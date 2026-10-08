import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
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
export function pageCompare(left: string, right: string): number {
  const a = left.toLowerCase().match(/\d+|\D+/g)!,
    b = right.toLowerCase().match(/\d+|\D+/g)!;
  for (let n = 0; n < Math.min(a.length, b.length); n++) {
    if (a[n] === b[n]) continue;
    if (/^\d+$/.test(a[n]) && /^\d+$/.test(b[n])) {
      const x = BigInt(a[n]),
        y = BigInt(b[n]);
      if (x !== y) return x < y ? -1 : 1;
    } else return a[n] < b[n] ? -1 : 1;
  }
  return a.length !== b.length
    ? a.length - b.length
    : left < right
      ? -1
      : left > right
        ? 1
        : 0;
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
  const files: Scan[] = [];
  let archiveSha256: string | undefined;
  if (stat.isDirectory()) {
    const root = await fs.realpath(input);
    let total = 0,
      count = 0;
    const visit = async (relative: string, depth: number) => {
      if (depth > 32)
        fail("MANGA_LIMIT", "Scan directories are nested too deeply");
      for (const entry of await fs.readdir(path.join(root, relative), {
        withFileTypes: true,
      })) {
        checkAbort(options.signal);
        if (++count > mangaLimits.entries)
          fail("MANGA_LIMIT", "Too many scan entries");
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        safeName(name);
        if (entry.isSymbolicLink())
          fail("MANGA_SYMLINK", `Symbolic link in scans: ${name}`);
        if (entry.isDirectory()) await visit(name, depth + 1);
        else {
          if (!entry.isFile())
            fail("MANGA_RESOURCE", `Scan is not a regular file: ${name}`);
          const bytes = await boundedRead(
            path.join(root, name),
            mangaLimits.pageBytes,
          );
          total += bytes.length;
          if (total > mangaLimits.totalBytes)
            fail("MANGA_LIMIT", "Scan directory exceeds the byte limit");
          files.push({ name, bytes });
        }
      }
    };
    await visit("", 0);
  } else {
    if (!stat.isFile())
      fail("MANGA_RESOURCE", "Scan archives must be regular files");
    if (!/\.(zip|cbz)$/i.test(input))
      fail("MANGA_FORMAT", "Use a scan directory or ZIP/CBZ image archive");
    const bytes = await boundedRead(input, mangaLimits.totalBytes);
    archiveSha256 = sha256(bytes);
    const entries = unpack(bytes, {
      maxEntries: mangaLimits.entries,
      maxEntryBytes: mangaLimits.pageBytes,
      maxTotalBytes: mangaLimits.totalBytes,
    });
    if (
      entries.has("META-INF/container.xml") ||
      entries.get("mimetype")?.bytes.toString() === "application/epub+zip"
    )
      fail(
        "MANGA_NATIVE_EPUB",
        "This archive is an EPUB; use the EPUB workflow",
      );
    for (const [name, entry] of entries)
      files.push({ name, bytes: entry.bytes });
  }
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
  pages.sort((a, b) => pageCompare(a.name, b.name));
  if (options.order) {
    const order = options.order;
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
  const sourceDigest = sha256(
    stable(
      files
        .map((file) => ({ name: file.name, sha256: sha256(file.bytes) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    ),
  );
  return {
    pages,
    ignored: ignored.sort(),
    sourceDigest,
    ...(archiveSha256 ? { archiveSha256 } : {}),
  };
}
