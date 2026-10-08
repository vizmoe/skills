import { load } from "cheerio";
import { fail } from "./errors.js";
import {
  bookWalkerAddress,
  bookWalkerDate,
  editionSchema,
  type BookWalkerEdition,
} from "./bookwalker-model.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) =>
  typeof value === "string" || typeof value === "number"
    ? String(value).trim().normalize("NFC")
    : "";
const plain = (value: unknown) => {
  const $ = load(string(value), undefined, false);
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
};
const volume = (title: string): string | null => {
  const match =
    /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(?:巻|冊|册|集|\))?(?:\s*【[^】]*】)?$/.exec(
      title.normalize("NFKC"),
    );
  return match ? String(Number(match[1])) : null;
};
const roles: Record<string, BookWalkerEdition["contributors"][number]["role"]> =
  {
    author: "aut",
    original_author: "ant",
    screenwriter: "adp",
    manga_artist: "art",
    illustrator: "ill",
    translator: "trl",
    著者: "aut",
    著: "aut",
    作者: "aut",
    原作: "ant",
    原著: "ant",
    漫画: "art",
    マンガ: "art",
    作画: "art",
    イラスト: "ill",
    挿絵: "ill",
    訳: "trl",
    翻訳: "trl",
    訳者: "trl",
    脚本: "adp",
  };

export function parseBookWalker(
  html: string,
  sourceUrl: string,
): BookWalkerEdition {
  const address = bookWalkerAddress(sourceUrl);
  const $ = load(html);
  const contributors: BookWalkerEdition["contributors"] = [];
  const add = (
    name: string,
    role: BookWalkerEdition["contributors"][number]["role"],
  ) => {
    if (
      name &&
      !contributors.some((item) => item.name === name && item.role === role)
    )
      contributors.push({ name, role });
  };
  let value: Record<string, unknown>;
  if (address.site === "tw") {
    let page: unknown;
    try {
      page = JSON.parse($("#app[data-page]").attr("data-page") ?? "");
    } catch {
      fail(
        "BOOKWALKER_PARSE",
        "Taiwan product data is unavailable; check access or page layout",
      );
    }
    const props = object(object(page).props),
      product = object(props.productData),
      detail = object(product.product_detail_info);
    if (string(props.product_id) !== address.id)
      fail(
        "BOOKWALKER_IDENTITY",
        "Taiwan product ID does not match the selected URL",
      );
    const crumbs = Array.isArray(props.breadcrumb)
      ? props.breadcrumb.map((item: unknown) => string(object(item).name))
      : [];
    const kind = crumbs.includes("漫畫")
      ? "manga"
      : crumbs.includes("輕小說")
        ? "light-novel"
        : undefined;
    for (const key of [
      "author",
      "original_author",
      "screenwriter",
      "manga_artist",
      "illustrator",
      "translator",
    ]) {
      const structured = product[key];
      const names =
        Array.isArray(structured) && structured.length
          ? structured.map((item: unknown) => string(object(item).name))
          : string(detail[key])
              .split(/[、，,;；\n]/)
              .map((name) => name.trim());
      for (const name of names) add(name, roles[key]);
    }
    value = {
      url: address.url,
      site: address.site,
      kind,
      title: string(product.product_name),
      series:
        string(product.product_series_name) ||
        string(detail.series) ||
        undefined,
      // product_series_num is the number of titles in the series, not this volume.
      number: volume(string(product.product_name)),
      description: plain(
        object(product.product_detail).introduction ??
          product.product_description,
      ),
      contributors,
      publisher:
        string(detail.publisher) ||
        string(object(product.publisher).text) ||
        undefined,
      printIsbn: string(detail.publisher_isbn) || undefined,
      electronicIsbn: string(detail.publisher_eisbn) || undefined,
      electronicDate: bookWalkerDate(string(detail.sell_date_start)),
    };
  } else {
    const canonical = $("link[rel=canonical]").attr("href");
    if (!canonical || bookWalkerAddress(canonical).url !== address.url)
      fail(
        "BOOKWALKER_IDENTITY",
        "Japanese canonical product URL does not match the selection",
      );
    const info = $("dl.t-c-detail-about-information__data").first();
    if (!info.length)
      fail(
        "BOOKWALKER_PARSE",
        "Japanese work information is unavailable; check access or page layout",
      );
    const fields = new Map<string, ReturnType<typeof $>>();
    info.children("dt").each((_, node) => {
      fields.set($(node).text().trim(), $(node).next("dd"));
    });
    const field = (name: string) =>
      fields.get(name)?.text().replace(/\s+/g, " ").trim();
    const creator = fields.get("著者");
    creator?.find("li a").each((_, node) => {
      const name = $(node).text().trim().normalize("NFC");
      const match = /^(.*?)\s*[(（]([^()（）]+)[)）]$/.exec(name);
      if (!match || !roles[match[2]])
        fail(
          "BOOKWALKER_ROLE",
          `Unrecognized BookWalker creator role: ${name}`,
        );
      add(match[1].trim(), roles[match[2]]);
    });
    const title = string($("meta[property='og:title']").attr("content"));
    const category = field("カテゴリ") ?? "";
    const kind =
      category === "マンガ"
        ? "manga"
        : ["ライトノベル", "新文芸"].includes(category)
          ? "light-novel"
          : undefined;
    const imprint = field("レーベル");
    let series = field("シリーズ")?.normalize("NFKC");
    const suffix = imprint ? `(${imprint.normalize("NFKC")})` : "";
    if (suffix && series?.endsWith(suffix))
      series = series.slice(0, -suffix.length).trim();
    value = {
      url: address.url,
      site: address.site,
      kind,
      title,
      series: series || undefined,
      number: volume(title),
      contributors,
      description: string($("meta[property='og:description']").attr("content")),
      publisher: field("出版社") || undefined,
      imprint: imprint || undefined,
      printDate: bookWalkerDate(field("底本発行日")),
      electronicDate: bookWalkerDate(field("配信開始日")),
    };
  }
  const parsed = editionSchema.safeParse(value);
  if (!parsed.success)
    fail(
      "BOOKWALKER_PARSE",
      "Missing or unsupported product metadata",
      parsed.error.issues,
    );
  if (!parsed.data.contributors.length)
    fail("BOOKWALKER_PARSE", "No declared book creators found");
  return parsed.data;
}
