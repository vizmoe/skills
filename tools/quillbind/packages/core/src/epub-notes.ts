import type { Element } from "@xmldom/xmldom";
import type { EpubInspection } from "./epub-types.js";
import { attr, elements, NS, removeNode } from "./xml.js";
import { localTarget } from "./paths.js";
import { sha256 } from "./hash.js";

const tokens = (value: string) => value.split(/\s+/).filter(Boolean);
const hasType = (el: Element, type: string) =>
  tokens(el.getAttributeNS(NS.epub, "type") ?? "").includes(type) ||
  tokens(attr(el, "role")).includes(`doc-${type}`);
const hasClass = (el: Element, name: string) =>
  tokens(attr(el, "class")).includes(name);
export const isNoteRefMarker = (el: Element) =>
  hasType(el, "noteref") || hasClass(el, "duokan-footnote");
export const isNoteTarget = (el: Element) =>
  hasType(el, "footnote") ||
  hasType(el, "endnote") ||
  hasType(el, "rearnote") ||
  hasClass(el, "duokan-footnote-item") ||
  (el.localName === "li" &&
    !!attr(el, "id") &&
    el.parentNode?.nodeType === 1 &&
    hasClass(el.parentNode as Element, "duokan-footnote-content"));
export function noteRefWrapper(el: Element): Element | undefined {
  const parent =
    el.parentNode?.nodeType === 1 ? (el.parentNode as Element) : undefined;
  if (!parent || !isNoteRefMarker(parent)) return undefined;
  const links = elements(parent, "a").filter((a) => a.hasAttribute("href"));
  return links.length === 1 && links[0] === el ? parent : undefined;
}
export const isNoteRefLink = (el: Element) =>
  isNoteRefMarker(el) || !!noteRefWrapper(el);
export function noteRefIds(el: Element): Set<string> {
  const wrapper = noteRefWrapper(el);
  return new Set(
    [attr(el, "id"), wrapper ? attr(wrapper, "id") : ""].filter(Boolean),
  );
}
export const noteRefId = (el: Element) =>
  attr(el, "id") || (noteRefWrapper(el) ? attr(noteRefWrapper(el)!, "id") : "");
const text = (el: Element) =>
  (el.textContent ?? "").replace(/\s+/g, " ").trim();
export function elementSelector(el: Element): string {
  const id = attr(el, "id");
  if (id)
    return (
      "#" + [...id].map((c) => `\\${c.codePointAt(0)!.toString(16)} `).join("")
    );
  const parent = el.parentNode;
  if (parent?.nodeType !== 1) return el.localName!;
  const siblings = Array.from(parent.childNodes).filter(
    (n) => n.nodeType === 1 && (n as Element).localName === el.localName,
  );
  return `${elementSelector(parent as Element)} > ${el.localName}:nth-of-type(${siblings.indexOf(el) + 1})`;
}
export function scriptingDocuments(
  info: Pick<EpubInspection, "manifest" | "documents">,
) {
  return [
    ...new Set([
      ...info.manifest
        .filter((item) => item.properties.includes("scripted"))
        .map((item) => item.path),
      ...[...info.documents]
        .filter(([, doc]) =>
          elements(doc).some(
            (el) =>
              ["script", "form"].includes(el.localName ?? "") ||
              Array.from(el.attributes).some(
                (a) => /^on/i.test(a.name) || /^\s*javascript:/i.test(a.value),
              ),
          ),
        )
        .map(([name]) => name),
    ]),
  ].sort((a, b) => a.localeCompare(b, "en"));
}

export interface NoteIssue {
  code: string;
  source: string;
  message: string;
  severity: "error" | "warning";
}
export interface NoteScript {
  source: string;
  kind: string;
  path?: string;
  sha256?: string;
  local: boolean;
}
type AddNoteIssue = (
  code: string,
  source: string,
  message: string,
  severity?: "error" | "warning",
) => void;

const activeElementNames = new Set([
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "video",
  "audio",
  "base",
]);

function indexDocumentIds(
  info: EpubInspection,
  add: AddNoteIssue,
): Map<string, Map<string, Element[]>> {
  return new Map(
    [...info.documents].map(([name, doc]) => {
      const index = new Map<string, Element[]>();
      for (const el of elements(doc)) {
        const id = attr(el, "id");
        if (id) index.set(id, [...(index.get(id) ?? []), el]);
      }
      for (const [id, matches] of index) {
        if (matches.length > 1)
          add("NOTE_DUPLICATE_ID", name, `Ambiguous ID: ${id}`);
      }
      return [name, index] as const;
    }),
  );
}

function inspectScriptElement(
  source: string,
  el: Element,
  info: EpubInspection,
  scripts: NoteScript[],
  add: AddNoteIssue,
) {
  const src = attr(el, "src");
  if (!src) {
    scripts.push({
      source,
      kind: "inline",
      sha256: sha256(Buffer.from(el.textContent ?? "")),
      local: true,
    });
    return;
  }
  try {
    const target = localTarget(source, src);
    const entry = info.entries.get(target.path);
    if (!entry || target.fragment)
      throw new Error("Script resource is missing or ambiguous");
    scripts.push({
      source,
      kind: "external-file",
      path: target.path,
      sha256: sha256(entry.bytes),
      local: true,
    });
  } catch {
    scripts.push({ source, kind: "external-file", local: false });
    add(
      "NOTE_SCRIPT_RESOURCE",
      source,
      `Script must resolve to a packaged local resource: ${src}`,
    );
  }
}

function inspectElementAttributes(
  source: string,
  el: Element,
  scripts: NoteScript[],
  active: { source: string; element: string }[],
  add: AddNoteIssue,
) {
  for (const a of Array.from(el.attributes)) {
    if (/^on/i.test(a.name))
      scripts.push({
        source,
        kind: `handler:${a.name}`,
        sha256: sha256(Buffer.from(a.value)),
        local: true,
      });
    if (/^\s*javascript:/i.test(a.value)) {
      active.push({ source, element: "javascript-uri" });
      add("NOTE_ACTIVE_URI", source, "Executable URI requires source review");
    }
  }
}

function collectActiveAndScripts(
  info: EpubInspection,
  add: AddNoteIssue,
): {
  scripts: NoteScript[];
  active: { source: string; element: string }[];
} {
  const scripts: NoteScript[] = [];
  const active: { source: string; element: string }[] = [];
  for (const [source, doc] of info.documents) {
    for (const el of elements(doc)) {
      if (
        activeElementNames.has(el.localName ?? "") ||
        (el.localName === "meta" &&
          attr(el, "http-equiv").toLowerCase() === "refresh")
      )
        active.push({ source, element: el.localName! });
      if (el.localName === "script")
        inspectScriptElement(source, el, info, scripts, add);
      inspectElementAttributes(source, el, scripts, active, add);
    }
  }
  return { scripts, active };
}

function isNoteReferenceCandidate(el: Element): boolean {
  if (el.localName === "a" && el.hasAttribute("href")) return isNoteRefLink(el);
  if (!isNoteRefMarker(el)) return false;
  const links = elements(el, "a").filter((a) => a.hasAttribute("href"));
  return links.length !== 1;
}

function isMatchingBacklink(
  link: Element,
  targetPath: string,
  source: string,
  refIds: Set<string>,
): boolean {
  try {
    const to = localTarget(targetPath, attr(link, "href"));
    return to.path === source && !!to.fragment && refIds.has(to.fragment);
  } catch {
    return false;
  }
}

function stripNoteBacklinks(
  note: Element,
  targetPath: string,
  source: string,
  refIds: Set<string>,
): Element {
  const copy = note.cloneNode(true) as Element;
  for (const link of elements(copy, "a")) {
    if (isMatchingBacklink(link, targetPath, source, refIds)) removeNode(link);
  }
  return copy;
}

function inspectNoteReference(
  source: string,
  el: Element,
  ids: Map<string, Map<string, Element[]>>,
  add: AddNoteIssue,
) {
  const id = noteRefId(el);
  const refIds = noteRefIds(el);
  const href = attr(el, "href");
  const base = { source, id, href, trigger: elementSelector(el) };
  try {
    const target = localTarget(source, href);
    const found = target.fragment
      ? ids.get(target.path)?.get(target.fragment)
      : undefined;
    if (found?.length !== 1)
      throw new Error("Note target must resolve to exactly one local element");
    const note = found[0];
    const backlinks = elements(note, "a").filter((link) =>
      isMatchingBacklink(link, target.path, source, refIds),
    );
    const copy = stripNoteBacklinks(note, target.path, source, refIds);
    if (!backlinks.length)
      add(
        "NOTE_BACKLINK",
        source,
        `No return link for ${id || href}`,
        "warning",
      );
    // Some readers wrap the entire note in its return link.
    const noteText = text(copy) || text(note);
    if (!noteText) add("NOTE_EMPTY", source, `Empty note target: ${href}`);
    return {
      ...base,
      target,
      resolution: "resolved" as const,
      text: noteText,
      popup: elementSelector(note),
      backlinks: backlinks.map((link) => ({
        source: target.path,
        selector: elementSelector(link),
      })),
    };
  } catch (error) {
    add("NOTE_TARGET", source, `${href}: ${String(error)}`);
    return { ...base, resolution: "unresolved" as const };
  }
}

function classifyNotesKind(
  canPreserve: boolean,
  scriptedCount: number,
  referenceCount: number,
) {
  if (canPreserve) return "scripted-note-candidate" as const;
  if (scriptedCount) return "scripted-content" as const;
  if (referenceCount) return "semantic-notes" as const;
  return "none" as const;
}

export function inspectNotes(info: EpubInspection) {
  const issues: NoteIssue[] = [];
  const add: AddNoteIssue = (code, source, message, severity = "error") => {
    issues.push({ code, source, message, severity });
  };
  const ids = indexDocumentIds(info, add);
  const scriptedDocuments = scriptingDocuments(info);
  const { scripts, active } = collectActiveAndScripts(info, add);
  const references = [...info.documents].flatMap(([source, doc]) =>
    elements(doc)
      .filter(isNoteReferenceCandidate)
      .map((el) => inspectNoteReference(source, el, ids, add)),
  );
  const canPreserve =
    scriptedDocuments.length > 0 &&
    references.length > 0 &&
    active.length === 0 &&
    !issues.some((i) => i.severity === "error") &&
    !info.entries.has("META-INF/signatures.xml") &&
    scriptedDocuments.every((name) => info.documents.has(name));
  return {
    kind: classifyNotesKind(
      canPreserve,
      scriptedDocuments.length,
      references.length,
    ),
    execution: "not-run" as const,
    scriptedDocuments,
    declarations: info.manifest
      .filter((item) => item.properties.includes("scripted"))
      .map((item) => item.path),
    scripts,
    active,
    references,
    issues,
    limitation:
      "Markup identifies note candidates, not script purpose or verified popup behavior",
  };
}
