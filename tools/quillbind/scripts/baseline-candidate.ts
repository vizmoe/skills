import { bodymatterItems } from "../tests/helpers.js";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { inspectBytes } from "../packages/core/src/validate.js";
import { browserPath, serveEpub } from "../packages/core/src/qa.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { json } from "../packages/core/src/json.js";
import { sha256 } from "../packages/core/src/hash.js";
import { fail } from "../packages/core/src/errors.js";
if (process.env.CI || process.env.QUILLBIND_QA_ENV !== "linux-arm64-noble-v2")
  fail(
    "BASELINE_ENVIRONMENT",
    "Create review candidates explicitly in the pinned container with CI unset",
  );
const directory = path.join(repoRoot, "dist/baseline-review");
await fs.mkdir(directory, { recursive: true });
const themeHashes: Record<string, string> = {};
let browserVersion = "";
for (const theme of ["literature", "technical"]) {
  const info = inspectBytes(
    await fs.readFile(path.join(repoRoot, `examples/${theme}/dist/book.epub`)),
    true,
  );
  const server = await serveEpub(info);
  const browser = await chromium.launch({
    executablePath: await browserPath(),
  });
  try {
    browserVersion = browser.version();
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
    await page.goto(`${server.origin}/${bodymatterItems(info)[0].path}`);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images).map((image) => image.decode()),
      );
    });
    await page.screenshot({
      path: path.join(directory, `${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
    themeHashes[theme] = sha256(
      Buffer.concat([
        await fs.readFile(path.join(repoRoot, "styles/base/epub.css")),
        await fs.readFile(path.join(repoRoot, `styles/themes/${theme}.css`)),
      ]),
    );
  } finally {
    await browser.close();
    await server.close();
  }
}
await json(path.join(directory, "candidate.json"), {
  status: "review-candidate",
  environment: "linux-arm64-noble-v2",
  qaFontHash: sha256(
    await fs.readFile(path.join(repoRoot, "standards/qa-fonts.lock.json")),
  ),
  browser: browserVersion,
  themeHashes,
  reviewCriteria: [
    "literature chapter opening has no indentation",
    "CJK glyphs and punctuation render",
    "quotation has a visible border and no body first-line indent",
    "technical listing retains indentation",
    "table is legible and semantically captioned",
    "inline and display math render",
    "notes retain visible backlinks",
  ],
});
console.log(
  "Review candidates written to dist/baseline-review; no committed baseline was updated.",
);
