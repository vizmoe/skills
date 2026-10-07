import { load, type CheerioAPI } from "cheerio";
import { fail } from "./errors.js";
import { remoteUrl } from "./novel-http.js";
import type { NovelCatalog } from "./novel-model.js";

export const cleanText = (value: string) => value.replace(/\s+/g, " ").trim();
// Escape all ASCII Markdown punctuation, including directives, math and raw HTML.
export const markdownText = (value: string) =>
  value.replace(/([!-/:-@[-`{-~])/g, "\\$1");
export function imageUrl(
  $: CheerioAPI,
  image: ReturnType<CheerioAPI>,
  base: string,
) {
  const raw =
    image.attr("data-src") ||
    image.attr("data-original") ||
    image.attr("data-lazy-src") ||
    image.attr("src");
  if (!raw || /book-cover-no|^data:/i.test(raw)) return undefined;
  return remoteUrl(raw, base).href;
}
export function plainHtml(html: string) {
  const $ = load(html);
  $("script,style,iframe,object,template,noscript").remove();
  $("br").replaceWith("\n");
  $("p,div,li").append("\n");
  return $("body").text().trim();
}
export function assertComplete(html: string) {
  const text = plainHtml(html);
  if (
    /內?容加[載载]失[敗败]|内容加载失败|請登[錄入]後[閱阅]讀|请登录后阅读|付[費费]解[鎖锁]|权限不足|權限不足/.test(
      text,
    )
  )
    fail(
      "NOVEL_CONTENT_INCOMPLETE",
      "Source returned incomplete or access-restricted chapter content; open the source page to check access",
    );
  if (!text && !load(html)("img").length)
    fail(
      "NOVEL_CONTENT_EMPTY",
      "Source chapter contains no text or illustrations",
    );
}
export function checkCatalog(catalog: NovelCatalog) {
  if (!catalog.title || !catalog.volumes.length)
    fail("NOVEL_CATALOG", "Source has no book title or volumes");
  const volumeIds = new Set<string>(),
    chapterUrls = new Set<string>();
  for (const volume of catalog.volumes) {
    if (
      !volume.title ||
      !volume.id ||
      volumeIds.has(volume.id) ||
      !volume.chapters.length
    )
      fail("NOVEL_CATALOG", "Source contains an empty or duplicate volume");
    volumeIds.add(volume.id);
    for (const chapter of volume.chapters) {
      if (!chapter.title || !chapter.id || chapterUrls.has(chapter.url))
        fail("NOVEL_CATALOG", "Source contains an empty or duplicate chapter");
      chapterUrls.add(chapter.url);
    }
  }
  return catalog;
}

/** Import prose and illustrations, never website scripts, styles, handlers or forms. */
export async function novelMarkdown(
  html: string,
  base: string,
  saveImage: (url: string, alt: string) => Promise<string>,
) {
  assertComplete(html);
  const $ = load(html);
  $(
    "script,style,iframe,object,embed,form,input,button,nav,template,noscript,ins,[hidden],[aria-hidden=true],.adsbygoogle,.advertisement,.tp,.bd",
  ).remove();
  $("[style]").each((_, node) => {
    if (
      /(?:display\s*:\s*none|visibility\s*:\s*hidden|transform\s*:\s*scale\(0\))/i.test(
        $(node).attr("style") ?? "",
      )
    )
      $(node).remove();
  });
  for (const [index, node] of $("img").toArray().entries()) {
    const image = $(node),
      url = imageUrl($, image, base);
    if (!url)
      fail(
        "NOVEL_IMAGE_MISSING",
        "A chapter illustration has no downloadable source",
      );
    const alt = cleanText(image.attr("alt") ?? "") || `插图 ${index + 1}`;
    image.attr("src", await saveImage(url, alt)).attr("alt", alt);
  }
  const walk = (nodes: ReturnType<CheerioAPI>, depth = 0): string => {
    if (depth > 100) fail("NOVEL_HTML", "Chapter HTML is nested too deeply");
    return nodes
      .toArray()
      .map((node): string => {
        if (node.type === "text")
          return markdownText(node.data.replace(/[\t\r\n ]+/g, " "));
        if (node.type !== "tag") return "";
        const element = $(node),
          tag = node.name.toLowerCase();
        if (tag === "img")
          return `\n\n![${markdownText(element.attr("alt")!)}](${element.attr("src")})\n\n`;
        if (tag === "br") return "\n\n";
        if (tag === "hr") return "\n\n---\n\n";
        const body = walk(element.contents(), depth + 1);
        if (/^h[1-6]$/.test(tag)) return `\n\n## ${body.trim()}\n\n`;
        if (
          ["p", "div", "section", "article", "figure", "figcaption"].includes(
            tag,
          )
        )
          return `\n\n${body.trim()}\n\n`;
        if (tag === "blockquote")
          return `\n\n${body
            .trim()
            .split("\n")
            .map((line) => "> " + line)
            .join("\n")}\n\n`;
        if (tag === "li") return `\n- ${body.trim().replace(/\n/g, "\n  ")}\n`;
        if (["ul", "ol"].includes(tag)) return `\n\n${body}\n\n`;
        if (["strong", "b"].includes(tag)) return `**${body}**`;
        if (["em", "i"].includes(tag)) return `*${body}*`;
        // Links remain readable text; no remote HTML or arbitrary links become executable input.
        return body;
      })
      .join("");
  };
  const markdown = walk($("body").contents())
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!markdown)
    fail(
      "NOVEL_CONTENT_EMPTY",
      "No chapter content remains after removing website controls",
    );
  return markdown + "\n";
}
