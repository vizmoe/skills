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

function stripTrailingChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

function stripEdgeChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

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
  /^[[［【〔(（]\s*(\p{Script=Han}{1,4})\s*[\]］】〕)）]\s*(?=\S)/u;
/** Agent nouns such as 作者 are labels, and can end pen names; they are not credit suffixes. */
const labelOnly = new Set(["作者", "著者"]);
const strongSuffixMarkers = strongMarkers.filter(
  ([marker]) => !labelOnly.has(marker),
);
const englishPrefixes = [
  "written by",
  "translated by",
  "illustrated by",
  "illustrations by",
  "edited by",
  "photographs by",
  "by",
];

function parseLabelPrefix(value: string): [string, string] | undefined {
  const ascii = value.indexOf(":");
  const full = value.indexOf("：");
  let colon: number;
  if (ascii !== -1 && full !== -1) colon = Math.min(ascii, full);
  else colon = Math.max(ascii, full);
  if (colon <= 0) return undefined;
  const left = value.slice(0, colon).trimEnd();
  if (
    !left ||
    left.length > 16 ||
    !/^[\p{Script=Han}\p{Script=Katakana}A-Za-z ]+$/u.test(left)
  )
    return undefined;
  const right = value.slice(colon + 1).trimStart();
  return right ? [left, right] : undefined;
}

function parseEnglishPrefix(value: string): [string, string] | undefined {
  const lower = value.toLowerCase();
  for (const p of englishPrefixes) {
    if (
      lower.startsWith(p) &&
      value.length > p.length &&
      /\s/.test(value[p.length])
    ) {
      const rest = value.slice(p.length).trimStart();
      if (rest) return [value.slice(0, p.length), rest];
    }
  }
  return undefined;
}

function parseBracketSuffix(value: string): [string, string] | undefined {
  const closing = value.at(-1);
  if (!closing || !")）]］".includes(closing)) return undefined;
  const open = Math.max(
    value.lastIndexOf("("),
    value.lastIndexOf("（"),
    value.lastIndexOf("["),
    value.lastIndexOf("［"),
  );
  if (open <= 0) return undefined;
  const before = value.slice(0, open).trimEnd();
  const inside = value.slice(open + 1, -1).trim();
  if (
    !before ||
    !inside ||
    inside.length > 20 ||
    /[()（）[\]［］]/.test(inside)
  )
    return undefined;
  return [before, inside];
}

function matchStrongCjkSuffix(
  value: string,
): { name: string; role: ContributorRole } | undefined {
  for (const [marker, role] of strongSuffixMarkers) {
    if (!value.endsWith(marker)) continue;
    let base = value.slice(0, -marker.length).trimEnd();
    if (base.length > 1 && base.endsWith("等"))
      base = base.slice(0, -1).trimEnd();
    return base ? { name: base, role } : undefined;
  }
  return undefined;
}

function matchWeakCjkSuffix(
  value: string,
): { name: string; role: ContributorRole } | undefined {
  for (const [marker, role] of weakMarkers) {
    if (!value.endsWith(marker)) continue;
    const before = value.slice(0, -marker.length);
    const beforeLast = before.at(-1);
    if (!beforeLast || !/\s/.test(beforeLast)) continue;
    let base = before.trimEnd();
    const beforeEtAl = base.at(-2);
    if (base.endsWith("等") && beforeEtAl && /\s/.test(beforeEtAl))
      base = base.slice(0, -1).trimEnd();
    return base ? { name: base, role } : undefined;
  }
  return undefined;
}

function matchCjkRoleSuffix(
  value: string,
): { name: string; role: ContributorRole } | undefined {
  return matchStrongCjkSuffix(value) ?? matchWeakCjkSuffix(value);
}

function stripBracketPrefixes(
  input: string,
  initialRole: ContributorRole | undefined,
  initialLeading: boolean,
  removed: string[],
) {
  let value = input;
  let role = initialRole;
  let leading = initialLeading;
  for (let changed = true; changed;) {
    changed = false;
    const match = prefix.exec(value);
    if (!match) continue;
    const marked = markerRole(match[1]);
    if (marked) {
      role = role ?? marked;
      leading = true;
    } else {
      removed.push(match[0].trim());
    }
    value = value.slice(match[0].length);
    changed = true;
  }
  return { value, role, leading };
}

function stripEtAlSuffix(value: string, removed: string[]): string {
  const lower = value.toLowerCase();
  let suffixLen = 0;
  if (value.endsWith("等")) suffixLen = 1;
  else if (lower.endsWith("et al.")) suffixLen = 6;
  else if (lower.endsWith("et al")) suffixLen = 5;
  if (!suffixLen || value.length <= suffixLen) return value;
  const base = value.slice(0, -suffixLen).trimEnd();
  if (!base) return value;
  removed.push(value.slice(base.length).trim());
  return space(base);
}

interface Token {
  name: string;
  role?: ContributorRole;
  /** A role introduced as a leading label applies to later unmarked names. */
  leading?: boolean;
}
function token(raw: string, removed: string[]): Token {
  let value = stripEdgeChars(space(raw), "\"'“”‘’「」『』");
  let role: ContributorRole | undefined;
  let leading = false;
  const label = [parseLabelPrefix(value), parseEnglishPrefix(value)].find(
    (match) => match && markerRole(match[0]),
  );
  if (label) {
    role = markerRole(label[0]);
    leading = true;
    value = space(label[1]);
  }
  ({ value, role, leading } = stripBracketPrefixes(
    value,
    role,
    leading,
    removed,
  ));
  if (isPlaceholder(value)) return { name: value, role, leading };
  if (!role) {
    const bracket = parseBracketSuffix(value);
    if (bracket && markerRole(bracket[1])) {
      role = markerRole(bracket[1]);
      value = space(bracket[0]);
    }
  }
  if (!role && cjk.test(value)) {
    const match = matchCjkRoleSuffix(value);
    if (match && [...match.name.replace(/\s/g, "")].length >= 2) {
      role = match.role;
      value = space(match.name);
    }
  }
  value = stripEtAlSuffix(value, removed);
  return {
    name: stripTrailingChars(value, ",，、;；:：").trim(),
    role,
    leading,
  };
}
function nameParts(segment: string) {
  if (cjk.test(segment))
    return segment.split(/[、，,&＆]|\band\b/u).map((part) => part.trim());
  const loose = segment.split(/&|\band\b/i).map((part) => part.trim());
  return loose.flatMap((part) => {
    const commas = part.split(",").map((item) => item.trim());
    return commas.every((item) => /\s|[(（]/.test(item)) ? commas : [part];
  });
}

function splitCreditSegments(value: string): string[] {
  return space(value)
    .split(/[;；|｜/／]/u)
    .flatMap((part) => part.trim().split(" - "))
    .map((part) => part.trim());
}

interface SegmentParseState {
  pending: string[];
  current?: ContributorRole;
}

function applyCreditToken(
  item: Token,
  state: SegmentParseState,
  defaultRole: ContributorRole,
  add: (name: string, role: ContributorRole) => void,
) {
  if (item.leading) {
    for (const name of state.pending) add(name, state.current ?? defaultRole);
    state.pending = item.name ? [item.name] : [];
    state.current = item.role;
    return;
  }
  if (item.role) {
    for (const name of [...state.pending, item.name]) add(name, item.role);
    state.pending = [];
    state.current = undefined;
    return;
  }
  state.pending.push(item.name);
}

function parseCreditSegment(
  segment: string,
  defaultRole: ContributorRole,
  add: (name: string, role: ContributorRole) => void,
  removed: string[],
) {
  const state: SegmentParseState = { pending: [] };
  for (const part of nameParts(segment)) {
    if (!part.trim()) continue;
    applyCreditToken(token(part, removed), state, defaultRole, add);
  }
  for (const name of state.pending) add(name, state.current ?? defaultRole);
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
  for (const segment of splitCreditSegments(value))
    parseCreditSegment(segment, defaultRole, add, removed);
  return { contributors, removed };
}

const marketingWords = new Set([
  "预售",
  "預售",
  "预购",
  "預購",
  "预订",
  "預訂",
  "现货",
  "現貨",
  "正版",
  "正品",
  "新书",
  "新書",
  "新品",
  "全新",
  "官方",
  "特价",
  "特價",
  "热销",
  "熱銷",
  "畅销",
  "暢銷",
  "电子书",
  "電子書",
  "電子書籍",
  "平装",
  "平裝",
  "精装",
  "精裝",
  "kindle",
  "ebook",
  "e-book",
]);
const marketingPhrase =
  /(包邮|包郵|签名|簽名|限量|赠品|贈品|附赠|附贈|赠送|贈送|促销|促銷|(?:chinese|japanese|english|kindle) edition)/i;
const marketing = (value: string) =>
  marketingWords.has(value.trim().toLowerCase()) || marketingPhrase.test(value);
const storeSuffixTerms = [
  "博客來",
  "博客来",
  "amazon",
  "亚马逊",
  "亞馬遜",
  "当当",
  "噹噹",
  "京东",
  "京東",
  "豆瓣",
  "douban",
  "三民網路書店",
  "誠品",
  "诚品",
  "金石堂",
  "读墨",
  "讀墨",
  "honto",
  "楽天",
  "紀伊國屋",
  "goodreads",
  "google books",
  "网上书店",
  "網路書店",
  "網路書城",
  "官网",
  "官網",
  "官方网站",
  "官方網站",
  "online store",
  "bookstore",
  "book store",
];
const hasStoreSuffix = (value: string) => {
  const lower = value.toLowerCase();
  return storeSuffixTerms.some((term) => lower.includes(term));
};
const openBrackets = "【[［(（〔";
const closeBrackets = "】]］)）〕";
const trailingFormatSuffixes = [
  "kindle版",
  "電子書籍版",
  "電子書籍",
  "电子书版",
  "電子書版",
];

function splitTitleSegments(title: string): string[] {
  return title
    .split(/[|｜_]/u)
    .flatMap((part) => part.trim().split(/ [–—-] /u))
    .map((part) => part.trim());
}

function stripTrailingTitleSeparator(prefixText: string): string {
  const trimmed = prefixText.trimEnd();
  const last = trimmed.at(-1);
  if (!last) return trimmed;
  if (last === "|" || last === "｜" || last === "_")
    return trimmed.slice(0, -1).trimEnd();
  const prev = trimmed.at(-2);
  if ((last === "–" || last === "—" || last === "-") && prev && /\s/.test(prev))
    return trimmed.slice(0, -1).trimEnd();
  return trimmed;
}

function stripTrailingStoreSegment(
  title: string,
  suffixes: string[],
  removed: string[],
): string | undefined {
  const parts = splitTitleSegments(title);
  if (parts.length <= 1) return undefined;
  const last = parts.at(-1)!;
  const key = fold(last);
  const matches =
    Boolean(key) &&
    (hasStoreSuffix(last) ||
      suffixes.some(
        (item) => key === item || ([...item].length >= 4 && key.includes(item)),
      ));
  if (!matches) return undefined;
  const index = title.lastIndexOf(last);
  removed.push(last);
  return stripTrailingTitleSeparator(title.slice(0, index));
}

interface EdgeBracket {
  raw: string;
  inside: string;
  atStart: boolean;
  rest: string;
}

function findLeadingBracket(title: string): EdgeBracket | undefined {
  if (title.length < 3 || !openBrackets.includes(title[0])) return undefined;
  const limit = Math.min(title.length - 1, 25);
  for (let i = 1; i <= limit; i++) {
    if (!closeBrackets.includes(title[i])) continue;
    if (i === 1) return undefined;
    return {
      raw: title.slice(0, i + 1),
      inside: title.slice(1, i),
      atStart: true,
      rest: title.slice(i + 1).trim(),
    };
  }
  return undefined;
}

function findTrailingBracket(title: string): EdgeBracket | undefined {
  const closing = title.at(-1);
  if (title.length < 3 || !closing || !closeBrackets.includes(closing))
    return undefined;
  const minOpen = Math.max(0, title.length - 26);
  let openIdx = -1;
  for (let i = title.length - 2; i >= minOpen; i--) {
    if (closeBrackets.includes(title[i])) break;
    if (i < title.length - 2 && openBrackets.includes(title[i])) openIdx = i;
  }
  if (openIdx === -1) return undefined;
  return {
    raw: title.slice(openIdx),
    inside: title.slice(openIdx + 1, -1),
    atStart: false,
    rest: title.slice(0, openIdx).trim(),
  };
}

function findEdgeBracket(title: string): EdgeBracket | undefined {
  return findLeadingBracket(title) ?? findTrailingBracket(title);
}

function stripEdgeBracket(
  title: string,
  removed: string[],
): string | undefined {
  const bracket = findEdgeBracket(title);
  if (!bracket) return undefined;
  if (
    !marketing(bracket.inside) &&
    (bracket.atStart || !hasStoreSuffix(bracket.inside))
  )
    return undefined;
  removed.push(bracket.raw.trim());
  return bracket.rest;
}

function stripTrailingFormat(
  title: string,
  removed: string[],
): string | undefined {
  const lower = title.toLowerCase();
  for (const suffix of trailingFormatSuffixes) {
    if (!lower.endsWith(suffix)) continue;
    const base = title.slice(0, -suffix.length).trimEnd();
    if (!base) return undefined;
    removed.push(title.slice(base.length).trim());
    return base;
  }
  return undefined;
}

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
    const next =
      stripTrailingStoreSegment(title, suffixes, removed) ??
      stripEdgeBracket(title, removed) ??
      stripTrailingFormat(title, removed);
    if (next !== undefined) {
      title = next;
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

const uiResidueTerms = new Set([
  "展开全部",
  "展開全部",
  "收起",
  "收合",
  "显示全部",
  "顯示全部",
  "查看全部",
  "查看更多",
  "看更多",
  "更多",
  "閱讀更多",
  "阅读更多",
  "read more",
  "show more",
  "see more",
  "show less",
  "more",
  "続きを読む",
  "もっと見る",
  "すべて表示",
]);

function isUiResidue(line: string): boolean {
  let text = line;
  if (text.length > 0 && "(（[［".includes(text[0])) text = text.slice(1);
  text = text.trimStart();
  text = stripTrailingChars(text, " \t\r\n.…»>›");
  const closing = text.at(-1);
  if (closing && ")）]］".includes(closing)) text = text.slice(0, -1);
  return uiResidueTerms.has(text.trimEnd().toLowerCase());
}

const sectionHeadingTerms = new Set([
  "内容简介",
  "內容簡介",
  "内容介绍",
  "內容介紹",
  "内容提要",
  "內容提要",
  "简介",
  "簡介",
  "图书简介",
  "圖書簡介",
  "作品简介",
  "作品簡介",
  "本书简介",
  "本書簡介",
  "作品紹介",
  "内容紹介",
  "内容説明",
  "あらすじ",
  "商品説明",
  "description",
  "book description",
  "about this book",
  "about the book",
  "summary",
  "synopsis",
  "overview",
]);

const watermarkTerms = [
  "http://",
  "https://",
  "www.",
  "整理制作",
  "整理製作",
  "校对制作",
  "校對製作",
  "下载",
  "下載",
  "公众号",
  "公眾號",
  "微信号",
  "微信號",
  "关注微信",
  "關注微信",
  "qq群",
  "ｑｑ群",
  "更多好书",
  "更多好書",
  "更多电子书",
  "更多電子書",
  "电子书搜索",
  "電子書搜索",
  "zlibrary",
  "z-library",
  "annas archive",
  "anna's archive",
  "仅供学习",
  "僅供學習",
  "学习交流",
  "學習交流",
  "版权归",
  "版權歸",
  "支持正版",
  "購買正版",
  "购买正版",
];
const watermarkDomain = /\b[\w-]+\.(?:com|net|org|cn|cc|me|top|xyz)\b/i;
const watermarkCredit =
  /(?:本书|本書|电子书|電子書)由.{0,20}(?:整理|制作|製作|提供)/;

export interface CleanedDescription {
  value: string;
  removed: string[];
}
/** A short line that advertises a file source, download site or redistribution channel. */
export const isWatermark = (value: string) => {
  if ([...value].length > 120) return false;
  const lower = value.toLowerCase();
  return (
    watermarkTerms.some((term) => lower.includes(term)) ||
    watermarkDomain.test(value) ||
    watermarkCredit.test(value)
  );
};
export const isHeading = (value: string) => {
  const normalized = space(value).replace(/[·•]\s*/g, "");
  return sectionHeadingTerms.has(
    stripTrailingChars(normalized, " \t\r\n:：·•.").toLowerCase(),
  );
};

const inlineUiTerms = [
  "展开全部",
  "展開全部",
  "显示全部",
  "顯示全部",
  "read more",
  "show more",
];

function skipBackwardSpace(value: string, pos: number): number {
  let cursor = pos;
  while (cursor > 0 && /\s/.test(value[cursor - 1])) cursor -= 1;
  return cursor;
}

function stripInlineUiTail(
  line: string,
): { text: string; removed: string } | undefined {
  let end = line.trimEnd().length;
  if (end > 0 && ")）]］".includes(line[end - 1]))
    end = skipBackwardSpace(line, end - 1);
  const headLower = line.slice(0, end).toLowerCase();
  const matched = inlineUiTerms.find((term) => headLower.endsWith(term));
  if (!matched) return undefined;
  let start = skipBackwardSpace(line, end - matched.length);
  if (start > 0 && "(（[［".includes(line[start - 1])) start -= 1;
  start = skipBackwardSpace(line, start);
  if (start <= 0) return undefined;
  return { text: line.slice(0, start), removed: line.slice(start).trim() };
}

function shouldDropDescriptionLine(
  line: string,
  index: number,
  checkWatermarks: boolean,
): boolean {
  if (!line) return false;
  if (isUiResidue(line)) return true;
  if (index === 0 && isHeading(line)) return true;
  return checkWatermarks && isWatermark(line);
}

/** Synopsis text only: markup, reader UI words, section labels and file watermarks are removed. */
export function cleanDescription(
  value: string,
  options: { watermarks?: boolean } = {},
): CleanedDescription {
  const removed: string[] = [];
  let text = plainText(value);
  if (/<\/?(?:p|br|div|span|em|strong|b|i)\b[^>]*>/i.test(text))
    text = plainText(text);
  const kept: string[] = [];
  const checkWatermarks = options.watermarks !== false;
  for (const [index, raw] of text.split("\n").entries()) {
    let line = raw;
    const inline = stripInlineUiTail(line);
    if (inline) {
      removed.push(inline.removed);
      line = inline.text;
    }
    if (shouldDropDescriptionLine(line, index, checkWatermarks)) {
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

const dateSuffixes = [
  "出版",
  "発売",
  "發行",
  "发行",
  "発行",
  "初版",
  "刊行",
  "上市",
  "published",
  "released",
];

function stripDateSuffix(text: string): string {
  const trimmed = text.trimEnd();
  const lower = trimmed.toLowerCase();
  for (const suffix of dateSuffixes) {
    if (lower.endsWith(suffix))
      return trimmed.slice(0, -suffix.length).trimEnd();
  }
  return text;
}

function isValidIsoTimeTail(tail: string): boolean {
  let rest = tail;
  if (rest.endsWith("Z")) {
    rest = rest.slice(0, -1);
  } else if (/[+-]\d{2}:?\d{2}$/.test(rest)) {
    const offsetIdx = Math.max(rest.lastIndexOf("+"), rest.lastIndexOf("-"));
    rest = rest.slice(0, offsetIdx);
  }
  return /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(rest);
}

function parseIsoDateTime(text: string): string | undefined {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](.+))?$/.exec(text);
  if (!match) return undefined;
  if (match[4] !== undefined && !isValidIsoTimeTail(match[4])) return undefined;
  return datePart(match[1], match[2], match[3]);
}

function parseNamedMonthDate(text: string): string | undefined {
  const dayFirst = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/.exec(text);
  if (dayFirst) {
    const month =
      months[dayFirst[2].toLowerCase().slice(0, 4)] ??
      months[dayFirst[2].toLowerCase().slice(0, 3)];
    return month ? datePart(dayFirst[3], month, dayFirst[1]) : undefined;
  }
  const monthFirst =
    /^([A-Za-z]{3,9})\.? (?:(\d{1,2})(?:st|nd|rd|th)?,? )?(\d{4})$/.exec(text);
  if (!monthFirst) return undefined;
  const month =
    months[monthFirst[1].toLowerCase().slice(0, 4)] ??
    months[monthFirst[1].toLowerCase().slice(0, 3)];
  return month ? datePart(monthFirst[3], month, monthFirst[2]) : undefined;
}

/** A publication date as YYYY, YYYY-MM or YYYY-MM-DD, keeping the precision the source states. */
export function normalizeDate(value: string): string | undefined {
  const cleaned = space(value.normalize("NFKC"))
    .replace(/^\[(.+)\]$/, "$1")
    .trim()
    .replace(/^(?:©\s*|c(?=\d{4}\b))/iu, "");
  const text = stripDateSuffix(cleaned).replace(
    /^(?:published|released|出版|発売)\s*[:：]?\s*/iu,
    "",
  );
  const iso = parseIsoDateTime(text);
  if (iso) return iso;
  let match = /^(\d{4})\s*[/.年]\s*(\d{1,2})\s*[/.月]\s*(\d{1,2})\s*日?$/.exec(
    text,
  );
  if (match) return datePart(match[1], match[2], match[3]);
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) return datePart(match[1], match[2], match[3]);
  match = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?$/.exec(text);
  if (match) return datePart(match[1], match[2]);
  match = /^(\d{4})(\d{2})$/.exec(text);
  if (match) return datePart(match[1], match[2]);
  match = /^(\d{4})\s*年?$/.exec(text);
  if (match) return datePart(match[1]);
  return parseNamedMonthDate(text);
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
    /^(?:第\s*)?(\d+(?:\.\d+)?)\s*[卷巻册冊集部辑輯篇]?$/u.exec(text) ??
    /^(?:vol(?:ume)?\.?|book|no\.?|#)\s*(\d+(?:\.\d+)?)$/i.exec(text);
  if (arabic) return String(Number(arabic[1]));
  const chinese =
    /^(?:第)?([〇零一二两兩三四五六七八九十百]+)[卷巻册冊集部辑輯篇]$/u.exec(
      text,
    ) ?? /^[卷巻]([〇零一二两兩三四五六七八九十百]+)$/u.exec(text);
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
function formatLanguageSubtag(part: string): string {
  if (part.length === 4)
    return part[0].toUpperCase() + part.slice(1).toLowerCase();
  if (part.length === 2) return part.toUpperCase();
  return part.toLowerCase();
}

/** A BCP 47 tag from a tag or a common language name; unknown names stay unresolved. */
export function normalizeLanguage(value: string): string | undefined {
  const text = space(value);
  const named = languageNames.find(([pattern]) => pattern.test(text));
  if (named) return named[1];
  if (!/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(text)) return undefined;
  const [primary, ...rest] = text.replaceAll("_", "-").split("-");
  if (["und", "mul", "zxx"].includes(primary.toLowerCase())) return undefined;
  return [
    shortLanguage[primary.toLowerCase()] ?? primary.toLowerCase(),
    ...rest.map(formatLanguageSubtag),
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
