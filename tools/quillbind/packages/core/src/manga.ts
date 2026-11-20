import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readBookWalkerLock } from "./bookwalker.js";
import { comicInfo } from "./comicinfo.js";
import {
  readScans,
  boundedRead,
  mangaLimits,
  type Scan,
} from "./manga-sources.js";
import { encodePage, jxlTools } from "./manga-jxl.js";
import { packArchive, unpack } from "./zip.js";
import { checkAbort, fail } from "./errors.js";
import { sha256 } from "./hash.js";
import { json, stable } from "./json.js";

export type EncodedPageEvidence = Awaited<
  ReturnType<typeof encodePage>
>["evidence"] & {
  page: string;
};

async function pathExists(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
}

async function findExistingAncestor(dir: string): Promise<string> {
  if (await pathExists(dir)) return dir;
  const parent = path.dirname(dir);
  if (parent === dir) return dir;
  return findExistingAncestor(parent);
}

async function assertOutputOutsideSource(input: string, output: string) {
  const root = await fs.realpath(input);
  const sourceStat = await fs.lstat(input);
  if (!sourceStat.isDirectory()) return;
  const ancestor = await findExistingAncestor(path.dirname(output));
  const parent = path.resolve(
    await fs.realpath(ancestor),
    path.relative(ancestor, path.dirname(output)),
  );
  if (parent === root || parent.startsWith(root + path.sep))
    fail(
      "OUTPUT_IN_SOURCE",
      "Place CBZ output and reports outside the scan directory",
    );
}

async function openMangaLock(lockfile: string) {
  return fs.open(lockfile, "wx").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST")
      fail("MANGA_BUSY", "Another manga operation owns the output lock");
    throw error;
  });
}

async function createReportDirectory(reports: string) {
  await fs.mkdir(reports).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST")
      fail(
        "MANGA_REPORT_EXISTS",
        "Choose a new output path; its report directory already exists",
      );
    throw error;
  });
}

interface EncodeState {
  entries: Map<string, Uint8Array>;
  pages: EncodedPageEvidence[];
  encodedBytes: number;
}

async function encodeSingleMangaPage(
  state: EncodeState,
  scan: Scan,
  index: number,
  temporary: string,
  codec: Awaited<ReturnType<typeof jxlTools>>,
  signal?: AbortSignal,
) {
  checkAbort(signal);
  const directory = path.join(temporary, String(index));
  await fs.mkdir(directory);
  const result = await encodePage(scan, directory, codec, signal);
  state.encodedBytes += result.bytes.length;
  if (state.encodedBytes > mangaLimits.totalBytes)
    fail("MANGA_LIMIT", "Encoded pages exceed the CBZ byte limit");
  const page = `${String(index + 1).padStart(5, "0")}.jxl`;
  state.entries.set(page, result.bytes);
  state.pages.push({ ...result.evidence, page });
  await fs.rm(directory, { recursive: true });
}

async function encodeMangaPages(
  scanPages: Scan[],
  temporary: string,
  codec: Awaited<ReturnType<typeof jxlTools>>,
  signal?: AbortSignal,
) {
  const state: EncodeState = {
    entries: new Map<string, Uint8Array>(),
    pages: [],
    encodedBytes: 0,
  };
  let chain = Promise.resolve();
  for (const [index, scan] of scanPages.entries())
    chain = chain.then(() =>
      encodeSingleMangaPage(state, scan, index, temporary, codec, signal),
    );
  await chain;
  return state;
}

function verifyMangaArchive(entries: Map<string, Uint8Array>, bytes: Buffer) {
  const verified = unpack(bytes, {
    maxEntries: mangaLimits.entries + 2,
    maxEntryBytes: mangaLimits.pageBytes,
    maxTotalBytes: mangaLimits.totalBytes + 16 * 1024 * 1024,
  });
  for (const [name, content] of entries)
    if (!verified.get(name)?.bytes.equals(Buffer.from(content)))
      fail("MANGA_INTEGRITY", `CBZ round trip changed ${name}`);
  if (!packArchive(entries, 946684800, { store: true }).equals(bytes))
    fail("NONDETERMINISTIC_BUILD", "Repeated CBZ packaging differs");
}

export async function packageManga(
  input: string,
  options: {
    bookwalker: string;
    output: string;
    order?: string[];
    direction?: "rtl" | "ltr";
    signal?: AbortSignal;
  },
) {
  checkAbort(options.signal);
  if (
    options.direction !== undefined &&
    !["rtl", "ltr"].includes(options.direction)
  )
    fail("MANGA_DIRECTION", "Reading direction must be rtl or ltr");
  const output = path.resolve(options.output);
  if (!/\.cbz$/i.test(output))
    fail("MANGA_OUTPUT", "Manga output must have a .cbz extension");
  if (await pathExists(output))
    fail(
      "OUTPUT_EXISTS",
      "CBZ output must be a new path; originals are protected",
    );
  await assertOutputOutsideSource(input, output);
  const sources = readBookWalkerLock(
    (await boundedRead(options.bookwalker, 4 * 1024 * 1024)).toString(),
  );
  if (sources.metadata.kind !== "manga")
    fail(
      "MANGA_METADATA",
      "Select a manga BookWalker record, not a light novel",
    );
  const scans = await readScans(input, options);
  const codec = await jxlTools(options.signal);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const lockfile = output + ".manga.lock";
  const handle = await openMangaLock(lockfile);
  const reports = output + ".reports",
    runId = randomUUID();
  let temporary: string | undefined;
  let ownsReports = false;
  try {
    await createReportDirectory(reports);
    ownsReports = true;
    temporary = await fs.mkdtemp(
      path.join(path.dirname(output), ".quillbind-manga-"),
    );
    const { entries, pages } = await encodeMangaPages(
      scans.pages,
      temporary,
      codec,
      options.signal,
    );
    entries.set(
      "ComicInfo.xml",
      Buffer.from(comicInfo(sources.metadata, pages, options.direction)),
    );
    const provenance = {
      schemaVersion: 1,
      sourceDigest: scans.sourceDigest,
      ...(scans.archiveSha256 ? { archiveSha256: scans.archiveSha256 } : {}),
      bookwalker: sources,
      ignored: scans.ignored,
      order: options.order ? "explicit" : "natural numeric path order",
      readingDirection: options.direction ?? "unspecified",
      codec: { versions: codec.versions, distance: 0, effort: 7, threads: 1 },
      pages,
    };
    entries.set("quillbind.json", Buffer.from(stable(provenance) + "\n"));
    const bytes = packArchive(entries, 946684800, { store: true });
    verifyMangaArchive(entries, bytes);
    const current = await readScans(input, options);
    if (
      current.sourceDigest !== scans.sourceDigest ||
      current.archiveSha256 !== scans.archiveSha256
    )
      fail(
        "MANGA_SOURCE_CHANGED",
        "Scan inputs changed while packaging; no output was published",
      );
    const candidate = path.join(temporary, "candidate.cbz");
    await fs.writeFile(candidate, bytes, { flag: "wx" });
    checkAbort(options.signal);
    const artifact = {
      path: output,
      sha256: sha256(bytes),
      size: bytes.length,
      mediaType: "application/vnd.comicbook+zip",
    };
    const report = {
      status: "pass" as const,
      operation: "manga-package",
      runId,
      artifact,
      metadata: sources.metadata,
      sourceDigest: scans.sourceDigest,
      pages,
      ignored: scans.ignored,
      codec: provenance.codec,
      checks: {
        imageIntegrity: "pass",
        comicInfo: "generated against ComicInfo 2.0",
        archiveIntegrity: "pass",
        reproducibility: "pass",
        sourceUnchanged: "pass",
      },
      readerCompatibility:
        "Requires a CBZ reader with JPEG XL support; native reader testing not run",
      reports: {
        json: path.join(reports, "report.json"),
        provenance: path.join(reports, "provenance.json"),
      },
    };
    await json(path.join(reports, "provenance.json"), provenance);
    await json(report.reports.json, {
      ...report,
      status: "ready",
      artifact: undefined,
    });
    checkAbort(options.signal);
    await fs.link(candidate, output);
    await json(report.reports.json, report);
    return report;
  } catch (error) {
    const e = error as Error & { code?: string };
    if (ownsReports)
      await json(path.join(reports, "report.json"), {
        status: "fail",
        operation: "manga-package",
        runId,
        code: e.code ?? "MANGA_FAILED",
        message: e.message,
      });
    throw error;
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    await handle.close();
    await fs.unlink(lockfile);
  }
}
