import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./runtime.js";

export const BOOK_THEMES = ["literature", "technical"] as const;
export type BookTheme = (typeof BOOK_THEMES)[number];

export interface PresetStylesheet {
  id: string;
  file: string;
  href: string;
  mediaType: "text/css";
  bytes: Buffer;
}

export function isBookTheme(value: string): value is BookTheme {
  return value === "literature" || value === "technical";
}

function presetEntries(theme: BookTheme) {
  return [
    ["base.css", "base/epub.css"],
    ["theme.css", `themes/${theme}.css`],
    ["frontmatter.css", "base/frontmatter.css"],
  ] as const;
}

export async function loadPresetStyles(
  theme: BookTheme,
  rootPrefix = "EPUB",
): Promise<PresetStylesheet[]> {
  return Promise.all(
    presetEntries(theme).map(async ([file, relative]) => ({
      id: file.replace(".", "-"),
      file,
      href: `${rootPrefix}/styles/${file}`,
      mediaType: "text/css" as const,
      bytes: await fsPromises.readFile(path.join(repoRoot, "styles", relative)),
    })),
  );
}

export function loadPresetStylesSync(
  theme: BookTheme,
  rootPrefix = "EPUB",
): PresetStylesheet[] {
  return presetEntries(theme).map(([file, relative]) => ({
    id: file.replace(".", "-"),
    file,
    href: `${rootPrefix}/styles/${file}`,
    mediaType: "text/css" as const,
    bytes: fs.readFileSync(path.join(repoRoot, "styles", relative)),
  }));
}

/** Shared opening-paragraph predicate used by Markdown and PDF pipelines. */
export function isOpeningParagraphAfter(
  previousBlockKind: string | undefined,
): boolean {
  return (
    previousBlockKind === undefined ||
    previousBlockKind === "heading" ||
    previousBlockKind === "thematicBreak" ||
    previousBlockKind === "hr"
  );
}

/** Map intentional print/scene vertical gaps to capped relative CSS classes. */
export function paragraphGapClass(
  gapBefore: boolean | number | undefined,
): "gap-before" | "gap-before-lg" | undefined {
  if (typeof gapBefore === "number") {
    if (gapBefore >= 2) return "gap-before-lg";
    if (gapBefore > 0) return "gap-before";
    return undefined;
  }
  return gapBefore ? "gap-before" : undefined;
}

/** Map explicit non-body alignment to utility classes; justify defers to the reader. */
export function paragraphAlignClass(
  align: "left" | "center" | "right" | "justify" | undefined,
): "align-left" | "align-center" | "align-right" | undefined {
  if (align === "left" || align === "center" || align === "right") {
    return `align-${align}`;
  }
  return undefined;
}
