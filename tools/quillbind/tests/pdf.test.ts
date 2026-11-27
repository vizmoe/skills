import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { readPdfRules } from "../../../skills/quillbind/scripts/skill-rules.js";
import { checkNotes } from "../packages/core/src/check-notes.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { sha256 } from "../packages/core/src/hash.js";
import { json, readJson } from "../packages/core/src/json.js";
import {
  buildEpubFromPdfSpec,
  convertPdfToEpub,
  enhancePdfImage,
  renderPdfSpecToEpub,
} from "../packages/core/src/pdf-epub.js";
import {
  PdfDocumentParser,
  asArr,
  asDict,
  collectPages,
  detectLineGeometryFromImage,
  dictGet,
  estimatePageImageTokens,
  extractOutline,
  extractPdfRawPages,
  inspectPdf,
  isPdfBytes,
  isPdfPath,
  normalizeExtractedPdfText,
  parsePdftotextBboxLayout,
  planPdfShards,
  sliceRenderedPageTiles,
  stripInvisibleOcrFromContentStream,
} from "../packages/core/src/pdf-binary.js";
import {
  buildGlyphLessTrueTypeFont,
  repairScannedPdf,
  verifyPdfOcrLayerReadback,
} from "../packages/core/src/pdf-repair.js";
import {
  PDF_SPEC_SCHEMA_VERSION,
  pageRequiresOcrVerification,
  type PdfPageFile,
  type PdfRenderManifest,
  type PdfShardFile,
  type PdfSpec,
  type PdfVerificationFile,
} from "../packages/core/src/pdf-model.js";
import {
  assertPdfSpecVerified,
  checkPdfSpec,
  compilePdfPageMarkdown,
  computePageContentSha256,
  initPdfShards,
  initPdfSpec,
  mergePdfShards,
  stitchPdfPagesInPlace,
  validatePdfShard,
  validateTableGrid,
  verifyPdfSpecPages,
} from "../packages/core/src/pdf-shard.js";
import { run } from "../packages/core/src/process.js";
import { browserPath } from "../packages/core/src/qa-environment.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { validateInternal } from "../packages/core/src/validate.js";

const temporary: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-pdf-test-"));
  const real = await fs.realpath(dir);
  temporary.push(real);
  return real;
}

afterEach(async () => {
  for (const dir of temporary.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function utf16Hex(text: string): string {
  const bytes: number[] = [0xfe, 0xff];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes.push((code >>> 8) & 0xff, code & 0xff);
  }
  return `<${Buffer.from(bytes).toString("hex").toUpperCase()}>`;
}

function pdfStream(dictEntries: string, rawData: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `<< ${dictEntries} /Length ${rawData.length} >>\nstream\n`,
      "latin1",
    ),
    rawData,
    Buffer.from("\nendstream", "latin1"),
  ]);
}

function flateStream(dictEntries: string, plainText: string | Buffer): Buffer {
  const raw = zlib.deflateSync(
    typeof plainText === "string"
      ? Buffer.from(plainText, "latin1")
      : plainText,
  );
  return pdfStream(`/Filter /FlateDecode ${dictEntries}`.trim(), raw);
}

function buildClassicPdf(
  objects: Map<number, string | Buffer>,
  options: {
    version?: string;
    rootObj?: number;
    infoObj?: number;
    encryptObj?: number;
  } = {},
): Buffer {
  const version = options.version ?? "1.4";
  const sorted = [...objects.keys()].sort((a, b) => a - b);
  const maxObj = sorted[sorted.length - 1] ?? 0;
  const header = Buffer.from(`%PDF-${version}\n%\xE2\xE3\xCF\xD3\n`, "latin1");
  const chunks: Buffer[] = [header];
  let offset = header.length;
  const offsets = new Map<number, number>();

  for (const num of sorted) {
    offsets.set(num, offset);
    const body = objects.get(num)!;
    const bodyBuf =
      typeof body === "string" ? Buffer.from(body, "latin1") : body;
    const wrapped = Buffer.concat([
      Buffer.from(`${num} 0 obj\n`, "latin1"),
      bodyBuf,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(wrapped);
    offset += wrapped.length;
  }

  const xrefStart = offset;
  const xrefLines = [`xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`];
  for (let i = 1; i <= maxObj; i++) {
    const off = offsets.get(i);
    xrefLines.push(
      off !== undefined
        ? `${String(off).padStart(10, "0")} 00000 n \n`
        : "0000000000 65535 f \n",
    );
  }
  const trailerParts = [
    `/Size ${maxObj + 1}`,
    `/Root ${options.rootObj ?? 1} 0 R`,
  ];
  if (options.infoObj) trailerParts.push(`/Info ${options.infoObj} 0 R`);
  if (options.encryptObj)
    trailerParts.push(`/Encrypt ${options.encryptObj} 0 R`);

  chunks.push(
    Buffer.from(xrefLines.join(""), "latin1"),
    Buffer.from(
      `trailer\n<< ${trailerParts.join(" ")} >>\nstartxref\n${xrefStart}\n%%EOF\n`,
      "latin1",
    ),
  );
  return Buffer.concat(chunks);
}

function buildCmapFontObjects(
  glyphList: string[],
  startObjNum: number,
): {
  fontRefObj: number;
  objects: Map<number, string | Buffer>;
  encodeCidHex: (text: string) => string;
} {
  const unique = Array.from(new Set(glyphList));
  const charToCid = new Map<string, number>();
  unique.forEach((ch, idx) => charToCid.set(ch, idx + 1));

  const bfChars: string[] = [];
  for (const [ch, cid] of charToCid.entries()) {
    const u16 = Buffer.from(ch, "utf16le")
      .swap16()
      .toString("hex")
      .toUpperCase();
    bfChars.push(
      `<${cid.toString(16).padStart(4, "0").toUpperCase()}> <${u16}>`,
    );
  }
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    `${bfChars.length} beginbfchar`,
    ...bfChars,
    "endbfchar",
    "2 beginbfrange",
    "<F001> <F002> <0041>",
    "<F010> <F011> [<2460> <2461>]",
    "endbfrange",
    "endcmap",
  ].join("\n");

  const cmapObj = startObjNum;
  const cidObj = startObjNum + 1;
  const fontObj = startObjNum + 2;
  const objects = new Map<number, string | Buffer>();
  objects.set(cmapObj, flateStream("", cmap));
  objects.set(
    cidObj,
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestCJK /DW 1000 >>",
  );
  objects.set(
    fontObj,
    `<< /Type /Font /Subtype /Type0 /BaseFont /TestCJK /Encoding /Identity-H /DescendantFonts [${cidObj} 0 R] /ToUnicode ${cmapObj} 0 R >>`,
  );

  const encodeCidHex = (text: string) => {
    const hex = Array.from(text)
      .map((ch) => {
        if (ch === "①") return "F010";
        if (ch === "②") return "F011";
        const cid = charToCid.get(ch);
        if (!cid) throw new Error(`Missing glyph in test CMap: ${ch}`);
        return cid.toString(16).padStart(4, "0").toUpperCase();
      })
      .join("");
    return `<${hex}>`;
  };

  return { fontRefObj: fontObj, objects, encodeCidHex };
}

function buildDigitalHybridPdf(): Buffer {
  const texts = [
    "山间札记",
    "第一章 晨雾与山径",
    "这是一段带注释①的跨页句子，在页末尚未结束",
    "① 页脚注释：晨雾指山谷清晨的水汽。",
    "在这里自然缝合成完整的段落。",
    "第二章 图文混排",
    "原生文字搭配一张大图，应判为数字原生文本。",
    "1",
    "2",
    "3",
  ];
  const allGlyphs = Array.from(new Set(Array.from(texts.join(""))));
  const { fontRefObj, objects, encodeCidHex } = buildCmapFontObjects(
    allGlyphs,
    20,
  );
  const photoRaw = zlib.deflateSync(Buffer.alloc(320 * 320 * 3, 0x77));
  objects.set(
    18,
    pdfStream(
      "/Type /XObject /Subtype /Image /Width 320 /Height 320 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
      photoRaw,
    ),
  );
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R /Outlines 11 0 R >>");
  objects.set(
    2,
    "<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] /MediaBox [0 0 595 842] >>",
  );
  objects.set(
    3,
    `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontRefObj} 0 R >> >> /Contents 7 0 R >>`,
  );
  objects.set(
    4,
    `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontRefObj} 0 R >> >> /Contents 8 0 R >>`,
  );
  objects.set(
    5,
    `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontRefObj} 0 R >> /XObject << /ImPhoto 18 0 R >> >> /Contents 9 0 R >>`,
  );

  objects.set(
    7,
    flateStream(
      "",
      [
        "BT",
        `/F1 10 Tf 1 0 0 1 72 800 Tm ${encodeCidHex("山间札记")} Tj`,
        `/F1 20 Tf 1 0 0 1 72 720 Tm ${encodeCidHex("第一章 晨雾与山径")} Tj`,
        `/F1 12 Tf 1 0 0 1 72 650 Tm ${encodeCidHex("这是一段带注释①的跨页句子，在页末尚未结束")} Tj`,
        `/F1 9 Tf 1 0 0 1 72 95 Tm ${encodeCidHex("① 页脚注释：晨雾指山谷清晨的水汽。")} Tj`,
        `/F1 10 Tf 1 0 0 1 290 40 Tm ${encodeCidHex("1")} Tj`,
        "ET",
      ].join("\n"),
    ),
  );
  objects.set(
    8,
    flateStream(
      "",
      [
        "BT",
        `/F1 10 Tf 1 0 0 1 72 800 Tm ${encodeCidHex("山间札记")} Tj`,
        `/F1 12 Tf 1 0 0 1 72 730 Tm ${encodeCidHex("在这里自然缝合成完整的段落。")} Tj`,
        `/F1 10 Tf 1 0 0 1 290 40 Tm ${encodeCidHex("2")} Tj`,
        "ET",
      ].join("\n"),
    ),
  );
  objects.set(
    9,
    flateStream(
      "",
      [
        "q 300 0 0 300 72 200 cm /ImPhoto Do Q",
        "BT",
        `/F1 10 Tf 1 0 0 1 72 800 Tm ${encodeCidHex("山间札记")} Tj`,
        `/F1 20 Tf 1 0 0 1 72 720 Tm ${encodeCidHex("第二章 图文混排")} Tj`,
        `/F1 12 Tf 1 0 0 1 72 660 Tm ${encodeCidHex("原生文字搭配一张大图，应判为数字原生文本。")} Tj`,
        `/F1 10 Tf 1 0 0 1 290 40 Tm ${encodeCidHex("3")} Tj`,
        "ET",
      ].join("\n"),
    ),
  );

  objects.set(11, "<< /Type /Outlines /First 12 0 R /Last 13 0 R /Count 2 >>");
  objects.set(
    12,
    `<< /Title ${utf16Hex("第一章 晨雾与山径")} /Parent 11 0 R /Next 13 0 R /Dest [3 0 R /XYZ null null null] >>`,
  );
  objects.set(
    13,
    `<< /Title ${utf16Hex("第二章 图文混排")} /Parent 11 0 R /Prev 12 0 R /Dest [5 0 R /XYZ null null null] >>`,
  );
  objects.set(
    15,
    `<< /Title ${utf16Hex("山间札记")} /Author ${utf16Hex("林清玄; 苏轼")} /Subject ( Mountain\x84Notes ) >>`,
  );
  return buildClassicPdf(objects, { rootObj: 1, infoObj: 15, version: "1.6" });
}

function buildScannedPdf(): Buffer {
  const img1 = zlib.deflateSync(Buffer.alloc(120 * 160 * 3, 0xee));
  const objects = new Map<number, string | Buffer>();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    "<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] /MediaBox [0 0 595 842] >>",
  );
  objects.set(
    11,
    pdfStream(
      "/Type /XObject /Subtype /Image /Width 120 /Height 160 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
      img1,
    ),
  );
  objects.set(13, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.set(
    3,
    "<< /Type /Page /Parent 2 0 R /PieceInfo << /ReaddleObject << /Private (bad) >> >> /Resources << /XObject << /Im1 11 0 R >> /Font << /F1 13 0 R >> >> /Contents 7 0 R >>",
  );
  objects.set(
    7,
    flateStream(
      "",
      "q 595 0 0 842 0 0 cm /Im1 Do Q\nBT 3 Tr /F1 12 Tf 1 0 0 1 72 700 Tm (Helo wrold te) Tj ET",
    ),
  );
  objects.set(
    4,
    "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 11 0 R >> >> /Contents 8 0 R >>",
  );
  objects.set(8, flateStream("", "q 595 0 0 842 0 0 cm /Im1 Do Q"));
  objects.set(
    5,
    "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 11 0 R >> >> /Contents 9 0 R >>",
  );
  objects.set(9, flateStream("", "q 595 0 0 842 0 0 cm /Im1 Do Q"));
  return buildClassicPdf(objects, { rootObj: 1, version: "1.7" });
}

function buildPdf15CompressedXref(): Buffer {
  const obj1 = "<< /Type /Catalog /Pages 2 0 R >>";
  const obj2 =
    "<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 600] >>";
  const obj4 = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const entries = [
    { num: 1, str: obj1 },
    { num: 2, str: obj2 },
    { num: 4, str: obj4 },
  ];
  const bodyParts: string[] = [];
  const headerPairs: string[] = [];
  let relOffset = 0;
  for (const item of entries) {
    headerPairs.push(`${item.num} ${relOffset}`);
    bodyParts.push(item.str);
    relOffset += Buffer.byteLength(item.str, "latin1") + 1;
  }
  const headerStr = `${headerPairs.join(" ")}\n`;
  const firstOffset = Buffer.byteLength(headerStr, "latin1");
  const obj5Stream = flateStream(
    `/Type /ObjStm /N ${entries.length} /First ${firstOffset}`,
    Buffer.from(`${headerStr}${bodyParts.join("\n")}`, "latin1"),
  );
  const obj3 = Buffer.from(
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
    "latin1",
  );
  const obj6 = flateStream(
    "",
    "q 1 0 0 -1 0 600 cm BT /F1 14 Tf 1 0 0 -1 50 100 Tm (Top Line Under Y Flip) Tj 0 -30 Td (Second Line Below) Tj ET Q",
  );
  const fileHeader = Buffer.from("%PDF-1.5\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const chunks: Buffer[] = [fileHeader];
  let pos = fileHeader.length;
  const wrapObj = (num: number, content: Buffer) => {
    const start = pos;
    const buf = Buffer.concat([
      Buffer.from(`${num} 0 obj\n`, "latin1"),
      content,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(buf);
    pos += buf.length;
    return start;
  };
  const off3 = wrapObj(3, obj3);
  const off5 = wrapObj(5, obj5Stream);
  const off6 = wrapObj(6, obj6);
  const off7 = pos;

  const rawRows: Buffer[] = [];
  const pushRow = (type: number, f2: number, f3: number) => {
    const b = Buffer.alloc(5);
    b[0] = type;
    b[1] = (f2 >>> 16) & 0xff;
    b[2] = (f2 >>> 8) & 0xff;
    b[3] = f2 & 0xff;
    b[4] = f3 & 0xff;
    rawRows.push(b);
  };
  pushRow(0, 0, 255);
  pushRow(2, 5, 0);
  pushRow(2, 5, 1);
  pushRow(1, off3, 0);
  pushRow(2, 5, 2);
  pushRow(1, off5, 0);
  pushRow(1, off6, 0);
  pushRow(1, off7, 0);

  const predictedRows: Buffer[] = [];
  let prev: Buffer = Buffer.alloc(5, 0);
  for (const row of rawRows) {
    const out = Buffer.alloc(6);
    out[0] = 2;
    for (let c = 0; c < 5; c++) out[c + 1] = (row[c] - prev[c]) & 0xff;
    predictedRows.push(out);
    prev = row;
  }
  const xrefStream = flateStream(
    "/Type /XRef /Size 8 /Root 1 0 R /W [1 3 1] /DecodeParms << /Predictor 12 /Columns 5 >>",
    Buffer.concat(predictedRows),
  );
  wrapObj(7, xrefStream);
  chunks.push(Buffer.from(`startxref\n${off7}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

async function makeSyntheticPagePng(filePath: string): Promise<string> {
  const width = 400;
  const height = 600;
  const raw = Buffer.alloc(width * height, 250);
  // Draw 6 crisp horizontal dark text bands
  for (let band = 0; band < 6; band++) {
    const y0 = 60 + band * 60;
    for (let y = y0; y < y0 + 18; y++) {
      for (let x = 40; x < 350; x++) {
        if ((x + y) % 3 !== 0) raw[y * width + x] = 30;
      }
    }
  }
  await sharp(raw, { raw: { width, height, channels: 1 } })
    .png()
    .toFile(filePath);
  return sha256(await fs.readFile(filePath));
}

describe("PDF inspection, ocrTrust gating, bbox-layout and Chrome extraction", () => {
  it("normalizes Kangxi radicals and ligatures without altering CJK punctuation or circled markers", () => {
    expect(normalizeExtractedPdfText("中⽂①，测试（ﬁle）！")).toBe(
      "中文①，测试（file）！",
    );
  });

  it("parses pdftotext -bbox-layout multi-column XHTML in reading order with bottom-up boxes", () => {
    const xhtml = `<!DOCTYPE html><html><body><doc>
      <page width="595" height="842">
        <flow>
          <block xMin="50" yMin="60" xMax="270" yMax="110">
            <line xMin="50" yMin="60" xMax="260" yMax="76">
              <word xMin="50" yMin="60" xMax="140" yMax="76">Left</word>
              <word xMin="148" yMin="60" xMax="220" yMax="76">column</word>
            </line>
            <line xMin="50" yMin="84" xMax="260" yMax="100">
              <word xMin="50" yMin="84" xMax="210" yMax="100">中⽂段落一。</word>
            </line>
          </block>
        </flow>
        <flow>
          <block xMin="310" yMin="60" xMax="540" yMax="110">
            <line xMin="310" yMin="60" xMax="520" yMax="76">
              <word xMin="310" yMin="60" xMax="400" yMax="76">Right</word>
              <word xMin="408" yMin="60" xMax="490" yMax="76">column</word>
            </line>
          </block>
        </flow>
      </page>
    </doc></body></html>`;
    const pages = parsePdftotextBboxLayout(xhtml);
    expect(pages).toHaveLength(1);
    expect(pages[0].lines.map((l) => l.text)).toEqual([
      "Left column",
      "中文段落一。",
      "Right column",
    ]);
    expect(pages[0].lines[0].y).toBeCloseTo(842 - 76, 1);
    expect(pages[0].lines[0].flowIndex).toBe(0);
    expect(pages[0].lines[2].flowIndex).toBe(1);
  });

  it("gates OCR verification by ocrTrust rather than classification and handles PDF 1.5 Y-flip CTM", async () => {
    expect(isPdfPath("/tmp/a.PDF")).toBe(true);
    expect(isPdfPath("/tmp/a.epub")).toBe(false);
    expect(isPdfBytes(Buffer.from("bad"))).toBe(false);
    expect(isPdfBytes(Buffer.from("%PDF-1.7\n"))).toBe(true);

    expect(
      pageRequiresOcrVerification({
        classification: "hybrid",
        ocrTrust: "digital-native",
      }),
    ).toBe(false);
    expect(
      pageRequiresOcrVerification({
        classification: "scanned",
        ocrTrust: "unverified-embedded",
      }),
    ).toBe(true);
    expect(
      pageRequiresOcrVerification({
        classification: "empty",
        ocrTrust: "none",
      }),
    ).toBe(false);

    const root = await makeTempDir();
    const corrupt = path.join(root, "bad.pdf");
    await fs.writeFile(corrupt, "not-pdf");
    await expect(inspectPdf(corrupt)).rejects.toMatchObject({
      code: "PDF_INVALID",
    });

    const encPdf = path.join(root, "enc.pdf");
    await fs.writeFile(
      encPdf,
      buildClassicPdf(
        new Map([
          [1, "<< /Type /Catalog /Pages 2 0 R >>"],
          [2, "<< /Type /Pages /Count 0 /Kids [] >>"],
          [3, "<< /Filter /Standard /V 2 >>"],
        ]),
        { rootObj: 1, encryptObj: 3 },
      ),
    );
    await expect(inspectPdf(encPdf)).rejects.toMatchObject({
      code: "PDF_ENCRYPTED",
    });

    // PDF 1.5 with Y-flipped CTM
    const pdf15 = path.join(root, "ctm.pdf");
    await fs.writeFile(pdf15, buildPdf15CompressedXref());
    const res15 = await extractPdfRawPages(pdf15);
    expect(res15.inspection.pdfVersion).toBe("1.5");
    const text15 = res15.pages[0].blocks
      .map((b) => ("text" in b ? b.text : ""))
      .join("\n");
    expect(text15.indexOf("Top Line Under Y Flip")).toBeLessThan(
      text15.indexOf("Second Line Below"),
    );

    // Digital+photo hybrid page keeps ocrTrust="digital-native" and extracts figure
    const hybridPdf = path.join(root, "hybrid-native.pdf");
    await fs.writeFile(hybridPdf, buildDigitalHybridPdf());
    const assetsDir = path.join(root, "assets");
    const specPath = path.join(root, "spec.json");
    const initRes = await initPdfSpec(hybridPdf, specPath, { assetsDir });
    expect(initRes.classification).toBe("hybrid");
    expect(initRes.unverifiedPages).toEqual([]);

    const spec = await readJson<PdfSpec>(specPath);
    const page3 = spec.pages.find((p) => p.page === 3)!;
    expect(page3.classification).toBe("hybrid");
    expect(page3.ocrTrust).toBe("digital-native");
    const fig = page3.blocks.find((b) => b.kind === "figure");
    expect(fig).toBeDefined();
    if (fig?.kind === "figure") {
      expect(fig.provenance?.mode).toBe("extracted");
      expect(fig.provenance?.generativeRedraw).toBe(false);
    }
    // Page 1 footnote is page-namespaced and linked to inline noteref
    const page1 = spec.pages.find((p) => p.page === 1)!;
    expect(page1.footnotes[0]?.id).toBe("p1-1");
  });

  it("extracts a real Chrome-generated 2-column CJK + photo PDF with proper reading order and NFKC", async () => {
    let executable: string;
    try {
      executable = await browserPath();
    } catch {
      return;
    }
    const root = await makeTempDir();
    const imgBuf = await sharp({
      create: {
        width: 320,
        height: 320,
        channels: 3,
        background: { r: 60, g: 110, b: 170 },
      },
    })
      .png()
      .toBuffer();
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { font-family: sans-serif; margin: 36pt; }
      .cols { display: flex; gap: 36pt; }
      .col { flex: 1; font-size: 12pt; line-height: 1.5; }
    </style></head><body>
      <h1>Chrome Sample Heading</h1>
      <div class="cols">
        <div class="col">
          <p>LEFT_ALPHA first paragraph in English with proper spaces.</p>
          <p>LEFT_BETA 中⽂康熙部首测试。</p>
        </div>
        <div class="col">
          <p>RIGHT_GAMMA second column text stays separate.</p>
          <img src="data:image/png;base64,${imgBuf.toString("base64")}" width="160" height="160" alt="photo"/>
        </div>
      </div>
    </body></html>`;
    const chromePdf = path.join(root, "chrome.pdf");
    const browser = await chromium.launch({
      executablePath: executable,
      headless: true,
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html);
      await page.pdf({ path: chromePdf, format: "A4" });
    } finally {
      await browser.close();
    }

    const assetsDir = path.join(root, "chrome-assets");
    const { inspection, pages } = await extractPdfRawPages(chromePdf, {
      assetsDir,
    });
    expect(inspection.pageCount).toBe(1);
    expect(pages[0].ocrTrust).toBe("digital-native");
    expect(pageRequiresOcrVerification(pages[0])).toBe(false);
    const fullText = pages[0].blocks
      .map((b) => ("text" in b ? b.text : ""))
      .join("\n");
    expect(fullText).toContain("LEFT_ALPHA first paragraph in English");
    expect(fullText).toContain("中文康熙部首测试");
    expect(fullText).not.toContain("⽂");
    expect(fullText.indexOf("LEFT_BETA")).toBeLessThan(
      fullText.indexOf("RIGHT_GAMMA"),
    );
    expect(pages[0].blocks.some((b) => b.kind === "figure")).toBe(true);
  });
});

describe("Visual tiling, horizontal projection, token-budget sharding, per-page Markdown and deterministic QA", () => {
  it("slices tiles with coordinates, detects lines via horizontal projection, and budgets shards by image tokens", async () => {
    const root = await makeTempDir();
    const pagePng = path.join(root, "p0001.png");
    await makeSyntheticPagePng(pagePng);

    const tileRes = await sliceRenderedPageTiles(
      1,
      pagePng,
      path.join(root, "tiles"),
    );
    expect(tileRes.widthPx).toBe(400);
    expect(tileRes.heightPx).toBe(600);
    const kinds = new Set(tileRes.tiles.map((t) => t.kind));
    expect(kinds).toEqual(
      new Set(["band", "header", "footer", "footnote-zone"]),
    );
    for (const tile of tileRes.tiles) {
      expect(tile.normalizedBox.height).toBeGreaterThan(0);
      expect(tile.normalizedBox.height).toBeLessThanOrEqual(1);
      expect(tile.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    const proj = await detectLineGeometryFromImage(pagePng, 595, 842);
    expect(proj.geometry.length).toBe(6);
    expect(proj.geometry[0].source).toBe("horizontal-projection");
    expect(proj.estimatedChars).toBeGreaterThan(10);

    expect(estimatePageImageTokens(2480, 3508, 7)).toBeGreaterThan(
      estimatePageImageTokens(2480, 3508, 0),
    );
    const tokenShards = planPdfShards(
      Array.from({ length: 10 }, (_, idx) => ({
        page: idx + 1,
        widthPt: 595,
        heightPt: 842,
        classification: "scanned" as const,
        ocrTrust: "none" as const,
      })),
      { tokenBudget: 8000, dpi: 300, tiled: true },
    );
    expect(tokenShards.length).toBeGreaterThanOrEqual(5);
    expect(tokenShards[0].estimatedImageTokens).toBeGreaterThan(0);
  });

  it("compiles per-page Markdown, validates shards with line numbers, rejects defective LLM outputs, and enforces verifier separation", async () => {
    const root = await makeTempDir();
    const scanPdf = path.join(root, "scan.pdf");
    await fs.writeFile(scanPdf, buildScannedPdf());

    const baseSpecPath = path.join(root, "base.spec.json");
    const initRes = await initPdfSpec(scanPdf, baseSpecPath, { shardSize: 2 });
    expect(initRes.unverifiedPages).toEqual([1, 2, 3]);

    // Generate editable per-page Markdown shards
    const shardsOut = path.join(root, "md-shards");
    const shardInitRes = await initPdfShards(baseSpecPath, shardsOut, {
      format: "md",
    });
    expect(shardInitRes.shards).toHaveLength(2);

    // Test compilePdfPageMarkdown with ruby, footnotes, explicit ::no-stitch-next, voice, unresolved
    const rawBase = await readJson<PdfSpec>(baseSpecPath);
    const p1Png = path.join(root, "p0001.png");
    const p2Png = path.join(root, "p0002.png");
    const p3Png = path.join(root, "p0003.png");
    const [p1Sha, p2Sha, p3Sha] = await Promise.all([
      makeSyntheticPagePng(p1Png),
      makeSyntheticPagePng(p2Png),
      makeSyntheticPagePng(p3Png),
    ]);
    const p1Tiles = await sliceRenderedPageTiles(
      1,
      p1Png,
      path.join(root, "tiles"),
    );

    const p1Md = `---
page: 1
sourceSha256: "${rawBase.source.sha256}"
transcribedBy: "worker-01"
renderPath: "${p1Png}"
renderSha256: "${p1Sha}"
dpi: 300
tilesReviewed:
  - "${p1Tiles.tiles[0].id}"
unresolved: []
---

# 第一章

凡治 :ruby[金石]{reading="jīn shí"} 学者，必先审定拓本[^1]

::no-stitch-next

[^1]: 宋拓本墨色醇厚。
`;
    const p2Md = `---
page: 2
sourceSha256: "${rawBase.source.sha256}"
transcribedBy: "worker-01"
renderPath: "${p2Png}"
renderSha256: "${p2Sha}"
dpi: 300
tilesReviewed: []
unresolved: []
---

:::voice{kind="verse"}
断碑残字入苍苔
:::

::no-stitch-next
`;
    const p3Md = `---
page: 3
sourceSha256: "${rawBase.source.sha256}"
transcribedBy: "worker-02"
renderPath: "${p3Png}"
renderSha256: "${p3Sha}"
dpi: 300
tilesReviewed: []
unresolved: []
---

第三页正文[^1]

[^1]: 第三页独立脚注，与第一页同名标号不冲突。
`;
    const editedDir = path.join(root, "edited-pages");
    await fs.mkdir(editedDir, { recursive: true });
    await fs.writeFile(path.join(editedDir, "p0001.md"), p1Md);
    await fs.writeFile(path.join(editedDir, "p0002.md"), p2Md);
    await fs.writeFile(path.join(editedDir, "p0003.md"), p3Md);

    const validRes = await validatePdfShard(editedDir);
    expect(validRes.status).toBe("pass");
    expect(validRes.pageCount).toBe(3);

    const mergedPath = path.join(root, "merged.spec.json");
    const mergeRes = await mergePdfShards(baseSpecPath, editedDir, mergedPath);
    expect(mergeRes.status).toBe("pass");
    const mergedSpec = await readJson<PdfSpec>(mergedPath);

    // Explicit ::no-stitch-next is NEVER overwritten by heuristic!
    expect(mergedSpec.pages[0].blocks[1]).toMatchObject({
      kind: "paragraph",
      stitchWithNextPage: false,
    });
    expect(mergedSpec.pages[1].blocks[0]).toMatchObject({
      kind: "paragraph",
      voice: "verse",
      stitchWithNextPage: false,
    });
    // Footnotes auto-namespaced as p1-1 and p3-1 without collision
    expect(mergedSpec.pages[0].footnotes[0].id).toBe("p1-1");
    expect(mergedSpec.pages[2].footnotes[0].id).toBe("p3-1");
    // Base deterministic geometry and rawOcrDraft preserved
    expect(mergedSpec.pages[0].geometry?.length).toBeGreaterThan(0);
    expect(mergedSpec.pages[0].rawOcrDraft).toContain("Helo wrold te");

    // Check deterministic QA signals & independent verifier contract
    const manifest: PdfRenderManifest = {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-render-manifest",
      sourcePath: scanPdf,
      sourceSha256: rawBase.source.sha256,
      dpi: 300,
      tiled: true,
      pages: [
        {
          page: 1,
          path: p1Png,
          sha256: p1Sha,
          dpi: 300,
          widthPx: 400,
          heightPx: 600,
          estimatedImageTokens: 500,
          tiles: p1Tiles.tiles,
        },
        {
          page: 2,
          path: p2Png,
          sha256: p2Sha,
          dpi: 300,
          widthPx: 400,
          heightPx: 600,
          estimatedImageTokens: 500,
        },
        {
          page: 3,
          path: p3Png,
          sha256: p3Sha,
          dpi: 300,
          widthPx: 400,
          heightPx: 600,
          estimatedImageTokens: 500,
        },
      ],
    };

    const selfApproveVer: PdfVerificationFile = {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-verification",
      sourceSha256: rawBase.source.sha256,
      verifierId: "worker-01",
      verifiedAt: "2026-11-21T00:00:00Z",
      pages: mergedSpec.pages.map((p) => ({
        page: p.page,
        renderSha256: p.render!.sha256,
        dpi: 300,
        tilesReviewed: p.page === 1 ? [p1Tiles.tiles[0].id] : [],
        transcribedBy: p.transcription!.transcribedBy,
        verifiedBy: p.transcription!.transcribedBy,
        contentSha256: computePageContentSha256(p),
        status: "verified",
        unresolved: [],
      })),
    };
    expect(() =>
      assertPdfSpecVerified(mergedSpec, {
        verification: selfApproveVer,
        renderManifest: manifest,
      }),
    ).toThrow(/verifiedBy/);
    const selfCheck = verifyPdfSpecPages(mergedSpec, {
      verification: selfApproveVer,
      renderManifest: manifest,
    });
    expect(
      selfCheck.some((d) => d.code === "PDF_SELF_APPROVAL_FORBIDDEN"),
    ).toBe(true);

    const goodVer: PdfVerificationFile = {
      ...selfApproveVer,
      verifierId: "verifier-alpha",
      pages: selfApproveVer.pages.map((p) => ({
        ...p,
        verifiedBy: "verifier-alpha",
      })),
    };
    const checkReport = await checkPdfSpec(mergedSpec, {
      renderManifest: manifest,
      verification: goodVer,
    });
    expect(checkReport.status).toBe("pass");
    expect(checkReport.pages[0].projectionLineCount).toBe(6);
    expect(checkReport.pages[0].rawOcrEditDistanceRatio).toBeGreaterThan(0.5);

    // Tampering with page text after verification triggers PDF_VERIFICATION_STALE
    const tampered = structuredClone(mergedSpec);
    if (tampered.pages[0].blocks[0].kind === "heading") {
      tampered.pages[0].blocks[0].text = "被篡改的标题";
    }
    const staleIssues = verifyPdfSpecPages(tampered, {
      verification: goodVer,
      renderManifest: manifest,
    });
    expect(staleIssues.some((d) => d.code === "PDF_VERIFICATION_STALE")).toBe(
      true,
    );

    // Defective LLM outputs: fn-1 collision, unreferenced footnote, broken table grid, unresolved item
    const badTableIssues = validateTableGrid(
      {
        kind: "table",
        caption: "坏表",
        head: [[{ text: "A", colspan: 2 }, { text: "B" }]],
        body: [[{ text: "1" }, { text: "2" }]],
      },
      { page: 1 },
    );
    expect(badTableIssues[0]?.code).toBe("PDF_TABLE_GRID_INVALID");

    const collisionDir = path.join(root, "collision-shards");
    await fs.mkdir(collisionDir, { recursive: true });
    const makeCollisionPage = (pageNum: number): PdfPageFile => ({
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-page",
      sourceSha256: rawBase.source.sha256,
      page: {
        ...rawBase.pages[pageNum - 1],
        blocks: [
          {
            kind: "paragraph",
            text: "正文",
            inlines: [
              { kind: "text", text: "正文" },
              { kind: "noteref", id: "fn-1", label: "1" },
            ],
          },
        ],
        footnotes: [{ id: "fn-1", label: "1", text: `第${pageNum}页注` }],
      },
    });
    await json(path.join(collisionDir, "p1.json"), makeCollisionPage(1));
    await json(path.join(collisionDir, "p2.json"), makeCollisionPage(2));
    await json(path.join(collisionDir, "p3.json"), {
      ...makeCollisionPage(3),
      page: {
        ...rawBase.pages[2],
        blocks: [{ kind: "paragraph", text: "无注页。" }],
        footnotes: [],
      },
    });
    const colVal = await validatePdfShard(collisionDir);
    expect(colVal.status).toBe("fail");
    expect(
      colVal.diagnostics.some((d) => d.code === "FOOTNOTE_ID_COLLISION"),
    ).toBe(true);
    await expect(
      mergePdfShards(
        baseSpecPath,
        collisionDir,
        path.join(root, "col-merged.json"),
      ),
    ).rejects.toMatchObject({ code: "FOOTNOTE_ID_COLLISION" });

    // Line-numbered JSON schema & Markdown directive error reporting
    const badJsonPath = path.join(root, "bad-shard.json");
    await fs.writeFile(
      badJsonPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "quillbind-pdf-shard",
          sourceSha256: "not-a-sha",
          shard: { id: "shard-01", pageStart: 1, pageEnd: 1 },
          pages: [],
        } satisfies Partial<PdfShardFile>,
        null,
        2,
      ),
    );
    const badJsonVal = await validatePdfShard(badJsonPath);
    expect(badJsonVal.status).toBe("fail");
    expect(badJsonVal.diagnostics[0]?.line).toBeGreaterThan(1);

    const unresolvedMd = compilePdfPageMarkdown(
      `---\npage: 1\ntranscribedBy: "w1"\n---\n\n正文 :unresolved[墨迹模糊]{location="line 1"}。\n`,
      "u.md",
    );
    expect(unresolvedMd.transcription?.unresolved).toHaveLength(1);

    // Charset anomaly check: Simplified+Traditional mix & halfwidth punctuation in CJK
    const anomalySpec = structuredClone(mergedSpec);
    anomalySpec.pages[1].blocks = [
      {
        kind: "paragraph",
        text: "这国为说时,會發後裡書,测试。",
      },
    ];
    const anomalyReport = await checkPdfSpec(anomalySpec);
    expect(
      anomalyReport.pages[1].charsetAnomalies.length,
    ).toBeGreaterThanOrEqual(2);

    // stitchPdfPagesInPlace never overwrites explicit false
    const pagesToStitch = structuredClone(mergedSpec.pages);
    pagesToStitch[0].blocks = [
      {
        kind: "paragraph",
        text: "没有句号的诗歌行",
        stitchWithNextPage: false,
      },
    ];
    pagesToStitch[1].blocks = [{ kind: "paragraph", text: "下一段" }];
    stitchPdfPagesInPlace(pagesToStitch);
    expect(
      pagesToStitch[0].blocks[0].kind === "paragraph" &&
        pagesToStitch[0].blocks[0].stitchWithNextPage,
    ).toBe(false);
    expect(
      pagesToStitch[1].blocks[0].kind === "paragraph" &&
        pagesToStitch[1].blocks[0].continueFromPrevPage,
    ).toBeUndefined();
  });

  it("exposes pdf inspect, init-spec, shard-init, validate-shard, check-spec and merge-shards through the CLI", async () => {
    const root = await makeTempDir();
    const cli = path.join(repoRoot, "packages/cli/src/index.ts");
    const invoke = (args: string[]) =>
      run(process.execPath, ["--import", "tsx", cli, ...args], {
        cwd: repoRoot,
      });

    const pdfPath = path.join(root, "book.pdf");
    await fs.writeFile(pdfPath, buildDigitalHybridPdf());

    const inspectHuman = await invoke(["pdf", "inspect", pdfPath]);
    expect(inspectHuman.exitCode).toBe(0);
    expect(inspectHuman.stderr).toContain("PDF classification: hybrid");

    const specOut = path.join(root, "book.spec.json");
    const initJson = await invoke([
      "pdf",
      "init-spec",
      pdfPath,
      "--output",
      specOut,
      "--token-budget",
      "8000",
      "--json",
    ]);
    expect(initJson.exitCode, initJson.stderr).toBe(0);
    expect(JSON.parse(initJson.stdout).unverifiedPages).toEqual([]);

    const checkJson = await invoke(["pdf", "check-spec", specOut, "--json"]);
    expect(checkJson.exitCode, checkJson.stderr).toBe(0);
    expect(JSON.parse(checkJson.stdout).status).toBe("pass");

    const shardsDir = path.join(root, "shards");
    const shardInit = await invoke([
      "pdf",
      "shard-init",
      specOut,
      "--output",
      shardsDir,
      "--format",
      "md",
      "--json",
    ]);
    expect(shardInit.exitCode, shardInit.stderr).toBe(0);

    const valShard = await invoke([
      "pdf",
      "validate-shard",
      shardsDir,
      "--json",
    ]);
    expect(valShard.exitCode, valShard.stderr).toBe(0);
    expect(JSON.parse(valShard.stdout).status).toBe("pass");

    // If pdftoppm is on PATH, verify real --render-dir --tiles end-to-end via CLI
    const hasPdftoppm = await run("pdftoppm", ["-v"], { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (hasPdftoppm) {
      const renderDir = path.join(root, "renders");
      const tiledInspect = await invoke([
        "pdf",
        "inspect",
        pdfPath,
        "--pages",
        "1",
        "--render-dir",
        renderDir,
        "--dpi",
        "150",
        "--tiles",
        "--json",
      ]);
      expect(tiledInspect.exitCode, tiledInspect.stderr).toBe(0);
      const payload = JSON.parse(tiledInspect.stdout) as {
        renderManifestPath: string;
        renderedPages: { tiles: unknown[] }[];
      };
      expect(payload.renderManifestPath).toContain("render-manifest.json");
      expect(payload.renderedPages[0].tiles.length).toBeGreaterThanOrEqual(6);
    }

    // Argument conflicts
    const badCmd = await invoke(["pdf", "unknown", pdfPath, "--json"]);
    expect(badCmd.exitCode).toBe(1);
    const badBudget = await invoke([
      "pdf",
      "inspect",
      pdfPath,
      "--token-budget",
      "0",
      "--json",
    ]);
    expect(badBudget.exitCode).toBe(1);
  });

  it("exercises full per-page Markdown directives, JSON shards, and verification/merge error guards", async () => {
    const root = await makeTempDir();
    const scanPdf = path.join(root, "scan-rich.pdf");
    await fs.writeFile(scanPdf, buildScannedPdf());
    const baseSpecPath = path.join(root, "base.spec.json");
    await initPdfSpec(scanPdf, baseSpecPath, { shardSize: 2 });
    const rawBase = await readJson<PdfSpec>(baseSpecPath);

    // JSON shard init + validation + merge guards
    const jsonShardsDir = path.join(root, "json-shards");
    const jsonInit = await initPdfShards(baseSpecPath, jsonShardsDir, {
      format: "json",
    });
    expect(jsonInit.format).toBe("json");
    const jsonVal = await validatePdfShard(jsonShardsDir);
    expect(jsonVal.status).toBe("pass");

    // Rich Markdown directives compilation
    const richMd = `---
page: 2
sourceSha256: "${rawBase.source.sha256}"
transcribedBy: "worker-rich"
sectionId: "sec-2"
unresolved:
  - "blurred margin note"
---

# 第一章

::subtitle[副标题]

::byline[作者名]

::continue-prev

含 **粗体**、*斜体*、\`代码\`、:sup[上标]、:sub[下标]、$a^2+b^2=c^2$ 与注释[^1]。

::stitch-next

> 引用段落。

$$
\\int_0^1 x\\,dx = \\frac{1}{2}
$$

::caption[简单表]

| 列一 | 列二 |
| :--- | ---: |
| 甲 | 10 |

\`\`\`json table
{
  "kind": "table",
  "caption": "复杂表",
  "head": [[{"text":"项目","header":true,"scope":"col","colspan":2}]],
  "body": [[{"text":"A"},{"text":"B"}]]
}
\`\`\`

::figure[图注]{src="fig.png" alt="示意图"}

1. 条目一
2. 条目二

---

[^1]: 本页脚注。

::footnote-continue[上页续接脚注。]{id="p1-1" label="①"}
`;
    const compiled = compilePdfPageMarkdown(richMd, "rich.md");
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual(
      [],
    );
    expect(compiled.blocks.some((b) => b.kind === "math-block")).toBe(true);
    expect(compiled.blocks.some((b) => b.kind === "figure")).toBe(true);
    expect(compiled.blocks.some((b) => b.kind === "list")).toBe(true);
    expect(compiled.blocks.some((b) => b.kind === "hr")).toBe(true);
    expect(compiled.footnotes).toHaveLength(2);

    // Invalid Markdown syntax/directive cases produce line-numbered errors
    expect(
      compilePdfPageMarkdown("no frontmatter", "a.md").diagnostics[0]?.code,
    ).toBe("PDF_MD_FRONTMATTER");
    expect(
      compilePdfPageMarkdown("---\npage: 0\n---\nhello", "b.md").diagnostics[0]
        ?.code,
    ).toBe("PDF_MD_PAGE");
    const badDirectives = compilePdfPageMarkdown(
      `---\npage: 1\n---\n\n::subtitle[orphan]\n\n::stitch-next\n\n:::voice{kind="invalid"}\nx\n:::\n\n::figure[x]{}\n\n::footnote-continue[x]{}\n\n:ruby[缺少读音]{}\n\n\`\`\`json\n{bad json\n\`\`\`\n`,
      "bad.md",
    );
    expect(badDirectives.diagnostics.length).toBeGreaterThanOrEqual(6);

    // Verification edge cases: missing record, render hash mismatch, missing tiles, unresolved
    const missingIssues = verifyPdfSpecPages(rawBase);
    expect(
      missingIssues.some((d) => d.code === "PDF_OCR_VERIFICATION_REQUIRED"),
    ).toBe(true);

    const p1Png = path.join(root, "p1.png");
    const p1Sha = await makeSyntheticPagePng(p1Png);
    const p1Tiles = await sliceRenderedPageTiles(
      1,
      p1Png,
      path.join(root, "t"),
    );
    const badVer: PdfVerificationFile = {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-verification",
      sourceSha256: rawBase.source.sha256,
      verifierId: "verifier-1",
      verifiedAt: "2026-11-21T00:00:00Z",
      pages: [
        {
          page: 1,
          renderSha256: "f".repeat(64),
          dpi: 300,
          tilesReviewed: [],
          transcribedBy: "worker-1",
          verifiedBy: "verifier-1",
          contentSha256: computePageContentSha256(rawBase.pages[0]),
          status: "verified",
          unresolved: [{ reason: "blur" }],
        },
      ],
    };
    const manifest: PdfRenderManifest = {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-render-manifest",
      sourcePath: scanPdf,
      sourceSha256: rawBase.source.sha256,
      dpi: 300,
      tiled: true,
      pages: [
        {
          page: 1,
          path: p1Png,
          sha256: p1Sha,
          dpi: 300,
          widthPx: 400,
          heightPx: 600,
          estimatedImageTokens: 400,
          tiles: p1Tiles.tiles,
        },
      ],
    };
    const verIssues = verifyPdfSpecPages(rawBase, {
      verification: badVer,
      renderManifest: manifest,
    });
    const codes = new Set(verIssues.map((i) => i.code));
    expect(codes.has("PDF_RENDER_HASH_MISMATCH")).toBe(true);
    expect(codes.has("PDF_TILES_NOT_REVIEWED")).toBe(true);
    expect(codes.has("PDF_UNRESOLVED_ITEMS")).toBe(true);

    // Invalid JSON syntax line number
    const syntaxBad = path.join(root, "syntax-bad.json");
    await fs.writeFile(syntaxBad, '{\n  "kind": \n}');
    const synRes = await validatePdfShard(syntaxBad);
    expect(synRes.status).toBe("fail");
    expect(synRes.diagnostics[0]?.code).toBe("PDF_SHARD_JSON_SYNTAX");
  });
});

async function makeStructuredFigurePng(filePath: string): Promise<void> {
  const w = 160;
  const h = 120;
  const raw = Buffer.alloc(w * h * 3, 242);
  for (let y = 16; y < 104; y++) {
    for (let x = 20; x < 140; x++) {
      const i = (y * w + x) * 3;
      const border = y < 22 || y > 98 || x < 26 || x > 134;
      const stripe = (x + y) % 16 < 5;
      raw[i] = border ? 30 : stripe ? 70 : 210;
      raw[i + 1] = border ? 45 : stripe ? 110 : 225;
      raw[i + 2] = border ? 90 : stripe ? 175 : 240;
    }
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(filePath);
}

describe("PDF-to-EPUB 3.3 builder, non-destructive image restoration and P0-3/P0-4/P1-B2 regressions", () => {
  it("restores figures deterministically with rule-aligned ops, comparison PNG, and fidelity guards", async () => {
    const root = await makeTempDir();
    const srcImg = path.join(root, "fig.png");
    await makeStructuredFigurePng(srcImg);

    const outImg = path.join(root, "fig-restored.png");
    const repDir = path.join(root, "enhance-reports");
    const report = await enhancePdfImage(srcImg, outImg, {
      deskew: -1.2,
      denoise: true,
      normalize: true,
      upscale: 2,
      sharpen: true,
      reports: repDir,
    });

    expect(report.mode).toBe("non-destructive-restoration");
    expect(report.generativeRedraw).toBe(false);
    expect(report.multiScaleSsim).toBeGreaterThan(0.65);
    expect(report.edgeCorrelation).toBeGreaterThan(0.5);
    expect(report.output.width).toBeGreaterThanOrEqual(320);

    // Every emitted operation prefix matches pdf.md "Image restoration policy"
    const pdfRules = await readPdfRules(
      path.resolve(repoRoot, "../../skills/quillbind/references"),
    );
    expect(report.operations.length).toBe(5);
    for (const op of report.operations) {
      const key = op.split(":")[0];
      expect(pdfRules.imageOperations[key]?.allowed).toBe(true);
    }

    // Comparison 3-panel PNG and enhance JSON report exist on disk
    const compareBytes = await fs.readFile(report.comparisonImage);
    expect(sha256(compareBytes)).toBe(report.comparisonImageSha256);
    const compareMeta = await sharp(compareBytes).metadata();
    expect(compareMeta.width).toBeGreaterThan(compareMeta.height ?? 0);
    const savedJson = await readJson<typeof report>(
      path.join(repDir, "fig-restored.png.enhance.json"),
    );
    expect(savedJson.output.sha256).toBe(report.output.sha256);

    // JPEG & WebP output paths work without overwriting
    const outJpg = path.join(root, "fig.jpg");
    const jpgReport = await enhancePdfImage(srcImg, outJpg, { sharpen: true });
    expect(jpgReport.output.format).toBe("jpeg");
    const outWebp = path.join(root, "fig.webp");
    const webpReport = await enhancePdfImage(srcImg, outWebp);
    expect(webpReport.output.format).toBe("webp");

    // Existing output & out-of-range deskew rejected
    await expect(enhancePdfImage(srcImg, outImg)).rejects.toMatchObject({
      code: "OUTPUT_EXISTS",
    });
    await expect(
      enhancePdfImage(srcImg, path.join(root, "bad-deskew.png"), {
        deskew: 25,
      }),
    ).rejects.toMatchObject({ code: "ARGUMENT_CONFLICT" });

    // Altered/inverted image rejected by SSIM/edge guard
    const inverted = path.join(root, "inverted.png");
    await sharp(srcImg).negate().png().toFile(inverted);
    await expect(
      enhancePdfImage(inverted, path.join(root, "bad-inv.png"), {
        verifyAgainst: srcImg,
      }),
    ).rejects.toMatchObject({ code: "IMAGE_FIDELITY_VIOLATION" });

    // Aspect-ratio altered image rejected by geometry guard
    const squashed = path.join(root, "squashed.png");
    await sharp(srcImg).resize(260, 80, { fit: "fill" }).png().toFile(squashed);
    await expect(
      enhancePdfImage(squashed, path.join(root, "bad-aspect.png"), {
        verifyAgainst: srcImg,
      }),
    ).rejects.toMatchObject({ code: "IMAGE_FIDELITY_VIOLATION" });
  });

  it("retains orphan continuations with warnings, rejects unreferenced/missing footnotes, and prevents footnote continuation duplication", async () => {
    const root = await makeTempDir();
    const figPath = path.join(root, "illu.png");
    await makeStructuredFigurePng(figPath);

    const makeBaseSpec = (pages: PdfSpec["pages"]): PdfSpec => ({
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-spec",
      source: {
        path: path.join(root, "doc.pdf"),
        sha256: "a".repeat(64),
        pdfVersion: "1.6",
        pageCount: pages.length,
        classification: "digital",
      },
      metadata: {
        title: "续接与脚注测试",
        authors: ["作者甲"],
        language: "zh-Hans",
        description: "测试跨页续接与脚注规则。",
        tags: [],
        modified: "2000-01-01T00:00:00Z",
      },
      frontmatter: {
        includeTitlepage: true,
        includeColophon: false,
      },
      outline: [],
      shards: [],
      pages,
    });

    // P0-3: orphan continueFromPrevPage paragraph (chapter start & after figure), orphan table, orphan footnote
    // P0-4: cross-page footnote continuation with inlines joins cleanly without duplicating text
    const orphanSpec = makeBaseSpec([
      {
        page: 1,
        widthPt: 595,
        heightPt: 842,
        rotate: 0,
        classification: "digital",
        ocrTrust: "digital-native",
        blocks: [
          { kind: "heading", level: 1, text: "第一章 边界测试" },
          {
            kind: "paragraph",
            text: "章首误标续接的段落必须保留，不能静默丢弃。",
            continueFromPrevPage: true,
          },
          {
            kind: "figure",
            src: figPath,
            alt: "插图",
          },
          {
            kind: "paragraph",
            text: "插图之后误标续接的段落也必须保留。",
            continueFromPrevPage: true,
            inlines: [
              { kind: "text", text: "插图之后误标续接的段落也必须保留" },
              { kind: "noteref", id: "p1-1", label: "1" },
              { kind: "text", text: "。" },
              { kind: "noteref", id: "p1-2", label: "2" },
            ],
          },
          {
            kind: "table",
            caption: "孤立续表",
            continueFromPrevPage: true,
            head: [
              [
                { text: "项", header: true },
                { text: "值", header: true },
              ],
            ],
            body: [[{ text: "甲" }, { text: "1" }]],
          },
        ],
        footnotes: [
          {
            id: "p1-1",
            label: "1",
            text: "孤立续注首句",
            continueFromPrevPage: true,
          },
          {
            id: "p1-2",
            label: "2",
            text: "跨页注前半段",
            inlines: [
              { kind: "text", text: "跨页注" },
              { kind: "text", text: "前半段", bold: true },
            ],
          },
        ],
      },
      {
        page: 2,
        widthPt: 595,
        heightPt: 842,
        rotate: 0,
        classification: "digital",
        ocrTrust: "digital-native",
        blocks: [{ kind: "paragraph", text: "第二页正文。" }],
        footnotes: [
          {
            id: "p1-2",
            label: "2",
            text: "跨页注后半段。",
            continueFromPrevPage: true,
            inlines: [{ kind: "text", text: "跨页注后半段。", italic: true }],
          },
        ],
      },
    ]);

    const rendered = await renderPdfSpecToEpub(orphanSpec, root);
    expect(validateInternal(rendered.bytes).status).toBe("pass");
    const warnCodes = rendered.warnings.map((w) => w.code);
    expect(warnCodes).toContain("STITCH_ORPHAN_PARAGRAPH");
    expect(warnCodes).toContain("STITCH_ORPHAN_TABLE");
    expect(warnCodes).toContain("STITCH_ORPHAN_FOOTNOTE");

    const inspected = inspectBytes(rendered.bytes, true);
    const ch1 = inspected.entries
      .get("EPUB/text/ch-001.xhtml")!
      .bytes.toString();
    expect(ch1).toContain("章首误标续接的段落必须保留，不能静默丢弃。");
    expect(ch1).toContain("插图之后误标续接的段落也必须保留");
    expect(ch1).toContain("孤立续表");
    expect(ch1).toContain("孤立续注首句");
    // P0-4: footnote continuation inlines must NOT duplicate "跨页注前半段"
    expect(ch1.split("跨页注后半段。").length - 1).toBe(1);
    expect(ch1.split("前半段").length - 1).toBe(1);
    expect(ch1).toContain("<strong>前半段</strong><em>跨页注后半段。</em>");

    // P0-3: unreferenced footnote MUST fail with FOOTNOTE_UNREFERENCED (no fabricated <sup>)
    const unrefSpec = makeBaseSpec([
      {
        page: 1,
        widthPt: 595,
        heightPt: 842,
        rotate: 0,
        classification: "digital",
        ocrTrust: "digital-native",
        blocks: [{ kind: "paragraph", text: "正文漏掉了脚注编号。" }],
        footnotes: [{ id: "p1-1", label: "1", text: "孤立脚注文本。" }],
      },
    ]);
    await expect(renderPdfSpecToEpub(unrefSpec, root)).rejects.toMatchObject({
      code: "FOOTNOTE_UNREFERENCED",
    });

    // P0-3: missing footnote target MUST fail with FOOTNOTE_MISSING
    const missingFnSpec = makeBaseSpec([
      {
        page: 1,
        widthPt: 595,
        heightPt: 842,
        rotate: 0,
        classification: "digital",
        ocrTrust: "digital-native",
        blocks: [
          {
            kind: "paragraph",
            text: "引用不存在脚注",
            inlines: [
              { kind: "text", text: "引用不存在脚注" },
              { kind: "noteref", id: "p1-9", label: "9" },
            ],
          },
        ],
        footnotes: [],
      },
    ]);
    await expect(
      renderPdfSpecToEpub(missingFnSpec, root),
    ).rejects.toMatchObject({
      code: "FOOTNOTE_MISSING",
    });
  });

  it("builds a verified canonical reflowable EPUB 3.3 from a scanned PDF spec with rich features and enforces independent verifier", async () => {
    const root = await makeTempDir();
    const scanPdf = path.join(root, "scan-rich.pdf");
    await fs.writeFile(scanPdf, buildScannedPdf());
    const baseSpecPath = path.join(root, "base.spec.json");
    await initPdfSpec(scanPdf, baseSpecPath);
    const spec = await readJson<PdfSpec>(baseSpecPath);

    const coverImg = path.join(root, "cover.png");
    const figImg = path.join(root, "figure.png");
    const p1Png = path.join(root, "p1.png");
    const p2Png = path.join(root, "p2.png");
    const p3Png = path.join(root, "p3.png");
    await Promise.all([
      makeStructuredFigurePng(coverImg),
      makeStructuredFigurePng(figImg),
      makeSyntheticPagePng(p1Png),
      makeSyntheticPagePng(p2Png),
      makeSyntheticPagePng(p3Png),
    ]);
    const [p1Sha, p2Sha, p3Sha] = await Promise.all([
      fs.readFile(p1Png).then(sha256),
      fs.readFile(p2Png).then(sha256),
      fs.readFile(p3Png).then(sha256),
    ]);

    spec.metadata = {
      title: "金石与数理札记",
      authors: ["林清玄"],
      translators: ["王译者"],
      publisher: "学术出版社",
      isbn: "9780306406157",
      language: "zh-Hans",
      description: "包含数学公式、复杂表格、注音与双向脚注的扫描书重建。",
      tags: ["Literature.Essays"],
      modified: "2026-11-21T00:00:00Z",
    };
    spec.frontmatter = {
      coverImage: coverImg,
      coverAlt: "金石与数理札记封面",
      titlepage: {
        title: "金石与数理札记",
        subtitle: "校订本",
        authors: ["林清玄"],
        translators: ["王译者"],
        publisher: "学术出版社",
        imprint: "典藏系列",
        extraLines: ["第一版"],
      },
      colophon: {
        copyright: "© 2026 学术出版社",
        publisher: "学术出版社",
        edition: "2026年11月第1版",
        isbn: "978-0-306-40615-7",
        lines: ["版权所有，翻印必究。"],
      },
      includeTitlepage: true,
      includeColophon: true,
    };

    spec.pages[0] = {
      ...spec.pages[0],
      render: { path: p1Png, sha256: p1Sha, dpi: 300 },
      transcription: { transcribedBy: "worker-01", unresolved: [] },
      blocks: [
        {
          kind: "heading",
          level: 1,
          text: "第一章 绪论",
          subtitle: "山川与数理",
          byline: "林清玄",
        },
        {
          kind: "paragraph",
          text: "凡治金石学者，必察方程。",
          voice: "epigraph",
        },
        {
          kind: "math-block",
          tex: "\\int_0^1 x\\,dx = \\frac{1}{2}",
          alt: "integral of x from 0 to 1 equals 1/2",
        },
        {
          kind: "math-block",
          mathml:
            "<math><msup><mi>e</mi><mrow><mi>i</mi><mi>π</mi></mrow></msup><mo>+</mo><mn>1</mn><mo>=</mo><mn>0</mn></math>",
          alt: "Euler identity",
        },
        {
          kind: "paragraph",
          text: "正文含注音、行内公式与脚注，且跨页延续",
          stitchWithNextPage: true,
          inlines: [
            { kind: "text", text: "正文含" },
            { kind: "ruby", base: "金石", rt: "jīn shí" },
            { kind: "text", text: "、" },
            { kind: "math-inline", tex: "a^2 + b^2 = c^2", alt: "a^2+b^2=c^2" },
            { kind: "text", text: "与脚注" },
            { kind: "noteref", id: "p1-1", label: "①" },
            { kind: "text", text: "，且跨页延续" },
          ],
        },
      ],
      footnotes: [
        {
          id: "p1-1",
          label: "①",
          text: "金石指钟鼎碑刻。",
        },
      ],
    };

    spec.pages[1] = {
      ...spec.pages[1],
      render: { path: p2Png, sha256: p2Sha, dpi: 300 },
      transcription: { transcribedBy: "worker-01", unresolved: [] },
      blocks: [
        {
          kind: "paragraph",
          text: "至此完整结束。",
          continueFromPrevPage: true,
        },
        {
          kind: "heading",
          level: 2,
          text: "第一节 表格与体裁",
        },
        {
          kind: "table",
          caption: "跨行列数据表",
          head: [
            [
              { text: "类别", header: true, scope: "col", rowspan: 2 },
              { text: "观测指标", header: true, scope: "col", colspan: 2 },
            ],
            [
              { text: "春", header: true, scope: "col", align: "right" },
              { text: "秋", header: true, scope: "col", align: "right" },
            ],
          ],
          body: [
            [
              { text: "山谷", header: true, scope: "row" },
              { text: "12.5", align: "right" },
              { text: "18.0", align: "right" },
            ],
          ],
          foot: [
            [
              { text: "合计", colspan: 2 },
              { text: "30.5", align: "right" },
            ],
          ],
        },
        { kind: "paragraph", text: "引文一段。", voice: "quote" },
        {
          kind: "paragraph",
          text: "孤云独去闲",
          voice: "verse",
          gapBefore: true,
        },
        { kind: "paragraph", text: "“此地甚佳。”", voice: "dialogue" },
        { kind: "paragraph", text: "——癸卯秋记", voice: "signature" },
        {
          kind: "list",
          ordered: true,
          items: [
            "条款一",
            {
              text: "条款二",
              inlines: [
                { kind: "text", text: "条款", bold: true },
                { kind: "text", text: "二", code: true },
              ],
            },
          ],
        },
        { kind: "hr" },
      ],
      footnotes: [],
    };

    spec.pages[2] = {
      ...spec.pages[2],
      render: { path: p3Png, sha256: p3Sha, dpi: 300 },
      transcription: { transcribedBy: "worker-02", unresolved: [] },
      blocks: [
        { kind: "heading", level: 1, text: "第二章 插图" },
        {
          kind: "figure",
          src: figImg,
          alt: "山谷示意图",
          caption: "图 2-1 山谷示意图",
          provenance: {
            sourceSha256: p3Sha,
            outputSha256: sha256(await fs.readFile(figImg)),
            mode: "non-destructive-restoration",
            generativeRedraw: false,
          },
        },
      ],
      footnotes: [],
    };

    const specFile = path.join(root, "rich.spec.json");
    await json(specFile, spec);

    // Without verification file: blocked
    await expect(
      buildEpubFromPdfSpec(specFile, path.join(root, "no-ver.epub")),
    ).rejects.toMatchObject({ code: "PDF_OCR_VERIFICATION_REQUIRED" });

    // Self-approved verification file: blocked
    const selfVerPath = path.join(root, "self-ver.json");
    await json(selfVerPath, {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-verification",
      sourceSha256: spec.source.sha256,
      verifierId: "worker-01",
      verifiedAt: "2026-11-21T00:00:00Z",
      pages: spec.pages.map((p) => ({
        page: p.page,
        renderSha256: p.render!.sha256,
        dpi: 300,
        tilesReviewed: [],
        transcribedBy: p.transcription!.transcribedBy,
        verifiedBy: p.transcription!.transcribedBy,
        contentSha256: computePageContentSha256(p),
        status: "verified",
        unresolved: [],
      })),
    } satisfies PdfVerificationFile);
    await expect(
      buildEpubFromPdfSpec(specFile, path.join(root, "self-ver.epub"), {
        verification: selfVerPath,
      }),
    ).rejects.toMatchObject({ code: "PDF_SELF_APPROVAL_FORBIDDEN" });

    // Independent verifier file: succeeds and passes EPUBCheck + checkNotes
    const verPath = path.join(root, "verifier.json");
    await json(verPath, {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-verification",
      sourceSha256: spec.source.sha256,
      verifierId: "verifier-01",
      verifiedAt: "2026-11-21T00:00:00Z",
      pages: spec.pages.map((p) => ({
        page: p.page,
        renderSha256: p.render!.sha256,
        dpi: 300,
        tilesReviewed: [],
        transcribedBy: p.transcription!.transcribedBy,
        verifiedBy: "verifier-01",
        contentSha256: computePageContentSha256(p),
        status: "verified",
        unresolved: [],
      })),
    } satisfies PdfVerificationFile);

    const outEpub = path.join(root, "rich.epub");
    const reportsDir = path.join(root, "rich-reports");
    const result = await buildEpubFromPdfSpec(specFile, outEpub, {
      verification: verPath,
      reports: reportsDir,
    });

    expect(result.status).toBe("pass");
    expect(result.reproducible).toBe(true);
    expect(result.frontmatterSpine).toEqual([
      "EPUB/cover.xhtml",
      "EPUB/titlepage.xhtml",
      "EPUB/colophon.xhtml",
      "EPUB/toc.xhtml",
    ]);
    expect(result.colophonExcludedFromToc).toBe(true);
    expect(result.tocHrefs.some((h) => h.includes("colophon"))).toBe(false);
    expect(result.validation.status).toBe("pass");
    expect(result.verification.verifierId).toBe("verifier-01");
    expect(result.verification.pagesRequiringVerification).toEqual([1, 2, 3]);

    const epubBytes = await fs.readFile(outEpub);
    expect(sha256(epubBytes)).toBe(result.outputSha256);
    const inspected = inspectBytes(epubBytes, true);
    const navStr = inspected.entries.get("EPUB/nav.xhtml")!.bytes.toString();
    const tocStr = inspected.entries.get("EPUB/toc.xhtml")!.bytes.toString();
    expect(navStr).not.toContain("colophon.xhtml");
    expect(tocStr).not.toContain("colophon.xhtml");
    expect(navStr).toContain('epub:type="page-list"');
    const opfStr = inspected.packageDocument.toString();
    expect(opfStr).toContain('properties="mathml"');
    expect(opfStr).toContain('rendition:layout">reflowable<');
    expect(opfStr).toContain('page-progression-direction="ltr"');

    const ch1 = inspected.entries
      .get("EPUB/text/ch-001.xhtml")!
      .bytes.toString();
    expect(ch1).toContain("<ruby>金石<rt>jīn shí</rt></ruby>");
    expect(ch1).toContain("且跨页延续至此完整结束。");
    expect(ch1).toContain('rowspan="2"');
    expect(ch1).toContain('colspan="2"');
    expect(ch1).toContain('class="voice-epigraph"');
    expect(ch1).toContain('class="voice-verse gap-before"');
    expect(ch1).toContain('class="voice-signature"');

    // Bidirectional popup footnotes pass static checkNotes without issues
    const noteReport = await checkNotes(outEpub);
    expect(noteReport.status).toBe("inspected");
    expect(noteReport.notes.issues).toEqual([]);
    expect(noteReport.notes.references.length).toBeGreaterThanOrEqual(1);

    // pdf-import.json report saved cleanly
    const importReport = await readJson<typeof result>(
      path.join(reportsDir, "pdf-import.json"),
    );
    expect(importReport.outputSha256).toBe(result.outputSha256);
  }, 120_000);

  it("wires pdf enhance-image, pdf build-epub, and epub convert <pdf> through the CLI", async () => {
    const root = await makeTempDir();
    const cli = path.join(repoRoot, "packages/cli/src/index.ts");
    const invoke = (args: string[]) =>
      run(process.execPath, ["--import", "tsx", cli, ...args], {
        cwd: repoRoot,
      });

    // 1. Direct digital+photo hybrid PDF conversion via CLI `epub convert`
    const hybridPdf = path.join(root, "hybrid.pdf");
    await fs.writeFile(hybridPdf, buildDigitalHybridPdf());
    const hybridBefore = sha256(await fs.readFile(hybridPdf));
    const hybridOut = path.join(root, "hybrid.epub");
    const convCli = await invoke([
      "epub",
      "convert",
      hybridPdf,
      "--output",
      hybridOut,
      "--json",
    ]);
    expect(convCli.exitCode, convCli.stderr).toBe(0);
    const convPayload = JSON.parse(convCli.stdout) as {
      status: string;
      validation: { status: string };
      outputSha256: string;
    };
    expect(convPayload.status).toBe("pass");
    expect(convPayload.validation.status).toBe("pass");
    expect(sha256(await fs.readFile(hybridPdf))).toBe(hybridBefore);
    expect(sha256(await fs.readFile(hybridOut))).toBe(convPayload.outputSha256);

    // 2. CLI `pdf enhance-image` and argument error guards
    const figIn = path.join(root, "cli-fig.png");
    await makeStructuredFigurePng(figIn);
    const figOut = path.join(root, "cli-fig-out.png");
    const enhCli = await invoke([
      "pdf",
      "enhance-image",
      figIn,
      "--output",
      figOut,
      "--denoise",
      "--upscale",
      "2",
      "--json",
    ]);
    expect(enhCli.exitCode, enhCli.stderr).toBe(0);
    expect(JSON.parse(enhCli.stdout).generativeRedraw).toBe(false);

    const badUpscale = await invoke([
      "pdf",
      "enhance-image",
      figIn,
      "--output",
      path.join(root, "bad-up.png"),
      "--upscale",
      "4",
      "--json",
    ]);
    expect(badUpscale.exitCode).toBe(1);

    // 3. CLI `pdf build-epub` and `--spec` hash mismatch guard on `epub convert`
    const specPath = path.join(root, "hybrid.spec.json");
    await initPdfSpec(hybridPdf, specPath);
    const builtOut = path.join(root, "from-spec.epub");
    const buildCli = await invoke([
      "pdf",
      "build-epub",
      specPath,
      "--output",
      builtOut,
      "--json",
    ]);
    expect(buildCli.exitCode, buildCli.stderr).toBe(0);
    expect(JSON.parse(buildCli.stdout).validation.status).toBe("pass");

    const otherPdf = path.join(root, "other.pdf");
    await fs.writeFile(otherPdf, buildScannedPdf());
    await expect(
      convertPdfToEpub(otherPdf, path.join(root, "mismatch.epub"), {
        spec: specPath,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_HASH_MISMATCH" });
  }, 120_000);

  it("converts a real Chrome 2-column CJK + photo PDF directly to a validated EPUB 3.3", async () => {
    let executable: string;
    try {
      executable = await browserPath();
    } catch {
      return;
    }
    const root = await makeTempDir();
    const imgBuf = await sharp({
      create: {
        width: 240,
        height: 240,
        channels: 3,
        background: { r: 70, g: 120, b: 185 },
      },
    })
      .png()
      .toBuffer();
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { font-family: sans-serif; margin: 36pt; }
      .cols { display: flex; gap: 36pt; }
      .col { flex: 1; font-size: 12pt; line-height: 1.5; }
    </style></head><body>
      <h1>Chrome EPUB Conversion</h1>
      <div class="cols">
        <div class="col"><p>LEFT_COLUMN 中⽂康熙部首正文。</p></div>
        <div class="col">
          <p>RIGHT_COLUMN second column paragraph.</p>
          <img src="data:image/png;base64,${imgBuf.toString("base64")}" width="140" height="140" alt="photo"/>
        </div>
      </div>
    </body></html>`;
    const chromePdf = path.join(root, "chrome-convert.pdf");
    const browser = await chromium.launch({
      executablePath: executable,
      headless: true,
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html);
      await page.pdf({ path: chromePdf, format: "A4" });
    } finally {
      await browser.close();
    }
    const chromeOut = path.join(root, "chrome-convert.epub");
    const chromeBuilt = await convertPdfToEpub(chromePdf, chromeOut);
    expect(chromeBuilt.status).toBe("pass");
    expect(chromeBuilt.validation.status).toBe("pass");
    const chromeInspected = inspectBytes(await fs.readFile(chromeOut), true);
    expect(
      chromeInspected.manifest.some((m) => m.mediaType.startsWith("image/")),
    ).toBe(true);
    const chromeBody = [...chromeInspected.entries.entries()]
      .filter(([k]) => k.startsWith("EPUB/text/"))
      .map(([, v]) => v.bytes.toString())
      .join("\n");
    expect(chromeBody).toContain("中文康熙部首正文");
    expect(chromeBody).not.toContain("⽂");
  }, 120_000);

  it("unifies PDF EPUB output onto shared preset themes, opening paragraphs, graduated gaps, explicit alignment, and Markdown round-trip", async () => {
    const root = await makeTempDir();
    const coverImg = path.join(root, "cover.png");
    await makeStructuredFigurePng(coverImg);
    const [baseCss, litCss, techCss, frontCss] = await Promise.all([
      fs.readFile(path.join(repoRoot, "styles/base/epub.css")),
      fs.readFile(path.join(repoRoot, "styles/themes/literature.css")),
      fs.readFile(path.join(repoRoot, "styles/themes/technical.css")),
      fs.readFile(path.join(repoRoot, "styles/base/frontmatter.css")),
    ]);

    const spec: PdfSpec = {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-spec",
      source: {
        path: path.join(root, "themed.pdf"),
        sha256: "b".repeat(64),
        pdfVersion: "1.6",
        pageCount: 1,
        classification: "digital",
      },
      metadata: {
        title: "Typography Fidelity Study",
        authors: ["Ada Author"],
        language: "en",
        description: "Shared theme presets and semantic PDF fidelity.",
        tags: [],
        modified: "2026-11-27T00:00:00Z",
      },
      frontmatter: {
        coverImage: coverImg,
        coverAlt: "Cover illustration",
        titlepage: {
          title: "Typography Fidelity Study",
          authors: ["Ada Author"],
        },
        colophon: { copyright: "© 2026 Press", lines: [] },
        includeTitlepage: true,
        includeColophon: true,
      },
      outline: [],
      shards: [{ id: "shard-01", pageStart: 1, pageEnd: 1 }],
      pages: [
        {
          page: 1,
          widthPt: 595,
          heightPt: 842,
          rotate: 0,
          classification: "digital",
          ocrTrust: "digital-native",
          blocks: [
            { kind: "heading", level: 1, text: "Chapter One" },
            { kind: "paragraph", text: "Opening paragraph after heading." },
            { kind: "paragraph", text: "Second narrative paragraph." },
            {
              kind: "paragraph",
              text: "Standard vertical gap paragraph.",
              gapBefore: true,
            },
            {
              kind: "paragraph",
              text: "Larger vertical gap paragraph.",
              gapBefore: 2,
            },
            {
              kind: "paragraph",
              text: "Centered dedication.",
              align: "center",
            },
            {
              kind: "paragraph",
              text: "Right-aligned date.",
              align: "right",
            },
            {
              kind: "paragraph",
              text: "Left-aligned colophon line.",
              align: "left",
            },
            {
              kind: "paragraph",
              text: "Justified body defers to reading system.",
              align: "justify",
            },
            { kind: "hr" },
            { kind: "paragraph", text: "Opening paragraph after scene break." },
            { kind: "heading", level: 2, text: "Section Two" },
            {
              kind: "paragraph",
              text: "Epigraph stays a voice, not opening prose.",
              voice: "epigraph",
              align: "right",
            },
          ],
          footnotes: [],
        },
      ],
    };

    const litOut = await renderPdfSpecToEpub(spec, root);
    expect(litOut.theme).toBe("literature");
    expect(validateInternal(litOut.bytes).status).toBe("pass");
    const litInfo = inspectBytes(litOut.bytes, true);
    expect(litInfo.entries.get("EPUB/styles/pdf.css")).toBeUndefined();
    expect(litInfo.entries.get("EPUB/styles/base.css")!.bytes).toEqual(baseCss);
    expect(litInfo.entries.get("EPUB/styles/theme.css")!.bytes).toEqual(litCss);
    expect(litInfo.entries.get("EPUB/styles/frontmatter.css")!.bytes).toEqual(
      frontCss,
    );
    expect(litInfo.entries.get("EPUB/cover.xhtml")!.bytes.toString()).toContain(
      'class="cover-document single-column"',
    );
    for (const docPath of [
      "EPUB/titlepage.xhtml",
      "EPUB/colophon.xhtml",
      "EPUB/toc.xhtml",
      "EPUB/nav.xhtml",
      "EPUB/text/ch-001.xhtml",
    ]) {
      expect(litInfo.entries.get(docPath)!.bytes.toString()).toContain(
        'class="single-column"',
      );
    }
    const ch1 = litInfo.entries.get("EPUB/text/ch-001.xhtml")!.bytes.toString();
    expect(ch1).toContain(
      '<p class="opening">Opening paragraph after heading.</p>',
    );
    expect(ch1).toContain("<p>Second narrative paragraph.</p>");
    expect(ch1).toContain(
      '<p class="gap-before">Standard vertical gap paragraph.</p>',
    );
    expect(ch1).toContain(
      '<p class="gap-before-lg">Larger vertical gap paragraph.</p>',
    );
    expect(ch1).toContain('<p class="align-center">Centered dedication.</p>');
    expect(ch1).toContain('<p class="align-right">Right-aligned date.</p>');
    expect(ch1).toContain(
      '<p class="align-left">Left-aligned colophon line.</p>',
    );
    expect(ch1).toContain("<p>Justified body defers to reading system.</p>");
    expect(ch1).not.toContain("align-justify");
    expect(ch1).toContain(
      '<p class="opening">Opening paragraph after scene break.</p>',
    );
    expect(ch1).toContain(
      '<p class="voice-epigraph align-right">Epigraph stays a voice, not opening prose.</p>',
    );

    const techOut = await renderPdfSpecToEpub(spec, root, {
      theme: "technical",
    });
    expect(techOut.theme).toBe("technical");
    expect(validateInternal(techOut.bytes).status).toBe("pass");
    const techInfo = inspectBytes(techOut.bytes, true);
    expect(techInfo.entries.get("EPUB/styles/theme.css")!.bytes).toEqual(
      techCss,
    );

    // Per-page Markdown round-trip for ::gap, :::align, and :::voice{align}
    const specFile = path.join(root, "themed.spec.json");
    await json(specFile, spec);
    const mdShards = path.join(root, "themed-md");
    const shardRes = await initPdfShards(specFile, mdShards, { format: "md" });
    const p1Md = await fs.readFile(shardRes.shards[0].files[0], "utf8");
    expect(p1Md).toContain("::gap\n");
    expect(p1Md).toContain('::gap{lines="2"}');
    expect(p1Md).toContain(':::align{to="center"}');
    expect(p1Md).toContain(':::voice{kind="epigraph" align="right"}');
    expect(p1Md).not.toContain('to="justify"');

    const valShard = await validatePdfShard(mdShards);
    expect(valShard.status).toBe("pass");
    const mergedPath = path.join(root, "themed-merged.spec.json");
    await mergePdfShards(specFile, mdShards, mergedPath);
    const mergedSpec = await readJson<PdfSpec>(mergedPath);
    const mergedBlocks = mergedSpec.pages[0].blocks;
    expect(mergedBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "paragraph",
          text: "Standard vertical gap paragraph.",
          gapBefore: true,
        }),
        expect.objectContaining({
          kind: "paragraph",
          text: "Larger vertical gap paragraph.",
          gapBefore: 2,
        }),
        expect.objectContaining({
          kind: "paragraph",
          text: "Centered dedication.",
          align: "center",
        }),
        expect.objectContaining({
          kind: "paragraph",
          text: "Epigraph stays a voice, not opening prose.",
          voice: "epigraph",
          align: "right",
        }),
      ]),
    );

    // Invalid ::gap, :::align, and :::voice{align} diagnostics
    const badDirectives = compilePdfPageMarkdown(
      `---\npage: 1\n---\n\n::gap{lines="0"}\n\nParagraph.\n\n::gap\n\n# Heading\n\n:::align{to="justify"}\nText.\n:::\n\n:::voice{kind="quote" align="justify"}\nQuote.\n:::\n\n::gap\n`,
      "bad-typo.md",
    );
    const directiveErrs = badDirectives.diagnostics.filter(
      (d) => d.code === "PDF_MD_DIRECTIVE",
    );
    expect(directiveErrs.length).toBeGreaterThanOrEqual(5);

    // CLI --theme wiring on pdf init-spec, pdf build-epub, epub convert, and conflict guards
    const cli = path.join(repoRoot, "packages/cli/src/index.ts");
    const invoke = (args: string[]) =>
      run(process.execPath, ["--import", "tsx", cli, ...args], {
        cwd: repoRoot,
      });
    const hybridPdf = path.join(root, "hybrid-themed.pdf");
    await fs.writeFile(hybridPdf, buildDigitalHybridPdf());
    const initSpecPath = path.join(root, "cli-tech.spec.json");
    const initCli = await invoke([
      "pdf",
      "init-spec",
      hybridPdf,
      "--theme",
      "technical",
      "--output",
      initSpecPath,
      "--json",
    ]);
    expect(initCli.exitCode, initCli.stderr).toBe(0);
    expect(JSON.parse(initCli.stdout).theme).toBe("technical");
    expect((await readJson<PdfSpec>(initSpecPath)).theme).toBe("technical");

    const fromSpecEpub = path.join(root, "cli-spec-tech.epub");
    const buildCli = await invoke([
      "pdf",
      "build-epub",
      initSpecPath,
      "--output",
      fromSpecEpub,
      "--json",
    ]);
    expect(buildCli.exitCode, buildCli.stderr).toBe(0);
    expect(JSON.parse(buildCli.stdout).theme).toBe("technical");
    expect(
      inspectBytes(await fs.readFile(fromSpecEpub), true).entries.get(
        "EPUB/styles/theme.css",
      )!.bytes,
    ).toEqual(techCss);

    const directPdfEpub = path.join(root, "cli-direct-tech.epub");
    const convertCli = await invoke([
      "epub",
      "convert",
      hybridPdf,
      "--theme",
      "technical",
      "--output",
      directPdfEpub,
      "--json",
    ]);
    expect(convertCli.exitCode, convertCli.stderr).toBe(0);
    expect(JSON.parse(convertCli.stdout).theme).toBe("technical");
    expect(
      inspectBytes(await fs.readFile(directPdfEpub), true).entries.get(
        "EPUB/styles/theme.css",
      )!.bytes,
    ).toEqual(techCss);

    const badThemeCli = await invoke([
      "pdf",
      "init-spec",
      hybridPdf,
      "--theme",
      "unknown",
      "--output",
      path.join(root, "bad-theme.spec.json"),
      "--json",
    ]);
    expect(badThemeCli.exitCode).toBe(1);
    expect(JSON.parse(badThemeCli.stdout).code).toBe("THEME_INVALID");

    const epubThemeConflict = await invoke([
      "epub",
      "convert",
      directPdfEpub,
      "--to",
      "simplified",
      "--theme",
      "technical",
      "--output",
      path.join(root, "conflict.epub"),
      "--json",
    ]);
    expect(epubThemeConflict.exitCode).toBe(1);
    expect(JSON.parse(epubThemeConflict.stdout).code).toBe("ARGUMENT_CONFLICT");
  }, 120_000);
});

function buildScannedPdfWithIdAndGen(): Buffer {
  const img1 = zlib.deflateSync(Buffer.alloc(120 * 160 * 3, 0xdd));
  const objects = new Map<number, { gen: number; body: string | Buffer }>();
  objects.set(1, { gen: 0, body: "<< /Type /Catalog /Pages 2 0 R >>" });
  objects.set(2, {
    gen: 0,
    body: "<< /Type /Pages /Count 2 /Kids [3 2 R 4 0 R] /MediaBox [0 0 595 842] >>",
  });
  objects.set(11, {
    gen: 0,
    body: pdfStream(
      "/Type /XObject /Subtype /Image /Width 120 /Height 160 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
      img1,
    ),
  });
  objects.set(13, {
    gen: 0,
    body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  objects.set(3, {
    gen: 2,
    body: "<< /Type /Page /Parent 2 0 R /PieceInfo << /ReaddleObject << /Private (bad) >> /KeepMe << /Ok 1 >> >> /Resources << /XObject << /Im1 11 0 R >> /Font << /F1 13 0 R >> >> /Contents 7 0 R >>",
  });
  objects.set(7, {
    gen: 0,
    body: flateStream(
      "",
      "q 595 0 0 842 0 0 cm /Im1 Do Q\nBT 3 Tr /F1 12 Tf 1 0 0 1 72 700 Tm (Helo wrold te) Tj ET",
    ),
  });
  objects.set(4, {
    gen: 0,
    body: "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 11 0 R >> >> /Contents 8 0 R >>",
  });
  objects.set(8, {
    gen: 0,
    body: flateStream("", "q 595 0 0 842 0 0 cm /Im1 Do Q"),
  });

  const sorted = [...objects.keys()].sort((a, b) => a - b);
  const maxObj = sorted[sorted.length - 1]!;
  const header = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const chunks: Buffer[] = [header];
  let offset = header.length;
  const offsets = new Map<number, { offset: number; gen: number }>();

  for (const num of sorted) {
    const entry = objects.get(num)!;
    offsets.set(num, { offset, gen: entry.gen });
    const bodyBuf =
      typeof entry.body === "string"
        ? Buffer.from(entry.body, "latin1")
        : entry.body;
    const wrapped = Buffer.concat([
      Buffer.from(`${num} ${entry.gen} obj\n`, "latin1"),
      bodyBuf,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(wrapped);
    offset += wrapped.length;
  }

  const xrefStart = offset;
  const xrefLines = [`xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`];
  for (let i = 1; i <= maxObj; i++) {
    const meta = offsets.get(i);
    xrefLines.push(
      meta
        ? `${String(meta.offset).padStart(10, "0")} ${String(meta.gen).padStart(5, "0")} n \n`
        : "0000000000 65535 f \n",
    );
  }
  chunks.push(
    Buffer.from(xrefLines.join(""), "latin1"),
    Buffer.from(
      `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R /ID [<0123456789ABCDEF0123456789ABCDEF> <FEDCBA9876543210FEDCBA9876543210>] >>\nstartxref\n${xrefStart}\n%%EOF\n`,
      "latin1",
    ),
  );
  return Buffer.concat(chunks);
}

function buildScannedPdf15XrefStream(): Buffer {
  const imgRaw = zlib.deflateSync(Buffer.alloc(100 * 140 * 3, 0xcc));
  const obj1 = "<< /Type /Catalog /Pages 2 0 R >>";
  const obj2 =
    "<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 595 842] >>";
  const entries = [
    { num: 1, str: obj1 },
    { num: 2, str: obj2 },
  ];
  const bodyParts: string[] = [];
  const headerPairs: string[] = [];
  let rel = 0;
  for (const item of entries) {
    headerPairs.push(`${item.num} ${rel}`);
    bodyParts.push(item.str);
    rel += Buffer.byteLength(item.str, "latin1") + 1;
  }
  const headerStr = `${headerPairs.join(" ")}\n`;
  const objStm = flateStream(
    `/Type /ObjStm /N ${entries.length} /First ${Buffer.byteLength(headerStr, "latin1")}`,
    Buffer.from(`${headerStr}${bodyParts.join("\n")}`, "latin1"),
  );
  const obj3 = Buffer.from(
    "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
    "latin1",
  );
  const obj4 = pdfStream(
    "/Type /XObject /Subtype /Image /Width 100 /Height 140 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
    imgRaw,
  );
  const obj5 = flateStream("", "q 595 0 0 842 0 0 cm /Im1 Do Q");

  const fileHeader = Buffer.from("%PDF-1.5\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const chunks: Buffer[] = [fileHeader];
  let pos = fileHeader.length;
  const wrap = (num: number, content: Buffer) => {
    const start = pos;
    const buf = Buffer.concat([
      Buffer.from(`${num} 0 obj\n`, "latin1"),
      content,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(buf);
    pos += buf.length;
    return start;
  };
  const off3 = wrap(3, obj3);
  const off4 = wrap(4, obj4);
  const off5 = wrap(5, obj5);
  const off6 = wrap(6, objStm);
  const off7 = pos;

  const rows: Buffer[] = [];
  const addRow = (type: number, f1: number, f2: number) => {
    const b = Buffer.alloc(7);
    b[0] = type;
    b.writeUInt32BE(f1, 1);
    b.writeUInt16BE(f2, 5);
    rows.push(b);
  };
  addRow(0, 0, 65535);
  addRow(2, 6, 0);
  addRow(2, 6, 1);
  addRow(1, off3, 0);
  addRow(1, off4, 0);
  addRow(1, off5, 0);
  addRow(1, off6, 0);
  addRow(1, off7, 0);

  const xrefStream = flateStream(
    "/Type /XRef /Size 8 /Root 1 0 R /W [1 4 2] /ID [<11111111111111111111111111111111> <22222222222222222222222222222222>]",
    Buffer.concat(rows),
  );
  wrap(7, xrefStream);
  chunks.push(Buffer.from(`startxref\n${off7}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

describe("Incremental scanned-PDF OCR/bookmark repair (P0-1, P1-B3)", () => {
  it("builds a valid checksummed GlyphLess TrueType font and strips invisible OCR blocks only", () => {
    const ttf = buildGlyphLessTrueTypeFont();
    expect(ttf.readUInt32BE(0)).toBe(0x00010000);
    const numTables = ttf.readUInt16BE(4);
    expect(numTables).toBe(10);
    const tags: string[] = [];
    for (let i = 0; i < numTables; i++) {
      tags.push(ttf.subarray(12 + i * 16, 16 + i * 16).toString("ascii"));
    }
    expect(tags).toEqual([...tags].sort());
    let sum = 0;
    for (let i = 0; i < ttf.length; i += 4) {
      sum = (sum + ttf.readUInt32BE(i)) >>> 0;
    }
    expect(sum).toBe(0xb1b0afba);

    const mixedStream = Buffer.from(
      "q 595 0 0 842 0 0 cm /Im1 Do Q\nBT 3 Tr /F1 12 Tf (Helo wrold te) Tj ET\nBT 0 Tr /F1 12 Tf (KeepVisible) Tj ET\n",
      "latin1",
    );
    const stripped = stripInvisibleOcrFromContentStream(mixedStream);
    expect(stripped.strippedBlocks).toBe(1);
    const outStr = stripped.cleaned.toString("latin1");
    expect(outStr).toContain("/Im1 Do");
    expect(outStr).toContain("KeepVisible");
    expect(outStr).not.toContain("Helo wrold te");
  });

  it("repairs Readdle OCR with proofread blocks, Tz fit, /Outlines, incremental prefix/gen/ID preservation, and readback gate", async () => {
    const root = await makeTempDir();
    const srcPdf = path.join(root, "readdle-scan.pdf");
    const srcBytes = buildScannedPdfWithIdAndGen();
    await fs.writeFile(srcPdf, srcBytes);

    const specPath = path.join(root, "readdle.spec.json");
    await initPdfSpec(srcPdf, specPath);
    const spec = await readJson<PdfSpec>(specPath);

    const p1Png = path.join(root, "p1.png");
    const p2Png = path.join(root, "p2.png");
    const [p1Sha, p2Sha] = await Promise.all([
      makeSyntheticPagePng(p1Png),
      makeSyntheticPagePng(p2Png),
    ]);

    const longProofreadLine =
      "这是一段经过多模态大模型逐切片精校的超长中文与English混合验证句子，用来确保Tz水平缩放与无字形字体不会在页面右边界被截断：The quick brown fox jumps over the lazy dog 1234567890。";
    spec.outline = [
      { title: "第一章 校订正文", page: 1, children: [] },
      { title: "第二章 块级回退页", page: 2, children: [] },
    ];
    spec.pages[0] = {
      ...spec.pages[0],
      render: { path: p1Png, sha256: p1Sha, dpi: 300 },
      transcription: { transcribedBy: "worker-ocr-1", unresolved: [] },
      geometry: [
        { x: 72, y: 700, width: 450, height: 14, source: "ocr-layer" },
      ],
      blocks: [{ kind: "paragraph", text: longProofreadLine }],
      footnotes: [],
    };
    spec.pages[1] = {
      ...spec.pages[1],
      render: { path: p2Png, sha256: p2Sha, dpi: 300 },
      transcription: { transcribedBy: "worker-ocr-2", unresolved: [] },
      geometry: [],
      blocks: [
        { kind: "heading", level: 1, text: "第二章 块级回退页" },
        {
          kind: "paragraph",
          text: "行数不匹配时必须退回块级大框并在报告中显式标注。",
        },
      ],
      footnotes: [],
    };
    await json(specPath, spec);

    // P0-1 readback gate catches stale Readdle text on original un-repaired PDF
    await expect(
      verifyPdfOcrLayerReadback(srcPdf, spec, [1]),
    ).rejects.toMatchObject({ code: "PDF_OCR_LAYER_STALE" });

    // P0-2 blocks repair without independent verification
    await expect(
      repairScannedPdf(srcPdf, specPath, path.join(root, "blocked.pdf")),
    ).rejects.toMatchObject({ code: "PDF_OCR_VERIFICATION_REQUIRED" });

    const verPath = path.join(root, "verification.json");
    await json(verPath, {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-verification",
      sourceSha256: spec.source.sha256,
      verifierId: "verifier-ocr",
      verifiedAt: "2026-11-21T00:00:00Z",
      pages: spec.pages.map((p) => ({
        page: p.page,
        renderSha256: p.render!.sha256,
        dpi: 300,
        tilesReviewed: [],
        transcribedBy: p.transcription!.transcribedBy,
        verifiedBy: "verifier-ocr",
        contentSha256: computePageContentSha256(p),
        status: "verified",
        unresolved: [],
      })),
    } satisfies PdfVerificationFile);

    const outPdf = path.join(root, "repaired.pdf");
    const bakPdf = path.join(root, "backup.pdf");
    const repDir = path.join(root, "repair-reports");
    const report = await repairScannedPdf(srcPdf, specPath, outPdf, {
      verification: verPath,
      backup: bakPdf,
      reports: repDir,
    });

    expect(report.status).toBe("pass");
    expect(report.incrementalUpdate).toBe(true);
    expect(report.xrefFormat).toBe("classic");
    expect(report.ocrLayerVerified).toBe(true);
    expect(report.preservedImageStreams.verifiedBitIdentical).toBe(true);
    expect(report.preservedImageStreams.count).toBe(2);
    expect(report.strippedOcrArtifacts).toBeGreaterThanOrEqual(2);
    expect(report.outlineEntries).toBe(2);
    expect(report.backup?.sha256).toBe(sha256(srcBytes));

    expect(report.pageAlignments[0]).toMatchObject({
      page: 1,
      mode: "line-matched",
    });
    expect(report.pageAlignments[1]).toMatchObject({
      page: 2,
      mode: "block-fallback",
    });

    const outBytes = await fs.readFile(outPdf);
    expect(outBytes.subarray(0, srcBytes.length).equals(srcBytes)).toBe(true);
    expect(await fs.readFile(bakPdf)).toEqual(srcBytes);

    const repParser = new PdfDocumentParser(outBytes);
    const repPages = collectPages(repParser);
    expect(repPages[0].gen).toBe(2);
    const repPiece = asDict(
      repParser.resolve(dictGet(repPages[0].dict, "PieceInfo")),
    );
    expect(repPiece?.entries.has("ReaddleObject")).toBe(false);
    expect(repPiece?.entries.has("KeepMe")).toBe(true);

    const repId = asArr(repParser.resolve(dictGet(repParser.trailer, "ID")));
    expect(repId).toHaveLength(2);
    expect(
      repId?.[0] &&
        typeof repId[0] === "object" &&
        !Array.isArray(repId[0]) &&
        repId[0].kind === "str" &&
        repId[0].raw.toString("hex").toUpperCase(),
    ).toBe("0123456789ABCDEF0123456789ABCDEF");

    const pageByObj = new Map(repPages.map((p) => [p.objNum, p.page]));
    const outline = extractOutline(repParser, pageByObj);
    expect(outline.map((n) => ({ title: n.title, page: n.page }))).toEqual([
      { title: "第一章 校订正文", page: 1 },
      { title: "第二章 块级回退页", page: 2 },
    ]);

    const hasPdftotext = await run("pdftotext", ["-v"], { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (hasPdftotext) {
      expect(report.readbackTool).toBe("pdftotext");
      const txt = await run("pdftotext", [outPdf, "-"], { timeout: 15000 });
      expect(txt.exitCode).toBe(0);
      expect(txt.stdout).not.toContain("Helo");
      expect(txt.stdout).not.toContain("wrold");
      expect(txt.stdout.replace(/\s+/g, "")).toContain(
        longProofreadLine.replace(/\s+/g, ""),
      );
      expect(txt.stdout.replace(/\s+/g, "")).toContain(
        "行数不匹配时必须退回块级大框并在报告中显式标注。",
      );
    }

    const hasQpdf = await run("qpdf", ["--version"], { timeout: 5000 })
      .then((r) => r.exitCode === 0)
      .catch(() => false);
    if (hasQpdf) {
      const qpdfCheck = await run("qpdf", ["--check", outPdf], {
        timeout: 15000,
      });
      expect(qpdfCheck.exitCode, qpdfCheck.stderr).toBe(0);
    }

    const saved = await readJson<typeof report>(
      path.join(repDir, "pdf-repair.json"),
    );
    expect(saved.output.sha256).toBe(report.output.sha256);
  });

  it("repairs PDF 1.5 compressed XRef-stream PDFs incrementally and wires CLI pdf repair-ocr", async () => {
    const root = await makeTempDir();
    const pdf15Path = path.join(root, "scan15.pdf");
    const pdf15Bytes = buildScannedPdf15XrefStream();
    await fs.writeFile(pdf15Path, pdf15Bytes);

    const specPath = path.join(root, "scan15.spec.json");
    await initPdfSpec(pdf15Path, specPath);
    const spec = await readJson<PdfSpec>(specPath);

    const p1Png = path.join(root, "p1.png");
    const p1Sha = await makeSyntheticPagePng(p1Png);
    spec.pages[0] = {
      ...spec.pages[0],
      render: { path: p1Png, sha256: p1Sha, dpi: 300 },
      transcription: { transcribedBy: "worker-15", unresolved: [] },
      blocks: [
        { kind: "paragraph", text: "PDF一点五压缩交叉引用流增量修复验证。" },
      ],
      footnotes: [],
    };
    spec.outline = [{ title: "压缩流书签", page: 1, children: [] }];
    await json(specPath, spec);

    const verPath = path.join(root, "ver15.json");
    await json(verPath, {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-verification",
      sourceSha256: spec.source.sha256,
      verifierId: "verifier-15",
      verifiedAt: "2026-11-21T00:00:00Z",
      pages: [
        {
          page: 1,
          renderSha256: p1Sha,
          dpi: 300,
          tilesReviewed: [],
          transcribedBy: "worker-15",
          verifiedBy: "verifier-15",
          contentSha256: computePageContentSha256(spec.pages[0]),
          status: "verified",
          unresolved: [],
        },
      ],
    } satisfies PdfVerificationFile);

    const cli = path.join(repoRoot, "packages/cli/src/index.ts");
    const outPdf = path.join(root, "scan15-repaired.pdf");
    const cliRes = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        cli,
        "pdf",
        "repair-ocr",
        pdf15Path,
        "--spec",
        specPath,
        "--verification",
        verPath,
        "--output",
        outPdf,
        "--json",
      ],
      { cwd: repoRoot },
    );
    expect(cliRes.exitCode, cliRes.stdout || cliRes.stderr).toBe(0);
    const payload = JSON.parse(cliRes.stdout) as {
      status: string;
      xrefFormat: string;
      incrementalUpdate: boolean;
      ocrLayerVerified: boolean;
      outlineEntries: number;
    };
    expect(payload.status).toBe("pass");
    expect(payload.xrefFormat).toBe("xref-stream");
    expect(payload.incrementalUpdate).toBe(true);
    expect(payload.ocrLayerVerified).toBe(true);
    expect(payload.outlineEntries).toBe(1);

    const outBytes = await fs.readFile(outPdf);
    expect(outBytes.subarray(0, pdf15Bytes.length).equals(pdf15Bytes)).toBe(
      true,
    );
    const parsed = new PdfDocumentParser(outBytes);
    expect(parsed.usesXrefStream).toBe(true);
    const pages = collectPages(parsed);
    const outline = extractOutline(
      parsed,
      new Map(pages.map((p) => [p.objNum, p.page])),
    );
    expect(outline[0]?.title).toBe("压缩流书签");
  });

  it("covers vertical OCR lines, nested outlines, skipped-empty pages, Readdle annots, and repair error guards", async () => {
    const root = await makeTempDir();
    const img1 = zlib.deflateSync(Buffer.alloc(80 * 100 * 3, 0xee));
    const objs = new Map<number, string | Buffer>();
    objs.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
    objs.set(
      2,
      "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 595 842] >>",
    );
    objs.set(
      10,
      pdfStream(
        "/Type /XObject /Subtype /Image /Width 80 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
        img1,
      ),
    );
    objs.set(11, "<< /ReaddleAnnot (drop) /Subtype /Text >>");
    objs.set(12, "<< /Subtype /Link /Border [0 0 0] >>");
    objs.set(
      3,
      "<< /Type /Page /Parent 2 0 R /Annots [11 0 R 12 0 R] /Resources << /XObject << /Im1 10 0 R >> >> /Contents [5 0 R] >>",
    );
    objs.set(5, flateStream("", "q 595 0 0 842 0 0 cm /Im1 Do Q"));
    objs.set(
      4,
      "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 10 0 R >> >> /Contents 6 0 R >>",
    );
    objs.set(6, flateStream("", "q 595 0 0 842 0 0 cm /Im1 Do Q"));

    const pdfPath = path.join(root, "edge.pdf");
    await fs.writeFile(pdfPath, buildClassicPdf(objs, { rootObj: 1 }));

    // Guard checks: non-PDF source, non-PDF output, corrupt source, spec hash mismatch
    await expect(
      repairScannedPdf(
        path.join(root, "a.txt"),
        path.join(root, "s.json"),
        path.join(root, "o.pdf"),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    await expect(
      repairScannedPdf(
        pdfPath,
        path.join(root, "s.json"),
        path.join(root, "o.epub"),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });

    const corruptPdf = path.join(root, "corrupt.pdf");
    await fs.writeFile(corruptPdf, "not-a-pdf");
    await expect(
      repairScannedPdf(
        corruptPdf,
        path.join(root, "s.json"),
        path.join(root, "o.pdf"),
      ),
    ).rejects.toMatchObject({ code: "PDF_INVALID" });

    const specPath = path.join(root, "edge.spec.json");
    await initPdfSpec(pdfPath, specPath);
    const spec = await readJson<PdfSpec>(specPath);
    const p1Png = path.join(root, "p1.png");
    const p2Png = path.join(root, "p2.png");
    const [p1Sha, p2Sha] = await Promise.all([
      makeSyntheticPagePng(p1Png),
      makeSyntheticPagePng(p2Png),
    ]);

    spec.outline = [
      {
        title: "卷一",
        page: 1,
        children: [{ title: "第一节 竖排", page: 1, children: [] }],
      },
      { title: "卷二 空白", page: 2, children: [] },
    ];
    spec.pages[0] = {
      ...spec.pages[0],
      render: { path: p1Png, sha256: p1Sha, dpi: 300 },
      transcription: { transcribedBy: "worker-e1", unresolved: [] },
      geometry: [
        {
          x: 500,
          y: 700,
          width: 18,
          height: 200,
          vertical: true,
          source: "ocr-layer",
        },
      ],
      blocks: [{ kind: "paragraph", text: "竖排古籍示例" }],
      footnotes: [],
    };
    spec.pages[1] = {
      ...spec.pages[1],
      render: { path: p2Png, sha256: p2Sha, dpi: 300 },
      transcription: { transcribedBy: "worker-e2", unresolved: [] },
      geometry: [],
      blocks: [],
      footnotes: [],
    };

    const wrongSpec = structuredClone(spec);
    wrongSpec.source.sha256 = "0".repeat(64);
    await expect(
      repairScannedPdf(pdfPath, wrongSpec, path.join(root, "wrong.pdf")),
    ).rejects.toMatchObject({ code: "SOURCE_HASH_MISMATCH" });

    const verObj: PdfVerificationFile = {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-verification",
      sourceSha256: spec.source.sha256,
      verifierId: "verifier-edge",
      verifiedAt: "2026-11-21T00:00:00Z",
      pages: spec.pages.map((p) => ({
        page: p.page,
        renderSha256: p.render!.sha256,
        dpi: 300,
        tilesReviewed: [],
        transcribedBy: p.transcription!.transcribedBy,
        verifiedBy: "verifier-edge",
        contentSha256: computePageContentSha256(p),
        status: "verified",
        unresolved: [],
      })),
    };
    const manifestObj: PdfRenderManifest = {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-render-manifest",
      sourcePath: pdfPath,
      sourceSha256: spec.source.sha256,
      dpi: 300,
      tiled: false,
      pages: [
        {
          page: 1,
          path: p1Png,
          sha256: p1Sha,
          dpi: 300,
          widthPx: 400,
          heightPx: 600,
          estimatedImageTokens: 400,
        },
        {
          page: 2,
          path: p2Png,
          sha256: p2Sha,
          dpi: 300,
          widthPx: 400,
          heightPx: 600,
          estimatedImageTokens: 400,
        },
      ],
    };

    const outPdf = path.join(root, "edge-repaired.pdf");
    const rep = await repairScannedPdf(pdfPath, spec, outPdf, {
      verification: verObj,
      renderManifest: manifestObj,
    });
    expect(rep.outlineEntries).toBe(3);
    expect(rep.strippedOcrArtifacts).toBeGreaterThanOrEqual(1);
    expect(rep.pageAlignments[0]?.mode).toBe("line-matched");
    expect(rep.pageAlignments[1]?.mode).toBe("skipped-empty");

    // Existing output and existing backup refused
    await expect(
      repairScannedPdf(pdfPath, spec, outPdf, { verification: verObj }),
    ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    await expect(
      repairScannedPdf(pdfPath, spec, path.join(root, "edge-2.pdf"), {
        verification: verObj,
        backup: outPdf,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
  });
});
