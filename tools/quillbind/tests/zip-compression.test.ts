import { expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { pack, unpack, compressionReport } from "../packages/core/src/zip.js";

it("keeps OCF mimetype first and stored, compresses text deterministically, and records both methods", () => {
  const text = Buffer.from("中文书籍 test chapter\n".repeat(100));
  const entries = new Map([
    ["chapter.xhtml", text],
    ["mimetype", Buffer.from("application/epub+zip")],
    ["tiny.bin", Buffer.from([1, 2, 3])],
  ]);
  const bytes = pack(entries, 946684800);
  expect(pack(new Map([...entries].reverse()), 946684800)).toEqual(bytes);
  const restored = unpack(bytes);
  expect(restored.get("mimetype")).toMatchObject({
    offset: 0,
    method: 0,
    extra: Buffer.alloc(0),
  });
  expect(restored.get("tiny.bin")?.method).toBe(0);
  const chapter = restored.get("chapter.xhtml")!;
  expect(chapter.method).toBe(8);
  // Decode the on-disk payload independently of Quillbind's reader.
  const start = chapter.offset + 30 + bytes.readUInt16LE(chapter.offset + 26);
  const length = bytes.readUInt32LE(chapter.offset + 18);
  expect(inflateRawSync(bytes.subarray(start, start + length))).toEqual(text);
  expect(bytes.length).toBeLessThan(text.length / 3);
  expect(compressionReport(restored)).toMatchObject({
    level: 9,
    storedEntries: 2,
    deflatedEntries: 1,
  });
});
