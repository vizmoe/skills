import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { inspectBytes, type EpubInspection } from "./epub.js";
import { openMetadata } from "./metadata-file.js";
import { coverDocument } from "./cover-epub.js";
import { coverImage, type CoverImage } from "./cover-image.js";
import { jxlTools } from "./manga-jxl.js";
import { browserPath, serveEpub } from "./qa-environment.js";
import { boundedRead, mangaLimits } from "./manga-sources.js";
import { readSourceFile } from "./files.js";
import { run } from "./process.js";
import { xml } from "./xml.js";
import { checkAbort, fail } from "./errors.js";
import { json } from "./json.js";
import { sha256 } from "./hash.js";
import { packArchive, unpack } from "./zip.js";

interface CoverQaReport {
  format: "epub" | "cbz";
  image: CoverImage;
  imagePath: string;
  documentPath: string | null;
}

type CoverViewport = {
  width: number;
  height: number;
};

const coverViewports: readonly CoverViewport[] = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1200, height: 700 },
];

async function decodeCbzCoverRaster(
  raster: Buffer,
  report: CoverQaReport,
  temporary: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!report.imagePath.toLowerCase().endsWith(".jxl")) return raster;
  const input = path.join(temporary, "page.jxl");
  const decoded = path.join(
    temporary,
    report.image.extension === ".jpg" ? "page.jpg" : "page.png",
  );
  await fs.writeFile(input, raster);
  const result = await run(
    (await jxlTools(signal)).djxl,
    [input, decoded, "--num_threads=1"],
    { signal, timeout: 180000 },
  );
  if (result.exitCode !== 0)
    fail("COVER_DECODE", "Cannot decode actual CBZ cover page");
  return boundedRead(decoded, mangaLimits.pageBytes);
}

async function prepareCbzCoverPreview(
  bytes: Buffer,
  report: CoverQaReport,
  temporary: string,
  signal?: AbortSignal,
): Promise<{ info: EpubInspection; resource: string }> {
  const file = openMetadata(bytes, "cbz");
  const raster = await decodeCbzCoverRaster(
    file.entries.get(report.imagePath)!.bytes,
    report,
    temporary,
    signal,
  );
  const details = await coverImage(raster);
  if (
    details.width !== report.image.width ||
    details.height !== report.image.height
  )
    fail("COVER_GEOMETRY", "Decoded cover dimensions changed");
  const resource = "cover.xhtml";
  const imagePath = `cover${details.extension}`;
  const page = Buffer.from(coverDocument(imagePath, "und"));
  const info: EpubInspection = {
    sha256: sha256(bytes),
    entries: unpack(
      packArchive(
        new Map([
          [resource, page],
          [imagePath, raster],
        ]),
        946684800,
      ),
    ),
    packagePath: "preview.opf",
    packageDocument: xml("<preview/>"),
    manifest: [
      {
        id: "cover",
        href: resource,
        path: resource,
        mediaType: "application/xhtml+xml",
        properties: [],
      },
      {
        id: "image",
        href: imagePath,
        path: imagePath,
        mediaType: details.mediaType,
        properties: [],
      },
    ],
    spine: ["cover"],
    documents: new Map([[resource, xml(page.toString())]]),
    version: "3.0",
    language: "und",
    title: "Cover preview",
    unsupported: [],
  };
  return { info, resource };
}

function measureCoverImage() {
  const images = Array.from(document.images);
  const image = images[0];
  const rect = image?.getBoundingClientRect();
  return {
    count: images.length,
    loaded: Boolean(image?.complete) && image.naturalWidth > 0,
    naturalWidth: image?.naturalWidth ?? 0,
    naturalHeight: image?.naturalHeight ?? 0,
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
    inside:
      Boolean(rect) &&
      rect.left >= -1 &&
      rect.top >= -1 &&
      rect.right <= innerWidth + 1 &&
      rect.bottom <= innerHeight + 1,
    overflow:
      document.documentElement.scrollWidth > innerWidth + 1 ||
      document.documentElement.scrollHeight > innerHeight + 1,
  };
}

async function captureCoverViewport(
  page: Page,
  url: string,
  viewport: CoverViewport,
  ratio: number,
  output: string,
  signal?: AbortSignal,
) {
  checkAbort(signal);
  await page.setViewportSize(viewport);
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  const metrics = await page.evaluate(measureCoverImage);
  const passed =
    metrics.count === 1 &&
    metrics.loaded &&
    metrics.inside &&
    !metrics.overflow &&
    Math.abs(metrics.width / metrics.height - ratio) < 0.005 &&
    Math.abs(metrics.naturalWidth / metrics.naturalHeight - ratio) < 0.005;
  const screenshot = `${viewport.width}x${viewport.height}.png`;
  await page.screenshot({ path: path.join(output, screenshot) });
  return {
    viewport,
    ...metrics,
    status: passed ? "pass" : "fail",
    screenshot,
  };
}

export async function coverQa(
  candidate: string,
  report: CoverQaReport,
  output: string,
  signal?: AbortSignal,
) {
  const bytes = await readSourceFile(candidate);
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "quillbind-cover-qa-"),
  );
  try {
    const { info, resource } =
      report.format === "epub"
        ? { info: inspectBytes(bytes, true), resource: report.documentPath! }
        : await prepareCbzCoverPreview(bytes, report, temporary, signal);
    await fs.mkdir(output, { recursive: true });
    const browser = await chromium.launch({
      executablePath: await browserPath(),
      headless: true,
    });
    let server: Awaited<ReturnType<typeof serveEpub>> | undefined;
    const cases: Awaited<ReturnType<typeof captureCoverViewport>>[] = [];
    const onAbort = () => {
      void browser.close().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      server = await serveEpub(info);
      const { origin } = server;
      const context = await browser.newContext({ serviceWorkers: "block" });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      const targetUrl = `${origin}/${resource.split("/").map(encodeURIComponent).join("/")}`;
      const ratio = report.image.width / report.image.height;
      let chain = Promise.resolve();
      for (const viewport of coverViewports) {
        chain = chain.then(async () => {
          cases.push(
            await captureCoverViewport(
              page,
              targetUrl,
              viewport,
              ratio,
              output,
              signal,
            ),
          );
        });
      }
      await chain;
      await context.close();
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await Promise.allSettled([browser.close(), server?.close()]);
    }
    const result = {
      status: cases.every((item) => item.status === "pass") ? "pass" : "fail",
      scope:
        report.format === "epub"
          ? "actual-epub-cover-browser-render"
          : "actual-cbz-decoded-cover-browser-preview",
      artifactSha256: sha256(bytes),
      imagePath: report.imagePath,
      cases,
      nativeReaderVerification: "not-run",
    };
    await json(path.join(output, "report.json"), result);
    if (result.status !== "pass")
      fail(
        "COVER_RENDER",
        "Rendered cover is missing, cropped, stretched or overflows the viewport",
        result,
      );
    return result;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
