import { bodymatterItems } from "../helpers.js";
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectBytes } from "../../packages/core/src/validate.js";
import { browserPath, serveEpub } from "../../packages/core/src/qa.js";
import { repoRoot } from "../../packages/core/src/runtime.js";
import { readJson } from "../../packages/core/src/json.js";
import { sha256 } from "../../packages/core/src/hash.js";

test.beforeAll(() => {
  expect(process.platform).toBe("linux");
  expect(process.arch).toBe("arm64");
  expect(process.env.QUILLBIND_QA_ENV).toBe("linux-arm64-noble-v2");
});
for (const theme of ["literature", "technical"])
  test(`${theme} approved reference rendering`, async () => {
    const reference = await readJson<{
      themeHashes: Record<string, string>;
      browser: string;
      qaFontHash: string;
    }>(path.join(repoRoot, "tests/baselines/review.json"));
    const hash = sha256(
      Buffer.concat([
        await fs.readFile(path.join(repoRoot, "styles/base/epub.css")),
        await fs.readFile(path.join(repoRoot, `styles/themes/${theme}.css`)),
      ]),
    );
    expect(hash).toBe(reference.themeHashes[theme]);
    expect(
      sha256(
        await fs.readFile(path.join(repoRoot, "standards/qa-fonts.lock.json")),
      ),
    ).toBe(reference.qaFontHash);
    const info = inspectBytes(
      await fs.readFile(
        path.join(repoRoot, `examples/${theme}/dist/book.epub`),
      ),
      true,
    );
    const server = await serveEpub(info);
    const browser = await chromium.launch({
      executablePath: await browserPath(),
    });
    try {
      expect(browser.version()).toBe(reference.browser);
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        locale: "en-US",
        timezoneId: "UTC",
        serviceWorkers: "block",
      });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === server.origin
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
      await expect(page.locator("h1")).toHaveText(
        theme === "literature" ? "抵达" : "Clear Contracts",
      );
      if (theme === "technical") {
        await expect(page.locator("pre code")).toHaveText(
          "export function square(value: number): number {\n  return value * value;\n}",
        );
        await expect(page.locator("table caption")).toHaveText(
          "Inputs and expected results",
        );
        await expect(page.locator("math")).toHaveCount(2);
      }
      await expect(page).toHaveScreenshot(`${theme}.png`, { fullPage: true });
    } finally {
      await browser.close();
      await server.close();
    }
  });
