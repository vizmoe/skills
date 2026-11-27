import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import postcss from "postcss";
import { pack } from "./zip.js";
import { escapeXml, NS } from "./xml.js";
import { validIsbn, validLanguage } from "./config.js";
import { lintCss } from "./css.js";
import { readingCss } from "./repair-reflow.js";
import {
  isOpeningParagraphAfter,
  loadPresetStylesSync,
  type BookTheme,
} from "./styles.js";
import { inspectBytes } from "./epub.js";
import { checkEpubConformance, validateInternal } from "./validate.js";
import { readingQa } from "./reading-qa.js";
import { checkAbort, fail } from "./errors.js";
import { readSourceFile, exists } from "./files.js";
import { sha256 } from "./hash.js";
import { json } from "./json.js";

export type KindleFormat = "mobi6" | "kf8" | "combo-kf8";

interface ExthMetadata {
  title?: string;
  authors: string[];
  contributors: string[];
  publisher?: string;
  description?: string;
  isbn?: string;
  subjects: string[];
  date?: string;
  language?: string;
  uuid?: string;
  kf8Boundary?: number;
  coverOffset?: number;
}

interface MobiHeader {
  compression: number;
  textLength: number;
  textRecordCount: number;
  encryption: number;
  encoding: number;
  version: number;
  firstNonBookIndex: number;
  firstImageIndex: number;
  huffIndex: number;
  huffCount: number;
  extraFlags: number;
  fdstIndex: number;
  fdstFlowCount: number;
  ncxIndex: number;
  fragIndex: number;
  skelIndex: number;
  title: string;
  exth: ExthMetadata;
}

export function isKindlePath(file: string): boolean {
  return [".mobi", ".azw3"].includes(path.extname(file).toLowerCase());
}

export function isKindleBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 78 &&
    Buffer.from(bytes.subarray(60, 68)).toString("ascii") === "BOOKMOBI"
  );
}

function stripTrailingEntries(data: Buffer, flags: number): Buffer {
  let end = data.length;
  let f = flags >>> 1;
  while (f > 0) {
    if (f & 1) {
      let size = 0,
        shift = 0,
        p = end;
      while (p > 0) {
        p--;
        const b = data[p];
        size |= (b & 0x7f) << shift;
        shift += 7;
        if (b & 0x80) break;
      }
      end = Math.max(0, end - size);
    }
    f >>>= 1;
  }
  if (flags & 1 && end > 0) {
    const n = (data[end - 1] & 0x03) + 1;
    end = Math.max(0, end - n);
  }
  return data.subarray(0, end);
}

function appendPalmDocBackRef(b: number, b2: number, out: number[]) {
  const pair = ((b << 8) | b2) & 0x3fff;
  const distance = pair >>> 3;
  const length = (pair & 0x07) + 3;
  if (distance === 0 || distance > out.length)
    fail("MOBI_INVALID", "Corrupt PalmDOC LZ77 back-reference");
  for (let j = 0; j < length; j++) out.push(out[out.length - distance]);
}

function consumePalmDocLiteralRun(
  data: Buffer,
  start: number,
  count: number,
  out: number[],
): number {
  const end = Math.min(data.length, start + count);
  let i = start;
  while (i < end) out.push(data[i++]);
  return i;
}

function decompressPalmDoc(data: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i++];
    if (b === 0x00 || (b >= 0x09 && b <= 0x7f)) {
      out.push(b);
    } else if (b >= 0x01 && b <= 0x08) {
      i = consumePalmDocLiteralRun(data, i, b, out);
    } else if (b >= 0xc0) {
      out.push(0x20, b ^ 0x80);
    } else {
      if (i >= data.length) break;
      appendPalmDocBackRef(b, data[i++], out);
    }
  }
  return Buffer.from(out);
}

interface HuffTables {
  dict1: { codelen: number; term: boolean; maxcode: number }[];
  mincodes: number[];
  maxcodes: number[];
  dictionary: { slice: Buffer; final: boolean }[];
}

function readU32BitWindow(padded: Buffer, bitOffset: number): number {
  const bytePos = bitOffset >>> 3;
  const shift = bitOffset & 7;
  const hi = padded.readUInt32BE(bytePos);
  if (shift === 0) return hi;
  const lo = padded[bytePos + 4];
  return ((hi << shift) | (lo >>> (8 - shift))) >>> 0;
}

function decodeHuffCode(
  dw: number,
  tables: HuffTables,
): { codelen: number; maxcode: number } {
  let { codelen, term, maxcode } = tables.dict1[dw >>> 24];
  if (!term) {
    while (codelen < 32 && dw < tables.mincodes[codelen]) codelen++;
    maxcode = tables.maxcodes[codelen];
  }
  return { codelen, maxcode };
}

function unpackHuffSlice(
  data: Buffer,
  tables: HuffTables,
  chunks: Buffer[],
  depth = 0,
) {
  if (depth > 32) fail("MOBI_INVALID", "HUFF/CDIC recursion limit exceeded");
  let bitsLeft = data.length * 8;
  const padded = Buffer.concat([data, Buffer.alloc(8)]);
  let pos = 0;
  while (bitsLeft > 0) {
    const dw = readU32BitWindow(padded, pos);
    const { codelen, maxcode } = decodeHuffCode(dw, tables);
    if (codelen === 0 || (bitsLeft < codelen && bitsLeft < 8)) break;
    pos += codelen;
    bitsLeft -= codelen;
    const index = (maxcode - dw) >>> (32 - codelen);
    if (index >= tables.dictionary.length)
      fail("MOBI_INVALID", "HUFF/CDIC dictionary index out of bounds");
    const entry = tables.dictionary[index];
    if (entry.final) chunks.push(entry.slice);
    else unpackHuffSlice(entry.slice, tables, chunks, depth + 1);
  }
}

function loadHuffTables(
  records: Buffer[],
  huffIndex: number,
  huffCount: number,
): HuffTables {
  const huff = records[huffIndex];
  if (huff.subarray(0, 4).toString("ascii") !== "HUFF")
    fail("MOBI_INVALID", "Invalid HUFF header");
  const off1 = huff.readUInt32BE(8);
  const off2 = huff.readUInt32BE(12);
  const dict1: HuffTables["dict1"] = [];
  for (let i = 0; i < 256; i++) {
    const v = huff.readUInt32BE(off1 + i * 4);
    const codelen = v & 0x1f;
    const term = (v & 0x80) !== 0;
    let maxcode = v >>> 8;
    if (codelen > 0) maxcode = ((maxcode + 1) << (32 - codelen)) - 1;
    dict1.push({ codelen, term, maxcode: maxcode >>> 0 });
  }
  const mincodes = [0];
  const maxcodes = [0];
  for (let len = 1; len <= 32; len++) {
    const min = huff.readUInt32BE(off2 + (len - 1) * 8);
    const max = huff.readUInt32BE(off2 + (len - 1) * 8 + 4);
    mincodes.push((min << (32 - len)) >>> 0);
    maxcodes.push((((max + 1) << (32 - len)) - 1) >>> 0);
  }
  const dictionary: HuffTables["dictionary"] = [];
  for (let c = 1; c < huffCount; c++) {
    const cdic = records[huffIndex + c];
    if (cdic.subarray(0, 4).toString("ascii") !== "CDIC")
      fail("MOBI_INVALID", "Invalid CDIC record");
    const headerLen = cdic.readUInt32BE(4);
    const numEntries = cdic.readUInt32BE(8);
    const codeLength = cdic.readUInt32BE(12);
    const count = Math.min(numEntries - dictionary.length, 1 << codeLength);
    for (let i = 0; i < count; i++) {
      const off = cdic.readUInt16BE(headerLen + i * 2);
      const blen = cdic.readUInt16BE(headerLen + off);
      const slice = cdic.subarray(
        headerLen + off + 2,
        headerLen + off + 2 + (blen & 0x7fff),
      );
      dictionary.push({ slice, final: (blen & 0x8000) !== 0 });
    }
  }
  return { dict1, mincodes, maxcodes, dictionary };
}

function decompressHuffCdic(
  records: Buffer[],
  textRecords: Buffer[],
  huffIndex: number,
  huffCount: number,
): Buffer {
  if (
    huffIndex === 0xffffffff ||
    huffCount < 2 ||
    huffIndex + huffCount > records.length
  )
    fail("MOBI_INVALID", "Missing HUFF/CDIC dictionary records");
  const tables = loadHuffTables(records, huffIndex, huffCount);
  const chunks: Buffer[] = [];
  for (const rec of textRecords) unpackHuffSlice(rec, tables, chunks);
  return Buffer.concat(chunks);
}

function applyExthRecord(
  meta: ExthMetadata,
  type: number,
  data: Buffer,
  encoding: BufferEncoding,
) {
  if (type === 121 && data.length === 4) {
    meta.kf8Boundary = data.readUInt32BE(0);
    return;
  }
  if (type === 201 && data.length === 4) {
    meta.coverOffset = data.readUInt32BE(0);
    return;
  }
  const value = data.toString(encoding).trim().normalize("NFC");
  if (!value) return;
  switch (type) {
    case 100:
      meta.authors.push(value);
      break;
    case 101:
      meta.publisher = value;
      break;
    case 103:
      meta.description = value;
      break;
    case 104: {
      const digits = value.replace(/[- ]/g, "");
      if (validIsbn(digits)) meta.isbn = digits;
      break;
    }
    case 105:
      meta.subjects.push(value);
      break;
    case 106:
      meta.date = value;
      break;
    case 108:
      if (!/^calibre\b/i.test(value)) meta.contributors.push(value);
      break;
    case 113:
      meta.uuid = value;
      break;
    case 503:
      meta.title = value;
      break;
    case 524:
      meta.language = value;
      break;
  }
}

function parseExth(
  rec0: Buffer,
  offset: number,
  encoding: BufferEncoding,
): ExthMetadata {
  const meta: ExthMetadata = { authors: [], contributors: [], subjects: [] };
  if (
    offset + 12 > rec0.length ||
    rec0.subarray(offset, offset + 4).toString("ascii") !== "EXTH"
  )
    return meta;
  const count = rec0.readUInt32BE(offset + 8);
  let pos = offset + 12;
  for (let i = 0; i < count && pos + 8 <= rec0.length; i++) {
    const type = rec0.readUInt32BE(pos);
    const len = rec0.readUInt32BE(pos + 4);
    if (len < 8 || pos + len > rec0.length) break;
    const data = rec0.subarray(pos + 8, pos + len);
    pos += len;
    applyExthRecord(meta, type, data, encoding);
  }
  return meta;
}

function parseRecord0(rec0: Buffer): MobiHeader {
  if (rec0.length < 132 || rec0.subarray(16, 20).toString("ascii") !== "MOBI")
    fail("MOBI_INVALID", "Missing MOBI header in record 0");
  const compression = rec0.readUInt16BE(0),
    textLength = rec0.readUInt32BE(4),
    textRecordCount = rec0.readUInt16BE(8),
    encryption = rec0.readUInt16BE(12);
  if (encryption !== 0)
    fail(
      "MOBI_ENCRYPTED",
      "Encrypted or DRM-protected Kindle files cannot be converted",
    );
  const headerLength = rec0.readUInt32BE(20),
    encodingNum = rec0.readUInt32BE(28),
    version = rec0.readUInt32BE(36);
  const encoding: BufferEncoding = encodingNum === 1252 ? "latin1" : "utf8";
  const firstNonBookIndex = rec0.readUInt32BE(80),
    fullNameOffset = rec0.readUInt32BE(84),
    fullNameLength = rec0.readUInt32BE(88),
    firstImageIndex = rec0.readUInt32BE(108),
    huffIndex = rec0.readUInt32BE(112),
    huffCount = rec0.readUInt32BE(116),
    exthFlags = rec0.readUInt32BE(128);
  const u32At = (off: number) =>
    16 + headerLength >= off + 4 ? rec0.readUInt32BE(off) : 0xffffffff;
  const extraFlags = 16 + headerLength >= 244 ? rec0.readUInt16BE(242) : 0;
  const fdstIndex = version >= 8 ? u32At(192) : 0xffffffff;
  const fdstFlowCount =
    version >= 8 && u32At(196) !== 0xffffffff ? u32At(196) : 1;
  const ncxIndex = u32At(244);
  const fragIndex = version >= 8 ? u32At(248) : 0xffffffff;
  const skelIndex = version >= 8 ? u32At(252) : 0xffffffff;
  const exth =
    exthFlags & 0x40
      ? parseExth(rec0, 16 + headerLength, encoding)
      : { authors: [], contributors: [], subjects: [] };
  const rawTitle =
    fullNameOffset + fullNameLength <= rec0.length
      ? rec0
          .subarray(fullNameOffset, fullNameOffset + fullNameLength)
          .toString(encoding)
          .trim()
      : "";
  return {
    compression,
    textLength,
    textRecordCount,
    encryption,
    encoding: encodingNum,
    version,
    firstNonBookIndex,
    firstImageIndex,
    huffIndex,
    huffCount,
    extraFlags,
    fdstIndex,
    fdstFlowCount,
    ncxIndex,
    fragIndex,
    skelIndex,
    title: exth.title || rawTitle || "Untitled",
    exth,
  };
}

function parsePdb(bytes: Uint8Array): Buffer[] {
  if (!isKindleBytes(bytes))
    fail("MOBI_INVALID", "Expected a BOOKMOBI (.mobi or .azw3) container");
  const buf = Buffer.from(bytes);
  const numRecords = buf.readUInt16BE(76);
  if (numRecords < 2 || 78 + numRecords * 8 > buf.length)
    fail("MOBI_INVALID", "Invalid PalmDB record table");
  const offsets: number[] = [];
  for (let i = 0; i < numRecords; i++) {
    const off = buf.readUInt32BE(78 + i * 8);
    if (off >= buf.length || (i > 0 && off < offsets[i - 1]))
      fail("MOBI_INVALID", "Corrupt PalmDB record offset");
    offsets.push(off);
  }
  offsets.push(buf.length);
  return offsets
    .slice(0, numRecords)
    .map((start, i) => buf.subarray(start, offsets[i + 1]));
}

function normalizeBcp47(lang?: string): string {
  const raw = (lang ?? "").trim().replaceAll("_", "-");
  if (/^zh(?:-(?:cn|sg|hans))?$/i.test(raw)) return "zh-Hans";
  if (/^zh-(?:tw|hk|mo|hant)$/i.test(raw)) return "zh-Hant";
  if (raw && validLanguage(raw)) return raw;
  return "en";
}

function normalizeDate(value?: string): string | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(value.trim());
  if (!m) return undefined;
  return m[0];
}

function detectImage(bytes: Buffer): { ext: string; mediaType: string } | null {
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return { ext: "png", mediaType: "image/png" };
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return { ext: "jpg", mediaType: "image/jpeg" };
  if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
  )
    return { ext: "gif", mediaType: "image/gif" };
  return null;
}

function sanitizeStylesheet(
  source: string,
  images: Map<number, { file: string }>,
): string {
  try {
    const root = postcss.parse(source);
    root.walkAtRules((rule) => {
      if (
        !["font-face", "media", "supports", "namespace"].includes(
          rule.name.toLowerCase(),
        )
      )
        rule.remove();
    });
    root.walkDecls((decl) => {
      decl.important = false;
      decl.value = decl.value.replace(
        /kindle:embed:([0-9A-Za-z]{4})(?:\?[^)"'\s]*)?/g,
        (_m, id: string) => {
          const idx = Number.parseInt(id, 32);
          const img = images.get(idx);
          return img ? `../images/${img.file}` : "";
        },
      );
      const prop = decl.prop.toLowerCase();
      if (
        [
          "font",
          "font-family",
          "font-size",
          "line-height",
          "color",
          "background",
          "background-color",
          "width",
          "text-align",
          "height",
          "min-height",
          "max-height",
          "position",
          "overflow",
          "visibility",
          "opacity",
          "animation",
          "transition",
        ].includes(prop) ||
        decl.value.includes("kindle:")
      )
        decl.remove();
    });
    const out = root.toString();
    return lintCss(out, "flow.css").status === "pass" ? out : "";
  } catch {
    return "";
  }
}

const allowedKindleTags = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "div",
  "section",
  "article",
  "blockquote",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "pre",
  "code",
  "em",
  "strong",
  "b",
  "i",
  "sup",
  "sub",
  "span",
  "a",
  "img",
  "br",
  "hr",
  "aside",
]);

interface KindleRenderOptions {
  lang: string;
  defaultTitle: string;
  stylesheets: string[];
  images: Map<number, { file: string }>;
  resolveHref: (href: string, filepos?: string) => string | undefined;
  markOpeningParagraphs?: boolean;
}

interface KindleRenderState {
  usedIds: Set<string>;
  h1Count: number;
  linkCount: number;
  detectedTitle: string;
}

function promoteFontHeadings($: ReturnType<typeof load>) {
  // Convert MOBI 6 <p><font size="7|6|5"><b>Heading</b></font></p> into semantic headings
  $("p, div").each((_, el) => {
    const node = $(el);
    const children = node
      .contents()
      .filter((__, c) => c.type !== "text" || !!(c.data ?? "").trim());
    if (children.length !== 1 || children[0].type !== "tag") return;
    const first = $(children[0]);
    if (!first.is("font")) return;
    const size = Number(first.attr("size") ?? "0");
    const text = first.text().trim();
    if (!text || size < 5) return;
    const tag = size >= 6 ? "h1" : "h2";
    const idAttr = node.attr("id") || first.attr("id");
    const idFragment = idAttr ? ` id="${escapeXml(idAttr)}"` : "";
    node.replaceWith(`<${tag}${idFragment}>${escapeXml(text)}</${tag}>`);
  });
}

function hoistFileposSpans($: ReturnType<typeof load>) {
  $("span[id^='filepos-']").each((_, span) => {
    const s = $(span);
    if (s.text().trim() || s.children().length > 0) return;
    const next = s.next();
    if (next.length && !next.attr("id")) {
      next.attr("id", s.attr("id")!);
      s.remove();
      return;
    }
    if (
      s.parent().length &&
      !s.parent().is("body, html") &&
      !s.parent().attr("id")
    ) {
      s.parent().attr("id", s.attr("id")!);
      s.remove();
    }
  });
}

function normalizeKindleHeadingTag(
  tag: string,
  text: string,
  state: KindleRenderState,
): string {
  if (!state.detectedTitle && text) state.detectedTitle = text;
  if (tag === "h1") {
    state.h1Count++;
    return tag;
  }
  if (state.h1Count === 0) {
    state.h1Count++;
    return "h1";
  }
  return Number(tag[1]) > 2 ? "h2" : tag;
}

function renderKindleImageTag(
  el: ReturnType<ReturnType<typeof load>>,
  attrs: string[],
  images: Map<number, { file: string }>,
): string | undefined {
  let imgIdx: number | undefined;
  const recindex = el.attr("recindex");
  const src = el.attr("src") ?? "";
  const embedMatch = /^kindle:embed:([0-9a-z]{4})/i.exec(src);
  if (recindex && /^\d+$/.test(recindex)) imgIdx = Number(recindex);
  else if (embedMatch) imgIdx = Number.parseInt(embedMatch[1], 32);
  else if (images.size === 1) imgIdx = 1;
  const img = imgIdx ? images.get(imgIdx) : undefined;
  if (!img) return undefined;
  const alt = (el.attr("alt") ?? "").trim() || "Illustration";
  attrs.push(
    `src="../images/${escapeXml(img.file)}"`,
    `alt="${escapeXml(alt)}"`,
  );
  return `<img ${attrs.join(" ")}/>`;
}

function renderKindleAnchorTag(
  el: ReturnType<ReturnType<typeof load>>,
  attrs: string[],
  inner: string,
  options: KindleRenderOptions,
  state: KindleRenderState,
): string {
  const resolved = options.resolveHref(
    el.attr("href") ?? "",
    el.attr("filepos"),
  );
  if (!resolved || !inner.trim()) {
    return attrs.length ? `<span ${attrs.join(" ")}>${inner}</span>` : inner;
  }
  if (
    !attrs.some((a) => a.startsWith('id="')) &&
    !/^(?:https?:|mailto:)/i.test(resolved)
  ) {
    let linkId = `link-${++state.linkCount}`;
    while (state.usedIds.has(linkId)) linkId = `link-${++state.linkCount}`;
    state.usedIds.add(linkId);
    attrs.push(`id="${linkId}"`);
  }
  attrs.push(`href="${escapeXml(resolved)}"`);
  return `<a ${attrs.join(" ")}>${inner}</a>`;
}

function collectElementIdAttr(
  el: ReturnType<ReturnType<typeof load>>,
  state: KindleRenderState,
): string[] {
  const rawId = (el.attr("id") || el.attr("name") || "").trim();
  if (
    rawId &&
    /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(rawId) &&
    !state.usedIds.has(rawId)
  ) {
    state.usedIds.add(rawId);
    return [`id="${escapeXml(rawId)}"`];
  }
  return [];
}

function renderKindleElement(
  $: ReturnType<typeof load>,
  rawTag: string,
  el: ReturnType<ReturnType<typeof load>>,
  options: KindleRenderOptions,
  state: KindleRenderState,
  openingParagraph = false,
): { html: string; tag: string } | undefined {
  let tag = rawTag.toLowerCase();
  if (tag.includes(":") || tag === "mbp:pagebreak") return undefined;
  if (!allowedKindleTags.has(tag)) tag = "span";
  if (/^h[1-6]$/.test(tag))
    tag = normalizeKindleHeadingTag(tag, el.text().trim(), state);
  const attrs = collectElementIdAttr(el, state);
  if (tag === "p" && openingParagraph) attrs.push('class="opening"');
  if (tag === "img") {
    const html = renderKindleImageTag(el, attrs, options.images);
    return html ? { html, tag } : undefined;
  }
  const attrSuffix = attrs.length ? " " + attrs.join(" ") : "";
  if (tag === "br" || tag === "hr")
    return { html: `<${tag}${attrSuffix}/>`, tag };
  const inner = renderKindleChildren($, el, options, state, false);
  if (tag === "a")
    return {
      html: renderKindleAnchorTag(el, attrs, inner, options, state),
      tag,
    };
  return { html: `<${tag}${attrSuffix}>${inner}</${tag}>`, tag };
}

function renderKindleChildren(
  $: ReturnType<typeof load>,
  nodes: { contents: () => ReturnType<ReturnType<typeof load>> },
  options: KindleRenderOptions,
  state: KindleRenderState,
  topLevel = false,
): string {
  const parts: string[] = [];
  let prevBlockKind: string | undefined;
  nodes.contents().each((_, child) => {
    if (child.type === "text") {
      parts.push(escapeXml(child.data ?? ""));
      return;
    }
    if (child.type !== "tag") return;
    const opening =
      topLevel &&
      Boolean(options.markOpeningParagraphs) &&
      isOpeningParagraphAfter(prevBlockKind);
    const rendered = renderKindleElement(
      $,
      child.tagName ?? "",
      $(child),
      options,
      state,
      opening,
    );
    if (rendered) {
      parts.push(rendered.html);
      if (topLevel) {
        const isEmptyAnchor =
          rendered.tag === "span" &&
          !$(child).text().trim() &&
          $(child).children().length === 0;
        if (!isEmptyAnchor) {
          prevBlockKind = /^h[1-6]$/.test(rendered.tag)
            ? "heading"
            : rendered.tag;
        }
      }
    }
  });
  return parts.join("");
}

function serializeCleanXhtml(
  rawHtml: string,
  options: KindleRenderOptions,
): { xhtml: string; title: string; isGeneratedToc: boolean } | null {
  const $ = load(rawHtml);
  const isGeneratedToc =
    $("#calibre_generated_inline_toc").length > 0 ||
    $("body").attr("id") === "calibre_generated_inline_toc";
  $(
    "script, style, meta, base, iframe, object, embed, form, input, video, audio",
  ).remove();
  promoteFontHeadings($);
  // Unwrap remaining <font>, <center>, <mbp:*> wrappers while keeping their children
  for (let pass = 0; pass < 3; pass++) {
    $("font, center, strike, u").each((_, el) => {
      $(el).replaceWith($(el).contents());
    });
  }
  hoistFileposSpans($);
  const state: KindleRenderState = {
    usedIds: new Set<string>(),
    h1Count: 0,
    linkCount: 0,
    detectedTitle: "",
  };
  const bodyRoot = $("body").length ? $("body") : $.root();
  let bodyContent = renderKindleChildren(
    $,
    bodyRoot,
    options,
    state,
    true,
  ).trim();
  if (!bodyContent) return null;
  const title =
    state.detectedTitle ||
    $("title").first().text().trim() ||
    options.defaultTitle;
  // Ensure block-level root children inside <body> for valid XHTML & split units
  if (
    !/<(?:h[1-6]|p|div|section|article|blockquote|ul|ol|dl|pre|aside)\b/.test(
      bodyContent,
    )
  ) {
    bodyContent = options.markOpeningParagraphs
      ? `<p class="opening">${bodyContent}</p>`
      : `<p>${bodyContent}</p>`;
  }
  const styleLinks = options.stylesheets
    .map(
      (href) =>
        `<link rel="stylesheet" type="text/css" href="${escapeXml(href)}"/>`,
    )
    .join("");
  const xhtml = `<?xml version="1.0" encoding="utf-8"?><html xmlns="${NS.xhtml}" xmlns:epub="${NS.epub}" lang="${escapeXml(options.lang)}" xml:lang="${escapeXml(options.lang)}"><head><title>${escapeXml(title)}</title>${styleLinks}</head><body>${bodyContent}</body></html>`;
  return { xhtml, title, isGeneratedToc };
}

interface KindleImageRecord {
  index: number;
  file: string;
  path: string;
  mediaType: string;
  bytes: Buffer;
}

interface KindleChapterFile {
  id: string;
  file: string;
  path: string;
  title: string;
}

function selectKindleHeader(records: Buffer[]): {
  primary: MobiHeader;
  header: MobiHeader;
  recordOffset: number;
  format: KindleFormat;
} {
  const primary = parseRecord0(records[0]);
  if (
    primary.version < 8 &&
    primary.exth.kf8Boundary !== undefined &&
    primary.exth.kf8Boundary + 1 < records.length &&
    records[primary.exth.kf8Boundary]
      .subarray(0, 8)
      .toString("ascii")
      .startsWith("BOUNDARY")
  ) {
    const recordOffset = primary.exth.kf8Boundary + 1;
    return {
      primary,
      header: parseRecord0(records[recordOffset]),
      recordOffset,
      format: "combo-kf8",
    };
  }
  return {
    primary,
    header: primary,
    recordOffset: 0,
    format: primary.version >= 8 ? "kf8" : "mobi6",
  };
}

function decompressKindleText(
  records: Buffer[],
  header: MobiHeader,
  recordOffset: number,
): Buffer {
  if (
    recordOffset + header.textRecordCount >= records.length ||
    header.textRecordCount < 1
  )
    fail("MOBI_INVALID", "Kindle text records exceed container bounds");
  const textSlice = records
    .slice(recordOffset + 1, recordOffset + 1 + header.textRecordCount)
    .map((rec) => stripTrailingEntries(rec, header.extraFlags));
  let rawText: Buffer;
  if (header.compression === 1) rawText = Buffer.concat(textSlice);
  else if (header.compression === 2)
    rawText = Buffer.concat(textSlice.map(decompressPalmDoc));
  else if (header.compression === 17480)
    rawText = decompressHuffCdic(
      records,
      textSlice,
      recordOffset + header.huffIndex,
      header.huffCount,
    );
  else
    fail(
      "MOBI_UNSUPPORTED_COMPRESSION",
      `Unsupported MOBI compression type: ${header.compression}`,
    );
  if (rawText.length > header.textLength && header.textLength > 0)
    return rawText.subarray(0, header.textLength);
  return rawText;
}

function findImageStartIndex(
  header: MobiHeader,
  primary: MobiHeader,
  recordOffset: number,
  recordCount: number,
): number {
  if (
    header.firstImageIndex !== 0xffffffff &&
    recordOffset + header.firstImageIndex < recordCount
  )
    return recordOffset + header.firstImageIndex;
  if (
    primary.firstImageIndex !== 0xffffffff &&
    primary.firstImageIndex < recordCount
  )
    return primary.firstImageIndex;
  return recordCount;
}

function extractKindleImages(
  records: Buffer[],
  imgStart: number,
): Map<number, KindleImageRecord> {
  const images = new Map<number, KindleImageRecord>();
  for (let r = imgStart; r < records.length; r++) {
    const detected = detectImage(records[r]);
    if (!detected) continue;
    const oneBased = r - imgStart + 1;
    const file = `image-${String(oneBased).padStart(4, "0")}.${detected.ext}`;
    images.set(oneBased, {
      index: oneBased,
      file,
      path: `OEBPS/images/${file}`,
      mediaType: detected.mediaType,
      bytes: records[r],
    });
  }
  return images;
}

function sliceFdstFlows(
  records: Buffer[],
  header: MobiHeader,
  recordOffset: number,
  rawText: Buffer,
): Buffer[] {
  if (
    header.fdstIndex === 0xffffffff ||
    recordOffset + header.fdstIndex >= records.length
  )
    return [rawText];
  const fdst = records[recordOffset + header.fdstIndex];
  if (fdst.length < 12 || fdst.subarray(0, 4).toString("ascii") !== "FDST")
    return [rawText];
  const hlen = fdst.readUInt32BE(4);
  const nflows = fdst.readUInt32BE(8);
  const sliced: Buffer[] = [];
  for (let i = 0; i < nflows && hlen + (i + 1) * 8 <= fdst.length; i++) {
    const s = fdst.readUInt32BE(hlen + i * 8);
    const e = fdst.readUInt32BE(hlen + i * 8 + 4);
    if (s <= e && e <= rawText.length) sliced.push(rawText.subarray(s, e));
  }
  return sliced.length ? sliced : [rawText];
}

function scanKf8FidTargets(
  flow0Str: string,
  fragBuf: Buffer,
  idx: number,
  encoding: BufferEncoding,
  fidTargets: Map<string, { chapterIdx: number; id?: string }>,
) {
  const fidCode = idx.toString(32).toUpperCase().padStart(4, "0");
  const posRegex = new RegExp(
    `kindle:pos:fid:${fidCode}:off:([0-9a-z]{10})`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = posRegex.exec(flow0Str)) !== null) {
    const off = Number.parseInt(m[1], 32);
    const key = `${idx}:${off}`;
    if (fidTargets.has(key)) continue;
    if (off === 0) {
      fidTargets.set(key, { chapterIdx: idx });
    } else if (off < fragBuf.length) {
      const tail = fragBuf.subarray(off).toString(encoding);
      const idMatch = /^<[^>]*?\bid=["']([^"']+)["']/i.exec(tail);
      fidTargets.set(
        key,
        idMatch ? { chapterIdx: idx, id: idMatch[1] } : { chapterIdx: idx },
      );
    }
  }
}

function extractKf8Chapters(
  records: Buffer[],
  header: MobiHeader,
  recordOffset: number,
  rawText: Buffer,
  encoding: BufferEncoding,
  context: {
    images: Map<number, KindleImageRecord>;
    entries: Map<string, Buffer>;
    stylesheets: string[];
    fidTargets: Map<string, { chapterIdx: number; id?: string }>;
  },
): string[] {
  const flows = sliceFdstFlows(records, header, recordOffset, rawText);
  for (let f = 1; f < flows.length; f++) {
    const cleanCss = sanitizeStylesheet(
      flows[f].toString(encoding),
      context.images,
    );
    if (cleanCss.trim()) {
      const name = `flow-${String(f).padStart(4, "0")}.css`;
      context.entries.set(`OEBPS/styles/${name}`, Buffer.from(cleanCss));
      context.stylesheets.push(`../styles/${name}`);
    }
  }
  const flow0Str = flows[0].toString(encoding);
  const parts = flow0Str
    .split(/(?=<\?xml\s)/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((part, idx) => {
    const closeIdx = part.search(/<\/body>\s*<\/html>/i);
    if (closeIdx < 0) return part;
    const closeMatch = /<\/body>\s*<\/html>\s*/i.exec(part.slice(closeIdx))!;
    const skelEnd = closeIdx + closeMatch.index + closeMatch[0].length;
    const skel = part.slice(0, skelEnd);
    const frag = part.slice(skelEnd);
    scanKf8FidTargets(
      flow0Str,
      Buffer.from(frag, encoding),
      idx,
      encoding,
      context.fidTargets,
    );
    if (!frag.trim()) return skel;
    return skel.slice(0, closeIdx) + frag + skel.slice(closeIdx);
  });
}

function extractMobi6Chapters(
  rawText: Buffer,
  encoding: BufferEncoding,
  fileposTargets: Map<number, { chapterIdx: number; id: string }>,
): string[] {
  // MOBI 6: resolve filepos byte offsets before splitting on <mbp:pagebreak>
  const fullStr = rawText.toString(encoding);
  const posSet = new Set<number>();
  let m: RegExpExecArray | null;
  const posRe = /\bfilepos=["']?(\d+)["']?/gi;
  while ((m = posRe.exec(fullStr)) !== null) posSet.add(Number(m[1]));
  const sortedPos = [...posSet]
    .filter((p) => p >= 0 && p < rawText.length)
    .sort((a, b) => b - a);
  let annotated = rawText;
  for (const pos of sortedPos) {
    const marker = Buffer.from(`<span id="filepos-${pos}"></span>`, encoding);
    annotated = Buffer.concat([
      annotated.subarray(0, pos),
      marker,
      annotated.subarray(pos),
    ]);
  }
  const rawChapters = annotated
    .toString(encoding)
    .split(/<mbp:pagebreak\s*\/?>/i)
    .map((s) => s.trim())
    .filter(Boolean);
  rawChapters.forEach((ch, idx) => {
    const markerRe = /\bid="filepos-(\d+)"/g;
    let mm: RegExpExecArray | null;
    while ((mm = markerRe.exec(ch)) !== null) {
      fileposTargets.set(Number(mm[1]), {
        chapterIdx: idx,
        id: `filepos-${mm[1]}`,
      });
    }
  });
  return rawChapters;
}

function selectActiveChapterIndices(rawChapters: string[]): number[] {
  const activeIndices: number[] = [];
  rawChapters.forEach((raw, idx) => {
    const $ = load(raw);
    const isToc =
      $("#calibre_generated_inline_toc").length > 0 ||
      $("body").attr("id") === "calibre_generated_inline_toc" ||
      (idx === rawChapters.length - 1 &&
        rawChapters.length > 1 &&
        /^(?:目录|目錄|Table of Contents)$/i.test(
          $("font[size='5'] b, h1, h2").first().text().trim(),
        ));
    const hasTextOrImg =
      $("body").text().trim().length > 0 ||
      $.root().text().trim().length > 0 ||
      $("img").length > 0;
    if (!isToc && hasTextOrImg) activeIndices.push(idx);
  });
  if (!activeIndices.length && rawChapters.length) activeIndices.push(0);
  return activeIndices;
}

function formatChapterLink(
  destIdx: number,
  finalIdx: number,
  fragment?: string,
): string {
  const destFile = `c${String(destIdx + 1).padStart(4, "0")}.xhtml`;
  if (!fragment) return destIdx === finalIdx ? "#" : destFile;
  return destIdx === finalIdx ? `#${fragment}` : `${destFile}#${fragment}`;
}

function resolveFileposHref(
  filepos: string,
  finalIdx: number,
  rawToFinalIdx: Map<number, number>,
  fileposTargets: Map<number, { chapterIdx: number; id: string }>,
): string | undefined {
  const target = fileposTargets.get(Number(filepos));
  if (!target) return undefined;
  const destIdx = rawToFinalIdx.get(target.chapterIdx);
  if (destIdx === undefined) return undefined;
  return formatChapterLink(destIdx, finalIdx, target.id);
}

function resolveKf8PosHref(
  posMatch: RegExpExecArray,
  finalIdx: number,
  rawToFinalIdx: Map<number, number>,
  fidTargets: Map<string, { chapterIdx: number; id?: string }>,
): string | undefined {
  const fid = Number.parseInt(posMatch[1], 32);
  const off = Number.parseInt(posMatch[2], 32);
  const target = fidTargets.get(`${fid}:${off}`) ?? { chapterIdx: fid };
  const destIdx = rawToFinalIdx.get(target.chapterIdx);
  if (destIdx === undefined) return undefined;
  return formatChapterLink(destIdx, finalIdx, target.id);
}

function createChapterHrefResolver(
  finalIdx: number,
  rawToFinalIdx: Map<number, number>,
  fileposTargets: Map<number, { chapterIdx: number; id: string }>,
  fidTargets: Map<string, { chapterIdx: number; id?: string }>,
) {
  return (href: string, filepos?: string): string | undefined => {
    if (filepos && /^\d+$/.test(filepos))
      return resolveFileposHref(
        filepos,
        finalIdx,
        rawToFinalIdx,
        fileposTargets,
      );
    const posMatch = /^kindle:pos:fid:([0-9a-z]{4}):off:([0-9a-z]{10})/i.exec(
      href,
    );
    if (posMatch)
      return resolveKf8PosHref(posMatch, finalIdx, rawToFinalIdx, fidTargets);
    if (/^https?:\/\/|^mailto:/i.test(href) || href.startsWith("#"))
      return href;
    return undefined;
  };
}

function buildKindleOpf(options: {
  bytes: Uint8Array;
  header: MobiHeader;
  primary: MobiHeader;
  metadata: {
    lang: string;
    title: string;
    authors: string[];
    contributors: string[];
    publisher?: string;
    description?: string;
    isbn?: string;
    date?: string;
    subjects: string[];
    coverOffset?: number;
  };
  entries: Map<string, Buffer>;
  chapterFiles: KindleChapterFile[];
  images: Map<number, KindleImageRecord>;
}): string {
  const { bytes, header, primary, metadata, entries, chapterFiles, images } =
    options;
  const coverImageEntry =
    metadata.coverOffset !== undefined
      ? images.get(metadata.coverOffset + 1)
      : undefined;
  const digest = sha256(bytes);
  const fallbackUuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const rawUuid = header.exth.uuid ?? primary.exth.uuid;
  const primaryId =
    rawUuid &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      rawUuid,
    )
      ? `urn:uuid:${rawUuid.toLowerCase()}`
      : `urn:uuid:${fallbackUuid}`;
  const metaParts: string[] = [
    `<dc:identifier id="uid">${escapeXml(primaryId)}</dc:identifier>`,
    ...(metadata.isbn
      ? [
          `<dc:identifier id="isbn">${escapeXml(metadata.isbn)}</dc:identifier>`,
          `<meta refines="#isbn" property="identifier-type" scheme="onix:codelist5">15</meta>`,
        ]
      : []),
    `<dc:title>${escapeXml(metadata.title)}</dc:title>`,
    `<dc:language>${escapeXml(metadata.lang)}</dc:language>`,
    ...(metadata.authors.length ? metadata.authors : ["Unknown"]).map(
      (a) => `<dc:creator>${escapeXml(a)}</dc:creator>`,
    ),
    ...metadata.contributors.map(
      (c) => `<dc:contributor>${escapeXml(c)}</dc:contributor>`,
    ),
    ...(metadata.publisher
      ? [`<dc:publisher>${escapeXml(metadata.publisher)}</dc:publisher>`]
      : []),
    ...(metadata.description
      ? [`<dc:description>${escapeXml(metadata.description)}</dc:description>`]
      : []),
    ...metadata.subjects.map((s) => `<dc:subject>${escapeXml(s)}</dc:subject>`),
    ...(metadata.date
      ? [`<dc:date>${escapeXml(metadata.date)}</dc:date>`]
      : []),
    `<meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>`,
    `<meta property="schema:accessMode">textual</meta>`,
    `<meta property="schema:accessModeSufficient">textual</meta>`,
    `<meta property="schema:accessibilityFeature">tableOfContents</meta>`,
    `<meta property="schema:accessibilityHazard">none</meta>`,
    `<meta property="schema:accessibilitySummary">Converted from Kindle format with preserved text and navigation; accessibility has not been certified.</meta>`,
  ];
  const manifestParts: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    ...[...entries.keys()]
      .filter((k) => k.startsWith("OEBPS/styles/") && k.endsWith(".css"))
      .map((k, i) => {
        const rel = k.slice("OEBPS/".length);
        const id =
          rel === "styles/reading.css"
            ? "reading-css"
            : rel === "styles/base.css"
              ? "base-css"
              : rel === "styles/theme.css"
                ? "theme-css"
                : rel === "styles/frontmatter.css"
                  ? "frontmatter-css"
                  : `css-${i + 1}`;
        return `<item id="${id}" href="${escapeXml(rel)}" media-type="text/css"/>`;
      }),
    ...chapterFiles.map(
      (ch) =>
        `<item id="${ch.id}" href="text/${escapeXml(ch.file)}" media-type="application/xhtml+xml"/>`,
    ),
    ...[...images.values()].map(
      (img) =>
        `<item id="img-${img.index}" href="images/${escapeXml(img.file)}" media-type="${img.mediaType}"${coverImageEntry?.index === img.index ? ' properties="cover-image"' : ""}/>`,
    ),
  ];
  const spineParts = chapterFiles.map((ch) => `<itemref idref="${ch.id}"/>`);
  return `<?xml version="1.0" encoding="utf-8"?><package xmlns="${NS.opf}" xmlns:dc="${NS.dc}" version="3.0" unique-identifier="uid" xml:lang="${escapeXml(metadata.lang)}"><metadata>${metaParts.join("")}</metadata><manifest>${manifestParts.join("")}</manifest><spine>${spineParts.join("")}</spine></package>`;
}

export function unpackKindle(
  bytes: Uint8Array,
  options: { theme?: BookTheme } = {},
): {
  bytes: Buffer;
  format: KindleFormat;
  presetTheme?: BookTheme;
  metadata: {
    title: string;
    language: string;
    authors: string[];
    publisher?: string;
    description?: string;
    isbn?: string;
    date?: string;
    chapters: number;
    images: number;
  };
} {
  const records = parsePdb(bytes);
  const { primary, header, recordOffset, format } = selectKindleHeader(records);
  const rawText = decompressKindleText(records, header, recordOffset);
  const imgStart = findImageStartIndex(
    header,
    primary,
    recordOffset,
    records.length,
  );
  const images = extractKindleImages(records, imgStart);
  const lang = normalizeBcp47(header.exth.language ?? primary.exth.language);
  const title = header.title || primary.title || "Untitled";
  const authors = header.exth.authors.length
    ? header.exth.authors
    : primary.exth.authors;
  const contributors = header.exth.contributors.length
    ? header.exth.contributors
    : primary.exth.contributors;
  const publisher = header.exth.publisher ?? primary.exth.publisher;
  const description = header.exth.description ?? primary.exth.description;
  const isbn = header.exth.isbn ?? primary.exth.isbn;
  const date = normalizeDate(header.exth.date ?? primary.exth.date);
  const subjects = header.exth.subjects.length
    ? header.exth.subjects
    : primary.exth.subjects;
  const coverOffset = header.exth.coverOffset ?? primary.exth.coverOffset;
  const encoding: BufferEncoding = header.encoding === 1252 ? "latin1" : "utf8";

  const entries = new Map<string, Buffer>();
  entries.set("mimetype", Buffer.from("application/epub+zip"));
  entries.set(
    "META-INF/container.xml",
    Buffer.from(
      `<container xmlns="${NS.container}" version="1.0"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
  );
  const stylesheets: string[] = [];
  const fidTargets = new Map<string, { chapterIdx: number; id?: string }>();
  const fileposTargets = new Map<number, { chapterIdx: number; id: string }>();
  const rawChapters =
    header.version >= 8
      ? extractKf8Chapters(records, header, recordOffset, rawText, encoding, {
          images,
          entries,
          stylesheets,
          fidTargets,
        })
      : extractMobi6Chapters(rawText, encoding, fileposTargets);

  const hasSourceStyles = stylesheets.length > 0;
  let presetTheme: BookTheme | undefined;
  const navStyles: string[] = [];
  if (hasSourceStyles) {
    entries.set("OEBPS/styles/reading.css", Buffer.from(readingCss));
    stylesheets.unshift("../styles/reading.css");
    navStyles.push("styles/reading.css");
  } else {
    presetTheme = options.theme ?? "literature";
    for (const style of loadPresetStylesSync(presetTheme, "OEBPS")) {
      entries.set(style.href, style.bytes);
    }
    entries.set("OEBPS/styles/reading.css", Buffer.from(readingCss));
    stylesheets.push(
      "../styles/base.css",
      "../styles/theme.css",
      "../styles/reading.css",
    );
    navStyles.push(
      "styles/base.css",
      "styles/frontmatter.css",
      "styles/reading.css",
    );
  }

  const activeIndices = selectActiveChapterIndices(rawChapters);
  const rawToFinalIdx = new Map<number, number>(
    activeIndices.map((rawIdx, finalIdx) => [rawIdx, finalIdx]),
  );
  const chapterFiles: KindleChapterFile[] = [];
  for (const [finalIdx, rawIdx] of activeIndices.entries()) {
    const file = `c${String(finalIdx + 1).padStart(4, "0")}.xhtml`;
    const rendered = serializeCleanXhtml(rawChapters[rawIdx], {
      lang,
      defaultTitle: `${title} - ${finalIdx + 1}`,
      stylesheets,
      images,
      markOpeningParagraphs: !hasSourceStyles,
      resolveHref: createChapterHrefResolver(
        finalIdx,
        rawToFinalIdx,
        fileposTargets,
        fidTargets,
      ),
    });
    if (!rendered) continue;
    const id = `c${String(finalIdx + 1).padStart(4, "0")}`;
    const fullPath = `OEBPS/text/${file}`;
    entries.set(fullPath, Buffer.from(rendered.xhtml));
    chapterFiles.push({ id, file, path: fullPath, title: rendered.title });
  }
  if (!chapterFiles.length)
    fail("MOBI_EMPTY", "Kindle file contains no readable chapters");

  for (const img of images.values()) entries.set(img.path, img.bytes);
  const navItems = chapterFiles
    .map(
      (ch) =>
        `<li><a href="text/${escapeXml(ch.file)}">${escapeXml(ch.title)}</a></li>`,
    )
    .join("");
  const navStyleLinks = navStyles
    .map(
      (href) =>
        `<link rel="stylesheet" type="text/css" href="${escapeXml(href)}"/>`,
    )
    .join("");
  const navXhtml = `<?xml version="1.0" encoding="utf-8"?><html xmlns="${NS.xhtml}" xmlns:epub="${NS.epub}" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}"><head><title>${escapeXml(title)}</title>${navStyleLinks}</head><body><nav epub:type="toc" role="doc-toc" aria-label="Contents"><h1>Contents</h1><ol>${navItems}</ol></nav><nav epub:type="landmarks" aria-label="Landmarks"><h2>Landmarks</h2><ol><li><a epub:type="bodymatter" href="text/${escapeXml(chapterFiles[0].file)}">Start of text</a></li></ol></nav></body></html>`;
  entries.set("OEBPS/nav.xhtml", Buffer.from(navXhtml));
  const opf = buildKindleOpf({
    bytes,
    header,
    primary,
    metadata: {
      lang,
      title,
      authors,
      contributors,
      publisher,
      description,
      isbn,
      date,
      subjects,
      coverOffset,
    },
    entries,
    chapterFiles,
    images,
  });
  entries.set("OEBPS/package.opf", Buffer.from(opf));

  return {
    bytes: pack(entries, 946684800),
    format,
    ...(presetTheme ? { presetTheme } : {}),
    metadata: {
      title,
      language: lang,
      authors,
      publisher,
      description,
      isbn,
      date,
      chapters: chapterFiles.length,
      images: images.size,
    },
  };
}

export async function convertKindleToEpub(
  file: string,
  options: {
    output: string;
    theme?: BookTheme;
    reports?: string;
    signal?: AbortSignal;
  },
) {
  checkAbort(options.signal);
  if (!isKindlePath(file))
    fail("UNSUPPORTED_FORMAT", "Choose a .mobi or .azw3 source file");
  const output = path.resolve(options.output);
  if (path.extname(output).toLowerCase() !== ".epub")
    fail("UNSUPPORTED_FORMAT", "Output path must use the .epub extension");
  if (path.resolve(file) === output || (await exists(output)))
    fail(
      "OUTPUT_EXISTS",
      "Conversion output must be a new path; original file is protected",
    );
  const sourceBytes = await readSourceFile(file);
  const sourceSha256 = sha256(sourceBytes);
  const unpacked = unpackKindle(sourceBytes, { theme: options.theme });
  const repeated = unpackKindle(sourceBytes, { theme: options.theme });
  if (!unpacked.bytes.equals(repeated.bytes))
    fail(
      "NONDETERMINISTIC_BUILD",
      "Repeated Kindle-to-EPUB unpacking produced different bytes",
    );

  const reports = path.resolve(options.reports ?? output + ".reports");
  await fs.mkdir(reports, { recursive: true });
  const runId = randomUUID();
  const candidate = output + `.${runId}.candidate.epub`;
  try {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(candidate, unpacked.bytes, { flag: "wx" });
    const internal = validateInternal(unpacked.bytes);
    await json(path.join(reports, "diagnostics.json"), internal);
    if (internal.status !== "pass")
      fail(
        "KINDLE_VALIDATION",
        "Converted EPUB failed internal EPUB 3.3 policy checks",
        internal,
      );
    const validation = await checkEpubConformance(candidate, {
      reports,
      signal: options.signal,
    });
    if (validation.status !== "pass")
      fail(
        "KINDLE_VALIDATION",
        "Converted EPUB failed EPUBCheck validation",
        validation,
      );
    const reading = await readingQa(
      inspectBytes(unpacked.bytes, true),
      path.join(reports, "reading"),
      options.signal,
    );
    if (reading.status !== "pass")
      fail(
        "KINDLE_READING",
        "Converted EPUB failed browser reading verification",
        reading,
      );
    checkAbort(options.signal);
    if (sha256(await readSourceFile(file)) !== sourceSha256)
      fail("SOURCE_CHANGED", "Source file changed during conversion");
    await fs.link(candidate, output);
    const outputSha256 = sha256(unpacked.bytes);
    const result = {
      status: "pass" as const,
      operation: "kindle-to-epub",
      purpose: "format-conversion",
      format: unpacked.format,
      ...(unpacked.presetTheme ? { theme: unpacked.presetTheme } : {}),
      source: path.resolve(file),
      sourceSha256,
      output,
      outputSha256,
      metadata: unpacked.metadata,
      validation,
      reading,
      reproducible: true,
      publicationReady: false,
      releaseGates: "not-run",
      reports,
    };
    await json(path.join(reports, "import.json"), result);
    return result;
  } finally {
    await fs.rm(candidate, { force: true });
  }
}
