import { load, type CheerioAPI } from "cheerio";
import { isHeading } from "./bibliography-normalize.js";
import { plainText } from "./plain-text.js";
import type { EditionCandidate } from "./edition-model.js";

type Field = EditionCandidate["field"];
type Source = EditionCandidate["source"];
type Role = NonNullable<EditionCandidate["role"]>;
interface Target {
  field: Field;
  role?: Role;
  format?: "print" | "electronic";
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];
const scalar = (value: unknown) =>
  typeof value === "string" || typeof value === "number"
    ? String(value).normalize("NFC").trim()
    : "";
const isUrl = (value: string) => /^https?:\/\//i.test(value);
const name = (value: unknown) =>
  typeof value === "object" ? scalar(object(value).name) : scalar(value);
const typeOf = (node: Record<string, unknown>) =>
  list(node["@type"]).map((item) => scalar(item).replace(/^.*[/#]/, ""));

const labelKey = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s:：·•()（）]/g, "");
const labelTargets: [string[], Target][] = [
  [
    ["书名", "書名", "タイトル", "title", "题名", "題名", "作品名"],
    { field: "title" },
  ],
  [["副标题", "副標題", "サブタイトル", "subtitle"], { field: "subtitle" }],
  [
    [
      "原作名",
      "原书名",
      "原書名",
      "原文书名",
      "原文書名",
      "原题",
      "原題",
      "原名",
      "原文名",
      "originaltitle",
    ],
    { field: "originalTitle" },
  ],
  [
    [
      "作者",
      "著者",
      "著",
      "作者名",
      "著作者",
      "author",
      "authors",
      "authors",
      "by",
      "作者/著者",
    ],
    { field: "contributor", role: "aut" },
  ],
  [
    [
      "译者",
      "譯者",
      "訳者",
      "翻译",
      "翻譯",
      "翻訳",
      "translator",
      "translators",
    ],
    { field: "contributor", role: "trl" },
  ],
  [
    [
      "绘者",
      "繪者",
      "插画",
      "插畫",
      "绘图",
      "繪圖",
      "插图",
      "插圖",
      "イラスト",
      "illustrator",
      "illustrators",
    ],
    { field: "contributor", role: "ill" },
  ],
  [
    ["编者", "編者", "主编", "主編", "editor", "editors"],
    { field: "contributor", role: "edt" },
  ],
  [["原著", "原作"], { field: "contributor", role: "ant" }],
  [
    ["摄影", "攝影", "写真", "photographer"],
    { field: "contributor", role: "pht" },
  ],
  [
    [
      "出版社",
      "出版者",
      "出版商",
      "出版单位",
      "出版單位",
      "出版元",
      "発行元",
      "publisher",
    ],
    { field: "publisher" },
  ],
  [["品牌", "レーベル", "imprint"], { field: "imprint" }],
  [
    [
      "出版日期",
      "出版时间",
      "出版時間",
      "出版年",
      "出版年月",
      "出版年月日",
      "出版日",
      "初版日期",
      "発売日",
      "発行日",
      "発売年月日",
      "publicationdate",
      "publishdate",
      "publishingdate",
      "published",
      "releasedate",
      "pubdate",
    ],
    { field: "date" },
  ],
  [
    [
      "isbn",
      "isbn13",
      "isbn-13",
      "isbn10",
      "isbn-10",
      "国际标准书号",
      "國際標準書號",
      "书号",
      "書號",
      "printisbn",
    ],
    { field: "isbn" },
  ],
  [
    [
      "eisbn",
      "e-isbn",
      "電子書isbn",
      "电子书isbn",
      "電子isbn",
      "电子isbn",
      "ebookisbn",
      "电子版isbn",
      "電子版isbn",
    ],
    { field: "isbn", format: "electronic" },
  ],
  [
    [
      "丛书",
      "叢書",
      "丛书系列",
      "叢書系列",
      "丛书名",
      "叢書名",
      "系列",
      "シリーズ",
      "series",
      "书系",
      "書系",
    ],
    { field: "series" },
  ],
  [["卷次", "巻数", "冊次", "volume", "seriesnumber"], { field: "position" }],
  [["语言", "語言", "言語", "语种", "語種", "language"], { field: "language" }],
];
const labels = new Map(
  labelTargets.flatMap(([keys, target]) =>
    keys.map((key) => [labelKey(key), target] as const),
  ),
);
const excluded =
  "script, style, noscript, template, iframe, svg, form, nav, header, footer, aside, [hidden], [aria-hidden=true]";
/** Whole class/id tokens, optionally prefixed (`book-reviews`), that hold other books or site chrome. */
const decoy =
  /^(?:[a-z0-9]+[-_])?(recommend\w*|related(?:[-_]?(?:books?|products?|items?|titles?|works?))?|similar\w*|also[-_]?(?:bought|viewed|liked)|comments?|reviews?|ratings?|footer|header|navbar|nav|breadcrumbs?|sidebar|advert\w*|ads?|banner|carousel|ranking|hot[-_]?list|guess\w*)$/i;
const isDecoy = (value: string) =>
  value.split(/\s+/).some((token) => token && decoy.test(token));

function lines($: CheerioAPI) {
  const copy = load($.html(), undefined, false);
  copy
    .root()
    .find("*")
    .addBack()
    .contents()
    .each((_, node) => {
      if (node.type === "text") node.data = node.data.replace(/\s+/g, " ");
    });
  copy("br").replaceWith("\n");
  copy(
    "p, div, li, dt, dd, tr, h1, h2, h3, h4, h5, h6, section, article, ul, ol, dl, table, blockquote",
  )
    .before("\n")
    .after("\n");
  copy("td, th").after(" ");
  return copy
    .root()
    .text()
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Field candidates from one edition page. Each value keeps its source kind; nothing is merged here. */
export function extractEdition(html: string) {
  const $ = load(html);
  const candidates: EditionCandidate[] = [];
  const add = (
    target: Target,
    source: Source,
    raw: unknown,
    label?: string,
  ) => {
    const value =
      target.field === "description"
        ? scalar(raw)
        : scalar(raw).replace(/\s+/g, " ").trim();
    if (!value || value.length > 100000) return;
    if (target.field === "contributor" && isUrl(value)) return;
    const candidate: EditionCandidate = {
      field: target.field,
      source,
      value,
      ...(label ? { label } : {}),
      ...(target.role ? { role: target.role } : {}),
      ...(target.format ? { format: target.format } : {}),
    };
    const key = JSON.stringify(candidate);
    if (!candidates.some((item) => JSON.stringify(item) === key))
      candidates.push(candidate);
  };
  const siteName = scalar($("meta[property='og:site_name']").attr("content"));
  const canonical = scalar($("link[rel=canonical]").attr("href"));

  const books: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 6) return;
    for (const item of list(value)) {
      const node = object(item);
      if (!Object.keys(node).length) continue;
      const types = typeOf(node);
      if (
        types.some((type) =>
          ["Book", "Product", "ProductModel", "IndividualProduct"].includes(
            type,
          ),
        )
      )
        books.push(node);
      for (const key of ["@graph", "mainEntity", "workExample"])
        visit(node[key], depth + 1);
    }
  };
  $("script[type='application/ld+json']").each((_, node) => {
    try {
      visit(JSON.parse($(node).text()));
    } catch {
      // Malformed structured data is ignored; other sources still apply.
    }
  });
  for (const book of books) {
    const format = list(book.bookFormat).some((item) =>
      /EBook$/i.test(scalar(item)),
    )
      ? "electronic"
      : list(book.bookFormat).some((item) =>
            /(Hardcover|Paperback|GraphicNovel)$/i.test(scalar(item)),
          )
        ? "print"
        : undefined;
    add({ field: "title" }, "json-ld", book.name);
    add({ field: "subtitle" }, "json-ld", book.alternativeHeadline);
    for (const [key, role] of [
      ["author", "aut"],
      ["creator", "aut"],
      ["translator", "trl"],
      ["illustrator", "ill"],
      ["editor", "edt"],
    ] as const)
      for (const person of list(book[key]))
        add({ field: "contributor", role }, "json-ld", name(person));
    for (const publisher of list(book.publisher))
      add({ field: "publisher" }, "json-ld", name(publisher));
    add({ field: "date" }, "json-ld", book.datePublished);
    for (const key of ["isbn", "gtin13", "gtin", "gtin10"])
      for (const value of list(book[key]))
        add({ field: "isbn", format }, "json-ld", value, key);
    for (const value of list(book.inLanguage))
      add({ field: "language" }, "json-ld", name(value) || scalar(value));
    add({ field: "description" }, "json-ld", book.description);
    for (const part of list(book.isPartOf)) {
      add({ field: "series" }, "json-ld", name(part));
      add({ field: "position" }, "json-ld", object(part).position);
    }
    add({ field: "position" }, "json-ld", book.position ?? book.volumeNumber);
    for (const original of list(book.translationOfWork))
      add({ field: "originalTitle" }, "json-ld", name(original));
  }

  $("[itemscope][itemtype]").each((_, scope) => {
    const type = scalar($(scope).attr("itemtype")).replace(/^.*[/#]/, "");
    if (!["Book", "Product"].includes(type)) return;
    $(scope)
      .find("[itemprop]")
      .each((_, node) => {
        const owner = $(node).parent().closest("[itemscope]")[0];
        if (owner !== scope) return;
        const element = $(node);
        const value = element.is("[itemscope]")
          ? element.find("[itemprop=name]").first().text() || element.text()
          : (element.attr("content") ??
            element.attr("datetime") ??
            (element.is("meta, link") ? element.attr("href") : element.text()));
        const prop = scalar(element.attr("itemprop"));
        const targets: Record<string, Target> = {
          name: { field: "title" as const },
          author: { field: "contributor" as const, role: "aut" as const },
          translator: { field: "contributor" as const, role: "trl" as const },
          illustrator: { field: "contributor" as const, role: "ill" as const },
          editor: { field: "contributor" as const, role: "edt" as const },
          publisher: { field: "publisher" as const },
          datePublished: { field: "date" as const },
          isbn: { field: "isbn" as const },
          gtin13: { field: "isbn" as const },
          inLanguage: { field: "language" as const },
          description: { field: "description" as const },
        };
        const target = Object.hasOwn(targets, prop) ? targets[prop] : undefined;
        if (target)
          add(
            target,
            "microdata",
            target.field === "description" ? element.html() : value,
            prop,
          );
      });
  });

  $("meta[name], meta[property]").each((_, node) => {
    const key = scalar(
      $(node).attr("name") ?? $(node).attr("property"),
    ).toLowerCase();
    const value = $(node).attr("content");
    const targets: Record<string, [Target, Source]> = {
      "og:title": [{ field: "title" }, "open-graph"],
      "og:description": [{ field: "description" }, "open-graph"],
      "book:isbn": [{ field: "isbn" }, "open-graph"],
      "book:release_date": [{ field: "date" }, "open-graph"],
      "book:author": [{ field: "contributor", role: "aut" }, "open-graph"],
      citation_title: [{ field: "title" }, "meta"],
      citation_author: [{ field: "contributor", role: "aut" }, "meta"],
      citation_publisher: [{ field: "publisher" }, "meta"],
      citation_isbn: [{ field: "isbn" }, "meta"],
      citation_publication_date: [{ field: "date" }, "meta"],
      citation_date: [{ field: "date" }, "meta"],
      citation_language: [{ field: "language" }, "meta"],
      "dc.title": [{ field: "title" }, "meta"],
      "dc.creator": [{ field: "contributor", role: "aut" }, "meta"],
      "dc.publisher": [{ field: "publisher" }, "meta"],
      "dc.date": [{ field: "date" }, "meta"],
      "dc.language": [{ field: "language" }, "meta"],
      "dc.description": [{ field: "description" }, "meta"],
      "dcterms.title": [{ field: "title" }, "meta"],
      "dcterms.creator": [{ field: "contributor", role: "aut" }, "meta"],
      "dcterms.publisher": [{ field: "publisher" }, "meta"],
      "dcterms.issued": [{ field: "date" }, "meta"],
      description: [{ field: "description" }, "meta"],
    };
    const target = Object.hasOwn(targets, key) ? targets[key] : undefined;
    if (target) add(target[0], target[1], value, key);
    if (["dc.identifier", "dcterms.identifier"].includes(key))
      add({ field: "isbn" }, "meta", value, key);
  });
  add({ field: "title" }, "document-title", $("head > title").first().text());

  const body = $("body").length ? $("body").first() : $.root();
  const content = load($.html(body), undefined, false);
  content(excluded).remove();
  content("*")
    .filter((_, node) =>
      isDecoy(
        `${content(node).attr("class") ?? ""} ${content(node).attr("id") ?? ""}`,
      ),
    )
    .remove();

  const pair = (label: string, value: string) => {
    const target = labels.get(labelKey(label));
    if (target && value.trim())
      add(target, "label", value, label.trim().replace(/\s*[:：]$/u, ""));
  };
  content("dt").each((_, node) => {
    const value = content(node).nextAll("dd").first();
    if (value.length) pair(content(node).text(), value.text());
  });
  content("tr").each((_, row) => {
    const cells = content(row).children("th, td");
    if (cells.length === 2) pair(cells.eq(0).text(), cells.eq(1).text());
  });
  for (const line of lines(content)) {
    const match = /^([^:：]{1,20}?)\s*[:：]\s*(.+)$/u.exec(line);
    if (match) pair(match[1], match[2]);
  }

  content(
    "h1, h2, h3, h4, h5, h6, dt, strong, b, [class*=title], [class*=heading]",
  ).each((_, node) => {
    const heading = content(node);
    if (heading.text().length > 40 || !isHeading(heading.text())) return;
    let anchor = heading;
    let block = anchor.nextAll().first();
    for (let depth = 0; !block.length && depth < 3; depth++) {
      anchor = anchor.parent();
      if (!anchor.length || anchor.is("body")) break;
      block = anchor.nextAll().first();
    }
    if (!block.length) return;
    const full = block
      .find("[class]")
      .filter((_, item) =>
        /(?:^|\s)(all|full|complete|expand(?:ed)?)(?:\s|$)/i.test(
          content(item).attr("class") ?? "",
        ),
      )
      .toArray();
    const html = full.length
      ? full
          .map((item) => content.html(item))
          .sort((a, b) => plainText(b).length - plainText(a).length)[0]
      : content.html(block);
    add({ field: "description" }, "section", html, heading.text().trim());
  });
  return {
    candidates,
    ...(siteName ? { siteName } : {}),
    ...(canonical ? { canonicalUrl: canonical } : {}),
  };
}
