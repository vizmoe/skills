import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { bodymatterItems, candidate, copyBook } from "../helpers.js";
import { openBook } from "../../packages/core/src/config.js";
import { browserPath, serveEpub } from "../../packages/core/src/qa.js";
import { inspectBytes } from "../../packages/core/src/validate.js";
import { json } from "../../packages/core/src/json.js";

for (const theme of ["literature", "technical"])
  test(`${theme} blog byline, heading links and repeated footnotes`, async ({}, testInfo) => {
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
        markdown: { ...config.markdown, profile: "blog" },
        chapters: ["chapters/first.md", "chapters/second.md"],
      });
      await fs.writeFile(
        path.join(root, "chapters/first.md"),
        [
          "---",
          "title: 博客章节与脚注",
          "author: 示例作者",
          "pubDate: 2023-10-29",
          "source: https://example.org/post",
          "layout: DO_NOT_PUBLISH",
          "---",
          "",
          "第一处引用[^shared]。接着阅读[本章结论](#结论)或[下一章](second.md#%E7%BB%93%E8%AE%BA)。",
          "",
          "> 引用块保留 **重要信息**。出处与脚注分开呈现。",
          "",
          ...Array.from(
            { length: 8 },
            (_, i) =>
              `第 ${i + 1} 段正文用于检查跨屏跳转。阅读器调整字号后，正文和署名随之缩放。\n`,
          ),
          "第二处引用[^shared]。",
          "",
          "## 结论",
          "",
          "第三处引用[^shared]。",
          "",
          "[^shared]: **同一条脚注**有三条独立返回链接。",
          "",
          "    脚注支持多段正文及[站外出处](https://example.org/note)。",
          "",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(root, "chapters/second.md"),
        "---\ntitle: 第二章\n---\n\n## 结论\n\n本章注释[^shared]。\n\n[^shared]: 标签相同，内容属于第二章。\n",
      );
      const info = inspectBytes(await candidate(root), true);
      server = await serveEpub(info);
      const context = await browser.newContext({
        viewport: { width: 768, height: 844 },
      });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === server!.origin
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      const chapter = bodymatterItems(info)[0];
      const firstUrl = `${server.origin}/${chapter.path}`;
      await page.goto(firstUrl);
      for (const reader of [
        {
          name: "light",
          size: 16,
          ink: "#222222",
          paper: "#ffffff",
          font: "serif",
        },
        {
          name: "dark-large",
          size: 28,
          ink: "#eeeeee",
          paper: "#2e3440",
          font: "sans-serif",
        },
      ]) {
        const override = await page.addStyleTag({
          content: `body {font-size:${reader.size}px; color:${reader.ink}; background:${reader.paper};} body, p, h1, h2, small {font-family:${reader.font} !important;}`,
        });
        await page.evaluate(async () => {
          await document.fonts.ready;
          window.scrollTo(0, 0);
        });
        await expect(page.locator("h1 + p.chapter-meta")).toHaveText(
          "示例作者 · 2023-10-29",
        );
        await expect(page.locator("p.chapter-meta a")).toHaveCount(0);
        await expect(page.locator("h1 > a")).toHaveAttribute(
          "href",
          "https://example.org/post",
        );
        const styles = await page
          .locator("p.chapter-meta")
          .evaluate((element) => ({
            indent: getComputedStyle(element).textIndent,
            size: parseFloat(
              getComputedStyle(element.querySelector("small")!).fontSize,
            ),
            font: getComputedStyle(element).fontFamily,
            color: getComputedStyle(element).color,
            bodyColor: getComputedStyle(document.body).color,
          }));
        expect(styles.indent).toBe("0px");
        expect(styles.size).toBeGreaterThan(reader.size * 0.7);
        expect(styles.size).toBeLessThan(reader.size);
        expect(styles.font).toBe(reader.font);
        expect(styles.color).toBe(styles.bodyColor);
        const bodyIndent =
          theme === "literature" ? `${reader.size * 2}px` : "0px";
        expect(
          await page
            .locator("main > blockquote + p, main > blockquote + p + p")
            .evaluateAll((paragraphs) =>
              paragraphs.map(
                (paragraph) => getComputedStyle(paragraph).textIndent,
              ),
            ),
        ).toEqual([bodyIndent, bodyIndent]);
        await testInfo.attach(`${reader.name}.png`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        await override.evaluate((element) =>
          element.parentNode?.removeChild(element),
        );
      }
      const refs = page.locator('a[role="doc-noteref"]');
      await expect(refs).toHaveCount(3);
      const refIds = await refs.evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.id),
      );
      for (const id of refIds) {
        const ref = page.locator(`[id="${id}"]`);
        const href = (await ref.getAttribute("href"))!;
        await ref.click();
        expect(decodeURIComponent(new URL(page.url()).hash)).toBe(href);
        const note = page.locator(`[id="${href.slice(1)}"]`);
        await expect(note).toBeInViewport();
        await note.locator(`a[href="#${id}"]`).click();
        expect(decodeURIComponent(new URL(page.url()).hash)).toBe(`#${id}`);
        await expect(ref).toBeInViewport();
      }
      await page.getByRole("link", { name: "本章结论", exact: true }).click();
      await expect(page.locator('h2[id="结论"]')).toBeInViewport();
      await page.getByRole("link", { name: "下一章", exact: true }).click();
      const second = bodymatterItems(info)[1];
      expect(new URL(page.url()).pathname).toBe(`/${second.path}`);
      expect(decodeURIComponent(new URL(page.url()).hash)).toBe("#结论");
      await expect(page.locator('h2[id="结论"]')).toBeInViewport();
      await page.locator('a[role="doc-noteref"]').click();
      await expect(page.locator('aside[role="doc-footnote"]')).toContainText(
        "标签相同，内容属于第二章",
      );
    } finally {
      await browser.close();
      await server?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
