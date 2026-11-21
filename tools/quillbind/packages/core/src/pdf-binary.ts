import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import * as cheerio from "cheerio";
import sharp from "sharp";
import { checkAbort, fail } from "./errors.js";
import { exists, readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { json } from "./json.js";
import { run } from "./process.js";
import {
  PDF_SPEC_SCHEMA_VERSION,
  pageRequiresOcrVerification,
  type OcrTrust,
  type PdfBlock,
  type PdfClassification,
  type PdfFootnoteItem,
  type PdfImageInventoryItem,
  type PdfInlineRun,
  type PdfInspectionReport,
  type PdfLineGeometry,
  type PdfOutlineNode,
  type PdfPageSummary,
  type PdfRenderedPage,
  type PdfRenderManifest,
  type PdfRenderTile,
  type PdfRotate,
  type PdfShardRange,
  type PdfSpecPage,
} from "./pdf-model.js";

export function isPdfPath(file: string): boolean {
  return path.extname(file).toLowerCase() === ".pdf";
}

export function isPdfBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

/**
 * Normalize Kangxi radicals (U+2F00..U+2FDF), CJK compatibility ideographs,
 * and Latin typographic ligatures via NFKC while preserving fullwidth CJK
 * punctuation and circled footnote markers.
 */
export function normalizeExtractedPdfText(text: string): string {
  return text.replace(
    /[\u2F00-\u2FDF\uF900-\uFAFF\uFB00-\uFB06\u{2F800}-\u{2FA1F}]/gu,
    (ch) => ch.normalize("NFKC"),
  );
}

export type PdfRef = { kind: "ref"; num: number; gen: number };
export type PdfName = { kind: "name"; value: string };
export type PdfStr = { kind: "str"; raw: Buffer; hex: boolean };
export type PdfDict = { kind: "dict"; entries: Map<string, PdfVal> };
export type PdfStream = { kind: "stream"; dict: PdfDict; rawData: Buffer };
export type PdfVal =
  | null
  | boolean
  | number
  | PdfName
  | PdfStr
  | PdfRef
  | PdfVal[]
  | PdfDict
  | PdfStream;

export type XrefEntry =
  | { type: "uncompressed"; offset: number; gen: number }
  | { type: "compressed"; objStm: number; index: number };

const PDF_DOC_ENCODING: Record<number, number> = {
  0x80: 0x2022,
  0x81: 0x2020,
  0x82: 0x2021,
  0x83: 0x2026,
  0x84: 0x2014,
  0x85: 0x2013,
  0x86: 0x0192,
  0x87: 0x2044,
  0x88: 0x2039,
  0x89: 0x203a,
  0x8a: 0x2212,
  0x8b: 0x2030,
  0x8c: 0x201e,
  0x8d: 0x201c,
  0x8e: 0x201d,
  0x8f: 0x2018,
  0x90: 0x2019,
  0x91: 0x201a,
  0x92: 0x2122,
  0x93: 0xfb01,
  0x94: 0xfb02,
  0x95: 0x0141,
  0x96: 0x0152,
  0x97: 0x0160,
  0x98: 0x0178,
  0x99: 0x017d,
  0x9a: 0x0131,
  0x9b: 0x0142,
  0x9c: 0x0153,
  0x9d: 0x0161,
  0x9e: 0x017e,
  0xa0: 0x20ac,
};

function isWhite(b: number): boolean {
  return (
    b === 0x00 ||
    b === 0x09 ||
    b === 0x0a ||
    b === 0x0c ||
    b === 0x0d ||
    b === 0x20
  );
}

function isDelim(b: number): boolean {
  return (
    b === 0x28 ||
    b === 0x29 ||
    b === 0x3c ||
    b === 0x3e ||
    b === 0x5b ||
    b === 0x5d ||
    b === 0x7b ||
    b === 0x7d ||
    b === 0x2f ||
    b === 0x25
  );
}

class PdfTokenizer {
  pos: number;
  readonly buf: Buffer;

  constructor(buf: Buffer, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  skipWsAndComments(): void {
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos];
      if (isWhite(b)) {
        this.pos++;
      } else if (b === 0x25) {
        while (
          this.pos < this.buf.length &&
          this.buf[this.pos] !== 0x0a &&
          this.buf[this.pos] !== 0x0d
        ) {
          this.pos++;
        }
      } else {
        break;
      }
    }
  }

  peekWord(): string {
    const saved = this.pos;
    this.skipWsAndComments();
    const start = this.pos;
    while (
      this.pos < this.buf.length &&
      !isWhite(this.buf[this.pos]) &&
      !isDelim(this.buf[this.pos])
    ) {
      this.pos++;
    }
    const word = this.buf.subarray(start, this.pos).toString("latin1");
    this.pos = saved;
    return word;
  }

  readValue(): PdfVal | undefined {
    this.skipWsAndComments();
    if (this.pos >= this.buf.length) return undefined;
    const b = this.buf[this.pos];

    if (b === 0x2f) return this.readName();
    if (b === 0x28) return this.readLiteralString();
    if (b === 0x3c) return this.readAngleBracket();
    if (b === 0x5b) return this.readArray();
    return this.readAtom();
  }

  private readName(): PdfName {
    this.pos++;
    const bytes: number[] = [];
    while (
      this.pos < this.buf.length &&
      !isWhite(this.buf[this.pos]) &&
      !isDelim(this.buf[this.pos])
    ) {
      if (
        this.buf[this.pos] === 0x23 &&
        this.pos + 2 < this.buf.length &&
        /^[0-9a-fA-F]{2}$/.test(
          this.buf.subarray(this.pos + 1, this.pos + 3).toString("ascii"),
        )
      ) {
        bytes.push(
          Number.parseInt(
            this.buf.subarray(this.pos + 1, this.pos + 3).toString("ascii"),
            16,
          ),
        );
        this.pos += 3;
      } else {
        bytes.push(this.buf[this.pos++]);
      }
    }
    return { kind: "name", value: Buffer.from(bytes).toString("utf8") };
  }

  private readLiteralString(): PdfStr {
    this.pos++;
    let depth = 1;
    const out: number[] = [];
    while (this.pos < this.buf.length && depth > 0) {
      const ch = this.buf[this.pos++];
      if (ch === 0x5c) {
        if (this.pos >= this.buf.length) break;
        const esc = this.buf[this.pos++];
        if (esc === 0x6e) out.push(0x0a);
        else if (esc === 0x72) out.push(0x0d);
        else if (esc === 0x74) out.push(0x09);
        else if (esc === 0x62) out.push(0x08);
        else if (esc === 0x66) out.push(0x0c);
        else if (esc === 0x0a) continue;
        else if (esc === 0x0d) {
          if (this.buf[this.pos] === 0x0a) this.pos++;
        } else if (esc >= 0x30 && esc <= 0x37) {
          let oct = esc - 0x30;
          for (let k = 0; k < 2 && this.pos < this.buf.length; k++) {
            const d = this.buf[this.pos];
            if (d >= 0x30 && d <= 0x37) {
              oct = (oct << 3) | (d - 0x30);
              this.pos++;
            } else break;
          }
          out.push(oct & 0xff);
        } else out.push(esc);
      } else if (ch === 0x28) {
        depth++;
        out.push(ch);
      } else if (ch === 0x29) {
        depth--;
        if (depth > 0) out.push(ch);
      } else {
        out.push(ch);
      }
    }
    return { kind: "str", raw: Buffer.from(out), hex: false };
  }

  private readAngleBracket(): PdfDict | PdfStr {
    if (this.buf[this.pos + 1] === 0x3c) {
      this.pos += 2;
      const entries = new Map<string, PdfVal>();
      while (this.pos < this.buf.length) {
        this.skipWsAndComments();
        if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
          this.pos += 2;
          break;
        }
        const key = this.readValue();
        if (
          !key ||
          typeof key !== "object" ||
          Array.isArray(key) ||
          key.kind !== "name"
        ) {
          break;
        }
        const val = this.readValue();
        if (val !== undefined) entries.set(key.value, val);
      }
      return { kind: "dict", entries };
    }
    this.pos++;
    let hex = "";
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const ch = this.buf[this.pos++];
      if (!isWhite(ch)) hex += String.fromCharCode(ch);
    }
    if (this.buf[this.pos] === 0x3e) this.pos++;
    if (hex.length % 2 === 1) hex += "0";
    return { kind: "str", raw: Buffer.from(hex, "hex"), hex: true };
  }

  private readArray(): PdfVal[] {
    this.pos++;
    const arr: PdfVal[] = [];
    while (this.pos < this.buf.length) {
      this.skipWsAndComments();
      if (this.buf[this.pos] === 0x5d) {
        this.pos++;
        break;
      }
      const item = this.readValue();
      if (item === undefined) break;
      arr.push(item);
    }
    return arr;
  }

  private readAtom(): PdfVal | undefined {
    const start = this.pos;
    while (
      this.pos < this.buf.length &&
      !isWhite(this.buf[this.pos]) &&
      !isDelim(this.buf[this.pos])
    ) {
      this.pos++;
    }
    const token = this.buf.subarray(start, this.pos).toString("latin1");
    if (!token) {
      this.pos++;
      return undefined;
    }
    if (token === "null") return null;
    if (token === "true") return true;
    if (token === "false") return false;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      const n = Number(token);
      if (Number.isInteger(n) && n >= 0 && !token.includes(".")) {
        const saved = this.pos;
        const second = this.readNumberToken();
        if (
          second !== undefined &&
          Number.isInteger(second) &&
          second >= 0 &&
          this.peekWord() === "R"
        ) {
          this.skipWsAndComments();
          this.pos += 1;
          return { kind: "ref", num: n, gen: second };
        }
        this.pos = saved;
      }
      return n;
    }
    return { kind: "name", value: token };
  }

  private readNumberToken(): number | undefined {
    this.skipWsAndComments();
    const start = this.pos;
    while (
      this.pos < this.buf.length &&
      !isWhite(this.buf[this.pos]) &&
      !isDelim(this.buf[this.pos])
    ) {
      this.pos++;
    }
    const token = this.buf.subarray(start, this.pos).toString("latin1");
    return /^\d+$/.test(token) ? Number(token) : undefined;
  }
}

export function dictGet(
  dict: PdfDict | undefined,
  key: string,
): PdfVal | undefined {
  return dict?.entries.get(key);
}

export function asName(val: PdfVal | undefined): string | undefined {
  return val &&
    typeof val === "object" &&
    !Array.isArray(val) &&
    val.kind === "name"
    ? val.value
    : undefined;
}

export function asNum(val: PdfVal | undefined): number | undefined {
  return typeof val === "number" ? val : undefined;
}

export function asArr(val: PdfVal | undefined): PdfVal[] | undefined {
  return Array.isArray(val) ? val : undefined;
}

export function asDict(val: PdfVal | undefined): PdfDict | undefined {
  if (!val || typeof val !== "object" || Array.isArray(val)) return undefined;
  if (val.kind === "dict") return val;
  if (val.kind === "stream") return val.dict;
  return undefined;
}

export function asRef(val: PdfVal | undefined): PdfRef | undefined {
  return val &&
    typeof val === "object" &&
    !Array.isArray(val) &&
    val.kind === "ref"
    ? val
    : undefined;
}

export function decodePdfString(val: PdfVal | undefined): string | undefined {
  if (
    !val ||
    typeof val !== "object" ||
    Array.isArray(val) ||
    val.kind !== "str"
  ) {
    return undefined;
  }
  const raw = val.raw;
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < raw.length; i += 2) {
      out += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
    }
    return out;
  }
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return raw.subarray(2).toString("utf16le");
  }
  let out = "";
  for (const byte of raw) {
    out += String.fromCharCode(PDF_DOC_ENCODING[byte] ?? byte);
  }
  return out;
}

function applyPngPredictor(
  data: Buffer,
  predictor: number,
  columns: number,
  colors = 1,
  bpc = 8,
): Buffer {
  if (predictor <= 1) return data;
  if (predictor >= 10 && predictor <= 15) {
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rowBytes = Math.ceil((columns * colors * bpc) / 8);
    const stride = rowBytes + 1;
    const rows = Math.floor(data.length / stride);
    const out = Buffer.alloc(rows * rowBytes);
    let prev = Buffer.alloc(rowBytes);
    for (let r = 0; r < rows; r++) {
      const filter = data[r * stride];
      const cur = Buffer.alloc(rowBytes);
      for (let i = 0; i < rowBytes; i++) {
        const raw = data[r * stride + 1 + i] ?? 0;
        const left = i >= bpp ? cur[i - bpp] : 0;
        const up = prev[i] ?? 0;
        const upLeft = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
        if (filter === 0) cur[i] = raw;
        else if (filter === 1) cur[i] = (raw + left) & 0xff;
        else if (filter === 2) cur[i] = (raw + up) & 0xff;
        else if (filter === 3) {
          cur[i] = (raw + Math.floor((left + up) / 2)) & 0xff;
        } else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          cur[i] = (raw + pr) & 0xff;
        } else {
          cur[i] = raw;
        }
      }
      cur.copy(out, r * rowBytes);
      prev = cur;
    }
    return out;
  }
  return data;
}

function ascii85Decode(input: Buffer): Buffer {
  const out: number[] = [];
  let tuple: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === 0x7e) break;
    if (isWhite(c)) continue;
    if (c === 0x7a && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    tuple.push(c - 0x21);
    if (tuple.length === 5) {
      let val = 0;
      for (const d of tuple) val = val * 85 + d;
      out.push(
        (val >>> 24) & 0xff,
        (val >>> 16) & 0xff,
        (val >>> 8) & 0xff,
        val & 0xff,
      );
      tuple = [];
    }
  }
  if (tuple.length > 1) {
    const count = tuple.length - 1;
    while (tuple.length < 5) tuple.push(84);
    let val = 0;
    for (const d of tuple) val = val * 85 + d;
    const tail = [
      (val >>> 24) & 0xff,
      (val >>> 16) & 0xff,
      (val >>> 8) & 0xff,
      val & 0xff,
    ];
    for (let i = 0; i < count; i++) out.push(tail[i]);
  }
  return Buffer.from(out);
}

export class PdfDocumentParser {
  readonly buf: Buffer;
  readonly version: string;
  readonly xref = new Map<number, XrefEntry>();
  readonly cache = new Map<number, PdfVal>();
  readonly objStmCache = new Map<number, Map<number, PdfVal>>();
  trailer: PdfDict = { kind: "dict", entries: new Map() };
  maxObjNum = 0;
  startXrefOffset = 0;
  usesXrefStream = false;

  constructor(bytes: Uint8Array) {
    this.buf = Buffer.from(bytes);
    const headerSlice = this.buf
      .subarray(0, Math.min(1024, this.buf.length))
      .toString("latin1");
    const m = /%PDF-(\d+\.\d+)/.exec(headerSlice);
    if (!m) fail("PDF_INVALID", "File does not contain a valid %PDF- header");
    this.version = m[1];
    this.loadStructure();
    for (const num of this.xref.keys()) {
      if (num > this.maxObjNum) this.maxObjNum = num;
    }
    if (dictGet(this.trailer, "Encrypt") !== undefined) {
      fail(
        "PDF_ENCRYPTED",
        "Encrypted or DRM-protected PDFs are not supported",
      );
    }
  }

  private loadStructure(): void {
    const tailLen = Math.min(this.buf.length, 4096);
    const tail = this.buf
      .subarray(this.buf.length - tailLen)
      .toString("latin1");
    const matches = [...tail.matchAll(/startxref\s+(\d+)/g)];
    if (matches.length > 0) {
      const startOffset = Number(matches[matches.length - 1][1]);
      if (startOffset > 0 && startOffset < this.buf.length) {
        this.startXrefOffset = startOffset;
        try {
          this.parseXrefChain(startOffset, new Set(), true);
          if (this.xref.size > 0 && dictGet(this.trailer, "Root")) return;
        } catch (err) {
          if ((err as { code?: string }).code === "PDF_ENCRYPTED") throw err;
        }
      }
    }
    this.fallbackScanObjects();
  }

  private mergeTrailer(tr: PdfDict): void {
    if (this.trailer.entries.size === 0) {
      this.trailer = tr;
      return;
    }
    for (const [k, v] of tr.entries) {
      if (!this.trailer.entries.has(k)) this.trailer.entries.set(k, v);
    }
  }

  private parseXrefChain(
    offset: number,
    visited: Set<number>,
    isLatest: boolean,
  ): void {
    if (visited.has(offset) || offset < 0 || offset >= this.buf.length) return;
    visited.add(offset);
    const tok = new PdfTokenizer(this.buf, offset);
    if (tok.peekWord() === "xref") {
      if (isLatest) this.usesXrefStream = false;
      tok.readValue();
      while (tok.pos < this.buf.length) {
        tok.skipWsAndComments();
        if (tok.peekWord() === "trailer") {
          tok.readValue();
          const tr = asDict(tok.readValue());
          if (tr) {
            this.mergeTrailer(tr);
            const xrefStm = asNum(dictGet(tr, "XRefStm"));
            if (xrefStm !== undefined)
              this.parseXrefChain(xrefStm, visited, false);
            const prev = asNum(dictGet(tr, "Prev"));
            if (prev !== undefined) this.parseXrefChain(prev, visited, false);
          }
          break;
        }
        const first = tok.readValue();
        const count = tok.readValue();
        if (typeof first !== "number" || typeof count !== "number") break;
        for (let i = 0; i < count; i++) {
          const off = tok.readValue();
          const gen = tok.readValue();
          const flag = asName(tok.readValue());
          if (typeof off !== "number" || typeof gen !== "number" || !flag)
            break;
          const objNum = first + i;
          if (flag === "n" && !this.xref.has(objNum)) {
            this.xref.set(objNum, { type: "uncompressed", offset: off, gen });
          }
        }
      }
      return;
    }

    const parsed = this.readIndirectAt(offset);
    if (
      !parsed ||
      typeof parsed.val !== "object" ||
      parsed.val === null ||
      Array.isArray(parsed.val) ||
      parsed.val.kind !== "stream"
    ) {
      return;
    }
    if (isLatest) this.usesXrefStream = true;
    const dict = parsed.val.dict;
    this.mergeTrailer(dict);
    const decoded = this.decodeStream(parsed.val);
    const wArr = asArr(dictGet(dict, "W"))?.map((x) => Number(x)) ?? [];
    if (wArr.length === 3) {
      const [w0, w1, w2] = wArr;
      const entryLen = w0 + w1 + w2;
      const size = asNum(dictGet(dict, "Size")) ?? 0;
      const idxArr = asArr(dictGet(dict, "Index"))?.map((x) => Number(x)) ?? [
        0,
        size,
      ];
      let ptr = 0;
      const readInt = (len: number) => {
        let v = 0;
        for (let b = 0; b < len; b++) v = v * 256 + (decoded[ptr++] ?? 0);
        return v;
      };
      for (let s = 0; s + 1 < idxArr.length; s += 2) {
        const startObj = idxArr[s];
        const subCount = idxArr[s + 1];
        for (let i = 0; i < subCount && ptr + entryLen <= decoded.length; i++) {
          const t = w0 === 0 ? 1 : readInt(w0);
          const f1 = readInt(w1);
          const f2 = w2 === 0 ? 0 : readInt(w2);
          const objNum = startObj + i;
          if (!this.xref.has(objNum)) {
            if (t === 1) {
              this.xref.set(objNum, {
                type: "uncompressed",
                offset: f1,
                gen: f2,
              });
            } else if (t === 2) {
              this.xref.set(objNum, {
                type: "compressed",
                objStm: f1,
                index: f2,
              });
            }
          }
        }
      }
    }
    const prev = asNum(dictGet(dict, "Prev"));
    if (prev !== undefined) this.parseXrefChain(prev, visited, false);
  }

  private fallbackScanObjects(): void {
    const text = this.buf.toString("latin1");
    const objRegex = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
    let match: RegExpExecArray | null;
    while ((match = objRegex.exec(text)) !== null) {
      const lead =
        match[0].startsWith("\r") ||
        match[0].startsWith("\n") ||
        match[0].startsWith(" ")
          ? 1
          : 0;
      const offset = match.index + lead;
      this.xref.set(Number(match[1]), {
        type: "uncompressed",
        offset,
        gen: Number(match[2]),
      });
    }
    const trailerIdx = text.lastIndexOf("trailer");
    if (trailerIdx >= 0) {
      const tok = new PdfTokenizer(this.buf, trailerIdx);
      tok.readValue();
      const tr = asDict(tok.readValue());
      if (tr) this.trailer = tr;
    }
    if (!dictGet(this.trailer, "Root")) {
      for (const [num] of this.xref) {
        const d = asDict(this.getObject(num));
        if (asName(dictGet(d, "Type")) === "Catalog") {
          this.trailer.entries.set("Root", { kind: "ref", num, gen: 0 });
          break;
        }
      }
    }
    if (!dictGet(this.trailer, "Root")) {
      fail("PDF_INVALID", "PDF catalog (/Root) is missing or unreadable");
    }
  }

  private readIndirectAt(
    offset: number,
  ): { num: number; gen: number; val: PdfVal } | undefined {
    const tok = new PdfTokenizer(this.buf, offset);
    const num = tok.readValue();
    const gen = tok.readValue();
    const kw = tok.readValue();
    if (
      typeof num !== "number" ||
      typeof gen !== "number" ||
      asName(kw) !== "obj"
    ) {
      return undefined;
    }
    const val = tok.readValue();
    if (
      val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      val.kind === "dict"
    ) {
      const saved = tok.pos;
      tok.skipWsAndComments();
      if (
        this.buf.subarray(tok.pos, tok.pos + 6).toString("latin1") === "stream"
      ) {
        tok.pos += 6;
        if (this.buf[tok.pos] === 0x0d && this.buf[tok.pos + 1] === 0x0a)
          tok.pos += 2;
        else if (this.buf[tok.pos] === 0x0a || this.buf[tok.pos] === 0x0d)
          tok.pos += 1;
        const lenVal = this.resolve(dictGet(val, "Length"));
        let streamEnd = -1;
        if (
          typeof lenVal === "number" &&
          lenVal >= 0 &&
          tok.pos + lenVal <= this.buf.length
        ) {
          const after = this.buf
            .subarray(
              tok.pos + lenVal,
              Math.min(this.buf.length, tok.pos + lenVal + 32),
            )
            .toString("latin1");
          if (/^\s*endstream\b/.test(after)) streamEnd = tok.pos + lenVal;
        }
        if (streamEnd < 0) {
          const marker = this.buf.indexOf("endstream", tok.pos, "latin1");
          streamEnd = marker >= 0 ? marker : this.buf.length;
          while (
            streamEnd > tok.pos &&
            (this.buf[streamEnd - 1] === 0x0a ||
              this.buf[streamEnd - 1] === 0x0d)
          ) {
            streamEnd--;
          }
        }
        return {
          num,
          gen,
          val: {
            kind: "stream",
            dict: val,
            rawData: this.buf.subarray(tok.pos, streamEnd),
          },
        };
      }
      tok.pos = saved;
    }
    return { num, gen, val: val ?? null };
  }

  getObject(num: number, seen = new Set<number>()): PdfVal {
    if (this.cache.has(num)) return this.cache.get(num)!;
    if (seen.has(num)) return null;
    seen.add(num);
    const entry = this.xref.get(num);
    if (!entry) return null;
    if (entry.type === "uncompressed") {
      const val = this.readIndirectAt(entry.offset)?.val ?? null;
      this.cache.set(num, val);
      return val;
    }
    let stmMap = this.objStmCache.get(entry.objStm);
    if (!stmMap) {
      stmMap = new Map();
      this.objStmCache.set(entry.objStm, stmMap);
      const stmObj = this.getObject(entry.objStm, seen);
      if (
        stmObj &&
        typeof stmObj === "object" &&
        !Array.isArray(stmObj) &&
        stmObj.kind === "stream"
      ) {
        const decoded = this.decodeStream(stmObj);
        const n = asNum(this.resolve(dictGet(stmObj.dict, "N"))) ?? 0;
        const first = asNum(this.resolve(dictGet(stmObj.dict, "First"))) ?? 0;
        const headerTok = new PdfTokenizer(decoded.subarray(0, first), 0);
        const pairs: { objNum: number; relOffset: number }[] = [];
        for (let i = 0; i < n; i++) {
          const on = headerTok.readValue();
          const off = headerTok.readValue();
          if (typeof on === "number" && typeof off === "number") {
            pairs.push({ objNum: on, relOffset: off });
          }
        }
        for (const pair of pairs) {
          const bodyTok = new PdfTokenizer(decoded, first + pair.relOffset);
          stmMap.set(pair.objNum, bodyTok.readValue() ?? null);
        }
      }
    }
    const val = stmMap.get(num) ?? null;
    this.cache.set(num, val);
    return val;
  }

  resolve(
    val: PdfVal | undefined,
    seen = new Set<number>(),
  ): PdfVal | undefined {
    const ref = asRef(val);
    return ref ? this.getObject(ref.num, seen) : val;
  }

  decodeStream(stream: PdfStream): Buffer {
    const filterVal = this.resolve(dictGet(stream.dict, "Filter"));
    const parmsVal = this.resolve(dictGet(stream.dict, "DecodeParms"));
    const filters = Array.isArray(filterVal)
      ? filterVal.map((f) => asName(this.resolve(f)) ?? "")
      : filterVal
        ? [asName(filterVal) ?? ""]
        : [];
    const parmsList = Array.isArray(parmsVal)
      ? parmsVal.map((p) => asDict(this.resolve(p)))
      : [asDict(parmsVal)];

    let data: Buffer = Buffer.from(stream.rawData);
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      if (!f) continue;
      if (f === "FlateDecode" || f === "Fl") {
        try {
          data = zlib.inflateSync(data);
        } catch {
          try {
            data = zlib.inflateRawSync(data);
          } catch {
            return data;
          }
        }
        const parms = parmsList[i];
        const predictor = asNum(dictGet(parms, "Predictor")) ?? 1;
        if (predictor > 1) {
          data = applyPngPredictor(
            data,
            predictor,
            asNum(dictGet(parms, "Columns")) ?? 1,
            asNum(dictGet(parms, "Colors")) ?? 1,
            asNum(dictGet(parms, "BitsPerComponent")) ?? 8,
          );
        }
      } else if (f === "ASCIIHexDecode" || f === "AHx") {
        const clean = data
          .toString("latin1")
          .replace(/\s+/g, "")
          .replace(/>.*$/, "");
        data = Buffer.from(clean.length % 2 ? clean + "0" : clean, "hex");
      } else if (f === "ASCII85Decode" || f === "A85") {
        data = ascii85Decode(data);
      }
    }
    return data;
  }
}

interface FontDecoder {
  bytesPerCode: 1 | 2;
  map: Map<number, string>;
  vertical: boolean;
}

function parseToUnicodeCMap(cmapText: string): Map<number, string> {
  const map = new Map<number, string>();
  const decodeHexUtf16 = (hex: string): string => {
    const clean = hex.replace(/\s+/g, "");
    const buf = Buffer.from(clean.length % 2 ? "0" + clean : clean, "hex");
    if (buf.length === 1) return String.fromCharCode(buf[0]);
    let out = "";
    for (let i = 0; i + 1 < buf.length; i += 2) {
      out += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
    }
    return out;
  };

  for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(Number.parseInt(p[1], 16), decodeHexUtf16(p[2]));
    }
  }
  for (const block of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const line of block[1].trim().split(/[\r\n]+/)) {
      const direct =
        /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/.exec(line);
      if (direct) {
        const start = Number.parseInt(direct[1], 16);
        const end = Number.parseInt(direct[2], 16);
        const baseCp = decodeHexUtf16(direct[3]).codePointAt(0) ?? 0;
        for (let code = start; code <= end && code - start < 4096; code++) {
          map.set(code, String.fromCodePoint(baseCp + (code - start)));
        }
        continue;
      }
      const arrMatch =
        /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]+)\]/.exec(line);
      if (arrMatch) {
        const start = Number.parseInt(arrMatch[1], 16);
        const end = Number.parseInt(arrMatch[2], 16);
        const targets = [...arrMatch[3].matchAll(/<([0-9a-fA-F]+)>/g)].map(
          (m) => decodeHexUtf16(m[1]),
        );
        for (
          let code = start;
          code <= end && code - start < targets.length;
          code++
        ) {
          map.set(code, targets[code - start]);
        }
      }
    }
  }
  return map;
}

function buildFontDecoder(
  doc: PdfDocumentParser,
  fontVal: PdfVal | undefined,
): FontDecoder {
  const dict = asDict(doc.resolve(fontVal));
  if (!dict) return { bytesPerCode: 1, map: new Map(), vertical: false };
  const subtype = asName(doc.resolve(dictGet(dict, "Subtype"))) ?? "";
  const encodingVal = doc.resolve(dictGet(dict, "Encoding"));
  const encodingName = asName(encodingVal) ?? "";
  const vertical =
    encodingName === "Identity-V" ||
    encodingName.endsWith("-V") ||
    asNum(doc.resolve(dictGet(asDict(encodingVal), "WMode"))) === 1;
  const bytesPerCode: 1 | 2 =
    subtype === "Type0" || encodingName.startsWith("Identity-") ? 2 : 1;
  let map = new Map<number, string>();
  const toUni = doc.resolve(dictGet(dict, "ToUnicode"));
  if (
    toUni &&
    typeof toUni === "object" &&
    !Array.isArray(toUni) &&
    toUni.kind === "stream"
  ) {
    map = parseToUnicodeCMap(doc.decodeStream(toUni).toString("latin1"));
  }
  return { bytesPerCode, map, vertical };
}

function decodeGlyphBytes(raw: Buffer, decoder: FontDecoder): string {
  if (decoder.bytesPerCode === 2 && raw.length >= 2 && raw.length % 2 === 0) {
    let out = "";
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const code = (raw[i] << 8) | raw[i + 1];
      const mapped = decoder.map.get(code);
      if (mapped !== undefined) out += mapped;
      else if (code >= 0x20 && code !== 0xffff)
        out += String.fromCharCode(code);
    }
    return normalizeExtractedPdfText(out);
  }
  let out = "";
  for (const byte of raw) {
    const mapped = decoder.map.get(byte);
    out += mapped ?? String.fromCharCode(PDF_DOC_ENCODING[byte] ?? byte);
  }
  return normalizeExtractedPdfText(out);
}

type Matrix6 = [number, number, number, number, number, number];

function multiplyMatrix(m1: Matrix6, m2: Matrix6): Matrix6 {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function transformPoint(m: Matrix6, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

interface PositionedRun {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  renderMode: number;
  vertical: boolean;
}

function parseContentStreamRuns(
  contentBuf: Buffer,
  fonts: Map<string, FontDecoder>,
): { runs: PositionedRun[]; hasInvisibleText: boolean } {
  const tok = new PdfTokenizer(contentBuf, 0);
  const operands: PdfVal[] = [];
  const runs: PositionedRun[] = [];
  let hasInvisibleText = false;
  let renderMode = 0;
  let currentFont: FontDecoder = {
    bytesPerCode: 1,
    map: new Map(),
    vertical: false,
  };
  let fontSize = 12;
  let ctm: Matrix6 = [1, 0, 0, 1, 0, 0];
  const ctmStack: Matrix6[] = [];
  let tm: Matrix6 = [1, 0, 0, 1, 0, 0];
  let tlm: Matrix6 = [1, 0, 0, 1, 0, 0];
  let leading = 14;

  const pushText = (val: PdfVal | undefined) => {
    if (!val) return;
    let chunk = "";
    if (typeof val === "object" && !Array.isArray(val) && val.kind === "str") {
      chunk = decodeGlyphBytes(val.raw, currentFont);
    } else if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const item = val[i];
        if (
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          item.kind === "str"
        ) {
          chunk += decodeGlyphBytes(item.raw, currentFont);
        } else if (
          typeof item === "number" &&
          item < -320 &&
          chunk &&
          !chunk.endsWith(" ")
        ) {
          const next = val[i + 1];
          const nextStartsSpace =
            next &&
            typeof next === "object" &&
            !Array.isArray(next) &&
            next.kind === "str" &&
            decodeGlyphBytes(next.raw, currentFont).startsWith(" ");
          const lastCp = chunk.codePointAt(chunk.length - 1) ?? 0;
          if (!nextStartsSpace && lastCp < 0x2e80) chunk += " ";
        }
      }
    }
    if (!chunk) return;
    if (renderMode === 3) hasInvisibleText = true;
    const combined = multiplyMatrix(tm, ctm);
    const [worldX, worldY] = transformPoint(combined, 0, 0);
    const effSize = Math.max(
      1,
      Math.abs(fontSize * Math.hypot(combined[0], combined[1])),
    );
    runs.push({
      text: chunk,
      x: worldX,
      y: worldY,
      fontSize: effSize,
      renderMode,
      vertical: currentFont.vertical,
    });
    const adv = currentFont.vertical
      ? [0, -chunk.length * fontSize * 0.9]
      : [chunk.length * fontSize * 0.55, 0];
    tm = multiplyMatrix([1, 0, 0, 1, adv[0], adv[1]], tm);
  };

  while (tok.pos < contentBuf.length) {
    tok.skipWsAndComments();
    if (tok.pos >= contentBuf.length) break;
    if (tok.peekWord() === "BI") {
      const eiIdx = contentBuf.indexOf("EI", tok.pos + 2, "latin1");
      if (eiIdx < 0) break;
      tok.pos = eiIdx + 2;
      operands.length = 0;
      continue;
    }
    const v = tok.readValue();
    if (v === undefined) break;
    if (
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      v.kind === "name" &&
      !contentBuf
        .subarray(Math.max(0, tok.pos - v.value.length - 2), tok.pos)
        .toString("latin1")
        .includes("/")
    ) {
      const op = v.value;
      if (op === "q") {
        ctmStack.push([...ctm]);
      } else if (op === "Q") {
        ctm = ctmStack.pop() ?? [1, 0, 0, 1, 0, 0];
      } else if (op === "cm" && operands.length >= 6) {
        const m: Matrix6 = [
          asNum(operands[operands.length - 6]) ?? 1,
          asNum(operands[operands.length - 5]) ?? 0,
          asNum(operands[operands.length - 4]) ?? 0,
          asNum(operands[operands.length - 3]) ?? 1,
          asNum(operands[operands.length - 2]) ?? 0,
          asNum(operands[operands.length - 1]) ?? 0,
        ];
        ctm = multiplyMatrix(m, ctm);
      } else if (op === "BT") {
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
      } else if (op === "Tr") {
        const mode = asNum(operands[operands.length - 1]);
        if (mode !== undefined) renderMode = mode;
      } else if (op === "Tf") {
        const size = asNum(operands[operands.length - 1]);
        const fontName = asName(operands[operands.length - 2]);
        if (fontName && fonts.has(fontName)) currentFont = fonts.get(fontName)!;
        if (size !== undefined) fontSize = Math.abs(size) || 12;
      } else if (op === "Tm" && operands.length >= 6) {
        tm = [
          asNum(operands[operands.length - 6]) ?? 1,
          asNum(operands[operands.length - 5]) ?? 0,
          asNum(operands[operands.length - 4]) ?? 0,
          asNum(operands[operands.length - 3]) ?? 1,
          asNum(operands[operands.length - 2]) ?? 0,
          asNum(operands[operands.length - 1]) ?? 0,
        ];
        tlm = [...tm];
      } else if ((op === "Td" || op === "TD") && operands.length >= 2) {
        const tx = asNum(operands[operands.length - 2]) ?? 0;
        const ty = asNum(operands[operands.length - 1]) ?? 0;
        if (op === "TD") leading = -ty;
        tlm = multiplyMatrix([1, 0, 0, 1, tx, ty], tlm);
        tm = [...tlm];
      } else if (op === "TL" && operands.length >= 1) {
        leading = asNum(operands[operands.length - 1]) ?? 14;
      } else if (op === "T*") {
        tlm = multiplyMatrix(
          [1, 0, 0, 1, 0, -(leading || fontSize * 1.2)],
          tlm,
        );
        tm = [...tlm];
      } else if (op === "Tj" || op === "TJ") {
        pushText(operands[operands.length - 1]);
      } else if (op === "'" || (op === '"' && operands.length >= 3)) {
        tlm = multiplyMatrix(
          [1, 0, 0, 1, 0, -(leading || fontSize * 1.2)],
          tlm,
        );
        tm = [...tlm];
        pushText(operands[operands.length - 1]);
      }
      operands.length = 0;
    } else {
      operands.push(v);
    }
  }
  return { runs, hasInvisibleText };
}

export interface ExtractedTextLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  vertical?: boolean;
  flowIndex?: number;
  blockIndex?: number;
  source: "ocr-layer" | "bbox-layout";
}

export interface ParsedBboxPage {
  page: number;
  widthPt: number;
  heightPt: number;
  lines: ExtractedTextLine[];
}

function joinWordsInLine(
  words: { text: string; xMin: number; xMax: number; height: number }[],
): string {
  let out = "";
  for (let i = 0; i < words.length; i++) {
    const cur = words[i];
    if (i > 0) {
      const prev = words[i - 1];
      const gap = cur.xMin - prev.xMax;
      const prevCp = out.codePointAt(out.length - 1) ?? 0;
      const nextCp = cur.text.codePointAt(0) ?? 0;
      const bothCjk = prevCp >= 0x2e80 && nextCp >= 0x2e80;
      if (!out.endsWith(" ") && (!bothCjk || gap > cur.height * 0.65)) {
        if (!bothCjk || gap > cur.height * 0.65) out += " ";
      }
    }
    out += cur.text;
  }
  return out.trim();
}

interface RawBboxLine {
  text: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  fontSize: number;
}

function mergeFragmentedSameLineRuns(lines: RawBboxLine[]): RawBboxLine[] {
  const sorted = [...lines].sort((a, b) =>
    Math.abs(a.yMin - b.yMin) > 2 ? a.yMin - b.yMin : a.xMin - b.xMin,
  );
  const merged: RawBboxLine[] = [];
  for (const cur of sorted) {
    const curH = Math.max(1, cur.yMax - cur.yMin);
    let target: RawBboxLine | undefined;
    for (let i = merged.length - 1; i >= 0; i--) {
      const cand = merged[i];
      const candH = Math.max(1, cand.yMax - cand.yMin);
      const overlap =
        Math.min(cand.yMax, cur.yMax) - Math.max(cand.yMin, cur.yMin);
      const minH = Math.min(candH, curH);
      if (overlap < minH * 0.55) continue;
      const left = cand.xMin <= cur.xMin ? cand : cur;
      const right = cand.xMin <= cur.xMin ? cur : cand;
      const gap = right.xMin - left.xMax;
      if (gap >= -minH * 0.5 && gap <= Math.max(18, minH * 1.4)) {
        target = cand;
        break;
      }
    }
    if (!target) {
      merged.push({ ...cur });
      continue;
    }
    const left = target.xMin <= cur.xMin ? target : cur;
    const right = target.xMin <= cur.xMin ? cur : target;
    const gap = Math.max(0, right.xMin - left.xMax);
    const prevCp = left.text.codePointAt(left.text.length - 1) ?? 0;
    const nextCp = right.text.codePointAt(0) ?? 0;
    const bothCjk = prevCp >= 0x2e80 && nextCp >= 0x2e80;
    const sep =
      !bothCjk || gap > Math.min(left.fontSize, right.fontSize) * 0.65
        ? " "
        : "";
    target.text = `${left.text}${sep}${right.text}`.trim();
    target.xMin = Math.min(left.xMin, right.xMin);
    target.xMax = Math.max(left.xMax, right.xMax);
    target.yMin = Math.min(left.yMin, right.yMin);
    target.yMax = Math.max(left.yMax, right.yMax);
    target.fontSize = Math.min(left.fontSize, right.fontSize);
  }
  return merged;
}

function findColumnGutter(
  lines: RawBboxLine[],
  pageWidth: number,
): number | undefined {
  if (lines.length < 2) return undefined;
  const minCut = pageWidth * 0.32;
  const maxCut = pageWidth * 0.68;
  const minGap = Math.max(16, pageWidth * 0.03);
  const candidates = Array.from(
    new Set(lines.map((l) => l.xMax).filter((x) => x >= minCut && x <= maxCut)),
  ).sort((a, b) => a - b);

  let bestCut: number | undefined;
  let bestScore = 0;
  for (const leftEdge of candidates) {
    const crossing = lines.some(
      (l) => l.xMin < leftEdge + 1 && l.xMax > leftEdge + 1,
    );
    if (crossing) continue;
    const leftLines = lines.filter((l) => l.xMax <= leftEdge + 1);
    const rightLines = lines.filter((l) => l.xMin >= leftEdge + 1);
    if (!leftLines.length || !rightLines.length) continue;
    const rightMinX = Math.min(...rightLines.map((l) => l.xMin));
    const gutterWidth = rightMinX - leftEdge;
    if (gutterWidth < minGap) continue;
    const leftYMin = Math.min(...leftLines.map((l) => l.yMin));
    const leftYMax = Math.max(...leftLines.map((l) => l.yMax));
    const rightYMin = Math.min(...rightLines.map((l) => l.yMin));
    const rightYMax = Math.max(...rightLines.map((l) => l.yMax));
    const vOverlap =
      Math.min(leftYMax, rightYMax) - Math.max(leftYMin, rightYMin);
    if (vOverlap <= 0) continue;
    const score = gutterWidth * Math.min(leftLines.length, rightLines.length);
    if (score > bestScore) {
      bestScore = score;
      bestCut = (leftEdge + rightMinX) / 2;
    }
  }
  return bestCut;
}

function orderLinesIntoColumnFlows(
  lines: RawBboxLine[],
  pageWidth: number,
): { line: RawBboxLine; flowIndex: number }[] {
  const byY = [...lines].sort((a, b) =>
    Math.abs(a.yMin - b.yMin) > 2 ? a.yMin - b.yMin : a.xMin - b.xMin,
  );
  // Segment vertically into bands separated by lines spanning across the central 40%-60% zone
  const bands: RawBboxLine[][] = [];
  let curBand: RawBboxLine[] = [];
  const flushBand = () => {
    if (curBand.length) {
      bands.push(curBand);
      curBand = [];
    }
  };
  for (const line of byY) {
    const spansCenter =
      line.xMin < pageWidth * 0.4 && line.xMax > pageWidth * 0.52;
    if (spansCenter) {
      flushBand();
      bands.push([line]);
    } else {
      curBand.push(line);
    }
  }
  flushBand();

  const ordered: { line: RawBboxLine; flowIndex: number }[] = [];
  let flowIndex = 0;
  for (const band of bands) {
    const gutter = findColumnGutter(band, pageWidth);
    if (gutter !== undefined) {
      const left = band
        .filter((l) => l.xMax <= gutter)
        .sort((a, b) => a.yMin - b.yMin);
      const right = band
        .filter((l) => l.xMin >= gutter)
        .sort((a, b) => a.yMin - b.yMin);
      const leftFlow = flowIndex++;
      for (const l of left) ordered.push({ line: l, flowIndex: leftFlow });
      const rightFlow = flowIndex++;
      for (const l of right) ordered.push({ line: l, flowIndex: rightFlow });
    } else {
      const f = flowIndex++;
      for (const l of band.sort((a, b) => a.yMin - b.yMin)) {
        ordered.push({ line: l, flowIndex: f });
      }
    }
  }
  return ordered;
}

/** Parse Poppler `pdftotext -bbox-layout` XHTML into reading-order lines and PDF-coordinate boxes. */
export function parsePdftotextBboxLayout(xhtml: string): ParsedBboxPage[] {
  const $ = cheerio.load(xhtml, { xml: true });
  const pages: ParsedBboxPage[] = [];
  $("page").each((pageIdx, pageEl) => {
    const $page = $(pageEl);
    const widthPt = Number($page.attr("width")) || 595;
    const heightPt = Number($page.attr("height")) || 842;
    const rawLines: RawBboxLine[] = [];

    $page.find("line").each((_li, lineEl) => {
      const $line = $(lineEl);
      const lxMin = Number($line.attr("xMin")) || 0;
      const lyMin = Number($line.attr("yMin")) || 0;
      const lxMax = Number($line.attr("xMax")) || lxMin;
      const lyMax = Number($line.attr("yMax")) || lyMin;
      const words: {
        text: string;
        xMin: number;
        xMax: number;
        height: number;
      }[] = [];
      $line.children("word").each((_wi, wordEl) => {
        const $w = $(wordEl);
        const txt = normalizeExtractedPdfText($w.text()).trim();
        if (!txt) return;
        const wxMin = Number($w.attr("xMin")) || lxMin;
        const wxMax = Number($w.attr("xMax")) || wxMin;
        const wyMin = Number($w.attr("yMin")) || lyMin;
        const wyMax = Number($w.attr("yMax")) || wyMin;
        words.push({
          text: txt,
          xMin: wxMin,
          xMax: wxMax,
          height: Math.max(1, wyMax - wyMin),
        });
      });
      const text = joinWordsInLine(words);
      if (!text) return;
      const boxHeight = Math.max(1, lyMax - lyMin);
      rawLines.push({
        text,
        xMin: lxMin,
        xMax: lxMax,
        yMin: lyMin,
        yMax: lyMax,
        fontSize: Math.round(boxHeight * 0.85 * 100) / 100,
      });
    });

    const merged = mergeFragmentedSameLineRuns(rawLines);
    const ordered = orderLinesIntoColumnFlows(merged, widthPt);
    const lines: ExtractedTextLine[] = ordered.map(({ line, flowIndex }) => {
      const boxHeight = Math.max(1, line.yMax - line.yMin);
      const boxWidth = Math.max(1, line.xMax - line.xMin);
      const yBottomUp = Math.max(0, heightPt - line.yMax);
      return {
        text: line.text,
        x: Math.round(line.xMin * 100) / 100,
        y: Math.round(yBottomUp * 100) / 100,
        width: Math.round(boxWidth * 100) / 100,
        height: Math.round(boxHeight * 100) / 100,
        fontSize: line.fontSize,
        flowIndex,
        source: "bbox-layout",
      };
    });

    pages.push({
      page: pageIdx + 1,
      widthPt,
      heightPt,
      lines,
    });
  });
  return pages;
}

async function runPdftotextBboxLayout(
  file: string,
  signal?: AbortSignal,
): Promise<Map<number, ParsedBboxPage> | null> {
  try {
    const res = await run("pdftotext", ["-bbox-layout", file, "-"], {
      signal,
      timeout: 60000,
    });
    if (res.exitCode !== 0 || !res.stdout.includes("<page")) return null;
    const parsed = parsePdftotextBboxLayout(res.stdout);
    return new Map(parsed.map((p) => [p.page, p]));
  } catch {
    return null;
  }
}

export interface PageRecord {
  page: number;
  objNum: number;
  gen: number;
  dict: PdfDict;
  resources?: PdfDict;
  widthPt: number;
  heightPt: number;
  rotate: PdfRotate;
}

function normalizeRotate(value: number | undefined): PdfRotate {
  const norm = (((value ?? 0) % 360) + 360) % 360;
  if (norm === 90 || norm === 180 || norm === 270) return norm;
  return 0;
}

export function collectPages(doc: PdfDocumentParser): PageRecord[] {
  const root = asDict(doc.resolve(dictGet(doc.trailer, "Root")));
  if (!root) fail("PDF_INVALID", "Missing PDF /Root catalog");
  const pagesRoot = dictGet(root, "Pages");
  const out: PageRecord[] = [];
  const visited = new Set<number>();

  const walk = (
    nodeVal: PdfVal | undefined,
    inheritedBox: number[],
    inheritedRotate: PdfRotate,
    inheritedRes?: PdfDict,
  ) => {
    const ref = asRef(nodeVal);
    if (ref) {
      if (visited.has(ref.num)) return;
      visited.add(ref.num);
    }
    const dict = asDict(doc.resolve(nodeVal));
    if (!dict) return;
    const mediaArr = asArr(
      doc.resolve(dictGet(dict, "CropBox") ?? dictGet(dict, "MediaBox")),
    );
    const box =
      mediaArr && mediaArr.length >= 4
        ? mediaArr.map((v) => Number(doc.resolve(v) ?? 0))
        : inheritedBox;
    const rotVal = asNum(doc.resolve(dictGet(dict, "Rotate")));
    const rotate =
      rotVal !== undefined ? normalizeRotate(rotVal) : inheritedRotate;
    const res = asDict(doc.resolve(dictGet(dict, "Resources"))) ?? inheritedRes;
    const kids = asArr(doc.resolve(dictGet(dict, "Kids")));
    const type = asName(doc.resolve(dictGet(dict, "Type")));
    if (kids && type !== "Page") {
      for (const kid of kids) walk(kid, box, rotate, res);
      return;
    }
    const widthPt = Math.max(1, Math.abs((box[2] ?? 595) - (box[0] ?? 0)));
    const heightPt = Math.max(1, Math.abs((box[3] ?? 842) - (box[1] ?? 0)));
    const xrefEntry = ref ? doc.xref.get(ref.num) : undefined;
    const gen =
      xrefEntry?.type === "uncompressed" ? xrefEntry.gen : (ref?.gen ?? 0);
    out.push({
      page: out.length + 1,
      objNum: ref?.num ?? 0,
      gen,
      dict,
      resources: res,
      widthPt,
      heightPt,
      rotate,
    });
  };

  walk(pagesRoot, [0, 0, 595, 842], 0, undefined);
  return out;
}

function parsePageSelection(
  spec: string | undefined,
  pageCount: number,
): Set<number> | undefined {
  if (!spec) return undefined;
  const set = new Set<number>();
  for (const part of spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a < 1 || b < a || b > pageCount) {
        fail(
          "PDF_PAGE_RANGE",
          `Invalid page range "${part}" for ${pageCount}-page PDF`,
        );
      }
      for (let p = a; p <= b; p++) set.add(p);
    } else if (/^\d+$/.test(part)) {
      const p = Number(part);
      if (p < 1 || p > pageCount) {
        fail("PDF_PAGE_RANGE", `Page ${p} out of bounds (1..${pageCount})`);
      }
      set.add(p);
    } else {
      fail("PDF_PAGE_RANGE", `Malformed page selector "${part}"`);
    }
  }
  return set;
}

/** Estimate vision-model image token cost for a rendered page (and optional tiles). */
export function estimatePageImageTokens(
  widthPx: number,
  heightPx: number,
  tileCount = 0,
): number {
  const scaledTokens = (w: number, h: number) => {
    const scale = Math.min(1, 2048 / Math.max(w, h, 1));
    const sw = Math.max(1, Math.round(w * scale));
    const sh = Math.max(1, Math.round(h * scale));
    return Math.max(85, Math.ceil((sw * sh) / 784));
  };
  const base = scaledTokens(widthPx, heightPx);
  if (tileCount <= 0) return base;
  const tileEst = Math.round(
    scaledTokens(widthPx, Math.max(200, Math.round(heightPx / 3.5))),
  );
  return base + tileCount * tileEst;
}

export function planPdfShards(
  pages: {
    page: number;
    widthPt: number;
    heightPt: number;
    classification: PdfClassification;
    ocrTrust: OcrTrust;
    estimatedImageTokens?: number;
  }[],
  options: {
    shardSize?: number;
    tokenBudget?: number;
    dpi?: number;
    tiled?: boolean;
  } = {},
): PdfShardRange[] {
  if (!pages.length) return [];
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  const dpi = options.dpi ?? 300;
  const defaultTileCount = options.tiled ? 7 : 0;

  const pageTokens = (p: (typeof sorted)[number]): number => {
    if (p.estimatedImageTokens !== undefined) return p.estimatedImageTokens;
    if (!pageRequiresOcrVerification(p)) return 100;
    const widthPx = Math.max(1, Math.round((p.widthPt / 72) * dpi));
    const heightPx = Math.max(1, Math.round((p.heightPt / 72) * dpi));
    return estimatePageImageTokens(widthPx, heightPx, defaultTileCount);
  };

  if (options.shardSize !== undefined) {
    const size = Math.max(1, Math.trunc(options.shardSize));
    const shards: PdfShardRange[] = [];
    for (let i = 0; i < sorted.length; i += size) {
      const slice = sorted.slice(i, i + size);
      shards.push({
        id: `shard-${String(shards.length + 1).padStart(2, "0")}`,
        pageStart: slice[0].page,
        pageEnd: slice[slice.length - 1].page,
        estimatedImageTokens: slice.reduce((acc, p) => acc + pageTokens(p), 0),
      });
    }
    return shards;
  }

  const budget = Math.max(500, Math.trunc(options.tokenBudget ?? 16000));
  const shards: PdfShardRange[] = [];
  let bucket: (typeof sorted)[number][] = [];
  let bucketTokens = 0;

  const flush = () => {
    if (!bucket.length) return;
    shards.push({
      id: `shard-${String(shards.length + 1).padStart(2, "0")}`,
      pageStart: bucket[0].page,
      pageEnd: bucket[bucket.length - 1].page,
      estimatedImageTokens: bucketTokens,
    });
    bucket = [];
    bucketTokens = 0;
  };

  for (const p of sorted) {
    const cost = pageTokens(p);
    if (
      bucket.length > 0 &&
      (bucketTokens + cost > budget || bucket.length >= 25)
    ) {
      flush();
    }
    bucket.push(p);
    bucketTokens += cost;
  }
  flush();
  return shards;
}

function extractOutline(
  doc: PdfDocumentParser,
  pageByObjNum: Map<number, number>,
): PdfOutlineNode[] {
  const root = asDict(doc.resolve(dictGet(doc.trailer, "Root")));
  const outlines = asDict(doc.resolve(dictGet(root, "Outlines")));
  if (!outlines) return [];

  const resolveDestPage = (destVal: PdfVal | undefined): number => {
    const resolved = doc.resolve(destVal);
    if (Array.isArray(resolved) && resolved.length > 0) {
      const firstRef = asRef(resolved[0]);
      if (firstRef && pageByObjNum.has(firstRef.num)) {
        return pageByObjNum.get(firstRef.num)!;
      }
      if (typeof resolved[0] === "number") return Math.max(1, resolved[0] + 1);
    }
    const d = asDict(resolved);
    return d ? resolveDestPage(dictGet(d, "D")) : 1;
  };

  const readSiblings = (
    firstVal: PdfVal | undefined,
    seen: Set<number>,
  ): PdfOutlineNode[] => {
    const nodes: PdfOutlineNode[] = [];
    let cur = firstVal;
    while (cur) {
      const ref = asRef(cur);
      if (ref) {
        if (seen.has(ref.num)) break;
        seen.add(ref.num);
      }
      const item = asDict(doc.resolve(cur));
      if (!item) break;
      const title = (
        decodePdfString(doc.resolve(dictGet(item, "Title"))) ?? ""
      ).trim();
      let page = 1;
      const dest = dictGet(item, "Dest");
      if (dest !== undefined) page = resolveDestPage(dest);
      else {
        const action = asDict(doc.resolve(dictGet(item, "A")));
        if (action && asName(doc.resolve(dictGet(action, "S"))) === "GoTo") {
          page = resolveDestPage(dictGet(action, "D"));
        }
      }
      const children = readSiblings(dictGet(item, "First"), seen);
      if (title) nodes.push({ title, page, children });
      cur = dictGet(item, "Next");
    }
    return nodes;
  };

  return readSiblings(dictGet(outlines, "First"), new Set());
}

function detectReaddleInPage(
  doc: PdfDocumentParser,
  pageDict: PdfDict,
  rawContent: string,
): boolean {
  if (
    rawContent.includes("Readdle") ||
    dictGet(pageDict, "PieceInfo") !== undefined
  ) {
    const piece = asDict(doc.resolve(dictGet(pageDict, "PieceInfo")));
    if (
      piece?.entries.has("ReaddleObject") ||
      rawContent.includes("ReaddleObject")
    ) {
      return true;
    }
  }
  const annots = asArr(doc.resolve(dictGet(pageDict, "Annots"))) ?? [];
  for (const annotVal of annots) {
    const annot = asDict(doc.resolve(annotVal));
    if (!annot) continue;
    for (const k of annot.entries.keys()) {
      if (k.includes("Readdle")) return true;
    }
  }
  return false;
}

interface ExtractedPageImage {
  inventory: PdfImageInventoryItem;
  stream: PdfStream;
}

export function collectPageImageStreams(
  doc: PdfDocumentParser,
  pageRec: PageRecord,
): ExtractedPageImage[] {
  const xobjDict = asDict(doc.resolve(dictGet(pageRec.resources, "XObject")));
  if (!xobjDict) return [];
  const items: ExtractedPageImage[] = [];
  for (const [name, val] of xobjDict.entries) {
    const resolved = doc.resolve(val);
    if (
      !resolved ||
      typeof resolved !== "object" ||
      Array.isArray(resolved) ||
      resolved.kind !== "stream"
    ) {
      continue;
    }
    if (asName(doc.resolve(dictGet(resolved.dict, "Subtype"))) !== "Image") {
      continue;
    }
    const width = asNum(doc.resolve(dictGet(resolved.dict, "Width"))) ?? 0;
    const height = asNum(doc.resolve(dictGet(resolved.dict, "Height"))) ?? 0;
    const bpc =
      asNum(doc.resolve(dictGet(resolved.dict, "BitsPerComponent"))) ?? 8;
    const csVal = doc.resolve(dictGet(resolved.dict, "ColorSpace"));
    const colorSpace =
      asName(csVal) ??
      (Array.isArray(csVal)
        ? (asName(doc.resolve(csVal[0])) ?? "Custom")
        : "DeviceRGB");
    const fVal = doc.resolve(dictGet(resolved.dict, "Filter"));
    const filter = Array.isArray(fVal)
      ? fVal
          .map((x) => asName(doc.resolve(x)) ?? "")
          .filter(Boolean)
          .join("+")
      : (asName(fVal) ?? "Raw");
    const estimatedDpi =
      width > 0 && pageRec.widthPt > 0
        ? Math.round((width / (pageRec.widthPt / 72)) * 10) / 10
        : undefined;
    items.push({
      inventory: {
        id: `p${pageRec.page}-${name}`,
        page: pageRec.page,
        name,
        width,
        height,
        bitsPerComponent: bpc,
        colorSpace,
        filter,
        streamSha256: sha256(resolved.rawData),
        ...(estimatedDpi ? { estimatedDpi } : {}),
      },
      stream: resolved,
    });
  }
  return items;
}

async function extractEmbeddedFigureToFile(
  doc: PdfDocumentParser,
  img: ExtractedPageImage,
  assetsDir: string,
): Promise<{
  filePath: string;
  sourceSha256: string;
  outputSha256: string;
} | null> {
  if (img.inventory.width < 32 || img.inventory.height < 32) return null;
  await fs.mkdir(assetsDir, { recursive: true });
  const filter = img.inventory.filter;
  if (filter === "DCTDecode") {
    const outPath = path.join(assetsDir, `${img.inventory.id}.jpg`);
    await fs.writeFile(outPath, img.stream.rawData);
    return {
      filePath: outPath,
      sourceSha256: img.inventory.streamSha256,
      outputSha256: sha256(img.stream.rawData),
    };
  }
  if (
    (filter === "FlateDecode" || filter === "Raw") &&
    img.inventory.bitsPerComponent === 8
  ) {
    const channels =
      img.inventory.colorSpace === "DeviceGray"
        ? 1
        : img.inventory.colorSpace === "DeviceCMYK"
          ? 4
          : 3;
    const raw =
      filter === "FlateDecode"
        ? doc.decodeStream(img.stream)
        : img.stream.rawData;
    const expected = img.inventory.width * img.inventory.height * channels;
    if (raw.length >= expected) {
      const pngBytes = await sharp(raw.subarray(0, expected), {
        raw: {
          width: img.inventory.width,
          height: img.inventory.height,
          channels,
        },
      })
        .png()
        .toBuffer();
      const outPath = path.join(assetsDir, `${img.inventory.id}.png`);
      await fs.writeFile(outPath, pngBytes);
      return {
        filePath: outPath,
        sourceSha256: img.inventory.streamSha256,
        outputSha256: sha256(pngBytes),
      };
    }
  }
  return null;
}

function groupRunsIntoLines(
  runs: PositionedRun[],
  pageWidth: number,
  source: "ocr-layer" | "bbox-layout" = "ocr-layer",
): {
  lines: ExtractedTextLine[];
  visibleChars: number;
  invisibleChars: number;
} {
  let visibleChars = 0;
  let invisibleChars = 0;
  for (const r of runs) {
    const len = r.text.replace(/\s+/g, "").length;
    if (r.renderMode === 3) invisibleChars += len;
    else visibleChars += len;
  }
  if (!runs.length) return { lines: [], visibleChars, invisibleChars };

  const nonEmpty = runs.filter((r) => r.text.trim().length > 0);
  // Detect simple two-column split when left and right clusters are separated by a gutter.
  const midX = pageWidth * 0.5;
  const leftRuns = nonEmpty.filter(
    (r) => !r.vertical && r.x + r.text.length * r.fontSize * 0.45 < midX - 8,
  );
  const rightRuns = nonEmpty.filter((r) => !r.vertical && r.x > midX + 8);
  const hasTwoColumns =
    leftRuns.length >= 2 &&
    rightRuns.length >= 2 &&
    leftRuns.length + rightRuns.length >= nonEmpty.length * 0.8;

  const groupColumn = (
    colRuns: PositionedRun[],
    flowIndex: number,
  ): ExtractedTextLine[] => {
    const buckets: PositionedRun[][] = [];
    const sorted = [...colRuns].sort((a, b) =>
      a.vertical
        ? Math.abs(b.x - a.x) > 3
          ? b.x - a.x
          : b.y - a.y
        : Math.abs(b.y - a.y) >
            Math.max(3, Math.min(a.fontSize, b.fontSize) * 0.45)
          ? b.y - a.y
          : a.x - b.x,
    );
    for (const r of sorted) {
      const prev = buckets[buckets.length - 1];
      if (
        prev &&
        prev[0].vertical === r.vertical &&
        Math.abs(
          (r.vertical ? prev[0].x : prev[0].y) - (r.vertical ? r.x : r.y),
        ) <= Math.max(3, prev[0].fontSize * 0.45)
      ) {
        prev.push(r);
      } else {
        buckets.push([r]);
      }
    }

    return buckets
      .map((group) => {
        const vertical = group[0].vertical;
        group.sort((a, b) => (vertical ? b.y - a.y : a.x - b.x));
        let text = "";
        for (let i = 0; i < group.length; i++) {
          const cur = group[i];
          if (i > 0) {
            const prev = group[i - 1];
            const prevEnd = prev.x + prev.text.length * prev.fontSize * 0.52;
            if (
              !vertical &&
              cur.x - prevEnd > cur.fontSize * 0.35 &&
              !text.endsWith(" ")
            ) {
              const prevCp = text.codePointAt(text.length - 1) ?? 0;
              const nextCp = cur.text.codePointAt(0) ?? 0;
              if (prevCp < 0x2e80 && nextCp < 0x2e80) text += " ";
            }
          }
          text += cur.text;
        }
        const fontSize = Math.max(...group.map((g) => g.fontSize));
        const minX = Math.min(...group.map((g) => g.x));
        const minY = Math.min(...group.map((g) => g.y));
        const estWidth = vertical
          ? fontSize * 1.1
          : Math.min(
              pageWidth,
              Math.max(fontSize, text.length * fontSize * 0.6),
            );
        const estHeight = vertical
          ? Math.max(fontSize, text.length * fontSize * 0.95)
          : fontSize * 1.2;
        const normalizedText = text.replace(/ {2,}/g, " ").trim();
        return {
          text: normalizedText,
          x: Math.round(minX * 100) / 100,
          y: Math.round(minY * 100) / 100,
          width: Math.round(estWidth * 100) / 100,
          height: Math.round(estHeight * 100) / 100,
          ...(vertical ? { vertical: true } : {}),
          fontSize,
          flowIndex,
          source,
        };
      })
      .filter((l) => l.text.length > 0);
  };

  const lines = hasTwoColumns
    ? [
        ...groupColumn(
          nonEmpty.filter((r) => !rightRuns.includes(r)),
          0,
        ),
        ...groupColumn(rightRuns, 1),
      ]
    : groupColumn(nonEmpty, 0);

  return { lines, visibleChars, invisibleChars };
}

function classifyPage(args: {
  visibleChars: number;
  invisibleChars: number;
  images: PdfImageInventoryItem[];
  hasReaddleOcr: boolean;
  textSample: string;
}): {
  classification: PdfClassification;
  ocrTrust: OcrTrust;
  anomalies: string[];
} {
  const anomalies: string[] = [];
  const totalChars = args.visibleChars + args.invisibleChars;
  const hasSubstantialImage = args.images.some(
    (img) => img.width >= 300 && img.height >= 300,
  );
  if (args.hasReaddleOcr) {
    anomalies.push(
      "Embedded /ReaddleObject OCR layer detected; require visual verification",
    );
  }
  if (args.invisibleChars > 0) {
    anomalies.push(
      "Invisible Tr=3 OCR text stream present; never trust without visual proofreading",
    );
  }
  const replacementCount = (
    args.textSample.match(/[\ufffd\ue000-\uf8ff]/g) ?? []
  ).length;
  if (replacementCount > 0) {
    anomalies.push(
      `Private-use or replacement characters detected (${replacementCount})`,
    );
  }
  for (const img of args.images) {
    if (
      img.estimatedDpi !== undefined &&
      img.estimatedDpi < 150 &&
      img.width >= 120
    ) {
      anomalies.push(
        `Low-DPI embedded image ${img.name} (~${img.estimatedDpi} DPI)`,
      );
    }
  }

  if (totalChars === 0 && args.images.length === 0) {
    return { classification: "empty", ocrTrust: "none", anomalies };
  }
  if (
    args.hasReaddleOcr ||
    (args.invisibleChars > 0 && args.visibleChars === 0)
  ) {
    return {
      classification: "scanned",
      ocrTrust: "unverified-embedded",
      anomalies,
    };
  }
  if (args.visibleChars === 0 && args.images.length > 0) {
    return { classification: "scanned", ocrTrust: "none", anomalies };
  }
  if (
    args.visibleChars > 0 &&
    (args.invisibleChars > 0 || hasSubstantialImage)
  ) {
    return {
      classification: "hybrid",
      ocrTrust:
        args.invisibleChars > 0 ? "unverified-embedded" : "digital-native",
      anomalies,
    };
  }
  return { classification: "digital", ocrTrust: "digital-native", anomalies };
}

export function decodePageContentBuffer(
  doc: PdfDocumentParser,
  pageDict: PdfDict,
): Buffer {
  const contentsVal = doc.resolve(dictGet(pageDict, "Contents"));
  if (!contentsVal) return Buffer.alloc(0);
  const streams: PdfStream[] = [];
  if (Array.isArray(contentsVal)) {
    for (const item of contentsVal) {
      const s = doc.resolve(item);
      if (
        s &&
        typeof s === "object" &&
        !Array.isArray(s) &&
        s.kind === "stream"
      ) {
        streams.push(s);
      }
    }
  } else if (
    typeof contentsVal === "object" &&
    contentsVal !== null &&
    contentsVal.kind === "stream"
  ) {
    streams.push(contentsVal);
  }
  if (!streams.length) return Buffer.alloc(0);
  return Buffer.concat(
    streams.map((s) => Buffer.concat([doc.decodeStream(s), Buffer.from("\n")])),
  );
}

function linkInlineNoteRef(
  blocks: PdfBlock[],
  marker: string,
  fnId: string,
  label: string,
): boolean {
  let linked = false;
  for (const b of blocks) {
    if (b.kind !== "paragraph") continue;
    const idx = b.text.indexOf(marker);
    if (idx < 0) continue;
    const baseRuns: PdfInlineRun[] = b.inlines
      ? [...b.inlines]
      : [{ kind: "text", text: b.text }];
    const nextRuns: PdfInlineRun[] = [];
    for (const runItem of baseRuns) {
      if (runItem.kind !== "text" || linked) {
        nextRuns.push(runItem);
        continue;
      }
      const pos = runItem.text.indexOf(marker);
      if (pos < 0) {
        nextRuns.push(runItem);
        continue;
      }
      const before = runItem.text.slice(0, pos);
      const after = runItem.text.slice(pos + marker.length);
      if (before) nextRuns.push({ ...runItem, text: before });
      nextRuns.push({ kind: "noteref", id: fnId, label });
      if (after) nextRuns.push({ ...runItem, text: after });
      linked = true;
    }
    if (linked) {
      b.inlines = nextRuns;
      return true;
    }
  }
  return false;
}

function buildBlocksFromLines(
  lines: ExtractedTextLine[],
  pageNumber: number,
  pageHeight: number,
): { blocks: PdfBlock[]; footnotes: PdfFootnoteItem[] } {
  if (!lines.length) return { blocks: [], footnotes: [] };
  const weightedSizes: number[] = [];
  for (const l of lines) {
    if (l.y < pageHeight * 0.08 || l.y > pageHeight * 0.92) continue;
    const weight = Math.max(1, Math.min(40, l.text.replace(/\s+/g, "").length));
    for (let k = 0; k < weight; k++) weightedSizes.push(l.fontSize);
  }
  const sizes = (
    weightedSizes.length ? weightedSizes : lines.map((l) => l.fontSize)
  ).sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)] || 12;
  const blocks: PdfBlock[] = [];
  const rawFootnotes: { marker: string; label: string; text: string }[] = [];

  let currentPara: string[] = [];
  let prevY: number | undefined;
  let prevFlow: number | undefined;
  let prevBlock: number | undefined;
  let gapPending = false;

  const flushPara = () => {
    if (!currentPara.length) return;
    const joined = currentPara
      .reduce((acc, line) => {
        if (!acc) return line;
        const lastCp = acc.codePointAt(acc.length - 1) ?? 0;
        const nextCp = line.codePointAt(0) ?? 0;
        if (acc.endsWith("-") && /^[a-z]/.test(line)) {
          return acc.slice(0, -1) + line;
        }
        return lastCp < 0x2e80 && nextCp < 0x2e80
          ? `${acc} ${line}`
          : `${acc}${line}`;
      }, "")
      .trim();
    if (joined) {
      blocks.push({
        kind: "paragraph",
        text: joined,
        ...(gapPending ? { gapBefore: true } : {}),
      });
    }
    currentPara = [];
    gapPending = false;
  };

  for (const line of lines) {
    if (
      /^(?:[-—–]?\s*\d{1,4}\s*[-—–]?)$/.test(line.text) &&
      (line.y < pageHeight * 0.08 || line.y > pageHeight * 0.92)
    ) {
      continue;
    }

    const fnMatch =
      line.y < pageHeight * 0.22 && line.fontSize <= bodySize * 0.92
        ? /^(\[(\d+)\]|([①②③④⑤⑥⑦⑧⑨⑩]))\s*(.+)$/.exec(line.text)
        : null;
    if (fnMatch) {
      flushPara();
      const marker = fnMatch[1];
      const label = fnMatch[2] ?? fnMatch[3];
      rawFootnotes.push({ marker, label, text: fnMatch[4].trim() });
      prevY = line.y;
      prevFlow = line.flowIndex;
      prevBlock = line.blockIndex;
      continue;
    }

    if (line.fontSize >= bodySize * 1.35 && line.text.length <= 80) {
      flushPara();
      const level = line.fontSize >= bodySize * 1.65 ? 1 : 2;
      blocks.push({ kind: "heading", level, text: line.text });
      prevY = line.y;
      prevFlow = line.flowIndex;
      prevBlock = line.blockIndex;
      continue;
    }

    const flowChanged =
      prevFlow !== undefined &&
      line.flowIndex !== undefined &&
      prevFlow !== line.flowIndex;
    const blockChanged =
      prevBlock !== undefined &&
      line.blockIndex !== undefined &&
      prevBlock !== line.blockIndex;

    if (flowChanged || blockChanged) {
      flushPara();
    } else if (prevY !== undefined) {
      const dy = Math.abs(prevY - line.y);
      if (dy > bodySize * 2.3) {
        flushPara();
        gapPending = blocks.length > 0;
      } else if (
        currentPara.length > 0 &&
        /[。！？!?.”」』）)]$/.test(currentPara[currentPara.length - 1]) &&
        dy > bodySize * 1.55
      ) {
        flushPara();
      }
    }
    currentPara.push(line.text);
    prevY = line.y;
    prevFlow = line.flowIndex;
    prevBlock = line.blockIndex;
  }
  flushPara();

  // Only emit structured footnotes when an in-text callout marker exists on the page;
  // otherwise keep the note line as a paragraph to avoid unreferenced footnotes.
  const footnotes: PdfFootnoteItem[] = [];
  let fnSeq = 0;
  for (const candidate of rawFootnotes) {
    fnSeq++;
    const fnId = `p${pageNumber}-${fnSeq}`;
    if (linkInlineNoteRef(blocks, candidate.marker, fnId, candidate.label)) {
      footnotes.push({
        id: fnId,
        label: candidate.label,
        text: candidate.text,
      });
    } else {
      blocks.push({
        kind: "paragraph",
        text: `${candidate.marker} ${candidate.text}`,
      });
    }
  }

  return { blocks, footnotes };
}

/**
 * Pure image-processing horizontal projection line slicer using sharp (not OCR).
 * Returns bottom-up PDF-coordinate line bounding boxes and rough ink-area stats.
 */
export async function detectLineGeometryFromImage(
  imagePathOrBytes: string | Uint8Array,
  pageWidthPt: number,
  pageHeightPt: number,
): Promise<{
  geometry: PdfLineGeometry[];
  inkRatio: number;
  estimatedChars: number;
}> {
  const input =
    typeof imagePathOrBytes === "string"
      ? await fs.readFile(imagePathOrBytes)
      : imagePathOrBytes;
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) {
    return { geometry: [], inkRatio: 0, estimatedChars: 0 };
  }
  const targetWidth = Math.min(meta.width, 900);
  const targetHeight = Math.max(
    1,
    Math.round((meta.height * targetWidth) / meta.width),
  );
  const { data, info } = await sharp(input)
    .grayscale()
    .resize(targetWidth, targetHeight, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const rowCounts = new Int32Array(h);
  const rowMinX = new Int32Array(h).fill(w);
  const rowMaxX = new Int32Array(h).fill(-1);
  let darkPixels = 0;
  const threshold = 210;

  for (let y = 0; y < h; y++) {
    const offset = y * w;
    let count = 0;
    for (let x = 0; x < w; x++) {
      if (data[offset + x] < threshold) {
        count++;
        if (x < rowMinX[y]) rowMinX[y] = x;
        if (x > rowMaxX[y]) rowMaxX[y] = x;
      }
    }
    rowCounts[y] = count;
    darkPixels += count;
  }

  const minDarkPerRow = Math.max(2, Math.floor(w * 0.004));
  const rawBands: { y0: number; y1: number; x0: number; x1: number }[] = [];
  let inBand = false;
  let bStart = 0;
  let bMinX = w;
  let bMaxX = 0;

  for (let y = 0; y < h; y++) {
    if (rowCounts[y] >= minDarkPerRow) {
      if (!inBand) {
        inBand = true;
        bStart = y;
        bMinX = rowMinX[y];
        bMaxX = rowMaxX[y];
      } else {
        if (rowMinX[y] < bMinX) bMinX = rowMinX[y];
        if (rowMaxX[y] > bMaxX) bMaxX = rowMaxX[y];
      }
    } else if (inBand) {
      rawBands.push({ y0: bStart, y1: y - 1, x0: bMinX, x1: bMaxX });
      inBand = false;
    }
  }
  if (inBand) rawBands.push({ y0: bStart, y1: h - 1, x0: bMinX, x1: bMaxX });

  const minBandPx = Math.max(3, Math.round(h * 0.004));
  const mergedBands: typeof rawBands = [];
  for (const band of rawBands) {
    const bandH = band.y1 - band.y0 + 1;
    if (bandH < minBandPx && mergedBands.length > 0) {
      const prev = mergedBands[mergedBands.length - 1];
      if (band.y0 - prev.y1 <= Math.max(3, minBandPx)) {
        prev.y1 = band.y1;
        prev.x0 = Math.min(prev.x0, band.x0);
        prev.x1 = Math.max(prev.x1, band.x1);
        continue;
      }
    }
    if (bandH >= minBandPx) mergedBands.push({ ...band });
  }

  const scaleX = pageWidthPt / w;
  const scaleY = pageHeightPt / h;
  const geometry: PdfLineGeometry[] = [];
  let estimatedChars = 0;

  for (const band of mergedBands) {
    const boxW = Math.max(1, (band.x1 - band.x0 + 1) * scaleX);
    const boxH = Math.max(4, (band.y1 - band.y0 + 1) * scaleY);
    const boxX = Math.max(0, band.x0 * scaleX);
    const boxY = Math.max(0, pageHeightPt - (band.y1 + 1) * scaleY);
    geometry.push({
      x: Math.round(boxX * 100) / 100,
      y: Math.round(boxY * 100) / 100,
      width: Math.round(boxW * 100) / 100,
      height: Math.round(boxH * 100) / 100,
      source: "horizontal-projection",
    });
    estimatedChars += Math.max(1, Math.round(boxW / Math.max(6, boxH * 0.85)));
  }

  return {
    geometry,
    inkRatio: Math.round((darkPixels / Math.max(1, w * h)) * 10000) / 10000,
    estimatedChars,
  };
}

/** Slice a rendered page PNG into overlapping horizontal bands plus header, footer and footnote zones. */
export async function sliceRenderedPageTiles(
  pageNumber: number,
  pngPath: string,
  tilesDir: string,
): Promise<{
  widthPx: number;
  heightPx: number;
  tiles: PdfRenderTile[];
}> {
  const bytes = await fs.readFile(pngPath);
  const meta = await sharp(bytes).metadata();
  if (!meta.width || !meta.height) {
    fail("IMAGE_INVALID", `Cannot read rendered page dimensions: ${pngPath}`);
  }
  const widthPx = meta.width;
  const heightPx = meta.height;
  await fs.mkdir(tilesDir, { recursive: true });
  const prefix = `p${String(pageNumber).padStart(4, "0")}`;

  const specs: {
    id: string;
    kind: PdfRenderTile["kind"];
    x: number;
    y: number;
    width: number;
    height: number;
  }[] = [];

  const bandCount = Math.min(6, Math.max(3, Math.ceil(heightPx / 1100)));
  const baseStep = Math.ceil(heightPx / bandCount);
  const overlap = Math.round(baseStep * 0.15);
  for (let i = 0; i < bandCount; i++) {
    const top = Math.max(0, i * baseStep - (i > 0 ? overlap : 0));
    const bottom = Math.min(
      heightPx,
      (i + 1) * baseStep + (i + 1 < bandCount ? overlap : 0),
    );
    const h = Math.max(1, bottom - top);
    specs.push({
      id: `${prefix}-band-${String(i + 1).padStart(2, "0")}`,
      kind: "band",
      x: 0,
      y: top,
      width: widthPx,
      height: h,
    });
  }

  const headerH = Math.max(1, Math.min(heightPx, Math.round(heightPx * 0.12)));
  const footerH = Math.max(1, Math.min(heightPx, Math.round(heightPx * 0.12)));
  const footnoteH = Math.max(
    1,
    Math.min(heightPx, Math.round(heightPx * 0.28)),
  );
  specs.push(
    {
      id: `${prefix}-header`,
      kind: "header",
      x: 0,
      y: 0,
      width: widthPx,
      height: headerH,
    },
    {
      id: `${prefix}-footer`,
      kind: "footer",
      x: 0,
      y: Math.max(0, heightPx - footerH),
      width: widthPx,
      height: footerH,
    },
    {
      id: `${prefix}-footnote-zone`,
      kind: "footnote-zone",
      x: 0,
      y: Math.max(0, heightPx - footnoteH),
      width: widthPx,
      height: footnoteH,
    },
  );

  const tiles: PdfRenderTile[] = [];
  for (const s of specs) {
    const outPath = path.join(tilesDir, `${s.id}.png`);
    const tileBuf = await sharp(bytes)
      .extract({ left: s.x, top: s.y, width: s.width, height: s.height })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await fs.writeFile(outPath, tileBuf);
    tiles.push({
      id: s.id,
      kind: s.kind,
      path: outPath,
      sha256: sha256(tileBuf),
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
      normalizedBox: {
        x: Math.round((s.x / widthPx) * 10000) / 10000,
        y: Math.round((s.y / heightPx) * 10000) / 10000,
        width: Math.round((s.width / widthPx) * 10000) / 10000,
        height: Math.round((s.height / heightPx) * 10000) / 10000,
      },
    });
  }

  return { widthPx, heightPx, tiles };
}

async function renderPdfPagesWithPoppler(
  file: string,
  sourceSha256: string,
  pages: number[],
  renderDir: string,
  dpi: number,
  tiles: boolean,
  signal?: AbortSignal,
): Promise<{
  renderedPages: PdfRenderedPage[];
  manifestPath: string;
  manifestSha256: string;
}> {
  await fs.mkdir(renderDir, { recursive: true });
  const tilesDir = path.join(renderDir, "tiles");
  const renderedPages: PdfRenderedPage[] = [];

  for (const page of pages) {
    checkAbort(signal);
    const prefix = path.join(renderDir, `p${String(page).padStart(4, "0")}`);
    const outFile = `${prefix}.png`;
    let execRes;
    try {
      execRes = await run(
        "pdftoppm",
        [
          "-png",
          "-r",
          String(dpi),
          "-f",
          String(page),
          "-l",
          String(page),
          "-singlefile",
          path.resolve(file),
          prefix,
        ],
        { signal, timeout: 120000 },
      );
    } catch (error) {
      fail(
        "ENVIRONMENT_ERROR",
        `pdftoppm is required for --render-dir page rendering: ${String(error)}`,
      );
    }
    if (execRes.exitCode !== 0 || !(await exists(outFile))) {
      fail(
        "ENVIRONMENT_ERROR",
        `pdftoppm failed on page ${page}: ${execRes.stderr || execRes.stdout}`,
      );
    }
    const pngBytes = await fs.readFile(outFile);
    const meta = await sharp(pngBytes).metadata();
    const widthPx = meta.width ?? 1;
    const heightPx = meta.height ?? 1;
    const tileInfo = tiles
      ? await sliceRenderedPageTiles(page, outFile, tilesDir)
      : undefined;
    const tileCount = tileInfo?.tiles.length ?? 0;
    renderedPages.push({
      page,
      path: outFile,
      sha256: sha256(pngBytes),
      dpi,
      widthPx,
      heightPx,
      estimatedImageTokens: estimatePageImageTokens(
        widthPx,
        heightPx,
        tileCount,
      ),
      ...(tileInfo ? { tiles: tileInfo.tiles } : {}),
    });
  }

  const manifest: PdfRenderManifest = {
    schemaVersion: PDF_SPEC_SCHEMA_VERSION,
    kind: "quillbind-pdf-render-manifest",
    sourcePath: path.resolve(file),
    sourceSha256,
    dpi,
    tiled: tiles,
    pages: renderedPages,
  };
  const manifestPath = path.join(renderDir, "render-manifest.json");
  await json(manifestPath, manifest);
  const manifestSha256 = sha256(await fs.readFile(manifestPath));
  return { renderedPages, manifestPath, manifestSha256 };
}

export async function extractPdfRawPages(
  file: string,
  options: {
    pages?: string;
    shardSize?: number;
    tokenBudget?: number;
    renderDir?: string;
    dpi?: number;
    tiles?: boolean;
    assetsDir?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{ inspection: PdfInspectionReport; pages: PdfSpecPage[] }> {
  checkAbort(options.signal);
  if (!isPdfPath(file)) fail("UNSUPPORTED_FORMAT", "Choose a .pdf file");
  const resolvedPath = path.resolve(file);
  const bytes = await readSourceFile(resolvedPath);
  if (!isPdfBytes(bytes)) {
    fail("PDF_INVALID", "Input file does not start with a valid %PDF- header");
  }
  const sourceSha256 = sha256(bytes);

  const parser = new PdfDocumentParser(bytes);
  const pageRecords = collectPages(parser);
  const selected = parsePageSelection(options.pages, pageRecords.length);
  const pageByObjNum = new Map<number, number>();
  for (const p of pageRecords) {
    if (p.objNum > 0) pageByObjNum.set(p.objNum, p.page);
  }

  const infoDict = asDict(parser.resolve(dictGet(parser.trailer, "Info")));
  const info: Record<string, string> = {};
  if (infoDict) {
    for (const [k, v] of infoDict.entries) {
      const decoded = decodePdfString(parser.resolve(v));
      if (decoded !== undefined && decoded.trim()) {
        info[k] = normalizeExtractedPdfText(decoded.trim());
      }
    }
  }

  const bboxPages = await runPdftotextBboxLayout(resolvedPath, options.signal);
  const summaries: PdfPageSummary[] = [];
  const allImages: PdfImageInventoryItem[] = [];
  const specPages: PdfSpecPage[] = [];

  for (const rec of pageRecords) {
    if (selected && !selected.has(rec.page)) continue;
    checkAbort(options.signal);

    const fontMap = new Map<string, FontDecoder>();
    const fontsDict = asDict(parser.resolve(dictGet(rec.resources, "Font")));
    if (fontsDict) {
      for (const [fname, fval] of fontsDict.entries) {
        fontMap.set(fname, buildFontDecoder(parser, fval));
      }
    }
    const contentBuf = decodePageContentBuffer(parser, rec.dict);
    const rawLatin = contentBuf.toString("latin1");
    const hasReaddleOcr = detectReaddleInPage(parser, rec.dict, rawLatin);
    const { runs, hasInvisibleText } = parseContentStreamRuns(
      contentBuf,
      fontMap,
    );
    const fallbackGrouped = groupRunsIntoLines(runs, rec.widthPt, "ocr-layer");
    const pageImgStreams = collectPageImageStreams(parser, rec);
    const pageImages = pageImgStreams.map((entry) => entry.inventory);
    allImages.push(...pageImages);

    const bboxPage = bboxPages?.get(rec.page);
    const hasPopplerText = Boolean(bboxPage && bboxPage.lines.length > 0);
    const popplerChars = hasPopplerText
      ? bboxPage!.lines.reduce(
          (acc, l) => acc + l.text.replace(/\s+/g, "").length,
          0,
        )
      : 0;

    // Combine binary parser visibility signals with Poppler character counts for fonts
    // whose ToUnicode/encoding only Poppler decoded cleanly (e.g., Chrome/Skia Type0 fonts).
    const effectiveVisibleChars =
      hasInvisibleText && fallbackGrouped.visibleChars === 0
        ? 0
        : Math.max(fallbackGrouped.visibleChars, popplerChars);
    const effectiveInvisibleChars =
      hasInvisibleText && fallbackGrouped.visibleChars === 0
        ? Math.max(fallbackGrouped.invisibleChars, popplerChars)
        : fallbackGrouped.invisibleChars;

    const chosenLines: ExtractedTextLine[] = hasPopplerText
      ? bboxPage!.lines.map((line) => ({
          ...line,
          source:
            hasInvisibleText && effectiveVisibleChars === 0
              ? "ocr-layer"
              : "bbox-layout",
        }))
      : fallbackGrouped.lines;

    const textSample = chosenLines.map((l) => l.text).join("\n");
    const { classification, ocrTrust, anomalies } = classifyPage({
      visibleChars: effectiveVisibleChars,
      invisibleChars: effectiveInvisibleChars,
      images: pageImages,
      hasReaddleOcr,
      textSample,
    });

    summaries.push({
      page: rec.page,
      widthPt: rec.widthPt,
      heightPt: rec.heightPt,
      rotate: rec.rotate,
      classification,
      textCharCount: effectiveVisibleChars + effectiveInvisibleChars,
      imageCount: pageImages.length,
      hasReaddleOcr,
      hasInvisibleTextLayer: hasInvisibleText,
      ocrTrust,
      anomalies,
    });

    const { blocks, footnotes } = buildBlocksFromLines(
      chosenLines,
      rec.page,
      rec.heightPt,
    );

    if (ocrTrust === "digital-native" && options.assetsDir) {
      for (const imgEntry of pageImgStreams) {
        const extracted = await extractEmbeddedFigureToFile(
          parser,
          imgEntry,
          path.resolve(options.assetsDir),
        );
        if (extracted) {
          blocks.push({
            kind: "figure",
            id: imgEntry.inventory.id,
            src: extracted.filePath,
            alt: `Figure ${imgEntry.inventory.id}`,
            provenance: {
              sourceSha256: extracted.sourceSha256,
              outputSha256: extracted.outputSha256,
              mode: "extracted",
              generativeRedraw: false,
            },
          });
        }
      }
    }

    const geometry: PdfLineGeometry[] = chosenLines.map((l) => ({
      x: l.x,
      y: l.y,
      width: l.width,
      height: l.height,
      ...(l.vertical ? { vertical: true } : {}),
      source: l.source,
    }));
    const rawOcrDraft =
      ocrTrust === "unverified-embedded" && textSample.trim()
        ? textSample.trim()
        : undefined;

    specPages.push({
      page: rec.page,
      widthPt: rec.widthPt,
      heightPt: rec.heightPt,
      rotate: rec.rotate,
      classification,
      ocrTrust,
      blocks,
      footnotes,
      ...(geometry.length ? { geometry } : {}),
      ...(rawOcrDraft ? { rawOcrDraft } : {}),
    });
  }

  const nonEmpty = summaries.filter((p) => p.classification !== "empty");
  let overall: PdfClassification = "empty";
  if (nonEmpty.length > 0) {
    const kinds = new Set(nonEmpty.map((p) => p.classification));
    overall = kinds.size === 1 ? [...kinds][0] : "hybrid";
  }

  const outline = extractOutline(parser, pageByObjNum);
  const dpi = options.dpi ?? 300;
  const renderOutput = options.renderDir
    ? await renderPdfPagesWithPoppler(
        resolvedPath,
        sourceSha256,
        summaries.map((s) => s.page),
        path.resolve(options.renderDir),
        dpi,
        Boolean(options.tiles),
        options.signal,
      )
    : undefined;

  const renderedByPage = new Map(
    (renderOutput?.renderedPages ?? []).map((r) => [r.page, r]),
  );
  for (const sp of specPages) {
    const ren = renderedByPage.get(sp.page);
    if (!ren) continue;
    sp.render = {
      path: ren.path,
      sha256: ren.sha256,
      dpi: ren.dpi,
      widthPx: ren.widthPx,
      heightPx: ren.heightPx,
    };
    if (
      (!sp.geometry || sp.geometry.length === 0) &&
      pageRequiresOcrVerification(sp)
    ) {
      const projected = await detectLineGeometryFromImage(
        ren.path,
        sp.widthPt,
        sp.heightPt,
      );
      if (projected.geometry.length > 0) sp.geometry = projected.geometry;
    }
  }

  const shards = planPdfShards(
    summaries.map((s) => ({
      page: s.page,
      widthPt: s.widthPt,
      heightPt: s.heightPt,
      classification: s.classification,
      ocrTrust: s.ocrTrust,
      estimatedImageTokens: renderedByPage.get(s.page)?.estimatedImageTokens,
    })),
    {
      shardSize: options.shardSize,
      tokenBudget: options.tokenBudget,
      dpi,
      tiled: Boolean(options.tiles),
    },
  );

  const inspection: PdfInspectionReport = {
    schemaVersion: PDF_SPEC_SCHEMA_VERSION,
    path: resolvedPath,
    sha256: sourceSha256,
    pdfVersion: parser.version,
    pageCount: pageRecords.length,
    classification: overall,
    info,
    pages: summaries,
    images: allImages,
    outline,
    shards,
    ...(renderOutput
      ? {
          renderedPages: renderOutput.renderedPages,
          renderManifestPath: renderOutput.manifestPath,
          renderManifestSha256: renderOutput.manifestSha256,
        }
      : {}),
  };

  return { inspection, pages: specPages };
}

export async function inspectPdf(
  file: string,
  options: {
    pages?: string;
    shardSize?: number;
    tokenBudget?: number;
    renderDir?: string;
    dpi?: number;
    tiles?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<PdfInspectionReport> {
  const { inspection } = await extractPdfRawPages(file, options);
  return inspection;
}
