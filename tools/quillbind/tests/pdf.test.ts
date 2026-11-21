import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../packages/core/src/hash.js";
import { json, readJson } from "../packages/core/src/json.js";
import {
  detectLineGeometryFromImage,
  estimatePageImageTokens,
  extractPdfRawPages,
  inspectPdf,
  isPdfBytes,
  isPdfPath,
  normalizeExtractedPdfText,
  parsePdftotextBboxLayout,
  planPdfShards,
  sliceRenderedPageTiles,
} from "../packages/core/src/pdf-binary.js";
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
