import { describe, expect, it } from "vitest";
import { lintCss } from "../packages/core/src/css.js";
import {
  BOOK_THEMES,
  isBookTheme,
  isOpeningParagraphAfter,
  loadPresetStyles,
  loadPresetStylesSync,
  paragraphAlignClass,
  paragraphGapClass,
} from "../packages/core/src/styles.js";

describe("shared preset styles and typography helpers", () => {
  it("loads every preset theme stylesheet asynchronously and synchronously and passes all platform CSS lints", async () => {
    expect(isBookTheme("literature")).toBe(true);
    expect(isBookTheme("technical")).toBe(true);
    expect(isBookTheme("magazine")).toBe(false);

    for (const theme of BOOK_THEMES) {
      const asyncStyles = await loadPresetStyles(theme);
      const syncStyles = loadPresetStylesSync(theme);
      expect(asyncStyles.map((s) => s.href)).toEqual([
        "EPUB/styles/base.css",
        "EPUB/styles/theme.css",
        "EPUB/styles/frontmatter.css",
      ]);
      expect(syncStyles.map((s) => s.href)).toEqual(
        asyncStyles.map((s) => s.href),
      );
      for (let i = 0; i < asyncStyles.length; i++) {
        expect(asyncStyles[i].bytes.equals(syncStyles[i].bytes)).toBe(true);
        const css = asyncStyles[i].bytes.toString("utf8");
        for (const platform of ["internal", "apple-books", "kindle"] as const) {
          const checked = lintCss(css, asyncStyles[i].href, platform);
          expect(
            checked.diagnostics,
            `${theme} ${asyncStyles[i].href} (${platform})`,
          ).toEqual([]);
          expect(checked.status).toBe("pass");
        }
      }
    }

    const oebps = loadPresetStylesSync("literature", "OEBPS");
    expect(oebps.map((s) => s.href)).toEqual([
      "OEBPS/styles/base.css",
      "OEBPS/styles/theme.css",
      "OEBPS/styles/frontmatter.css",
    ]);
  });

  it("classifies opening paragraphs, scene gaps, and non-body alignments consistently", () => {
    expect(isOpeningParagraphAfter(undefined)).toBe(true);
    expect(isOpeningParagraphAfter("heading")).toBe(true);
    expect(isOpeningParagraphAfter("thematicBreak")).toBe(true);
    expect(isOpeningParagraphAfter("hr")).toBe(true);
    expect(isOpeningParagraphAfter("paragraph")).toBe(false);
    expect(isOpeningParagraphAfter("quote")).toBe(false);
    expect(isOpeningParagraphAfter("table")).toBe(false);

    expect(paragraphGapClass(undefined)).toBeUndefined();
    expect(paragraphGapClass(false)).toBeUndefined();
    expect(paragraphGapClass(0)).toBeUndefined();
    expect(paragraphGapClass(true)).toBe("gap-before");
    expect(paragraphGapClass(1)).toBe("gap-before");
    expect(paragraphGapClass(1.5)).toBe("gap-before");
    expect(paragraphGapClass(2)).toBe("gap-before-lg");
    expect(paragraphGapClass(3)).toBe("gap-before-lg");

    expect(paragraphAlignClass(undefined)).toBeUndefined();
    expect(paragraphAlignClass("left")).toBe("align-left");
    expect(paragraphAlignClass("center")).toBe("align-center");
    expect(paragraphAlignClass("right")).toBe("align-right");
    expect(paragraphAlignClass("justify")).toBeUndefined();
  });
});
