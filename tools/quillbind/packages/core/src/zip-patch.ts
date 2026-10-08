import { deflateRawSync } from "node:zlib";
import { crc32, unpack } from "./zip.js";
import { fail } from "./errors.js";

export const maintenanceLimits = {
  maxEntries: 50000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

/** Replace existing members without reordering or recompressing other records. */
export function patchZip(input: Buffer, replacements: Map<string, Buffer>) {
  const entries = unpack(input, maintenanceLimits);
  for (const name of replacements.keys())
    if (!entries.has(name)) fail("PATCH_MEMBER", `Missing member: ${name}`);
  let end = input.length - 22;
  while (
    end >= 0 &&
    !(
      input.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + input.readUInt16LE(end + 20) === input.length
    )
  )
    end--;
  const directoryOffset = input.readUInt32LE(end + 16);
  let cursor = directoryOffset;
  const records: { name: string; offset: number; directory: Buffer }[] = [];
  for (let i = 0; i < input.readUInt16LE(end + 10); i++) {
    const length =
      46 +
      input.readUInt16LE(cursor + 28) +
      input.readUInt16LE(cursor + 30) +
      input.readUInt16LE(cursor + 32);
    const directory = Buffer.from(input.subarray(cursor, cursor + length));
    records.push({
      name: directory.subarray(46, 46 + directory.readUInt16LE(28)).toString(),
      offset: directory.readUInt32LE(42),
      directory,
    });
    cursor += length;
  }
  const physical = [...records].sort((a, b) => a.offset - b.offset);
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const [index, record] of physical.entries()) {
    const limit = physical[index + 1]?.offset ?? directoryOffset;
    const replacement = replacements.get(record.name);
    record.directory.writeUInt32LE(offset, 42);
    let data = input.subarray(record.offset, limit);
    if (replacement) {
      const start = record.offset;
      const header = Buffer.from(
        input.subarray(
          start,
          start +
            30 +
            input.readUInt16LE(start + 26) +
            input.readUInt16LE(start + 28),
        ),
      );
      const payload =
        header.readUInt16LE(8) === 8
          ? deflateRawSync(replacement, { level: 9 })
          : replacement;
      const flags = header.readUInt16LE(6) & ~8;
      header.writeUInt16LE(flags, 6);
      record.directory.writeUInt16LE(flags, 8);
      for (const [local, central, value] of [
        [14, 16, crc32(replacement)],
        [18, 20, payload.length],
        [22, 24, replacement.length],
      ]) {
        header.writeUInt32LE(value, local);
        record.directory.writeUInt32LE(value, central);
      }
      data = Buffer.concat([header, payload]);
    }
    chunks.push(data);
    offset += data.length;
    if (offset >= 0xffffffff)
      fail("ZIP64_UNSUPPORTED", "Patched archive exceeds ZIP limits");
  }
  const directory = Buffer.concat(records.map((record) => record.directory));
  const ending = Buffer.from(input.subarray(end));
  ending.writeUInt32LE(directory.length, 12);
  ending.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...chunks, directory, ending]);
  const verified = unpack(result, maintenanceLimits);
  for (const [name, entry] of entries) {
    const after = verified.get(name);
    if (
      !after ||
      !after.bytes.equals(replacements.get(name) ?? entry.bytes) ||
      after.method !== entry.method
    )
      fail("PATCH_READBACK", `Archive preservation failed: ${name}`);
  }
  return result;
}
