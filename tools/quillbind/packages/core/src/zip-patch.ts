import { deflateRawSync } from "node:zlib";
import { crc32, packArchive, unpack } from "./zip.js";
import { fail } from "./errors.js";

export const maintenanceLimits = {
  maxEntries: 50000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

interface CentralRecord {
  name: string;
  offset: number;
  directory: Buffer;
}

function validatePatchTargets(
  entries: Map<string, { bytes: Buffer; method: number }>,
  replacements: Map<string, Buffer>,
  additions: Map<string, Buffer>,
) {
  for (const name of replacements.keys()) {
    if (!entries.has(name)) fail("PATCH_MEMBER", `Missing member: ${name}`);
  }
  const names = new Set([...entries.keys()].map((name) => name.toLowerCase()));
  for (const name of additions.keys()) {
    if (names.has(name.toLowerCase()))
      fail("PATCH_COLLISION", `Member collision: ${name}`);
    names.add(name.toLowerCase());
  }
  if (names.size >= 0xffff)
    fail("ZIP64_UNSUPPORTED", "Too many archive members");
}

function findEocdOffset(input: Buffer): number {
  let end = input.length - 22;
  while (
    end >= 0 &&
    !(
      input.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + input.readUInt16LE(end + 20) === input.length
    )
  )
    end--;
  return end;
}

function readCentralDirectoryRecords(
  buffer: Buffer,
  startOffset: number,
  count: number,
): CentralRecord[] {
  let cursor = startOffset;
  const records: CentralRecord[] = [];
  for (let i = 0; i < count; i++) {
    const length =
      46 +
      buffer.readUInt16LE(cursor + 28) +
      buffer.readUInt16LE(cursor + 30) +
      buffer.readUInt16LE(cursor + 32);
    const directory = Buffer.from(buffer.subarray(cursor, cursor + length));
    records.push({
      name: directory.subarray(46, 46 + directory.readUInt16LE(28)).toString(),
      offset: directory.readUInt32LE(42),
      directory,
    });
    cursor += length;
  }
  return records;
}

function buildReplacedRecord(
  input: Buffer,
  record: CentralRecord,
  replacement: Buffer,
): Buffer {
  const start = record.offset;
  const headerLen =
    30 + input.readUInt16LE(start + 26) + input.readUInt16LE(start + 28);
  const header = Buffer.from(input.subarray(start, start + headerLen));
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
  return Buffer.concat([header, payload]);
}

function appendAddedEntries(
  additions: Map<string, Buffer>,
  records: CentralRecord[],
  chunks: Buffer[],
  startOffset: number,
): number {
  const added = packArchive(additions, 946684800);
  const addedEnd = added.length - 22;
  const addedOffset = added.readUInt32LE(addedEnd + 16);
  const addedRecords = readCentralDirectoryRecords(
    added,
    addedOffset,
    additions.size,
  );
  for (const record of addedRecords) {
    record.offset = startOffset + record.offset;
    record.directory.writeUInt32LE(record.offset, 42);
    records.push(record);
  }
  chunks.push(added.subarray(0, addedOffset));
  const nextOffset = startOffset + addedOffset;
  if (nextOffset >= 0xffffffff)
    fail("ZIP64_UNSUPPORTED", "Patched archive exceeds ZIP limits");
  return nextOffset;
}

function verifyPatchedZip(
  result: Buffer,
  entries: Map<string, { bytes: Buffer; method: number }>,
  replacements: Map<string, Buffer>,
  additions: Map<string, Buffer>,
) {
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
  for (const [name, bytes] of additions) {
    if (!verified.get(name)?.bytes.equals(bytes))
      fail("PATCH_READBACK", `Added member readback failed: ${name}`);
  }
}

/** Replace or append members without reordering or recompressing other records. */
export function patchZip(
  input: Buffer,
  replacements: Map<string, Buffer>,
  additions = new Map<string, Buffer>(),
) {
  const entries = unpack(input, maintenanceLimits);
  validatePatchTargets(entries, replacements, additions);
  const end = findEocdOffset(input);
  const directoryOffset = input.readUInt32LE(end + 16);
  const records = readCentralDirectoryRecords(
    input,
    directoryOffset,
    input.readUInt16LE(end + 10),
  );
  const physical = [...records].sort((a, b) => a.offset - b.offset);
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const [index, record] of physical.entries()) {
    const limit = physical[index + 1]?.offset ?? directoryOffset;
    const replacement = replacements.get(record.name);
    record.directory.writeUInt32LE(offset, 42);
    const data = replacement
      ? buildReplacedRecord(input, record, replacement)
      : input.subarray(record.offset, limit);
    chunks.push(data);
    offset += data.length;
    if (offset >= 0xffffffff)
      fail("ZIP64_UNSUPPORTED", "Patched archive exceeds ZIP limits");
  }
  if (additions.size)
    offset = appendAddedEntries(additions, records, chunks, offset);
  const directory = Buffer.concat(records.map((record) => record.directory));
  const ending = Buffer.from(input.subarray(end));
  ending.writeUInt32LE(directory.length, 12);
  ending.writeUInt32LE(offset, 16);
  ending.writeUInt16LE(records.length, 8);
  ending.writeUInt16LE(records.length, 10);
  const result = Buffer.concat([...chunks, directory, ending]);
  verifyPatchedZip(result, entries, replacements, additions);
  return result;
}
