import postcss, { type Declaration } from "postcss";
import valueParser from "postcss-value-parser";
import selectorParser from "postcss-selector-parser";
import { diagnostic, result, fail, type Diagnostic } from "./errors.js";
import { APPLE, KINDLE, EPUB } from "./standards.js";
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
const bodyOverrideProps = new Set([
  "font",
  "font-family",
  "font-size",
  "line-height",
  "color",
  "background",
  "background-color",
  "width",
  "text-align",
]);
const resetKeywords = new Set(["inherit", "initial", "unset", "auto"]);
const semanticAlignClasses = new Set([
  "align-left",
  "align-center",
  "align-right",
  "align-start",
  "align-end",
  "voice-signature",
  "titlepage-box",
  "colophon-box",
]);

type AddDiagnostic = (code: string, message: string, line?: number) => void;

function platformUrl(platform: "internal" | "apple-books" | "kindle"): string {
  if (platform === "apple-books") return APPLE;
  if (platform === "kindle") return KINDLE;
  return EPUB;
}

function classifyRuleSelector(selector: string): {
  bodyLike: boolean;
  mediaOnly: boolean;
  semanticAlignOnly: boolean;
} {
  let bodyLike = false;
  let mediaOnly = false;
  let semanticAlignOnly = false;
  selectorParser((selectors) => {
    mediaOnly = selectors.nodes.length > 0;
    semanticAlignOnly = selectors.nodes.length > 0;
    selectors.each((item) => {
      const lastCombinator = item.nodes.findLastIndex(
        (node) => node.type === "combinator",
      );
      const terminalNodes = item.nodes.slice(lastCombinator + 1);
      const tags = terminalNodes
        .filter((node) => node.type === "tag")
        .map((node) => node.value.toLowerCase());
      const allClasses = item.nodes
        .filter((node) => node.type === "class")
        .map((node) => node.value.toLowerCase());
      const media = tags.some((tag) => ["img", "svg"].includes(tag));
      const isSpecialTag = tags.some((tag) => special.has(tag));
      const targetsRoot = tags.some((tag) => tag === "html" || tag === "body");
      const hasSemanticAlignClass = allClasses.some((cls) =>
        semanticAlignClasses.has(cls),
      );
      mediaOnly &&= media;
      semanticAlignOnly &&=
        isSpecialTag || (!targetsRoot && hasSemanticAlignClass);
      if (!media && !isSpecialTag) bodyLike = true;
    });
  }).processSync(selector);
  return { bodyLike, mediaOnly, semanticAlignOnly };
}

function lintDeclValueFunctions(
  declValue: string,
  line: number | undefined,
  add: AddDiagnostic,
) {
  valueParser(declValue).walk((node) => {
    if (node.type !== "function") return;
    const name = node.value.toLowerCase();
    if (name === "url") {
      const target = valueParser
        .stringify(node.nodes)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (/^(?:[a-z][\w+.-]*:|\/\/|\/)/i.test(target) || target.includes("\\"))
        add("CSS_REMOTE", "Remote or absolute CSS resource is forbidden", line);
    }
    if (name === "expression" || name === "attr")
      add("CSS_ACTIVE", "Dynamic CSS values are forbidden", line);
  });
}

function hasForbiddenLayout(prop: string, value: string): boolean {
  return (
    (prop === "display" && /grid|flex|none/.test(value)) ||
    (prop === "position" && /fixed|absolute/.test(value)) ||
    (prop === "overflow" && /hidden|clip/.test(value)) ||
    (prop === "visibility" && value === "hidden") ||
    (prop === "opacity" && Number(value) === 0)
  );
}

function lintDimensionAndBodyRules(
  decl: Declaration,
  prop: string,
  value: string,
  line: number | undefined,
  selectorInfo: {
    bodyLike: boolean;
    mediaOnly: boolean;
    semanticAlignOnly: boolean;
  },
  add: AddDiagnostic,
) {
  const { bodyLike, mediaOnly, semanticAlignOnly } = selectorInfo;
  const mediaDimension =
    mediaOnly && /^(?:(?:min|max)-)?(?:width|height)$/.test(prop);
  if (
    /^(animation|transition)/.test(prop) ||
    (!mediaDimension && /\b\d+(?:\.\d+)?(?:vw|vh|vmin|vmax)\b/.test(value))
  )
    add(
      "CSS_VIEWPORT",
      "Viewport units are reserved for image dimensions; animation is not accepted",
      line,
    );
  const allowedMediaHeight =
    mediaOnly && /^(?:\d*\.)?\d+(?:em|rem|%|vh|vw|vmin|vmax)$/.test(value);
  if (
    ["height", "min-height", "max-height"].includes(prop) &&
    !["auto", "none", "inherit"].includes(value) &&
    !allowedMediaHeight
  )
    add(
      "CSS_FIXED_HEIGHT",
      "Fixed content height can clip reader-scaled text",
      line,
    );
  const allowedSemanticAlign =
    prop === "text-align" &&
    semanticAlignOnly &&
    ["left", "right", "center", "start", "end"].includes(value.trim());
  if (
    decl.parent?.type === "rule" &&
    bodyLike &&
    bodyOverrideProps.has(prop) &&
    !resetKeywords.has(value) &&
    !allowedSemanticAlign
  )
    add("BODY_OVERRIDE", `Body-like selector locks ${prop}`, line);
}

function lintDeclaration(decl: Declaration, add: AddDiagnostic) {
  const prop = decl.prop.toLowerCase();
  const value = decl.value.toLowerCase();
  const line = decl.source?.start?.line;
  const selectorInfo =
    decl.parent?.type === "rule"
      ? classifyRuleSelector(decl.parent.selector)
      : { bodyLike: false, mediaOnly: false, semanticAlignOnly: false };
  // eslint-disable-next-line no-control-regex -- Reject literal control characters in untrusted CSS.
  if (/\\|[\u0000-\u001f]/.test(decl.value + decl.prop))
    add(
      "CSS_ESCAPE",
      "Escaped/control CSS requires normalization before validation",
      line,
    );
  lintDeclValueFunctions(decl.value, line, add);
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
  if (hasForbiddenLayout(prop, value))
    add("CSS_LAYOUT", "Unsupported, hidden, or inflexible layout", line);
  lintDimensionAndBodyRules(decl, prop, value, line, selectorInfo, add);
}

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
  const url = platformUrl(platform);
  const add: AddDiagnostic = (code, message, line) =>
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
    tree.walkDecls((decl) => lintDeclaration(decl, add));
  } catch (error) {
    add("CSS_INVALID", String(error));
  }
  return result(diagnostics);
}
