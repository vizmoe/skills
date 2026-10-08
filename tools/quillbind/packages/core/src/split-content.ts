import type { Document, Element } from "@xmldom/xmldom";
import { attr, elements, NS, serialize } from "./xml.js";
import { localTarget } from "./paths.js";
import { fail } from "./errors.js";
import {
  selectedDocument,
  resolveElement,
  semantic,
  noteKey,
  type SplitSource,
  type SplitUnit,
} from "./split-source.js";
import type { SplitVolume } from "./split-model.js";

export interface CrossLink {
  source: string;
  id: string;
  href: string;
  action: "unlink";
  evidence: string;
}
export function splitContent(
  source: SplitSource,
  units: SplitUnit[],
  volume: SplitVolume,
  decisions: CrossLink[],
) {
  const selected = new Map<string, Set<Element>>(),
    rootIds = new Map<Element, string>();
  const add = (name: string, node: Element) => {
    const set = selected.get(name) ?? new Set<Element>();
    set.add(node);
    selected.set(name, set);
  };
  const unitIds = new Map<string, string>();
  for (const unit of units) {
    const id = attr(unit.node, "id") || `quillbind-split-${unit.key}`;
    if (
      !attr(unit.node, "id") &&
      elements(source.info.documents.get(unit.path)!).some(
        (node) => attr(node, "id") === id,
      )
    )
      fail("SPLIT_ID", "Generated content anchor collides with a source ID");
    unitIds.set(unit.key, id);
    rootIds.set(unit.node, id);
    add(unit.path, unit.node);
  }
  const notes = new Set<string>(),
    queue = units.map((unit) => ({ path: unit.path, node: unit.node })),
    references = new Map<string, string>();
  for (const reference of source.inspection.notes.references)
    if (reference.resolution === "resolved")
      references.set(
        noteKey(reference.source, reference.id),
        noteKey(reference.target.path, reference.target.fragment!),
      );
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    for (const link of [item.node, ...elements(item.node)]) {
      if (link.localName !== "a" || !link.hasAttribute("href")) continue;
      const href = attr(link, "href");
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) continue;
      if (
        !source.info.documents.has(localTarget(item.path, href).path) &&
        !semantic(link, "noteref")
      )
        continue;
      const target = resolveElement(source, item.path, href),
        key = noteKey(target.path, target.fragment ?? "");
      const note = source.notes.get(key);
      if (!note) {
        if (semantic(link, "noteref"))
          fail("SPLIT_NOTE", "Unresolved note reference");
        continue;
      }
      if (!attr(link, "id"))
        fail("SPLIT_NOTE", "A note reference requires a stable return-link ID");
      const refKey = noteKey(item.path, attr(link, "id"));
      references.set(refKey, key);
      const returns = elements(note.node, "a").some((back) => {
        try {
          const to = localTarget(note.path, attr(back, "href"));
          return to.path === item.path && to.fragment === attr(link, "id");
        } catch {
          return false;
        }
      });
      if (!returns)
        fail("SPLIT_NOTE", `Note lacks a return link for ${refKey}`);
      if (!notes.has(key)) {
        notes.add(key);
        add(note.path, note.node);
        queue.push({ path: note.path, node: note.node });
      }
    }
  }
  const documents = new Map<string, Document>();
  for (const [name, nodes] of selected)
    documents.set(
      name,
      selectedDocument(
        source.info.documents.get(name)!,
        nodes,
        volume.metadata.title,
        rootIds,
        new Set(
          units
            .filter((unit) => unit.path === name)
            .flatMap((unit) => unit.anchors),
        ),
      ),
    );
  const present = (name: string, fragment?: string) => {
    const doc = documents.get(name);
    return (
      !!doc &&
      (!fragment || elements(doc).some((node) => attr(node, "id") === fragment))
    );
  };
  const crossLinks: CrossLink[] = [],
    noteReturns: { source: string; id: string; href: string }[] = [];
  for (const [name, document] of documents)
    for (const link of elements(document, "a", NS.xhtml)) {
      const href = attr(link, "href");
      if (!link.hasAttribute("href") || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href))
        continue;
      const target = localTarget(name, href);
      if (!source.info.documents.has(target.path)) continue; // Images/downloads enter resource closure later.
      const firstUnit = source.units.find((unit) => unit.path === target.path);
      const originalBody = elements(
        source.info.documents.get(target.path)!,
        "body",
        NS.xhtml,
      )[0];
      const selectedBody = documents.has(target.path)
        ? elements(documents.get(target.path)!, "body", NS.xhtml)[0]
        : undefined;
      const ownsBeginning =
        target.fragment ||
        (firstUnit
          ? unitIds.has(firstUnit.key)
          : !!selectedBody &&
            selectedBody.textContent?.trim() ===
              originalBody.textContent?.trim());
      if (present(target.path, target.fragment) && ownsBeginning) continue;
      if (semantic(link, "noteref"))
        fail("SPLIT_NOTE", "A selected note reference lost its target");
      let inNote = false;
      for (
        let node: Element | null = link;
        node;
        node =
          node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
      )
        if (notes.has(noteKey(name, attr(node, "id")))) inNote = true;
      if (inNote && references.has(noteKey(target.path, target.fragment ?? "")))
        noteReturns.push({ source: name, id: attr(link, "id"), href });
      else {
        const decision = decisions.find(
          (item) =>
            item.source === name &&
            item.id === attr(link, "id") &&
            item.href === href,
        );
        if (!decision)
          fail(
            "SPLIT_CROSS_VOLUME",
            "Cross-volume link requires an explicit disposition; classify untagged notes before splitting",
            { source: name, id: attr(link, "id"), href, target },
          );
        crossLinks.push(decision);
      }
      const replacement = document.createElementNS(NS.xhtml, "span");
      for (const attribute of Array.from(link.attributes))
        if (!["href", "epub:type", "role"].includes(attribute.name))
          replacement.setAttributeNS(
            attribute.namespaceURI,
            attribute.name,
            attribute.value,
          );
      while (link.firstChild) replacement.appendChild(link.firstChild);
      link.parentNode!.replaceChild(replacement, link);
    }
  for (const unit of units) {
    const clone = elements(documents.get(unit.path)!).find(
      (node) => attr(node, "id") === unitIds.get(unit.key),
    );
    if (!clone || (clone.textContent ?? "") !== (unit.node.textContent ?? ""))
      fail("SPLIT_TEXT", `Content changed during selection: ${unit.key}`);
  }
  return {
    documents,
    notes: [...notes],
    unitIds,
    crossLinks,
    noteReturns,
    entries: new Map(
      [...documents].map(([name, doc]) => [name, Buffer.from(serialize(doc))]),
    ),
  };
}
