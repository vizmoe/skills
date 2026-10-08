import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
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

export async function coverQa(
  candidate: string,
  report: {
    format: "epub" | "cbz";
    image: CoverImage;
    imagePath: string;
    documentPath: string | null;
  },
  output: string,
  signal?: AbortSignal,
) {
  const bytes = await readSourceFile(candidate),
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-cover-qa-"));
  let info: EpubInspection, resource: string;
  try {
    if (report.format === "epub") {
      info = inspectBytes(bytes, true);
      resource = report.documentPath!;
    } else {
      const file = openMetadata(bytes, "cbz");
      let raster = file.entries.get(report.imagePath)!.bytes;
      if (report.imagePath.toLowerCase().endsWith(".jxl")) {
        const input = path.join(temporary, "page.jxl"),
          decoded = path.join(
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
        raster = await boundedRead(decoded, mangaLimits.pageBytes);
      }
      const details = await coverImage(raster);
      if (
        details.width !== report.image.width ||
        details.height !== report.image.height
      )
        fail("COVER_GEOMETRY", "Decoded cover dimensions changed");
      resource = "cover.xhtml";
      const imagePath = `cover${details.extension}`,
        page = Buffer.from(coverDocument(imagePath, "und"));
      info = {
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
    }
    await fs.mkdir(output, { recursive: true });
    const browser = await chromium.launch({
      executablePath: await browserPath(),
      headless: true,
    });
    let server: Awaited<ReturnType<typeof serveEpub>> | undefined;
    const cases = [];
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
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 1200, height: 700 },
      ]) {
        checkAbort(signal);
        await page.setViewportSize(viewport);
        await page.goto(
          `${origin}/${resource.split("/").map(encodeURIComponent).join("/")}`,
          { waitUntil: "load", timeout: 30000 },
        );
        const metrics = await page.evaluate(() => {
          const images = Array.from(document.images),
            image = images[0],
            rect = image?.getBoundingClientRect();
          return {
            count: images.length,
            loaded: !!image?.complete && image.naturalWidth > 0,
            naturalWidth: image?.naturalWidth ?? 0,
            naturalHeight: image?.naturalHeight ?? 0,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
            inside:
              !!rect &&
              rect.left >= -1 &&
              rect.top >= -1 &&
              rect.right <= innerWidth + 1 &&
              rect.bottom <= innerHeight + 1,
            overflow:
              document.documentElement.scrollWidth > innerWidth + 1 ||
              document.documentElement.scrollHeight > innerHeight + 1,
          };
        });
        const ratio = report.image.width / report.image.height;
        const passed =
          metrics.count === 1 &&
          metrics.loaded &&
          metrics.inside &&
          !metrics.overflow &&
          Math.abs(metrics.width / metrics.height - ratio) < 0.005 &&
          Math.abs(metrics.naturalWidth / metrics.naturalHeight - ratio) <
            0.005;
        const screenshot = `${viewport.width}x${viewport.height}.png`;
        await page.screenshot({ path: path.join(output, screenshot) });
        cases.push({
          viewport,
          ...metrics,
          status: passed ? "pass" : "fail",
          screenshot,
        });
      }
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
