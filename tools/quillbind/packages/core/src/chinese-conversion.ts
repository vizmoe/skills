import type { Element, Node } from "@xmldom/xmldom";
import { inspectBytes } from "./epub.js";
import { contentXml, ncxXml, xml, attr, serialize, NS } from "./xml.js";
import { escapeXml } from "./xml.js";
import { fail } from "./errors.js";
import { sha256 } from "./hash.js";
import { pack } from "./zip.js";
import { conversionLanguages, type ZhconvertSession } from "./zhconvert.js";

const chinese = (language: string) => /^zh(?:-|$)/i.test(language);
const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
const ncxNamespace = "http://www.daisy.org/z3986/2005/ncx/";
const protectedElements = new Set([
  "code",
  "pre",
  "kbd",
  "samp",
  "script",
  "style",
]);
const metadataFields = new Set([
  "title",
  "creator",
  "contributor",
  "description",
  "subject",
  "publisher",
  "rights",
  "coverage",
]);

/** Convert text slots, never serialized markup, paths, identifiers or resources. */
export async function convertChineseContent(
  bytes: Uint8Array,
  session: ZhconvertSession,
  epoch = 946684800,
) {
  const info = inspectBytes(bytes);
  if (info.version !== "3.0")
    fail(
      "CONVERSION_EPUB_VERSION",
      "Convert an EPUB 3 book; use epub repair to upgrade EPUB 2 first",
    );
  if (!chinese(info.language))
    fail(
      "CONVERSION_LANGUAGE",
      "Chinese conversion requires a zh book language",
    );
  if (info.unsupported.length || info.entries.has("META-INF/signatures.xml"))
    fail(
      "CONVERSION_UNSUPPORTED",
      "Cannot convert this EPUB structure",
      info.unsupported,
    );
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  const language = conversionLanguages[session.target];
  const slots: { value: string; apply: (value: string) => void }[] = [];
  const documents: { path: string; save: () => string; changed: boolean }[] =
    [];
  const files = new Map<string, string>([[info.packagePath, "opf"]]);
  for (const item of info.manifest)
    if (info.documents.has(item.path)) files.set(item.path, "xhtml");
    else if (item.mediaType === "application/x-dtbncx+xml")
      files.set(item.path, "ncx");
  for (const [file, kind] of files) {
    const source = entries.get(file);
    if (!source)
      fail("RESOURCE_MISSING", `Missing conversion document: ${file}`);
    const document = (
      kind === "xhtml" ? contentXml : kind === "ncx" ? ncxXml : xml
    )(source.toString("utf8"), file);
    const state = {
      path: file,
      save: () => serialize(document),
      changed: false,
    };
    documents.push(state);
    const slot = (value: string, apply: (value: string) => void) => {
      // URL labels and source citations can contain Han paths; keep their identity.
      if (/^[a-z][a-z0-9+.-]*:\S+$/i.test(value.trim())) return;
      slots.push({
        value,
        apply: (converted) => {
          if (converted !== value) {
            escapeXml(converted);
            apply(converted);
            state.changed = true;
          }
        },
      });
    };
    const walk = (node: Node, inherited: string, allowed: boolean) => {
      if (node.nodeType === 3 || node.nodeType === 4) {
        if (allowed && chinese(inherited))
          slot(node.nodeValue ?? "", (value) =>
            node.parentNode!.replaceChild(document.createTextNode(value), node),
          );
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      const name = element.localName ?? "";
      if (
        element.namespaceURI === NS.math ||
        element.namespaceURI === "http://www.w3.org/2000/svg" ||
        (element.namespaceURI === NS.xhtml && protectedElements.has(name)) ||
        attr(element, "translate").toLowerCase() === "no"
      )
        return;
      const current =
        element.getAttributeNS(xmlNamespace, "lang") ??
        element.getAttribute("lang") ??
        inherited;
      const isChinese = chinese(current);
      for (const name of ["xml:lang", "lang"])
        if (chinese(attr(element, name))) {
          element.setAttribute(name, language);
          state.changed = true;
        }
      if (kind === "xhtml") {
        allowed = element.namespaceURI === NS.xhtml;
        if (allowed && isChinese) {
          for (const attribute of [
            "alt",
            "title",
            "aria-label",
            "aria-description",
          ])
            if (element.hasAttribute(attribute))
              slot(attr(element, attribute), (value) =>
                element.setAttribute(attribute, value),
              );
          if (
            name === "meta" &&
            ["author", "description"].includes(attr(element, "name"))
          )
            slot(attr(element, "content"), (value) =>
              element.setAttribute("content", value),
            );
        }
      } else if (kind === "opf") {
        allowed =
          (element.namespaceURI === NS.dc && metadataFields.has(name)) ||
          (element.namespaceURI === NS.opf &&
            name === "meta" &&
            ["file-as", "alternate-script"].includes(
              attr(element, "property"),
            ));
        if (element.namespaceURI === NS.dc && name === "language") {
          if (chinese((element.textContent ?? "").trim())) {
            element.textContent = language;
            state.changed = true;
          }
          return;
        }
      } else allowed = element.namespaceURI === ncxNamespace && name === "text";
      for (const child of Array.from(element.childNodes))
        walk(child, current, allowed);
    };
    walk(document.documentElement!, info.language, false);
  }
  const converted = await session.translate(slots.map((slot) => slot.value));
  slots.forEach((slot, index) => slot.apply(converted[index]));
  const changes = documents
    .filter((document) => document.changed)
    .map((document) => {
      const converted = Buffer.from(document.save());
      const change = {
        path: document.path,
        sourceSha256: sha256(entries.get(document.path)!),
        outputSha256: sha256(converted),
      };
      entries.set(document.path, converted);
      return change;
    });
  // Parse the new bytes before any candidate is passed to release tooling.
  const output = pack(entries, epoch);
  inspectBytes(output, true);
  return { bytes: output, changes };
}
