import { load, type CheerioAPI } from "cheerio";
import { fail } from "./errors.js";
import { plainText } from "./plain-text.js";
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
const plain = plainText;
const httpsCover = (raw: unknown, base: string): string | undefined => {
  const value = string(raw);
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
};
const volumeUnits = new Set(["巻", "卷", "冊", "册", "集", ")"]);

const volume = (title: string): string | null => {
  let text = title.normalize("NFKC");
  while (text.endsWith("】")) {
    const prevClose = text.lastIndexOf("】", text.length - 2);
    const open = text.indexOf("【", prevClose + 1);
    if (open === -1) break;
    text = text.slice(0, open).trimEnd();
  }
  if (text.length > 0 && volumeUnits.has(text[text.length - 1])) {
    text = text.slice(0, -1);
  }
  text = text.trimEnd();
  let start = text.length;
  while (start > 0 && /[\d.]/.test(text[start - 1])) start -= 1;
  const candidate = text.slice(start);
  return /^\d+(?:\.\d+)?$/.test(candidate) ? String(Number(candidate)) : null;
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

type BookWalkerRole = BookWalkerEdition["contributors"][number]["role"];
type AddContributor = (name: string, role: BookWalkerRole) => void;
type BookWalkerAddress = ReturnType<typeof bookWalkerAddress>;

const taiwanCreatorKeys = [
  "author",
  "original_author",
  "screenwriter",
  "manga_artist",
  "illustrator",
  "translator",
] as const;

function taiwanKind(crumbs: string[]) {
  if (crumbs.includes("漫畫")) return "manga";
  if (crumbs.includes("輕小說")) return "light-novel";
  return undefined;
}

function japanKind(category: string) {
  if (category === "マンガ") return "manga";
  if (category === "ライトノベル" || category === "新文芸")
    return "light-novel";
  return undefined;
}

function parseCreatorRole(
  name: string,
): { creator: string; role: string } | undefined {
  if (!name.endsWith(")") && !name.endsWith("）")) return undefined;
  const open = Math.max(name.lastIndexOf("("), name.lastIndexOf("（"));
  if (open === -1) return undefined;
  const role = name.slice(open + 1, -1);
  if (!role || /[()（）]/.test(role)) return undefined;
  return { creator: name.slice(0, open).trim(), role };
}

function collectTaiwanContributors(
  product: Record<string, unknown>,
  detail: Record<string, unknown>,
  add: AddContributor,
) {
  for (const key of taiwanCreatorKeys) {
    const structured = product[key];
    const names =
      Array.isArray(structured) && structured.length
        ? structured.map((item: unknown) => string(object(item).name))
        : string(detail[key])
            .split(/[、，,;；\n]/)
            .map((name) => name.trim());
    for (const name of names) add(name, roles[key]);
  }
}

function parseTaiwanBookWalker(
  $: CheerioAPI,
  address: BookWalkerAddress,
  contributors: BookWalkerEdition["contributors"],
  add: AddContributor,
): Record<string, unknown> {
  let page: unknown;
  try {
    page = JSON.parse($("#app[data-page]").attr("data-page") ?? "");
  } catch {
    fail(
      "BOOKWALKER_PARSE",
      "Taiwan product data is unavailable; check access or page layout",
    );
  }
  const props = object(object(page).props);
  const product = object(props.productData);
  const detail = object(product.product_detail_info);
  if (string(props.product_id) !== address.id)
    fail(
      "BOOKWALKER_IDENTITY",
      "Taiwan product ID does not match the selected URL",
    );
  const crumbs = Array.isArray(props.breadcrumb)
    ? props.breadcrumb.map((item: unknown) => string(object(item).name))
    : [];
  collectTaiwanContributors(product, detail, add);
  return {
    url: address.url,
    site: address.site,
    kind: taiwanKind(crumbs),
    title: string(product.product_name),
    series:
      string(product.product_series_name) || string(detail.series) || undefined,
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
    coverUrl:
      httpsCover(product.product_cover, address.url) ??
      httpsCover(product.image, address.url) ??
      httpsCover($("meta[property='og:image']").attr("content"), address.url),
  };
}

function parseJapanBookWalker(
  $: CheerioAPI,
  address: BookWalkerAddress,
  contributors: BookWalkerEdition["contributors"],
  add: AddContributor,
): Record<string, unknown> {
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
  const fields = new Map<string, ReturnType<CheerioAPI>>();
  info.children("dt").each((_, node) => {
    fields.set($(node).text().trim(), $(node).next("dd"));
  });
  const field = (name: string) =>
    fields.get(name)?.text().replace(/\s+/g, " ").trim();
  fields
    .get("著者")
    ?.find("li a")
    .each((_, node) => {
      const name = $(node).text().trim().normalize("NFC");
      const parsed = parseCreatorRole(name);
      if (!parsed || !roles[parsed.role])
        fail(
          "BOOKWALKER_ROLE",
          `Unrecognized BookWalker creator role: ${name}`,
        );
      add(parsed.creator, roles[parsed.role]);
    });
  const title = string($("meta[property='og:title']").attr("content"));
  const imprint = field("レーベル");
  let series = field("シリーズ")?.normalize("NFKC");
  const suffix = imprint ? `(${imprint.normalize("NFKC")})` : "";
  if (suffix && series?.endsWith(suffix))
    series = series.slice(0, -suffix.length).trim();
  return {
    url: address.url,
    site: address.site,
    kind: japanKind(field("カテゴリ") ?? ""),
    title,
    series: series || undefined,
    number: volume(title),
    contributors,
    description: string($("meta[property='og:description']").attr("content")),
    publisher: field("出版社") || undefined,
    imprint: imprint || undefined,
    printDate: bookWalkerDate(field("底本発行日")),
    electronicDate: bookWalkerDate(field("配信開始日")),
    coverUrl: httpsCover(
      $("meta[property='og:image']").attr("content"),
      address.url,
    ),
  };
}

export function parseBookWalker(
  html: string,
  sourceUrl: string,
): BookWalkerEdition {
  const address = bookWalkerAddress(sourceUrl);
  const $ = load(html);
  const contributors: BookWalkerEdition["contributors"] = [];
  const add: AddContributor = (name, role) => {
    if (
      name &&
      !contributors.some((item) => item.name === name && item.role === role)
    )
      contributors.push({ name, role });
  };
  const value =
    address.site === "tw"
      ? parseTaiwanBookWalker($, address, contributors, add)
      : parseJapanBookWalker($, address, contributors, add);
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
