import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { stringify } from "yaml";
import { BiliSource } from "./novel-bili.js";
import { FunSource } from "./novel-fun.js";
import { ShelfSource, type NovelHub } from "./novel-shelf.js";
import {
  NovelHttp,
  novelAddress,
  type NovelNetworkOptions,
} from "./novel-http.js";
import { markdownText, novelMarkdown } from "./novel-html.js";
import type { NovelSource, NovelVolume } from "./novel-model.js";
import { inspectImage } from "./images.js";
import { bookSchema, validLanguage, type NavigationEntry } from "./config.js";
import { buildBook } from "./pipeline.js";
import { resolveMetadata } from "./metadata.js";
import { checkAbort, fail } from "./errors.js";
import { json } from "./json.js";
import { sha256 } from "./hash.js";
import type { Artifact, Diagnostic } from "./model.js";
import type { QaOptions } from "./qa-plan.js";

export interface NovelOptions extends NovelNetworkOptions {
  /** Injectable read-only hub for recorded-response tests. */
  hub?: NovelHub;
}
export interface FetchNovelOptions extends NovelOptions {
  output?: string;
  volumes?: string;
  splitVolumes?: boolean;
  prepareOnly?: boolean;
  title?: string;
  authors?: string[];
  description?: string;
  language?: string;
  qa?: QaOptions;
  onProgress?: (message: string) => void;
}
function sourceFor(http: NovelHttp, options: NovelOptions): NovelSource {
  switch (http.address.site) {
    case "bilinovel":
      return new BiliSource(http);
    case "lightnovel-fun":
      return new FunSource(http);
    case "lightnovel-app":
      return new ShelfSource(http, options.hub);
  }
}
async function cleanup(
  source: NovelSource | undefined,
  staging: string | undefined,
  operationFailed: boolean,
) {
  const results = await Promise.allSettled([
    source?.close(),
    staging ? fs.rm(staging, { recursive: true, force: true }) : undefined,
  ]);
  if (!operationFailed) {
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected")
      throw failure.reason instanceof Error
        ? failure.reason
        : new Error(String(failure.reason));
  }
}
export async function inspectNovel(url: string, options: NovelOptions = {}) {
  const http = new NovelHttp(novelAddress(url), options),
    source = sourceFor(http, options);
  let operationFailed = false;
  try {
    return {
      status: "pass" as const,
      operation: "novel-inspect" as const,
      ...(await source.catalog()),
    };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    await cleanup(source, undefined, operationFailed);
  }
}
export function selectNovelVolumes(volumes: NovelVolume[], selection?: string) {
  if (selection === undefined || selection === "all") return volumes;
  if (!/^[1-9]\d*(?:-[1-9]\d*)?(?:,[1-9]\d*(?:-[1-9]\d*)?)*$/.test(selection))
    fail(
      "NOVEL_VOLUMES",
      "Use --volumes all, 1,3 or 1-3,5 (one-based catalog numbers)",
    );
  const selected = new Set<number>();
  for (const range of selection.split(",")) {
    const [start, last] = range.split("-").map(Number),
      end = last ?? start;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      end > volumes.length
    )
      fail(
        "NOVEL_VOLUMES",
        "Selected volume range is outside the source catalog",
      );
    for (let n = start; n <= end; n++) selected.add(n);
  }
  return volumes.filter((volume) => selected.has(volume.number));
}
interface ImageRecord {
  url: string;
  path: string;
  sourceSha256: string;
  sha256: string;
  action: "preserved" | "webp-to-png";
  original?: string;
}
interface NovelProjectResult {
  root: string;
  title: string;
  volumes: number[];
  chapters: number;
  status: "prepared" | "pass" | "fail";
  readiness: { metadata: string; release: "not-run" | "pass" | "fail" };
  diagnostics: Diagnostic[];
  artifact?: Artifact;
  reports?: { summaryMarkdown: string; summaryJson: string };
}

export async function fetchNovelBook(
  url: string,
  options: FetchNovelOptions = {},
) {
  const address = novelAddress(url);
  if (options.language && !validLanguage(options.language))
    fail("NOVEL_OPTIONS", "--language requires a valid BCP 47 language tag");
  if (
    options.authors?.some((author) => !author.trim()) ||
    options.authors?.length === 0
  )
    fail("NOVEL_OPTIONS", "--author must not be empty");
  const root = path.resolve(
    options.output ?? `novel-${address.site}-${address.id}`,
  );
  // Fail on existing directories, files and dangling symlinks before making requests.
  await fs.lstat(root).then(
    () => fail("OUTPUT_EXISTS", "Novel import requires a new output directory"),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const http = new NovelHttp(address, options),
    source = sourceFor(http, options);
  let staging: string | undefined;
  let sourceClosed = false,
    operationFailed = false;
  try {
    options.onProgress?.("Reading book metadata and volume catalog");
    const catalog = await source.catalog();
    const selected = selectNovelVolumes(catalog.volumes, options.volumes);
    checkAbort(options.signal);
    await fs.mkdir(path.dirname(root), { recursive: true });
    staging = await fs.mkdtemp(
      path.join(path.dirname(root), ".quillbind-novel-"),
    );
    const cachedImages = new Map<
      string,
      { file: string; record: ImageRecord; original?: string }
    >();
    const projects: NovelProjectResult[] = [];
    const groups = options.splitVolumes
      ? selected.map((volume) => [volume])
      : [selected];
    for (const volumes of groups) {
      const relativeRoot = options.splitVolumes
        ? `volume-${String(volumes[0].number).padStart(3, "0")}`
        : ".";
      const bookRoot = path.join(staging, relativeRoot),
        finalRoot = path.join(root, relativeRoot);
      await fs.mkdir(path.join(bookRoot, "chapters"), { recursive: true });
      await fs.mkdir(path.join(bookRoot, "assets"), { recursive: true });
      const images: ImageRecord[] = [],
        provenance: {
          file: string;
          url: string;
          pages: string[];
          sha256: string;
        }[] = [];
      const saveImage = async (imageUrl: string) => {
        let saved = cachedImages.get(imageUrl);
        if (!saved) {
          const response = await http.read(imageUrl, { asset: true });
          let bytes = response.bytes;
          const originalHash = sha256(bytes);
          const webp =
            bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP";
          let original: string | undefined;
          if (webp) {
            const metadata = await sharp(bytes).metadata();
            if ((metadata.pages ?? 1) > 1)
              fail(
                "NOVEL_IMAGE_FORMAT",
                "Animated WebP needs an explicit authoring decision; no frames were discarded",
              );
            original = `assets/${originalHash}.webp`;
            await fs.writeFile(path.join(bookRoot, original), bytes);
            bytes = await sharp(bytes).keepMetadata().png().toBuffer();
          }
          const info = await inspectImage(bytes, imageUrl);
          const file = `assets/${sha256(bytes)}.${info.extension}`;
          await fs.writeFile(path.join(bookRoot, file), bytes);
          saved = {
            file: path.join(bookRoot, file),
            ...(original ? { original: path.join(bookRoot, original) } : {}),
            record: {
              url: imageUrl,
              path: file,
              sourceSha256: originalHash,
              sha256: sha256(bytes),
              action: webp ? "webp-to-png" : "preserved",
              ...(original ? { original } : {}),
            },
          };
          cachedImages.set(imageUrl, saved);
        }
        const target = path.join(bookRoot, saved.record.path);
        if (target !== saved.file) await fs.copyFile(saved.file, target);
        if (
          saved.original &&
          saved.record.original &&
          path.join(bookRoot, saved.record.original) !== saved.original
        )
          await fs.copyFile(
            saved.original,
            path.join(bookRoot, saved.record.original),
          );
        if (!images.some((record) => record.url === imageUrl))
          images.push(saved.record);
        return saved.record.path;
      };
      const title =
        options.title ??
        (options.splitVolumes
          ? `${catalog.title} — ${volumes[0].title}`
          : catalog.title);
      const language = options.language ?? catalog.language;
      const coverUrl =
        volumes.length === 1
          ? (volumes[0].cover ?? catalog.cover)
          : (catalog.cover ?? volumes[0].cover);
      const cover = coverUrl ? await saveImage(coverUrl) : undefined;
      const chapters: string[] = [],
        navigation: NavigationEntry[] = [];
      for (const volume of volumes) {
        const children: NavigationEntry[] = [],
          prefix = `v${String(volume.number).padStart(3, "0")}`;
        if (volumes.length > 1 && volume.cover) {
          const artwork = await saveImage(volume.cover),
            file = `chapters/${prefix}-cover.md`;
          await fs.writeFile(
            path.join(bookRoot, file),
            `---\n${stringify({ id: `${prefix}-cover`, title: volume.title, lang: language })}---\n\n# ${markdownText(volume.title)}\n\n![${markdownText(volume.title)}](${artwork})\n`,
          );
          chapters.push(file);
          children.push(file);
        }
        for (const [index, chapter] of volume.chapters.entries()) {
          checkAbort(options.signal);
          options.onProgress?.(
            `Volume ${volume.number}: ${index + 1}/${volume.chapters.length} — ${chapter.title}`,
          );
          const pages = await source.chapter(chapter),
            chunks: string[] = [];
          for (const page of pages)
            chunks.push(
              await novelMarkdown(
                page.html,
                page.url,
                async (url) => await saveImage(url),
              ),
            );
          const file = `chapters/${prefix}-${String(index + 1).padStart(4, "0")}.md`;
          const markdown = `---\n${stringify({ id: `${prefix}-c${index + 1}`, title: chapter.title, lang: language, source: chapter.url })}---\n\n# ${markdownText(chapter.title)}\n\n${chunks.join("\n")}\n`;
          await fs.writeFile(path.join(bookRoot, file), markdown, {
            flag: "wx",
          });
          chapters.push(file);
          children.push(file);
          provenance.push({
            file,
            url: chapter.url,
            pages: pages.map((page) => page.url),
            sha256: sha256(markdown),
          });
        }
        navigation.push({ title: volume.title, children });
      }
      const config = bookSchema.parse({
        schemaVersion: 1,
        book: {
          title,
          authors: options.authors ?? catalog.authors,
          description: options.description ?? catalog.description,
          language,
          publication: { isbn: null },
          tags: ["Literature.Fiction"],
        },
        theme: "literature",
        chapters,
        navigation,
        markdown: {
          chapterMetadata: { fields: ["source"], display: "hidden" },
        },
        ...(cover ? { cover: { path: cover } } : {}),
        ...(options.qa ? { qa: options.qa } : {}),
        build: {
          epoch: 946684800,
          stripImageMetadata: false,
          optimizeImages: true,
        },
      });
      await fs.writeFile(path.join(bookRoot, "book.yaml"), stringify(config));
      const metadata = await resolveMetadata(bookRoot);
      const diagnostics = [...catalog.diagnostics, ...metadata.diagnostics];
      if (!cover)
        diagnostics.push({
          code: "NOVEL_COVER_MISSING",
          severity: "warning",
          message: "The source supplies no cover artwork",
        });
      if (images.length)
        diagnostics.push({
          code: "NOVEL_IMAGE_DESCRIPTIONS",
          severity: "warning",
          message:
            "Image descriptions use source alt text or numbered illustration labels; review them for meaningful descriptions",
        });
      const project: NovelProjectResult = {
        root: finalRoot,
        title,
        volumes: volumes.map((volume) => volume.number),
        chapters: provenance.length,
        status: "prepared",
        readiness: { metadata: metadata.status, release: "not-run" },
        diagnostics,
      };
      projects.push(project);
      await json(path.join(bookRoot, "metadata/novel-source.json"), {
        schemaVersion: 1,
        source: catalog.url,
        site: catalog.site,
        bookId: catalog.id,
        retrievedAt: new Date().toISOString(),
        title: catalog.title,
        authors: catalog.authors,
        description: catalog.description,
        language: catalog.language,
        volumes,
        chapters: provenance,
        images,
        readiness: project.readiness,
        diagnostics,
      });
    }
    await json(path.join(staging, "novel-requests.json"), {
      schemaVersion: 1,
      requests: http.evidence,
    });
    await source.close();
    sourceClosed = true;
    const report = {
      schemaVersion: 1,
      operation: "novel-fetch" as const,
      status: "prepared" as "prepared" | "pass" | "fail",
      root,
      source: address.url,
      mode: options.splitVolumes ? "split" : "merged",
      publicationReady: false,
      projects,
      report: path.join(root, "novel.json"),
    };
    await json(path.join(staging, "novel.json"), report);
    checkAbort(options.signal);
    await fs.mkdir(root);
    try {
      await fs.rename(staging, root);
    } catch (error) {
      await fs.rmdir(root);
      throw error;
    }
    staging = undefined;
    if (!options.prepareOnly) {
      try {
        for (const project of projects) {
          options.onProgress?.(`Running EPUB release checks: ${project.title}`);
          project.reports = {
            summaryMarkdown: path.join(project.root, "dist/reports/summary.md"),
            summaryJson: path.join(project.root, "dist/reports/summary.json"),
          };
          const release = await buildBook(project.root, {
            signal: options.signal,
            qa: options.qa,
          });
          project.status = "pass";
          project.readiness.release = "pass";
          project.artifact = release.artifact;
          await json(report.report, report);
        }
        report.status = "pass";
        report.publicationReady = true;
      } catch (error) {
        report.status = "fail";
        const failed = projects.find(
          (project) => project.status === "prepared",
        );
        if (failed) {
          failed.status = "fail";
          failed.readiness.release = "fail";
        }
        await json(report.report, report);
        if (error instanceof Error)
          Object.assign(error, {
            reports: { novel: report.report, ...failed?.reports },
          });
        throw error;
      }
      await json(report.report, report);
    }
    return report;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    await cleanup(sourceClosed ? undefined : source, staging, operationFailed);
  }
}
