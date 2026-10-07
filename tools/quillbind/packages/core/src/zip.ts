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
  const names = [
    "mimetype",
    ...[...entries.keys()].filter((n) => n !== "mimetype").sort(),
  ];
  if (!entries.has("mimetype")) fail("OCF_MIMETYPE", "Missing mimetype");
  if (names.length >= 0xffff)
    fail("ZIP64_UNSUPPORTED", "ZIP64 output is not supported");
  const date = new Date(epoch * 1000);
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  const dosDate =
    ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const dosTime =
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    (date.getUTCSeconds() >> 1);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const used = new Set<string>();
  for (const name of names) {
    safeName(name);
    const folded = name.toLowerCase();
    if (used.has(folded)) fail("ZIP_COLLISION", name);
    used.add(folded);
    const value = entries.get(name)!;
    const data = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const compressed =
      name === "mimetype"
        ? data
        : deflateRawSync(data, { level: compressionPolicy.level });
    const method =
      name !== "mimetype" && compressed.length < data.length ? 8 : 0;
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
export function unpack(
  input: Uint8Array,
  options: { strictOcf?: boolean } = {},
): Map<string, ZipEntry> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const u16 = (at: number) => {
    if (at < 0 || at + 2 > bytes.length) fail("ZIP_TRUNCATED", "Truncated ZIP");
    return bytes.readUInt16LE(at);
  };
  const u32 = (at: number) => {
    if (at < 0 || at + 4 > bytes.length) fail("ZIP_TRUNCATED", "Truncated ZIP");
    return bytes.readUInt32LE(at);
  };
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) {
      end = i;
      break;
    }
  if (end < 0) fail("ZIP_END", "ZIP end record missing");
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10))
    fail("ZIP_MULTIDISK", "Multi-disk ZIP is unsupported");
  const count = u16(end + 10),
    cdSize = u32(end + 12),
    cdOffset = u32(end + 16);
  if (count === 65535 || cdOffset === 0xffffffff || cdSize === 0xffffffff)
    fail("ZIP64_UNSUPPORTED", "ZIP64 input is not supported");
  if (cdOffset + cdSize !== end)
    fail("ZIP_DIRECTORY", "Inconsistent central directory");
  let cursor = cdOffset;
  const entries = new Map<string, ZipEntry>(),
    used = new Set<string>();
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(cursor) !== 0x02014b50)
      fail("ZIP_DIRECTORY", "Invalid central directory entry");
    const flags = u16(cursor + 8),
      method = u16(cursor + 10),
      crc = u32(cursor + 16),
      compressed = u32(cursor + 20),
      size = u32(cursor + 24),
      nameSize = u16(cursor + 28),
      extraSize = u16(cursor + 30),
      commentSize = u16(cursor + 32),
      offset = u32(cursor + 42);
    if (flags & 1 || flags & 0x40)
      fail("UNSUPPORTED_ENCRYPTION", "Encrypted ZIP entry");
    if (method !== 0 && method !== 8)
      fail("ZIP_COMPRESSION", "Unsupported compression method");
    if ([size, compressed, offset].includes(0xffffffff))
      fail("ZIP64_UNSUPPORTED", "ZIP64 input is not supported");
    if (cursor + 46 + nameSize + extraSize + commentSize > end)
      fail("ZIP_DIRECTORY", "Central directory entry exceeds its bounds");
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    const name = rawName.toString("utf8");
    if (!Buffer.from(name).equals(rawName))
      fail("ZIP_ENCODING", "Invalid UTF-8 filename");
    const isDirectory = name.endsWith("/");
    safeName(isDirectory ? name.slice(0, -1) : name);
    if (used.has(name.toLowerCase()))
      fail("ZIP_COLLISION", `Duplicate/case-colliding ZIP entry: ${name}`);
    used.add(name.toLowerCase());
    if (((u32(cursor + 38) >>> 16) & 0xf000) === 0xa000)
      fail("ZIP_SYMLINK", "ZIP symlinks are not accepted");
    if (
      u32(offset) !== 0x04034b50 ||
      u16(offset + 6) !== flags ||
      u16(offset + 8) !== method
    )
      fail("ZIP_HEADER", "Local and central headers disagree");
    const localNameSize = u16(offset + 26),
      localExtraSize = u16(offset + 28);
    const start = offset + 30 + localNameSize + localExtraSize;
    if (
      localNameSize !== nameSize ||
      !bytes
        .subarray(offset + 30, offset + 30 + localNameSize)
        .equals(rawName) ||
      start + compressed > cdOffset
    )
      fail("ZIP_HEADER", "Invalid local filename or data bounds");
    if (
      !(flags & 8) &&
      (u32(offset + 14) !== crc ||
        u32(offset + 18) !== compressed ||
        u32(offset + 22) !== size)
    )
      fail("ZIP_HEADER", "Local sizes/CRC disagree");
    let dataEnd = start + compressed;
    if (flags & 8) {
      let descriptor = dataEnd;
      if (u32(descriptor) === 0x08074b50) descriptor += 4;
      if (
        u32(descriptor) !== crc ||
        u32(descriptor + 4) !== compressed ||
        u32(descriptor + 8) !== size
      )
        fail("ZIP_DESCRIPTOR", "Invalid ZIP data descriptor");
      dataEnd = descriptor + 12;
    }
    if (dataEnd > cdOffset) fail("ZIP_HEADER", "Entry overlaps directory");
    ranges.push({ start: offset, end: dataEnd });
    let data: Buffer;
    try {
      data =
        method === 0
          ? bytes.subarray(start, start + compressed)
          : inflateRawSync(bytes.subarray(start, start + compressed), {
              maxOutputLength: Math.max(size, 1),
            });
    } catch {
      fail("ZIP_DEFLATE", `Invalid compressed data: ${name}`);
    }
    if (data.length !== size || crc32(data) !== crc)
      fail("ZIP_CRC", `CRC/size mismatch: ${name}`);
    if (!isDirectory)
      entries.set(name, {
        name,
        bytes: data,
        method,
        offset,
        extra: bytes.subarray(offset + 30 + localNameSize, start),
      });
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== end) fail("ZIP_DIRECTORY", "Directory length mismatch");
  ranges.sort((a, b) => a.start - b.start);
  let last = 0;
  for (const range of ranges) {
    if (range.start !== last)
      fail("ZIP_OVERLAP", "Gaps, prepended data or overlapping ZIP entries");
    last = range.end;
  }
  if (last !== cdOffset)
    fail("ZIP_HEADER", "Unexpected bytes before central directory");
  if (options.strictOcf) validateOcf(entries);
  return entries;
}

export function validateOcf(entries: ReadonlyMap<string, ZipEntry>) {
  const mime = entries.get("mimetype");
  if (
    !mime ||
    mime.offset !== 0 ||
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
