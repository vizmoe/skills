import path from "node:path";
import type { EpubInspection } from "./epub.js";
import { attr, elements, NS } from "./xml.js";
import { localTarget } from "./paths.js";
import { standaloneReadingImages } from "./repair-images.js";

export const readingImageClass = "quillbind-reading-image";
export const readingCss = `/* Quillbind personal reading: contain blocks and images without changing source image bytes. */
html, body, div, section, article, figure, p, blockquote, ol, ul, table, pre {
  max-width: 100%;
  box-sizing: border-box;
}
body, h1, h2, h3, h4, h5, h6, p, li, a {
  overflow-wrap: anywhere;
  word-wrap: break-word;
}
img.${readingImageClass} {
  max-width: 100%;
  height: auto;
}
`;
export const readingCssPath = (info: EpubInspection) =>
  path.posix.join(
    path.posix.dirname(info.packagePath),
    "quillbind-reading.css",
  );
export function readingReflowNeeded(info: EpubInspection) {
  const cssPath = readingCssPath(info);
  if (!info.entries.get(cssPath)?.bytes.equals(Buffer.from(readingCss)))
    return true;
  if (
    !info.manifest.some(
      (item) => item.path === cssPath && item.mediaType === "text/css",
    )
  )
    return true;
  return [...info.documents].some(([name, doc]) => {
    const linked = elements(doc, "link", NS.xhtml).some((el) => {
      try {
        return (
          attr(el, "rel") === "stylesheet" &&
          localTarget(name, attr(el, "href")).path === cssPath
        );
      } catch {
        return false;
      }
    });
    return (
      !linked ||
      standaloneReadingImages(doc).some(
        (el) => !attr(el, "class").split(/\s+/).includes(readingImageClass),
      )
    );
  });
}
