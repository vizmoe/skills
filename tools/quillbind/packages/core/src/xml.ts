import { SaxesParser } from "saxes";
import {
  DOMParser,
  XMLSerializer,
  type Document,
  type Element,
} from "@xmldom/xmldom";
import { fail } from "./errors.js";
import { xhtmlEntities } from "./xhtml-entities.js";
import { passiveSvgCss } from "./css.js";
export const NS = {
  opf: "http://www.idpf.org/2007/opf",
  dc: "http://purl.org/dc/elements/1.1/",
  xhtml: "http://www.w3.org/1999/xhtml",
  epub: "http://www.idpf.org/2007/ops",
  container: "urn:oasis:names:tc:opendocument:xmlns:container",
  math: "http://www.w3.org/1998/Math/MathML",
};
export function xml(source: string, label = "XML"): Document {
  const sax = new SaxesParser({ xmlns: true });
  let depth = 0;
  sax.on("doctype", (value) => {
    if (value.trim().toLowerCase() !== "html")
      fail("XXE_BLOCKED", `${label}: external or internal DTD is not accepted`);
  });
  sax.on("error", (error) => fail("XML_INVALID", `${label}: ${error.message}`));
  sax.on("opentag", () => {
    if (++depth > 256)
      fail("XML_DEPTH", `${label}: XML nesting exceeds parser depth`);
  });
  sax.on("closetag", () => {
    depth--;
  });
  sax.write(source).close();
  return new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") fail("XML_INVALID", `${label}: ${message}`);
    },
  }).parseFromString(source, "application/xml");
}
export const serialize = (document: Document | Element) =>
  new XMLSerializer().serializeToString(document);
export const elements = (
  document: Document | Element,
  name = "*",
  namespace = "*",
) => Array.from(document.getElementsByTagNameNS(namespace, name));
export const attr = (element: Element, name: string) =>
  element.getAttribute(name) ?? "";
const ncxDoctype =
  /<!DOCTYPE\s+ncx\s+PUBLIC\s+(["'])-\/\/NISO\/\/DTD ncx 2005-1\/\/EN\1\s+(["'])https?:\/\/www\.daisy\.org\/z3986\/2005\/ncx-2005-1\.dtd\2\s*>/i;
export function ncxXml(source: string, label: string) {
  return xml(source.replace(ncxDoctype, ""), label);
}
export function textContent(document: Document | Element) {
  return document.textContent ?? "";
}
const legacyDoctype =
  /<!DOCTYPE\s+html\s+PUBLIC\s+(["'])-\/\/W3C\/\/DTD XHTML (?:1\.1|1\.0 Strict|1\.0 Transitional)\/\/EN\1\s+(["'])https?:\/\/www\.w3\.org\/TR\/(?:xhtml11\/DTD\/xhtml11\.dtd|xhtml1\/DTD\/xhtml1-(?:strict|transitional)\.dtd)\2\s*>/i;
export const hasLegacyDoctype = (source: string) => legacyDoctype.test(source);
export function contentXml(source: string, label: string) {
  if (hasLegacyDoctype(source)) {
    source = source
      .replace(legacyDoctype, "")
      // CDATA, comments and processing instructions contain literal text, not entities.
      .replace(
        /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|&([A-Za-z][A-Za-z0-9]*);/g,
        (whole, name: string | undefined) => {
          if (!name) return whole;
          if (!Object.hasOwn(xhtmlEntities, name))
            fail(
              "LEGACY_ENTITY_UNSUPPORTED",
              `${label}: unsupported XHTML 1.x entity &${name};`,
              { source: label, entity: name },
            );
          // Numeric references preserve XML delimiters and do not recursively expand text.
          return `&#${xhtmlEntities[name]};`;
        },
      );
  }
  return xml(source, label);
}
export function passiveSvg(source: string, label: string) {
  const document = xml(source, label);
  if (
    document.documentElement?.namespaceURI !== "http://www.w3.org/2000/svg" ||
    document.documentElement.localName !== "svg"
  )
    fail("SVG_INVALID", `${label}: SVG namespace is required`);
  for (const el of elements(document)) {
    if (
      [
        "script",
        "foreignobject",
        "animate",
        "animatemotion",
        "animatetransform",
        "set",
      ].includes((el.localName ?? "").toLowerCase())
    )
      fail("SVG_ACTIVE", `${label}: active SVG content is forbidden`);
    if ((el.localName ?? "").toLowerCase() === "style")
      passiveSvgCss(el.textContent ?? "", label);
    for (const node of Array.from(el.childNodes))
      if (node.nodeType === 7 && node.nodeName === "xml-stylesheet")
        fail("SVG_ACTIVE", `${label}: external SVG stylesheets are forbidden`);
    for (const attribute of Array.from(el.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name === "style") {
        passiveSvgCss(value, label, true);
        continue;
      }
      if (
        /^on/.test(name) ||
        (["href", "xlink:href"].includes(name) && !value.startsWith("#")) ||
        /url\s*\(/i.test(value) ||
        value.includes("\\")
      )
        fail(
          "SVG_ACTIVE",
          `${label}: SVG resource reference or active attribute is forbidden`,
        );
    }
  }
  for (const node of Array.from(document.childNodes))
    if (node.nodeType === 7 && node.nodeName === "xml-stylesheet")
      fail("SVG_ACTIVE", `${label}: external SVG stylesheets are forbidden`);
  return document;
}

export function escapeXml(text: string) {
  // eslint-disable-next-line no-control-regex -- Enforce the XML character repertoire.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text))
    fail("XML_CHARACTER", "Text contains an XML-forbidden character");
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
