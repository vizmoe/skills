import path from "node:path";
import type { Document, Element } from "@xmldom/xmldom";
import { inspectBytes, type EpubInspection } from "./epub.js";
import { describeInspection } from "./inspection.js";
import {
  openMetadata,
  setModified,
  type MetadataFile,
} from "./metadata-file.js";
import { attr, elements, NS, removeNode, serialize, escapeXml } from "./xml.js";
import { localTarget } from "./paths.js";
import { fail } from "./errors.js";
import type { CoverImage } from "./cover-image.js";

const tokens = (value: string) => value.split(/\s+/).filter(Boolean);
const uri = (from: string, to: string) =>
  path.posix
    .relative(path.posix.dirname(from), to)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
export function coverClaims(bytes: Buffer) {
  const info = inspectBytes(bytes, true);
  const images = [
    ...info.manifest
      .filter((item) => item.properties.includes("cover-image"))
      .map((item) => item.path),
    ...elements(info.packageDocument, "meta", NS.opf)
      .filter((node) => attr(node, "name") === "cover")
      .map(
        (node) =>
          info.manifest.find((item) => item.id === attr(node, "content"))
            ?.path ?? `missing-id:${attr(node, "content")}`,
      ),
  ];
  const documents = elements(info.packageDocument, "reference", NS.opf)
    .filter((node) => tokens(attr(node, "type")).includes("cover"))
    .map((node) => localTarget(info.packagePath, attr(node, "href")).path);
  for (const item of info.manifest.filter((item) =>
    item.properties.includes("nav"),
  )) {
    const nav = info.documents.get(item.path);
    if (!nav) fail("COVER_NAV", "Missing navigation document");
    for (const link of elements(nav, "a", NS.xhtml))
      if (tokens(link.getAttributeNS(NS.epub, "type") ?? "").includes("cover"))
        documents.push(localTarget(item.path, attr(link, "href")).path);
  }
  return { images: [...new Set(images)], documents: [...new Set(documents)] };
}
/** Display the complete raster; empty viewport space is not added to the image. */
export function coverDocument(
  href: string,
  language: string,
  ids: string[] = [],
) {
  const anchors = ids
    .map((id) => `<span id="${escapeXml(id)}"></span>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="${NS.xhtml}" xml:lang="${escapeXml(language || "und")}"><head><title>Cover</title><style type="text/css">html, body { margin: 0; padding: 0; } body { text-align: center; } img { display: block; margin: 0 auto; width: auto; height: auto; max-width: 100%; max-height: 100vh; object-fit: contain; }</style></head><body><div>${anchors}<img src="${escapeXml(href)}" alt="Cover" /></div></body></html>`;
}

const allowedCoverTags = new Set([
  "div",
  "p",
  "span",
  "a",
  "img",
  "svg",
  "image",
  "g",
]);

function uniqueCoverPath(
  file: MetadataFile,
  info: EpubInspection,
  details: CoverImage,
  suffix: string,
) {
  const name = path.posix.join(
    path.posix.dirname(file.location),
    `quillbind-cover-${details.sha256.slice(0, 12)}${suffix}`,
  );
  const collides =
    [...file.entries.keys()].some(
      (key) => key.toLowerCase() === name.toLowerCase(),
    ) || info.manifest.some((item) => item.path === name);
  if (collides)
    fail("COVER_COLLISION", `Cover resource already exists: ${name}`);
  return name;
}

function extractCoverDocumentIds(info: EpubInspection, documentPath: string) {
  const cover = info.documents.get(documentPath);
  if (!cover) fail("COVER_CONTENT", "Selected cover document is missing");
  const body = elements(cover, "body", NS.xhtml)[0];
  const images = [
    ...elements(cover, "img", NS.xhtml),
    ...elements(cover, "image", "http://www.w3.org/2000/svg"),
  ];
  const hasExtraContent =
    !body ||
    Boolean(body.textContent?.trim()) ||
    images.length !== 1 ||
    elements(body).some((node) => !allowedCoverTags.has(node.localName ?? ""));
  if (hasExtraContent)
    fail(
      "COVER_CONTENT",
      "Selected document contains content beyond a single cover image",
    );
  const ids = elements(cover)
    .map((node) => attr(node, "id"))
    .filter(Boolean);
  if (new Set(ids).size !== ids.length)
    fail("COVER_CONTENT", "Duplicate cover document anchors");
  return ids;
}

function assertCoverImageUnshared(
  info: EpubInspection,
  byteLength: number,
  imagePath: string,
  documentPath: string,
) {
  const inventory = describeInspection(info, byteLength);
  const shared =
    inventory.references.some(
      (reference) =>
        reference.path === imagePath &&
        ![documentPath, info.packagePath].includes(reference.source),
    ) || inventory.diagnostics.some((item) => item.code === "INSPECT_CSS");
  if (shared)
    fail(
      "COVER_SHARED",
      "Selected image is used outside the cover or shared CSS cannot be inspected; choose null to add a separate cover image",
    );
}

function nextUnusedId(document: Document, stem: string) {
  const used = new Set(elements(document).map((node) => attr(node, "id")));
  let id = stem;
  let n = 1;
  while (used.has(id)) {
    id = `${stem}-${n}`;
    n += 1;
  }
  return id;
}

function addManifestItem(
  file: MetadataFile,
  manifest: Element,
  name: string,
  type: string,
  stem: string,
) {
  const item = file.document.createElementNS(NS.opf, "item");
  item.setAttribute("id", nextUnusedId(file.document, stem));
  item.setAttribute("href", uri(file.location, name));
  item.setAttribute("media-type", type);
  manifest.appendChild(item);
  return item;
}

function updateCoverManifestProperties(
  file: MetadataFile,
  manifest: Element,
  imageNode: Element,
  pageNode: Element,
) {
  const properties = tokens(attr(pageNode, "properties")).filter(
    (value) => !["svg", "mathml", "scripted"].includes(value),
  );
  if (properties.length)
    pageNode.setAttribute("properties", properties.join(" "));
  else pageNode.removeAttribute("properties");
  for (const item of elements(manifest, "item", NS.opf)) {
    const values = tokens(attr(item, "properties")).filter(
      (value) => value !== "cover-image",
    );
    if (file.version === "3.0" && item === imageNode)
      values.push("cover-image");
    if (values.length) item.setAttribute("properties", values.join(" "));
    else item.removeAttribute("properties");
  }
}

function updateCoverMetaAndGuide(
  file: MetadataFile,
  imageNode: Element,
  documentPath: string,
) {
  const metas = elements(file.metadata, "meta", NS.opf).filter(
    (node) => attr(node, "name") === "cover",
  );
  if (metas.some((node) => attr(node, "id") || attr(node, "refines")))
    fail(
      "COVER_REFERENCE",
      "Refined legacy cover metadata needs explicit repair",
    );
  for (const meta of metas) removeNode(meta);
  const meta = file.document.createElementNS(NS.opf, "meta");
  meta.setAttribute("name", "cover");
  meta.setAttribute("content", attr(imageNode, "id"));
  file.metadata.appendChild(meta);

  let guide = elements(file.document, "guide", NS.opf)[0];
  if (!guide && file.version === "2.0") {
    guide = file.document.createElementNS(NS.opf, "guide");
    file.document.documentElement!.appendChild(guide);
  }
  if (!guide) return;
  const covers = elements(guide, "reference", NS.opf).filter((node) =>
    tokens(attr(node, "type")).includes("cover"),
  );
  for (const reference of covers) removeNode(reference);
  const reference = file.document.createElementNS(NS.opf, "reference");
  reference.setAttribute("type", "cover");
  reference.setAttribute("title", "Cover");
  reference.setAttribute("href", uri(file.location, documentPath));
  guide.appendChild(reference);
}

function updateNavLandmark(
  nav: Document,
  navPath: string,
  documentPath: string,
) {
  nav.documentElement!.setAttribute("xmlns:epub", NS.epub);
  const coverLinks = elements(nav, "a", NS.xhtml).filter((link) =>
    tokens(link.getAttributeNS(NS.epub, "type") ?? "").includes("cover"),
  );
  if (coverLinks.length > 1)
    fail("COVER_NAV", "Duplicate cover landmarks need explicit repair");
  const landmarks = elements(nav, "nav", NS.xhtml).filter((node) =>
    tokens(node.getAttributeNS(NS.epub, "type") ?? "").includes("landmarks"),
  );
  if (landmarks.length > 1) fail("COVER_NAV", "Ambiguous landmarks navigation");
  let landmark: Element | undefined = landmarks[0];
  if (!landmark) {
    landmark = nav.createElementNS(NS.xhtml, "nav");
    landmark.setAttributeNS(NS.epub, "epub:type", "landmarks");
    landmark.setAttribute("hidden", "hidden");
    elements(nav, "body", NS.xhtml)[0].appendChild(landmark);
    landmark.appendChild(nav.createElementNS(NS.xhtml, "ol"));
  }
  const lists = elements(landmark, "ol", NS.xhtml);
  if (lists.length !== 1)
    fail("COVER_NAV", "Complex landmarks need an explicit navigation repair");
  if (coverLinks.length) {
    coverLinks[0].setAttribute("href", uri(navPath, documentPath));
    return;
  }
  const li = nav.createElementNS(NS.xhtml, "li");
  const a = nav.createElementNS(NS.xhtml, "a");
  a.setAttributeNS(NS.epub, "epub:type", "cover");
  a.setAttribute("href", uri(navPath, documentPath));
  a.textContent = "Cover";
  li.appendChild(a);
  lists[0].appendChild(li);
}

function updateCoverNavDocuments(
  file: MetadataFile,
  info: EpubInspection,
  documentPath: string,
  put: (name: string, content: Buffer) => void,
) {
  if (file.version !== "3.0") return;
  for (const item of info.manifest.filter((entry) =>
    entry.properties.includes("nav"),
  )) {
    if (item.path === documentPath)
      fail("COVER_CONTENT", "Navigation is not a replaceable cover page");
    const nav = info.documents.get(item.path)!;
    updateNavLandmark(nav, item.path, documentPath);
    put(item.path, Buffer.from(serialize(nav)));
  }
}

function resolveImageTarget(
  file: MetadataFile,
  info: EpubInspection,
  details: CoverImage,
  targetImage: string | null,
) {
  let imageItem = targetImage
    ? info.manifest.find((item) => item.path === targetImage)
    : undefined;
  if (targetImage && !imageItem?.mediaType.startsWith("image/"))
    fail(
      "COVER_TARGET",
      "Select an existing image manifest item or null to add a resource",
    );
  if (imageItem && imageItem.mediaType !== details.mediaType)
    imageItem = undefined;
  const imagePath =
    imageItem?.path ?? uniqueCoverPath(file, info, details, details.extension);
  return { imageItem, imagePath };
}

function resolveDocumentTarget(
  file: MetadataFile,
  info: EpubInspection,
  details: CoverImage,
  targetDocument: string | null,
) {
  const documentItem = targetDocument
    ? info.manifest.find((item) => item.path === targetDocument)
    : undefined;
  if (targetDocument && documentItem?.mediaType !== "application/xhtml+xml")
    fail("COVER_TARGET", "Select an XHTML cover document or null");
  const documentPath =
    documentItem?.path ?? uniqueCoverPath(file, info, details, ".xhtml");
  return { documentItem, documentPath };
}

function findOrAddManifestItem(
  file: MetadataFile,
  manifest: Element,
  existingId: string | undefined,
  resourcePath: string,
  mediaType: string,
  stem: string,
) {
  if (existingId)
    return elements(manifest, "item", NS.opf).find(
      (node) => attr(node, "id") === existingId,
    )!;
  return addManifestItem(file, manifest, resourcePath, mediaType, stem);
}

export function epubCover(
  bytes: Buffer,
  image: Buffer,
  details: CoverImage,
  target: { image: string | null; document: string | null },
  modified: string,
) {
  const file = openMetadata(bytes, "epub");
  const info = inspectBytes(bytes, true);
  const document = file.document;
  const manifest = elements(document, "manifest", NS.opf)[0];
  const spine = elements(document, "spine", NS.opf)[0];
  const ambiguous =
    !manifest ||
    !spine ||
    new Set(info.manifest.map((item) => item.path)).size !==
      info.manifest.length ||
    new Set(info.manifest.map((item) => item.id)).size !== info.manifest.length;
  if (ambiguous) fail("COVER_MANIFEST", "Ambiguous manifest or spine");

  const replacements = new Map<string, Buffer>();
  const additions = new Map<string, Buffer>();
  const put = (name: string, content: Buffer) => {
    const bucket = file.entries.has(name) ? replacements : additions;
    bucket.set(name, content);
  };

  const { imageItem, imagePath } = resolveImageTarget(
    file,
    info,
    details,
    target.image,
  );
  const { documentItem, documentPath } = resolveDocumentTarget(
    file,
    info,
    details,
    target.document,
  );

  const ids = documentItem ? extractCoverDocumentIds(info, documentPath) : [];
  if (imageItem)
    assertCoverImageUnshared(info, bytes.length, imagePath, documentPath);

  const imageNode = findOrAddManifestItem(
    file,
    manifest,
    imageItem?.id,
    imagePath,
    details.mediaType,
    "quillbind-cover-image",
  );
  const pageNode = findOrAddManifestItem(
    file,
    manifest,
    documentItem?.id,
    documentPath,
    "application/xhtml+xml",
    "quillbind-cover-page",
  );

  updateCoverManifestProperties(file, manifest, imageNode, pageNode);
  updateCoverMetaAndGuide(file, imageNode, documentPath);
  if (!info.spine.includes(attr(pageNode, "id"))) {
    const itemref = document.createElementNS(NS.opf, "itemref");
    itemref.setAttribute("idref", attr(pageNode, "id"));
    spine.insertBefore(itemref, spine.firstChild);
  }
  updateCoverNavDocuments(file, info, documentPath, put);

  put(imagePath, image);
  put(
    documentPath,
    Buffer.from(
      coverDocument(uri(documentPath, imagePath), info.language, ids),
    ),
  );
  setModified(file, modified);
  put(file.location, Buffer.from(serialize(document)));
  return { replacements, additions, imagePath, documentPath };
}
