import type { Document as XmlDocument, Element, Node } from "@xmldom/xmldom";
import { inspectBytes, type EpubInspection } from "./epub.js";
import {
  contentXml,
  ncxXml,
  xml,
  attr,
  serialize,
  NS,
  escapeXml,
} from "./xml.js";
import { fail } from "./errors.js";
import { sha256 } from "./hash.js";
import { pack } from "./zip.js";
import { conversionLanguages, type ZhconvertSession } from "./zhconvert.js";

const chinese = (language: string) => /^zh(?:-|$)/i.test(language);
const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
const ncxNamespace = NS.ncx;
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

type DocumentKind = "opf" | "xhtml" | "ncx";
interface ConversionSlot {
  value: string;
  apply: (value: string) => void;
}
interface DocumentState {
  path: string;
  save: () => string;
  changed: boolean;
}
interface WalkContext {
  document: XmlDocument;
  kind: DocumentKind;
  language: string;
  state: DocumentState;
  slots: ConversionSlot[];
}

function collectConversionFiles(
  info: EpubInspection,
): Map<string, DocumentKind> {
  const files = new Map<string, DocumentKind>([[info.packagePath, "opf"]]);
  for (const item of info.manifest) {
    if (info.documents.has(item.path)) files.set(item.path, "xhtml");
    else if (item.mediaType === "application/x-dtbncx+xml")
      files.set(item.path, "ncx");
  }
  return files;
}

function parseConversionDocument(
  kind: DocumentKind,
  source: Buffer,
  file: string,
): XmlDocument {
  const text = source.toString("utf8");
  if (kind === "xhtml") return contentXml(text, file);
  if (kind === "ncx") return ncxXml(text, file);
  return xml(text, file);
}

function recordSlot(
  context: WalkContext,
  value: string,
  apply: (value: string) => void,
) {
  // URL labels and source citations can contain Han paths; keep their identity.
  if (/^[a-z][a-z0-9+.-]*:\S+$/i.test(value.trim())) return;
  context.slots.push({
    value,
    apply: (converted) => {
      if (converted !== value) {
        escapeXml(converted);
        apply(converted);
        context.state.changed = true;
      }
    },
  });
}

function isProtectedElement(element: Element, name: string): boolean {
  return (
    element.namespaceURI === NS.math ||
    element.namespaceURI === "http://www.w3.org/2000/svg" ||
    (element.namespaceURI === NS.xhtml && protectedElements.has(name)) ||
    attr(element, "translate").toLowerCase() === "no"
  );
}

function updateLangAttributes(
  element: Element,
  language: string,
  state: DocumentState,
) {
  for (const langAttr of ["xml:lang", "lang"]) {
    if (chinese(attr(element, langAttr))) {
      element.setAttribute(langAttr, language);
      state.changed = true;
    }
  }
}

function collectXhtmlAttributes(
  element: Element,
  name: string,
  context: WalkContext,
) {
  for (const attribute of ["alt", "title", "aria-label", "aria-description"]) {
    if (element.hasAttribute(attribute))
      recordSlot(context, attr(element, attribute), (value) =>
        element.setAttribute(attribute, value),
      );
  }
  if (
    name === "meta" &&
    ["author", "description"].includes(attr(element, "name"))
  )
    recordSlot(context, attr(element, "content"), (value) =>
      element.setAttribute("content", value),
    );
}

function handleOpfElement(
  element: Element,
  name: string,
  context: WalkContext,
): { allowed: boolean; descend: boolean } {
  if (element.namespaceURI === NS.dc && name === "language") {
    if (chinese((element.textContent ?? "").trim())) {
      element.textContent = context.language;
      context.state.changed = true;
    }
    return { allowed: false, descend: false };
  }
  const isDcField = element.namespaceURI === NS.dc && metadataFields.has(name);
  const isOpfMeta =
    element.namespaceURI === NS.opf &&
    name === "meta" &&
    ["file-as", "alternate-script"].includes(attr(element, "property"));
  return { allowed: isDcField || isOpfMeta, descend: true };
}

function handleElementScope(
  element: Element,
  name: string,
  isChinese: boolean,
  context: WalkContext,
): { allowed: boolean; descend: boolean } {
  if (context.kind === "xhtml") {
    const allowed = element.namespaceURI === NS.xhtml;
    if (allowed && isChinese) collectXhtmlAttributes(element, name, context);
    return { allowed, descend: true };
  }
  if (context.kind === "opf") return handleOpfElement(element, name, context);
  return {
    allowed: element.namespaceURI === ncxNamespace && name === "text",
    descend: true,
  };
}

function walkConversionNode(
  node: Node,
  context: WalkContext,
  inherited: string,
  allowed: boolean,
) {
  if (node.nodeType === 3 || node.nodeType === 4) {
    if (allowed && chinese(inherited))
      recordSlot(context, node.nodeValue ?? "", (value) =>
        node.parentNode!.replaceChild(
          context.document.createTextNode(value),
          node,
        ),
      );
    return;
  }
  if (node.nodeType !== 1) return;
  const element = node as Element;
  const name = element.localName ?? "";
  if (isProtectedElement(element, name)) return;
  const current =
    element.getAttributeNS(xmlNamespace, "lang") ??
    element.getAttribute("lang") ??
    inherited;
  updateLangAttributes(element, context.language, context.state);
  const scope = handleElementScope(element, name, chinese(current), context);
  if (!scope.descend) return;
  for (const child of Array.from(element.childNodes))
    walkConversionNode(child, context, current, scope.allowed);
}

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
  const slots: ConversionSlot[] = [];
  const documents: DocumentState[] = [];
  for (const [file, kind] of collectConversionFiles(info)) {
    const source = entries.get(file);
    if (!source)
      fail("RESOURCE_MISSING", `Missing conversion document: ${file}`);
    const document = parseConversionDocument(kind, source, file);
    const state: DocumentState = {
      path: file,
      save: () => serialize(document),
      changed: false,
    };
    documents.push(state);
    walkConversionNode(
      document.documentElement!,
      { document, kind, language, state, slots },
      info.language,
      false,
    );
  }
  const converted = await session.translate(slots.map((slot) => slot.value));
  slots.forEach((slot, index) => slot.apply(converted[index]));
  const changes = documents
    .filter((document) => document.changed)
    .map((document) => {
      const convertedBytes = Buffer.from(document.save());
      const change = {
        path: document.path,
        sourceSha256: sha256(entries.get(document.path)!),
        outputSha256: sha256(convertedBytes),
      };
      entries.set(document.path, convertedBytes);
      return change;
    });
  // Parse the new bytes before any candidate is passed to release tooling.
  const output = pack(entries, epoch);
  inspectBytes(output, true);
  return { bytes: output, changes };
}
