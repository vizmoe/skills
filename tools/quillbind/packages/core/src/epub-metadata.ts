import { inspectBytes } from "./epub.js";
import { readBookWalkerLock, type BookWalkerLock } from "./bookwalker.js";
import { bookWalkerOpf } from "./bookwalker-opf.js";
import { attr, elements, escapeXml, NS, serialize, xml } from "./xml.js";
import { pack } from "./zip.js";
import { diagnostic, fail } from "./errors.js";
import { sha256 } from "./hash.js";
import type { Diagnostic } from "./model.js";
import type { Document } from "@xmldom/xmldom";

const structure = (document: Document) => {
  const copy = xml(serialize(document));
  for (const node of elements(copy, "metadata", NS.opf))
    node.parentNode!.removeChild(node);
  return serialize(copy);
};

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
  const document = info.packageDocument,
    metadata = elements(document, "metadata", NS.opf)[0];
  if (!metadata) fail("METADATA_MISSING", "The EPUB has no metadata element");
  const protectedStructure = structure(document);
  const identifiers = elements(document, "identifier", NS.dc).map(serialize);
  const changes: { field: string; before: string[]; after: string[] }[] = [];
  const diagnostics: Diagnostic[] = [];
  const selected = lock.metadata;
  const setField = (field: string, values: string[], replace = false) => {
    const nodes = elements(metadata, field, NS.dc);
    const before = nodes.map((node) => node.textContent ?? "");
    if (before.some((value) => value.trim()) && !replace) {
      if (JSON.stringify(before) !== JSON.stringify(values))
        diagnostics.push(
          diagnostic(
            "BOOKWALKER_CONFLICT",
            `Preserved existing dc:${field}; BookWalker differs`,
            info.packagePath,
            selected.url,
            "warning",
          ),
        );
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
        nodes[index] ?? document.createElementNS(NS.dc, `dc:${field}`);
      node.textContent = value;
      if (!node.parentNode) metadata.appendChild(node);
    }
    changes.push({ field, before, after: values });
  };
  setField("title", [selected.title]);
  setField("language", [selected.language]);
  setField("description", selected.description ? [selected.description] : []);
  setField(
    "creator",
    selected.contributors
      .filter((item) => item.role === "aut")
      .map((item) => item.name),
  );
  setField("publisher", selected.publisher ? [selected.publisher] : []);
  setField("date", [selected.releaseDate], true);
  const ids = new Set(
    elements(document)
      .map((node) => attr(node, "id"))
      .filter(Boolean),
  );
  const reserveId = (base: string) => {
    let id = base;
    for (let n = 1; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  };
  const fragment = xml(
    `<metadata xmlns="${NS.opf}" xmlns:dc="${NS.dc}">${bookWalkerOpf(selected, reserveId)}</metadata>`,
  );
  const names = new Set(
    [
      ...elements(metadata, "creator", NS.dc),
      ...elements(metadata, "contributor", NS.dc),
    ].map((node) => node.textContent?.trim().normalize("NFC")),
  );
  const sources = new Set(
    elements(metadata, "source", NS.dc).map((node) => node.textContent),
  );
  const collections = elements(metadata, "meta", NS.opf).filter(
    (node) => attr(node, "property") === "belongs-to-collection",
  );
  const omittedIds = new Set<string>();
  for (const node of Array.from(fragment.documentElement!.childNodes)) {
    if (node.nodeType !== 1) continue;
    const element = node as typeof metadata;
    if (["date", "publisher"].includes(element.localName ?? "")) continue;
    if (
      element.localName === "contributor" &&
      names.has(element.textContent?.trim().normalize("NFC"))
    ) {
      omittedIds.add(attr(element, "id"));
      continue;
    }
    if (element.localName === "source" && sources.has(element.textContent))
      continue;
    if (
      attr(element, "property") === "belongs-to-collection" &&
      collections.length
    ) {
      omittedIds.add(attr(element, "id"));
      if (!collections.some((item) => item.textContent === selected.series))
        diagnostics.push(
          diagnostic(
            "BOOKWALKER_CONFLICT",
            "Preserved existing collection metadata; BookWalker series differs",
            info.packagePath,
            selected.url,
            "warning",
          ),
        );
      continue;
    }
    if (omittedIds.has(attr(element, "refines").slice(1))) continue;
    metadata.appendChild(document.importNode(element, true));
    changes.push({
      field: attr(element, "property") || element.localName!,
      before: [],
      after: [element.textContent ?? ""],
    });
  }
  const collection = collections.find(
    (node) => node.textContent === selected.series,
  );
  if (collection && selected.number !== null) {
    const id = attr(collection, "id") || reserveId("series");
    if (
      !elements(metadata, "meta", NS.opf).some(
        (node) =>
          attr(node, "property") === "group-position" &&
          attr(node, "refines") === `#${id}`,
      )
    ) {
      collection.setAttribute("id", id);
      const position = document.createElementNS(NS.opf, "meta");
      position.setAttribute("property", "group-position");
      position.setAttribute("refines", `#${id}`);
      position.textContent = selected.number;
      metadata.appendChild(position);
      changes.push({
        field: "group-position",
        before: [],
        after: [selected.number],
      });
    }
  }
  if (changes.length) {
    const modified = elements(metadata, "meta", NS.opf).filter(
      (node) => attr(node, "property") === "dcterms:modified",
    );
    if (modified.length > 1)
      fail(
        "METADATA_AMBIGUOUS",
        "Multiple modification dates require an explicit repair",
      );
    const node = modified[0] ?? document.createElementNS(NS.opf, "meta");
    node.setAttribute("property", "dcterms:modified");
    const times = lock.records.map((record) => Date.parse(record.retrievedAt));
    const previous = Date.parse(node.textContent ?? "");
    if (Number.isFinite(previous)) times.push(previous);
    const value = new Date(Math.max(...times))
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    if (node.textContent !== value)
      changes.push({
        field: "dcterms:modified",
        before: node.textContent ? [node.textContent] : [],
        after: [value],
      });
    node.textContent = value;
    if (!node.parentNode) metadata.appendChild(node);
  }
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(info.packagePath, Buffer.from(serialize(document)));
  const output = pack(entries, 946684800);
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
  const resources = [...info.entries]
    .filter(([name]) => name !== info.packagePath)
    .map(([name, entry]) => {
      if (!entry.bytes.equals(after.entries.get(name)!.bytes))
        fail("METADATA_INTEGRITY", `Protected resource changed: ${name}`);
      return { path: name, sha256: sha256(entry.bytes) };
    });
  return {
    bytes: output,
    report: {
      status: "pass" as const,
      sourceSha256: sha256(bytes),
      sourceLockDigest: lock.digest,
      sourceUrls: selected.sourceUrls,
      dateBasis: selected.dateBasis,
      releaseDate: selected.releaseDate,
      changes,
      diagnostics,
      resources,
    },
  };
}
