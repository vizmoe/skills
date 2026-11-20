import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import type { EpubInspection } from "./epub.js";
import { browserPath, serveEpub } from "./qa-environment.js";
import { elements, NS } from "./xml.js";
import { checkAbort, fail } from "./errors.js";
import { json } from "./json.js";
import { sha256 } from "./hash.js";

export interface ReadingIssue {
  resource: string;
  code: string;
  message: string;
}

interface ReadingCheck {
  resource: string;
  expectedText: string;
  mode: "default" | "large" | "dark";
}

function selectReadingDocuments(info: EpubInspection) {
  const all = [
    ...new Set(
      info.spine
        .map((id) => info.manifest.find((m) => m.id === id)?.path)
        .filter((p): p is string => Boolean(p && info.documents.has(p))),
    ),
  ];
  if (!all.length) fail("SPINE_INVALID", "No readable spine documents");
  const selected = new Set<string>([all[0], all.at(-1)!]);
  const main = all.find(
    (p) =>
      (elements(info.documents.get(p)!, "body", NS.xhtml)[0]?.textContent
        ?.length ?? 0) > 2000,
  );
  const illustrated = all.find(
    (p) => elements(info.documents.get(p)!, "img").length > 0,
  );
  if (main) selected.add(main);
  if (illustrated) selected.add(illustrated);
  for (let i = 1; i <= 4; i++)
    selected.add(all[Math.floor(((all.length - 1) * i) / 5)]);
  for (const item of info.manifest.filter((m) => m.properties.includes("nav")))
    selected.add(item.path);
  return { all, selected };
}

function readingModeStyle(mode: ReadingCheck["mode"]): string | undefined {
  if (mode === "large")
    return "html {font-size:200%!important} body,p,li {font-family:serif!important;line-height:1.8!important}";
  if (mode === "dark")
    return "html,body {color:#eee!important;background:#111!important;color-scheme:dark}";
  return undefined;
}

async function runReadingCheck(
  page: Page,
  check: ReadingCheck,
  options: {
    origin: string;
    output: string;
    signal?: AbortSignal;
    issues: ReadingIssue[];
    cases: unknown[];
  },
) {
  checkAbort(options.signal);
  const { resource, expectedText, mode } = check;
  const width = mode === "large" ? 320 : 390;
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`${options.origin}/${resource}`, {
    waitUntil: "load",
    timeout: 30000,
  });
  const style = readingModeStyle(mode);
  if (style) await page.addStyleTag({ content: style });
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page.evaluate((expected) => {
    return {
      textPreserved:
        (document.body.textContent ?? "")
          .normalize("NFC")
          .replace(/\s+/g, " ")
          .trim() === expected.normalize("NFC").replace(/\s+/g, " ").trim(),
      missingImages: Array.from(document.images)
        .filter((image) => !image.complete || image.naturalWidth === 0)
        .map((image) => image.getAttribute("src")),
      overflow: document.documentElement.scrollWidth > innerWidth + 2,
      content: Boolean(
        document.body.textContent?.trim() ||
        document.querySelector("img,svg image"),
      ),
    };
  }, expectedText);
  const checks = [
    ["TEXT_CHANGED", !metrics.textPreserved],
    ["IMAGE_MISSING", metrics.missingImages.length > 0],
    ["HORIZONTAL_OVERFLOW", metrics.overflow],
    ["EMPTY_PAGE", !metrics.content],
  ] as const;
  for (const [code, failed] of checks) {
    if (!failed) continue;
    const suffix =
      code === "IMAGE_MISSING" ? " " + metrics.missingImages.join(", ") : "";
    options.issues.push({
      resource,
      code,
      message: `${mode}: ${code}${suffix}`,
    });
  }
  const screenshot = `${sha256(resource).slice(0, 12)}-${mode}.png`;
  await page.screenshot({ path: path.join(options.output, screenshot) });
  options.cases.push({ resource, mode, width, ...metrics, screenshot });
}

/** A bounded reading smoke test; deliberately does not claim the full publication QA gate. */
export async function readingQa(
  info: EpubInspection,
  output: string,
  signal?: AbortSignal,
) {
  const { all, selected } = selectReadingDocuments(info);
  const issues: ReadingIssue[] = [];
  const cases: unknown[] = [];
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: await browserPath(),
    headless: true,
  });
  let server: Awaited<ReturnType<typeof serveEpub>> | undefined;
  const onAbort = () => {
    void browser.close().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    server = await serveEpub(info);
    const { origin } = server;
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    const checks: ReadingCheck[] = [];
    for (const resource of selected) {
      const packaged = info.documents.get(resource);
      if (!packaged) continue;
      const expectedText =
        elements(packaged, "body", NS.xhtml)[0]?.textContent ?? "";
      for (const mode of ["default", "large", "dark"] as const)
        checks.push({ resource, expectedText, mode });
    }
    let chain = Promise.resolve();
    for (const check of checks)
      chain = chain.then(() =>
        runReadingCheck(page, check, { origin, output, signal, issues, cases }),
      );
    await chain;
    await context.close();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await Promise.allSettled([browser.close(), server?.close()]);
  }
  const report = {
    status: issues.length ? "findings" : "pass",
    scope: "sampled-reading-smoke-test",
    artifactSha256: info.sha256,
    totalDocuments: all.length,
    sampledDocuments: [...selected],
    cases,
    issues,
    fullPublicationQa: "not-run",
    accessibilityCertification: false,
  };
  await json(path.join(output, "report.json"), report);
  return report;
}
