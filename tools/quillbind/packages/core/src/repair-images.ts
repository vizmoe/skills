import type { Document, Element } from "@xmldom/xmldom";
import postcss from "postcss";
import { attr, elements, NS } from "./xml.js";

const blocks = new Set(["p", "div", "figure"]);
const wrappers = new Set(["a", "span"]);
const excluded = new Set([
  "table",
  "pre",
  "code",
  "nav",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

// Follow one image through transparent wrappers to its own block. Whitespace
// and comments are harmless; a figure's separate caption remains untouched.
function imageBranch(image: Element): Element[] | undefined {
  for (
    let node: Element | null = image;
    node;
    node = node.parentNode as Element | null
  ) {
    if (excluded.has(node.localName ?? "") || node.hasAttribute?.("hidden"))
      return;
  }
  const branch = [image];
  let child = image;
  while (child.parentNode?.nodeType === 1) {
    const parent = child.parentNode as Element;
    if (parent.namespaceURI !== NS.xhtml) return;
    const tag = parent.localName!;
    if (!blocks.has(tag) && !wrappers.has(tag)) return;
    let captions = 0;
    for (const sibling of Array.from(parent.childNodes)) {
      if (sibling === child || sibling.nodeType === 8) continue;
      if (
        sibling.nodeType === 3 &&
        /^[\t\r\n ]*$/.test(sibling.nodeValue ?? "")
      )
        continue;
      if (
        tag === "figure" &&
        sibling.nodeType === 1 &&
        (sibling as Element).namespaceURI === NS.xhtml &&
        (sibling as Element).localName === "figcaption" &&
        ++captions === 1
      )
        continue;
      return;
    }
    if (blocks.has(tag)) return branch;
    branch.push(parent);
    child = parent;
  }
}

function centeredStyle(element: Element): string | undefined {
  const css = postcss.parse(attr(element, "style"));
  if (css.nodes.some((node) => node.type !== "decl" && node.type !== "comment"))
    throw new Error("Expected an inline CSS declaration list");
  // Hidden/positioned content is not evidence of an ordinary standalone image.
  let outOfFlow = false;
  css.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase(),
      value = decl.value.trim().toLowerCase();
    if (
      (prop === "display" && value === "none") ||
      (prop === "position" && ["absolute", "fixed"].includes(value)) ||
      (prop === "visibility" && ["hidden", "collapse"].includes(value))
    )
      outOfFlow = true;
  });
  if (outOfFlow) return;
  css.walkDecls((decl) => {
    if (
      [
        "display",
        "float",
        "margin-inline",
        "margin-inline-start",
        "margin-inline-end",
      ].includes(decl.prop.toLowerCase())
    )
      decl.remove();
  });
  css.append({ prop: "display", value: "block" });
  css.append({ prop: "float", value: "none" });
  // Logical margins follow both horizontal/RTL and vertical writing modes.
  css.append({ prop: "margin-inline", value: "auto" });
  return css.toString();
}

export function imageCenteringRepairs(document: Document) {
  const repairs: { element: Element; style: string }[][] = [];
  let invalidStyles = 0;
  for (const image of elements(document, "img", NS.xhtml)) {
    const branch = imageBranch(image);
    if (!branch) continue;
    try {
      const styles = branch.map((element) => ({
        element,
        style: centeredStyle(element),
      }));
      if (styles.some(({ style }) => style === undefined)) continue;
      const changes = styles
        .filter(({ element, style }) => style !== attr(element, "style"))
        .map(({ element, style }) => ({ element, style: style! }));
      if (changes.length) repairs.push(changes);
    } catch {
      invalidStyles++;
    }
  }
  return { repairs, invalidStyles };
}

export function standaloneReadingImages(document: Document): Element[] {
  return elements(document, "img", NS.xhtml).filter((image) => {
    const branch = imageBranch(image);
    if (!branch) return false;
    try {
      return branch.every((element) => centeredStyle(element) !== undefined);
    } catch {
      return false;
    }
  });
}
