import fs from "node:fs/promises";
import path from "node:path";
import { constants, type Dirent, type Stats } from "node:fs";
import { safeName } from "./paths.js";
import { unpack } from "./zip.js";
import { checkAbort, fail } from "./errors.js";
import { sha256 } from "./hash.js";
import { stable } from "./json.js";

export const mangaLimits = {
  entries: 10000,
  pageBytes: 100 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  pixels: 100000000,
} as const;
export interface Scan {
  name: string;
  bytes: Buffer;
}
export async function boundedRead(file: string, maxBytes: number) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("MANGA_RESOURCE", "Scans must be regular files");
    if (stat.size > maxBytes)
      fail("MANGA_LIMIT", "Input exceeds the size limit");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const data = chunk as Buffer;
      size += data.length;
      if (size > maxBytes)
        fail("MANGA_LIMIT", "Input grew beyond the size limit");
      chunks.push(data);
    }
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
function compareSegment(a: string, b: string): number {
  if (a === b) return 0;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a),
      y = BigInt(b);
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  }
  return compareCodeUnits(a, b);
}
export function pageCompare(left: string, right: string): number {
  const a = left.toLowerCase().match(/\d+|\D+/g)!,
    b = right.toLowerCase().match(/\d+|\D+/g)!;
  const length = Math.min(a.length, b.length);
  for (let n = 0; n < length; n++) {
    const diff = compareSegment(a[n], b[n]);
    if (diff !== 0) return diff;
  }
  if (a.length !== b.length) return a.length - b.length;
  return compareCodeUnits(left, right);
}
interface ScanDirState {
  root: string;
  signal?: AbortSignal;
  files: Scan[];
  total: number;
  count: number;
}
async function readDirectoryEntry(
  state: ScanDirState,
  relative: string,
  depth: number,
  entry: Dirent,
): Promise<void> {
  checkAbort(state.signal);
  if (++state.count > mangaLimits.entries)
    fail("MANGA_LIMIT", "Too many scan entries");
  const name = relative ? `${relative}/${entry.name}` : entry.name;
  safeName(name);
  if (entry.isSymbolicLink())
    fail("MANGA_SYMLINK", `Symbolic link in scans: ${name}`);
  if (entry.isDirectory()) {
    await readScanDirectory(state, name, depth + 1);
    return;
  }
  if (!entry.isFile())
    fail("MANGA_RESOURCE", `Scan is not a regular file: ${name}`);
  const bytes = await boundedRead(
    path.join(state.root, name),
    mangaLimits.pageBytes,
  );
  state.total += bytes.length;
  if (state.total > mangaLimits.totalBytes)
    fail("MANGA_LIMIT", "Scan directory exceeds the byte limit");
  state.files.push({ name, bytes });
}
async function readScanDirectory(
  state: ScanDirState,
  relative: string,
  depth: number,
): Promise<void> {
  if (depth > 32) fail("MANGA_LIMIT", "Scan directories are nested too deeply");
  const entries = await fs.readdir(path.join(state.root, relative), {
    withFileTypes: true,
  });
  let chain = Promise.resolve();
  for (const entry of entries)
    chain = chain.then(() => readDirectoryEntry(state, relative, depth, entry));
  await chain;
}
async function readScanArchive(
  input: string,
  stat: Stats,
): Promise<{ files: Scan[]; archiveSha256: string }> {
  if (!stat.isFile())
    fail("MANGA_RESOURCE", "Scan archives must be regular files");
  if (!/\.(zip|cbz)$/i.test(input))
    fail("MANGA_FORMAT", "Use a scan directory or ZIP/CBZ image archive");
  const bytes = await boundedRead(input, mangaLimits.totalBytes);
  const archiveSha256 = sha256(bytes);
  const entries = unpack(bytes, {
    maxEntries: mangaLimits.entries,
    maxEntryBytes: mangaLimits.pageBytes,
    maxTotalBytes: mangaLimits.totalBytes,
  });
  if (
    entries.has("META-INF/container.xml") ||
    entries.get("mimetype")?.bytes.toString() === "application/epub+zip"
  )
    fail("MANGA_NATIVE_EPUB", "This archive is an EPUB; use the EPUB workflow");
  const files: Scan[] = [];
  for (const [name, entry] of entries) files.push({ name, bytes: entry.bytes });
  return { files, archiveSha256 };
}
function classifyScans(files: Scan[]): { pages: Scan[]; ignored: string[] } {
  const pages: Scan[] = [],
    ignored: string[] = [],
    names = new Set<string>();
  for (const file of files) {
    const folded = file.name.toLowerCase();
    if (names.has(folded))
      fail(
        "MANGA_COLLISION",
        `Duplicate/case-colliding scan path: ${file.name}`,
      );
    names.add(folded);
    if (
      /(?:^|\/)(?:\.DS_Store|ComicInfo\.xml|quillbind\.json)$/.test(
        file.name,
      ) ||
      file.name.startsWith("__MACOSX/")
    ) {
      ignored.push(file.name);
      continue;
    }
    if (!/\.(png|jpe?g|webp|tiff?|gif)$/i.test(file.name))
      fail(
        "MANGA_FORMAT",
        `Unsupported scan: ${file.name}; supported images are JPEG, PNG and static WebP/TIFF/GIF`,
      );
    pages.push(file);
  }
  if (!pages.length) fail("MANGA_EMPTY", "No scan pages found");
  return { pages, ignored };
}
function applyScanOrder(pages: Scan[], order?: string[]) {
  pages.sort((a, b) => pageCompare(a.name, b.name));
  if (!order) return;
  if (!Array.isArray(order) || order.some((name) => typeof name !== "string"))
    fail("MANGA_ORDER", "Page order must be a JSON array of scan paths");
  if (
    order.length !== pages.length ||
    new Set(order).size !== order.length ||
    order.some((name) => !pages.some((page) => page.name === name))
  )
    fail("MANGA_ORDER", "Page order must list every scan path exactly once");
  pages.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}
export async function readScans(
  input: string,
  options: { order?: string[]; signal?: AbortSignal } = {},
) {
  checkAbort(options.signal);
  if (/\.epub$/i.test(input))
    fail(
      "MANGA_NATIVE_EPUB",
      "Native EPUB must use the EPUB workflow; it is never flattened to CBZ",
    );
  const stat = await fs.lstat(input);
  if (stat.isSymbolicLink())
    fail("MANGA_SYMLINK", "Scan sources cannot be symbolic links");
  let files: Scan[];
  let archiveSha256: string | undefined;
  if (stat.isDirectory()) {
    const state: ScanDirState = {
      root: await fs.realpath(input),
      signal: options.signal,
      files: [],
      total: 0,
      count: 0,
    };
    await readScanDirectory(state, "", 0);
    files = state.files;
  } else {
    ({ files, archiveSha256 } = await readScanArchive(input, stat));
  }
  const { pages, ignored } = classifyScans(files);
  applyScanOrder(pages, options.order);
  const sourceDigest = sha256(
    stable(
      files
        .map((file) => ({ name: file.name, sha256: sha256(file.bytes) }))
        .toSorted((a, b) => compareCodeUnits(a.name, b.name)),
    ),
  );
  return {
    pages,
    ignored: ignored.toSorted((a, b) => a.localeCompare(b, "en")),
    sourceDigest,
    ...(archiveSha256 ? { archiveSha256 } : {}),
  };
}
