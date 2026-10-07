import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { candidate, copyBook, bodymatterItems } from "../helpers.js";
import { openBook } from "../../packages/core/src/config.js";
import { browserPath, serveEpub } from "../../packages/core/src/qa.js";
import {
  inspectBytes,
  validateInternal,
} from "../../packages/core/src/validate.js";
import { json } from "../../packages/core/src/json.js";

for (const [language, label, direction, writingMode] of [
  ["en", "Contents", "ltr", "horizontal-tb"],
  ["zh-Hans", "目录", "ltr", "horizontal-tb"],
  ["zh-Hant", "目錄", "ltr", "horizontal-tb"],
  ["ar", "Contents", "rtl", "horizontal-tb"],
  ["ja", "Contents", "ltr", "vertical-rl"],
]) {
  test(`${language} contents page links and reader overrides`, async ({}, testInfo) => {
    const executablePath = await browserPath();
    const root = await copyBook("technical");
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let server: Awaited<ReturnType<typeof serveEpub>> | undefined;
    try {
      const { config } = await openBook(root);
      const coverAlt = `${config.book.title} — ${config.book.authors.join(", ")}`;
      await json(path.join(root, "book.yaml"), {
        ...config,
        book: { ...config.book, language },
        direction,
        writingMode,
        cover: { path: "cover.png" },
        navigation: [{ title: "Part & structure", children: config.chapters }],
      });
      await sharp({
        create: { width: 600, height: 960, channels: 3, background: "#334477" },
      })
        .png()
        .toFile(path.join(root, "cover.png"));
      for (const [index, chapter] of config.chapters.entries()) {
        const number = index + 1;
        await fs.writeFile(
          path.join(root, chapter),
          `---\nid: chapter-${number}\ntitle: Chapter ${number}\nlang: ${language}\n---\n\n# Chapter ${number}\n\nA short paragraph.\n\n## Detail ${number}\n\nA linked destination.\n`,
        );
      }
      const bytes = await candidate(root);
      expect(validateInternal(bytes).diagnostics).toEqual([]);
      const info = inspectBytes(bytes, true);
      expect(info.entries.has("EPUB/cover.xhtml")).toBe(true);
      expect(
        info.manifest.filter((item) => item.properties.includes("cover-image")),
      ).toHaveLength(1);
      server = await serveEpub(info);
      browser = await chromium.launch({ executablePath });
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: "block",
      });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === server!.origin
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const navUrl = `${server.origin}/EPUB/nav.xhtml`;
      const contentsUrl = `${server.origin}/EPUB/contents.xhtml`;
      const coverUrl = `${server.origin}/EPUB/cover.xhtml`;
      const coverLabel = language.startsWith("zh") ? "封面" : "Cover";
      await page.goto(navUrl);
      const toc = page.locator('[role="doc-toc"]');
      await expect(toc.locator(":scope > ol > li > a")).toHaveText([
        coverLabel,
        label,
        "Part & structure",
      ]);
      await toc.getByRole("link", { name: coverLabel, exact: true }).click();
      await expect(page).toHaveURL(coverUrl);
      await expect(page.locator("h1")).toHaveCount(0);
      await expect(
        page.getByRole("img", { name: coverAlt, exact: true }),
      ).toBeVisible();
      await page
        .locator("img")
        .evaluate((image: HTMLImageElement) => image.decode());
      const coverGeometry = await page.locator("img").evaluate((image) => {
        const box = image.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          center: box.x + box.width / 2,
          viewportWidth: document.documentElement.clientWidth,
          viewportHeight: window.innerHeight,
        };
      });
      expect(coverGeometry.width / coverGeometry.height).toBeCloseTo(
        600 / 960,
        3,
      );
      expect(
        Math.abs(coverGeometry.center - coverGeometry.viewportWidth / 2),
      ).toBeLessThan(1);
      expect(coverGeometry.height).toBeLessThanOrEqual(
        coverGeometry.viewportHeight,
      );
      await testInfo.attach("cover.png", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.goto(navUrl);
      await toc.getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(contentsUrl);
      await expect(page.locator("h1")).toHaveText(label);
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      await expect(page.locator("html")).toHaveAttribute("dir", direction);
      await expect(page.locator("html")).toHaveCSS("writing-mode", writingMode);
      await expect(
        page.getByRole("link", { name: label, exact: true }),
      ).toHaveCount(0);

      for (const dark of [false, true]) {
        const style = await page.addStyleTag({
          content: `body { font-size: ${dark ? 32 : 16}px; color: ${dark ? "#eeeeee" : "#222222"}; background: ${dark ? "#2e3440" : "#ffffff"}; font-family: ${dark ? "monospace" : "serif"}; line-height: 1.8; }`,
        });
        await expect(
          page.getByRole("link", { name: "Detail 2", exact: true }),
        ).toBeVisible();
        await expect(page.locator("h1")).toHaveCSS("text-align", "center");
        expect(
          await page
            .locator("nav ol")
            .evaluateAll((lists) =>
              lists.every(
                (list) => getComputedStyle(list).listStyleType === "none",
              ),
            ),
        ).toBe(true);
        expect(
          await page
            .locator("nav ol ol")
            .evaluateAll((lists) =>
              lists.every(
                (list) =>
                  parseFloat(getComputedStyle(list).paddingInlineStart) > 0,
              ),
            ),
        ).toBe(true);
        if (writingMode === "horizontal-tb") {
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <=
                document.documentElement.clientWidth + 1,
            ),
          ).toBe(true);
        }
        await testInfo.attach(`${dark ? "dark-large" : "light"}.png`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
        await style.evaluate((node) => node.parentNode?.removeChild(node));
      }

      const destinations = await page.locator("nav a").evaluateAll((links) =>
        links.map((link) => ({
          label: link.textContent!,
          href: link.getAttribute("href")!,
        })),
      );
      expect(destinations.map((item) => item.label)).toEqual([
        coverLabel,
        "Part & structure",
        "Chapter 1",
        "Detail 1",
        "Chapter 2",
        "Detail 2",
      ]);
      for (const destination of destinations) {
        await page.goto(contentsUrl);
        await page
          .getByRole("link", { name: destination.label, exact: true })
          .click();
        await expect(page).toHaveURL(
          new URL(destination.href, contentsUrl).href,
        );
        const url = new URL(page.url());
        if (destination.label === coverLabel) {
          await expect(
            page.getByRole("img", { name: coverAlt, exact: true }),
          ).toBeVisible();
          continue;
        }
        expect(
          bodymatterItems(info).some(
            (item) => `/${item.path}` === url.pathname,
          ),
        ).toBe(true);
        if (url.hash)
          await expect(
            page.locator(`[id="${decodeURIComponent(url.hash.slice(1))}"]`),
          ).toBeInViewport();
      }
      await page.goto(navUrl);
      await page
        .getByRole("navigation", { name: "Landmarks" })
        .getByRole("link", { name: label, exact: true })
        .click();
      await expect(page).toHaveURL(contentsUrl);
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          await server?.close();
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    }
  });
}
