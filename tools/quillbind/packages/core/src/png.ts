import { constants, deflateSync, inflateSync } from "node:zlib";
import { crc32 } from "./zip.js";
import { fail } from "./errors.js";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
interface Chunk {
  type: string;
  raw: Buffer;
  data: Buffer;
}
function chunks(bytes: Buffer): Chunk[] {
  if (!bytes.subarray(0, 8).equals(signature))
    fail("PNG_INVALID", "Invalid PNG signature");
  const result: Chunk[] = [];
  let at = 8;
  let idatEnded = false;
  let hasIdat = false;
  while (at + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(at);
    const end = at + size + 12;
    const type = bytes.toString("ascii", at + 4, at + 8);
    if (size > 0x7fffffff || end > bytes.length || !/^[A-Za-z]{4}$/.test(type))
      fail("PNG_INVALID", "Invalid PNG chunk bounds or name");
    if (crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
      fail("PNG_CRC", `PNG ${type} checksum mismatch`);
    if (type === "IDAT") {
      if (idatEnded) fail("PNG_INVALID", "PNG IDAT chunks must be consecutive");
      hasIdat = true;
    } else if (hasIdat) idatEnded = true;
    result.push({
      type,
      raw: bytes.subarray(at, end),
      data: bytes.subarray(at + 8, end - 4),
    });
    at = end;
    if (type === "IEND") break;
  }
  if (
    at !== bytes.length ||
    result[0]?.type !== "IHDR" ||
    result[0].data.length !== 13 ||
    result.filter((c) => c.type === "IHDR").length !== 1 ||
    result.at(-1)?.type !== "IEND" ||
    result.at(-1)!.data.length ||
    !hasIdat
  )
    fail("PNG_INVALID", "Incomplete PNG chunk structure");
  return result;
}

function filteredSize(header: Buffer) {
  const width = header.readUInt32BE(0),
    height = header.readUInt32BE(4);
  const depth = header[8],
    color = header[9];
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const depths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !width ||
    !height ||
    !depths[color]?.includes(depth) ||
    header[10] !== 0 ||
    header[11] !== 0 ||
    header[12] > 1
  )
    fail("PNG_INVALID", "Unsupported PNG image header");
  const passes =
    header[12] === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ];
  return passes.reduce((sum, [x, y, dx, dy]) => {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    const rows = Math.max(0, Math.ceil((height - y) / dy));
    return (
      sum +
      (columns && rows
        ? (Math.ceil((columns * channels[color] * depth) / 8) + 1) * rows
        : 0)
    );
  }, 0);
}

/** Only the IDAT compression stream changes; image samples and every other chunk stay exact. */
export function optimizePng(bytes: Buffer) {
  const original = chunks(bytes);
  const preserve = (reason: string) => ({
    bytes,
    action: "preserved" as const,
    reason,
  });
  if (original.some((c) => ["acTL", "fcTL", "fdAT"].includes(c.type)))
    return preserve("Animation frames and timing retained without re-encoding");
  const known = new Set([
    "IHDR",
    "PLTE",
    "IDAT",
    "IEND",
    "tRNS",
    "cHRM",
    "gAMA",
    "iCCP",
    "sBIT",
    "sRGB",
    "cICP",
    "mDCV",
    "cLLI",
    "tEXt",
    "zTXt",
    "iTXt",
    "bKGD",
    "hIST",
    "pHYs",
    "sPLT",
    "eXIf",
    "tIME",
  ]);
  if (original.some((c) => !known.has(c.type) && /[A-Z]/.test(c.type[3])))
    return preserve(
      "Unknown chunk requires original image data; retained intact",
    );
  const compressed = Buffer.concat(
    original.filter((c) => c.type === "IDAT").map((c) => c.data),
  );
  const expected = filteredSize(original[0].data);
  if (!Number.isSafeInteger(expected))
    return preserve(
      "Image dimensions exceed exact integer arithmetic; retained intact",
    );
  let filtered: Buffer;
  try {
    // This bound comes from the image's declared dimensions, not a file/pixel quota.
    const decoded = inflateSync(compressed, {
      maxOutputLength: expected,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (decoded.engine.bytesWritten !== compressed.length)
      return preserve("Extra compressed-stream data retained intact");
    filtered = decoded.buffer;
  } catch {
    fail(
      "PNG_INVALID",
      "PNG image data does not match its declared dimensions",
    );
  }
  if (filtered.length !== expected)
    fail("PNG_INVALID", "PNG scanline length mismatch");
  let best = compressed;
  for (const strategy of [
    constants.Z_DEFAULT_STRATEGY,
    constants.Z_FILTERED,
    constants.Z_RLE,
    constants.Z_HUFFMAN_ONLY,
    constants.Z_FIXED,
  ]) {
    const candidate = deflateSync(filtered, {
      level: 9,
      memLevel: 9,
      strategy,
    });
    if (candidate.length < best.length) best = candidate;
  }
  if (best === compressed)
    return preserve(
      "Original compression is at least as small as all candidates",
    );
  if (!inflateSync(best, { maxOutputLength: expected }).equals(filtered))
    fail("IMAGE_INTEGRITY", "PNG recompression changed the image data");
  const replacement: Buffer[] = [];
  // PNG chunk lengths are 31-bit; this splits output without imposing an image-size quota.
  for (let at = 0; at < best.length; at += 0x7fffffff) {
    const data = best.subarray(at, at + 0x7fffffff);
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length);
    chunk.write("IDAT", 4, "ascii");
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    replacement.push(chunk);
  }
  let inserted = false;
  const output = Buffer.concat([
    signature,
    ...original.flatMap((c) => {
      if (c.type !== "IDAT") return [c.raw];
      if (inserted) return [];
      inserted = true;
      return replacement;
    }),
  ]);
  if (output.length >= bytes.length)
    return preserve("Recompressed file is not smaller");
  const unchanged = (items: Chunk[]) =>
    Buffer.concat(items.filter((c) => c.type !== "IDAT").map((c) => c.raw));
  if (!unchanged(chunks(output)).equals(unchanged(original)))
    fail(
      "IMAGE_INTEGRITY",
      "PNG recompression changed metadata or image structure",
    );
  return {
    bytes: output,
    action: "png-lossless" as const,
    reason:
      "Level-9 deflate, smallest of five strategies; exact scanline and non-IDAT chunk verification",
  };
}
