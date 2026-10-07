import { chromium, expect, test } from "@playwright/test";
import { applyRepair, planFromBytes } from "../../packages/core/src/repair.js";
import { inspectBytes } from "../../packages/core/src/epub.js";
import { browserPath, serveEpub } from "../../packages/core/src/qa.js";
import {
  repairImageChapter,
  repairImageFixture,
} from "../repair-image-fixture.js";

for (const mode of ["ltr", "rtl", "vertical"] as const)
  test(`repair centers standalone images in ${mode} flow`, async ({}, testInfo) => {
    const source = await repairImageFixture({
      direction: mode === "rtl" ? "rtl" : "ltr",
      vertical: mode === "vertical",
    });
    const browser = await chromium.launch({
      executablePath: await browserPath(),
    });
    const before = await serveEpub(inspectBytes(source));
    const repaired = applyRepair(source, planFromBytes(source));
    const after = await serveEpub(inspectBytes(repaired.bytes));
    try {
      const page = await browser.newPage();
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        const positions = [];
        for (const server of [before, after]) {
          await page.goto(`${server.origin}/${repairImageChapter}`);
          await page.evaluate(() =>
            Promise.all(Array.from(document.images, (image) => image.decode())),
          );
          positions.push(
            await page.evaluate(() => {
              const images = [
                "plain",
                "wrapped",
                "captioned",
                "nested-image",
              ].map((id) => {
                const image = document.getElementById(id)!;
                const block = image.closest("p,div,figure")!;
                const rect = image.getBoundingClientRect(),
                  parent = block.getBoundingClientRect();
                const vertical =
                  getComputedStyle(image).writingMode.startsWith("vertical");
                return {
                  id,
                  width: rect.width,
                  height: rect.height,
                  before: vertical
                    ? rect.top - parent.top
                    : rect.left - parent.left,
                  after: vertical
                    ? parent.bottom - rect.bottom
                    : parent.right - rect.right,
                };
              });
              const inline = document.querySelector("#inline img")!;
              return {
                images,
                inlineDisplay: getComputedStyle(inline).display,
                inlineHeight: inline.getBoundingClientRect().height,
                captionAlignment: getComputedStyle(
                  document.getElementById("caption")!,
                ).textAlign,
              };
            }),
          );
        }
        expect(
          positions[0].images.some(
            (image) => Math.abs(image.before - image.after) > 1,
          ),
        ).toBe(true);
        for (const image of positions[1].images) {
          expect(
            Math.abs(image.before - image.after),
            JSON.stringify(image),
          ).toBeLessThanOrEqual(1);
          expect(image.before).toBeGreaterThan(0);
          expect(image.width).toBe(120);
          expect(image.height).toBe(60);
        }
        expect(positions[1].inlineDisplay).toBe(positions[0].inlineDisplay);
        expect(positions[1].inlineHeight).toBe(positions[0].inlineHeight);
        expect(positions[1].captionAlignment).toBe(
          positions[0].captionAlignment,
        );
        await testInfo.attach(`placement-${width}.json`, {
          body: JSON.stringify(positions, null, 2),
          contentType: "application/json",
        });
      }
    } finally {
      await browser.close();
      await Promise.all([before.close(), after.close()]);
    }
  });
