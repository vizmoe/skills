import path from "node:path";
import { escapeXml as e, NS } from "./xml.js";

export const relative = (from: string, to: string) =>
  path.posix.relative(path.posix.dirname(from), to);

export function shell(
  title: string,
  lang: string,
  body: string,
  links: string[],
  attrs = "",
  metadata = "",
) {
  const stylesheets = links
    .map((link) => `<link rel="stylesheet" type="text/css" href="${e(link)}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="${NS.xhtml}" xmlns:epub="${NS.epub}" lang="${e(lang)}" xml:lang="${e(lang)}"${attrs}><head><title>${e(title)}</title>${metadata}${stylesheets}</head><body>${body}</body></html>\n`;
}
