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

function decompressPalmDoc(data: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i++];
    if (b === 0x00) out.push(0x00);
    else if (b >= 0x01 && b <= 0x08) {
      for (let j = 0; j < b && i < data.length; j++) out.push(data[i++]);
    } else if (b <= 0x7f) out.push(b);
    else if (b >= 0xc0) {
      out.push(0x20, b ^ 0x80);
    } else {
      if (i >= data.length) break;
      const b2 = data[i++];
      const pair = ((b << 8) | b2) & 0x3fff;
      const distance = pair >>> 3;
      const length = (pair & 0x07) + 3;
      if (distance === 0 || distance > out.length)
        fail("MOBI_INVALID", "Corrupt PalmDOC LZ77 back-reference");
      for (let j = 0; j < length; j++) out.push(out[out.length - distance]);
    }
  }
  return Buffer.from(out);
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
  const huff = records[huffIndex];
  if (huff.subarray(0, 4).toString("ascii") !== "HUFF")
    fail("MOBI_INVALID", "Invalid HUFF header");
  const off1 = huff.readUInt32BE(8),
    off2 = huff.readUInt32BE(12);
  const dict1: { codelen: number; term: boolean; maxcode: number }[] = [];
  for (let i = 0; i < 256; i++) {
    const v = huff.readUInt32BE(off1 + i * 4);
    const codelen = v & 0x1f,
      term = (v & 0x80) !== 0;
    let maxcode = v >>> 8;
    if (codelen > 0) maxcode = ((maxcode + 1) << (32 - codelen)) - 1;
    dict1.push({ codelen, term, maxcode: maxcode >>> 0 });
  }
  const mincodes = [0],
    maxcodes = [0];
  for (let len = 1; len <= 32; len++) {
    const min = huff.readUInt32BE(off2 + (len - 1) * 8);
    const max = huff.readUInt32BE(off2 + (len - 1) * 8 + 4);
    mincodes.push((min << (32 - len)) >>> 0);
    maxcodes.push((((max + 1) << (32 - len)) - 1) >>> 0);
  }
  const dictionary: { slice: Buffer; final: boolean }[] = [];
  for (let c = 1; c < huffCount; c++) {
    const cdic = records[huffIndex + c];
    if (cdic.subarray(0, 4).toString("ascii") !== "CDIC")
      fail("MOBI_INVALID", "Invalid CDIC record");
    const headerLen = cdic.readUInt32BE(4),
      numEntries = cdic.readUInt32BE(8);
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
  const chunks: Buffer[] = [];
  const unpackSlice = (data: Buffer, depth = 0) => {
    if (depth > 32) fail("MOBI_INVALID", "HUFF/CDIC recursion limit exceeded");
    let bitsLeft = data.length * 8;
    const padded = Buffer.concat([data, Buffer.alloc(8)]);
    let pos = 0;
    const read32 = (bitOffset: number): number => {
      const bytePos = bitOffset >>> 3,
        shift = bitOffset & 7;
      const hi = padded.readUInt32BE(bytePos);
      if (shift === 0) return hi;
      const lo = padded[bytePos + 4];
      return ((hi << shift) | (lo >>> (8 - shift))) >>> 0;
    };
    while (bitsLeft > 0) {
      const dw = read32(pos);
      let { codelen, term, maxcode } = dict1[dw >>> 24];
      if (!term) {
        while (codelen < 32 && dw < mincodes[codelen]) codelen++;
        maxcode = maxcodes[codelen];
      }
      if (codelen === 0 || (bitsLeft < codelen && bitsLeft < 8)) break;
      pos += codelen;
      bitsLeft -= codelen;
      const index = (maxcode - dw) >>> (32 - codelen);
      if (index >= dictionary.length)
        fail("MOBI_INVALID", "HUFF/CDIC dictionary index out of bounds");
      const entry = dictionary[index];
      if (entry.final) chunks.push(entry.slice);
      else unpackSlice(entry.slice, depth + 1);
    }
  };
  for (const rec of textRecords) unpackSlice(rec);
  return Buffer.concat(chunks);
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
    const type = rec0.readUInt32BE(pos),
      len = rec0.readUInt32BE(pos + 4);
    if (len < 8 || pos + len > rec0.length) break;
    const data = rec0.subarray(pos + 8, pos + len);
    pos += len;
    const str = () => data.toString(encoding).trim().normalize("NFC");
    if (type === 100 && str()) meta.authors.push(str());
    else if (type === 101 && str()) meta.publisher = str();
    else if (type === 103 && str()) meta.description = str();
    else if (type === 104 && str()) {
      const digits = str().replace(/[- ]/g, "");
      if (validIsbn(digits)) meta.isbn = digits;
    } else if (type === 105 && str()) meta.subjects.push(str());
    else if (type === 106 && str()) meta.date = str();
    else if (type === 108 && str() && !/^calibre\b/i.test(str()))
      meta.contributors.push(str());
    else if (type === 113 && str()) meta.uuid = str();
    else if (type === 121 && data.length === 4)
      meta.kf8Boundary = data.readUInt32BE(0);
    else if (type === 201 && data.length === 4)
      meta.coverOffset = data.readUInt32BE(0);
    else if (type === 503 && str()) meta.title = str();
    else if (type === 524 && str()) meta.language = str();
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
  const raw = (lang ?? "").trim().replace(/_/g, "-");
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
          const idx = parseInt(id, 32);
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

function serializeCleanXhtml(
  rawHtml: string,
  options: {
    lang: string;
    defaultTitle: string;
    stylesheets: string[];
    images: Map<number, { file: string }>;
    resolveHref: (href: string, filepos?: string) => string | undefined;
  },
): { xhtml: string; title: string; isGeneratedToc: boolean } | null {
  const $ = load(rawHtml);
  const isGeneratedToc =
    $("#calibre_generated_inline_toc").length > 0 ||
    $("body").attr("id") === "calibre_generated_inline_toc";
  $(
    "script, style, meta, base, iframe, object, embed, form, input, video, audio",
  ).remove();
  // Convert MOBI 6 <p><font size="7|6|5"><b>Heading</b></font></p> into semantic headings
  $("p, div").each((_, el) => {
    const node = $(el);
    const children = node
      .contents()
      .filter((__, c) => c.type !== "text" || !!(c.data ?? "").trim());
    if (children.length === 1 && children[0].type === "tag") {
      const first = $(children[0]);
      if (first.is("font")) {
        const size = Number(first.attr("size") ?? "0");
        const text = first.text().trim();
        if (text && size >= 5) {
          const tag = size >= 6 ? "h1" : "h2";
          const idAttr = node.attr("id") || first.attr("id");
          node.replaceWith(
            `<${tag}${idAttr ? ` id="${escapeXml(idAttr)}"` : ""}>${escapeXml(text)}</${tag}>`,
          );
        }
      }
    }
  });
  // Unwrap remaining <font>, <center>, <mbp:*> wrappers while keeping their children
  for (let pass = 0; pass < 3; pass++) {
    $("font, center, strike, u").each((_, el) => {
      $(el).replaceWith($(el).contents());
    });
  }
  const usedIds = new Set<string>();
  let h1Count = 0;
  let linkCount = 0;
  let detectedTitle = "";
  const allowedTags = new Set([
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
  const renderChildren = (nodes: {
    contents: () => ReturnType<typeof $>;
  }): string => {
    const parts: string[] = [];
    nodes.contents().each((_, child) => {
      if (child.type === "text") {
        parts.push(escapeXml(child.data ?? ""));
        return;
      }
      if (child.type !== "tag") return;
      let tag = (child.tagName ?? "").toLowerCase();
      if (tag.includes(":") || tag === "mbp:pagebreak") return;
      if (!allowedTags.has(tag)) tag = "span";
      const el = $(child);
      if (/^h[1-6]$/.test(tag)) {
        if (!detectedTitle && el.text().trim())
          detectedTitle = el.text().trim();
        if (tag === "h1") h1Count++;
        else if (h1Count === 0) {
          tag = "h1";
          h1Count++;
        } else if (Number(tag[1]) > 2) tag = "h2";
      }
      const attrs: string[] = [];
      const rawId = (el.attr("id") || el.attr("name") || "").trim();
      if (
        rawId &&
        /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(rawId) &&
        !usedIds.has(rawId)
      ) {
        usedIds.add(rawId);
        attrs.push(`id="${escapeXml(rawId)}"`);
      }
      if (tag === "img") {
        let imgIdx: number | undefined;
        const recindex = el.attr("recindex");
        const src = el.attr("src") ?? "";
        const embedMatch = /^kindle:embed:([0-9A-Za-z]{4})/i.exec(src);
        if (recindex && /^\d+$/.test(recindex)) imgIdx = Number(recindex);
        else if (embedMatch) imgIdx = parseInt(embedMatch[1], 32);
        else if (options.images.size === 1) imgIdx = 1;
        const img = imgIdx ? options.images.get(imgIdx) : undefined;
        if (!img) return;
        const alt = (el.attr("alt") ?? "").trim() || "Illustration";
        attrs.push(
          `src="../images/${escapeXml(img.file)}"`,
          `alt="${escapeXml(alt)}"`,
        );
        parts.push(`<img ${attrs.join(" ")}/>`);
        return;
      }
      if (tag === "br" || tag === "hr") {
        parts.push(`<${tag}${attrs.length ? " " + attrs.join(" ") : ""}/>`);
        return;
      }
      const inner = renderChildren(el);
      if (tag === "a") {
        const resolved = options.resolveHref(
          el.attr("href") ?? "",
          el.attr("filepos"),
        );
        if (!resolved || !inner.trim()) {
          if (attrs.length)
            parts.push(`<span ${attrs.join(" ")}>${inner}</span>`);
          else parts.push(inner);
          return;
        }
        if (
          !attrs.some((a) => a.startsWith('id="')) &&
          !/^(?:https?:|mailto:)/i.test(resolved)
        ) {
          let linkId = `link-${++linkCount}`;
          while (usedIds.has(linkId)) linkId = `link-${++linkCount}`;
          usedIds.add(linkId);
          attrs.push(`id="${linkId}"`);
        }
        attrs.push(`href="${escapeXml(resolved)}"`);
      }
      parts.push(
        `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>${inner}</${tag}>`,
      );
    });
    return parts.join("");
  };

  $("span[id^='filepos-']").each((_, span) => {
    const s = $(span);
    if (!s.text().trim() && s.children().length === 0) {
      const next = s.next();
      if (next.length && !next.attr("id")) {
        next.attr("id", s.attr("id")!);
        s.remove();
      } else if (
        s.parent().length &&
        !s.parent().is("body, html") &&
        !s.parent().attr("id")
      ) {
        s.parent().attr("id", s.attr("id")!);
        s.remove();
      }
    }
  });
  const bodyRoot = $("body").length ? $("body") : $.root();
  let bodyContent = renderChildren(bodyRoot).trim();
  if (!bodyContent) return null;
  const title =
    detectedTitle || $("title").first().text().trim() || options.defaultTitle;
  // Ensure block-level root children inside <body> for valid XHTML & split units
  if (
    !/<(?:h[1-6]|p|div|section|article|blockquote|ul|ol|dl|pre|aside)\b/.test(
      bodyContent,
    )
  ) {
    bodyContent = `<p>${bodyContent}</p>`;
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

export function unpackKindle(bytes: Uint8Array): {
  bytes: Buffer;
  format: KindleFormat;
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
  const primary = parseRecord0(records[0]);
  let header = primary;
  let recordOffset = 0;
  let format: KindleFormat = primary.version >= 8 ? "kf8" : "mobi6";
  if (
    primary.version < 8 &&
    primary.exth.kf8Boundary !== undefined &&
    primary.exth.kf8Boundary + 1 < records.length &&
    records[primary.exth.kf8Boundary]
      .subarray(0, 8)
      .toString("ascii")
      .startsWith("BOUNDARY")
  ) {
    recordOffset = primary.exth.kf8Boundary + 1;
    header = parseRecord0(records[recordOffset]);
    format = "combo-kf8";
  }

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
    rawText = rawText.subarray(0, header.textLength);

  // Extract image records
  const imgStart =
    header.firstImageIndex !== 0xffffffff &&
    recordOffset + header.firstImageIndex < records.length
      ? recordOffset + header.firstImageIndex
      : primary.firstImageIndex !== 0xffffffff &&
          primary.firstImageIndex < records.length
        ? primary.firstImageIndex
        : records.length;
  const images = new Map<
    number,
    {
      index: number;
      file: string;
      path: string;
      mediaType: string;
      bytes: Buffer;
    }
  >();
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
  entries.set("OEBPS/styles/reading.css", Buffer.from(readingCss));
  const stylesheets = ["../styles/reading.css"];

  let rawChapters: string[] = [];
  const fidTargets = new Map<string, { chapterIdx: number; id?: string }>();
  const fileposTargets = new Map<number, { chapterIdx: number; id: string }>();

  if (header.version >= 8) {
    let flows = [rawText];
    if (
      header.fdstIndex !== 0xffffffff &&
      recordOffset + header.fdstIndex < records.length
    ) {
      const fdst = records[recordOffset + header.fdstIndex];
      if (
        fdst.length >= 12 &&
        fdst.subarray(0, 4).toString("ascii") === "FDST"
      ) {
        const hlen = fdst.readUInt32BE(4),
          nflows = fdst.readUInt32BE(8);
        const sliced: Buffer[] = [];
        for (let i = 0; i < nflows && hlen + (i + 1) * 8 <= fdst.length; i++) {
          const s = fdst.readUInt32BE(hlen + i * 8),
            e = fdst.readUInt32BE(hlen + i * 8 + 4);
          if (s <= e && e <= rawText.length)
            sliced.push(rawText.subarray(s, e));
        }
        if (sliced.length) flows = sliced;
      }
    }
    for (let f = 1; f < flows.length; f++) {
      const cleanCss = sanitizeStylesheet(flows[f].toString(encoding), images);
      if (cleanCss.trim()) {
        const name = `flow-${String(f).padStart(4, "0")}.css`;
        entries.set(`OEBPS/styles/${name}`, Buffer.from(cleanCss));
        stylesheets.push(`../styles/${name}`);
      }
    }
    const flow0Str = flows[0].toString(encoding);
    const parts = flow0Str
      .split(/(?=<\?xml\s)/i)
      .map((s) => s.trim())
      .filter(Boolean);
    rawChapters = parts.map((part, idx) => {
      const closeIdx = part.search(/<\/body>\s*<\/html>/i);
      if (closeIdx < 0) return part;
      const closeMatch = /<\/body>\s*<\/html>\s*/i.exec(part.slice(closeIdx))!;
      const skelEnd = closeIdx + closeMatch.index + closeMatch[0].length;
      const skel = part.slice(0, skelEnd);
      const frag = part.slice(skelEnd);
      const fragBuf = Buffer.from(frag, encoding);
      // Scan all kindle:pos:fid:XXXX:off:YYYYYYYYYY references in flow0 targeting this fid
      const fidCode = idx.toString(32).toUpperCase().padStart(4, "0");
      const posRegex = new RegExp(
        `kindle:pos:fid:${fidCode}:off:([0-9A-Za-z]{10})`,
        "gi",
      );
      let m: RegExpExecArray | null;
      while ((m = posRegex.exec(flow0Str)) !== null) {
        const off = parseInt(m[1], 32);
        const key = `${idx}:${off}`;
        if (fidTargets.has(key)) continue;
        if (off === 0) {
          fidTargets.set(key, { chapterIdx: idx });
        } else if (off < fragBuf.length) {
          const tail = fragBuf.subarray(off).toString(encoding);
          const idMatch = /^<[^>]*?\bid=["']([^"']+)["']/i.exec(tail);
          if (idMatch) fidTargets.set(key, { chapterIdx: idx, id: idMatch[1] });
          else fidTargets.set(key, { chapterIdx: idx });
        }
      }
      if (!frag.trim()) return skel;
      return skel.slice(0, closeIdx) + frag + skel.slice(closeIdx);
    });
  } else {
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
    rawChapters = annotated
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
  }

  // First pass: identify which raw chapters are real content vs generated inline TOC
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
  const rawToFinalIdx = new Map<number, number>(
    activeIndices.map((rawIdx, finalIdx) => [rawIdx, finalIdx]),
  );

  const chapterFiles: {
    id: string;
    file: string;
    path: string;
    title: string;
  }[] = [];
  for (const [finalIdx, rawIdx] of activeIndices.entries()) {
    const file = `c${String(finalIdx + 1).padStart(4, "0")}.xhtml`;
    const resolveHref = (
      href: string,
      filepos?: string,
    ): string | undefined => {
      if (filepos && /^\d+$/.test(filepos)) {
        const target = fileposTargets.get(Number(filepos));
        if (!target) return undefined;
        const destIdx = rawToFinalIdx.get(target.chapterIdx);
        if (destIdx === undefined) return undefined;
        const destFile = `c${String(destIdx + 1).padStart(4, "0")}.xhtml`;
        return destIdx === finalIdx
          ? `#${target.id}`
          : `${destFile}#${target.id}`;
      }
      const posMatch =
        /^kindle:pos:fid:([0-9A-Za-z]{4}):off:([0-9A-Za-z]{10})/i.exec(href);
      if (posMatch) {
        const fid = parseInt(posMatch[1], 32),
          off = parseInt(posMatch[2], 32);
        const target = fidTargets.get(`${fid}:${off}`) ?? { chapterIdx: fid };
        const destIdx = rawToFinalIdx.get(target.chapterIdx);
        if (destIdx === undefined) return undefined;
        const destFile = `c${String(destIdx + 1).padStart(4, "0")}.xhtml`;
        if (!target.id) return destIdx === finalIdx ? "#" : destFile;
        return destIdx === finalIdx
          ? `#${target.id}`
          : `${destFile}#${target.id}`;
      }
      if (/^https?:\/\/|^mailto:/i.test(href) || href.startsWith("#"))
        return href;
      return undefined;
    };
    const rendered = serializeCleanXhtml(rawChapters[rawIdx], {
      lang,
      defaultTitle: `${title} - ${finalIdx + 1}`,
      stylesheets,
      images,
      resolveHref,
    });
    if (!rendered) continue;
    const id = `c${String(finalIdx + 1).padStart(4, "0")}`;
    const fullPath = `OEBPS/text/${file}`;
    entries.set(fullPath, Buffer.from(rendered.xhtml));
    chapterFiles.push({ id, file, path: fullPath, title: rendered.title });
  }
  if (!chapterFiles.length)
    fail("MOBI_EMPTY", "Kindle file contains no readable chapters");

  // Optional cover page if coverOffset points to a valid image
  const coverImageEntry =
    coverOffset !== undefined ? images.get(coverOffset + 1) : undefined;

  for (const img of images.values()) entries.set(img.path, img.bytes);

  const navItems = chapterFiles
    .map(
      (ch) =>
        `<li><a href="text/${escapeXml(ch.file)}">${escapeXml(ch.title)}</a></li>`,
    )
    .join("");
  const navXhtml = `<?xml version="1.0" encoding="utf-8"?><html xmlns="${NS.xhtml}" xmlns:epub="${NS.epub}" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}"><head><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="styles/reading.css"/></head><body><nav epub:type="toc" role="doc-toc" aria-label="Contents"><h1>Contents</h1><ol>${navItems}</ol></nav><nav epub:type="landmarks" aria-label="Landmarks"><h2>Landmarks</h2><ol><li><a epub:type="bodymatter" href="text/${escapeXml(chapterFiles[0].file)}">Start of text</a></li></ol></nav></body></html>`;
  entries.set("OEBPS/nav.xhtml", Buffer.from(navXhtml));

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
    ...(isbn
      ? [
          `<dc:identifier id="isbn">${escapeXml(isbn)}</dc:identifier>`,
          `<meta refines="#isbn" property="identifier-type" scheme="onix:codelist5">15</meta>`,
        ]
      : []),
    `<dc:title>${escapeXml(title)}</dc:title>`,
    `<dc:language>${escapeXml(lang)}</dc:language>`,
    ...(authors.length ? authors : ["Unknown"]).map(
      (a) => `<dc:creator>${escapeXml(a)}</dc:creator>`,
    ),
    ...contributors.map(
      (c) => `<dc:contributor>${escapeXml(c)}</dc:contributor>`,
    ),
    ...(publisher
      ? [`<dc:publisher>${escapeXml(publisher)}</dc:publisher>`]
      : []),
    ...(description
      ? [`<dc:description>${escapeXml(description)}</dc:description>`]
      : []),
    ...subjects.map((s) => `<dc:subject>${escapeXml(s)}</dc:subject>`),
    ...(date ? [`<dc:date>${escapeXml(date)}</dc:date>`] : []),
    `<meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>`,
    `<meta property="schema:accessMode">textual</meta>`,
    `<meta property="schema:accessModeSufficient">textual</meta>`,
    `<meta property="schema:accessibilityFeature">tableOfContents</meta>`,
    `<meta property="schema:accessibilityHazard">none</meta>`,
    `<meta property="schema:accessibilitySummary">Converted from Kindle format with preserved text and navigation; accessibility has not been certified.</meta>`,
  ];
  const manifestParts: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="reading-css" href="styles/reading.css" media-type="text/css"/>`,
    ...[...entries.keys()]
      .filter((k) => k.startsWith("OEBPS/styles/flow-"))
      .map((k, i) => {
        const rel = k.slice("OEBPS/".length);
        return `<item id="css-${i + 1}" href="${escapeXml(rel)}" media-type="text/css"/>`;
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
  const opf = `<?xml version="1.0" encoding="utf-8"?><package xmlns="${NS.opf}" xmlns:dc="${NS.dc}" version="3.0" unique-identifier="uid" xml:lang="${escapeXml(lang)}"><metadata>${metaParts.join("")}</metadata><manifest>${manifestParts.join("")}</manifest><spine>${spineParts.join("")}</spine></package>`;
  entries.set("OEBPS/package.opf", Buffer.from(opf));

  return {
    bytes: pack(entries, 946684800),
    format,
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
  options: { output: string; reports?: string; signal?: AbortSignal },
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
  const unpacked = unpackKindle(sourceBytes);
  const repeated = unpackKindle(sourceBytes);
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
