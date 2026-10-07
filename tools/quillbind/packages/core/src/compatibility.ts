import { inspectBytes, type EpubInspection } from "./epub.js";
import { inspectImage } from "./images.js";
import { lintCss } from "./css.js";
import { elements, attr, NS } from "./xml.js";
import { diagnostic, result } from "./errors.js";
import { APPLE, KINDLE } from "./standards.js";
import type { CompatibilityReport, Diagnostic } from "./model.js";

export async function compatibilityLint(
  input: Uint8Array | EpubInspection,
  platform: "apple-books" | "kindle",
): Promise<CompatibilityReport> {
  const info = input instanceof Uint8Array ? inspectBytes(input) : input;
  const diagnostics: Diagnostic[] = [];
  const url = platform === "apple-books" ? APPLE : KINDLE;
  const imageUrl =
    platform === "apple-books"
      ? APPLE
      : "https://kdp.amazon.com/en_US/help/topic/G75V4YX5X8GRGXWV";
  const colorUrl =
    platform === "apple-books"
      ? APPLE
      : "https://kdp.amazon.com/en_US/help/topic/G6GTK3T3NUHKLEFX";
  for (const entry of info.entries.values())
    if (entry.name.endsWith(".css"))
      diagnostics.push(
        ...lintCss(entry.bytes.toString(), entry.name, platform).diagnostics,
      );
  for (const item of info.manifest) {
    if (item.mediaType.startsWith("image/") && info.entries.has(item.path))
      try {
        const meta = await inspectImage(
          info.entries.get(item.path)!.bytes,
          item.path,
        );
        if (meta.mediaType !== item.mediaType)
          diagnostics.push(
            diagnostic(
              "IMAGE_MEDIA_TYPE",
              "Manifest media type disagrees with the original image format",
              item.path,
              imageUrl,
            ),
          );
        if (meta.space === "cmyk")
          diagnostics.push(
            diagnostic(
              "IMAGE_COLORSPACE",
              "Supply an RGB image for platform compatibility; the CMYK original was preserved without conversion",
              item.path,
              colorUrl,
            ),
          );
        else if (meta.space && !["srgb", "rgb", "rgb16"].includes(meta.space))
          diagnostics.push(
            diagnostic(
              "IMAGE_COLORSPACE_REVIEW",
              `Platform guidance recommends RGB; original ${meta.space} image was preserved`,
              item.path,
              colorUrl,
              "warning",
            ),
          );
        if (
          platform === "apple-books" &&
          (meta.width ?? 0) * (meta.height ?? 0) > 5600000
        )
          diagnostics.push(
            diagnostic(
              "APPLE_IMAGE_PIXEL_GUIDANCE",
              "Interior image exceeds Apple's 5.6 million pixel guidance; retained at original quality without a build size limit",
              item.path,
              APPLE,
              "warning",
            ),
          );
        if (platform === "apple-books" && meta.mediaType === "image/gif")
          diagnostics.push(
            diagnostic(
              "APPLE_RASTER_FORMAT_GUIDANCE",
              "Apple recommends JPEG or PNG for raster images; the original GIF was retained for review",
              item.path,
              APPLE,
              "warning",
            ),
          );
        if ((meta.pages ?? 1) > 1)
          diagnostics.push(
            diagnostic(
              "IMAGE_ANIMATION_REVIEW",
              "Multi-frame image retained; review its static fallback in the target reading app",
              item.path,
              imageUrl,
              "warning",
            ),
          );
      } catch (error) {
        diagnostics.push(
          diagnostic("IMAGE_INVALID", String(error), item.path, imageUrl),
        );
      }
    if (
      item.mediaType.startsWith("font/") &&
      !["font/ttf", "font/otf"].includes(item.mediaType)
    )
      diagnostics.push(
        diagnostic(
          "FONT_COMPATIBILITY",
          "Embedded font format requires platform verification",
          item.path,
          url,
          "warning",
        ),
      );
  }
  if (!info.manifest.some((m) => m.properties.includes("cover-image")))
    diagnostics.push(
      diagnostic(
        "COVER_MISSING",
        "No interior cover image; distribution requires cover artwork",
        info.packagePath,
        url,
        "warning",
      ),
    );
  if (
    platform === "apple-books" &&
    /^zh(?:-|$)/i.test(info.language) &&
    !/^zh-(?:Hans|Hant)(?:-|$)/i.test(info.language)
  )
    diagnostics.push(
      diagnostic(
        "APPLE_LANGUAGE_SCRIPT",
        "Specify zh-Hans or zh-Hant for Chinese; the script is not inferred from a region",
        info.packagePath,
        APPLE,
      ),
    );
  for (const el of elements(info.packageDocument, "metadata", NS.opf)
    .flatMap((m) => Array.from(m.childNodes))
    .filter((n) => n.nodeType === 1))
    if (el.textContent !== el.textContent?.trim())
      diagnostics.push(
        diagnostic(
          "METADATA_WHITESPACE",
          "Trim leading/trailing metadata whitespace",
          info.packagePath,
          url,
        ),
      );
  for (const [name, document] of info.documents) {
    const root = document.documentElement!;
    if (
      /^(ar|he|fa|ur)(-|$)/.test(attr(root, "lang")) &&
      attr(root, "dir") !== "rtl"
    )
      diagnostics.push(
        diagnostic(
          "RTL_DIRECTION",
          "RTL content requires explicit direction",
          name,
          url,
        ),
      );
    if (platform === "kindle") {
      const unsupportedMath = elements(document, "*", NS.math)
        .map((el) => el.localName)
        .filter((tag) =>
          ["maction", "mglyph", "mlongdiv", "msgroup", "mstack"].includes(
            tag ?? "",
          ),
        );
      if (unsupportedMath.length)
        diagnostics.push(
          diagnostic(
            "KINDLE_MATHML_ELEMENT",
            `Enhanced Typesetting does not support these MathML elements: ${[...new Set(unsupportedMath)].join(", ")}`,
            name,
            "https://kdp.amazon.com/en_US/help/topic/GH4DRT75GWWAGBTU",
          ),
        );
      for (const table of elements(document, "table", NS.xhtml)) {
        const tableUrl =
          "https://kdp.amazon.com/en_US/help/topic/GZ8BAXASXKB5JVML";
        if (elements(table, "table", NS.xhtml).length)
          diagnostics.push(
            diagnostic(
              "KINDLE_NESTED_TABLE",
              "Nested tables are unsupported by Enhanced Typesetting; use separate semantic tables",
              name,
              tableUrl,
            ),
          );
        if (
          elements(table, "td", NS.xhtml).length +
            elements(table, "th", NS.xhtml).length >
            1800 ||
          (table.textContent?.length ?? 0) > 20000
        )
          diagnostics.push(
            diagnostic(
              "KINDLE_TABLE_SIZE_GUIDANCE",
              "Table exceeds Enhanced Typesetting's 1,800 cells or 20,000 characters; content was retained without a build size limit",
              name,
              tableUrl,
              "warning",
            ),
          );
      }
    }
  }
  const distribution: CompatibilityReport["distribution"] = diagnostics.length
    ? "warning"
    : "compatible";
  return {
    ...result(diagnostics),
    platform,
    distribution,
    checkedAt: "2026-09-06",
    ruleVersion: "1.3.0",
  };
}
