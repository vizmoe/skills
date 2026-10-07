import type { AtRule, Root, Declaration } from "postcss";
import valueParser from "postcss-value-parser";
import type { EpubInspection } from "./epub.js";
import { localTarget } from "./paths.js";

/** An entirely unavailable font face already falls back in readers. */
export function missingFontFaces(
  css: Root,
  name: string,
  info: EpubInspection,
): AtRule[] {
  const missing: AtRule[] = [];
  css.walkAtRules("font-face", (rule) => {
    let urls = 0;
    let absent = 0;
    let alternative = false;
    rule.walkDecls("src", (decl) => {
      valueParser(decl.value).walk((node) => {
        if (node.type !== "function") return;
        if (node.value.toLowerCase() === "local") alternative = true;
        if (node.value.toLowerCase() !== "url") return;
        urls++;
        const href = valueParser
          .stringify(node.nodes)
          .trim()
          .replace(/^['"]|['"]$/g, "");
        try {
          const target = localTarget(name, href);
          if (!info.entries.has(target.path)) absent++;
        } catch {
          alternative = true;
        }
      });
    });
    if (urls > 0 && absent === urls && !alternative) missing.push(rule);
  });
  return missing;
}

export function missingFontSources(
  css: Root,
  name: string,
  info: EpubInspection,
): { declaration: Declaration; value: string }[] {
  const repairs: { declaration: Declaration; value: string }[] = [];
  css.walkAtRules("font-face", (rule) => {
    rule.walkDecls("src", (declaration) => {
      const parsed = valueParser(declaration.value);
      const groups: (typeof parsed.nodes)[] = [[]];
      for (const node of parsed.nodes) {
        if (node.type === "div" && node.value === ",") groups.push([]);
        else groups[groups.length - 1].push(node);
      }
      const retained = groups.filter(
        (group) =>
          !group.some((node) => {
            if (node.type !== "function" || node.value.toLowerCase() !== "url")
              return false;
            try {
              const href = valueParser
                .stringify(node.nodes)
                .trim()
                .replace(/^['"]|['"]$/g, "");
              return !info.entries.has(localTarget(name, href).path);
            } catch {
              return false;
            }
          }),
      );
      if (retained.length && retained.length < groups.length)
        repairs.push({
          declaration,
          value: retained
            .map((group) => valueParser.stringify(group).trim())
            .join(", "),
        });
    });
  });
  return repairs;
}
