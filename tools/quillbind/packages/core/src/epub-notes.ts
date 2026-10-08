import type { Element } from "@xmldom/xmldom";
import type { EpubInspection } from "./epub.js";
import { attr, elements, NS } from "./xml.js";
import { localTarget } from "./paths.js";
import { sha256 } from "./hash.js";

const tokens = (value: string) => value.split(/\s+/).filter(Boolean);
const semantic = (el: Element, type: string) =>
  tokens(el.getAttributeNS(NS.epub, "type") ?? "").includes(type) ||
  tokens(attr(el, "role")).includes(`doc-${type}`);
const text = (el: Element) =>
  (el.textContent ?? "").replace(/\s+/g, " ").trim();
export function elementSelector(el: Element): string {
  const id = attr(el, "id");
  if (id)
    return (
      "#" + [...id].map((c) => `\\${c.codePointAt(0)!.toString(16)} `).join("")
    );
  const parent = el.parentNode;
  if (!parent || parent.nodeType !== 1) return el.localName!;
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
  ].sort();
}

export function inspectNotes(info: EpubInspection) {
  const issues: {
    code: string;
    source: string;
    message: string;
    severity: "error" | "warning";
  }[] = [];
  const add = (
    code: string,
    source: string,
    message: string,
    severity: "error" | "warning" = "error",
  ) => issues.push({ code, source, message, severity });
  const ids = new Map(
    [...info.documents].map(([name, doc]) => {
      const index = new Map<string, Element[]>();
      for (const el of elements(doc)) {
        const id = attr(el, "id");
        if (id) index.set(id, [...(index.get(id) ?? []), el]);
      }
      for (const [id, matches] of index)
        if (matches.length > 1)
          add("NOTE_DUPLICATE_ID", name, `Ambiguous ID: ${id}`);
      return [name, index] as const;
    }),
  );
  const scriptedDocuments = scriptingDocuments(info);
  const scripts: {
    source: string;
    kind: string;
    path?: string;
    sha256?: string;
    local: boolean;
  }[] = [];
  const active: { source: string; element: string }[] = [];
  for (const [source, doc] of info.documents)
    for (const el of elements(doc)) {
      if (
        [
          "iframe",
          "object",
          "embed",
          "form",
          "input",
          "video",
          "audio",
          "base",
        ].includes(el.localName ?? "") ||
        (el.localName === "meta" &&
          attr(el, "http-equiv").toLowerCase() === "refresh")
      )
        active.push({ source, element: el.localName! });
      if (el.localName === "script") {
        const src = attr(el, "src");
        if (!src)
          scripts.push({
            source,
            kind: "inline",
            sha256: sha256(Buffer.from(el.textContent ?? "")),
            local: true,
          });
        else {
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
      }
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
          add(
            "NOTE_ACTIVE_URI",
            source,
            "Executable URI requires source review",
          );
        }
      }
    }
  const references = [...info.documents].flatMap(([source, doc]) =>
    elements(doc)
      .filter((el) => semantic(el, "noteref"))
      .map((el) => {
        const id = attr(el, "id"),
          href = attr(el, "href");
        const base = { source, id, href, trigger: elementSelector(el) };
        try {
          const target = localTarget(source, href);
          const found = target.fragment
            ? ids.get(target.path)?.get(target.fragment)
            : undefined;
          if (!found || found.length !== 1)
            throw new Error(
              "Note target must resolve to exactly one local element",
            );
          const note = found[0];
          const backlinks = elements(note, "a").filter((link) => {
            try {
              const to = localTarget(target.path, attr(link, "href"));
              return !!id && to.path === source && to.fragment === id;
            } catch {
              return false;
            }
          });
          const copy = note.cloneNode(true) as Element;
          for (const link of elements(copy, "a")) {
            try {
              const to = localTarget(target.path, attr(link, "href"));
              if (to.path === source && to.fragment === id)
                link.parentNode?.removeChild(link);
            } catch {
              /* unrelated text links remain part of the note */
            }
          }
          if (!backlinks.length)
            add(
              "NOTE_BACKLINK",
              source,
              `No return link for ${id || href}`,
              "warning",
            );
          // Some readers wrap the entire note in its return link.
          const noteText = text(copy) || text(note);
          if (!noteText)
            add("NOTE_EMPTY", source, `Empty note target: ${href}`);
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
      }),
  );
  const canPreserve =
    scriptedDocuments.length > 0 &&
    references.length > 0 &&
    active.length === 0 &&
    !issues.some((i) => i.severity === "error") &&
    !info.entries.has("META-INF/signatures.xml") &&
    scriptedDocuments.every((name) => info.documents.has(name));
  return {
    kind: canPreserve
      ? ("scripted-note-candidate" as const)
      : scriptedDocuments.length
        ? ("scripted-content" as const)
        : references.length
          ? ("semantic-notes" as const)
          : ("none" as const),
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
