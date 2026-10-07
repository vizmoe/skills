import sharp from "sharp";
import { fail } from "./errors.js";
import { sha256 } from "./hash.js";
import { passiveSvg } from "./xml.js";
import { optimizePng } from "./png.js";

/** Inspect original bytes without decoding to pixels or invoking an encoder. */
export async function inspectImage(bytes: Buffer, source: string) {
  const raster =
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (bytes[0] === 0xff && bytes[1] === 0xd8) ||
    /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6));
  if (!raster) {
    const text = bytes.toString("utf8");
    if (!/^\s*</u.test(text))
      fail(
        "IMAGE_TYPE",
        `${source}: supply JPEG, PNG, GIF or passive SVG; images are never converted automatically`,
      );
    passiveSvg(text, source);
    return { mediaType: "image/svg+xml", extension: "svg" };
  }
  try {
    const meta = await sharp(bytes, {
      limitInputPixels: false,
      failOn: "warning",
    }).metadata();
    if (!meta.width || !meta.height)
      fail("IMAGE_DIMENSIONS", `${source}: image dimensions are missing`);
    const formats: Record<string, [string, string]> = {
      jpeg: ["image/jpeg", "jpg"],
      png: ["image/png", "png"],
      gif: ["image/gif", "gif"],
    };
    const format = formats[meta.format ?? ""];
    if (!format) fail("IMAGE_TYPE", `${source}: unsupported raster format`);
    return {
      mediaType: format[0],
      extension: format[1],
      width: meta.width,
      height: meta.pageHeight ?? meta.height,
      space: meta.space,
      pages: meta.pages ?? 1,
    };
  } catch (error) {
    fail("IMAGE_INVALID", `${source}: ${String(error)}`);
  }
}

export async function prepareImage(
  bytes: Buffer,
  source: string,
  optimize: boolean,
) {
  const metadata = await inspectImage(bytes, source);
  const processed =
    optimize && metadata.mediaType === "image/png"
      ? optimizePng(bytes)
      : {
          bytes,
          action: "preserved" as const,
          reason: optimize
            ? "Original image format retained without re-encoding"
            : "Image optimization disabled",
        };
  return {
    ...metadata,
    bytes: processed.bytes,
    processing: {
      action: processed.action,
      reason: processed.reason,
      inputBytes: bytes.length,
      outputBytes: processed.bytes.length,
      sourceSha256: sha256(bytes),
      outputSha256: sha256(processed.bytes),
      verification:
        processed.action === "png-lossless"
          ? ("exact-scanlines-and-metadata" as const)
          : ("original-bytes" as const),
    },
  };
}
