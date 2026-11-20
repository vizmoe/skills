import { inspectBytes, type EpubInspection } from "./epub.js";
import { readBookWalkerLock, type BookWalkerLock } from "./bookwalker.js";
import { bookWalkerOpf } from "./bookwalker-opf.js";
import {
  attr,
  elements,
  escapeXml,
  NS,
  removeNode,
  serialize,
  xml,
} from "./xml.js";
import { pack } from "./zip.js";
import { diagnostic, fail } from "./errors.js";
import { sha256 } from "./hash.js";
import type { Diagnostic } from "./model.js";
import type { Document, Element } from "@xmldom/xmldom";

const structure = (document: Document) => {
  const copy = xml(serialize(document));
  for (const node of elements(copy, "metadata", NS.opf)) removeNode(node);
  return serialize(copy);
};

type MetadataChange = {
  field: string;
  before: string[];
  after: string[];
};

interface MetadataApplyContext {
  document: Document;
  metadata: Element;
  packagePath: string;
  selected: BookWalkerLock["metadata"];
  changes: MetadataChange[];
  diagnostics: Diagnostic[];
}

function recordPreservedFieldConflict(
  ctx: MetadataApplyContext,
  field: string,
  before: string[],
  values: string[],
) {
  if (JSON.stringify(before) !== JSON.stringify(values))
    ctx.diagnostics.push(
      diagnostic(
        "BOOKWALKER_CONFLICT",
        `Preserved existing dc:${field}; BookWalker differs`,
        ctx.packagePath,
        ctx.selected.url,
        "warning",
      ),
    );
}

function setDcMetadataField(
  ctx: MetadataApplyContext,
  field: string,
  values: string[],
  replace = false,
) {
  const nodes = elements(ctx.metadata, field, NS.dc);
  const before = nodes.map((node) => node.textContent ?? "");
  if (before.some((value) => value.trim()) && !replace) {
    recordPreservedFieldConflict(ctx, field, before, values);
    return;
  }
  if (JSON.stringify(before) === JSON.stringify(values) || !values.length)
    return;
  if (replace && nodes.length > 1)
    fail(
      "METADATA_AMBIGUOUS",
      `Multiple dc:${field} elements require an explicit repair`,
    );
  if (nodes.length > values.length)
    fail(
      "METADATA_AMBIGUOUS",
      `Multiple empty dc:${field} elements require an explicit repair`,
    );
  for (const [index, value] of values.entries()) {
    escapeXml(value);
    const node =
      nodes[index] ?? ctx.document.createElementNS(NS.dc, `dc:${field}`);
    node.textContent = value;
    if (!node.parentNode) ctx.metadata.appendChild(node);
  }
  ctx.changes.push({ field, before, after: values });
}

function createIdReserver(document: Document) {
  const ids = new Set(
    elements(document)
      .map((node) => attr(node, "id"))
      .filter(Boolean),
  );
  return (base: string) => {
    let id = base;
    let n = 1;
    while (ids.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    ids.add(id);
    return id;
  };
}

function mergeBookWalkerFragment(
  ctx: MetadataApplyContext,
  fragment: Document,
  collections: Element[],
) {
  const names = new Set(
    [
      ...elements(ctx.metadata, "creator", NS.dc),
      ...elements(ctx.metadata, "contributor", NS.dc),
    ].map((node) => node.textContent?.trim().normalize("NFC")),
  );
  const sources = new Set(
    elements(ctx.metadata, "source", NS.dc).map((node) => node.textContent),
  );
  const omittedIds = new Set<string>();
  for (const node of Array.from(fragment.documentElement!.childNodes)) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (
      shouldSkipFragmentElement(
        ctx,
        element,
        names,
        sources,
        collections,
        omittedIds,
      )
    )
      continue;
    ctx.metadata.appendChild(ctx.document.importNode(element, true));
    ctx.changes.push({
      field: attr(element, "property") || element.localName!,
      before: [],
      after: [element.textContent ?? ""],
    });
  }
}

function shouldSkipFragmentElement(
  ctx: MetadataApplyContext,
  element: Element,
  names: Set<string | undefined>,
  sources: Set<string | null>,
  collections: Element[],
  omittedIds: Set<string>,
): boolean {
  if (["date", "publisher"].includes(element.localName ?? "")) return true;
  if (
    element.localName === "contributor" &&
    names.has(element.textContent?.trim().normalize("NFC"))
  ) {
    omittedIds.add(attr(element, "id"));
    return true;
  }
  if (element.localName === "source" && sources.has(element.textContent))
    return true;
  if (
    attr(element, "property") === "belongs-to-collection" &&
    collections.length
  ) {
    omittedIds.add(attr(element, "id"));
    if (!collections.some((item) => item.textContent === ctx.selected.series))
      ctx.diagnostics.push(
        diagnostic(
          "BOOKWALKER_CONFLICT",
          "Preserved existing collection metadata; BookWalker series differs",
          ctx.packagePath,
          ctx.selected.url,
          "warning",
        ),
      );
    return true;
  }
  return omittedIds.has(attr(element, "refines").slice(1));
}

function ensureCollectionPosition(
  ctx: MetadataApplyContext,
  collections: Element[],
  reserveId: (base: string) => string,
) {
  const collection = collections.find(
    (node) => node.textContent === ctx.selected.series,
  );
  if (!collection || ctx.selected.number === null) return;
  const id = attr(collection, "id") || reserveId("series");
  const hasPosition = elements(ctx.metadata, "meta", NS.opf).some(
    (node) =>
      attr(node, "property") === "group-position" &&
      attr(node, "refines") === `#${id}`,
  );
  if (hasPosition) return;
  collection.setAttribute("id", id);
  const position = ctx.document.createElementNS(NS.opf, "meta");
  position.setAttribute("property", "group-position");
  position.setAttribute("refines", `#${id}`);
  position.textContent = ctx.selected.number;
  ctx.metadata.appendChild(position);
  ctx.changes.push({
    field: "group-position",
    before: [],
    after: [ctx.selected.number],
  });
}

function updateModifiedTimestamp(
  ctx: MetadataApplyContext,
  records: BookWalkerLock["records"],
) {
  if (!ctx.changes.length) return;
  const modified = elements(ctx.metadata, "meta", NS.opf).filter(
    (node) => attr(node, "property") === "dcterms:modified",
  );
  if (modified.length > 1)
    fail(
      "METADATA_AMBIGUOUS",
      "Multiple modification dates require an explicit repair",
    );
  const node = modified[0] ?? ctx.document.createElementNS(NS.opf, "meta");
  node.setAttribute("property", "dcterms:modified");
  const times = records.map((record) => Date.parse(record.retrievedAt));
  const previous = Date.parse(node.textContent ?? "");
  if (Number.isFinite(previous)) times.push(previous);
  const value = new Date(Math.max(...times))
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  if (node.textContent !== value)
    ctx.changes.push({
      field: "dcterms:modified",
      before: node.textContent ? [node.textContent] : [],
      after: [value],
    });
  node.textContent = value;
  if (!node.parentNode) ctx.metadata.appendChild(node);
}

function verifyAppliedResources(
  info: EpubInspection,
  output: Buffer,
  protectedStructure: string,
  identifiers: string[],
) {
  const after = inspectBytes(output, true);
  if (
    structure(after.packageDocument) !== protectedStructure ||
    JSON.stringify(
      elements(after.packageDocument, "identifier", NS.dc).map(serialize),
    ) !== JSON.stringify(identifiers)
  )
    fail(
      "METADATA_INTEGRITY",
      "Protected EPUB structure or identifiers changed",
    );
  return [...info.entries]
    .filter(([name]) => name !== info.packagePath)
    .map(([name, entry]) => {
      if (!entry.bytes.equals(after.entries.get(name)!.bytes))
        fail("METADATA_INTEGRITY", `Protected resource changed: ${name}`);
      return { path: name, sha256: sha256(entry.bytes) };
    });
}

/** Change the package metadata only; all publication resources retain their exact bytes. */
export function applyBookWalkerMetadata(
  bytes: Uint8Array,
  input: BookWalkerLock,
) {
  const lock = readBookWalkerLock(JSON.stringify(input));
  const info = inspectBytes(bytes, true);
  if (info.version !== "3.0")
    fail(
      "METADATA_EPUB_VERSION",
      "Enrichment requires EPUB 3; an EPUB 2 upgrade is a separate repair operation",
    );
  if (info.unsupported.length || info.entries.has("META-INF/signatures.xml"))
    fail(
      "METADATA_EPUB_UNSUPPORTED",
      "Unsupported EPUB structure for metadata publication",
      info.unsupported,
    );
  const document = info.packageDocument;
  const metadata = elements(document, "metadata", NS.opf)[0];
  if (!metadata) fail("METADATA_MISSING", "The EPUB has no metadata element");
  const protectedStructure = structure(document);
  const identifiers = elements(document, "identifier", NS.dc).map(serialize);
  const selected = lock.metadata;
  const ctx: MetadataApplyContext = {
    document,
    metadata,
    packagePath: info.packagePath,
    selected,
    changes: [],
    diagnostics: [],
  };

  setDcMetadataField(ctx, "title", [selected.title]);
  setDcMetadataField(ctx, "language", [selected.language]);
  setDcMetadataField(
    ctx,
    "description",
    selected.description ? [selected.description] : [],
  );
  setDcMetadataField(
    ctx,
    "creator",
    selected.contributors
      .filter((item) => item.role === "aut")
      .map((item) => item.name),
  );
  setDcMetadataField(
    ctx,
    "publisher",
    selected.publisher ? [selected.publisher] : [],
  );
  setDcMetadataField(ctx, "date", [selected.releaseDate], true);

  const reserveId = createIdReserver(document);
  const fragment = xml(
    `<metadata xmlns="${NS.opf}" xmlns:dc="${NS.dc}">${bookWalkerOpf(selected, reserveId)}</metadata>`,
  );
  const collections = elements(metadata, "meta", NS.opf).filter(
    (node) => attr(node, "property") === "belongs-to-collection",
  );
  mergeBookWalkerFragment(ctx, fragment, collections);
  ensureCollectionPosition(ctx, collections, reserveId);
  updateModifiedTimestamp(ctx, lock.records);

  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(info.packagePath, Buffer.from(serialize(document)));
  const output = pack(entries, 946684800);
  const resources = verifyAppliedResources(
    info,
    output,
    protectedStructure,
    identifiers,
  );
  return {
    bytes: output,
    report: {
      status: "pass" as const,
      sourceSha256: sha256(bytes),
      sourceLockDigest: lock.digest,
      sourceUrls: selected.sourceUrls,
      dateBasis: selected.dateBasis,
      releaseDate: selected.releaseDate,
      changes: ctx.changes,
      diagnostics: ctx.diagnostics,
      resources,
    },
  };
}
