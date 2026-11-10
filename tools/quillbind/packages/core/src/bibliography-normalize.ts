import { plainText } from "./plain-text.js";

export type ContributorRole =
  "aut" | "trl" | "ill" | "edt" | "ant" | "art" | "pht";
export interface Contributor {
  name: string;
  role: ContributorRole;
}
export interface ParsedContributors {
  contributors: Contributor[];
  /** Text removed while cleaning: nationality/era prefixes, "et al." markers and placeholders. */
  removed: string[];
}

const space = (value: string) =>
  value
    .normalize("NFC")
    .replace(/[\u00a0\u3000\u2002-\u200b]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const fold = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
const han = /\p{Script=Han}/u;
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Multi-character markers are unambiguous; weak single characters also end ordinary names. */
const strongMarkers: [string, ContributorRole][] = [
  ["编著", "aut"],
  ["編著", "aut"],
  ["著者", "aut"],
  ["作者", "aut"],
  ["撰文", "aut"],
  ["原著", "ant"],
  ["原作", "ant"],
  ["翻译", "trl"],
  ["翻譯", "trl"],
  ["翻訳", "trl"],
  ["译者", "trl"],
  ["譯者", "trl"],
  ["訳者", "trl"],
  ["插画", "ill"],
  ["插畫", "ill"],
  ["插图", "ill"],
  ["插圖", "ill"],
  ["绘图", "ill"],
  ["繪圖", "ill"],
  ["绘者", "ill"],
  ["繪者", "ill"],
  ["イラスト", "ill"],
  ["挿絵", "ill"],
  ["主编", "edt"],
  ["主編", "edt"],
  ["编者", "edt"],
  ["編者", "edt"],
  ["编选", "edt"],
  ["編選", "edt"],
  ["編集", "edt"],
  ["摄影", "pht"],
  ["攝影", "pht"],
  ["写真", "pht"],
  ["漫画", "art"],
  ["漫畫", "art"],
  ["作画", "art"],
  ["著", "aut"],
  ["译", "trl"],
  ["譯", "trl"],
  ["訳", "trl"],
  ["绘", "ill"],
  ["繪", "ill"],
  ["编", "edt"],
  ["編", "edt"],
];
const weakMarkers: [string, ContributorRole][] = [
  ["作", "aut"],
  ["撰", "aut"],
  ["文", "aut"],
  ["画", "ill"],
  ["畫", "ill"],
  ["图", "ill"],
  ["圖", "ill"],
];
const englishRoles: [RegExp, ContributorRole][] = [
  [/^(?:author|writer|written by|by)$/i, "aut"],
  [/^(?:translator|translated by|trans\.?)$/i, "trl"],
  [/^(?:illustrator|illustrated by|illustrations? by)$/i, "ill"],
  [/^(?:editor|edited by|ed\.)$/i, "edt"],
  [/^(?:photographer|photographs by|photography by)$/i, "pht"],
];
const markerRole = (value: string): ContributorRole | undefined => {
  const key = space(value);
  return (
    [...strongMarkers, ...weakMarkers].find(
      ([marker]) => marker === key,
    )?.[1] ?? englishRoles.find(([pattern]) => pattern.test(key))?.[1]
  );
};
const placeholders = new Set(
  [
    "unknown",
    "unknown author",
    "unknownauthor",
    "未知",
    "未知作者",
    "不详",
    "不詳",
    "n/a",
    "na",
    "none",
    "null",
    "undefined",
    "作者",
    "author",
  ].map(fold),
);
export const isPlaceholder = (value: string) =>
  !fold(value) || placeholders.has(fold(value));

const prefix =
  /^[[［【〔(（]\s*([\p{Script=Han}]{1,4})\s*[\]］】〕)）]\s*(?=\S)/u;
/** Agent nouns such as 作者 are labels, and can end pen names; they are not credit suffixes. */
const labelOnly = new Set(["作者", "著者"]);
const strongSuffix = new RegExp(
  `^(.+?)\\s*(?:等\\s*)?(${strongMarkers
    .filter(([marker]) => !labelOnly.has(marker))
    .map(([marker]) => escape(marker))
    .join("|")})$`,
  "u",
);
const weakSuffix = new RegExp(
  `^(.+?)(?:\\s+等)?\\s+(${weakMarkers.map(([marker]) => escape(marker)).join("|")})$`,
  "u",
);
const bracketSuffix =
  /^(.+?)\s*[(（[［]\s*([^()（）[\]［］]{1,20})\s*[)）\]］]$/u;
const labelPrefix =
  /^([\p{Script=Han}\p{Script=Katakana}A-Za-z ]{1,16}?)\s*[:：]\s*(.+)$/u;
const englishPrefix =
  /^(written by|translated by|illustrated by|illustrations by|edited by|photographs by|by)\s+(.+)$/i;

interface Token {
  name: string;
  role?: ContributorRole;
  /** A role introduced as a leading label applies to later unmarked names. */
  leading?: boolean;
}
function token(raw: string, removed: string[]): Token {
  let value = space(raw).replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "");
  let role: ContributorRole | undefined;
  let leading = false;
  const label = [labelPrefix.exec(value), englishPrefix.exec(value)].find(
    (match) => match && markerRole(match[1]),
  );
  if (label) {
    role = markerRole(label[1]);
    leading = true;
    value = space(label[2]);
  }
  for (let changed = true; changed;) {
    changed = false;
    const match = prefix.exec(value);
    if (match) {
      removed.push(match[0].trim());
      value = value.slice(match[0].length);
      changed = true;
    }
  }
  if (isPlaceholder(value)) return { name: value, role, leading };
  if (!role) {
    const bracket = bracketSuffix.exec(value);
    if (bracket && markerRole(bracket[2])) {
      role = markerRole(bracket[2]);
      value = space(bracket[1]);
    }
  }
  if (!role && cjk.test(value)) {
    const match = strongSuffix.exec(value) ?? weakSuffix.exec(value);
    if (match && [...match[1].replace(/\s/g, "")].length >= 2) {
      role = markerRole(match[2]);
      value = space(match[1]);
    }
  }
  const etAl = /^(.+?)\s*(?:等|et al\.?)$/iu.exec(value);
  if (etAl) {
    removed.push(value.slice(etAl[1].length).trim());
    value = space(etAl[1]);
  }
  return { name: value.replace(/[,，、;；:：]+$/u, "").trim(), role, leading };
}
function nameParts(segment: string) {
  if (cjk.test(segment)) return segment.split(/\s*(?:[、，,&＆]|\band\b)\s*/u);
  const loose = segment.split(/\s*(?:&|\band\b)\s*/i);
  return loose.flatMap((part) => {
    const commas = part.split(/\s*,\s*/);
    return commas.every((item) => /\s|[(（]/.test(item.trim()))
      ? commas
      : [part];
  });
}

/** Split a credit string into people and MARC relator roles. */
export function parseContributors(
  value: string,
  defaultRole: ContributorRole = "aut",
): ParsedContributors {
  const removed: string[] = [];
  const contributors: Contributor[] = [];
  const add = (name: string, role: ContributorRole) => {
    if (isPlaceholder(name)) {
      if (name) removed.push(name);
      return;
    }
    if (!contributors.some((item) => item.name === name && item.role === role))
      contributors.push({ name, role });
  };
  for (const segment of space(value).split(/\s*(?:[;；|｜/／\n]|\s-\s)\s*/u)) {
    let pending: string[] = [];
    let current: ContributorRole | undefined;
    for (const part of nameParts(segment)) {
      if (!part.trim()) continue;
      const item = token(part, removed);
      if (item.leading) {
        for (const name of pending) add(name, current ?? defaultRole);
        pending = [];
        current = item.role;
        if (item.name) pending.push(item.name);
        continue;
      }
      if (item.role) {
        for (const name of [...pending, item.name]) add(name, item.role);
        pending = [];
        current = undefined;
      } else pending.push(item.name);
    }
    for (const name of pending) add(name, current ?? defaultRole);
  }
  return { contributors, removed };
}

const marketingWord =
  /^(?:预售|預售|预购|預購|预订|預訂|现货|現貨|正版|正品|新书|新書|新品|全新|官方|特价|特價|热销|熱銷|畅销|暢銷|电子书|電子書|電子書籍|平装|平裝|精装|精裝|kindle|e-?book)$/i;
const marketingPhrase =
  /(包邮|包郵|签名|簽名|限量|赠品|贈品|附赠|附贈|赠送|贈送|促销|促銷|(?:chinese|japanese|english|kindle) edition)/i;
const marketing = (value: string) =>
  marketingWord.test(value.trim()) || marketingPhrase.test(value);
const storeSuffix =
  /(博客來|博客来|amazon|亚马逊|亞馬遜|当当|噹噹|京东|京東|豆瓣|douban|三民網路書店|誠品|诚品|金石堂|读墨|讀墨|honto|楽天|紀伊國屋|goodreads|google books|网上书店|網路書店|網路書城|官网|官網|官方网站|官方網站|online store|bookstore|book store)/i;
const separator = /\s+[|｜–—-]\s+|\s*[|｜]\s*|\s*_\s*/u;
export interface CleanedTitle {
  value: string;
  removed: string[];
}

/** Remove storefront and marketing residue while keeping real title and subtitle text. */
export function cleanTitle(
  value: string,
  options: { suffixes?: string[] } = {},
): CleanedTitle {
  const removed: string[] = [];
  let title = space(value);
  const suffixes = (options.suffixes ?? [])
    .map(fold)
    .filter((item) => [...item].length >= 2);
  for (let changed = true; changed;) {
    changed = false;
    const parts = title.split(separator);
    if (parts.length > 1) {
      const last = parts.at(-1)!;
      const key = fold(last);
      if (
        key &&
        (storeSuffix.test(last) ||
          suffixes.some(
            (item) =>
              key === item || ([...item].length >= 4 && key.includes(item)),
          ))
      ) {
        const index = title.lastIndexOf(last);
        removed.push(last);
        title = title
          .slice(0, index)
          .replace(/(?:\s+[|｜–—-]\s*|\s*[|｜_]\s*)$/u, "")
          .trim();
        changed = true;
        continue;
      }
    }
    const bracket =
      /^[【[［(（〔]([^】\]］)）〕]{1,24})[】\]］)）〕]\s*|\s*[【[［(（〔]([^】\]］)）〕]{1,24})[】\]］)）〕]$/u.exec(
        title,
      );
    const inside = bracket ? (bracket[1] ?? bracket[2]) : "";
    if (
      bracket &&
      (marketing(inside) || (bracket.index > 0 && storeSuffix.test(inside)))
    ) {
      removed.push(bracket[0].trim());
      title = (
        bracket.index === 0
          ? title.slice(bracket[0].length)
          : title.slice(0, bracket.index)
      ).trim();
      changed = true;
      continue;
    }
    const format = /\s*(?:kindle版|電子書籍版?|电子书版|電子書版)$/iu.exec(
      title,
    );
    if (format && format.index > 0) {
      removed.push(format[0].trim());
      title = title.slice(0, format.index).trim();
      changed = true;
    }
  }
  const quoted = /^《([^《》]+)》$/u.exec(title);
  if (quoted) {
    removed.push("《》");
    title = quoted[1].trim();
  }
  return { value: title, removed };
}

const uiResidue =
  /^[(（[［]?\s*(展开全部|展開全部|收起|收合|显示全部|顯示全部|查看全部|查看更多|看更多|更多|閱讀更多|阅读更多|read more|show more|see more|show less|more|続きを読む|もっと見る|すべて表示)\s*[)）\]］]?[\s.…»>›]*$/iu;
const sectionHeading =
  /^(内容简介|內容簡介|内容介绍|內容介紹|内容提要|內容提要|简介|簡介|图书简介|圖書簡介|作品简介|作品簡介|本书简介|本書簡介|作品紹介|内容紹介|内容説明|あらすじ|商品説明|description|book description|about this book|about the book|summary|synopsis|overview)[\s:：·•.]*$/iu;
const watermark =
  /(https?:\/\/|www\.|\b[\w-]+\.(?:com|net|org|cn|cc|me|top|xyz)\b|(?:本书|本書|电子书|電子書)由.{0,20}(?:整理|制作|製作|提供)|整理制作|整理製作|校对制作|校對製作|下载|下載|公众号|公眾號|微信号|微信號|关注微信|關注微信|qq群|ｑｑ群|更多好书|更多好書|更多电子书|更多電子書|电子书搜索|電子書搜索|z-?library|anna'?s archive|仅供学习|僅供學習|学习交流|學習交流|版权归|版權歸|支持正版|購買正版|购买正版)/i;
export interface CleanedDescription {
  value: string;
  removed: string[];
}
/** A short line that advertises a file source, download site or redistribution channel. */
export const isWatermark = (value: string) =>
  [...value].length <= 120 && watermark.test(value);
export const isHeading = (value: string) =>
  sectionHeading.test(space(value).replace(/[·•]\s*/g, ""));

/** Synopsis text only: markup, reader UI words, section labels and file watermarks are removed. */
export function cleanDescription(
  value: string,
  options: { watermarks?: boolean } = {},
): CleanedDescription {
  const removed: string[] = [];
  let text = plainText(value);
  if (/<\/?(?:p|br|div|span|em|strong|b|i)\b[^>]*>/i.test(text))
    text = plainText(text);
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const [index, raw] of lines.entries()) {
    let line = raw;
    const inline =
      /\s*[(（[［]?\s*(?:展开全部|展開全部|显示全部|顯示全部|read more|show more)\s*[)）\]］]?\s*$/iu.exec(
        line,
      );
    if (inline && inline.index > 0) {
      removed.push(inline[0].trim());
      line = line.slice(0, inline.index);
    }
    if (line && uiResidue.test(line)) {
      removed.push(line);
      continue;
    }
    if (index === 0 && line && isHeading(line)) {
      removed.push(line);
      continue;
    }
    if (options.watermarks !== false && line && isWatermark(line)) {
      removed.push(line);
      continue;
    }
    kept.push(line);
  }
  return {
    value: kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    removed,
  };
}

const isbn10 = (digits: string) =>
  /^\d{9}[\dX]$/.test(digits) &&
  [...digits].reduce(
    (sum, d, i) => sum + (d === "X" ? 10 : Number(d)) * (10 - i),
    0,
  ) %
    11 ===
    0;
const isbn13 = (digits: string) =>
  /^97[89]\d{10}$/.test(digits) &&
  [...digits].reduce((sum, d, i) => sum + Number(d) * (i % 2 ? 3 : 1), 0) %
    10 ===
    0;

/** Validate ISBN-10 or ISBN-13 syntax and checksum; return normalized ISBN-13 digits. */
export function normalizeIsbn(value: string): string | undefined {
  const digits = value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/^\s*(?:URN:)?ISBN(?:-1[03])?[:：]?\s*/, "")
    .replace(/[\s‐-―-]/g, "");
  if (isbn13(digits)) return digits;
  if (!isbn10(digits)) return undefined;
  const body = "978" + digits.slice(0, 9);
  const check =
    (10 -
      ([...body].reduce((sum, d, i) => sum + Number(d) * (i % 2 ? 3 : 1), 0) %
        10)) %
    10;
  return body + check;
}
/** ISBN-like tokens in free text, split into valid normalized values and rejected originals. */
export function findIsbns(value: string) {
  const valid: string[] = [];
  const invalid: string[] = [];
  const text = value.normalize("NFKC");
  for (const match of text.matchAll(
    /(?<![\dXx])(?:97[89][\s‐-]?)?(?:\d[\s‐-]?){9}[\dXx](?![\dXx])/g,
  )) {
    const raw = match[0].trim();
    const digits = raw.replace(/[\s‐-]/g, "");
    if (digits.length !== 10 && digits.length !== 13) continue;
    const isbn = normalizeIsbn(raw);
    if (isbn) {
      if (!valid.includes(isbn)) valid.push(isbn);
    } else if (!invalid.includes(raw)) invalid.push(raw);
  }
  return { valid, invalid };
}

const months: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
function datePart(
  year: string,
  month?: string | number,
  day?: string | number,
) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1000 || y > 2999) return undefined;
  if (month === undefined) return year;
  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 12) return undefined;
  const ym = `${year}-${String(m).padStart(2, "0")}`;
  if (day === undefined) return ym;
  const iso = `${ym}-${String(Number(day)).padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === iso
    ? iso
    : undefined;
}

/** A publication date as YYYY, YYYY-MM or YYYY-MM-DD, keeping the precision the source states. */
export function normalizeDate(value: string): string | undefined {
  const text = space(value.normalize("NFKC"))
    .replace(
      /\s*(?:出版|発売|發行|发行|発行|初版|刊行|上市|published|released)\s*$/iu,
      "",
    )
    .replace(/^(?:published|released|出版|発売)\s*[:：]?\s*/iu, "");
  let match =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      text,
    );
  if (match) return datePart(match[1], match[2], match[3]);
  match = /^(\d{4})\s*[/.年]\s*(\d{1,2})\s*[/.月]\s*(\d{1,2})\s*日?$/.exec(
    text,
  );
  if (match) return datePart(match[1], match[2], match[3]);
  match = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?$/.exec(text);
  if (match) return datePart(match[1], match[2]);
  match = /^(\d{4})\s*年?$/.exec(text);
  if (match) return datePart(match[1]);
  match =
    /^(?:(\d{1,2})\s+)?([A-Za-z]{3,9})\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})$/.exec(
      text,
    );
  if (match) {
    const month =
      months[match[2].toLowerCase().slice(0, 4)] ??
      months[match[2].toLowerCase().slice(0, 3)];
    if (!month || (match[1] && match[3])) return undefined;
    return datePart(match[4], month, match[1] ?? match[3]);
  }
  return undefined;
}

const digits: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
/** Chinese numerals up to 999. */
export function chineseNumber(value: string): number | undefined {
  if (!/^[〇零一二两兩三四五六七八九十百]+$/u.test(value)) return undefined;
  let total = 0;
  let current = 0;
  for (const char of value) {
    if (char === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else if (char === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else current = current * 10 + digits[char];
  }
  return total + current;
}
/** Series position as Arabic digits, independent of the numeral form printed in the title. */
export function seriesPosition(value: string): string | undefined {
  const text = space(value.normalize("NFKC"));
  const arabic =
    /^(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:卷|巻|册|冊|集|部|辑|輯|篇)?$/u.exec(
      text,
    ) ?? /^(?:vol(?:ume)?\.?|book|no\.?|#)\s*(\d+(?:\.\d+)?)$/i.exec(text);
  if (arabic) return String(Number(arabic[1]));
  const chinese =
    /^(?:第)?([〇零一二两兩三四五六七八九十百]+)(?:卷|巻|册|冊|集|部|辑|輯|篇)$/u.exec(
      text,
    ) ?? /^(?:卷|巻)([〇零一二两兩三四五六七八九十百]+)$/u.exec(text);
  const number = chinese ? chineseNumber(chinese[1]) : undefined;
  return number ? String(number) : undefined;
}

const languageNames: [RegExp, string][] = [
  [
    /^(简体中文|簡體中文|中文简体|中文（简体）|中文\(简体\)|简体|簡體|simplified chinese)$/iu,
    "zh-Hans",
  ],
  [
    /^(繁體中文|繁体中文|中文繁體|中文（繁體）|中文\(繁體\)|繁體|繁体|traditional chinese)$/iu,
    "zh-Hant",
  ],
  [/^(中文|汉语|漢語|chinese)$/iu, "zh"],
  [/^(日文|日语|日語|日本語|japanese)$/iu, "ja"],
  [/^(英文|英语|英語|english)$/iu, "en"],
  [/^(韩文|韓文|韩语|韓語|韓国語|korean)$/iu, "ko"],
];
/** BCP 47 uses the ISO 639-1 code when one exists. */
const shortLanguage: Record<string, string> = {
  zho: "zh",
  chi: "zh",
  jpn: "ja",
  eng: "en",
  kor: "ko",
  fra: "fr",
  fre: "fr",
  deu: "de",
  ger: "de",
  spa: "es",
  rus: "ru",
};
/** A BCP 47 tag from a tag or a common language name; unknown names stay unresolved. */
export function normalizeLanguage(value: string): string | undefined {
  const text = space(value);
  const named = languageNames.find(([pattern]) => pattern.test(text));
  if (named) return named[1];
  if (!/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(text)) return undefined;
  const [primary, ...rest] = text.replace(/_/g, "-").split("-");
  if (["und", "mul", "zxx"].includes(primary.toLowerCase())) return undefined;
  return [
    shortLanguage[primary.toLowerCase()] ?? primary.toLowerCase(),
    ...rest.map((part) =>
      part.length === 4
        ? part[0].toUpperCase() + part.slice(1).toLowerCase()
        : part.length === 2
          ? part.toUpperCase()
          : part.toLowerCase(),
    ),
  ].join("-");
}

/** Whitespace-normalized single-line value with a leading field label removed. */
export function cleanText(value: string, label?: RegExp): string {
  let text = space(value);
  if (label) text = text.replace(label, "").trim();
  return isPlaceholder(text) ? "" : text;
}
export const comparable = fold;
export const containsHan = (value: string) => han.test(value);
