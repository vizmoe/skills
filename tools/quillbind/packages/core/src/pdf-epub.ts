import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { validIsbn, validLanguage } from "./config.js";
import { convertEpub } from "./convert-epub.js";
import { inspectBytes } from "./epub.js";
import { checkAbort, fail } from "./errors.js";
import { exists, readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { json, readJson } from "./json.js";
import { createMathCompiler } from "./math.js";
import { extractPdfRawPages, isPdfPath } from "./pdf-binary.js";
import {
  PDF_SPEC_SCHEMA_VERSION,
  pageRequiresOcrVerification,
  pdfRenderManifestSchema,
  pdfSpecSchema,
  pdfVerificationFileSchema,
  type PdfBlock,
  type PdfDiagnostic,
  type PdfFootnoteItem,
  type PdfImageEnhanceReport,
  type PdfInlineRun,
  type PdfOutlineNode,
  type PdfRenderManifest,
  type PdfSpec,
  type PdfTableCell,
  type PdfVerificationFile,
} from "./pdf-model.js";
import {
  assertPdfSpecVerified,
  extractBlockPlainText,
  guessLanguage,
  stitchPdfPagesInPlace,
  stripRunningHeadersAndFooters,
  validateSpecFootnotes,
  validateTableGrid,
} from "./pdf-shard.js";
import { runQa } from "./qa.js";
import { readingQa } from "./reading-qa.js";
import {
  isOpeningParagraphAfter,
  loadPresetStyles,
  paragraphAlignClass,
  paragraphGapClass,
  type BookTheme,
} from "./styles.js";
import {
  checkEpubConformance,
  compatibilityLint,
  validateInternal,
} from "./validate.js";
import { relative, shell } from "./xhtml.js";
import { escapeXml as e, NS, xml } from "./xml.js";
import type { ConversionTarget } from "./zhconvert.js";
import { pack } from "./zip.js";

async function assertNewOutput(outputPath: string): Promise<string> {
  const resolved = path.resolve(outputPath);
  if (await exists(resolved)) {
    fail("OUTPUT_EXISTS", `Refusing to overwrite existing output: ${resolved}`);
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  return resolved;
}

async function grayscaleBuffer(
  bytes: Uint8Array,
  size: number,
): Promise<Uint8Array> {
  const { data } = await sharp(bytes)
    .grayscale()
    .resize(size, size, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

function windowedSsim(a: Uint8Array, b: Uint8Array, size: number): number {
  const win = 8;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let total = 0;
  let windows = 0;

  for (let y = 0; y + win <= size; y += win) {
    for (let x = 0; x + win <= size; x += win) {
      let sumA = 0;
      let sumB = 0;
      const n = win * win;
      for (let dy = 0; dy < win; dy++) {
        const row = (y + dy) * size + x;
        for (let dx = 0; dx < win; dx++) {
          sumA += a[row + dx];
          sumB += b[row + dx];
        }
      }
      const meanA = sumA / n;
      const meanB = sumB / n;
      let varA = 0;
      let varB = 0;
      let cov = 0;
      for (let dy = 0; dy < win; dy++) {
        const row = (y + dy) * size + x;
        for (let dx = 0; dx < win; dx++) {
          const da = a[row + dx] - meanA;
          const db = b[row + dx] - meanB;
          varA += da * da;
          varB += db * db;
          cov += da * db;
        }
      }
      varA /= n;
      varB /= n;
      cov /= n;
      const num = (2 * meanA * meanB + c1) * (2 * cov + c2);
      const den = (meanA * meanA + meanB * meanB + c1) * (varA + varB + c2);
      total += den === 0 ? 1 : num / den;
      windows++;
    }
  }
  return windows === 0 ? 0 : total / windows;
}

function sobelMagnitude(buf: Uint8Array, size: number): number[] {
  const out: number[] = [];
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const gx =
        -buf[i - size - 1] +
        buf[i - size + 1] -
        2 * buf[i - 1] +
        2 * buf[i + 1] -
        buf[i + size - 1] +
        buf[i + size + 1];
      const gy =
        -buf[i - size - 1] -
        2 * buf[i - size] -
        buf[i - size + 1] +
        buf[i + size - 1] +
        2 * buf[i + size] +
        buf[i + size + 1];
      out.push(Math.hypot(gx, gy));
    }
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA === 0 && denB === 0) return 1;
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

/** Generate a [Before | After | Amplified Diff Heatmap] PNG for visual verifier review. */
async function buildComparisonHeatmap(
  refBytes: Uint8Array,
  outBytes: Uint8Array,
  targetPath: string,
): Promise<string> {
  const meta = await sharp(refBytes).metadata();
  const panelW = Math.max(64, Math.min(480, meta.width ?? 320));
  const panelH = Math.max(
    64,
    Math.min(
      640,
      Math.round(
        ((meta.height ?? 320) * panelW) / Math.max(1, meta.width ?? 320),
      ),
    ),
  );

  const [beforeRaw, afterRaw] = await Promise.all([
    sharp(refBytes)
      .removeAlpha()
      .resize(panelW, panelH, { fit: "fill" })
      .toColorspace("srgb")
      .raw()
      .toBuffer(),
    sharp(outBytes)
      .removeAlpha()
      .resize(panelW, panelH, { fit: "fill" })
      .toColorspace("srgb")
      .raw()
      .toBuffer(),
  ]);

  const diffRaw = Buffer.alloc(panelW * panelH * 3);
  for (let i = 0; i < panelW * panelH; i++) {
    const p = i * 3;
    const delta = Math.round(
      (Math.abs(beforeRaw[p] - afterRaw[p]) +
        Math.abs(beforeRaw[p + 1] - afterRaw[p + 1]) +
        Math.abs(beforeRaw[p + 2] - afterRaw[p + 2])) /
        3,
    );
    const amp = Math.min(255, delta * 3);
    // Heat ramp: dark navy (0) -> orange -> bright yellow (255)
    diffRaw[p] = amp;
    diffRaw[p + 1] =
      amp > 128 ? Math.min(255, (amp - 128) * 2) : Math.round(amp * 0.35);
    diffRaw[p + 2] = Math.max(20, 80 - Math.round(amp * 0.3));
  }

  const gap = 8;
  const totalW = panelW * 3 + gap * 2;
  const composite = await sharp({
    create: {
      width: totalW,
      height: panelH,
      channels: 3,
      background: { r: 32, g: 32, b: 36 },
    },
  })
    .composite([
      {
        input: beforeRaw,
        raw: { width: panelW, height: panelH, channels: 3 },
        left: 0,
        top: 0,
      },
      {
        input: afterRaw,
        raw: { width: panelW, height: panelH, channels: 3 },
        left: panelW + gap,
        top: 0,
      },
      {
        input: diffRaw,
        raw: { width: panelW, height: panelH, channels: 3 },
        left: (panelW + gap) * 2,
        top: 0,
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, composite);
  return sha256(composite);
}

/**
 * Deterministic non-destructive figure restoration with coarse multi-scale SSIM / Sobel edge
 * guards and a side-by-side + diff-heatmap comparison PNG for visual verifier audit.
 */
export async function enhancePdfImage(
  inputFile: string,
  outputFile: string,
  options: {
    deskew?: number;
    denoise?: boolean;
    sharpen?: boolean;
    normalize?: boolean;
    upscale?: 1 | 2;
    verifyAgainst?: string;
    reports?: string;
    signal?: AbortSignal;
  } = {},
): Promise<PdfImageEnhanceReport> {
  checkAbort(options.signal);
  const resolvedInput = path.resolve(inputFile);
  const resolvedOutput = await assertNewOutput(outputFile);
  const inputBytes = await readSourceFile(resolvedInput);
  const referencePath = options.verifyAgainst
    ? path.resolve(options.verifyAgainst)
    : resolvedInput;
  const referenceBytes =
    referencePath === resolvedInput
      ? inputBytes
      : await readSourceFile(referencePath);

  const refMeta = await sharp(referenceBytes).metadata();
  if (!refMeta.width || !refMeta.height || !refMeta.format) {
    fail("IMAGE_INVALID", `Cannot read image dimensions for ${referencePath}`);
  }
  const inMeta = await sharp(inputBytes).metadata();
  if (!inMeta.width || !inMeta.height) {
    fail("IMAGE_INVALID", `Cannot read image dimensions for ${resolvedInput}`);
  }

  // Operation prefixes align directly with pdf.md "Image restoration policy" rule keys.
  const ops: string[] = [];
  let pipeline = sharp(inputBytes);
  const deskew = options.deskew ?? 0;
  if (deskew !== 0) {
    if (!Number.isFinite(deskew) || Math.abs(deskew) > 15) {
      fail(
        "ARGUMENT_CONFLICT",
        "--deskew must be within [-15, 15] degrees for non-destructive skew correction",
      );
    }
    pipeline = pipeline.rotate(deskew, {
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
    ops.push(`deskew:${deskew}`);
  }
  if (options.denoise) {
    pipeline = pipeline.median(3);
    ops.push("denoise:median3");
  }
  if (options.normalize) {
    pipeline = pipeline.normalize();
    ops.push("background-clean:normalize");
  }
  const upscale = options.upscale ?? 1;
  if (upscale === 2) {
    pipeline = pipeline.resize(inMeta.width * 2, inMeta.height * 2, {
      kernel: "lanczos3",
    });
    ops.push("super-resolution:2x-lanczos3");
  } else if (upscale !== 1) {
    fail("ARGUMENT_CONFLICT", "--upscale supports 1 or 2 only");
  }
  if (options.sharpen) {
    pipeline = pipeline.sharpen({ sigma: 1.0 });
    ops.push("deblur:unsharp");
  }

  const ext = path.extname(resolvedOutput).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true });
  } else if (ext === ".webp") {
    pipeline = pipeline.webp({ lossless: true });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9 });
  }

  const outBuf = await pipeline.toBuffer();
  const outMeta = await sharp(outBuf).metadata();
  if (!outMeta.width || !outMeta.height || !outMeta.format) {
    fail("IMAGE_INVALID", "Enhanced output image metadata unreadable");
  }

  const refAspect = refMeta.width / refMeta.height;
  const outAspect = outMeta.width / outMeta.height;
  const aspectRatioDelta =
    Math.round((Math.abs(outAspect - refAspect) / refAspect) * 10000) / 10000;
  const maxAspectDelta = Math.abs(deskew) > 0 ? 0.25 : 0.04;
  if (aspectRatioDelta > maxAspectDelta) {
    fail(
      "IMAGE_FIDELITY_VIOLATION",
      `Refusing geometry alteration: aspect ratio shifted by ${(aspectRatioDelta * 100).toFixed(2)}%`,
    );
  }

  const [ref64, out64, ref128, out128] = await Promise.all([
    grayscaleBuffer(referenceBytes, 64),
    grayscaleBuffer(outBuf, 64),
    grayscaleBuffer(referenceBytes, 128),
    grayscaleBuffer(outBuf, 128),
  ]);
  const ssim64 = windowedSsim(ref64, out64, 64);
  const ssim128 = windowedSsim(ref128, out128, 128);
  const multiScaleSsim = Math.round(((ssim64 + ssim128) / 2) * 10000) / 10000;
  const edgeCorrelation =
    Math.round(
      pearson(sobelMagnitude(ref128, 128), sobelMagnitude(out128, 128)) * 10000,
    ) / 10000;

  const minSsim = Math.abs(deskew) > 2 ? 0.45 : 0.65;
  const minEdge = Math.abs(deskew) > 2 ? 0.35 : 0.5;
  if (multiScaleSsim < minSsim || edgeCorrelation < minEdge) {
    fail(
      "IMAGE_FIDELITY_VIOLATION",
      `Refusing altered image: multiScaleSsim=${multiScaleSsim} (min ${minSsim}), edgeCorrelation=${edgeCorrelation} (min ${minEdge})`,
    );
  }

  await fs.writeFile(resolvedOutput, outBuf, { flag: "wx" });
  const comparePath = options.reports
    ? path.join(
        path.resolve(options.reports),
        `${path.basename(resolvedOutput)}.compare.png`,
      )
    : `${resolvedOutput}.compare.png`;
  const comparisonImageSha256 = await buildComparisonHeatmap(
    referenceBytes,
    outBuf,
    comparePath,
  );

  const report: PdfImageEnhanceReport = {
    schemaVersion: PDF_SPEC_SCHEMA_VERSION,
    source: {
      path: referencePath,
      sha256: sha256(referenceBytes),
      width: refMeta.width,
      height: refMeta.height,
      format: refMeta.format,
    },
    output: {
      path: resolvedOutput,
      sha256: sha256(outBuf),
      width: outMeta.width,
      height: outMeta.height,
      format: outMeta.format,
    },
    comparisonImage: comparePath,
    comparisonImageSha256,
    operations: ops,
    multiScaleSsim,
    edgeCorrelation,
    aspectRatioDelta,
    mode: "non-destructive-restoration",
    generativeRedraw: false,
  };
  if (options.reports) {
    const repDir = path.resolve(options.reports);
    await fs.mkdir(repDir, { recursive: true });
    await json(
      path.join(repDir, `${path.basename(resolvedOutput)}.enhance.json`),
      report,
    );
  }
  return report;
}

interface ChapterFootnote extends PdfFootnoteItem {
  sourcePage: number;
}

interface ChapterBucket {
  id: string;
  href: string;
  title: string;
  subtitle?: string;
  byline?: string;
  startPage: number;
  items: (
    | { kind: "pagebreak"; page: number }
    | { kind: "block"; block: PdfBlock; page: number }
  )[];
  footnotes: ChapterFootnote[];
}

function joinStitchedText(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;
  if (prev.endsWith("-") && /^[a-z]/.test(next)) {
    return prev.slice(0, -1) + next;
  }
  const prevCp = prev.codePointAt(prev.length - 1) ?? 0;
  const nextCp = next.codePointAt(0) ?? 0;
  return prevCp < 0x2e80 && nextCp < 0x2e80
    ? `${prev} ${next}`
    : `${prev}${next}`;
}

function buildChapterBuckets(spec: PdfSpec): {
  buckets: ChapterBucket[];
  warnings: PdfDiagnostic[];
} {
  const outlineByPage = new Map<number, string>();
  const walkOutline = (nodes: PdfOutlineNode[], topLevel = true) => {
    for (const node of nodes) {
      if (topLevel && !outlineByPage.has(node.page)) {
        outlineByPage.set(node.page, node.title);
      }
      if (node.children.length) walkOutline(node.children, false);
    }
  };
  walkOutline(spec.outline, true);

  const buckets: ChapterBucket[] = [];
  const warnings: PdfDiagnostic[] = [];
  let current: ChapterBucket | undefined;

  const openBucket = (
    page: number,
    title: string,
    subtitle?: string,
    byline?: string,
  ): ChapterBucket => {
    const idx = buckets.length + 1;
    const id = `ch-${String(idx).padStart(3, "0")}`;
    const bucket: ChapterBucket = {
      id,
      href: `EPUB/text/${id}.xhtml`,
      title: title.trim() || `Chapter ${idx}`,
      subtitle,
      byline,
      startPage: page,
      items: [],
      footnotes: [],
    };
    buckets.push(bucket);
    current = bucket;
    return bucket;
  };

  let lastSectionId: string | undefined;

  for (const p of spec.pages) {
    const firstBlock = p.blocks[0];
    const hasTopH1 = firstBlock?.kind === "heading" && firstBlock.level === 1;
    const outlineTitle = outlineByPage.get(p.page);
    const sectionChanged = Boolean(
      p.sectionId && p.sectionId !== lastSectionId,
    );

    if (hasTopH1) {
      openBucket(
        p.page,
        firstBlock.text,
        firstBlock.subtitle,
        firstBlock.byline,
      );
      lastSectionId = p.sectionId ?? lastSectionId;
    } else if (outlineTitle && (!current || p.page > current.startPage)) {
      openBucket(p.page, outlineTitle);
      lastSectionId = p.sectionId ?? lastSectionId;
    } else if (sectionChanged) {
      openBucket(p.page, p.sectionId!);
      lastSectionId = p.sectionId;
    } else if (!current) {
      openBucket(p.page, spec.metadata.title);
      lastSectionId = p.sectionId;
    }

    current!.items.push({ kind: "pagebreak", page: p.page });

    const startIndex = hasTopH1 ? 1 : 0;
    for (let bi = startIndex; bi < p.blocks.length; bi++) {
      const block = p.blocks[bi];
      if (block.kind === "heading" && block.level === 1 && bi > 0) {
        openBucket(p.page, block.text, block.subtitle, block.byline);
        continue;
      }

      if (block.kind === "paragraph" && block.continueFromPrevPage) {
        let merged = false;
        for (let k = current!.items.length - 1; k >= 0; k--) {
          const item = current!.items[k];
          if (item.kind === "pagebreak") continue;
          if (item.block.kind === "paragraph") {
            const prevText = item.block.text;
            const mergedInlines =
              item.block.inlines || block.inlines
                ? [
                    ...(item.block.inlines ?? [
                      { kind: "text" as const, text: prevText },
                    ]),
                    ...(block.inlines ?? [
                      { kind: "text" as const, text: block.text },
                    ]),
                  ]
                : undefined;
            item.block = {
              ...item.block,
              text: joinStitchedText(prevText, block.text),
              ...(mergedInlines ? { inlines: mergedInlines } : {}),
              stitchWithNextPage: block.stitchWithNextPage,
            };
            merged = true;
          }
          break;
        }
        if (merged) continue;
        warnings.push({
          code: "STITCH_ORPHAN_PARAGRAPH",
          severity: "warning",
          page: p.page,
          message: `Page ${p.page} paragraph marked continueFromPrevPage=true had no preceding paragraph to merge into; preserved as standalone paragraph`,
        });
      }

      if (block.kind === "table" && block.continueFromPrevPage) {
        let merged = false;
        for (let k = current!.items.length - 1; k >= 0; k--) {
          const item = current!.items[k];
          if (item.kind === "pagebreak") continue;
          if (item.block.kind === "table") {
            item.block = {
              ...item.block,
              body: [...item.block.body, ...block.body],
              foot: block.foot ?? item.block.foot,
              stitchWithNextPage: block.stitchWithNextPage,
            };
            merged = true;
          }
          break;
        }
        if (merged) continue;
        warnings.push({
          code: "STITCH_ORPHAN_TABLE",
          severity: "warning",
          page: p.page,
          message: `Page ${p.page} table marked continueFromPrevPage=true had no preceding table to merge into; preserved as standalone table`,
        });
      }

      current!.items.push({
        kind: "block",
        block: structuredClone(block),
        page: p.page,
      });
    }

    for (const fn of p.footnotes) {
      if (fn.continueFromPrevPage) {
        const target =
          current!.footnotes.find((existing) => existing.id === fn.id) ??
          current!.footnotes[current!.footnotes.length - 1];
        if (target) {
          const prevText = target.text;
          const prevInlines = target.inlines;
          target.text = joinStitchedText(prevText, fn.text);
          if (prevInlines || fn.inlines) {
            target.inlines = [
              ...(prevInlines ?? [{ kind: "text", text: prevText }]),
              ...(fn.inlines ?? [{ kind: "text", text: fn.text }]),
            ];
          }
          continue;
        }
        warnings.push({
          code: "STITCH_ORPHAN_FOOTNOTE",
          severity: "warning",
          page: p.page,
          message: `Page ${p.page} footnote "${fn.id}" marked continueFromPrevPage=true had no preceding footnote; preserved as standalone footnote`,
        });
      }
      current!.footnotes.push({ ...structuredClone(fn), sourcePage: p.page });
    }
  }

  if (buckets.length === 0) {
    buckets.push({
      id: "ch-001",
      href: "EPUB/text/ch-001.xhtml",
      title: spec.metadata.title,
      startPage: 1,
      items: [
        {
          kind: "block",
          page: 1,
          block: { kind: "paragraph", text: spec.metadata.title },
        },
      ],
      footnotes: [],
    });
  }
  return { buckets, warnings };
}

interface NavItem {
  title: string;
  href: string;
  children: NavItem[];
}

function renderNavList(items: NavItem[], fromDoc: string): string {
  return `<ol>${items
    .map(
      (item) =>
        `<li><a href="${e(relative(fromDoc, item.href))}">${e(item.title)}</a>${item.children.length ? renderNavList(item.children, fromDoc) : ""}</li>`,
    )
    .join("")}</ol>`;
}

function validateOrCompileMath(
  compileMath: ReturnType<typeof createMathCompiler>,
  expr: { tex?: string; mathml?: string; alt: string },
  display: boolean,
): string {
  if (expr.mathml) {
    let raw = expr.mathml.trim();
    if (!raw.includes("xmlns=")) {
      raw = raw.replace(
        /^<math\b/,
        `<math xmlns="http://www.w3.org/1998/Math/MathML"`,
      );
    }
    if (!raw.includes("alttext=") && expr.alt) {
      raw = raw.replace(/^<math\b/, `<math alttext="${e(expr.alt)}"`);
    }
    xml(raw, "MathML");
    return raw;
  }
  if (expr.tex) return compileMath(expr.tex, display).mathml;
  fail("MATH_CONVERSION", "Formula block requires either tex or mathml");
}

function mediaTypeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    default:
      fail("UNSUPPORTED_IMAGE", `Unsupported image extension: ${ext}`);
  }
}

export async function renderPdfSpecToEpub(
  specInput: PdfSpec,
  specBaseDir: string,
  options: {
    theme?: BookTheme;
    verification?: PdfVerificationFile;
    renderManifest?: PdfRenderManifest;
  } = {},
): Promise<{
  bytes: Buffer;
  theme: BookTheme;
  spinePaths: string[];
  tocHrefs: string[];
  figureProvenance: NonNullable<
    Extract<PdfBlock, { kind: "figure" }>["provenance"]
  >[];
  warnings: PdfDiagnostic[];
}> {
  const parsed = pdfSpecSchema.safeParse(specInput);
  if (!parsed.success) fail("PDF_SPEC_INVALID", parsed.error.message);
  const spec = parsed.data;
  const theme: BookTheme = options.theme ?? spec.theme ?? "literature";

  // Enforce independent verification contract strictly for pages whose ocrTrust requires it.
  assertPdfSpecVerified(spec, options);

  // Enforce global footnote ID uniqueness and 2D table grid validity.
  const fnCollisionIssues = validateSpecFootnotes(spec.pages, {
    checkPairing: false,
  }).filter((d) => d.severity === "error");
  if (fnCollisionIssues.length > 0) {
    fail(
      fnCollisionIssues[0].code,
      fnCollisionIssues.map((i) => i.message).join("; "),
      fnCollisionIssues,
    );
  }
  const tableIssues = spec.pages.flatMap((p) =>
    p.blocks.flatMap((b) =>
      b.kind === "table" ? validateTableGrid(b, { page: p.page }) : [],
    ),
  );
  if (tableIssues.length > 0) {
    fail(
      tableIssues[0].code,
      tableIssues.map((i) => i.message).join("; "),
      tableIssues,
    );
  }

  const lang = validLanguage(spec.metadata.language)
    ? spec.metadata.language
    : "zh-Hans";
  const isZh = lang.toLowerCase().startsWith("zh");
  const isHant = /hant|tw|hk|mo/i.test(lang);
  const labels = {
    cover: isZh ? "封面" : "Cover",
    titlepage: isZh ? "扉页" : "Title Page",
    colophon: isZh ? (isHant ? "版權頁" : "版权信息") : "Colophon",
    toc: isZh ? (isHant ? "目錄" : "目录") : "Contents",
    notes: isZh ? (isHant ? "註釋" : "注释") : "Notes",
    startOfText: isZh ? "正文" : "Start of text",
  };

  const entries = new Map<string, Uint8Array>();
  const set = (p: string, v: string | Uint8Array) =>
    entries.set(p, typeof v === "string" ? Buffer.from(v) : v);

  const presetStyles = await loadPresetStyles(theme);
  for (const style of presetStyles) set(style.href, style.bytes);

  const manifestItems: {
    id: string;
    href: string;
    mediaType: string;
    properties?: string[];
  }[] = [
    {
      id: "nav",
      href: "nav.xhtml",
      mediaType: "application/xhtml+xml",
      properties: ["nav"],
    },
    ...presetStyles.map((style) => ({
      id: style.id,
      href: `styles/${style.file}`,
      mediaType: style.mediaType,
    })),
  ];

  const imageMap = new Map<
    string,
    { id: string; href: string; mediaType: string }
  >();
  const figureProvenance: NonNullable<
    Extract<PdfBlock, { kind: "figure" }>["provenance"]
  >[] = [];

  const registerImage = async (
    srcPath: string,
    isCover = false,
  ): Promise<{ id: string; href: string; mediaType: string }> => {
    const resolved = path.resolve(specBaseDir, srcPath);
    if (imageMap.has(resolved)) {
      const existing = imageMap.get(resolved)!;
      if (isCover) {
        const mItem = manifestItems.find((m) => m.id === existing.id);
        if (mItem && !mItem.properties?.includes("cover-image")) {
          mItem.properties = [...(mItem.properties ?? []), "cover-image"];
        }
      }
      return existing;
    }
    const bytes = await readSourceFile(resolved);
    let ext = path.extname(resolved).toLowerCase();
    if (!ext) {
      const meta = await sharp(bytes).metadata();
      ext = meta.format === "jpeg" ? ".jpg" : `.${meta.format ?? "png"}`;
    }
    const mediaType = mediaTypeForExt(ext);
    if (mediaType !== "image/svg+xml") {
      const meta = await sharp(bytes).metadata();
      if (!meta.width || !meta.height) {
        fail("IMAGE_INVALID", `Corrupt image asset: ${resolved}`);
      }
    }
    const idx = imageMap.size + 1;
    const id = isCover ? "cover-image" : `img-${String(idx).padStart(3, "0")}`;
    const relHref = `images/${id}${ext === ".jpeg" ? ".jpg" : ext}`;
    const fullHref = `EPUB/${relHref}`;
    set(fullHref, bytes);
    manifestItems.push({
      id,
      href: relHref,
      mediaType,
      ...(isCover ? { properties: ["cover-image"] } : {}),
    });
    const rec = { id, href: fullHref, mediaType };
    imageMap.set(resolved, rec);
    return rec;
  };

  const spineIds: string[] = [];
  const spinePaths: string[] = [];
  const frontStyles = ["styles/base.css", "styles/frontmatter.css"];
  const chapterStyles = ["../styles/base.css", "../styles/theme.css"];

  // ① Cover (EPUB/cover.xhtml)
  let hasCover = false;
  if (spec.frontmatter.coverImage) {
    const coverImg = await registerImage(spec.frontmatter.coverImage, true);
    const coverAlt =
      spec.frontmatter.coverAlt?.trim() ||
      `${spec.metadata.title} — ${spec.metadata.authors.join(", ")}`;
    const coverXhtml = shell(
      spec.metadata.title,
      lang,
      `<main epub:type="cover"><figure><img src="${e(relative("EPUB/cover.xhtml", coverImg.href))}" alt="${e(coverAlt)}"/></figure></main>`,
      frontStyles,
      ' class="cover-document single-column" dir="ltr"',
    );
    xml(coverXhtml, "EPUB/cover.xhtml");
    set("EPUB/cover.xhtml", coverXhtml);
    manifestItems.push({
      id: "cover-page",
      href: "cover.xhtml",
      mediaType: "application/xhtml+xml",
    });
    spineIds.push("cover-page");
    spinePaths.push("EPUB/cover.xhtml");
    hasCover = true;
  }

  // ② Titlepage (EPUB/titlepage.xhtml)
  const includeTitlepage = spec.frontmatter.includeTitlepage !== false;
  if (includeTitlepage) {
    const tp = spec.frontmatter.titlepage ?? {
      title: spec.metadata.title,
      authors: spec.metadata.authors,
      translators: spec.metadata.translators,
      publisher: spec.metadata.publisher,
    };
    const tpLines: string[] = [`<h1>${e(tp.title)}</h1>`];
    if (tp.subtitle?.trim()) {
      tpLines.push(`<p class="chapter-subtitle">${e(tp.subtitle.trim())}</p>`);
    }
    if (tp.authors.length) {
      tpLines.push(
        `<p class="chapter-byline">${e(tp.authors.join(" · "))}</p>`,
      );
    }
    if (tp.translators?.length) {
      const trLabel = isZh
        ? `${tp.translators.join("、")} 译`
        : `Translated by ${tp.translators.join(", ")}`;
      tpLines.push(`<p>${e(trLabel)}</p>`);
    }
    for (const extra of tp.extraLines ?? []) {
      if (extra.trim()) tpLines.push(`<p>${e(extra.trim())}</p>`);
    }
    const pubLine = [tp.publisher, tp.imprint].filter(Boolean).join(" · ");
    if (pubLine) tpLines.push(`<p>${e(pubLine)}</p>`);

    const titlepageXhtml = shell(
      tp.title,
      lang,
      `<main epub:type="frontmatter"><section epub:type="titlepage" class="titlepage-box">${tpLines.join("")}</section></main>`,
      frontStyles,
      ' class="single-column" dir="ltr"',
    );
    xml(titlepageXhtml, "EPUB/titlepage.xhtml");
    set("EPUB/titlepage.xhtml", titlepageXhtml);
    manifestItems.push({
      id: "titlepage",
      href: "titlepage.xhtml",
      mediaType: "application/xhtml+xml",
    });
    spineIds.push("titlepage");
    spinePaths.push("EPUB/titlepage.xhtml");
  }

  // ③ Colophon (EPUB/colophon.xhtml) — strictly right after titlepage, never in TOC
  const col = spec.frontmatter.colophon;
  const shouldEmitColophon =
    spec.frontmatter.includeColophon === true ||
    (spec.frontmatter.includeColophon !== false &&
      Boolean(
        col ||
        spec.metadata.publisher ||
        (spec.metadata.isbn && validIsbn(spec.metadata.isbn)),
      ));
  if (shouldEmitColophon) {
    const colLines: string[] = [`<h1>${e(labels.colophon)}</h1>`];
    colLines.push(`<p>${e(spec.metadata.title)}</p>`);
    if (col?.copyright?.trim()) {
      colLines.push(`<p>${e(col.copyright.trim())}</p>`);
    }
    const pub = col?.publisher?.trim() ?? spec.metadata.publisher?.trim();
    if (pub) colLines.push(`<p>${e(pub)}</p>`);
    if (col?.edition?.trim()) colLines.push(`<p>${e(col.edition.trim())}</p>`);
    const isbnVal = col?.isbn?.trim() ?? spec.metadata.isbn?.trim();
    if (isbnVal) colLines.push(`<p>ISBN ${e(isbnVal)}</p>`);
    for (const line of col?.lines ?? []) {
      if (line.trim()) colLines.push(`<p>${e(line.trim())}</p>`);
    }
    const colophonXhtml = shell(
      labels.colophon,
      lang,
      `<main epub:type="frontmatter"><section epub:type="colophon" class="colophon-box">${colLines.join("")}</section></main>`,
      frontStyles,
      ' class="single-column" dir="ltr"',
    );
    xml(colophonXhtml, "EPUB/colophon.xhtml");
    set("EPUB/colophon.xhtml", colophonXhtml);
    manifestItems.push({
      id: "colophon",
      href: "colophon.xhtml",
      mediaType: "application/xhtml+xml",
    });
    spineIds.push("colophon");
    spinePaths.push("EPUB/colophon.xhtml");
  }

  // ④ Reserve TOC (EPUB/toc.xhtml) slot in spine before body chapters
  manifestItems.push({
    id: "toc-page",
    href: "toc.xhtml",
    mediaType: "application/xhtml+xml",
  });
  spineIds.push("toc-page");
  spinePaths.push("EPUB/toc.xhtml");

  const compileMath = createMathCompiler();
  const { buckets, warnings } = buildChapterBuckets(spec);
  const chapterNavItems: NavItem[] = [];
  const pageListItems: NavItem[] = [];

  for (const bucket of buckets) {
    let hasMath = false;
    let prevHeadingLevel = 1;
    const subHeadings: NavItem[] = [];
    const noteRefsByNoteId = new Map<string, string[]>();
    const noteRefPageById = new Map<string, number>();
    let noteRefSeq = 0;

    const renderInlines = (
      runs: PdfInlineRun[] | undefined,
      fallbackText = "",
      pageNum = bucket.startPage,
    ): string => {
      if (!runs || runs.length === 0) return e(fallbackText);
      return runs
        .map((r) => {
          if (r.kind === "text") {
            let out = e(r.text);
            if (r.code) out = `<code>${out}</code>`;
            if (r.bold) out = `<strong>${out}</strong>`;
            if (r.italic) out = `<em>${out}</em>`;
            if (r.sup) out = `<sup>${out}</sup>`;
            if (r.sub) out = `<sub>${out}</sub>`;
            return out;
          }
          if (r.kind === "ruby") {
            return `<ruby>${e(r.base)}<rt>${e(r.rt)}</rt></ruby>`;
          }
          if (r.kind === "math-inline") {
            hasMath = true;
            return validateOrCompileMath(compileMath, r, false);
          }
          noteRefSeq++;
          const refId = `fnref-${bucket.id}-${r.id}-${noteRefSeq}`;
          const list = noteRefsByNoteId.get(r.id) ?? [];
          list.push(refId);
          noteRefsByNoteId.set(r.id, list);
          if (!noteRefPageById.has(r.id)) noteRefPageById.set(r.id, pageNum);
          return `<a epub:type="noteref" role="doc-noteref" id="${e(refId)}" href="#${e(`fn-${bucket.id}-${r.id}`)}"><sup>${e(r.label)}</sup></a>`;
        })
        .join("");
    };

    const renderCell = (
      cell: PdfTableCell,
      defaultHeader: boolean,
      pageNum: number,
    ): string => {
      const isHeader = cell.header ?? defaultHeader;
      const tag = isHeader ? "th" : "td";
      const scopeAttr = isHeader ? ` scope="${e(cell.scope ?? "col")}"` : "";
      const rsAttr =
        cell.rowspan && cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "";
      const csAttr =
        cell.colspan && cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "";
      const alignClass = cell.align ? ` class="align-${cell.align}"` : "";
      const inner = renderInlines(cell.inlines, cell.text ?? "", pageNum);
      return `<${tag}${scopeAttr}${rsAttr}${csAttr}${alignClass}>${inner}</${tag}>`;
    };

    const htmlParts: string[] = [
      `<h1 id="${e(bucket.id)}-title">${e(bucket.title)}</h1>`,
    ];
    if (bucket.subtitle?.trim()) {
      htmlParts.push(
        `<p class="chapter-subtitle">${e(bucket.subtitle.trim())}</p>`,
      );
    }
    if (bucket.byline?.trim()) {
      htmlParts.push(
        `<p class="chapter-byline">${e(bucket.byline.trim())}</p>`,
      );
    }

    let subHeadingIndex = 0;
    let prevBlockKind: string | undefined = "heading";
    for (const entry of bucket.items) {
      if (entry.kind === "pagebreak") {
        const pid = `page-${entry.page}`;
        htmlParts.push(
          `<span class="pagebreak" id="${pid}" epub:type="pagebreak" role="doc-pagebreak" aria-label="${entry.page}"/>`,
        );
        pageListItems.push({
          title: String(entry.page),
          href: `${bucket.href}#${pid}`,
          children: [],
        });
        continue;
      }

      const b = entry.block;
      switch (b.kind) {
        case "heading": {
          subHeadingIndex++;
          const clampedLevel = Math.min(
            6,
            Math.max(2, Math.min(b.level, prevHeadingLevel + 1)),
          );
          prevHeadingLevel = clampedLevel;
          const hid = b.id
            ? `${bucket.id}-${b.id}`
            : `${bucket.id}-sec-${subHeadingIndex}`;
          htmlParts.push(
            `<h${clampedLevel} id="${e(hid)}">${renderInlines(b.inlines, b.text, entry.page)}</h${clampedLevel}>`,
          );
          if (clampedLevel === 2) {
            subHeadings.push({
              title: b.text || `Section ${subHeadingIndex}`,
              href: `${bucket.href}#${hid}`,
              children: [],
            });
          }
          if (b.subtitle?.trim()) {
            htmlParts.push(
              `<p class="chapter-subtitle">${e(b.subtitle.trim())}</p>`,
            );
          }
          if (b.byline?.trim()) {
            htmlParts.push(
              `<p class="chapter-byline">${e(b.byline.trim())}</p>`,
            );
          }
          break;
        }
        case "paragraph": {
          const classes: string[] = [];
          const isBodyVoice = !b.voice || b.voice === "body";
          if (!isBodyVoice) classes.push(`voice-${b.voice}`);
          else if (isOpeningParagraphAfter(prevBlockKind))
            classes.push("opening");
          const gapClass = paragraphGapClass(b.gapBefore);
          if (gapClass) classes.push(gapClass);
          const alignClass = paragraphAlignClass(b.align);
          if (alignClass) classes.push(alignClass);
          const clsAttr = classes.length ? ` class="${classes.join(" ")}"` : "";
          if (b.voice === "quote") {
            htmlParts.push(
              `<blockquote${clsAttr}><p>${renderInlines(b.inlines, b.text, entry.page)}</p></blockquote>`,
            );
          } else {
            htmlParts.push(
              `<p${clsAttr}>${renderInlines(b.inlines, b.text, entry.page)}</p>`,
            );
          }
          break;
        }
        case "math-block": {
          hasMath = true;
          const mml = validateOrCompileMath(compileMath, b, true);
          htmlParts.push(
            `<div class="math-display" tabindex="0" role="region" aria-label="${e(b.alt || "Mathematical expression")}">${mml}</div>`,
          );
          break;
        }
        case "table": {
          const captionText = b.caption.trim() || "Table";
          let headRows = b.head ?? [];
          let bodyRows = b.body;
          const hasAnyHeader =
            headRows.length > 0 ||
            bodyRows.some((r) => r.some((c) => c.header));
          if (!hasAnyHeader && bodyRows.length > 0) {
            headRows = [bodyRows[0]];
            bodyRows = bodyRows.slice(1);
          }
          const thead = headRows.length
            ? `<thead>${headRows.map((row) => `<tr>${row.map((c) => renderCell(c, true, entry.page)).join("")}</tr>`).join("")}</thead>`
            : "";
          const tbody = `<tbody>${(bodyRows.length ? bodyRows : [[]])
            .map(
              (row) =>
                `<tr>${row.map((c) => renderCell(c, false, entry.page)).join("")}</tr>`,
            )
            .join("")}</tbody>`;
          const tfoot = b.foot?.length
            ? `<tfoot>${b.foot.map((row) => `<tr>${row.map((c) => renderCell(c, false, entry.page)).join("")}</tr>`).join("")}</tfoot>`
            : "";
          htmlParts.push(
            `<div class="table-container" tabindex="0" role="region" aria-label="${e(captionText)}"><table><caption>${e(captionText)}</caption>${thead}${tbody}${tfoot}</table></div>`,
          );
          break;
        }
        case "figure": {
          const imgRec = await registerImage(b.src, false);
          if (b.provenance) figureProvenance.push(b.provenance);
          const isDecorative = Boolean(b.decorative) || !b.alt.trim();
          const altText = isDecorative ? "" : b.alt.trim();
          const roleAttr = isDecorative ? ' role="presentation"' : "";
          const capHtml = b.caption?.trim()
            ? `<figcaption>${e(b.caption.trim())}</figcaption>`
            : "";
          htmlParts.push(
            `<figure><img src="${e(relative(bucket.href, imgRec.href))}" alt="${e(altText)}"${roleAttr}/>${capHtml}</figure>`,
          );
          break;
        }
        case "list": {
          const listTag = b.ordered ? "ol" : "ul";
          const liHtml = b.items
            .map((item) =>
              typeof item === "string"
                ? `<li>${e(item)}</li>`
                : `<li>${renderInlines(item.inlines, item.text, entry.page)}</li>`,
            )
            .join("");
          htmlParts.push(`<${listTag}>${liHtml}</${listTag}>`);
          break;
        }
        case "hr":
          htmlParts.push("<hr/>");
          break;
      }
      prevBlockKind = b.kind;
    }

    const definedNoteIds = new Set(bucket.footnotes.map((fn) => fn.id));
    for (const [refNoteId, refPage] of noteRefPageById.entries()) {
      if (!definedNoteIds.has(refNoteId)) {
        fail(
          "FOOTNOTE_MISSING",
          `Chapter "${bucket.title}" (page ${refPage}) references missing footnote "${refNoteId}"`,
          { chapter: bucket.id, page: refPage, footnoteId: refNoteId },
        );
      }
    }

    if (bucket.footnotes.length > 0) {
      const notesHeadingLevel = Math.min(prevHeadingLevel + 1, 2);
      htmlParts.push(
        `<section class="footnotes" epub:type="footnotes"><h${notesHeadingLevel}>${e(labels.notes)}</h${notesHeadingLevel}>`,
      );
      for (const fn of bucket.footnotes) {
        const refs = noteRefsByNoteId.get(fn.id);
        if (!refs || refs.length === 0) {
          fail(
            "FOOTNOTE_UNREFERENCED",
            `Footnote "${fn.id}" (label "${fn.label}") on page ${fn.sourcePage} has no matching in-text noteref; return page ${fn.sourcePage} to its worker instead of fabricating an anchor`,
            {
              chapter: bucket.id,
              page: fn.sourcePage,
              footnoteId: fn.id,
              label: fn.label,
            },
          );
        }
        const backlinks = refs
          .map(
            (ref, idx) =>
              `<a role="doc-backlink" href="#${e(ref)}">↩${refs.length > 1 ? String(idx + 1) : ""}</a>`,
          )
          .join(" ");
        htmlParts.push(
          `<aside epub:type="footnote" role="doc-footnote" id="${e(`fn-${bucket.id}-${fn.id}`)}"><p>${renderInlines(fn.inlines, fn.text, fn.sourcePage)} ${backlinks}</p></aside>`,
        );
      }
      htmlParts.push("</section>");
    }

    const chapterXhtml = shell(
      bucket.title,
      lang,
      `<main epub:type="bodymatter">${htmlParts.join("\n")}</main>`,
      chapterStyles,
      ' class="single-column" dir="ltr"',
    );
    xml(chapterXhtml, bucket.href);
    set(bucket.href, chapterXhtml);
    manifestItems.push({
      id: bucket.id,
      href: relative("EPUB/package.opf", bucket.href),
      mediaType: "application/xhtml+xml",
      ...(hasMath ? { properties: ["mathml"] } : {}),
    });
    spineIds.push(bucket.id);
    spinePaths.push(bucket.href);
    chapterNavItems.push({
      title: bucket.title,
      href: bucket.href,
      children: subHeadings,
    });
  }

  // ④ Render EPUB/toc.xhtml & EPUB/nav.xhtml — strictly excluding colophon.xhtml
  const visibleTocTree: NavItem[] = [...chapterNavItems];
  const navDocTree: NavItem[] = [
    ...(hasCover
      ? [{ title: labels.cover, href: "EPUB/cover.xhtml", children: [] }]
      : []),
    ...(includeTitlepage
      ? [
          {
            title: labels.titlepage,
            href: "EPUB/titlepage.xhtml",
            children: [],
          },
        ]
      : []),
    ...chapterNavItems,
  ];

  const tocPageXhtml = shell(
    labels.toc,
    lang,
    `<main epub:type="frontmatter"><nav epub:type="toc" role="doc-toc" aria-labelledby="toc-heading"><h1 id="toc-heading">${e(labels.toc)}</h1>${renderNavList(visibleTocTree, "EPUB/toc.xhtml")}</nav></main>`,
    frontStyles,
    ' class="single-column" dir="ltr"',
  );
  xml(tocPageXhtml, "EPUB/toc.xhtml");
  set("EPUB/toc.xhtml", tocPageXhtml);

  const landmarks: string[] = [];
  if (hasCover) {
    landmarks.push(
      `<li><a epub:type="cover" href="cover.xhtml">${e(labels.cover)}</a></li>`,
    );
  }
  if (includeTitlepage) {
    landmarks.push(
      `<li><a epub:type="titlepage" href="titlepage.xhtml">${e(labels.titlepage)}</a></li>`,
    );
  }
  landmarks.push(
    `<li><a epub:type="toc" href="toc.xhtml">${e(labels.toc)}</a></li>`,
    `<li><a epub:type="bodymatter" href="${e(relative("EPUB/nav.xhtml", buckets[0].href))}">${e(labels.startOfText)}</a></li>`,
  );

  const navXhtml = shell(
    labels.toc,
    lang,
    `<nav epub:type="toc" role="doc-toc" aria-label="${e(labels.toc)}"><h1>${e(labels.toc)}</h1>${renderNavList(navDocTree, "EPUB/nav.xhtml")}</nav><nav epub:type="landmarks" aria-label="Landmarks"><h2>Landmarks</h2><ol>${landmarks.join("")}</ol></nav>${pageListItems.length ? `<nav epub:type="page-list" role="doc-pagelist" aria-label="Pages"><h2>Pages</h2>${renderNavList(pageListItems, "EPUB/nav.xhtml")}</nav>` : ""}`,
    frontStyles,
    ' class="single-column" dir="ltr"',
  );
  xml(navXhtml, "EPUB/nav.xhtml");
  set("EPUB/nav.xhtml", navXhtml);

  const cleanIsbn =
    spec.metadata.isbn && validIsbn(spec.metadata.isbn)
      ? spec.metadata.isbn.replace(/[-\s]/g, "")
      : undefined;
  const primaryId = cleanIsbn
    ? `urn:isbn:${cleanIsbn}`
    : `urn:uuid:${sha256(spec.source.sha256).slice(0, 8)}-${sha256(spec.source.sha256).slice(8, 12)}-4${sha256(spec.source.sha256).slice(13, 16)}-8${sha256(spec.source.sha256).slice(17, 20)}-${sha256(spec.source.sha256).slice(20, 32)}`;
  const modified =
    spec.metadata.modified &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(spec.metadata.modified)
      ? spec.metadata.modified
      : "2000-01-01T00:00:00Z";
  const hasVisual = imageMap.size > 0;
  const hasMathGlobal = manifestItems.some((m) =>
    m.properties?.includes("mathml"),
  );

  const metaXml = [
    `<dc:identifier id="publication-id">${e(primaryId)}</dc:identifier>`,
    ...(cleanIsbn
      ? [
          `<dc:identifier id="isbn-id">${e(cleanIsbn)}</dc:identifier>`,
          `<meta refines="#isbn-id" property="identifier-type" scheme="onix:codelist5">15</meta>`,
        ]
      : []),
    `<dc:title>${e(spec.metadata.title)}</dc:title>`,
    `<dc:language>${e(lang)}</dc:language>`,
    ...(spec.metadata.authors.length ? spec.metadata.authors : ["Unknown"]).map(
      (a) => `<dc:creator>${e(a)}</dc:creator>`,
    ),
    ...(spec.metadata.translators ?? []).map(
      (t, i) =>
        `<dc:contributor id="trl-${i + 1}">${e(t)}</dc:contributor><meta refines="#trl-${i + 1}" property="role" scheme="marc:relators">trl</meta>`,
    ),
    ...(spec.metadata.publisher
      ? [`<dc:publisher>${e(spec.metadata.publisher)}</dc:publisher>`]
      : []),
    ...(spec.metadata.description.trim()
      ? [
          `<dc:description>${e(spec.metadata.description.trim())}</dc:description>`,
        ]
      : []),
    ...spec.metadata.tags.map((t) => `<dc:subject>${e(t)}</dc:subject>`),
    `<meta property="dcterms:modified">${modified}</meta>`,
    `<meta property="rendition:layout">reflowable</meta>`,
    `<meta property="rendition:spread">none</meta>`,
    `<meta property="rendition:orientation">auto</meta>`,
    `<meta property="schema:accessMode">textual</meta>`,
    ...(hasVisual ? [`<meta property="schema:accessMode">visual</meta>`] : []),
    `<meta property="schema:accessModeSufficient">textual</meta>`,
    `<meta property="schema:accessibilityFeature">structuralNavigation</meta>`,
    `<meta property="schema:accessibilityFeature">tableOfContents</meta>`,
    ...(pageListItems.length
      ? [`<meta property="schema:accessibilityFeature">pageNavigation</meta>`]
      : []),
    ...(hasMathGlobal
      ? [`<meta property="schema:accessibilityFeature">MathML</meta>`]
      : []),
    ...(hasVisual
      ? [`<meta property="schema:accessibilityFeature">alternativeText</meta>`]
      : []),
    `<meta property="schema:accessibilityHazard">none</meta>`,
    `<meta property="schema:accessibilitySummary">Reflowable single-column horizontal EPUB 3.3 reconstructed from PDF with semantic structure, navigation, and non-certified automated checks.</meta>`,
  ].join("");

  const manifestXml = manifestItems
    .map(
      (m) =>
        `<item id="${e(m.id)}" href="${e(m.href)}" media-type="${e(m.mediaType)}"${m.properties?.length ? ` properties="${m.properties.join(" ")}"` : ""}/>`,
    )
    .join("");
  const spineXml = spineIds
    .map(
      (id) => `<itemref idref="${e(id)}" properties="rendition:spread-none"/>`,
    )
    .join("");

  const opf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="${NS.opf}" xmlns:dc="${NS.dc}" version="3.0" unique-identifier="publication-id" dir="ltr" xml:lang="${e(lang)}" prefix="rendition: http://www.idpf.org/vocab/rendition/# schema: http://schema.org/"><metadata>${metaXml}</metadata><manifest>${manifestXml}</manifest><spine page-progression-direction="ltr">${spineXml}</spine></package>\n`;
  xml(opf, "EPUB/package.opf");
  set("EPUB/package.opf", opf);
  set(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="${NS.container}"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n`,
  );
  set("mimetype", "application/epub+zip");

  const collectHrefs = (nodes: NavItem[]): string[] =>
    nodes.flatMap((n) => [n.href, ...collectHrefs(n.children)]);
  const tocHrefs = [
    ...new Set([...collectHrefs(visibleTocTree), ...collectHrefs(navDocTree)]),
  ];

  return {
    bytes: pack(entries, 946684800),
    theme,
    spinePaths,
    tocHrefs,
    figureProvenance,
    warnings,
  };
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
      const raw = await readJson<unknown>(path.resolve(input));
      return pdfRenderManifestSchema.parse(raw);
    }
    return pdfRenderManifestSchema.parse(input);
  }
  if (fallbackPath && (await exists(fallbackPath))) {
    const raw = await readJson<unknown>(fallbackPath);
    return pdfRenderManifestSchema.parse(raw);
  }
  return undefined;
}

export async function buildEpubFromPdfSpec(
  specFileOrObject: string | PdfSpec,
  outputEpubFile: string,
  options: {
    theme?: BookTheme;
    verification?: string | PdfVerificationFile;
    renderManifest?: string | PdfRenderManifest;
    release?: boolean;
    to?: ConversionTarget;
    online?: boolean;
    reports?: string;
    signal?: AbortSignal;
  } = {},
) {
  checkAbort(options.signal);
  const output = path.resolve(outputEpubFile);
  if (path.extname(output).toLowerCase() !== ".epub") {
    fail("UNSUPPORTED_FORMAT", "Output path must use the .epub extension");
  }
  if (await exists(output)) {
    fail("OUTPUT_EXISTS", `Refusing to overwrite existing output: ${output}`);
  }

  let spec: PdfSpec;
  let specBaseDir: string;
  if (typeof specFileOrObject === "string") {
    const resolvedSpec = path.resolve(specFileOrObject);
    specBaseDir = path.dirname(resolvedSpec);
    const raw = await readJson<unknown>(resolvedSpec);
    const parsed = pdfSpecSchema.safeParse(raw);
    if (!parsed.success) fail("PDF_SPEC_INVALID", parsed.error.message);
    spec = parsed.data;
  } else {
    specBaseDir = path.dirname(path.resolve(specFileOrObject.source.path));
    const parsed = pdfSpecSchema.safeParse(specFileOrObject);
    if (!parsed.success) fail("PDF_SPEC_INVALID", parsed.error.message);
    spec = parsed.data;
  }

  const [{ verification, verificationFileSha256 }, renderManifest] =
    await Promise.all([
      resolveOptionalVerification(options.verification),
      resolveOptionalRenderManifest(
        options.renderManifest,
        spec.renderManifestPath,
      ),
    ]);

  const firstBuild = await renderPdfSpecToEpub(spec, specBaseDir, {
    theme: options.theme,
    verification,
    renderManifest,
  });
  const secondBuild = await renderPdfSpecToEpub(spec, specBaseDir, {
    theme: options.theme,
    verification,
    renderManifest,
  });
  if (!firstBuild.bytes.equals(secondBuild.bytes)) {
    fail(
      "NONDETERMINISTIC_BUILD",
      "Repeated PDF-to-EPUB builds produced different bytes",
    );
  }
  if (firstBuild.tocHrefs.some((h) => h.includes("colophon.xhtml"))) {
    fail(
      "COLOPHON_IN_TOC",
      "Colophon must never be included in TOC navigation",
    );
  }

  const reports = path.resolve(options.reports ?? `${output}.reports`);
  await fs.mkdir(reports, { recursive: true });
  const runId = randomUUID();
  const candidate = `${output}.${runId}.candidate.epub`;

  const pagesRequiringVerification = spec.pages
    .filter((p) => pageRequiresOcrVerification(p))
    .map((p) => p.page);
  const verificationEvidence = {
    pagesRequiringVerification,
    ...(verification
      ? {
          verifierId: verification.verifierId,
          verifiedAt: verification.verifiedAt,
        }
      : {}),
    ...(verificationFileSha256 ? { verificationFileSha256 } : {}),
  };

  try {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(candidate, firstBuild.bytes, { flag: "wx" });

    const internal = validateInternal(firstBuild.bytes);
    await json(path.join(reports, "diagnostics.json"), internal);
    if (internal.status !== "pass") {
      fail(
        "PDF_EPUB_VALIDATION",
        "Generated EPUB failed internal EPUB 3.3 policy checks",
        internal,
      );
    }

    const validation = await checkEpubConformance(candidate, {
      reports,
      signal: options.signal,
    });
    if (validation.status !== "pass") {
      fail(
        "PDF_EPUB_VALIDATION",
        "Generated EPUB failed EPUBCheck 3.3 conformance",
        validation,
      );
    }

    const frontmatterSpine = firstBuild.spinePaths.filter((p) =>
      [
        "EPUB/cover.xhtml",
        "EPUB/titlepage.xhtml",
        "EPUB/colophon.xhtml",
        "EPUB/toc.xhtml",
      ].includes(p),
    );

    if (options.to) {
      const converted = await convertEpub(candidate, {
        target: options.to,
        output,
        online: options.online,
        signal: options.signal,
      });
      const result = {
        status: "pass" as const,
        operation: "pdf-to-epub" as const,
        purpose: "publication-release" as const,
        theme: firstBuild.theme,
        classification: spec.source.classification,
        source: spec.source.path,
        sourceSha256: spec.source.sha256,
        output,
        outputSha256: converted.artifact.sha256,
        frontmatterSpine,
        tocHrefs: firstBuild.tocHrefs,
        colophonExcludedFromToc: true as const,
        figureProvenance: firstBuild.figureProvenance,
        verification: verificationEvidence,
        warnings: firstBuild.warnings,
        metadata: spec.metadata,
        validation: converted.gates.validation,
        reading: converted.gates.qa,
        ace: converted.gates.ace,
        platformLint: {
          appleBooks: converted.gates.apple,
          kindle: converted.gates.kindle,
        },
        chineseConversion: converted,
        reproducible:
          converted.reproducibility.firstSha256 ===
          converted.reproducibility.secondSha256,
        publicationReady: true,
        releaseGates: "pass" as const,
        reports,
      };
      await json(path.join(reports, "pdf-import.json"), result);
      return result;
    }

    let reading: unknown = { status: "not-run" };
    let qaReport: unknown;
    let platformLint: unknown;

    if (options.release) {
      qaReport = await runQa(candidate, { signal: options.signal });
      if ((qaReport as { status?: string }).status !== "pass") {
        fail("PDF_EPUB_QA", "Generated EPUB failed full browser QA", qaReport);
      }
      const inspected = inspectBytes(firstBuild.bytes, true);
      platformLint = {
        appleBooks: await compatibilityLint(inspected, "apple-books"),
        kindle: await compatibilityLint(inspected, "kindle"),
      };
    } else {
      try {
        const rq = await readingQa(
          inspectBytes(firstBuild.bytes, true),
          path.join(reports, "reading"),
          options.signal,
        );
        if (rq.status !== "pass") {
          fail(
            "PDF_EPUB_READING",
            "Generated EPUB failed browser reading verification",
            rq,
          );
        }
        reading = rq;
      } catch (err) {
        if ((err as { code?: string }).code === "ENVIRONMENT_ERROR") {
          reading = { status: "not-run", reason: (err as Error).message };
        } else {
          throw err;
        }
      }
    }

    checkAbort(options.signal);
    await fs.link(candidate, output);
    const outputSha256 = sha256(firstBuild.bytes);
    const result = {
      status: "pass" as const,
      operation: "pdf-to-epub" as const,
      purpose: options.release ? "publication-release" : "format-conversion",
      theme: firstBuild.theme,
      classification: spec.source.classification,
      source: spec.source.path,
      sourceSha256: spec.source.sha256,
      output,
      outputSha256,
      frontmatterSpine,
      tocHrefs: firstBuild.tocHrefs,
      colophonExcludedFromToc: true as const,
      figureProvenance: firstBuild.figureProvenance,
      verification: verificationEvidence,
      warnings: firstBuild.warnings,
      metadata: spec.metadata,
      validation,
      reading: options.release ? qaReport : reading,
      ...(platformLint ? { platformLint } : {}),
      reproducible: true,
      publicationReady: Boolean(options.release),
      releaseGates: options.release ? "pass" : "not-run",
      reports,
    };
    await json(path.join(reports, "pdf-import.json"), result);
    return result;
  } finally {
    await fs.rm(candidate, { force: true });
  }
}

export async function convertPdfToEpub(
  pdfFile: string,
  outputEpubFile: string,
  options: {
    theme?: BookTheme;
    spec?: string;
    verification?: string;
    renderManifest?: string;
    release?: boolean;
    to?: ConversionTarget;
    online?: boolean;
    reports?: string;
    signal?: AbortSignal;
  } = {},
) {
  checkAbort(options.signal);
  if (!isPdfPath(pdfFile)) {
    fail("UNSUPPORTED_FORMAT", "Choose a .pdf source file");
  }
  const resolvedPdf = path.resolve(pdfFile);
  const sourceBytes = await readSourceFile(resolvedPdf);
  const sourceSha256 = sha256(sourceBytes);

  if (options.spec) {
    const specObj = await readJson<unknown>(path.resolve(options.spec));
    const parsed = pdfSpecSchema.safeParse(specObj);
    if (!parsed.success) fail("PDF_SPEC_INVALID", parsed.error.message);
    if (parsed.data.source.sha256 !== sourceSha256) {
      fail(
        "SOURCE_HASH_MISMATCH",
        `Source PDF SHA-256 (${sourceSha256}) does not match --spec (${parsed.data.source.sha256})`,
      );
    }
    const built = await buildEpubFromPdfSpec(options.spec, outputEpubFile, {
      theme: options.theme,
      verification: options.verification,
      renderManifest: options.renderManifest,
      release: options.release,
      to: options.to,
      online: options.online,
      reports: options.reports,
      signal: options.signal,
    });
    if (sha256(await readSourceFile(resolvedPdf)) !== sourceSha256) {
      fail("SOURCE_CHANGED", "Source PDF changed during conversion");
    }
    return built;
  }

  const tmpAssets = await fs.mkdtemp(
    path.join(os.tmpdir(), "quillbind-pdf-assets-"),
  );
  try {
    const { inspection, pages } = await extractPdfRawPages(resolvedPdf, {
      assetsDir: tmpAssets,
      signal: options.signal,
    });
    stripRunningHeadersAndFooters(pages);
    stitchPdfPagesInPlace(pages);

    const sampleText = pages
      .slice(0, 5)
      .flatMap((p) => p.blocks.map(extractBlockPlainText))
      .join(" ");
    const title =
      inspection.info.Title?.trim() ||
      path.basename(resolvedPdf, path.extname(resolvedPdf));
    const rawAuthor = inspection.info.Author?.trim();
    const authors = rawAuthor
      ? rawAuthor
          .split(/[;,；、]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : ["Unknown"];
    const lang = guessLanguage(`${title} ${sampleText}`);

    const autoSpec: PdfSpec = {
      schemaVersion: PDF_SPEC_SCHEMA_VERSION,
      kind: "quillbind-pdf-spec",
      ...(options.theme ? { theme: options.theme } : {}),
      source: {
        path: inspection.path,
        sha256: inspection.sha256,
        pdfVersion: inspection.pdfVersion,
        pageCount: inspection.pageCount,
        classification: inspection.classification,
      },
      metadata: {
        title,
        authors,
        language: lang,
        description: inspection.info.Subject?.trim() ?? "",
        tags: [],
        modified: "2000-01-01T00:00:00Z",
      },
      frontmatter: {
        titlepage: { title, authors },
        includeTitlepage: true,
        includeColophon: false,
      },
      outline: inspection.outline,
      shards: inspection.shards,
      pages,
    };

    const built = await buildEpubFromPdfSpec(autoSpec, outputEpubFile, {
      theme: options.theme,
      verification: options.verification,
      renderManifest: options.renderManifest,
      release: options.release,
      to: options.to,
      online: options.online,
      reports: options.reports,
      signal: options.signal,
    });
    if (sha256(await readSourceFile(resolvedPdf)) !== sourceSha256) {
      fail("SOURCE_CHANGED", "Source PDF changed during conversion");
    }
    return built;
  } finally {
    await fs.rm(tmpAssets, { recursive: true, force: true });
  }
}
