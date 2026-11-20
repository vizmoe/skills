import type { Document as XmlDocument, Element } from "@xmldom/xmldom";
import path from "node:path";
import {
  attr,
  elements,
  escapeXml,
  NS,
  serialize,
  xml,
  passiveSvg,
} from "./xml.js";
import { inspectBytes, type EpubInspection } from "./epub.js";
import { describeInspection } from "./inspection.js";
import { pack } from "./zip.js";
import { fail } from "./errors.js";
import { sha256 } from "./hash.js";
import { resolveSeriesDecision } from "./series-policy.js";
import type { SplitSource, SplitUnit } from "./split-source.js";
import { splitContent, type CrossLink } from "./split-content.js";
import type { SplitVolume } from "./split-model.js";

const href = (from: string, to: string, fragment?: string) =>
  path.posix
    .relative(path.posix.dirname(from), to)
    .split("/")
    .map(encodeURIComponent)
    .join("/") + (fragment ? `#${encodeURIComponent(fragment)}` : "");

type SplitContentResult = ReturnType<typeof splitContent>;
interface ResolvedNavUnit {
  entry: SplitVolume["navigation"][number];
  unit: SplitUnit;
}

function validateNavigationUnits(
  units: SplitUnit[],
  volume: SplitVolume,
  readingPaths: string[],
): ResolvedNavUnit[] {
  const navUnits = volume.navigation.map((entry) => ({
    entry,
    unit: units.find((unit) => unit.key === entry.unit),
  }));
  if (
    navUnits.some((item) => !item.unit) ||
    new Set(navUnits.map((item) => item.entry.unit)).size !== navUnits.length ||
    navUnits.some(
      (item, index) =>
        index > 0 && item.unit!.index <= navUnits[index - 1].unit!.index,
    )
  )
    fail(
      "SPLIT_NAV",
      "Volume navigation must point to selected units once in source order",
    );
  const resolved = navUnits as ResolvedNavUnit[];
  if (
    readingPaths.some(
      (name) => !resolved.some((item) => item.unit.path === name),
    )
  )
    fail(
      "SPLIT_NAV",
      "Every retained reading document needs a volume navigation entry",
    );
  return resolved;
}

function validateSplitCover(
  info: EpubInspection,
  content: SplitContentResult,
  readingPaths: string[],
  cover: SplitVolume["metadata"]["cover"],
) {
  if (!cover) return;
  if (
    !readingPaths.includes(cover.document) ||
    !info.manifest.some(
      (item) =>
        item.path === cover.image && item.mediaType.startsWith("image/"),
    )
  )
    fail(
      "SPLIT_COVER",
      "An evidenced volume cover must be a retained reading page and source image",
    );
  const doc = content.documents.get(cover.document)!;
  const body = elements(doc, "body", NS.xhtml)[0];
  if (
    body.textContent?.trim() ||
    elements(doc, "img", NS.xhtml).length !== 1 ||
    !info.manifest.some(
      (item) =>
        item.path === cover.image &&
        ["image/jpeg", "image/png"].includes(item.mediaType),
    )
  )
    fail(
      "SPLIT_COVER",
      "A volume cover must be a cover-only XHTML page displaying one original JPEG/PNG; inspect and prepare complex cover content first",
    );
}

function renderSplitNavFiles(
  navPath: string,
  ncxPath: string,
  navUnits: ResolvedNavUnit[],
  volume: SplitVolume,
  unitIds: Map<string, string>,
) {
  const cover = volume.metadata.cover;
  const navItems = navUnits
    .map(({ entry, unit }) => {
      const targetHref = escapeXml(
        href(navPath, unit.path, unitIds.get(unit.key)),
      );
      return `<li><a href="${targetHref}">${escapeXml(entry.label)}</a></li>`;
    })
    .join("");
  const coverLandmark = cover
    ? `<nav epub:type="landmarks" hidden="hidden"><ol><li><a epub:type="cover" href="${escapeXml(href(navPath, cover.document))}">Cover</a></li></ol></nav>`
    : "";
  const authoredNav = `<?xml version="1.0"?><html xmlns="${NS.xhtml}" xmlns:epub="${NS.epub}" xml:lang="${escapeXml(volume.metadata.language)}"><head><title>${escapeXml(volume.metadata.title)}</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol>${navItems}</ol></nav>${coverLandmark}</body></html>`;
  const ncxPoints = navUnits
    .map(({ entry, unit }, index) => {
      const targetSrc = escapeXml(
        href(ncxPath, unit.path, unitIds.get(unit.key)),
      );
      return `<navPoint id="n${index + 1}" playOrder="${index + 1}"><navLabel><text>${escapeXml(entry.label)}</text></navLabel><content src="${targetSrc}"/></navPoint>`;
    })
    .join("");
  const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escapeXml(volume.metadata.identifier)}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>${escapeXml(volume.metadata.title)}</text></docTitle><navMap>${ncxPoints}</navMap></ncx>`;
  return { authoredNav, ncx };
}

function resolveVolumeReference(
  reference: ReturnType<typeof describeInspection>["references"][number],
  info: EpubInspection,
  documents: Map<string, XmlDocument>,
  resources: Set<string>,
  pending: string[],
) {
  if (reference.resolution === "external") {
    if (!reference.kind.startsWith("a@"))
      fail(
        "SPLIT_RESOURCES",
        "Remote assets cannot form a closed offline volume",
        reference,
      );
    return;
  }
  if (!reference.path || reference.resolution !== "resolved")
    fail(
      "SPLIT_RESOURCES",
      "Selected resource or fragment is unresolved",
      reference,
    );
  if (info.documents.has(reference.path) && !documents.has(reference.path))
    fail(
      "SPLIT_RESOURCES",
      "Unexpected content dependency crosses the selected volume",
      reference,
    );
  if (!resources.has(reference.path)) {
    resources.add(reference.path);
    pending.push(reference.path);
  }
}

function copyManifestDependencies(
  info: EpubInspection,
  resources: Set<string>,
  entries: Map<string, Buffer>,
) {
  for (const name of resources) {
    if (entries.has(name)) continue;
    const item = info.manifest.find(
      (manifestItem) => manifestItem.path === name,
    );
    const entry = info.entries.get(name);
    if (!item || !entry)
      fail("SPLIT_RESOURCES", `Unmanifested dependency: ${name}`);
    if (item.mediaType === "image/svg+xml")
      passiveSvg(entry.bytes.toString(), name);
    entries.set(name, entry.bytes);
  }
}

function collectVolumeResources(
  info: EpubInspection,
  documents: Map<string, XmlDocument>,
  entries: Map<string, Buffer>,
  cover: SplitVolume["metadata"]["cover"],
): Set<string> {
  const graph = describeInspection({ ...info, documents }, 0);
  if (graph.diagnostics.length)
    fail(
      "SPLIT_RESOURCES",
      "Cannot inspect the selected resource graph",
      graph.diagnostics,
    );
  const pending = [...entries.keys()];
  const resources = new Set(pending);
  if (cover) {
    resources.add(cover.image);
    pending.push(cover.image);
  }
  for (const current of pending) {
    for (const reference of graph.references) {
      if (reference.source === current)
        resolveVolumeReference(reference, info, documents, resources, pending);
    }
  }
  copyManifestDependencies(info, resources, entries);
  if (
    cover &&
    !graph.references.some(
      (reference) =>
        reference.source === cover.document && reference.path === cover.image,
    )
  )
    fail(
      "SPLIT_COVER",
      "The selected cover page does not reference the evidenced image",
    );
  return resources;
}

function createUniqueIdAllocator(usedIds: Set<string>) {
  return (stem: string) => {
    let id = stem;
    let n = 1;
    while (usedIds.has(id)) {
      id = `${stem}-${n}`;
      n++;
    }
    usedIds.add(id);
    return id;
  };
}

function appendCreatorsMetadata(
  version: string,
  creators: SplitVolume["metadata"]["creators"],
  newId: (stem: string) => string,
  dc: (name: string, value: string, id?: string) => Element,
  meta: (property: string, value: string, refines?: string) => Element,
) {
  for (const [index, creator] of creators.entries()) {
    const personId = newId(`person${index}`);
    const node = dc(
      creator.role === "aut" ? "creator" : "contributor",
      creator.name,
      personId,
    );
    if (version === "3.0")
      meta("role", creator.role, personId).setAttribute(
        "scheme",
        "marc:relators",
      );
    else node.setAttributeNS(NS.opf, "opf:role", creator.role);
  }
}

function populatePackageMetadata(
  document: XmlDocument,
  metadata: Element,
  version: string,
  volume: SplitVolume,
  modified: string,
  newId: (stem: string) => string,
) {
  const dc = (name: string, value: string, id?: string) => {
    const node = document.createElementNS(NS.dc, `dc:${name}`);
    node.textContent = value;
    if (id) node.setAttribute("id", id);
    metadata.appendChild(node);
    return node;
  };
  const meta = (property: string, value: string, refines?: string) => {
    const node = document.createElementNS(NS.opf, "meta");
    node.setAttribute("property", property);
    if (refines) node.setAttribute("refines", `#${refines}`);
    node.textContent = value;
    metadata.appendChild(node);
    return node;
  };
  const primaryId = newId("uid");
  document.documentElement!.setAttribute("unique-identifier", primaryId);
  dc("identifier", volume.metadata.identifier, primaryId);
  dc("title", volume.metadata.title);
  dc("language", volume.metadata.language);
  appendCreatorsMetadata(version, volume.metadata.creators, newId, dc, meta);
  for (const name of ["description", "publisher", "date"] as const)
    if (volume.metadata[name]) dc(name, volume.metadata[name]!);
  for (const tag of volume.metadata.tags) dc("subject", tag);
  if (volume.metadata.isbn) {
    const isbnId = newId("isbn");
    const node = dc("identifier", volume.metadata.isbn, isbnId);
    if (version === "3.0")
      meta("identifier-type", "15", isbnId).setAttribute(
        "scheme",
        "onix:codelist5",
      );
    else node.setAttributeNS(NS.opf, "opf:scheme", "ISBN");
  }
  if (version === "3.0") meta("dcterms:modified", modified);
  appendSeriesMetadata(document, metadata, version, volume, newId, meta);
}

function appendSeriesMetadata(
  document: XmlDocument,
  metadata: Element,
  version: string,
  volume: SplitVolume,
  newId: (stem: string) => string,
  meta: (property: string, value: string, refines?: string) => Element,
) {
  const series = volume.metadata.series
    ? resolveSeriesDecision(volume.metadata.series)
    : null;
  if (!series?.series) return;
  if (version === "3.0") {
    const seriesId = newId("series");
    meta("belongs-to-collection", series.series).setAttribute("id", seriesId);
    meta("collection-type", "series", seriesId);
    if (series.position !== null)
      meta("group-position", series.position, seriesId);
  }
  for (const [name, value] of [
    ["calibre:series", series.series],
    ["calibre:series_index", series.position],
  ] as const) {
    if (value === null) continue;
    const node = document.createElementNS(NS.opf, "meta");
    node.setAttribute("name", name);
    node.setAttribute("content", value);
    metadata.appendChild(node);
  }
}

function cloneSelectedManifestItems(
  manifest: Element,
  info: EpubInspection,
  selectedItems: EpubInspection["manifest"],
  cover: SplitVolume["metadata"]["cover"],
) {
  for (const item of selectedItems) {
    const original = elements(info.packageDocument, "item", NS.opf).find(
      (node) => attr(node, "id") === item.id,
    )!;
    const node = original.cloneNode(true) as Element;
    const properties = item.properties.filter(
      (value) => !["nav", "cover-image"].includes(value),
    );
    if (cover?.image === item.path && info.version === "3.0")
      properties.push("cover-image");
    if (properties.length)
      node.setAttribute("properties", properties.join(" "));
    else node.removeAttribute("properties");
    manifest.appendChild(node);
  }
}

function populateSpineItems(
  document: XmlDocument,
  spine: Element,
  info: EpubInspection,
  selectedItems: EpubInspection["manifest"],
  readingPaths: string[],
  notePaths: string[],
) {
  const originalSpine = elements(info.packageDocument, "spine", NS.opf)[0];
  if (attr(originalSpine, "page-progression-direction"))
    spine.setAttribute(
      "page-progression-direction",
      attr(originalSpine, "page-progression-direction"),
    );
  for (const name of [...readingPaths, ...notePaths]) {
    const item = selectedItems.find((m) => m.path === name)!;
    const node = document.createElementNS(NS.opf, "itemref");
    node.setAttribute("idref", item.id);
    const originalRef = elements(info.packageDocument, "itemref", NS.opf).find(
      (ref) => attr(ref, "idref") === item.id,
    );
    if (
      notePaths.includes(name) ||
      (originalRef && attr(originalRef, "linear") === "no")
    )
      node.setAttribute("linear", "no");
    if (originalRef && attr(originalRef, "properties"))
      node.setAttribute("properties", attr(originalRef, "properties"));
    spine.appendChild(node);
  }
}

function populateManifestAndSpine(options: {
  document: XmlDocument;
  manifest: Element;
  spine: Element;
  info: EpubInspection;
  selectedItems: EpubInspection["manifest"];
  cover: SplitVolume["metadata"]["cover"];
  navPath: string;
  ncxPath: string;
  readingPaths: string[];
  notePaths: string[];
  newId: (stem: string) => string;
}) {
  const {
    document,
    manifest,
    spine,
    info,
    selectedItems,
    cover,
    navPath,
    ncxPath,
    readingPaths,
    notePaths,
    newId,
  } = options;
  cloneSelectedManifestItems(manifest, info, selectedItems, cover);
  const addItem = (
    name: string,
    type: string,
    id: string,
    properties?: string,
  ) => {
    const node = document.createElementNS(NS.opf, "item");
    node.setAttribute("id", id);
    node.setAttribute("href", href(info.packagePath, name));
    node.setAttribute("media-type", type);
    if (properties) node.setAttribute("properties", properties);
    manifest.appendChild(node);
  };
  if (info.version === "3.0")
    addItem(navPath, "application/xhtml+xml", newId("split-nav"), "nav");
  const ncxId = newId("split-ncx");
  addItem(ncxPath, "application/x-dtbncx+xml", ncxId);
  spine.setAttribute("toc", ncxId);
  populateSpineItems(
    document,
    spine,
    info,
    selectedItems,
    readingPaths,
    notePaths,
  );
}

function appendCoverOpfMetadata(
  document: XmlDocument,
  metadata: Element,
  opf: string,
  selectedItems: EpubInspection["manifest"],
  cover: NonNullable<SplitVolume["metadata"]["cover"]>,
) {
  const imageId = selectedItems.find((item) => item.path === cover.image)!.id;
  const node = document.createElementNS(NS.opf, "meta");
  node.setAttribute("name", "cover");
  node.setAttribute("content", imageId);
  metadata.appendChild(node);
  const guide = document.createElementNS(NS.opf, "guide");
  const reference = document.createElementNS(NS.opf, "reference");
  reference.setAttribute("type", "cover");
  reference.setAttribute("title", "Cover");
  reference.setAttribute("href", href(opf, cover.document));
  guide.appendChild(reference);
  document.documentElement!.appendChild(guide);
}

function verifySplitPackageOutput(options: {
  info: EpubInspection;
  bytes: Buffer;
  units: SplitUnit[];
  expectedOrder: string[];
  resources: Set<string>;
  documents: Map<string, XmlDocument>;
  unitIds: Map<string, string>;
}) {
  const { info, bytes, units, expectedOrder, resources, documents, unitIds } =
    options;
  const actual = inspectBytes(bytes, true);
  const checked = describeInspection(actual, bytes.length);
  if (checked.brokenReferences.length || checked.notes.issues.length)
    fail(
      "SPLIT_READBACK",
      "Output links or note returns failed independent inspection",
      { references: checked.brokenReferences, notes: checked.notes.issues },
    );
  if (
    actual.spine
      .map((id) => actual.manifest.find((item) => item.id === id)!.path)
      .join("\n") !== expectedOrder.join("\n")
  )
    fail("SPLIT_ORDER", "Output reading order differs from source selection");
  const coverage = units.map((unit) => {
    const matches = elements(actual.documents.get(unit.path)!).filter(
      (node) => attr(node, "id") === unitIds.get(unit.key),
    );
    if (
      matches.length !== 1 ||
      (matches[0].textContent ?? "") !== (unit.node.textContent ?? "")
    )
      fail(
        "SPLIT_COVERAGE",
        `Output content missing, duplicated or changed: ${unit.key}`,
      );
    return {
      unit: unit.key,
      path: unit.path,
      id: unitIds.get(unit.key)!,
      sourceSha256: unit.sha256,
      textSha256: sha256(matches[0].textContent ?? ""),
    };
  });
  const preserved = [...resources]
    .filter((name) => !documents.has(name))
    .map((name) => {
      const original = info.entries.get(name)!;
      if (!actual.entries.get(name)?.bytes.equals(original.bytes))
        fail("SPLIT_RESOURCE_CHANGED", `Resource changed: ${name}`);
      return { name, sha256: sha256(original.bytes) };
    });
  return { coverage, preserved };
}

export function splitPackage(
  source: SplitSource,
  units: SplitUnit[],
  volume: SplitVolume,
  decisions: CrossLink[],
  modified: string,
) {
  const content = splitContent(source, units, volume, decisions);
  const info = source.info;
  const opf = info.packagePath;
  const folder = path.posix.dirname(opf);
  const navPath = path.posix.join(folder, "quillbind-split-nav.xhtml");
  const ncxPath = path.posix.join(folder, "quillbind-split-toc.ncx");
  if (info.entries.has(navPath) || info.entries.has(ncxPath))
    fail(
      "SPLIT_COLLISION",
      "Generated navigation paths already occur in source; rename them in a prepared copy",
    );
  const readingPaths = [...new Set(units.map((unit) => unit.path))];
  const navUnits = validateNavigationUnits(units, volume, readingPaths);
  const cover = volume.metadata.cover;
  validateSplitCover(info, content, readingPaths, cover);
  const { authoredNav, ncx } = renderSplitNavFiles(
    navPath,
    ncxPath,
    navUnits,
    volume,
    content.unitIds,
  );
  const entries = new Map<string, Buffer>(content.entries);
  const documents = new Map(content.documents);
  const resources = collectVolumeResources(info, documents, entries, cover);
  if (info.version === "3.0") entries.set(navPath, Buffer.from(authoredNav));
  entries.set(ncxPath, Buffer.from(ncx));
  const selectedItems = info.manifest.filter((item) =>
    resources.has(item.path),
  );
  const newId = createUniqueIdAllocator(
    new Set(selectedItems.map((item) => item.id)),
  );
  const document = xml(
    `<package xmlns="${NS.opf}" xmlns:opf="${NS.opf}" xmlns:dc="${NS.dc}" version="${info.version}" unique-identifier="uid"><metadata/><manifest/><spine/></package>`,
  );
  const metadata = elements(document, "metadata", NS.opf)[0];
  const manifest = elements(document, "manifest", NS.opf)[0];
  const spine = elements(document, "spine", NS.opf)[0];
  populatePackageMetadata(
    document,
    metadata,
    info.version,
    volume,
    modified,
    newId,
  );
  const notePaths = [...documents.keys()].filter(
    (name) => !readingPaths.includes(name),
  );
  populateManifestAndSpine({
    document,
    manifest,
    spine,
    info,
    selectedItems,
    cover,
    navPath,
    ncxPath,
    readingPaths,
    notePaths,
    newId,
  });
  if (cover)
    appendCoverOpfMetadata(document, metadata, opf, selectedItems, cover);
  entries.set(opf, Buffer.from(serialize(document)));
  entries.set("mimetype", Buffer.from("application/epub+zip"));
  entries.set(
    "META-INF/container.xml",
    source.info.entries.get("META-INF/container.xml")!.bytes,
  );
  const bytes = pack(entries, Math.floor(Date.parse(modified) / 1000));
  const expectedOrder = [...readingPaths, ...notePaths];
  const { coverage, preserved } = verifySplitPackageOutput({
    info,
    bytes,
    units,
    expectedOrder,
    resources,
    documents,
    unitIds: content.unitIds,
  });
  return {
    key: volume.key,
    bytes,
    report: {
      units: units.map((unit) => unit.key),
      coverage,
      notes: content.notes,
      crossLinks: content.crossLinks,
      noteReturns: content.noteReturns,
      readingOrder: expectedOrder,
      preserved,
      metadata: volume.metadata,
      sourceSha256: info.sha256,
      outputSha256: sha256(bytes),
    },
  };
}
