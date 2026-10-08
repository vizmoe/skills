import sharp from "sharp";
import { sha256 } from "./hash.js";
import { fail } from "./errors.js";
import { mangaLimits } from "./manga-sources.js";

export async function coverImage(bytes: Buffer) {
  if (bytes.length > mangaLimits.pageBytes)
    fail("COVER_IMAGE", "Cover exceeds the image size limit");
  const image = sharp(bytes, {
    failOn: "warning",
    limitInputPixels: mangaLimits.pixels,
    animated: true,
  });
  const info = await image.metadata();
  if (
    !info.width ||
    !info.height ||
    !["jpeg", "png"].includes(info.format ?? "") ||
    (info.pages ?? 1) !== 1
  )
    fail(
      "COVER_IMAGE",
      "Use a complete, single-frame original JPEG or PNG cover",
    );
  await image.stats(); // Decode the complete source, not only its header.
  const rotated = [5, 6, 7, 8].includes(info.orientation ?? 1);
  return {
    sha256: sha256(bytes),
    mediaType: info.format === "jpeg" ? "image/jpeg" : "image/png",
    extension: info.format === "jpeg" ? ".jpg" : ".png",
    width: rotated ? info.height : info.width,
    height: rotated ? info.width : info.height,
    storedWidth: info.width,
    storedHeight: info.height,
    orientation: info.orientation ?? 1,
    bytes: bytes.length,
  };
}
export type CoverImage = Awaited<ReturnType<typeof coverImage>>;
