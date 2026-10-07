import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { bodymatterItems, candidate } from "../helpers.js";
import { inspectBytes } from "../../packages/core/src/validate.js";
import { browserPath, serveEpub } from "../../packages/core/src/qa.js";
import { json } from "../../packages/core/src/json.js";

for (const theme of ["literature", "technical"])
  for (const mode of ["ltr", "rtl", "vertical"])
    test(`${theme} ${mode} block images are centered and inline images follow text`, async ({}, testInfo) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "quillbind-images-"),
      );
      const browser = await chromium.launch({
        executablePath: await browserPath(),
      });
      let server: Awaited<ReturnType<typeof serveEpub>> | undefined;
      try {
        await json(path.join(root, "book.yaml"), {
          schemaVersion: 1,
          book: {
            title: "Image alignment",
            authors: ["Quillbind Fixtures"],
            description: "Original image placement fixture.",
            language: "en",
            publication: { isbn: null },
            tags: ["Literature.Essays"],
          },
          theme,
          direction: mode === "rtl" ? "rtl" : "ltr",
          writingMode: mode === "vertical" ? "vertical-rl" : "horizontal-tb",
          chapters: ["chapter.md"],
          build: { epoch: 946684800 },
        });
        await sharp({
          create: {
            width: 120,
            height: 60,
            channels: 3,
            background: "#427788",
          },
        })
          .png()
          .toFile(path.join(root, "swatch.png"));
        await fs.writeFile(
          path.join(root, "swatch.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><rect width="120" height="60" fill="#884277"/></svg>',
        );
        await fs.writeFile(
          path.join(root, "chapter.md"),
          [
            "---",
            "id: images",
            "title: Image alignment",
            "lang: en",
            "---",
            "",
            "# Image alignment",
            "",
            "![Standalone raster swatch](swatch.png)",
            "",
            ':::figure{src="swatch.svg" alt="Captioned vector swatch"}',
            "A caption remains readable.",
            ":::",
            "",
            "Before ![Inline marker](swatch.svg) after.",
            "",
            '```text caption="A code listing"',
            "  indented code",
            "```",
            "",
            "::caption[Table caption]",
            "",
            "| Value |",
            "| --- |",
            "| One |",
            "",
          ].join("\n"),
        );
        const info = inspectBytes(await candidate(root), true);
        server = await serveEpub(info);
        const context = await browser.newContext({ deviceScaleFactor: 1 });
        await context.route("**/*", (route) =>
          new URL(route.request().url()).origin === server!.origin
            ? route.continue()
            : route.abort(),
        );
        const page = await context.newPage();
        const chapter = bodymatterItems(info)[0];
        await page.goto(`${server.origin}/${chapter.path}`);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(
            Array.from(document.images).map((image) => image.decode()),
          );
        });
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 844 });
          const measurements = await page
            .locator("figure > img")
            .evaluateAll((images) =>
              images.map((image) => {
                const box = image.getBoundingClientRect();
                const figure = image.parentElement!.getBoundingClientRect();
                const vertical =
                  getComputedStyle(image).writingMode.startsWith("vertical");
                return {
                  alt: image.getAttribute("alt"),
                  before: vertical
                    ? box.top - figure.top
                    : box.left - figure.left,
                  after: vertical
                    ? figure.bottom - box.bottom
                    : figure.right - box.right,
                  width: box.width,
                  height: box.height,
                };
              }),
            );
          await testInfo.attach(`placement-${width}.json`, {
            body: JSON.stringify(measurements, null, 2),
            contentType: "application/json",
          });
          expect(measurements).toHaveLength(2);
          for (const image of measurements) {
            expect(
              Math.abs(image.before - image.after),
              `${image.alt}: ${JSON.stringify(image)}`,
            ).toBeLessThanOrEqual(1);
            expect(image.before).toBeGreaterThan(0);
            expect(image.width).toBe(120);
            expect(image.height).toBe(60);
          }
          const inline = await page
            .locator("img.inline-image")
            .evaluate((image) => {
              const style = getComputedStyle(image);
              const paragraph = getComputedStyle(image.parentElement!);
              return {
                display: style.display,
                height: image.getBoundingClientRect().height,
                fontSize: Number.parseFloat(paragraph.fontSize),
                indent: paragraph.textAlign,
              };
            });
          expect(inline.display).toBe("inline");
          expect(inline.height).toBe(inline.fontSize);
          expect(inline.indent).not.toBe("center");
          await expect(page.locator("pre code")).toHaveText("  indented code");
          for (const selector of ["figcaption", "table caption", "pre"])
            expect(
              await page
                .locator(selector)
                .first()
                .evaluate((element) => getComputedStyle(element).textAlign),
            ).toBe("start");
          if (width === 1280)
            await testInfo.attach("image-layout.png", {
              body: await page.screenshot({ fullPage: true }),
              contentType: "image/png",
            });
        }
      } finally {
        await browser.close();
        await server?.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
