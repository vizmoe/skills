import type { Document, Element, Node } from "@xmldom/xmldom";
import { openMetadata, children } from "./metadata-file.js";
import { inspectBytes } from "./epub.js";
import { describeInspection } from "./inspection.js";
import { elements, attr, NS, serialize } from "./xml.js";
import { localTarget } from "./paths.js";
import { sha256 } from "./hash.js";
import { fail } from "./errors.js";

export const semantic = (node: Element, value: string) =>
  (node.getAttributeNS(NS.epub, "type") ?? "").split(/\s+/).includes(value) ||
  attr(node, "role").split(/\s+/).includes(`doc-${value}`);
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
export function splitSource(bytes: Buffer) {
  openMetadata(bytes, "epub");
  const info = inspectBytes(bytes, true),
    inspection = describeInspection(info, bytes.length);
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
  const checkCss = (value: string, name: string) => {
    if (/\\|image-set\s*\(|\bsrc\s*\(/i.test(value))
      fail(
        "SPLIT_CSS",
        `Normalize escaped or dynamic CSS references before splitting: ${name}`,
      );
  };
  for (const [name, doc] of info.documents) {
    for (const node of elements(doc)) {
      if (node.localName === "style") checkCss(node.textContent ?? "", name);
      if (node.hasAttribute("style")) checkCss(attr(node, "style"), name);
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
          [
            "picture",
            "source",
            "iframe",
            "object",
            "embed",
            "audio",
            "video",
            "base",
          ].includes(node.localName ?? ""),
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
  for (const item of info.manifest.filter(
    (item) => item.mediaType === "text/css",
  ))
    checkCss(info.entries.get(item.path)!.bytes.toString(), item.path);
  const notes = new Map<string, { path: string; id: string; node: Element }>();
  for (const [name, doc] of info.documents)
    for (const node of elements(doc))
      if (semantic(node, "footnote") || semantic(node, "endnote")) {
        const id = attr(node, "id");
        if (!id) fail("SPLIT_NOTE", `Note needs a stable ID in ${name}`);
        notes.set(noteKey(name, id), { path: name, id, node });
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
      (node) => attr(node, "id") === reference.target.fragment,
    )!;
    notes.set(noteKey(reference.target.path, reference.target.fragment), {
      path: reference.target.path,
      id: reference.target.fragment,
      node,
    });
  }
  for (const note of notes.values()) {
    if (
      !["aside", "div", "section", "p", "li", "blockquote"].includes(
        note.node.localName ?? "",
      )
    )
      fail(
        "SPLIT_NOTE",
        "Inline note targets need explicit structural preparation",
        { path: note.path, id: note.id },
      );
    for (
      let parent = note.node.parentNode;
      parent?.nodeType === 1;
      parent = parent.parentNode
    )
      if ([...notes.values()].some((other) => other.node === parent))
        fail("SPLIT_NOTE", "Nested note targets are ambiguous");
  }
  const noteNodes = new Set([...notes.values()].map((note) => note.node)),
    units: SplitUnit[] = [];
  const navigationPaths = new Set(
    info.manifest
      .filter((item) => item.properties.includes("nav"))
      .map((item) => item.path),
  );
  for (const id of info.spine) {
    const item = info.manifest.find((item) => item.id === id);
    if (!item || !info.documents.has(item.path))
      fail("SPLIT_SPINE", "Only XHTML reading-order items are supported");
    if (navigationPaths.has(item.path)) continue;
    const body = elements(info.documents.get(item.path)!, "body", NS.xhtml)[0];
    if (!body) fail("SPLIT_CONTENT", `Missing body in ${item.path}`);
    const start = units.length;
    const walk = (node: Element, inherited: string[]) => {
      if (noteNodes.has(node)) return;
      const nested = children(node),
        own = attr(node, "id"),
        anchors = [...(own ? [own] : []), ...inherited];
      const hasNotes = elements(node).some((child) => noteNodes.has(child));
      if (
        ["body", "div", "section", "article", "main"].includes(
          node.localName ?? "",
        ) ||
        (hasNotes && ["ol", "ul"].includes(node.localName ?? ""))
      ) {
        if (
          Array.from(node.childNodes).some(
            (child) => child.nodeType === 3 && child.textContent?.trim(),
          )
        )
          fail(
            "SPLIT_CONTENT",
            `Mixed container text has no safe block boundaries in ${item.path}`,
          );
        let first = true;
        for (const child of nested) {
          const before = units.length;
          walk(child, first ? anchors : []);
          if (units.length > before) first = false;
        }
        if (!nested.length && own)
          units.push({
            key: `u${String(units.length + 1).padStart(6, "0")}`,
            path: item.path,
            index: units.length,
            anchors,
            sha256: sha256(serialize(node)),
            text: "",
            boundary: true,
            node,
          });
        return;
      }
      if (hasNotes)
        fail(
          "SPLIT_NOTE",
          `A note is embedded inside an indivisible content block in ${item.path}`,
        );
      units.push({
        key: `u${String(units.length + 1).padStart(6, "0")}`,
        path: item.path,
        index: units.length,
        anchors,
        sha256: sha256(serialize(node)),
        text: (node.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240),
        boundary: anchors.length > 0 || units.length === start,
        node,
      });
    };
    const rootId = attr(info.documents.get(item.path)!.documentElement!, "id");
    walk(body, rootId ? [rootId] : []);
  }
  if (!units.length) fail("SPLIT_CONTENT", "No readable content units found");
  // TOC targets outside the spine can be real chapters, not disposable resources.
  const tocTargets = inspection.navigation
    .filter((nav) => nav.type === "toc" || nav.format === "ncx")
    .flatMap((nav) => {
      const targets: string[] = [];
      const visit = (nodes: typeof nav.items) => {
        for (const node of nodes) {
          if (node.target?.path) targets.push(node.target.path);
          visit(node.children);
        }
      };
      visit(nav.items);
      return targets;
    });
  for (const target of tocTargets)
    if (
      !units.some((unit) => unit.path === target) &&
      !navigationPaths.has(target) &&
      ![...notes.values()].some((note) => note.path === target)
    )
      fail(
        "SPLIT_ORDER",
        `TOC content outside the reading order requires an explicit spine repair: ${target}`,
      );
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
  while (body.firstChild) body.removeChild(body.firstChild);
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
