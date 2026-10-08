import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { deflateSync } from "node:zlib";
import { mangaFixture } from "./manga-fixture.js";
import { packageManga } from "../packages/core/src/manga.js";
import {
  readScans,
  pageCompare,
  boundedRead,
} from "../packages/core/src/manga-sources.js";
import { packArchive, unpack, crc32 } from "../packages/core/src/zip.js";
import { sha256 } from "../packages/core/src/hash.js";
import { collectBookWalker } from "../packages/core/src/bookwalker.js";
import { selection, bookwalkerFetcher } from "./bookwalker-fixture.js";
import { jxlTools } from "../packages/core/src/manga-jxl.js";
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const value = await mangaFixture();
  temporary.push(value.root);
  return value;
}
it("retains the cancellation reason during codec checks", async () => {
  const controller = new AbortController(),
    reason = new Error("Caller cancelled codec check");
  controller.abort(reason);
  await expect(jxlTools(controller.signal)).rejects.toBe(reason);
});
it("reads bounded ZIP/CBZ scans with complete explicit order and rejects unsafe ZIP entries", async () => {
  const input = await fixture();
  const source = await readScans(input.scans);
  const bytes = packArchive(
    new Map(source.pages.map((page) => [page.name, page.bytes])),
    946684800,
  );
  const file = path.join(input.root, "input.zip");
  await fs.writeFile(file, bytes);
  expect(
    (await readScans(file, { order: ["10.jpg", "2.png", "1.png"] })).pages.map(
      (page) => page.name,
    ),
  ).toEqual(["10.jpg", "2.png", "1.png"]);
  for (const order of [
    ["1.png"],
    ["1.png", "1.png", "2.png"],
    ["missing", "1.png", "2.png"],
  ])
    await expect(readScans(file, { order })).rejects.toMatchObject({
      code: "MANGA_ORDER",
    });
  await expect(boundedRead(file, 1)).rejects.toMatchObject({
    code: "MANGA_LIMIT",
  });
  for (const limits of [
    { maxEntries: 1 },
    { maxEntryBytes: 1 },
    { maxTotalBytes: 1 },
  ])
    expect(() => unpack(bytes, limits)).toThrow(/limit|many/);
  const linked = Buffer.from(bytes),
    central = linked.readUInt32LE(linked.length - 6);
  linked.writeUInt32LE(0xa1ff0000, central + 38);
  expect(() => unpack(linked)).toThrow(/symlink/);
  const traversal = packArchive(
    new Map([["one.png", source.pages[0].bytes]]),
    946684800,
  );
  for (
    let at = traversal.indexOf("one.png");
    at !== -1;
    at = traversal.indexOf("one.png", at + 1)
  )
    traversal.write("../xpng", at);
  expect(() => unpack(traversal)).toThrow(/Unsafe path/);
});
it("preserves input directories and routes native EPUB away from CBZ even when renamed", async () => {
  const input = await fixture();
  await expect(
    packageManga(input.scans, {
      ...input,
      output: path.join(input.scans, "new/output.cbz"),
    }),
  ).rejects.toMatchObject({ code: "OUTPUT_IN_SOURCE" });
  expect(await fs.readdir(input.scans)).toEqual(["1.png", "10.jpg", "2.png"]);
  await expect(readScans("/missing.epub")).rejects.toMatchObject({
    code: "MANGA_NATIVE_EPUB",
  });
  const hidden = path.join(input.root, "hidden.zip");
  await fs.writeFile(
    hidden,
    packArchive(
      new Map([
        ["mimetype", Buffer.from("application/epub+zip")],
        ["META-INF/container.xml", Buffer.from("<container/>")],
      ]),
      946684800,
    ),
  );
  await expect(readScans(hidden)).rejects.toMatchObject({
    code: "MANGA_NATIVE_EPUB",
  });
  await fs.symlink(input.scans, path.join(input.root, "linked"));
  await expect(
    readScans(path.join(input.root, "linked")),
  ).rejects.toMatchObject({ code: "MANGA_SYMLINK" });
  await fs.symlink(
    path.join(input.scans, "1.png"),
    path.join(input.scans, "linked.png"),
  );
  await expect(readScans(input.scans)).rejects.toMatchObject({
    code: "MANGA_SYMLINK",
  });
});
it("rejects ambiguous inputs, unrelated metadata, cancellation and unavailable codecs", async () => {
  const input = await fixture();
  await fs.copyFile(
    path.join(input.scans, "1.png"),
    path.join(input.scans, "ONE.png"),
  );
  // ZIP detects collisions independently of the host filesystem's case sensitivity.
  expect(() =>
    packArchive(
      new Map([
        ["one.png", Buffer.from("a")],
        ["ONE.png", Buffer.from("b")],
      ]),
      946684800,
    ),
  ).toThrow(/one.png/i);
  await fs.writeFile(path.join(input.scans, "readme.txt"), "Unknown payload");
  await expect(readScans(input.scans)).rejects.toMatchObject({
    code: "MANGA_FORMAT",
  });
  const controller = new AbortController();
  controller.abort(new Error("Cancelled"));
  await expect(
    packageManga(input.scans, { ...input, signal: controller.signal }),
  ).rejects.toThrow("Cancelled");
  vi.stubEnv("QUILLBIND_CJXL", path.join(input.root, "missing-tool"));
  await expect(jxlTools()).rejects.toMatchObject({ code: "ENVIRONMENT_ERROR" });
  await fs.writeFile(
    input.bookwalker,
    JSON.stringify(
      await collectBookWalker(selection, {
        online: true,
        fetcher: bookwalkerFetcher,
      }),
    ),
  );
  await expect(packageManga(input.scans, input)).rejects.toMatchObject({
    code: "MANGA_METADATA",
  });
  await expect(
    packageManga(input.scans, {
      ...input,
      output: path.join(input.root, "book.zip"),
    }),
  ).rejects.toMatchObject({ code: "MANGA_OUTPUT" });
  expect(
    ["10.jpg", "02.jpg", "2.jpg", "a2.jpg", "a10.jpg"].sort(pageCompare),
  ).toEqual(["02.jpg", "2.jpg", "10.jpg", "a2.jpg", "a10.jpg"]);
});

it("preserves non-quantized 16-bit samples and respects another output owner", async () => {
  const input = await fixture();
  const chunk = (name: string, bytes: Buffer) => {
    const part = Buffer.alloc(bytes.length + 12);
    part.writeUInt32BE(bytes.length);
    part.write(name, 4);
    bytes.copy(part, 8);
    part.writeUInt32BE(crc32(part.subarray(4, -4)), part.length - 4);
    return part;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(1, 4);
  header[8] = 16;
  header[9] = 2;
  const values = [123, 456, 789, 65432, 12345, 1],
    pixels = Buffer.alloc(13);
  values.forEach((value, index) => pixels.writeUInt16BE(value, 1 + index * 2));
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  await fs.writeFile(path.join(input.scans, "3.png"), png);
  const lockfile = input.output + ".manga.lock";
  await fs.writeFile(lockfile, "owned");
  await expect(packageManga(input.scans, input)).rejects.toMatchObject({
    code: "MANGA_BUSY",
  });
  expect(await fs.readFile(lockfile, "utf8")).toBe("owned");
  await fs.unlink(lockfile);
  const result = await packageManga(input.scans, input);
  const expected = Buffer.alloc(16);
  [123, 456, 789, 65535, 65432, 12345, 1, 65535].forEach((value, index) =>
    expected.writeUInt16LE(value, index * 2),
  );
  expect(
    result.pages.find((page) => page.source === "3.png")?.decodedSamples,
  ).toMatchObject({ depth: "ushort", sha256: sha256(expected) });
});
it("verifies static WebP adaptation and refuses fake encoder output instead of publishing it", async () => {
  const input = await fixture();
  await sharp(path.join(input.scans, "1.png"))
    .webp({ lossless: true, effort: 6 })
    .toFile(path.join(input.scans, "3.webp"));
  const result = await packageManga(input.scans, input);
  expect(
    result.pages.find((page) => page.source === "3.webp")?.adaptation,
  ).toBe("verified lossless PNG intermediate");
  const fake = path.join(input.root, "fake-cjxl");
  await fs.writeFile(
    fake,
    `#!${process.execPath}\nconst fs=require('node:fs'); if(process.argv.includes('--version')) console.log('cjxl v0.12.0'); else fs.writeFileSync(process.argv[3], 'not jxl');\n`,
    { mode: 0o700 },
  );
  vi.stubEnv("QUILLBIND_CJXL", fake);
  const output = path.join(input.root, "failed.cbz");
  await expect(
    packageManga(input.scans, { ...input, output }),
  ).rejects.toMatchObject({ code: "MANGA_ENCODER" });
  await expect(fs.lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("never overwrites an existing report directory or follows its symlink into sources", async () => {
  const input = await fixture();
  const reports = input.output + ".reports";
  await fs.symlink(input.scans, reports);
  await expect(packageManga(input.scans, input)).rejects.toMatchObject({
    code: "MANGA_REPORT_EXISTS",
  });
  expect(await fs.readdir(input.scans)).toEqual(["1.png", "10.jpg", "2.png"]);
  expect((await fs.lstat(reports)).isSymbolicLink()).toBe(true);
  await expect(fs.lstat(input.output)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await fs.unlink(reports);
  await fs.mkdir(reports);
  await fs.writeFile(path.join(reports, "report.json"), "prior report");
  await expect(packageManga(input.scans, input)).rejects.toMatchObject({
    code: "MANGA_REPORT_EXISTS",
  });
  expect(await fs.readFile(path.join(reports, "report.json"), "utf8")).toBe(
    "prior report",
  );
});

it.each(["source", "output"] as const)(
  "blocks publication when another writer changes the %s during encoding",
  async (target) => {
    const input = await fixture();
    const wrapper = path.join(input.root, "concurrent-cjxl");
    const source = path.join(input.scans, "1.png");
    const mutation =
      target === "source"
        ? `fs.appendFileSync(${JSON.stringify(source)}, 'changed');`
        : `if(!fs.existsSync(${JSON.stringify(input.output)})) fs.writeFileSync(${JSON.stringify(input.output)}, 'another writer');`;
    await fs.writeFile(
      wrapper,
      `#!${process.execPath}\nconst fs=require('node:fs'); if(!process.argv.includes('--version')) { ${mutation} } const r=require('node:child_process').spawnSync('cjxl',process.argv.slice(2),{stdio:'inherit'}); process.exit(r.status ?? 1);\n`,
      { mode: 0o700 },
    );
    vi.stubEnv("QUILLBIND_CJXL", wrapper);
    await expect(packageManga(input.scans, input)).rejects.toMatchObject({
      code: target === "source" ? "MANGA_SOURCE_CHANGED" : "EEXIST",
    });
    if (target === "source")
      await expect(fs.lstat(input.output)).rejects.toMatchObject({
        code: "ENOENT",
      });
    else expect(await fs.readFile(input.output, "utf8")).toBe("another writer");
    await expect(fs.lstat(input.output + ".manga.lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
