import { load } from "cheerio";

const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number"
    ? String(value).trim().normalize("NFC")
    : "";

/** Markup to plain text that keeps paragraph, line and list-item boundaries. */
export function plainText(value: unknown): string {
  const $ = load(text(value), undefined, false);
  const hasMarkup = $("*").length > 0;
  $("script, style, template, noscript").remove();
  if (hasMarkup) {
    // Collapse source formatting before adding semantic paragraph boundaries.
    $.root()
      .find("*")
      .addBack()
      .contents()
      .each((_, node) => {
        if (node.type === "text") node.data = node.data.replace(/\s+/g, " ");
      });
    $("br").replaceWith("\n");
    $("li, tr").after("\n");
    $("p, div, section, article, blockquote, h1, h2, h3, h4, h5, h6, ul, ol")
      .before("\n\n")
      .after("\n\n");
  }
  return $.root()
    .text()
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
