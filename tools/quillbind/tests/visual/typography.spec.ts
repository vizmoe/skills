import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { bodymatterItems, copyBook, candidate } from "../helpers.js";
import { openBook } from "../../packages/core/src/config.js";
import { inspectBytes } from "../../packages/core/src/validate.js";
import { browserPath, serveEpub } from "../../packages/core/src/qa.js";
import { json } from "../../packages/core/src/json.js";

for (const theme of ["literature", "technical"])
  for (const direction of ["ltr", "rtl", "vertical"])
    test(`${theme} ${direction} typography survives reader font and color changes`, async ({}, testInfo) => {
      const root = await copyBook(theme);
      const browser = await chromium.launch({
        executablePath: await browserPath(),
      });
      let server: Awaited<ReturnType<typeof serveEpub>> | undefined;
      try {
        const { config } = await openBook(root);
        await json(path.join(root, "book.yaml"), {
          ...config,
          book: { ...config.book, language: "zh-Hans" },
          chapters: [config.chapters[0]],
          direction: direction === "rtl" ? "rtl" : "ltr",
          writingMode:
            direction === "vertical" ? "vertical-rl" : "horizontal-tb",
          styles: ["reader-test.css"],
        });
        await fs.writeFile(
          path.join(root, "reader-test.css"),
          "img { display: block; }",
        );
        await fs.writeFile(
          path.join(root, "marker.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#427788"/></svg>',
        );
        await fs.writeFile(
          path.join(root, config.chapters[0]),
          [
            "---",
            "id: typography",
            "title: 排版检查",
            "lang: zh-Hans",
            "---",
            "",
            "# 排版检查",
            "",
            "正文**关键结论。**随后解释。*特别强调。*随后说明。~~旧结论。~~新结论。",
            "",
            "## **标题强调**与目录",
            "",
            "> 引用原文，保留 **重要信息**，用边线与留白区分。",
            "> 软换行继续同一个引用段落。",
            ">",
            "> 引用的第二段。  ",
            "> 硬换行继续引用段落。",
            ">",
            "> > 嵌套引用。",
            "> >",
            "> > 嵌套引用的第二段。",
            "",
            "正文 ![行内标记](marker.svg) 继续。`inline_code` 保持等宽。",
            "",
            "引用后的第二段正文采用相同的首行缩进。",
            "",
            "3. 第一项",
            "4. 第二项",
            "",
            "::caption[列对齐]",
            "",
            "| 左 | 中 | 右 |",
            "| :--- | :---: | ---: |",
            "| 甲 | 乙 | 42 |",
            "",
          ].join("\n"),
        );
        const info = inspectBytes(await candidate(root), true);
        server = await serveEpub(info);
        const context = await browser.newContext({
          viewport: { width: 768, height: 844 },
          deviceScaleFactor: 1,
        });
        await context.route("**/*", (route) =>
          new URL(route.request().url()).origin === server!.origin
            ? route.continue()
            : route.abort(),
        );
        const page = await context.newPage();
        const chapter = bodymatterItems(info)[0];
        await page.goto(`${server.origin}/${chapter.path}`);
        await expect(page.locator("main > p strong").first()).toHaveText(
          "关键结论。",
        );
        for (const reader of [
          {
            name: "light",
            size: 16,
            font: "serif",
            ink: "#222222",
            paper: "#ffffff",
          },
          {
            name: "dark-large",
            size: 28,
            font: "sans-serif",
            ink: "#eeeeee",
            paper: "#2e3440",
          },
          {
            name: "grayscale",
            size: 20,
            font: "serif",
            ink: "#111111",
            paper: "#dddddd",
          },
        ]) {
          const override = await page.addStyleTag({
            content: `body {font-size:${reader.size}px; line-height:1.6; color:${reader.ink}; background:${reader.paper};} body, h1, h2, p, li, blockquote, strong, em {font-family:${reader.font} !important;}`,
          });
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(
              Array.from(document.images).map((image) => image.decode()),
            );
          });
          const styles = await page.evaluate(() => {
            const style = (selector: string) =>
              getComputedStyle(document.querySelector(selector)!);
            const quote = style("blockquote"),
              strong = style("main > p strong"),
              body = style("body");
            const vertical = body.writingMode.startsWith("vertical");
            const rtl = body.direction === "rtl";
            const heading = document.querySelector("h1")!;
            const glyphs = [0, 1].map((offset) => {
              const range = document.createRange();
              range.setStart(heading.firstChild!, offset);
              range.setEnd(heading.firstChild!, offset + 1);
              return range.getBoundingClientRect();
            });
            return {
              headingAdvance: vertical
                ? glyphs[1].top - glyphs[0].top
                : glyphs[1].left - glyphs[0].left,
              headingSize: Number.parseFloat(style("h1").fontSize),
              bodyWeight: Number.parseFloat(body.fontWeight),
              strongWeight: Number.parseFloat(strong.fontWeight),
              font: style("main > p").fontFamily,
              quoteFont: quote.fontFamily,
              size: Number.parseFloat(style("main > p").fontSize),
              quoteSize: Number.parseFloat(quote.fontSize),
              italic: style("em").fontStyle,
              deletion: style("del").textDecorationLine,
              quoteBorder: Number.parseFloat(
                vertical
                  ? quote.borderTopWidth
                  : rtl
                    ? quote.borderRightWidth
                    : quote.borderLeftWidth,
              ),
              quoteBorderColor: vertical
                ? quote.borderTopColor
                : rtl
                  ? quote.borderRightColor
                  : quote.borderLeftColor,
              color: quote.color,
              quoteIndents: Array.from(
                document.querySelectorAll("blockquote p"),
                (paragraph) => getComputedStyle(paragraph).textIndent,
              ),
              followingIndents: Array.from(
                document.querySelectorAll(
                  "main > blockquote + p, main > blockquote + p + p",
                ),
                (paragraph) => getComputedStyle(paragraph).textIndent,
              ),
              inline: style("img.inline-image").display,
              inlineHeight: document
                .querySelector("img.inline-image")!
                .getBoundingClientRect().height,
              code: style("code").fontFamily,
              alignment: Array.from(document.querySelectorAll("td")).map(
                (cell) => getComputedStyle(cell).textAlign,
              ),
            };
          });
          expect(styles.strongWeight).toBeGreaterThan(styles.bodyWeight);
          expect(styles.headingAdvance).toBeGreaterThan(
            styles.headingSize * 0.8,
          );
          expect(styles.italic).toBe("italic");
          expect(styles.deletion).toContain("line-through");
          expect(styles.size).toBe(reader.size);
          expect(styles.quoteSize).toBe(reader.size);
          expect(styles.font).toBe(reader.font);
          expect(styles.quoteFont).toBe(reader.font);
          expect(styles.quoteBorder).toBeGreaterThan(0);
          expect(styles.quoteBorderColor).toBe(styles.color);
          expect(styles.quoteIndents).toEqual(["0px", "0px", "0px", "0px"]);
          const bodyIndent =
            theme === "literature" ? `${reader.size * 2}px` : "0px";
          expect(styles.followingIndents).toEqual([bodyIndent, bodyIndent]);
          expect(styles.inline).toBe("inline");
          expect(styles.inlineHeight).toBe(reader.size);
          expect(styles.code).toContain("monospace");
          expect(styles.alignment).toEqual(["left", "center", "right"]);
          await testInfo.attach(`${reader.name}.png`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
          });
          await override.evaluate((element) => {
            element.parentNode?.removeChild(element);
          });
        }
      } finally {
        await browser.close();
        await server?.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
