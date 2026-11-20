import { deflateRawSync, inflateRawSync } from "node:zlib";
import { safeName } from "./paths.js";
import { fail } from "./errors.js";

const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export interface ZipEntry {
  name: string;
  bytes: Buffer;
  method: number;
  offset: number;
  extra: Buffer;
}
export const compressionPolicy = {
  method: "deflate",
  level: 9,
  storeWhenNotSmaller: true,
  mimetype: "stored",
  node: process.versions.node,
  zlib: process.versions.zlib,
} as const;
export function compressionReport(entries: ReadonlyMap<string, ZipEntry>) {
  return {
    ...compressionPolicy,
    storedEntries: [...entries.values()].filter((entry) => entry.method === 0)
      .length,
    deflatedEntries: [...entries.values()].filter((entry) => entry.method === 8)
      .length,
  };
}
export function pack(entries: Map<string, Uint8Array>, epoch: number): Buffer {
  return packArchive(entries, epoch, { epub: true });
}
function encodeDosTimestamp(epoch: number) {
  const date = new Date(epoch * 1000);
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return {
    dosDate:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
    dosTime:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      (date.getUTCSeconds() >> 1),
  };
}

function encodeZipMember(
  name: string,
  value: Uint8Array,
  dosTime: number,
  dosDate: number,
  offset: number,
  store: boolean,
) {
  const data = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const compressed =
    name === "mimetype" || store
      ? data
      : deflateRawSync(data, { level: compressionPolicy.level });
  const method = name !== "mimetype" && compressed.length < data.length ? 8 : 0;
  const payload = method === 8 ? compressed : data;
  const filename = Buffer.from(name);
  if (filename.length > 0xffff)
    fail("ZIP_FILENAME", "Filename cannot be represented in ZIP");
  if (data.length >= 0xffffffff || offset >= 0xffffffff)
    fail("ZIP64_UNSUPPORTED", "ZIP64 output is not supported");
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(payload.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(filename.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(0x0800, 8);
  directory.writeUInt16LE(method, 10);
  directory.writeUInt16LE(dosTime, 12);
  directory.writeUInt16LE(dosDate, 14);
  directory.writeUInt32LE(crc, 16);
  directory.writeUInt32LE(payload.length, 20);
  directory.writeUInt32LE(data.length, 24);
  directory.writeUInt16LE(filename.length, 28);
  directory.writeUInt32LE(offset, 42);
  return { header, directory, filename, payload };
}

export function packArchive(
  entries: Map<string, Uint8Array>,
  epoch: number,
  options: { epub?: boolean; store?: boolean } = {},
): Buffer {
  const names = options.epub
    ? [
        "mimetype",
        ...[...entries.keys()]
          .filter((n) => n !== "mimetype")
          .sort((a, b) => a.localeCompare(b, "en")),
      ]
    : [...entries.keys()].sort((a, b) => a.localeCompare(b, "en"));
  if (options.epub && !entries.has("mimetype"))
    fail("OCF_MIMETYPE", "Missing mimetype");
  if (names.length >= 0xffff)
    fail("ZIP64_UNSUPPORTED", "ZIP64 output is not supported");
  const { dosDate, dosTime } = encodeDosTimestamp(epoch);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const used = new Set<string>();
  for (const name of names) {
    safeName(name);
    const folded = name.toLowerCase();
    if (used.has(folded)) fail("ZIP_COLLISION", name);
    used.add(folded);
    const { header, directory, filename, payload } = encodeZipMember(
      name,
      entries.get(name)!,
      dosTime,
      dosDate,
      offset,
      !!options.store,
    );
    local.push(header, filename, payload);
    central.push(directory, filename);
    offset += header.length + filename.length + payload.length;
  }
  const cd = Buffer.concat(central);
  if (offset >= 0xffffffff || cd.length >= 0xffffffff)
    fail("ZIP64_UNSUPPORTED", "ZIP64 output is not supported");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

interface BinaryReader {
  u16: (at: number) => number;
  u32: (at: number) => number;
}

interface CentralEntryMeta {
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  nameSize: number;
  offset: number;
  rawName: Buffer;
  name: string;
  isDirectory: boolean;
  nextCursor: number;
}

function createBinaryReader(bytes: Buffer): BinaryReader {
  return {
    u16(at: number) {
      if (at < 0 || at + 2 > bytes.length)
        fail("ZIP_TRUNCATED", "Truncated ZIP");
      return bytes.readUInt16LE(at);
    },
    u32(at: number) {
      if (at < 0 || at + 4 > bytes.length)
        fail("ZIP_TRUNCATED", "Truncated ZIP");
      return bytes.readUInt32LE(at);
    },
  };
}

function locateCentralDirectory(
  bytes: Buffer,
  reader: BinaryReader,
  maxEntries: number,
) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      reader.u32(i) === 0x06054b50 &&
      i + 22 + reader.u16(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) fail("ZIP_END", "ZIP end record missing");
  if (
    reader.u16(end + 4) ||
    reader.u16(end + 6) ||
    reader.u16(end + 8) !== reader.u16(end + 10)
  )
    fail("ZIP_MULTIDISK", "Multi-disk ZIP is unsupported");
  const count = reader.u16(end + 10);
  const cdSize = reader.u32(end + 12);
  const cdOffset = reader.u32(end + 16);
  if (count > maxEntries) fail("ZIP_LIMIT", "Archive has too many entries");
  if (count === 65535 || cdOffset === 0xffffffff || cdSize === 0xffffffff)
    fail("ZIP64_UNSUPPORTED", "ZIP64 input is not supported");
  if (cdOffset + cdSize !== end)
    fail("ZIP_DIRECTORY", "Inconsistent central directory");
  return { end, count, cdOffset };
}

function readCentralEntryMeta(
  bytes: Buffer,
  reader: BinaryReader,
  cursor: number,
  end: number,
  used: Set<string>,
): CentralEntryMeta {
  if (reader.u32(cursor) !== 0x02014b50)
    fail("ZIP_DIRECTORY", "Invalid central directory entry");
  const flags = reader.u16(cursor + 8);
  const method = reader.u16(cursor + 10);
  const crc = reader.u32(cursor + 16);
  const compressed = reader.u32(cursor + 20);
  const size = reader.u32(cursor + 24);
  const nameSize = reader.u16(cursor + 28);
  const extraSize = reader.u16(cursor + 30);
  const commentSize = reader.u16(cursor + 32);
  const offset = reader.u32(cursor + 42);
  if (flags & 1 || flags & 0x40)
    fail("UNSUPPORTED_ENCRYPTION", "Encrypted ZIP entry");
  if (method !== 0 && method !== 8)
    fail("ZIP_COMPRESSION", "Unsupported compression method");
  if ([size, compressed, offset].includes(0xffffffff))
    fail("ZIP64_UNSUPPORTED", "ZIP64 input is not supported");
  const nextCursor = cursor + 46 + nameSize + extraSize + commentSize;
  if (nextCursor > end)
    fail("ZIP_DIRECTORY", "Central directory entry exceeds its bounds");
  const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
  const name = rawName.toString("utf8");
  if (!Buffer.from(name).equals(rawName))
    fail("ZIP_ENCODING", "Invalid UTF-8 filename");
  const isDirectory = name.endsWith("/");
  safeName(isDirectory ? name.slice(0, -1) : name);
  const folded = name.toLowerCase();
  if (used.has(folded))
    fail("ZIP_COLLISION", `Duplicate/case-colliding ZIP entry: ${name}`);
  used.add(folded);
  if (((reader.u32(cursor + 38) >>> 16) & 0xf000) === 0xa000)
    fail("ZIP_SYMLINK", "ZIP symlinks are not accepted");
  return {
    flags,
    method,
    crc,
    compressed,
    size,
    nameSize,
    offset,
    rawName,
    name,
    isDirectory,
    nextCursor,
  };
}

function resolveLocalDataEnd(
  reader: BinaryReader,
  meta: CentralEntryMeta,
  start: number,
  cdOffset: number,
): number {
  const { offset, flags, crc, compressed, size } = meta;
  if (
    !(flags & 8) &&
    (reader.u32(offset + 14) !== crc ||
      reader.u32(offset + 18) !== compressed ||
      reader.u32(offset + 22) !== size)
  )
    fail("ZIP_HEADER", "Local sizes/CRC disagree");
  let dataEnd = start + compressed;
  if (flags & 8) {
    let descriptor = dataEnd;
    if (reader.u32(descriptor) === 0x08074b50) descriptor += 4;
    if (
      reader.u32(descriptor) !== crc ||
      reader.u32(descriptor + 4) !== compressed ||
      reader.u32(descriptor + 8) !== size
    )
      fail("ZIP_DESCRIPTOR", "Invalid ZIP data descriptor");
    dataEnd = descriptor + 12;
  }
  if (dataEnd > cdOffset) fail("ZIP_HEADER", "Entry overlaps directory");
  return dataEnd;
}

function inflateLocalData(
  bytes: Buffer,
  meta: CentralEntryMeta,
  start: number,
): Buffer {
  const slice = bytes.subarray(start, start + meta.compressed);
  let data: Buffer;
  try {
    data =
      meta.method === 0
        ? slice
        : inflateRawSync(slice, { maxOutputLength: Math.max(meta.size, 1) });
  } catch {
    fail("ZIP_DEFLATE", `Invalid compressed data: ${meta.name}`);
  }
  if (data.length !== meta.size || crc32(data) !== meta.crc)
    fail("ZIP_CRC", `CRC/size mismatch: ${meta.name}`);
  return data;
}

function readLocalEntryPayload(
  bytes: Buffer,
  reader: BinaryReader,
  meta: CentralEntryMeta,
  cdOffset: number,
): { entry?: ZipEntry; range: { start: number; end: number } } {
  const { offset, flags, method, compressed, nameSize, rawName } = meta;
  if (
    reader.u32(offset) !== 0x04034b50 ||
    reader.u16(offset + 6) !== flags ||
    reader.u16(offset + 8) !== method
  )
    fail("ZIP_HEADER", "Local and central headers disagree");
  const localNameSize = reader.u16(offset + 26);
  const localExtraSize = reader.u16(offset + 28);
  const start = offset + 30 + localNameSize + localExtraSize;
  if (
    localNameSize !== nameSize ||
    !bytes.subarray(offset + 30, offset + 30 + localNameSize).equals(rawName) ||
    start + compressed > cdOffset
  )
    fail("ZIP_HEADER", "Invalid local filename or data bounds");
  const dataEnd = resolveLocalDataEnd(reader, meta, start, cdOffset);
  const data = inflateLocalData(bytes, meta, start);
  return {
    range: { start: offset, end: dataEnd },
    entry: meta.isDirectory
      ? undefined
      : {
          name: meta.name,
          bytes: data,
          method,
          offset,
          extra: bytes.subarray(offset + 30 + localNameSize, start),
        },
  };
}

function verifyContiguousEntryRanges(
  ranges: { start: number; end: number }[],
  cdOffset: number,
) {
  ranges.sort((a, b) => a.start - b.start);
  let last = 0;
  for (const range of ranges) {
    if (range.start !== last)
      fail("ZIP_OVERLAP", "Gaps, prepended data or overlapping ZIP entries");
    last = range.end;
  }
  if (last !== cdOffset)
    fail("ZIP_HEADER", "Unexpected bytes before central directory");
}

export function unpack(
  input: Uint8Array,
  options: {
    strictOcf?: boolean;
    maxEntries?: number;
    maxEntryBytes?: number;
    maxTotalBytes?: number;
  } = {},
): Map<string, ZipEntry> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const reader = createBinaryReader(bytes);
  const { end, count, cdOffset } = locateCentralDirectory(
    bytes,
    reader,
    options.maxEntries ?? Infinity,
  );
  let cursor = cdOffset;
  let totalBytes = 0;
  const entries = new Map<string, ZipEntry>();
  const used = new Set<string>();
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < count; i++) {
    const meta = readCentralEntryMeta(bytes, reader, cursor, end, used);
    totalBytes += meta.size;
    if (
      meta.size > (options.maxEntryBytes ?? Infinity) ||
      totalBytes > (options.maxTotalBytes ?? Infinity)
    )
      fail("ZIP_LIMIT", "Archive exceeds expanded-size limits");
    const { entry, range } = readLocalEntryPayload(
      bytes,
      reader,
      meta,
      cdOffset,
    );
    ranges.push(range);
    if (entry) entries.set(entry.name, entry);
    cursor = meta.nextCursor;
  }
  if (cursor !== end) fail("ZIP_DIRECTORY", "Directory length mismatch");
  verifyContiguousEntryRanges(ranges, cdOffset);
  if (options.strictOcf) validateOcf(entries);
  return entries;
}

export function validateOcf(entries: ReadonlyMap<string, ZipEntry>) {
  const mime = entries.get("mimetype");
  if (
    mime?.offset !== 0 ||
    mime.method !== 0 ||
    mime.extra.length ||
    mime.bytes.toString() !== "application/epub+zip"
  )
    fail(
      "OCF_MIMETYPE",
      "mimetype must be first, stored, without extra fields and exactly application/epub+zip",
    );
  if (!entries.has("META-INF/container.xml"))
    fail("OCF_CONTAINER", "Missing container.xml");
}
