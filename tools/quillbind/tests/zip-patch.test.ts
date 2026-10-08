import { expect, it } from "vitest";
import { patchZip } from "../packages/core/src/zip-patch.js";
import { packArchive, unpack } from "../packages/core/src/zip.js";

function records(bytes: Buffer) {
  let end = bytes.length - 22;
  while (bytes.readUInt32LE(end) !== 0x06054b50) end--;
  let cursor = bytes.readUInt32LE(end + 16);
  const rows = [];
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    const size =
      46 +
      bytes.readUInt16LE(cursor + 28) +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
    rows.push({ start: cursor, size, offset: bytes.readUInt32LE(cursor + 42) });
    cursor += size;
  }
  return { end, rows };
}
function fixture(store: boolean) {
  const packed = packArchive(
    new Map([
      [
        "ComicInfo.xml",
        Buffer.from("<ComicInfo>" + "metadata".repeat(30) + "</ComicInfo>"),
      ],
      ["page.bin", Buffer.from("unchanged page".repeat(50))],
    ]),
    946684800,
    { store },
  );
  const { end, rows } = records(packed),
    sourceDirectory = packed.readUInt32LE(end + 16);
  const first = rows[0],
    nextOffset = rows[1].offset;
  const local = Buffer.from(packed.subarray(0, nextOffset));
  local.writeUInt16LE(local.readUInt16LE(6) | 8, 6);
  local.fill(0, 14, 26);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50);
  packed.copy(descriptor, 4, first.start + 16, first.start + 28);
  const d1 = Buffer.from(
    packed.subarray(first.start, first.start + first.size),
  );
  d1.writeUInt16LE(d1.readUInt16LE(8) | 8, 8);
  const second = rows[1],
    d2 = Buffer.from(packed.subarray(second.start, second.start + second.size));
  d2.writeUInt32LE(second.offset + 16, 42);
  d2.writeUInt32LE(0x81a40000, 38);
  const extra = Buffer.from([0xca, 0xfe, 0, 0]),
    comment = Buffer.from("preserved member comment");
  d2.writeUInt16LE(extra.length, 30);
  d2.writeUInt16LE(comment.length, 32);
  const central = Buffer.concat([d1, d2, extra, comment]);
  const archiveComment = Buffer.from("preserved archive comment"),
    ending = Buffer.from(packed.subarray(end));
  ending.writeUInt32LE(central.length, 12);
  ending.writeUInt32LE(sourceDirectory + 16, 16);
  ending.writeUInt16LE(archiveComment.length, 20);
  return Buffer.concat([
    local,
    descriptor,
    packed.subarray(nextOffset, sourceDirectory),
    central,
    ending,
    archiveComment,
  ]);
}

it.each([false, true])(
  "preserves physical records, central attributes, extras and comments with stored=%s",
  (store) => {
    const source = fixture(store),
      before = unpack(source),
      content = Buffer.from("<ComicInfo><Title>Corrected</Title></ComicInfo>");
    const result = patchZip(source, new Map([["ComicInfo.xml", content]])),
      after = unpack(result);
    expect(after.get("ComicInfo.xml")!.bytes).toEqual(content);
    expect(after.get("ComicInfo.xml")!.method).toBe(
      before.get("ComicInfo.xml")!.method,
    );
    expect([...after.keys()]).toEqual([...before.keys()]);
    const a = records(source),
      b = records(result);
    expect(source.subarray(a.rows[1].offset, a.rows[0].start)).toEqual(
      result.subarray(b.rows[1].offset, b.rows[0].start),
    );
    const original = Buffer.from(
        source.subarray(a.rows[1].start, a.rows[1].start + a.rows[1].size),
      ),
      changed = Buffer.from(
        result.subarray(b.rows[1].start, b.rows[1].start + b.rows[1].size),
      );
    original.fill(0, 42, 46);
    changed.fill(0, 42, 46);
    expect(changed).toEqual(original);
    expect(result.subarray(b.end + 22)).toEqual(source.subarray(a.end + 22));
    expect(patchZip(result, new Map())).toEqual(result);
    expect(() => patchZip(source, new Map([["missing.xml", content]]))).toThrow(
      /missing/i,
    );
    const corrupted = Buffer.from(source);
    corrupted[0] = 0;
    expect(() =>
      patchZip(corrupted, new Map([["ComicInfo.xml", content]])),
    ).toThrow();
  },
);
