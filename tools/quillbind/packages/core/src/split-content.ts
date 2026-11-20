import type { Document, Element } from "@xmldom/xmldom";
import { attr, elements, NS, serialize } from "./xml.js";
import { localTarget } from "./paths.js";
import { fail } from "./errors.js";
import {
  selectedDocument,
  resolveElement,
  semantic,
  noteRefId,
  noteRefIds,
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
function addSelectedNode(
  selected: Map<string, Set<Element>>,
  name: string,
  node: Element,
) {
  const set = selected.get(name) ?? new Set<Element>();
  set.add(node);
  selected.set(name, set);
}

function registerUnitRoots(source: SplitSource, units: SplitUnit[]) {
  const selected = new Map<string, Set<Element>>();
  const rootIds = new Map<Element, string>();
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
    addSelectedNode(selected, unit.path, unit.node);
  }
  return { selected, rootIds, unitIds };
}

function noteHasReturnLink(
  note: { path: string; node: Element },
  itemPath: string,
  refIds: Set<string>,
): boolean {
  return elements(note.node, "a").some((back) => {
    try {
      const to = localTarget(note.path, attr(back, "href"));
      return to.path === itemPath && !!to.fragment && refIds.has(to.fragment);
    } catch {
      return false;
    }
  });
}

function resolveReferencedNote(
  source: SplitSource,
  item: { path: string; node: Element },
  link: Element,
  state: {
    notes: Set<string>;
    references: Map<string, string>;
    selected: Map<string, Set<Element>>;
    queue: { path: string; node: Element }[];
  },
) {
  if (link.localName !== "a" || !link.hasAttribute("href")) return;
  const href = attr(link, "href");
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return;
  if (
    !source.info.documents.has(localTarget(item.path, href).path) &&
    !semantic(link, "noteref")
  )
    return;
  const target = resolveElement(source, item.path, href);
  const key = noteKey(target.path, target.fragment ?? "");
  const note = source.notes.get(key);
  if (!note) {
    if (semantic(link, "noteref"))
      fail("SPLIT_NOTE", "Unresolved note reference");
    return;
  }
  const linkId = noteRefId(link);
  if (!linkId)
    fail("SPLIT_NOTE", "A note reference requires a stable return-link ID");
  const refKey = noteKey(item.path, linkId);
  state.references.set(refKey, key);
  if (!noteHasReturnLink(note, item.path, noteRefIds(link)))
    fail("SPLIT_NOTE", `Note lacks a return link for ${refKey}`);
  if (!state.notes.has(key)) {
    state.notes.add(key);
    addSelectedNode(state.selected, note.path, note.node);
    state.queue.push({ path: note.path, node: note.node });
  }
}

function collectReferencedNotes(
  source: SplitSource,
  units: SplitUnit[],
  selected: Map<string, Set<Element>>,
) {
  const notes = new Set<string>();
  const queue = units.map((unit) => ({ path: unit.path, node: unit.node }));
  const references = new Map<string, string>();
  for (const reference of source.inspection.notes.references) {
    if (reference.resolution === "resolved")
      references.set(
        noteKey(reference.source, reference.id),
        noteKey(reference.target.path, reference.target.fragment!),
      );
  }
  const state = { notes, references, selected, queue };
  for (const item of queue) {
    for (const link of [item.node, ...elements(item.node)])
      resolveReferencedNote(source, item, link, state);
  }
  return { notes, references };
}

function targetPresentInSelection(
  documents: Map<string, Document>,
  name: string,
  fragment?: string,
): boolean {
  const doc = documents.get(name);
  if (!doc) return false;
  return (
    !fragment || elements(doc).some((node) => attr(node, "id") === fragment)
  );
}

function ownsTargetDocumentStart(
  source: SplitSource,
  documents: Map<string, Document>,
  unitIds: Map<string, string>,
  target: { path: string; fragment?: string },
): boolean {
  if (target.fragment) return true;
  const firstUnit = source.units.find((unit) => unit.path === target.path);
  if (firstUnit) return unitIds.has(firstUnit.key);
  const selectedDoc = documents.get(target.path);
  if (!selectedDoc) return false;
  const originalBody = elements(
    source.info.documents.get(target.path)!,
    "body",
    NS.xhtml,
  )[0];
  const selectedBody = elements(selectedDoc, "body", NS.xhtml)[0];
  return selectedBody.textContent?.trim() === originalBody.textContent?.trim();
}

function isInsideSelectedNote(
  link: Element,
  name: string,
  notes: Set<string>,
): boolean {
  for (
    let node: Element | null = link;
    node;
    node = node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
  ) {
    if (notes.has(noteKey(name, attr(node, "id")))) return true;
  }
  return false;
}

function replaceLinkWithSpan(document: Document, link: Element) {
  const replacement = document.createElementNS(NS.xhtml, "span");
  for (const attribute of Array.from(link.attributes)) {
    if (!["href", "epub:type", "role"].includes(attribute.name))
      replacement.setAttributeNS(
        attribute.namespaceURI,
        attribute.name,
        attribute.value,
      );
  }
  while (link.firstChild) replacement.appendChild(link.firstChild);
  link.parentNode!.replaceChild(replacement, link);
}

function processDocumentCrossLink(
  name: string,
  document: Document,
  link: Element,
  ctx: {
    source: SplitSource;
    documents: Map<string, Document>;
    unitIds: Map<string, string>;
    notes: Set<string>;
    references: Map<string, string>;
    decisions: CrossLink[];
    crossLinks: CrossLink[];
    noteReturns: { source: string; id: string; href: string }[];
  },
) {
  const href = attr(link, "href");
  if (!link.hasAttribute("href") || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href))
    return;
  const target = localTarget(name, href);
  if (!ctx.source.info.documents.has(target.path)) return; // Images/downloads enter resource closure later.
  if (
    targetPresentInSelection(ctx.documents, target.path, target.fragment) &&
    ownsTargetDocumentStart(ctx.source, ctx.documents, ctx.unitIds, target)
  )
    return;
  if (semantic(link, "noteref"))
    fail("SPLIT_NOTE", "A selected note reference lost its target");
  const inNote = isInsideSelectedNote(link, name, ctx.notes);
  if (
    inNote &&
    ctx.references.has(noteKey(target.path, target.fragment ?? ""))
  ) {
    ctx.noteReturns.push({ source: name, id: attr(link, "id"), href });
  } else {
    const decision = ctx.decisions.find(
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
    ctx.crossLinks.push(decision);
  }
  replaceLinkWithSpan(document, link);
}

export function splitContent(
  source: SplitSource,
  units: SplitUnit[],
  volume: SplitVolume,
  decisions: CrossLink[],
) {
  const { selected, rootIds, unitIds } = registerUnitRoots(source, units);
  const { notes, references } = collectReferencedNotes(source, units, selected);
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
  const crossLinks: CrossLink[] = [];
  const noteReturns: { source: string; id: string; href: string }[] = [];
  const linkCtx = {
    source,
    documents,
    unitIds,
    notes,
    references,
    decisions,
    crossLinks,
    noteReturns,
  };
  for (const [name, document] of documents) {
    for (const link of elements(document, "a", NS.xhtml))
      processDocumentCrossLink(name, document, link, linkCtx);
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
