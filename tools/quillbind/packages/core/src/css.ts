import postcss from "postcss";
import valueParser from "postcss-value-parser";
import selectorParser from "postcss-selector-parser";
import { diagnostic, result, fail } from "./errors.js";
import { APPLE, KINDLE, EPUB } from "./standards.js";
import type { Diagnostic } from "./model.js";
const special = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "code",
  "pre",
  "figcaption",
  "caption",
  "th",
  "td",
  "rt",
  "sup",
  "sub",
]);

/** Static SVG styling has no reflow constraints, but may not load resources or execute code. */
export function passiveSvgCss(source: string, file: string, inline = false) {
  // eslint-disable-next-line no-control-regex -- Reject obfuscated CSS identifiers and controls.
  if (/\\|[\u0000-\u0008\u000b\u000e-\u001f]/.test(source))
    fail(
      "SVG_CSS_UNSAFE",
      `${file}: escaped or control CSS requires normalization`,
    );
  let tree;
  try {
    tree = postcss.parse(source, { from: file });
  } catch (error) {
    fail("SVG_CSS_INVALID", `${file}: ${String(error)}`);
  }
  if (
    inline &&
    tree.nodes.some((node) => !["decl", "comment"].includes(node.type))
  )
    fail(
      "SVG_CSS_INVALID",
      `${file}: style attributes must contain only CSS declarations`,
    );
  tree.walkAtRules((rule) => {
    if (!["media", "supports", "layer"].includes(rule.name.toLowerCase()))
      fail("SVG_CSS_UNSAFE", `${file}: SVG CSS @${rule.name} is forbidden`);
  });
  tree.walkDecls((decl) => {
    if (
      /^(?:(?:-\w+-)?(?:animation|transition)(?:-|$)|behavior$|-moz-binding$)/i.test(
        decl.prop,
      )
    )
      fail(
        "SVG_CSS_UNSAFE",
        `${file}: active SVG CSS property ${decl.prop} is forbidden`,
      );
    const value = decl.value.replace(/\/\*[\s\S]*?\*\//g, "");
    valueParser(value).walk((node) => {
      if ((node.type === "function" || node.type === "string") && node.unclosed)
        fail("SVG_CSS_INVALID", `${file}: unclosed SVG CSS value`);
      if (
        node.type === "function" &&
        [
          "url",
          "src",
          "expression",
          "image",
          "image-set",
          "-webkit-image-set",
          "paint",
          "attr",
        ].includes(node.value.toLowerCase())
      )
        fail(
          "SVG_CSS_UNSAFE",
          `${file}: resource or dynamic SVG CSS function ${node.value}() is forbidden`,
        );
    });
  });
}
export function lintCss(
  source: string,
  file: string,
  platform: "internal" | "apple-books" | "kindle" = "internal",
) {
  const diagnostics: Diagnostic[] = [];
  const url =
    platform === "apple-books" ? APPLE : platform === "kindle" ? KINDLE : EPUB;
  const add = (code: string, message: string, line?: number) =>
    diagnostics.push({
      ...diagnostic(code, message, file, url),
      line,
      ruleId: `${platform}.${code}`,
    });
  try {
    const tree = postcss.parse(source, { from: file });
    tree.walkAtRules((rule) => {
      if (
        !["font-face", "media", "supports", "namespace"].includes(
          rule.name.toLowerCase(),
        )
      )
        add(
          "CSS_AT_RULE",
          `Unsupported or unsafe @${rule.name}`,
          rule.source?.start?.line,
        );
    });
    tree.walkDecls((decl) => {
      const prop = decl.prop.toLowerCase(),
        value = decl.value.toLowerCase();
      const line = decl.source?.start?.line;
      let bodyLike = false;
      let mediaOnly = false;
      if (decl.parent?.type === "rule") {
        selectorParser((selectors) => {
          mediaOnly = selectors.nodes.length > 0;
          selectors.each((selector) => {
            const lastCombinator = selector.nodes.findLastIndex(
              (node) => node.type === "combinator",
            );
            const tags = selector.nodes
              .slice(lastCombinator + 1)
              .filter((node) => node.type === "tag")
              .map((node) => node.value.toLowerCase());
            const media = tags.some((tag) => ["img", "svg"].includes(tag));
            mediaOnly &&= media;
            if (!media && !tags.some((tag) => special.has(tag)))
              bodyLike = true;
          });
        }).processSync(decl.parent.selector);
      }
      const mediaDimension =
        mediaOnly && /^(?:(?:min|max)-)?(?:width|height)$/.test(prop);
      // eslint-disable-next-line no-control-regex -- Reject literal control characters in untrusted CSS.
      if (/\\|[\u0000-\u001f]/.test(decl.value + decl.prop))
        add(
          "CSS_ESCAPE",
          "Escaped/control CSS requires normalization before validation",
          line,
        );
      valueParser(decl.value).walk((node) => {
        if (node.type === "function" && node.value.toLowerCase() === "url") {
          const target = valueParser
            .stringify(node.nodes)
            .trim()
            .replace(/^['"]|['"]$/g, "");
          if (
            /^(?:[a-z][\w+.-]*:|\/\/|\/)/i.test(target) ||
            target.includes("\\")
          )
            add(
              "CSS_REMOTE",
              "Remote or absolute CSS resource is forbidden",
              line,
            );
        }
        if (
          node.type === "function" &&
          ["expression", "attr"].includes(node.value.toLowerCase())
        )
          add("CSS_ACTIVE", "Dynamic CSS values are forbidden", line);
      });
      if (decl.important)
        add(
          "CSS_IMPORTANT",
          "Reader overrides must remain effective; remove !important",
          line,
        );
      if (
        ["behavior", "-moz-binding"].includes(prop) ||
        /expression\s*\(/.test(value)
      )
        add("CSS_ACTIVE", "Active CSS is forbidden", line);
      if (
        (prop === "display" && /grid|flex|none/.test(value)) ||
        (prop === "position" && /fixed|absolute/.test(value)) ||
        (prop === "overflow" && /hidden|clip/.test(value)) ||
        (prop === "visibility" && value === "hidden") ||
        (prop === "opacity" && Number(value) === 0)
      )
        add("CSS_LAYOUT", "Unsupported, hidden, or inflexible layout", line);
      if (
        /^(animation|transition)/.test(prop) ||
        (!mediaDimension && /\b\d+(?:\.\d+)?(?:vw|vh|vmin|vmax)\b/.test(value))
      )
        add(
          "CSS_VIEWPORT",
          "Viewport units are reserved for image dimensions; animation is not accepted",
          line,
        );
      if (
        ["height", "min-height", "max-height"].includes(prop) &&
        !["auto", "none", "inherit"].includes(value) &&
        !(
          mediaOnly && /^(?:\d*\.)?\d+(?:em|rem|%|vh|vw|vmin|vmax)$/.test(value)
        )
      )
        add(
          "CSS_FIXED_HEIGHT",
          "Fixed content height can clip reader-scaled text",
          line,
        );
      if (decl.parent?.type === "rule") {
        if (
          bodyLike &&
          [
            "font",
            "font-family",
            "font-size",
            "line-height",
            "color",
            "background",
            "background-color",
            "width",
            "text-align",
          ].includes(prop) &&
          !["inherit", "initial", "unset", "auto"].includes(value)
        )
          add("BODY_OVERRIDE", `Body-like selector locks ${prop}`, line);
      }
    });
  } catch (error) {
    add("CSS_INVALID", String(error));
  }
  return result(diagnostics);
}
