import type { Document, Element, Node } from "@xmldom/xmldom";
import { openMetadata, children } from "./metadata-file.js";
import { inspectBytes, type EpubInspection } from "./epub.js";
import {
  describeInspection,
  type InspectedNavigationNode,
  type InspectionReport,
} from "./inspection.js";
import { elements, attr, NS, removeNode, serialize } from "./xml.js";
import { localTarget } from "./paths.js";
import { sha256 } from "./hash.js";
import { fail } from "./errors.js";
import { isNoteRefLink, isNoteTarget } from "./epub-notes.js";

export {
  isNoteRefLink,
  isNoteTarget,
  noteRefId,
  noteRefIds,
} from "./epub-notes.js";
export function semantic(node: Element, value: string): boolean {
  if (value === "noteref") return isNoteRefLink(node);
  if (value === "footnote" || value === "endnote") return isNoteTarget(node);
  return (
    (node.getAttributeNS(NS.epub, "type") ?? "").split(/\s+/).includes(value) ||
    attr(node, "role").split(/\s+/).includes(`doc-${value}`)
  );
}
export const noteKey = (name: string, id: string) => `${name}#${id}`;
export interface SplitUnit {
  key: string;
  path: string;
  index: number;
  anchors: string[];
  sha256: string;
  text: string;
  boundary: boolean;
  node: Element;
}

const unsupportedSplitTags = new Set([
  "picture",
  "source",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "base",
]);
const blockNoteTags = new Set([
  "aside",
  "div",
  "section",
  "p",
  "li",
  "blockquote",
]);
const containerSplitTags = new Set([
  "body",
  "div",
  "section",
  "article",
  "main",
]);

function checkSplitCss(value: string, name: string) {
  if (/\\|image-set\s*\(|\bsrc\s*\(/i.test(value))
    fail(
      "SPLIT_CSS",
      `Normalize escaped or dynamic CSS references before splitting: ${name}`,
    );
}

function validateSourcePackage(
  info: EpubInspection,
  inspection: InspectionReport,
) {
  if (info.entries.has("META-INF/encryption.xml"))
    fail(
      "SPLIT_PROTECTED",
      "Splitting changes identity; encrypted or obfuscated resources require a separate supported preparation step",
    );
  if (
    inspection.notes.active.length ||
    inspection.diagnostics.length ||
    inspection.brokenReferences.length
  )
    fail(
      "SPLIT_SOURCE",
      "Repair active, unresolved or ambiguous source resources before splitting",
      {
        diagnostics: inspection.diagnostics,
        brokenReferences: inspection.brokenReferences,
        active: inspection.notes.active,
      },
    );
  if (
    new Set(info.spine).size !== info.spine.length ||
    new Set(info.manifest.map((item) => item.path)).size !==
      info.manifest.length ||
    new Set(info.manifest.map((item) => item.id)).size !== info.manifest.length
  )
    fail("SPLIT_SOURCE", "Duplicate manifest or spine entries are ambiguous");
  if (
    elements(info.packageDocument, "item", NS.opf).some(
      (node) => attr(node, "fallback") || attr(node, "media-overlay"),
    )
  )
    fail(
      "SPLIT_SOURCE",
      "Manifest fallbacks and media overlays require a separate preparation step",
    );
}

function validateSingleSourceDocument(name: string, doc: Document) {
  for (const node of elements(doc)) {
    if (node.localName === "style") checkSplitCss(node.textContent ?? "", name);
    if (node.hasAttribute("style")) checkSplitCss(attr(node, "style"), name);
  }
  if (
    elements(doc).some((node) => node.hasAttribute("xml:base")) ||
    Array.from(doc.childNodes).some(
      (node) => node.nodeType === 7 && node.nodeName === "xml-stylesheet",
    )
  )
    fail(
      "SPLIT_SOURCE",
      `XML base overrides or stylesheet instructions need explicit preparation: ${name}`,
    );
  if (
    elements(doc).some(
      (node) =>
        node.hasAttribute("srcset") ||
        unsupportedSplitTags.has(node.localName ?? ""),
    )
  )
    fail(
      "SPLIT_SOURCE",
      `Unsupported responsive or embedded content in ${name}`,
    );
  const ids = elements(doc)
    .map((node) => attr(node, "id"))
    .filter(Boolean);
  if (new Set(ids).size !== ids.length)
    fail("SPLIT_SOURCE", `Duplicate IDs in ${name}`);
}

function validateSourceDocumentsAndStyles(info: EpubInspection) {
  for (const [name, doc] of info.documents)
    validateSingleSourceDocument(name, doc);
  for (const item of info.manifest) {
    if (item.mediaType === "text/css")
      checkSplitCss(info.entries.get(item.path)!.bytes.toString(), item.path);
  }
}

function validateCollectedNotes(
  notes: Map<string, { path: string; id: string; node: Element }>,
  noteNodes: Set<Element>,
) {
  for (const note of notes.values()) {
    if (!blockNoteTags.has(note.node.localName ?? ""))
      fail(
        "SPLIT_NOTE",
        "Inline note targets need explicit structural preparation",
        { path: note.path, id: note.id },
      );
    for (
      let parent = note.node.parentNode;
      parent?.nodeType === 1;
      parent = parent.parentNode
    ) {
      if (noteNodes.has(parent as Element))
        fail("SPLIT_NOTE", "Nested note targets are ambiguous");
    }
  }
}

function collectSourceNotes(
  info: EpubInspection,
  inspection: InspectionReport,
) {
  const notes = new Map<string, { path: string; id: string; node: Element }>();
  for (const [name, doc] of info.documents) {
    for (const node of elements(doc)) {
      if (!semantic(node, "footnote") && !semantic(node, "endnote")) continue;
      const id = attr(node, "id");
      if (!id) fail("SPLIT_NOTE", `Note needs a stable ID in ${name}`);
      notes.set(noteKey(name, id), { path: name, id, node });
    }
  }
  for (const reference of inspection.notes.references) {
    if (
      reference.resolution !== "resolved" ||
      !reference.target.fragment ||
      !reference.id
    )
      fail(
        "SPLIT_NOTE",
        "Every note reference needs a stable ID and resolved target",
        reference,
      );
    const node = elements(info.documents.get(reference.target.path)!).find(
      (candidate) => attr(candidate, "id") === reference.target.fragment,
    )!;
    notes.set(noteKey(reference.target.path, reference.target.fragment), {
      path: reference.target.path,
      id: reference.target.fragment,
      node,
    });
  }
  const noteNodes = new Set([...notes.values()].map((note) => note.node));
  validateCollectedNotes(notes, noteNodes);
  return { notes, noteNodes };
}

function isContainerUnit(node: Element, hasNotes: boolean): boolean {
  const tag = node.localName ?? "";
  return (
    containerSplitTags.has(tag) || (hasNotes && (tag === "ol" || tag === "ul"))
  );
}

interface UnitWalkContext {
  itemPath: string;
  noteNodes: Set<Element>;
  units: SplitUnit[];
  start: number;
}

function pushSplitUnit(
  ctx: UnitWalkContext,
  node: Element,
  anchors: string[],
  text: string,
  boundary: boolean,
) {
  ctx.units.push({
    key: `u${String(ctx.units.length + 1).padStart(6, "0")}`,
    path: ctx.itemPath,
    index: ctx.units.length,
    anchors,
    sha256: sha256(serialize(node)),
    text,
    boundary,
    node,
  });
}

function walkContainerUnit(
  node: Element,
  nested: Element[],
  own: string,
  anchors: string[],
  ctx: UnitWalkContext,
) {
  if (
    Array.from(node.childNodes).some(
      (child) => child.nodeType === 3 && child.textContent?.trim(),
    )
  )
    fail(
      "SPLIT_CONTENT",
      `Mixed container text has no safe block boundaries in ${ctx.itemPath}`,
    );
  let first = true;
  for (const child of nested) {
    const before = ctx.units.length;
    walkSplitUnitNode(child, first ? anchors : [], ctx);
    if (ctx.units.length > before) first = false;
  }
  if (!nested.length && own) pushSplitUnit(ctx, node, anchors, "", true);
}

function walkSplitUnitNode(
  node: Element,
  inherited: string[],
  ctx: UnitWalkContext,
) {
  if (ctx.noteNodes.has(node)) return;
  const nested = children(node);
  const own = attr(node, "id");
  const anchors = [...(own ? [own] : []), ...inherited];
  const hasNotes = elements(node).some((child) => ctx.noteNodes.has(child));
  if (isContainerUnit(node, hasNotes)) {
    walkContainerUnit(node, nested, own, anchors, ctx);
    return;
  }
  if (hasNotes)
    fail(
      "SPLIT_NOTE",
      `A note is embedded inside an indivisible content block in ${ctx.itemPath}`,
    );
  const text = (node.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  const boundary = anchors.length > 0 || ctx.units.length === ctx.start;
  pushSplitUnit(ctx, node, anchors, text, boundary);
}

function collectSourceUnits(
  info: EpubInspection,
  noteNodes: Set<Element>,
  navigationPaths: Set<string>,
): SplitUnit[] {
  const units: SplitUnit[] = [];
  for (const id of info.spine) {
    const item = info.manifest.find((manifestItem) => manifestItem.id === id);
    if (!item || !info.documents.has(item.path))
      fail("SPLIT_SPINE", "Only XHTML reading-order items are supported");
    if (navigationPaths.has(item.path)) continue;
    const document = info.documents.get(item.path)!;
    const body = elements(document, "body", NS.xhtml)[0];
    if (!body) fail("SPLIT_CONTENT", `Missing body in ${item.path}`);
    const rootId = attr(document.documentElement!, "id");
    walkSplitUnitNode(body, rootId ? [rootId] : [], {
      itemPath: item.path,
      noteNodes,
      units,
      start: units.length,
    });
  }
  if (!units.length) fail("SPLIT_CONTENT", "No readable content units found");
  return units;
}

function collectNavigationTargets(
  nodes: InspectedNavigationNode[],
  targets: string[],
) {
  for (const node of nodes) {
    if (node.target?.path) targets.push(node.target.path);
    collectNavigationTargets(node.children, targets);
  }
}

function verifyTocTargets(
  inspection: InspectionReport,
  units: SplitUnit[],
  navigationPaths: Set<string>,
  notes: Map<string, { path: string; id: string; node: Element }>,
) {
  // TOC targets outside the spine can be real chapters, not disposable resources.
  const tocTargets: string[] = [];
  for (const nav of inspection.navigation) {
    if (nav.type === "toc" || nav.format === "ncx")
      collectNavigationTargets(nav.items, tocTargets);
  }
  for (const target of tocTargets) {
    if (
      !units.some((unit) => unit.path === target) &&
      !navigationPaths.has(target) &&
      ![...notes.values()].some((note) => note.path === target)
    )
      fail(
        "SPLIT_ORDER",
        `TOC content outside the reading order requires an explicit spine repair: ${target}`,
      );
  }
}

export function splitSource(bytes: Buffer) {
  openMetadata(bytes, "epub");
  const info = inspectBytes(bytes, true);
  const inspection = describeInspection(info, bytes.length);
  validateSourcePackage(info, inspection);
  validateSourceDocumentsAndStyles(info);
  const { notes, noteNodes } = collectSourceNotes(info, inspection);
  const navigationPaths = new Set(
    info.manifest
      .filter((item) => item.properties.includes("nav"))
      .map((item) => item.path),
  );
  const units = collectSourceUnits(info, noteNodes, navigationPaths);
  verifyTocTargets(inspection, units, navigationPaths, notes);
  const inventory = {
    units: units.map(({ node: _, ...unit }) => unit),
    spine: info.spine.map(
      (id) => info.manifest.find((item) => item.id === id)!.path,
    ),
    navigation: inspection.navigation,
    notes: [...notes].map(([key, note]) => ({
      key,
      path: note.path,
      id: note.id,
      sha256: sha256(serialize(note.node)),
    })),
    resources: [...info.entries].map(([name, entry]) => ({
      name,
      sha256: sha256(entry.bytes),
    })),
    metadata: serialize(elements(info.packageDocument, "metadata", NS.opf)[0]),
  };
  return { info, inspection, notes, noteNodes, units, inventory };
}
export type SplitSource = ReturnType<typeof splitSource>;

export function selectedDocument(
  document: Document,
  selected: Set<Element>,
  title: string,
  rootIds = new Map<Element, string>(),
  retainedAnchors = new Set<string>(),
) {
  const originalBody = elements(document, "body", NS.xhtml)[0],
    copy = document.cloneNode(true) as Document,
    body = elements(copy, "body", NS.xhtml)[0];
  while (body.firstChild) removeNode(body.firstChild);
  for (const ancestor of [body, copy.documentElement!])
    if (!retainedAnchors.has(attr(ancestor, "id")))
      ancestor.removeAttribute("id");
  const prune = (node: Node): Node | null => {
    if (node.nodeType !== 1)
      return node.nodeType === 3 || node.nodeType === 8
        ? node.cloneNode(true)
        : null;
    const element = node as Element;
    if (selected.has(element)) {
      const clone = element.cloneNode(true) as Element;
      const id = rootIds.get(element);
      if (id) clone.setAttribute("id", id);
      return clone;
    }
    if (!elements(element).some((child) => selected.has(child))) return null;
    const clone = element.cloneNode(false) as Element;
    if (!retainedAnchors.has(attr(clone, "id"))) clone.removeAttribute("id");
    for (const child of Array.from(element.childNodes)) {
      const kept = prune(child);
      if (kept) clone.appendChild(kept);
    }
    return clone;
  };
  for (const node of Array.from(originalBody.childNodes)) {
    const kept = prune(node);
    if (kept) body.appendChild(kept);
  }
  const heading = elements(copy, "title", NS.xhtml)[0];
  if (heading) heading.textContent = title;
  return copy;
}
export function resolveElement(
  source: SplitSource,
  from: string,
  href: string,
) {
  const target = localTarget(from, href),
    document = source.info.documents.get(target.path);
  const node = target.fragment
    ? document &&
      elements(document).find((node) => attr(node, "id") === target.fragment)
    : document && elements(document, "body", NS.xhtml)[0];
  if (!node) fail("SPLIT_REFERENCE", `Missing content target ${from}: ${href}`);
  return { ...target, node };
}
