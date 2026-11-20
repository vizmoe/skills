import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { run } from "./process.js";
import { checkAbort, fail } from "./errors.js";
import { sha256 } from "./hash.js";
import { stable } from "./json.js";
import { boundedRead, mangaLimits, type Scan } from "./manga-sources.js";

async function checkJxlTool(
  name: string,
  binary: string,
  signal?: AbortSignal,
): Promise<[string, string]> {
  const result = await run(binary, ["--version"], {
    signal,
    timeout: 10000,
  }).catch((error: unknown) => {
    checkAbort(signal);
    return fail(
      "ENVIRONMENT_ERROR",
      `Install libjxl cjxl and djxl for manga packaging: ${String(error)}`,
    );
  });
  const version = /v(\d+)\.(\d+)\.(\d+)/.exec(result.stdout + result.stderr);
  if (
    result.exitCode !== 0 ||
    !version ||
    (Number(version[1]) === 0 && Number(version[2]) < 7)
  )
    fail(
      "ENVIRONMENT_ERROR",
      `Unsupported ${name}; libjxl 0.7 or newer is required`,
    );
  return [name, version[0]];
}

export async function jxlTools(signal?: AbortSignal) {
  const cjxl = process.env.QUILLBIND_CJXL || "cjxl",
    djxl = process.env.QUILLBIND_DJXL || "djxl";
  const entries = await Promise.all([
    checkJxlTool("cjxl", cjxl, signal),
    checkJxlTool("djxl", djxl, signal),
  ]);
  return { cjxl, djxl, versions: Object.fromEntries(entries) };
}
type Codec = Awaited<ReturnType<typeof jxlTools>>;
const image = (bytes: Buffer) =>
  sharp(bytes, {
    failOn: "warning",
    limitInputPixels: mangaLimits.pixels,
    animated: true,
    // Compare stored samples; automatic ICC conversion can change RGB16 values.
    // Profiles are preserved by adaptation and checked separately below.
    ignoreIcc: true,
  });
async function inspect(bytes: Buffer) {
  const metadata = await image(bytes).metadata();
  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1)
    fail(
      "MANGA_IMAGE",
      "Scan pages must be complete single-frame images; split multi-page/animated sources explicitly",
    );
  if (
    !["jpeg", "png", "webp", "tiff", "gif"].includes(metadata.format ?? "") ||
    !["uchar", "ushort"].includes(metadata.depth)
  )
    fail("MANGA_IMAGE", "Unsupported scan sample format");
  return metadata;
}
async function samples(
  bytes: Buffer,
  space: string,
  depth: "uchar" | "ushort",
) {
  const decoded = await image(bytes)
    .toColourspace(space)
    .ensureAlpha()
    .raw({ depth })
    .toBuffer({ resolveWithObject: true });
  return {
    width: decoded.info.width,
    height: decoded.info.height,
    channels: decoded.info.channels,
    depth,
    sha256: sha256(decoded.data),
  };
}
async function verifyPixels(original: Buffer, decoded: Buffer) {
  const before = await inspect(original),
    after = await inspect(decoded);
  const depth = before.depth === "ushort" ? "ushort" : "uchar";
  const [a, b] = await Promise.all([
    samples(original, before.space, depth),
    samples(decoded, before.space, depth),
  ]);
  if (
    stable(a) !== stable(b) ||
    before.width !== after.width ||
    before.height !== after.height ||
    (before.bitsPerSample ?? (depth === "ushort" ? 16 : 8)) >
      (after.bitsPerSample ?? (after.depth === "ushort" ? 16 : 8))
  )
    fail(
      "MANGA_INTEGRITY",
      "Lossless conversion changed page samples, dimensions or bit depth",
    );
  for (const field of ["icc", "exif", "xmp"] as const)
    if (before[field] && !before[field].equals(after[field] ?? Buffer.alloc(0)))
      fail("MANGA_INTEGRITY", `Lossless conversion changed ${field} metadata`);
  if ((before.orientation ?? 1) !== (after.orientation ?? 1))
    fail("MANGA_INTEGRITY", "Lossless conversion changed image orientation");
  return a;
}
const JXL_CONTAINER_SIGNATURE = Buffer.from([
  0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20, 13, 10, 0x87, 10,
]);

function isJxlBytes(bytes: Buffer): boolean {
  return (
    (bytes[0] === 0xff && bytes[1] === 0x0a) ||
    bytes.subarray(0, 12).equals(JXL_CONTAINER_SIGNATURE)
  );
}

async function prepareEncodeInput(
  scan: Scan,
  metadata: Awaited<ReturnType<typeof inspect>>,
) {
  const adapted = !["jpeg", "png"].includes(metadata.format!);
  if (!adapted) return { input: scan.bytes, adapted: false };
  const input = await image(scan.bytes)
    .toColourspace(metadata.space)
    .keepMetadata()
    .png()
    .toBuffer();
  await verifyPixels(scan.bytes, input);
  return { input, adapted: true };
}

async function verifyReconstructedScan(
  scan: Scan,
  jpeg: boolean,
  reconstructed: Buffer,
) {
  if (jpeg) {
    if (!scan.bytes.equals(reconstructed))
      fail(
        "MANGA_INTEGRITY",
        "JPEG reconstruction is not byte-identical to the scan",
      );
    return undefined;
  }
  return verifyPixels(scan.bytes, reconstructed);
}

export async function encodePage(
  scan: Scan,
  directory: string,
  codec: Codec,
  signal?: AbortSignal,
) {
  checkAbort(signal);
  const metadata = await inspect(scan.bytes);
  const jpeg = metadata.format === "jpeg";
  const { input, adapted } = await prepareEncodeInput(scan, metadata);
  const source = path.join(directory, jpeg ? "input.jpg" : "input.png"),
    output = path.join(directory, "page.jxl"),
    decoded = path.join(directory, jpeg ? "reconstructed.jpg" : "decoded.png");
  await fs.writeFile(source, input, { flag: "wx" });
  const args = [
    source,
    output,
    "-d",
    "0",
    "-e",
    "7",
    "--num_threads=1",
    "--container=1",
    ...(jpeg ? ["--lossless_jpeg=1"] : []),
  ];
  const encoding = await run(codec.cjxl, args, {
    signal,
    timeout: 180000,
    limit: 1024 * 1024,
  });
  if (encoding.exitCode !== 0)
    fail("MANGA_ENCODER", `cjxl failed for ${scan.name}: ${encoding.stderr}`);
  const bytes = await boundedRead(output, mangaLimits.pageBytes);
  if (!isJxlBytes(bytes))
    fail("MANGA_ENCODER", "Encoder output is not JPEG XL");
  const decoding = await run(codec.djxl, [output, decoded, "--num_threads=1"], {
    signal,
    timeout: 180000,
    limit: 1024 * 1024,
  });
  if (decoding.exitCode !== 0)
    fail("MANGA_DECODER", `djxl failed for ${scan.name}: ${decoding.stderr}`);
  const reconstructed = await boundedRead(decoded, mangaLimits.pageBytes);
  const decodedSamples = await verifyReconstructedScan(
    scan,
    jpeg,
    reconstructed,
  );
  return {
    bytes,
    evidence: {
      source: scan.name,
      sourceSha256: sha256(scan.bytes),
      outputSha256: sha256(bytes),
      inputBytes: scan.bytes.length,
      size: bytes.length,
      width: metadata.width!,
      height: metadata.height!,
      sourceFormat: metadata.format,
      verification: jpeg
        ? ("jpeg-byte-reconstruction" as const)
        : ("decoded-samples-and-metadata" as const),
      ...(decodedSamples ? { decodedSamples } : {}),
      ...(adapted ? { adaptation: "verified lossless PNG intermediate" } : {}),
    },
  };
}
