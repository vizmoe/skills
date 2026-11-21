import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { checkAbort, fail } from "./errors.js";
import { exists, readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { json, readJson } from "./json.js";
import {
  PdfDocumentParser,
  asArr,
  asDict,
  asNum,
  asRef,
  collectPageImageStreams,
  collectPages,
  decodePageContentBuffer,
  detectLineGeometryFromImage,
  dictGet,
  isPdfBytes,
  isPdfPath,
  normalizeExtractedPdfText,
  stripInvisibleOcrFromContentStream,
  type PageRecord,
  type PdfDict,
  type PdfVal,
} from "./pdf-binary.js";
import {
  PDF_SPEC_SCHEMA_VERSION,
  pageRequiresOcrVerification,
  pdfRenderManifestSchema,
  pdfSpecSchema,
  pdfVerificationFileSchema,
  type PdfLineGeometry,
  type PdfOutlineNode,
  type PdfRenderManifest,
  type PdfRepairPageAlignment,
  type PdfRepairReport,
  type PdfSpec,
  type PdfSpecPage,
  type PdfVerificationFile,
} from "./pdf-model.js";
import {
  assertPdfSpecVerified,
  collectPageTranscribedLines,
} from "./pdf-shard.js";
import { run } from "./process.js";

function sfntChecksum(buf: Buffer): number {
  let sum = 0;
  const padded = Math.ceil(buf.length / 4) * 4;
  for (let i = 0; i < padded; i += 4) {
    const b0 = buf[i] ?? 0;
    const b1 = buf[i + 1] ?? 0;
    const b2 = buf[i + 2] ?? 0;
    const b3 = buf[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

/**
 * Build a minimal standards-compliant 1-glyph (.notdef, advanceWidth=1000, unitsPerEm=1000)
 * TrueType SFNT font buffer for invisible OCR text layers (/FontFile2).
 */
export function buildGlyphLessTrueTypeFont(): Buffer {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(0, 8);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(0x000b, 16);
  head.writeUInt16BE(1000, 18);
  head.writeInt16BE(0, 36);
  head.writeInt16BE(-200, 38);
  head.writeInt16BE(1000, 40);
  head.writeInt16BE(800, 42);
  head.writeUInt16BE(0, 44);
  head.writeUInt16BE(8, 46);
  head.writeInt16BE(2, 48);
  head.writeInt16BE(0, 50);
  head.writeInt16BE(0, 52);

  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(800, 4);
  hhea.writeInt16BE(-200, 6);
  hhea.writeInt16BE(0, 8);
  hhea.writeUInt16BE(1000, 10);
  hhea.writeInt16BE(0, 12);
  hhea.writeInt16BE(0, 14);
  hhea.writeInt16BE(1000, 16);
  hhea.writeInt16BE(1, 18);
  hhea.writeUInt16BE(1, 34);

  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(1, 4);

  const os2 = Buffer.alloc(78);
  os2.writeUInt16BE(0, 0);
  os2.writeInt16BE(1000, 2);
  os2.writeUInt16BE(400, 4);
  os2.writeUInt16BE(5, 6);
  os2.writeUInt16BE(0x0040, 62);
  os2.writeUInt16BE(0x0020, 64);
  os2.writeUInt16BE(0xffff, 66);
  os2.writeInt16BE(800, 68);
  os2.writeInt16BE(-200, 70);
  os2.writeInt16BE(0, 72);
  os2.writeUInt16BE(800, 74);
  os2.writeUInt16BE(200, 76);

  const hmtx = Buffer.alloc(4);
  hmtx.writeUInt16BE(1000, 0);
  hmtx.writeInt16BE(0, 2);

  const loca = Buffer.alloc(4);
  const glyf = Buffer.alloc(4);

  const cmap = Buffer.alloc(36);
  cmap.writeUInt16BE(0, 0);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(1, 6);
  cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(4, 12);
  cmap.writeUInt16BE(24, 14);
  cmap.writeUInt16BE(0, 16);
  cmap.writeUInt16BE(2, 18);
  cmap.writeUInt16BE(2, 20);
  cmap.writeUInt16BE(0, 22);
  cmap.writeUInt16BE(0, 24);
  cmap.writeUInt16BE(0xffff, 26);
  cmap.writeUInt16BE(0, 28);
  cmap.writeUInt16BE(0xffff, 30);
  cmap.writeInt16BE(1, 32);
  cmap.writeUInt16BE(0, 34);

  const name = Buffer.alloc(6);
  name.writeUInt16BE(0, 0);
  name.writeUInt16BE(0, 2);
  name.writeUInt16BE(6, 4);

  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0);

  const tables: { tag: string; data: Buffer }[] = [
    { tag: "OS/2", data: os2 },
    { tag: "cmap", data: cmap },
    { tag: "glyf", data: glyf },
    { tag: "head", data: head },
    { tag: "hhea", data: hhea },
    { tag: "hmtx", data: hmtx },
    { tag: "loca", data: loca },
    { tag: "maxp", data: maxp },
    { tag: "name", data: name },
    { tag: "post", data: post },
  ];

  const numTables = tables.length;
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = (1 << entrySelector) * 16;
  const rangeShift = numTables * 16 - searchRange;

  const header = Buffer.alloc(12 + numTables * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(numTables, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(rangeShift, 10);

  let offset = header.length;
  let headOffset = 0;
  const paddedBuffers: Buffer[] = [];
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (t.tag === "head") headOffset = offset;
    const padLen = Math.ceil(t.data.length / 4) * 4;
    const padded = Buffer.alloc(padLen);
    t.data.copy(padded);
    paddedBuffers.push(padded);

    const rec = 12 + i * 16;
    header.write(t.tag, rec, 4, "ascii");
    header.writeUInt32BE(sfntChecksum(padded), rec + 4);
    header.writeUInt32BE(offset, rec + 8);
    header.writeUInt32BE(t.data.length, rec + 12);
    offset += padLen;
  }

  const font = Buffer.concat([header, ...paddedBuffers]);
  const adjustment = (0xb1b0afba - sfntChecksum(font)) >>> 0;
  font.writeUInt32BE(adjustment, headOffset + 8);
  return font;
}

function escapePdfName(name: string): string {
  const bytes = Buffer.from(name, "utf8");
  let out = "/";
  for (const b of bytes) {
    const isDelimiter =
      b === 0x23 ||
      b === 0x25 ||
      b === 0x28 ||
      b === 0x29 ||
      b === 0x2f ||
      b === 0x3c ||
      b === 0x3e ||
      b === 0x5b ||
      b === 0x5d ||
      b === 0x7b ||
      b === 0x7d;
    if (b <= 0x20 || b >= 0x7f || isDelimiter) {
      out += `#${b.toString(16).toUpperCase().padStart(2, "0")}`;
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

function formatPdfNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  return Number(n.toFixed(4)).toString();
}

function serializePdfVal(val: PdfVal): string {
  if (val === null) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return formatPdfNumber(val);
  if (Array.isArray(val)) return `[${val.map(serializePdfVal).join(" ")}]`;
  if (val.kind === "name") return escapePdfName(val.value);
  if (val.kind === "ref") return `${val.num} ${val.gen} R`;
  if (val.kind === "str") {
    const needsHex = val.hex || val.raw.some((b) => b < 0x20 || b > 0x7e);
    if (needsHex) {
      return `<${val.raw.toString("hex").toUpperCase()}>`;
    }
    let lit = "(";
    for (const b of val.raw) {
      if (b === 0x5c || b === 0x28 || b === 0x29) lit += "\\";
      lit += String.fromCharCode(b);
    }
    return `${lit})`;
  }
  if (val.kind === "dict") {
    const parts: string[] = [];
    for (const [k, v] of val.entries) {
      parts.push(`${escapePdfName(k)} ${serializePdfVal(v)}`);
    }
    return `<< ${parts.join(" ")} >>`;
  }
  return serializePdfVal(val.dict);
}

function buildFlateStreamObject(
  extraDictEntries: string,
  payload: Buffer,
): Buffer {
  const compressed = zlib.deflateSync(payload);
  const entries = [
    extraDictEntries.trim(),
    "/Filter /FlateDecode",
    `/Length ${compressed.length}`,
  ]
    .filter(Boolean)
    .join(" ");
  return Buffer.concat([
    Buffer.from(`<< ${entries} >>\nstream\n`, "latin1"),
    compressed,
    Buffer.from("\nendstream", "latin1"),
  ]);
}

function encodeUtf16BeHex(text: string): string {
  const bytes: number[] = [0xfe, 0xff];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes.push((code >>> 8) & 0xff, code & 0xff);
  }
  return `<${Buffer.from(bytes).toString("hex").toUpperCase()}>`;
}

function buildToUnicodeCMap(charToCid: Map<string, number>): Buffer {
  const entries = [...charToCid.entries()].sort((a, b) => a[1] - b[1]);
  const lines: string[] = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Quillbind) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Quillbind-UTF16 def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
  ];
  // ISO 32000-1 caps each beginbfchar section at 100 entries.
  for (let i = 0; i < entries.length; i += 100) {
    const slice = entries.slice(i, i + 100);
    lines.push(`${slice.length} beginbfchar`);
    for (const [ch, cid] of slice) {
      const cidHex = cid.toString(16).toUpperCase().padStart(4, "0");
      const u16Hex = Buffer.from(ch, "utf16le")
        .swap16()
        .toString("hex")
        .toUpperCase();
      lines.push(`<${cidHex}> <${u16Hex}>`);
    }
    lines.push("endbfchar");
  }
  lines.push(
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  );
  return Buffer.from(lines.join("\n") + "\n", "latin1");
}

interface PlacedOcrLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  vertical?: boolean;
}

function planPageOcrPlacements(
  sp: PdfSpecPage,
  rec: PageRecord,
  geometry: PdfLineGeometry[],
): {
  placements: PlacedOcrLine[];
  alignment: PdfRepairPageAlignment;
} {
  const textLines = collectPageTranscribedLines(sp);
  const geomSource = geometry[0]?.source;
  if (textLines.length === 0) {
    return {
      placements: [],
      alignment: {
        page: sp.page,
        mode: "skipped-empty",
        geometryLines: geometry.length,
        textLines: 0,
        ...(geomSource ? { geometrySource: geomSource } : {}),
      },
    };
  }

  if (geometry.length === textLines.length) {
    const placements: PlacedOcrLine[] = textLines.map((text, idx) => {
      const box = geometry[idx];
      return {
        text,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        vertical: box.vertical,
      };
    });
    return {
      placements,
      alignment: {
        page: sp.page,
        mode: "line-matched",
        geometryLines: geometry.length,
        textLines: textLines.length,
        ...(geomSource ? { geometrySource: geomSource } : {}),
      },
    };
  }

  // Explicit block-level fallback when line counts mismatch or geometry is absent.
  const marginX = Math.max(12, rec.widthPt * 0.06);
  const marginY = Math.max(12, rec.heightPt * 0.06);
  let areaMinX = marginX;
  let areaMaxX = Math.max(marginX + 20, rec.widthPt - marginX);
  let areaMinY = marginY;
  let areaMaxY = Math.max(marginY + 20, rec.heightPt - marginY);
  if (geometry.length > 0) {
    areaMinX = Math.max(4, Math.min(...geometry.map((g) => g.x)));
    areaMaxX = Math.min(
      rec.widthPt - 4,
      Math.max(...geometry.map((g) => g.x + g.width)),
    );
    areaMinY = Math.max(4, Math.min(...geometry.map((g) => g.y)));
    areaMaxY = Math.min(
      rec.heightPt - 4,
      Math.max(...geometry.map((g) => g.y + g.height)),
    );
    if (areaMaxX - areaMinX < 20) {
      areaMinX = marginX;
      areaMaxX = Math.max(marginX + 20, rec.widthPt - marginX);
    }
    if (areaMaxY - areaMinY < 20) {
      areaMinY = marginY;
      areaMaxY = Math.max(marginY + 20, rec.heightPt - marginY);
    }
  }

  const totalH = Math.max(20, areaMaxY - areaMinY);
  const boxW = Math.max(20, areaMaxX - areaMinX);
  const sliceH = totalH / textLines.length;

  const placements: PlacedOcrLine[] = textLines.map((text, idx) => {
    const boxH = Math.max(6, Math.min(20, sliceH * 0.72));
    const y = Math.max(
      4,
      areaMaxY - (idx + 1) * sliceH + (sliceH - boxH) * 0.5,
    );
    return {
      text,
      x: areaMinX,
      y,
      width: boxW,
      height: boxH,
    };
  });

  return {
    placements,
    alignment: {
      page: sp.page,
      mode: "block-fallback",
      geometryLines: geometry.length,
      textLines: textLines.length,
      ...(geomSource ? { geometrySource: geomSource } : {}),
    },
  };
}

function buildInvisibleOcrStream(
  placements: PlacedOcrLine[],
  rec: PageRecord,
  fontResourceName: string,
  encodeTextHex: (text: string) => string,
): Buffer {
  if (placements.length === 0) return Buffer.alloc(0);
  const lines: string[] = ["q"];
  for (const item of placements) {
    const clean = item.text.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const glyphCount = Math.max(1, Array.from(clean).length);
    const x = Math.max(2, Math.min(rec.widthPt - 10, item.x));
    const y = Math.max(2, Math.min(rec.heightPt - 4, item.y));
    const availW = Math.max(8, Math.min(item.width, rec.widthPt - x - 2));

    let fontSize = Math.max(4, Math.min(24, item.height * 0.85));
    let naturalW = glyphCount * fontSize;
    let tz = (availW / Math.max(1, naturalW)) * 100;
    if (tz < 10) {
      fontSize = Math.max(1.5, availW / (glyphCount * 0.1));
      naturalW = glyphCount * fontSize;
      tz = Math.max(5, Math.min(400, (availW / Math.max(1, naturalW)) * 100));
    } else if (tz > 400) {
      tz = 400;
    }

    const hex = encodeTextHex(clean);
    if (item.vertical) {
      lines.push(
        `BT 3 Tr /${fontResourceName} ${formatPdfNumber(fontSize)} Tf ${formatPdfNumber(tz)} Tz 0 -1 1 0 ${formatPdfNumber(x)} ${formatPdfNumber(y)} Tm ${hex} Tj ET`,
      );
    } else {
      lines.push(
        `BT 3 Tr /${fontResourceName} ${formatPdfNumber(fontSize)} Tf ${formatPdfNumber(tz)} Tz 1 0 0 1 ${formatPdfNumber(x)} ${formatPdfNumber(y)} Tm ${hex} Tj ET`,
      );
    }
  }
  lines.push("Q");
  return Buffer.from(lines.join("\n") + "\n", "latin1");
}

function buildOutlineObjects(
  outline: PdfOutlineNode[],
  pageRecords: PageRecord[],
  allocObj: () => number,
  objects: Map<number, { gen: number; body: Buffer }>,
): { rootObjNum: number; count: number } | null {
  if (outline.length === 0) return null;
  const pageByNumber = new Map(pageRecords.map((r) => [r.page, r]));
  const rootObjNum = allocObj();
  let totalEntries = 0;

  const buildLevel = (
    nodes: PdfOutlineNode[],
    parentObjNum: number,
  ): { first: number; last: number; count: number } => {
    const ids = nodes.map(() => allocObj());
    let visibleCount = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const objNum = ids[i];
      totalEntries++;
      visibleCount++;
      const targetPage =
        pageByNumber.get(node.page) ??
        pageRecords[
          Math.min(pageRecords.length - 1, Math.max(0, node.page - 1))
        ];
      const parts: string[] = [
        `/Title ${encodeUtf16BeHex(node.title)}`,
        `/Parent ${parentObjNum} 0 R`,
      ];
      if (i > 0) parts.push(`/Prev ${ids[i - 1]} 0 R`);
      if (i + 1 < nodes.length) parts.push(`/Next ${ids[i + 1]} 0 R`);
      if (targetPage) {
        parts.push(`/Dest [${targetPage.objNum} ${targetPage.gen} R /Fit]`);
      }
      if (node.children.length > 0) {
        const sub = buildLevel(node.children, objNum);
        parts.push(
          `/First ${sub.first} 0 R`,
          `/Last ${sub.last} 0 R`,
          `/Count ${sub.count}`,
        );
        visibleCount += sub.count;
      }
      objects.set(objNum, {
        gen: 0,
        body: Buffer.from(`<< ${parts.join(" ")} >>`, "latin1"),
      });
    }
    return {
      first: ids[0],
      last: ids[ids.length - 1],
      count: visibleCount,
    };
  };

  const top = buildLevel(outline, rootObjNum);
  objects.set(rootObjNum, {
    gen: 0,
    body: Buffer.from(
      `<< /Type /Outlines /First ${top.first} 0 R /Last ${top.last} 0 R /Count ${top.count} >>`,
      "latin1",
    ),
  });
  return { rootObjNum, count: totalEntries };
}

function buildUpdatedIdArray(
  parser: PdfDocumentParser,
  sourceSha256: string,
  updateSeed: string,
): PdfVal | undefined {
  const origId = asArr(parser.resolve(dictGet(parser.trailer, "ID")));
  if (!origId || origId.length < 1) return undefined;
  const first = origId[0];
  const secondBytes = Buffer.from(
    sha256(`${sourceSha256}:${updateSeed}`).slice(0, 32),
    "hex",
  );
  return [first, { kind: "str", raw: secondBytes, hex: true }];
}

function groupContiguousSubsections(
  nums: number[],
): { start: number; items: number[] }[] {
  const sorted = [...nums].sort((a, b) => a - b);
  const groups: { start: number; items: number[] }[] = [];
  for (const n of sorted) {
    const prev = groups[groups.length - 1];
    if (prev && prev.items[prev.items.length - 1] + 1 === n) {
      prev.items.push(n);
    } else {
      groups.push({ start: n, items: [n] });
    }
  }
  return groups;
}

function appendIncrementalPdfUpdate(args: {
  sourceBytes: Buffer;
  sourceSha256: string;
  parser: PdfDocumentParser;
  updatedObjects: Map<number, { gen: number; body: Buffer }>;
  nextObjNum: number;
}): { bytes: Buffer; xrefFormat: "classic" | "xref-stream" } {
  const { sourceBytes, sourceSha256, parser, updatedObjects } = args;
  let nextObjNum = args.nextObjNum;
  const needsNewline =
    sourceBytes.length > 0 &&
    sourceBytes[sourceBytes.length - 1] !== 0x0a &&
    sourceBytes[sourceBytes.length - 1] !== 0x0d;

  const chunks: Buffer[] = [sourceBytes];
  if (needsNewline) chunks.push(Buffer.from("\n", "latin1"));
  let offset = sourceBytes.length + (needsNewline ? 1 : 0);

  const offsets = new Map<number, { offset: number; gen: number }>();
  const sortedNums = [...updatedObjects.keys()].sort((a, b) => a - b);
  for (const num of sortedNums) {
    const entry = updatedObjects.get(num)!;
    offsets.set(num, { offset, gen: entry.gen });
    const wrapped = Buffer.concat([
      Buffer.from(`${num} ${entry.gen} obj\n`, "latin1"),
      entry.body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(wrapped);
    offset += wrapped.length;
  }

  const rootVal = dictGet(parser.trailer, "Root");
  const infoVal = dictGet(parser.trailer, "Info");
  const updatedId = buildUpdatedIdArray(
    parser,
    sourceSha256,
    `${sortedNums.join(",")}:${offset}`,
  );
  const origSize =
    asNum(dictGet(parser.trailer, "Size")) ?? parser.maxObjNum + 1;

  if (parser.usesXrefStream) {
    const xrefObjNum = nextObjNum;
    const xrefOffset = offset;
    offsets.set(xrefObjNum, { offset: xrefOffset, gen: 0 });
    const newSize = Math.max(origSize, xrefObjNum + 1);
    const subsections = groupContiguousSubsections([...offsets.keys()]);

    const indexVals: number[] = [];
    const rowBufs: Buffer[] = [];
    for (const sub of subsections) {
      indexVals.push(sub.start, sub.items.length);
      for (const objNum of sub.items) {
        const meta = offsets.get(objNum)!;
        const row = Buffer.alloc(7);
        row[0] = 1;
        row.writeUInt32BE(meta.offset, 1);
        row.writeUInt16BE(meta.gen, 5);
        rowBufs.push(row);
      }
    }

    const compressed = zlib.deflateSync(Buffer.concat(rowBufs));
    const dictParts: string[] = [
      "/Type /XRef",
      `/Size ${newSize}`,
      `/Index [${indexVals.join(" ")}]`,
      "/W [1 4 2]",
    ];
    if (rootVal) dictParts.push(`/Root ${serializePdfVal(rootVal)}`);
    if (infoVal) dictParts.push(`/Info ${serializePdfVal(infoVal)}`);
    if (updatedId) dictParts.push(`/ID ${serializePdfVal(updatedId)}`);
    if (parser.startXrefOffset > 0) {
      dictParts.push(`/Prev ${parser.startXrefOffset}`);
    }
    dictParts.push("/Filter /FlateDecode", `/Length ${compressed.length}`);

    chunks.push(
      Buffer.from(
        `${xrefObjNum} 0 obj\n<< ${dictParts.join(" ")} >>\nstream\n`,
        "latin1",
      ),
      compressed,
      Buffer.from(
        `\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`,
        "latin1",
      ),
    );
    return { bytes: Buffer.concat(chunks), xrefFormat: "xref-stream" };
  }

  const xrefOffset = offset;
  const newSize = Math.max(
    origSize,
    nextObjNum,
    ...(sortedNums.length ? [sortedNums[sortedNums.length - 1] + 1] : [0]),
  );
  const subsections = groupContiguousSubsections(sortedNums);
  const xrefLines: string[] = ["xref\n"];
  for (const sub of subsections) {
    xrefLines.push(`${sub.start} ${sub.items.length}\n`);
    for (const objNum of sub.items) {
      const meta = offsets.get(objNum)!;
      xrefLines.push(
        `${String(meta.offset).padStart(10, "0")} ${String(meta.gen).padStart(5, "0")} n \n`,
      );
    }
  }

  const trailerParts: string[] = [`/Size ${newSize}`];
  if (rootVal) trailerParts.push(`/Root ${serializePdfVal(rootVal)}`);
  if (infoVal) trailerParts.push(`/Info ${serializePdfVal(infoVal)}`);
  if (updatedId) trailerParts.push(`/ID ${serializePdfVal(updatedId)}`);
  if (parser.startXrefOffset > 0) {
    trailerParts.push(`/Prev ${parser.startXrefOffset}`);
  }

  chunks.push(
    Buffer.from(xrefLines.join(""), "latin1"),
    Buffer.from(
      `trailer\n<< ${trailerParts.join(" ")} >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      "latin1",
    ),
  );
  return { bytes: Buffer.concat(chunks), xrefFormat: "classic" };
}

function normalizeForReadback(text: string): string {
  return normalizeExtractedPdfText(text).replace(/\s+/g, "");
}

async function extractPageTextViaPdftotext(
  pdfPath: string,
  pageNumber: number,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await run(
      "pdftotext",
      ["-f", String(pageNumber), "-l", String(pageNumber), pdfPath, "-"],
      { signal, timeout: 30000 },
    );
    if (res.exitCode !== 0) return null;
    return res.stdout;
  } catch {
    return null;
  }
}

async function extractPageTextFallback(
  pdfBytes: Uint8Array,
  pageNumber: number,
): Promise<string> {
  // Reuse extractPdfRawPages indirectly via PdfDocumentParser when pdftotext is absent.
  const parser = new PdfDocumentParser(pdfBytes);
  const pages = collectPages(parser);
  const rec = pages.find((p) => p.page === pageNumber);
  if (!rec) return "";
  const buf = decodePageContentBuffer(parser, rec.dict);
  // Decode both 2-byte ToUnicode CID hex strings and literal strings via ToUnicode CMap.
  const fontsDict = asDict(parser.resolve(dictGet(rec.resources, "Font")));
  const maps = new Map<string, Map<number, string>>();
  if (fontsDict) {
    for (const [fname, fval] of fontsDict.entries) {
      const fdict = asDict(parser.resolve(fval));
      const toUni = fdict ? parser.resolve(dictGet(fdict, "ToUnicode")) : null;
      if (
        toUni &&
        typeof toUni === "object" &&
        !Array.isArray(toUni) &&
        toUni.kind === "stream"
      ) {
        const cmap = parser.decodeStream(toUni).toString("latin1");
        const m = new Map<number, string>();
        for (const blk of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
          for (const pair of blk[1].matchAll(
            /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
          )) {
            const hex = pair[2];
            const raw = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
            let decoded = "";
            for (let i = 0; i + 1 < raw.length; i += 2) {
              decoded += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
            }
            m.set(Number.parseInt(pair[1], 16), decoded);
          }
        }
        maps.set(fname, m);
      }
    }
  }
  const content = buf.toString("latin1");
  let activeFont = "";
  let out = "";
  for (const match of content.matchAll(
    /\/([^\s/<>()[\]]+)\s+[0-9.]+\s+Tf|<([0-9a-fA-F]+)>\s*Tj|\(([^)]*)\)\s*Tj/g,
  )) {
    if (match[1]) {
      activeFont = match[1];
    } else if (match[2]) {
      const map = maps.get(activeFont);
      const raw = Buffer.from(match[2], "hex");
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const code = (raw[i] << 8) | raw[i + 1];
        out += map?.get(code) ?? "";
      }
    } else if (match[3]) {
      out += match[3];
    }
  }
  return out;
}

/**
 * Post-write readback gate verifying that every repaired page's embedded PDF text layer
 * matches the normalized proofread blocks + footnotes. Fails with PDF_OCR_LAYER_STALE on drift.
 */
export async function verifyPdfOcrLayerReadback(
  pdfPath: string,
  spec: PdfSpec,
  repairedPages: number[],
  options: { signal?: AbortSignal } = {},
): Promise<{ readbackTool: "pdftotext" | "internal-parser" }> {
  const resolved = path.resolve(pdfPath);
  const bytes = await readSourceFile(resolved);
  const probe = await extractPageTextViaPdftotext(
    resolved,
    repairedPages[0] ?? 1,
    options.signal,
  );
  const usePoppler = probe !== null;
  const specByPage = new Map(spec.pages.map((p) => [p.page, p]));

  for (const pageNum of repairedPages) {
    checkAbort(options.signal);
    const sp = specByPage.get(pageNum);
    if (!sp) continue;
    const expected = normalizeForReadback(
      collectPageTranscribedLines(sp).join(""),
    );
    const actualRaw = usePoppler
      ? ((pageNum === (repairedPages[0] ?? 1)
          ? probe
          : await extractPageTextViaPdftotext(
              resolved,
              pageNum,
              options.signal,
            )) ?? "")
      : await extractPageTextFallback(bytes, pageNum);
    const actual = normalizeForReadback(actualRaw);

    const mismatch =
      sp.classification === "hybrid"
        ? expected.length > 0 && !actual.includes(expected)
        : actual !== expected;
    if (mismatch) {
      fail(
        "PDF_OCR_LAYER_STALE",
        `Repaired PDF text layer on page ${pageNum} diverged from proofread blocks (expected "${expected.slice(0, 80)}", read back "${actual.slice(0, 80)}")`,
        { page: pageNum, expected, actual },
      );
    }
  }
  return { readbackTool: usePoppler ? "pdftotext" : "internal-parser" };
}

async function resolveOptionalVerification(
  input: string | PdfVerificationFile | undefined,
): Promise<{
  verification?: PdfVerificationFile;
  verificationFileSha256?: string;
}> {
  if (!input) return {};
  if (typeof input === "string") {
    const resolved = path.resolve(input);
    const bytes = await readSourceFile(resolved);
    const parsed = pdfVerificationFileSchema.safeParse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (!parsed.success) {
      fail("PDF_VERIFICATION_INVALID", parsed.error.message);
    }
    return { verification: parsed.data, verificationFileSha256: sha256(bytes) };
  }
  const parsed = pdfVerificationFileSchema.safeParse(input);
  if (!parsed.success) fail("PDF_VERIFICATION_INVALID", parsed.error.message);
  return { verification: parsed.data };
}

async function resolveOptionalRenderManifest(
  input: string | PdfRenderManifest | undefined,
  fallbackPath?: string,
): Promise<PdfRenderManifest | undefined> {
  if (input) {
    if (typeof input === "string") {
      return pdfRenderManifestSchema.parse(
        await readJson<unknown>(path.resolve(input)),
      );
    }
    return pdfRenderManifestSchema.parse(input);
  }
  if (fallbackPath && (await exists(fallbackPath))) {
    return pdfRenderManifestSchema.parse(await readJson<unknown>(fallbackPath));
  }
  return undefined;
}

/**
 * Repair a scanned or hybrid PDF's invisible OCR text layer and /Outlines bookmarks
 * via a true PDF incremental update driven exclusively by verified proofread blocks
 * + deterministic line geometry.
 */
export async function repairScannedPdf(
  pdfFile: string,
  specFileOrObject: string | PdfSpec,
  outputPdfFile: string,
  options: {
    verification?: string | PdfVerificationFile;
    renderManifest?: string | PdfRenderManifest;
    backup?: string;
    reports?: string;
    signal?: AbortSignal;
  } = {},
): Promise<PdfRepairReport> {
  checkAbort(options.signal);
  if (!isPdfPath(pdfFile)) fail("UNSUPPORTED_FORMAT", "Choose a .pdf source");
  const resolvedSource = path.resolve(pdfFile);
  const resolvedOutput = path.resolve(outputPdfFile);
  if (!isPdfPath(resolvedOutput)) {
    fail("UNSUPPORTED_FORMAT", "Output path must use the .pdf extension");
  }
  if (await exists(resolvedOutput)) {
    fail(
      "OUTPUT_EXISTS",
      `Refusing to overwrite existing output: ${resolvedOutput}`,
    );
  }

  const sourceBytes = Buffer.from(await readSourceFile(resolvedSource));
  if (!isPdfBytes(sourceBytes)) {
    fail("PDF_INVALID", "Input file does not start with a valid %PDF- header");
  }
  const sourceSha256 = sha256(sourceBytes);

  const rawSpec =
    typeof specFileOrObject === "string"
      ? await readJson<unknown>(path.resolve(specFileOrObject))
      : specFileOrObject;
  const parsedSpec = pdfSpecSchema.safeParse(rawSpec);
  if (!parsedSpec.success) fail("PDF_SPEC_INVALID", parsedSpec.error.message);
  const spec = parsedSpec.data;

  if (spec.source.sha256 !== sourceSha256) {
    fail(
      "SOURCE_HASH_MISMATCH",
      `Source PDF SHA-256 (${sourceSha256}) does not match spec (${spec.source.sha256})`,
    );
  }

  const [{ verification, verificationFileSha256 }, renderManifest] =
    await Promise.all([
      resolveOptionalVerification(options.verification),
      resolveOptionalRenderManifest(
        options.renderManifest,
        spec.renderManifestPath,
      ),
    ]);

  assertPdfSpecVerified(spec, { verification, renderManifest });

  const parser = new PdfDocumentParser(sourceBytes);
  const pageRecords = collectPages(parser);
  const pageRecByNum = new Map(pageRecords.map((r) => [r.page, r]));

  // Snapshot all source image XObject digests to prove bit-identical preservation.
  const sourceImageHashes = new Map<string, string>();
  for (const rec of pageRecords) {
    for (const img of collectPageImageStreams(parser, rec)) {
      sourceImageHashes.set(
        `${rec.page}:${img.inventory.name}`,
        img.inventory.streamSha256,
      );
    }
  }

  let nextObjNum = parser.maxObjNum + 1;
  const allocObj = () => nextObjNum++;
  const updatedObjects = new Map<number, { gen: number; body: Buffer }>();

  const targetSpecPages = spec.pages.filter(
    (p) =>
      pageRequiresOcrVerification(p) ||
      p.classification === "scanned" ||
      p.ocrTrust === "unverified-embedded",
  );

  // Plan geometry + placements using ONLY verified proofread blocks + deterministic geometry.
  const plannedPages: {
    sp: PdfSpecPage;
    rec: PageRecord;
    placements: PlacedOcrLine[];
    alignment: PdfRepairPageAlignment;
  }[] = [];

  for (const sp of targetSpecPages) {
    checkAbort(options.signal);
    const rec = pageRecByNum.get(sp.page);
    if (!rec || rec.objNum <= 0) continue;
    let geometry: PdfLineGeometry[] = sp.geometry ?? [];
    if (
      geometry.length === 0 &&
      sp.render?.path &&
      (await exists(sp.render.path))
    ) {
      const projected = await detectLineGeometryFromImage(
        sp.render.path,
        rec.widthPt,
        rec.heightPt,
      );
      geometry = projected.geometry;
    }
    const { placements, alignment } = planPageOcrPlacements(sp, rec, geometry);
    plannedPages.push({ sp, rec, placements, alignment });
  }

  // Assign sequential 16-bit CIDs across every unique Unicode character in repaired pages.
  const charToCid = new Map<string, number>();
  let nextCid = 1;
  for (const { placements } of plannedPages) {
    for (const item of placements) {
      const clean = item.text.replace(/\s+/g, " ").trim();
      for (const ch of Array.from(clean)) {
        if (!charToCid.has(ch)) charToCid.set(ch, nextCid++);
      }
    }
  }
  const encodeTextHex = (text: string): string => {
    let hex = "";
    for (const ch of Array.from(text)) {
      const cid = charToCid.get(ch) ?? 1;
      hex += cid.toString(16).toUpperCase().padStart(4, "0");
    }
    return `<${hex}>`;
  };

  // Embed GlyphLess TrueType font + CIDToGIDMap + ToUnicode Type0 font objects.
  const ttfBytes = buildGlyphLessTrueTypeFont();
  const fontFileObjNum = allocObj();
  updatedObjects.set(fontFileObjNum, {
    gen: 0,
    body: buildFlateStreamObject(`/Length1 ${ttfBytes.length}`, ttfBytes),
  });

  const fontDescObjNum = allocObj();
  updatedObjects.set(fontDescObjNum, {
    gen: 0,
    body: Buffer.from(
      `<< /Type /FontDescriptor /FontName /QuillbindGlyphLess /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 800 /StemV 80 /FontFile2 ${fontFileObjNum} 0 R >>`,
      "latin1",
    ),
  });

  // Explicit zero-filled CIDToGIDMap maps every CID cleanly to existing GID 0 (.notdef).
  const cidToGidObjNum = allocObj();
  updatedObjects.set(cidToGidObjNum, {
    gen: 0,
    body: buildFlateStreamObject("", Buffer.alloc(Math.max(2, nextCid * 2), 0)),
  });

  const cidFontObjNum = allocObj();
  updatedObjects.set(cidFontObjNum, {
    gen: 0,
    body: Buffer.from(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /QuillbindGlyphLess /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${fontDescObjNum} 0 R /DW 1000 /CIDToGIDMap ${cidToGidObjNum} 0 R >>`,
      "latin1",
    ),
  });

  const toUnicodeObjNum = allocObj();
  updatedObjects.set(toUnicodeObjNum, {
    gen: 0,
    body: buildFlateStreamObject("", buildToUnicodeCMap(charToCid)),
  });

  const type0FontObjNum = allocObj();
  updatedObjects.set(type0FontObjNum, {
    gen: 0,
    body: Buffer.from(
      `<< /Type /Font /Subtype /Type0 /BaseFont /QuillbindGlyphLess /Encoding /Identity-H /DescendantFonts [${cidFontObjNum} 0 R] /ToUnicode ${toUnicodeObjNum} 0 R >>`,
      "latin1",
    ),
  });

  let strippedOcrArtifacts = 0;
  const pagesRepaired: number[] = [];
  const pageAlignments: PdfRepairPageAlignment[] = [];

  for (const { sp, rec, placements, alignment } of plannedPages) {
    pagesRepaired.push(sp.page);
    pageAlignments.push(alignment);

    const origContentBuf = decodePageContentBuffer(parser, rec.dict);
    const { cleaned, strippedBlocks } =
      stripInvisibleOcrFromContentStream(origContentBuf);
    strippedOcrArtifacts += strippedBlocks;

    const existingFonts = asDict(
      parser.resolve(dictGet(rec.resources, "Font")),
    );
    let fontResName = "QBF0";
    let suffix = 0;
    while (existingFonts?.entries.has(fontResName)) {
      suffix++;
      fontResName = `QBF${suffix}`;
    }

    const ocrStreamBuf = buildInvisibleOcrStream(
      placements,
      rec,
      fontResName,
      encodeTextHex,
    );
    const ocrStreamObjNum = allocObj();
    updatedObjects.set(ocrStreamObjNum, {
      gen: 0,
      body: buildFlateStreamObject("", ocrStreamBuf),
    });

    // Preserve original content stream untouched when no invisible OCR had to be stripped.
    let contentsVal: PdfVal;
    const origContentsEntry = dictGet(rec.dict, "Contents");
    if (strippedBlocks === 0 && origContentsEntry) {
      const origRef = asRef(origContentsEntry);
      const origArr = asArr(parser.resolve(origContentsEntry));
      if (origRef) {
        contentsVal = [origRef, { kind: "ref", num: ocrStreamObjNum, gen: 0 }];
      } else if (origArr) {
        contentsVal = [
          ...origArr,
          { kind: "ref", num: ocrStreamObjNum, gen: 0 },
        ];
      } else {
        const preservedObjNum = allocObj();
        updatedObjects.set(preservedObjNum, {
          gen: 0,
          body: buildFlateStreamObject("", origContentBuf),
        });
        contentsVal = [
          { kind: "ref", num: preservedObjNum, gen: 0 },
          { kind: "ref", num: ocrStreamObjNum, gen: 0 },
        ];
      }
    } else {
      const cleanStreamObjNum = allocObj();
      updatedObjects.set(cleanStreamObjNum, {
        gen: 0,
        body: buildFlateStreamObject("", cleaned),
      });
      contentsVal = [
        { kind: "ref", num: cleanStreamObjNum, gen: 0 },
        { kind: "ref", num: ocrStreamObjNum, gen: 0 },
      ];
    }

    // Clone page dict preserving all non-OCR keys and stripping /ReaddleObject artifacts.
    const nextPageEntries = new Map<string, PdfVal>(rec.dict.entries);
    nextPageEntries.set("Contents", contentsVal);

    const pieceInfo = asDict(parser.resolve(dictGet(rec.dict, "PieceInfo")));
    if (pieceInfo) {
      const filteredPiece = new Map<string, PdfVal>();
      for (const [k, v] of pieceInfo.entries) {
        if (k.includes("Readdle")) {
          strippedOcrArtifacts++;
        } else {
          filteredPiece.set(k, v);
        }
      }
      if (filteredPiece.size > 0) {
        nextPageEntries.set("PieceInfo", {
          kind: "dict",
          entries: filteredPiece,
        });
      } else {
        nextPageEntries.delete("PieceInfo");
      }
    }

    const annots = asArr(parser.resolve(dictGet(rec.dict, "Annots")));
    if (annots) {
      const keptAnnots: PdfVal[] = [];
      let droppedAnnots = 0;
      for (const aVal of annots) {
        const aDict = asDict(parser.resolve(aVal));
        const hasReaddle =
          aDict && [...aDict.entries.keys()].some((k) => k.includes("Readdle"));
        if (hasReaddle) {
          droppedAnnots++;
          strippedOcrArtifacts++;
        } else {
          keptAnnots.push(aVal);
        }
      }
      if (droppedAnnots > 0) {
        if (keptAnnots.length > 0) nextPageEntries.set("Annots", keptAnnots);
        else nextPageEntries.delete("Annots");
      }
    }

    const mergedResources: PdfDict = {
      kind: "dict",
      entries: new Map(rec.resources?.entries ?? []),
    };
    const mergedFonts: PdfDict = {
      kind: "dict",
      entries: new Map(existingFonts?.entries ?? []),
    };
    mergedFonts.entries.set(fontResName, {
      kind: "ref",
      num: type0FontObjNum,
      gen: 0,
    });
    mergedResources.entries.set("Font", mergedFonts);
    nextPageEntries.set("Resources", mergedResources);

    updatedObjects.set(rec.objNum, {
      gen: rec.gen,
      body: Buffer.from(
        serializePdfVal({ kind: "dict", entries: nextPageEntries }),
        "latin1",
      ),
    });
  }

  // Write /Outlines bookmarks incrementally if spec supplies an outline tree.
  let outlineEntries = 0;
  const outlineBuilt = buildOutlineObjects(
    spec.outline,
    pageRecords,
    allocObj,
    updatedObjects,
  );
  if (outlineBuilt) {
    outlineEntries = outlineBuilt.count;
    const rootRef = asRef(dictGet(parser.trailer, "Root"));
    const rootDict = asDict(parser.resolve(rootRef));
    if (rootRef && rootDict) {
      const nextRootEntries = new Map<string, PdfVal>(rootDict.entries);
      nextRootEntries.set("Outlines", {
        kind: "ref",
        num: outlineBuilt.rootObjNum,
        gen: 0,
      });
      const rootXref = parser.xref.get(rootRef.num);
      const rootGen =
        rootXref?.type === "uncompressed" ? rootXref.gen : rootRef.gen;
      updatedObjects.set(rootRef.num, {
        gen: rootGen,
        body: Buffer.from(
          serializePdfVal({ kind: "dict", entries: nextRootEntries }),
          "latin1",
        ),
      });
    }
  }

  const { bytes: repairedBytes, xrefFormat } = appendIncrementalPdfUpdate({
    sourceBytes,
    sourceSha256,
    parser,
    updatedObjects,
    nextObjNum,
  });

  if (!repairedBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) {
    fail(
      "PDF_INCREMENTAL_PREFIX_BROKEN",
      "Incremental update failed to preserve original source PDF prefix bytes",
    );
  }

  // Verify every embedded image XObject stream remains bit-identical after update.
  const verifyParser = new PdfDocumentParser(repairedBytes);
  const verifyPages = collectPages(verifyParser);
  const repairedImageHashes = new Map<string, string>();
  for (const rec of verifyPages) {
    for (const img of collectPageImageStreams(verifyParser, rec)) {
      repairedImageHashes.set(
        `${rec.page}:${img.inventory.name}`,
        img.inventory.streamSha256,
      );
    }
  }
  for (const [key, expectedSha] of sourceImageHashes) {
    if (repairedImageHashes.get(key) !== expectedSha) {
      fail(
        "PDF_IMAGE_STREAM_MUTATED",
        `Image stream ${key} changed or went missing during incremental PDF repair`,
      );
    }
  }

  const reports = path.resolve(options.reports ?? `${resolvedOutput}.reports`);
  await fs.mkdir(reports, { recursive: true });
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
  const candidate = `${resolvedOutput}.${randomUUID()}.candidate.pdf`;

  let backupRecord: { path: string; sha256: string } | undefined;
  if (options.backup) {
    const resolvedBackup = path.resolve(options.backup);
    if (await exists(resolvedBackup)) {
      fail(
        "OUTPUT_EXISTS",
        `Refusing to overwrite existing backup: ${resolvedBackup}`,
      );
    }
    await fs.mkdir(path.dirname(resolvedBackup), { recursive: true });
    await fs.writeFile(resolvedBackup, sourceBytes, { flag: "wx" });
    backupRecord = { path: resolvedBackup, sha256: sourceSha256 };
  }

  try {
    await fs.writeFile(candidate, repairedBytes, { flag: "wx" });

    // P0-1 readback gate: normalized readback text MUST match verified proofread blocks.
    const { readbackTool } = await verifyPdfOcrLayerReadback(
      candidate,
      spec,
      pagesRepaired,
      { signal: options.signal },
    );

    checkAbort(options.signal);
    await fs.link(candidate, resolvedOutput);

    if (sha256(await readSourceFile(resolvedSource)) !== sourceSha256) {
      fail("SOURCE_CHANGED", "Source PDF changed during OCR repair");
    }

    const pagesRequiringVerification = spec.pages
      .filter((p) => pageRequiresOcrVerification(p))
      .map((p) => p.page);
    const report: PdfRepairReport = {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      operation: "pdf-repair-ocr",
      status: "pass",
      source: { path: resolvedSource, sha256: sourceSha256 },
      output: { path: resolvedOutput, sha256: sha256(repairedBytes) },
      ...(backupRecord ? { backup: backupRecord } : {}),
      incrementalUpdate: true,
      xrefFormat,
      pagesRepaired,
      pageAlignments,
      strippedOcrArtifacts,
      outlineEntries,
      ocrLayerVerified: true,
      readbackTool,
      preservedImageStreams: {
        count: sourceImageHashes.size,
        verifiedBitIdentical: true,
      },
      verification: {
        pagesRequiringVerification,
        ...(verification
          ? {
              verifierId: verification.verifierId,
              verifiedAt: verification.verifiedAt,
            }
          : {}),
        ...(verificationFileSha256 ? { verificationFileSha256 } : {}),
      },
      reports,
    };
    await json(path.join(reports, "pdf-repair.json"), report);
    return report;
  } finally {
    await fs.rm(candidate, { force: true });
  }
}
