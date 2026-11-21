import fs from "node:fs/promises";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import { parseYaml } from "./config.js";
import { fail } from "./errors.js";
import { exists } from "./files.js";
import { sha256 } from "./hash.js";
import { json, readJson, stable } from "./json.js";
import {
  detectLineGeometryFromImage,
  extractPdfRawPages,
} from "./pdf-binary.js";
import {
  PDF_SPEC_SCHEMA_VERSION,
  pageRequiresOcrVerification,
  pdfBlockSchema,
  pdfPageFileSchema,
  pdfRenderManifestSchema,
  pdfShardFileSchema,
  pdfSpecSchema,
  pdfVerificationFileSchema,
  type PdfBlock,
  type PdfCheckReport,
  type PdfDiagnostic,
  type PdfFootnoteItem,
  type PdfInlineRun,
  type PdfPageFile,
  type PdfPageQaSignal,
  type PdfPageVerificationRecord,
  type PdfRenderManifest,
  type PdfShardFile,
  type PdfSpec,
  type PdfSpecPage,
  type PdfTableCell,
  type PdfUnresolvedItem,
  type PdfVerificationFile,
} from "./pdf-model.js";

const SENTENCE_END_RE = /[。！？；.!?:：”"’'」』）)】》\]]$/u;

// High-frequency unambiguous Simplified-only vs Traditional-only characters for mixing alerts.
const SIMPLIFIED_MARKERS =
  /[这国为说时会发后里书学经过对还进来们无与体点东风见开马门长车]/gu;
const TRADITIONAL_MARKERS =
  /[這國為說時會發後裡書學經過對還進來們無與體點東風見開馬門長車]/gu;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  depth?: number;
  url?: string;
  alt?: string;
  identifier?: string;
  name?: string;
  label?: string;
  attributes?: Record<string, string>;
  ordered?: boolean;
  align?: ("left" | "center" | "right" | null)[];
  position?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

const pageMarkdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkDirective)
  .use(remarkCjkFriendly)
  .use(remarkCjkStrikethrough);

function mdPlain(node: MdNode): string {
  return node.value ?? node.children?.map(mdPlain).join("") ?? "";
}

/** Canonical content hash of a page's transcribed blocks and footnotes for verification binding. */
export function computePageContentSha256(
  page: Pick<PdfSpecPage, "page" | "blocks" | "footnotes">,
): string {
  return sha256(
    stable({
      page: page.page,
      blocks: page.blocks,
      footnotes: page.footnotes,
    }),
  );
}

export function extractBlockPlainText(block: PdfBlock): string {
  switch (block.kind) {
    case "heading":
    case "paragraph": {
      if (block.inlines && block.inlines.length > 0) {
        return block.inlines
          .map((r) => {
            if (r.kind === "text") return r.text;
            if (r.kind === "ruby") return r.base;
            if (r.kind === "math-inline") return r.alt || r.tex || "";
            return r.label;
          })
          .join("");
      }
      return block.text;
    }
    case "math-block":
      return block.alt || block.tex || "";
    case "table": {
      const lines: string[] = [];
      if (block.caption.trim()) lines.push(block.caption.trim());
      for (const row of [
        ...(block.head ?? []),
        ...block.body,
        ...(block.foot ?? []),
      ]) {
        const text = row
          .map((c) =>
            c.inlines?.length
              ? c.inlines
                  .map((r) =>
                    r.kind === "text"
                      ? r.text
                      : r.kind === "ruby"
                        ? r.base
                        : "",
                  )
                  .join("")
              : (c.text ?? ""),
          )
          .join(" ")
          .trim();
        if (text) lines.push(text);
      }
      return lines.join("\n");
    }
    case "figure":
      return block.caption?.trim() ?? "";
    case "list":
      return block.items
        .map((item) => (typeof item === "string" ? item : item.text))
        .filter(Boolean)
        .join("\n");
    case "hr":
      return "";
  }
}

export function collectPageTranscribedLines(page: PdfSpecPage): string[] {
  const lines: string[] = [];
  for (const b of page.blocks) {
    const t = extractBlockPlainText(b);
    for (const part of t.split(/\r?\n/u)) {
      const trimmed = part.trim();
      if (trimmed) lines.push(trimmed);
    }
  }
  for (const fn of page.footnotes) {
    const fnText = fn.inlines?.length
      ? fn.inlines
          .map((r) =>
            r.kind === "text" ? r.text : r.kind === "ruby" ? r.base : "",
          )
          .join("")
          .trim()
      : fn.text.trim();
    if (fnText) lines.push(`${fn.label} ${fnText}`);
  }
  return lines;
}

/** Validate 2D table grid occupancy accounting for rowspan and colspan across head/body/foot. */
export function validateTableGrid(
  table: Extract<PdfBlock, { kind: "table" }>,
  context: { page?: number; file?: string; line?: number } = {},
): PdfDiagnostic[] {
  const issues: PdfDiagnostic[] = [];
  const sections: { name: "head" | "body" | "foot"; rows: PdfTableCell[][] }[] =
    [];
  if (table.head?.length) sections.push({ name: "head", rows: table.head });
  sections.push({ name: "body", rows: table.body });
  if (table.foot?.length) sections.push({ name: "foot", rows: table.foot });

  const sectionCols: { name: string; cols: number }[] = [];
  for (const sec of sections) {
    if (sec.rows.length === 0) continue;
    const grid: boolean[][] = Array.from({ length: sec.rows.length }, () => []);
    const rowWidths: number[] = [];

    for (let r = 0; r < sec.rows.length; r++) {
      let c = 0;
      for (const cell of sec.rows[r]) {
        while (grid[r][c]) c++;
        const rs = cell.rowspan ?? 1;
        const cs = cell.colspan ?? 1;
        if (r + rs > sec.rows.length) {
          issues.push({
            code: "PDF_TABLE_GRID_INVALID",
            severity: "error",
            ...context,
            message: `Table "${table.caption}" ${sec.name} row ${r + 1} has rowspan=${rs} overflowing ${sec.rows.length} rows`,
          });
        }
        for (let dr = 0; dr < rs && r + dr < sec.rows.length; dr++) {
          for (let dc = 0; dc < cs; dc++) {
            if (grid[r + dr][c + dc]) {
              issues.push({
                code: "PDF_TABLE_GRID_INVALID",
                severity: "error",
                ...context,
                message: `Table "${table.caption}" ${sec.name} row ${r + 1} col ${c + dc + 1} overlaps a previous rowspan/colspan`,
              });
            }
            grid[r + dr][c + dc] = true;
          }
        }
        c += cs;
      }
      rowWidths.push(grid[r].length);
    }

    const expectedCols = rowWidths[0] ?? 0;
    for (let r = 1; r < rowWidths.length; r++) {
      if (rowWidths[r] !== expectedCols) {
        issues.push({
          code: "PDF_TABLE_GRID_INVALID",
          severity: "error",
          ...context,
          message: `Table "${table.caption}" ${sec.name} row ${r + 1} has ${rowWidths[r]} effective columns, expected ${expectedCols}`,
        });
      }
    }
    sectionCols.push({ name: sec.name, cols: expectedCols });
  }

  if (sectionCols.length > 1) {
    const expected = sectionCols[0].cols;
    for (let i = 1; i < sectionCols.length; i++) {
      if (sectionCols[i].cols !== expected) {
        issues.push({
          code: "PDF_TABLE_GRID_INVALID",
          severity: "error",
          ...context,
          message: `Table "${table.caption}" ${sectionCols[i].name} has ${sectionCols[i].cols} columns, mismatching ${sectionCols[0].name} (${expected})`,
        });
      }
    }
  }
  return issues;
}

function collectNoteRefsInRuns(
  runs: PdfInlineRun[] | undefined,
  target: string[],
): void {
  if (!runs) return;
  for (const r of runs) {
    if (r.kind === "noteref") target.push(r.id);
  }
}

export function collectNoteRefsInPage(page: PdfSpecPage): string[] {
  const ids: string[] = [];
  for (const b of page.blocks) {
    if (b.kind === "heading" || b.kind === "paragraph") {
      collectNoteRefsInRuns(b.inlines, ids);
    } else if (b.kind === "table") {
      for (const row of [...(b.head ?? []), ...b.body, ...(b.foot ?? [])]) {
        for (const cell of row) collectNoteRefsInRuns(cell.inlines, ids);
      }
    } else if (b.kind === "list") {
      for (const item of b.items) {
        if (typeof item !== "string") collectNoteRefsInRuns(item.inlines, ids);
      }
    }
  }
  return ids;
}

/** Validate global footnote ID uniqueness and 1-to-1 noteref <-> footnote pairing across pages. */
export function validateSpecFootnotes(
  pages: PdfSpecPage[],
  options: { checkPairing?: boolean } = {},
): PdfDiagnostic[] {
  const issues: PdfDiagnostic[] = [];
  const seenPrimaryIds = new Map<string, number>();
  const allDefinedIds = new Set<string>();
  const allRefPages = new Map<string, number>();
  let prevPageHadFootnote = false;

  for (const p of pages) {
    for (const refId of collectNoteRefsInPage(p)) {
      if (!allRefPages.has(refId)) allRefPages.set(refId, p.page);
    }
    for (const fn of p.footnotes) {
      if (fn.continueFromPrevPage) {
        if (!prevPageHadFootnote) {
          issues.push({
            code: "FOOTNOTE_ORPHAN_CONTINUATION",
            severity: "warning",
            page: p.page,
            message: `Footnote "${fn.id}" on page ${p.page} sets continueFromPrevPage=true with no preceding footnote`,
          });
        }
        allDefinedIds.add(fn.id);
      } else {
        const firstPage = seenPrimaryIds.get(fn.id);
        if (firstPage !== undefined) {
          issues.push({
            code: "FOOTNOTE_ID_COLLISION",
            severity: "error",
            page: p.page,
            message: `Duplicate footnote id "${fn.id}" on page ${p.page} (already defined on page ${firstPage}); namespace IDs by page (e.g. p${p.page}-1) or mark continueFromPrevPage: true for cross-page continuation`,
          });
        } else {
          seenPrimaryIds.set(fn.id, p.page);
          allDefinedIds.add(fn.id);
        }
      }
    }
    prevPageHadFootnote = p.footnotes.length > 0;
  }

  if (options.checkPairing !== false) {
    for (const [id, pageNum] of seenPrimaryIds.entries()) {
      if (!allRefPages.has(id)) {
        issues.push({
          code: "FOOTNOTE_UNREFERENCED",
          severity: "error",
          page: pageNum,
          message: `Footnote "${id}" on page ${pageNum} has no matching noteref in body text`,
        });
      }
    }
    for (const [refId, pageNum] of allRefPages.entries()) {
      if (!allDefinedIds.has(refId)) {
        issues.push({
          code: "FOOTNOTE_MISSING",
          severity: "error",
          page: pageNum,
          message: `Inline noteref "${refId}" on page ${pageNum} has no matching footnote definition`,
        });
      }
    }
  }
  return issues;
}

/**
 * Verify independent verifier records for every page whose ocrTrust requires proofreading.
 * Checks: distinct verifier !== transcriber, render SHA-256 match, content SHA-256 match,
 * zero unresolved items, and reviewed tiles when a tiled render manifest is provided.
 */
export function verifyPdfSpecPages(
  spec: PdfSpec,
  options: {
    verification?: PdfVerificationFile;
    renderManifest?: PdfRenderManifest;
  } = {},
): PdfDiagnostic[] {
  const issues: PdfDiagnostic[] = [];
  if (
    options.verification &&
    options.verification.sourceSha256 !== spec.source.sha256
  ) {
    issues.push({
      code: "SOURCE_HASH_MISMATCH",
      severity: "error",
      message: `Verification file sourceSha256 (${options.verification.sourceSha256}) does not match spec (${spec.source.sha256})`,
    });
  }
  if (
    options.renderManifest &&
    options.renderManifest.sourceSha256 !== spec.source.sha256
  ) {
    issues.push({
      code: "SOURCE_HASH_MISMATCH",
      severity: "error",
      message: `Render manifest sourceSha256 (${options.renderManifest.sourceSha256}) does not match spec (${spec.source.sha256})`,
    });
  }

  const verByPage = new Map<number, PdfPageVerificationRecord>();
  for (const rec of options.verification?.pages ?? []) {
    verByPage.set(rec.page, rec);
  }
  const manifestByPage = new Map(
    (options.renderManifest?.pages ?? []).map((p) => [p.page, p]),
  );

  for (const page of spec.pages) {
    if (!pageRequiresOcrVerification(page)) continue;

    if ((page.transcription?.unresolved.length ?? 0) > 0) {
      issues.push({
        code: "PDF_UNRESOLVED_ITEMS",
        severity: "error",
        page: page.page,
        message: `Page ${page.page} still has ${page.transcription!.unresolved.length} unresolved transcription item(s)`,
      });
    }

    const record = verByPage.get(page.page) ?? page.verification;
    if (!record) {
      issues.push({
        code: "PDF_OCR_VERIFICATION_REQUIRED",
        severity: "error",
        page: page.page,
        message: `Page ${page.page} (ocrTrust=${page.ocrTrust}) requires an independent verifier record before build or PDF repair`,
      });
      continue;
    }

    if (record.status !== "verified") {
      issues.push({
        code: "PDF_OCR_VERIFICATION_REQUIRED",
        severity: "error",
        page: page.page,
        message: `Page ${page.page} verification status is "${record.status}" (expected "verified")`,
      });
    }

    const transcriber = (
      page.transcription?.transcribedBy ?? record.transcribedBy
    )
      .trim()
      .toLowerCase();
    const verifier = record.verifiedBy.trim().toLowerCase();
    if (!transcriber || !verifier || transcriber === verifier) {
      issues.push({
        code: "PDF_SELF_APPROVAL_FORBIDDEN",
        severity: "error",
        page: page.page,
        message: `Page ${page.page} verification requires verifiedBy ("${record.verifiedBy}") to differ from transcribedBy ("${page.transcription?.transcribedBy ?? record.transcribedBy}")`,
      });
    }

    if (record.unresolved.length > 0) {
      issues.push({
        code: "PDF_UNRESOLVED_ITEMS",
        severity: "error",
        page: page.page,
        message: `Page ${page.page} verification record still lists ${record.unresolved.length} unresolved item(s)`,
      });
    }

    const actualContentHash = computePageContentSha256(page);
    if (record.contentSha256 !== actualContentHash) {
      issues.push({
        code: "PDF_VERIFICATION_STALE",
        severity: "error",
        page: page.page,
        message: `Page ${page.page} content hash (${actualContentHash}) changed after verification (${record.contentSha256})`,
      });
    }

    const manifestPage = manifestByPage.get(page.page);
    const expectedRenderSha = manifestPage?.sha256 ?? page.render?.sha256;
    if (expectedRenderSha && record.renderSha256 !== expectedRenderSha) {
      issues.push({
        code: "PDF_RENDER_HASH_MISMATCH",
        severity: "error",
        page: page.page,
        message: `Page ${page.page} verified renderSha256 (${record.renderSha256}) does not match inspect render (${expectedRenderSha})`,
      });
    }
    if (manifestPage?.tiles && manifestPage.tiles.length > 0) {
      const validTileIds = new Set(manifestPage.tiles.map((t) => t.id));
      if (record.tilesReviewed.length === 0) {
        issues.push({
          code: "PDF_TILES_NOT_REVIEWED",
          severity: "error",
          page: page.page,
          message: `Page ${page.page} has rendered tiles in manifest but verification record lists zero tilesReviewed`,
        });
      } else {
        for (const tileId of record.tilesReviewed) {
          if (!validTileIds.has(tileId)) {
            issues.push({
              code: "PDF_TILE_UNKNOWN",
              severity: "error",
              page: page.page,
              message: `Page ${page.page} lists unknown tile "${tileId}" in tilesReviewed`,
            });
          }
        }
      }
    }
  }
  return issues;
}

export function assertPdfSpecVerified(
  spec: PdfSpec,
  options: {
    verification?: PdfVerificationFile;
    renderManifest?: PdfRenderManifest;
  } = {},
): void {
  const issues = verifyPdfSpecPages(spec, options).filter(
    (d) => d.severity === "error",
  );
  if (issues.length > 0) {
    fail(issues[0].code, issues.map((i) => i.message).join("; "), issues);
  }
}

export function stripRunningHeadersAndFooters(pages: PdfSpecPage[]): void {
  if (pages.length < 3) return;
  const edgeCounts = new Map<string, number>();
  for (const p of pages) {
    const first = p.blocks[0];
    const last = p.blocks[p.blocks.length - 1];
    for (const candidate of [first, last]) {
      if (
        candidate &&
        candidate.kind === "paragraph" &&
        candidate.text.length > 0 &&
        candidate.text.length <= 50
      ) {
        const norm = candidate.text.replace(/\d+/g, "#").trim();
        edgeCounts.set(norm, (edgeCounts.get(norm) ?? 0) + 1);
      }
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
  for (const p of pages) {
    const firstBlock = p.blocks[0];
    if (p.blocks.length > 1 && firstBlock?.kind === "paragraph") {
      const norm = firstBlock.text.replace(/\d+/g, "#").trim();
      if ((edgeCounts.get(norm) ?? 0) >= threshold) p.blocks.shift();
    }
    const lastBlock = p.blocks[p.blocks.length - 1];
    if (p.blocks.length > 1 && lastBlock?.kind === "paragraph") {
      const norm = lastBlock.text.replace(/\d+/g, "#").trim();
      if ((edgeCounts.get(norm) ?? 0) >= threshold) p.blocks.pop();
    }
  }
}

/**
 * Heuristically fill undefined cross-page stitch flags only; never overwrite
 * explicit `false` decisions made by the LLM, and require explicit
 * `continueFromPrevPage: true` for cross-page footnote continuations.
 */
export function stitchPdfPagesInPlace(pages: PdfSpecPage[]): void {
  for (let i = 0; i + 1 < pages.length; i++) {
    const cur = pages[i];
    const next = pages[i + 1];
    if (next.page !== cur.page + 1) continue;

    const lastBlock = cur.blocks[cur.blocks.length - 1];
    const firstBlock = next.blocks[0];
    if (lastBlock?.kind === "paragraph" && firstBlock?.kind === "paragraph") {
      const explicitlyBlocked =
        lastBlock.stitchWithNextPage === false ||
        firstBlock.continueFromPrevPage === false;
      if (!explicitlyBlocked) {
        const explicitPair =
          lastBlock.stitchWithNextPage === true ||
          firstBlock.continueFromPrevPage === true;
        const heuristicMatch =
          lastBlock.stitchWithNextPage === undefined &&
          firstBlock.continueFromPrevPage === undefined &&
          (lastBlock.voice ?? "body") === (firstBlock.voice ?? "body") &&
          lastBlock.text.trim().length > 0 &&
          !SENTENCE_END_RE.test(lastBlock.text.trim());
        if (explicitPair || heuristicMatch) {
          if (lastBlock.stitchWithNextPage === undefined) {
            lastBlock.stitchWithNextPage = true;
          }
          if (firstBlock.continueFromPrevPage === undefined) {
            firstBlock.continueFromPrevPage = true;
          }
        }
      }
    }

    if (lastBlock?.kind === "table" && firstBlock?.kind === "table") {
      const explicitlyBlocked =
        lastBlock.stitchWithNextPage === false ||
        firstBlock.continueFromPrevPage === false;
      if (!explicitlyBlocked) {
        const explicitPair =
          lastBlock.stitchWithNextPage === true ||
          firstBlock.continueFromPrevPage === true;
        const heuristicMatch =
          lastBlock.stitchWithNextPage === undefined &&
          firstBlock.continueFromPrevPage === undefined &&
          !firstBlock.caption.trim() &&
          firstBlock.body[0]?.length === lastBlock.body[0]?.length;
        if (explicitPair || heuristicMatch) {
          if (lastBlock.stitchWithNextPage === undefined) {
            lastBlock.stitchWithNextPage = true;
          }
          if (firstBlock.continueFromPrevPage === undefined) {
            firstBlock.continueFromPrevPage = true;
          }
        }
      }
    }

    const lastFn = cur.footnotes[cur.footnotes.length - 1];
    const firstFn = next.footnotes[0];
    if (
      lastFn &&
      firstFn &&
      firstFn.continueFromPrevPage === true &&
      lastFn.stitchWithNextPage === undefined
    ) {
      lastFn.stitchWithNextPage = true;
    }
  }
}

async function assertNewOutput(outputPath: string): Promise<string> {
  const resolved = path.resolve(outputPath);
  if (await exists(resolved)) {
    fail("OUTPUT_EXISTS", `Refusing to overwrite existing output: ${resolved}`);
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  return resolved;
}

export function guessLanguage(sample: string, fallback = "zh-Hans"): string {
  if (/[\u3040-\u30ff]/u.test(sample)) return "ja";
  if (/[\u4e00-\u9fff]/u.test(sample)) return "zh-Hans";
  if (/[A-Za-z]{4,}/.test(sample)) return "en";
  return fallback;
}

export async function initPdfSpec(
  pdfFile: string,
  outputSpecFile: string,
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
): Promise<{
  status: "pass";
  operation: "pdf-init-spec";
  specPath: string;
  classification: PdfSpec["source"]["classification"];
  pageCount: number;
  shards: PdfSpec["shards"];
  unverifiedPages: number[];
  renderManifestPath?: string;
}> {
  const outPath = await assertNewOutput(outputSpecFile);
  const { inspection, pages } = await extractPdfRawPages(pdfFile, options);
  stripRunningHeadersAndFooters(pages);
  stitchPdfPagesInPlace(pages);

  const sampleText = pages
    .slice(0, 5)
    .flatMap((p) => p.blocks.map(extractBlockPlainText))
    .join(" ");
  const inferredTitle =
    inspection.info.Title?.trim() ||
    path.basename(pdfFile, path.extname(pdfFile));
  const rawAuthor = inspection.info.Author?.trim();
  const authors = rawAuthor
    ? rawAuthor
        .split(/[;,；、]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : ["Unknown"];
  const lang = guessLanguage(`${inferredTitle} ${sampleText}`);

  const spec: PdfSpec = {
    schemaVersion: PDF_SPEC_SCHEMA_VERSION,
    kind: "quillbind-pdf-spec",
    source: {
      path: inspection.path,
      sha256: inspection.sha256,
      pdfVersion: inspection.pdfVersion,
      pageCount: inspection.pageCount,
      classification: inspection.classification,
    },
    metadata: {
      title: inferredTitle,
      authors,
      language: lang,
      description: inspection.info.Subject?.trim() ?? "",
      tags: [],
      modified: "2000-01-01T00:00:00Z",
    },
    frontmatter: {
      titlepage: { title: inferredTitle, authors },
      includeTitlepage: true,
      includeColophon: false,
    },
    outline: inspection.outline,
    shards: inspection.shards,
    ...(inspection.renderManifestPath
      ? {
          renderManifestPath: inspection.renderManifestPath,
          renderManifestSha256: inspection.renderManifestSha256,
        }
      : {}),
    pages,
  };

  const validated = pdfSpecSchema.parse(spec);
  await fs.writeFile(outPath, JSON.stringify(validated, null, 2) + "\n", {
    flag: "wx",
  });
  const unverifiedPages = validated.pages
    .filter((p) => pageRequiresOcrVerification(p))
    .map((p) => p.page);
  return {
    status: "pass",
    operation: "pdf-init-spec",
    specPath: outPath,
    classification: validated.source.classification,
    pageCount: validated.pages.length,
    shards: validated.shards,
    unverifiedPages,
    ...(validated.renderManifestPath
      ? { renderManifestPath: validated.renderManifestPath }
      : {}),
  };
}

function renderInlinesToMarkdown(
  runs: PdfInlineRun[] | undefined,
  fallbackText: string,
): string {
  if (!runs || runs.length === 0) return fallbackText;
  return runs
    .map((r) => {
      if (r.kind === "text") {
        let out = r.text;
        if (r.code) out = `\`${out}\``;
        if (r.bold) out = `**${out}**`;
        if (r.italic) out = `*${out}*`;
        if (r.sup) out = `:sup[${out}]`;
        if (r.sub) out = `:sub[${out}]`;
        return out;
      }
      if (r.kind === "ruby") return `:ruby[${r.base}]{reading="${r.rt}"}`;
      if (r.kind === "math-inline") return `$${r.tex ?? r.alt}$`;
      return `[^${r.id}]`;
    })
    .join("");
}

function renderPageDraftToMarkdown(
  spec: PdfSpec,
  page: PdfSpecPage,
  manifestPage?: PdfRenderManifest["pages"][number],
): string {
  const fmLines = [
    "---",
    `page: ${page.page}`,
    `sourceSha256: "${spec.source.sha256}"`,
    `classification: "${page.classification}"`,
    `ocrTrust: "${page.ocrTrust}"`,
    `transcribedBy: "${page.transcription?.transcribedBy ?? ""}"`,
  ];
  const renderPath = manifestPage?.path ?? page.render?.path;
  const renderSha = manifestPage?.sha256 ?? page.render?.sha256;
  const dpi = manifestPage?.dpi ?? page.render?.dpi;
  if (renderPath) fmLines.push(`renderPath: "${renderPath}"`);
  if (renderSha) fmLines.push(`renderSha256: "${renderSha}"`);
  if (dpi) fmLines.push(`dpi: ${dpi}`);
  if (manifestPage?.tiles?.length) {
    fmLines.push("tiles:");
    for (const t of manifestPage.tiles) {
      fmLines.push(`  - id: "${t.id}"`);
      fmLines.push(`    kind: "${t.kind}"`);
      fmLines.push(`    path: "${t.path}"`);
    }
  }
  fmLines.push("tilesReviewed: []");
  if (page.sectionId) fmLines.push(`sectionId: "${page.sectionId}"`);
  fmLines.push("unresolved: []");
  fmLines.push("---", "");

  const bodyLines: string[] = [];
  for (const b of page.blocks) {
    if (b.kind === "heading") {
      bodyLines.push(
        `${"#".repeat(b.level)} ${renderInlinesToMarkdown(b.inlines, b.text)}`,
        "",
      );
      if (b.subtitle) bodyLines.push(`::subtitle[${b.subtitle}]`, "");
      if (b.byline) bodyLines.push(`::byline[${b.byline}]`, "");
    } else if (b.kind === "paragraph") {
      if (b.continueFromPrevPage === true)
        bodyLines.push("::continue-prev", "");
      if (b.continueFromPrevPage === false)
        bodyLines.push("::no-continue-prev", "");
      const text = renderInlinesToMarkdown(b.inlines, b.text);
      if (b.voice && b.voice !== "body") {
        bodyLines.push(`:::voice{kind="${b.voice}"}`, text, ":::", "");
      } else {
        bodyLines.push(text, "");
      }
      if (b.stitchWithNextPage === true) bodyLines.push("::stitch-next", "");
      if (b.stitchWithNextPage === false)
        bodyLines.push("::no-stitch-next", "");
    } else if (b.kind === "math-block") {
      bodyLines.push("$$", b.tex ?? b.alt, "$$", "");
    } else if (b.kind === "figure") {
      bodyLines.push(
        `::figure[${b.caption ?? ""}]{src="${b.src}" alt="${b.alt}"}`,
        "",
      );
    } else if (b.kind === "list") {
      b.items.forEach((item, idx) => {
        const prefix = b.ordered ? `${idx + 1}. ` : "- ";
        const text =
          typeof item === "string"
            ? item
            : renderInlinesToMarkdown(item.inlines, item.text);
        bodyLines.push(`${prefix}${text}`);
      });
      bodyLines.push("");
    } else if (b.kind === "hr") {
      bodyLines.push("---", "");
    } else if (b.kind === "table") {
      bodyLines.push("```json table", JSON.stringify(b, null, 2), "```", "");
    }
  }

  for (const fn of page.footnotes) {
    if (fn.continueFromPrevPage) {
      bodyLines.push(
        `::footnote-continue[${renderInlinesToMarkdown(fn.inlines, fn.text)}]{id="${fn.id}" label="${fn.label}"}`,
        "",
      );
    } else {
      bodyLines.push(
        `[^${fn.id}]: ${renderInlinesToMarkdown(fn.inlines, fn.text)}`,
        "",
      );
    }
  }

  return `${fmLines.join("\n")}${bodyLines.join("\n").trimEnd()}\n`;
}

/** Generate per-shard or per-page editable Markdown/JSON drafts for parallel LLM workers. */
export async function initPdfShards(
  baseSpecFile: string,
  outputDir: string,
  options: {
    format?: "md" | "json";
    renderManifest?: string;
  } = {},
): Promise<{
  status: "pass";
  operation: "pdf-shard-init";
  outputDir: string;
  format: "md" | "json";
  shards: { id: string; pageStart: number; pageEnd: number; files: string[] }[];
  indexPath: string;
}> {
  const format = options.format ?? "md";
  const resolvedOut = path.resolve(outputDir);
  if (await exists(resolvedOut)) {
    fail(
      "OUTPUT_EXISTS",
      `Refusing to overwrite existing shard directory: ${resolvedOut}`,
    );
  }
  const baseRaw = await readJson<unknown>(path.resolve(baseSpecFile));
  const parsed = pdfSpecSchema.safeParse(baseRaw);
  if (!parsed.success) fail("PDF_SPEC_INVALID", parsed.error.message);
  const spec = parsed.data;

  const manifestPath = options.renderManifest ?? spec.renderManifestPath;
  let manifest: PdfRenderManifest | undefined;
  if (manifestPath && (await exists(path.resolve(manifestPath)))) {
    const mRaw = await readJson<unknown>(path.resolve(manifestPath));
    manifest = pdfRenderManifestSchema.parse(mRaw);
  }
  const manifestByPage = new Map(
    (manifest?.pages ?? []).map((p) => [p.page, p]),
  );

  await fs.mkdir(resolvedOut, { recursive: true });
  const shardOutputs: {
    id: string;
    pageStart: number;
    pageEnd: number;
    files: string[];
  }[] = [];

  for (const shard of spec.shards) {
    const slicePages = spec.pages.filter(
      (p) => p.page >= shard.pageStart && p.page <= shard.pageEnd,
    );
    const files: string[] = [];
    if (format === "md") {
      const shardDir = path.join(resolvedOut, shard.id);
      await fs.mkdir(shardDir, { recursive: true });
      for (const p of slicePages) {
        const mdPath = path.join(
          shardDir,
          `p${String(p.page).padStart(4, "0")}.md`,
        );
        const content = renderPageDraftToMarkdown(
          spec,
          p,
          manifestByPage.get(p.page),
        );
        await fs.writeFile(mdPath, content, { flag: "wx" });
        files.push(mdPath);
      }
    } else {
      const shardPath = path.join(resolvedOut, `${shard.id}.json`);
      const shardPayload: PdfShardFile = {
        schemaVersion: PDF_SPEC_SCHEMA_VERSION,
        kind: "quillbind-pdf-shard",
        sourceSha256: spec.source.sha256,
        shard,
        pages: slicePages,
      };
      await fs.writeFile(
        shardPath,
        JSON.stringify(shardPayload, null, 2) + "\n",
        { flag: "wx" },
      );
      files.push(shardPath);
    }
    shardOutputs.push({
      id: shard.id,
      pageStart: shard.pageStart,
      pageEnd: shard.pageEnd,
      files,
    });
  }

  const indexPath = path.join(resolvedOut, "shards-index.json");
  await json(indexPath, {
    schemaVersion: PDF_SPEC_SCHEMA_VERSION,
    kind: "quillbind-pdf-shards-index",
    sourceSha256: spec.source.sha256,
    format,
    shards: shardOutputs,
  });

  return {
    status: "pass",
    operation: "pdf-shard-init",
    outputDir: resolvedOut,
    format,
    shards: shardOutputs,
    indexPath,
  };
}

export interface CompiledMarkdownPage {
  pageNumber: number;
  sourceSha256?: string;
  sectionId?: string;
  blocks: PdfBlock[];
  footnotes: PdfFootnoteItem[];
  transcription?: {
    transcribedBy: string;
    unresolved: PdfUnresolvedItem[];
  };
  render?: {
    path?: string;
    sha256: string;
    dpi: number;
    tilesReviewed?: string[];
  };
  diagnostics: PdfDiagnostic[];
}

function namespaceFootnoteId(rawId: string, pageNumber: number): string {
  const clean = rawId.trim();
  if (/^p\d+-/u.test(clean)) return clean;
  return `p${pageNumber}-${clean.replace(/^fn-/u, "")}`;
}

/** Compile a single per-page Markdown transcription into structured PDF page blocks & footnotes. */
export function compilePdfPageMarkdown(
  markdown: string,
  fileLabel = "page.md",
): CompiledMarkdownPage {
  const diagnostics: PdfDiagnostic[] = [];
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!fmMatch) {
    diagnostics.push({
      code: "PDF_MD_FRONTMATTER",
      severity: "error",
      file: fileLabel,
      line: 1,
      message:
        "Per-page Markdown must start with YAML frontmatter (--- ... ---)",
    });
    return { pageNumber: 0, blocks: [], footnotes: [], diagnostics };
  }

  let fm: Record<string, unknown>;
  try {
    const parsed = parseYaml(fmMatch[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Frontmatter must be a YAML mapping");
    }
    fm = parsed as Record<string, unknown>;
  } catch (err) {
    diagnostics.push({
      code: "PDF_MD_FRONTMATTER",
      severity: "error",
      file: fileLabel,
      line: 2,
      message: `Invalid YAML frontmatter: ${String(err)}`,
    });
    return { pageNumber: 0, blocks: [], footnotes: [], diagnostics };
  }

  const pageNumber = Number(fm.page);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    diagnostics.push({
      code: "PDF_MD_PAGE",
      severity: "error",
      file: fileLabel,
      line: 2,
      message: `Frontmatter "page" must be a positive integer, got ${String(fm.page)}`,
    });
    return { pageNumber: 0, blocks: [], footnotes: [], diagnostics };
  }

  const lineOffset = fmMatch[0].split("\n").length - 1;
  const body = normalized.slice(fmMatch[0].length);
  const tree = pageMarkdownParser.parse(body) as MdNode;

  const lineOf = (node: MdNode): number =>
    (node.position?.start.line ?? 1) + lineOffset;

  const unresolved: PdfUnresolvedItem[] = [];
  if (Array.isArray(fm.unresolved)) {
    for (const item of fm.unresolved) {
      if (typeof item === "string" && item.trim()) {
        unresolved.push({ reason: item.trim() });
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        if (typeof rec.reason === "string" && rec.reason.trim()) {
          unresolved.push({
            ...(typeof rec.id === "string" ? { id: rec.id } : {}),
            ...(typeof rec.location === "string"
              ? { location: rec.location }
              : {}),
            reason: rec.reason.trim(),
            ...(typeof rec.context === "string"
              ? { context: rec.context }
              : {}),
          });
        }
      }
    }
  }

  const footnoteDefs = new Map<string, { label: string; node: MdNode }>();
  const collectDefs = (node: MdNode) => {
    if (node.type === "footnoteDefinition" && node.identifier) {
      const id = namespaceFootnoteId(node.identifier, pageNumber);
      if (footnoteDefs.has(id)) {
        diagnostics.push({
          code: "FOOTNOTE_ID_COLLISION",
          severity: "error",
          file: fileLabel,
          page: pageNumber,
          line: lineOf(node),
          message: `Duplicate footnote definition "${id}" on page ${pageNumber}`,
        });
      } else {
        footnoteDefs.set(id, {
          label: node.label ?? node.identifier,
          node,
        });
      }
    }
    node.children?.forEach(collectDefs);
  };
  collectDefs(tree);

  const compileInlines = (nodes: MdNode[] | undefined): PdfInlineRun[] => {
    const out: PdfInlineRun[] = [];
    const visit = (
      node: MdNode,
      marks: { bold?: boolean; italic?: boolean; sup?: boolean; sub?: boolean },
    ) => {
      switch (node.type) {
        case "text":
          if (node.value) {
            out.push({
              kind: "text",
              text: node.value,
              ...(marks.bold ? { bold: true } : {}),
              ...(marks.italic ? { italic: true } : {}),
              ...(marks.sup ? { sup: true } : {}),
              ...(marks.sub ? { sub: true } : {}),
            });
          }
          break;
        case "strong":
          node.children?.forEach((c) => visit(c, { ...marks, bold: true }));
          break;
        case "emphasis":
          node.children?.forEach((c) => visit(c, { ...marks, italic: true }));
          break;
        case "inlineCode":
          out.push({ kind: "text", text: node.value ?? "", code: true });
          break;
        case "break":
          out.push({ kind: "text", text: "\n" });
          break;
        case "inlineMath":
          out.push({
            kind: "math-inline",
            tex: node.value ?? "",
            alt: node.value ?? "",
          });
          break;
        case "footnoteReference": {
          const rawId = node.identifier ?? "1";
          const fnId = namespaceFootnoteId(rawId, pageNumber);
          out.push({
            kind: "noteref",
            id: fnId,
            label: node.label ?? rawId,
          });
          break;
        }
        case "textDirective": {
          if (node.name === "ruby") {
            const rt = node.attributes?.reading?.trim();
            const base = mdPlain(node).trim();
            if (!rt || !base) {
              diagnostics.push({
                code: "PDF_MD_DIRECTIVE",
                severity: "error",
                file: fileLabel,
                page: pageNumber,
                line: lineOf(node),
                message:
                  ':ruby directive requires base text and {reading="..."}',
              });
            } else {
              out.push({ kind: "ruby", base, rt });
            }
          } else if (node.name === "sup") {
            node.children?.forEach((c) => visit(c, { ...marks, sup: true }));
          } else if (node.name === "sub") {
            node.children?.forEach((c) => visit(c, { ...marks, sub: true }));
          } else if (node.name === "unresolved") {
            const reason = mdPlain(node).trim() || "Illegible glyph";
            unresolved.push({
              reason,
              ...(node.attributes?.location
                ? { location: node.attributes.location }
                : { location: `line ${lineOf(node)}` }),
              ...(node.attributes?.context
                ? { context: node.attributes.context }
                : {}),
            });
          } else {
            diagnostics.push({
              code: "PDF_MD_DIRECTIVE",
              severity: "error",
              file: fileLabel,
              page: pageNumber,
              line: lineOf(node),
              message: `Unsupported inline directive :${node.name}`,
            });
          }
          break;
        }
        default:
          diagnostics.push({
            code: "PDF_MD_UNSUPPORTED",
            severity: "error",
            file: fileLabel,
            page: pageNumber,
            line: lineOf(node),
            message: `Unsupported inline Markdown node "${node.type}"`,
          });
      }
    };
    nodes?.forEach((n) => visit(n, {}));
    return out;
  };

  const runsToText = (runs: PdfInlineRun[]): string =>
    runs
      .map((r) => {
        if (r.kind === "text") return r.text;
        if (r.kind === "ruby") return r.base;
        if (r.kind === "math-inline") return r.alt;
        return r.label;
      })
      .join("");

  const hasRichRuns = (runs: PdfInlineRun[]): boolean =>
    runs.some(
      (r) =>
        r.kind !== "text" ||
        Boolean(r.bold || r.italic || r.code || r.sup || r.sub),
    );

  const blocks: PdfBlock[] = [];
  const footnotes: PdfFootnoteItem[] = [];
  let pendingContinue: boolean | undefined;
  let pendingCaption: string | undefined;

  const applyPendingContinue = (
    block:
      | Extract<PdfBlock, { kind: "paragraph" }>
      | Extract<PdfBlock, { kind: "table" }>,
  ) => {
    if (pendingContinue !== undefined) {
      block.continueFromPrevPage = pendingContinue;
      pendingContinue = undefined;
    }
  };

  for (const node of tree.children ?? []) {
    if (node.type === "footnoteDefinition" || node.type === "definition") {
      continue;
    }
    if (node.type === "heading") {
      const level = Math.min(6, Math.max(1, node.depth ?? 1)) as
        1 | 2 | 3 | 4 | 5 | 6;
      const runs = compileInlines(node.children);
      blocks.push({
        kind: "heading",
        level,
        text: runsToText(runs),
        ...(hasRichRuns(runs) ? { inlines: runs } : {}),
      });
      continue;
    }
    if (node.type === "paragraph") {
      const runs = compileInlines(node.children);
      const para: Extract<PdfBlock, { kind: "paragraph" }> = {
        kind: "paragraph",
        text: runsToText(runs),
        ...(hasRichRuns(runs) ? { inlines: runs } : {}),
      };
      applyPendingContinue(para);
      blocks.push(para);
      continue;
    }
    if (node.type === "blockquote") {
      const paraNodes = (node.children ?? []).filter(
        (c) => c.type === "paragraph",
      );
      for (const pNode of paraNodes) {
        const runs = compileInlines(pNode.children);
        const para: Extract<PdfBlock, { kind: "paragraph" }> = {
          kind: "paragraph",
          voice: "quote",
          text: runsToText(runs),
          ...(hasRichRuns(runs) ? { inlines: runs } : {}),
        };
        applyPendingContinue(para);
        blocks.push(para);
      }
      continue;
    }
    if (node.type === "math") {
      blocks.push({
        kind: "math-block",
        tex: node.value ?? "",
        alt: node.value ?? "",
      });
      continue;
    }
    if (node.type === "thematicBreak") {
      blocks.push({ kind: "hr" });
      continue;
    }
    if (node.type === "list") {
      const items = (node.children ?? []).map((li) => {
        const firstPara = li.children?.find((c) => c.type === "paragraph");
        const runs = compileInlines(firstPara?.children ?? li.children);
        const text = runsToText(runs);
        return hasRichRuns(runs) ? { text, inlines: runs } : text;
      });
      blocks.push({ kind: "list", ordered: Boolean(node.ordered), items });
      continue;
    }
    if (node.type === "table") {
      const rows = (node.children ?? []).map((row, rowIdx) =>
        (row.children ?? []).map((cell, colIdx): PdfTableCell => {
          const runs = compileInlines(cell.children);
          const align = node.align?.[colIdx] ?? undefined;
          return {
            ...(rowIdx === 0 ? { header: true, scope: "col" as const } : {}),
            ...(align ? { align } : {}),
            text: runsToText(runs),
            ...(hasRichRuns(runs) ? { inlines: runs } : {}),
          };
        }),
      );
      const tableBlock: Extract<PdfBlock, { kind: "table" }> = {
        kind: "table",
        caption: pendingCaption ?? "",
        ...(rows.length > 0
          ? { head: [rows[0]], body: rows.slice(1) }
          : { body: [] }),
      };
      pendingCaption = undefined;
      applyPendingContinue(tableBlock);
      diagnostics.push(
        ...validateTableGrid(tableBlock, {
          page: pageNumber,
          file: fileLabel,
          line: lineOf(node),
        }),
      );
      blocks.push(tableBlock);
      continue;
    }
    if (node.type === "code") {
      const rawCode = (node.value ?? "").trim();
      try {
        const parsedJson = JSON.parse(rawCode) as unknown;
        const parsedBlock = pdfBlockSchema.safeParse(parsedJson);
        if (!parsedBlock.success || parsedBlock.data.kind !== "table") {
          diagnostics.push({
            code: "PDF_MD_TABLE_JSON",
            severity: "error",
            file: fileLabel,
            page: pageNumber,
            line: lineOf(node),
            message: `Fenced table JSON failed schema validation: ${parsedBlock.success ? "expected kind=table" : parsedBlock.error.message}`,
          });
        } else {
          applyPendingContinue(parsedBlock.data);
          diagnostics.push(
            ...validateTableGrid(parsedBlock.data, {
              page: pageNumber,
              file: fileLabel,
              line: lineOf(node),
            }),
          );
          blocks.push(parsedBlock.data);
        }
      } catch (err) {
        diagnostics.push({
          code: "PDF_MD_TABLE_JSON",
          severity: "error",
          file: fileLabel,
          page: pageNumber,
          line: lineOf(node),
          message: `Invalid JSON in fenced block: ${String(err)}`,
        });
      }
      continue;
    }
    if (node.type === "leafDirective" || node.type === "containerDirective") {
      const attrs = node.attributes ?? {};
      const name = node.name ?? "";
      if (name === "continue-prev") {
        pendingContinue = true;
      } else if (name === "no-continue-prev") {
        pendingContinue = false;
      } else if (name === "stitch-next" || name === "no-stitch-next") {
        const prev = blocks[blocks.length - 1];
        if (prev && (prev.kind === "paragraph" || prev.kind === "table")) {
          prev.stitchWithNextPage = name === "stitch-next";
        } else {
          diagnostics.push({
            code: "PDF_MD_DIRECTIVE",
            severity: "error",
            file: fileLabel,
            page: pageNumber,
            line: lineOf(node),
            message: `::${name} must directly follow a paragraph or table`,
          });
        }
      } else if (name === "caption") {
        pendingCaption = mdPlain(node).trim();
      } else if (name === "subtitle" || name === "byline") {
        const prev = blocks[blocks.length - 1];
        if (prev?.kind === "heading") {
          if (name === "subtitle") prev.subtitle = mdPlain(node).trim();
          else prev.byline = mdPlain(node).trim();
        } else {
          diagnostics.push({
            code: "PDF_MD_DIRECTIVE",
            severity: "error",
            file: fileLabel,
            page: pageNumber,
            line: lineOf(node),
            message: `::${name} must directly follow a heading`,
          });
        }
      } else if (name === "voice") {
        const kind = attrs.kind;
        const validVoices = [
          "body",
          "epigraph",
          "quote",
          "verse",
          "dialogue",
          "signature",
        ];
        if (!kind || !validVoices.includes(kind)) {
          diagnostics.push({
            code: "PDF_MD_DIRECTIVE",
            severity: "error",
            file: fileLabel,
            page: pageNumber,
            line: lineOf(node),
            message: `:::voice requires kind in ${validVoices.join("|")}`,
          });
        } else {
          const innerParas = (node.children ?? []).filter(
            (c) => c.type === "paragraph",
          );
          for (const pNode of innerParas) {
            const runs = compileInlines(pNode.children);
            const para: Extract<PdfBlock, { kind: "paragraph" }> = {
              kind: "paragraph",
              voice: kind as Extract<PdfBlock, { kind: "paragraph" }>["voice"],
              text: runsToText(runs),
              ...(hasRichRuns(runs) ? { inlines: runs } : {}),
            };
            applyPendingContinue(para);
            blocks.push(para);
          }
        }
      } else if (name === "figure") {
        if (!attrs.src || attrs.alt === undefined) {
          diagnostics.push({
            code: "PDF_MD_DIRECTIVE",
            severity: "error",
            file: fileLabel,
            page: pageNumber,
            line: lineOf(node),
            message: "::figure requires src and alt attributes",
          });
        } else {
          const cap = mdPlain(node).trim();
          blocks.push({
            kind: "figure",
            src: attrs.src,
            alt: attrs.alt,
            ...(attrs.decorative === "true" ? { decorative: true } : {}),
            ...(cap ? { caption: cap } : {}),
          });
        }
      } else if (name === "footnote-continue") {
        const fnId = attrs.id?.trim();
        const label = attrs.label?.trim() || "1";
        if (!fnId) {
          diagnostics.push({
            code: "PDF_MD_DIRECTIVE",
            severity: "error",
            file: fileLabel,
            page: pageNumber,
            line: lineOf(node),
            message: '::footnote-continue requires id="..."',
          });
        } else {
          const runs = compileInlines(node.children);
          footnotes.push({
            id: fnId,
            label,
            text: runsToText(runs),
            ...(hasRichRuns(runs) ? { inlines: runs } : {}),
            continueFromPrevPage: true,
          });
        }
      } else if (name === "unresolved") {
        unresolved.push({
          reason: mdPlain(node).trim() || "Illegible glyph",
          ...(attrs.location
            ? { location: attrs.location }
            : { location: `line ${lineOf(node)}` }),
          ...(attrs.context ? { context: attrs.context } : {}),
        });
      } else {
        diagnostics.push({
          code: "PDF_MD_DIRECTIVE",
          severity: "error",
          file: fileLabel,
          page: pageNumber,
          line: lineOf(node),
          message: `Unsupported block directive ::${name}`,
        });
      }
      continue;
    }

    diagnostics.push({
      code: "PDF_MD_UNSUPPORTED",
      severity: "error",
      file: fileLabel,
      page: pageNumber,
      line: lineOf(node),
      message: `Unsupported block Markdown node "${node.type}"`,
    });
  }

  for (const [fnId, def] of footnoteDefs.entries()) {
    const firstPara = def.node.children?.find((c) => c.type === "paragraph");
    const runs = compileInlines(firstPara?.children ?? def.node.children);
    footnotes.push({
      id: fnId,
      label: def.label,
      text: runsToText(runs),
      ...(hasRichRuns(runs) ? { inlines: runs } : {}),
    });
  }

  const transcribedBy =
    typeof fm.transcribedBy === "string" && fm.transcribedBy.trim()
      ? fm.transcribedBy.trim()
      : undefined;
  const renderSha =
    typeof fm.renderSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(fm.renderSha256)
      ? fm.renderSha256
      : undefined;
  const dpiVal = typeof fm.dpi === "number" && fm.dpi > 0 ? fm.dpi : undefined;
  const tilesReviewed = Array.isArray(fm.tilesReviewed)
    ? fm.tilesReviewed.filter(
        (t): t is string => typeof t === "string" && t.trim().length > 0,
      )
    : undefined;

  return {
    pageNumber,
    ...(typeof fm.sourceSha256 === "string"
      ? { sourceSha256: fm.sourceSha256 }
      : {}),
    ...(typeof fm.sectionId === "string" && fm.sectionId.trim()
      ? { sectionId: fm.sectionId.trim() }
      : {}),
    blocks,
    footnotes,
    ...(transcribedBy || unresolved.length > 0
      ? {
          transcription: {
            transcribedBy: transcribedBy ?? "unknown-worker",
            unresolved,
          },
        }
      : {}),
    ...(renderSha && dpiVal
      ? {
          render: {
            ...(typeof fm.renderPath === "string"
              ? { path: fm.renderPath }
              : {}),
            sha256: renderSha,
            dpi: dpiVal,
            ...(tilesReviewed?.length ? { tilesReviewed } : {}),
          },
        }
      : {}),
    diagnostics,
  };
}

function findJsonLineForPath(
  sourceText: string,
  jsonPath: (string | number)[],
): number {
  const lines = sourceText.split(/\r?\n/u);
  const keySegments = jsonPath.filter(
    (seg): seg is string => typeof seg === "string",
  );
  let startLine = 0;
  for (const key of keySegments) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`"${escaped}"\\s*:`);
    for (let i = startLine; i < lines.length; i++) {
      if (re.test(lines[i])) {
        startLine = i;
        break;
      }
    }
  }
  return startLine + 1;
}

function lineFromJsonSyntaxError(sourceText: string, message: string): number {
  const posMatch = /position\s+(\d+)/i.exec(message);
  if (posMatch) {
    const offset = Number(posMatch[1]);
    return sourceText.slice(0, offset).split(/\r?\n/u).length;
  }
  const lineMatch = /line\s+(\d+)/i.exec(message);
  return lineMatch ? Number(lineMatch[1]) : 1;
}

async function resolveShardInputs(shardInput: string): Promise<string[]> {
  const parts = shardInput
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const files: string[] = [];

  const collectDir = async (dir: string) => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectDir(full);
      } else if (
        entry.isFile() &&
        entry.name !== "shards-index.json" &&
        (entry.name.endsWith(".json") || entry.name.endsWith(".md"))
      ) {
        files.push(full);
      }
    }
  };

  for (const part of parts) {
    const resolved = path.resolve(part);
    const st = await fs.stat(resolved).catch(() => null);
    if (!st) fail("SHARD_MISSING", `Shard input does not exist: ${resolved}`);
    if (st.isDirectory()) await collectDir(resolved);
    else files.push(resolved);
  }
  if (!files.length) {
    fail("SHARD_MISSING", "No shard JSON or per-page Markdown files found");
  }
  return files;
}

/** Validate shard JSON, per-page JSON, or per-page Markdown files with line-numbered diagnostics. */
export async function validatePdfShard(inputPath: string): Promise<{
  status: "pass" | "fail";
  operation: "pdf-validate-shard";
  filesChecked: number;
  pageCount: number;
  diagnostics: PdfDiagnostic[];
}> {
  const files = await resolveShardInputs(inputPath);
  const diagnostics: PdfDiagnostic[] = [];
  const collectedPages: PdfSpecPage[] = [];

  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    if (file.endsWith(".md")) {
      const compiled = compilePdfPageMarkdown(text, file);
      diagnostics.push(...compiled.diagnostics);
      if (compiled.pageNumber >= 1) {
        collectedPages.push({
          page: compiled.pageNumber,
          widthPt: 595,
          heightPt: 842,
          rotate: 0,
          classification: "scanned",
          ocrTrust: "unverified-embedded",
          ...(compiled.sectionId ? { sectionId: compiled.sectionId } : {}),
          blocks: compiled.blocks,
          footnotes: compiled.footnotes,
          ...(compiled.transcription
            ? { transcription: compiled.transcription }
            : {}),
          ...(compiled.render ? { render: compiled.render } : {}),
        });
      }
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      diagnostics.push({
        code: "PDF_SHARD_JSON_SYNTAX",
        severity: "error",
        file,
        line: lineFromJsonSyntaxError(text, String(err)),
        message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const kind =
      raw && typeof raw === "object" && "kind" in raw
        ? (raw as { kind?: unknown }).kind
        : undefined;
    if (kind === "quillbind-pdf-page") {
      const parsed = pdfPageFileSchema.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const pathParts = issue.path.filter(
            (s): s is string | number =>
              typeof s === "string" || typeof s === "number",
          );
          diagnostics.push({
            code: "PDF_SHARD_SCHEMA",
            severity: "error",
            file,
            line: findJsonLineForPath(text, pathParts),
            path: pathParts.join("."),
            message: issue.message,
          });
        }
      } else {
        collectedPages.push(parsed.data.page);
      }
    } else {
      const parsed = pdfShardFileSchema.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const pathParts = issue.path.filter(
            (s): s is string | number =>
              typeof s === "string" || typeof s === "number",
          );
          diagnostics.push({
            code: "PDF_SHARD_SCHEMA",
            severity: "error",
            file,
            line: findJsonLineForPath(text, pathParts),
            path: pathParts.join("."),
            message: issue.message,
          });
        }
      } else {
        for (const p of parsed.data.pages) {
          if (
            p.page < parsed.data.shard.pageStart ||
            p.page > parsed.data.shard.pageEnd
          ) {
            diagnostics.push({
              code: "PDF_SHARD_RANGE",
              severity: "error",
              file,
              page: p.page,
              message: `Page ${p.page} outside shard range ${parsed.data.shard.pageStart}..${parsed.data.shard.pageEnd}`,
            });
          }
          collectedPages.push(p);
        }
      }
    }
  }

  for (const p of collectedPages) {
    for (const b of p.blocks) {
      if (b.kind === "table") {
        diagnostics.push(...validateTableGrid(b, { page: p.page }));
      }
    }
  }
  diagnostics.push(
    ...validateSpecFootnotes(
      [...collectedPages].sort((a, b) => a.page - b.page),
      { checkPairing: true },
    ),
  );

  const hasError = diagnostics.some((d) => d.severity === "error");
  return {
    status: hasError ? "fail" : "pass",
    operation: "pdf-validate-shard",
    filesChecked: files.length,
    pageCount: collectedPages.length,
    diagnostics,
  };
}

export async function mergePdfShards(
  baseSpecFile: string,
  shardInput: string,
  outputSpecFile: string,
): Promise<{
  status: "pass";
  operation: "pdf-merge-shards";
  output: string;
  mergedInputs: number;
  pageCount: number;
  unverifiedPages: number[];
}> {
  const outPath = await assertNewOutput(outputSpecFile);
  const baseRaw = await readJson<unknown>(path.resolve(baseSpecFile));
  const baseParsed = pdfSpecSchema.safeParse(baseRaw);
  if (!baseParsed.success) fail("PDF_SPEC_INVALID", baseParsed.error.message);
  const base = baseParsed.data;
  const baseByPage = new Map(base.pages.map((p) => [p.page, p]));

  const inputFiles = await resolveShardInputs(shardInput);
  const byPage = new Map<number, PdfSpecPage>();

  const registerMergedPage = (incoming: PdfSpecPage) => {
    if (byPage.has(incoming.page)) {
      fail(
        "PDF_SHARD_OVERLAP",
        `Duplicate page ${incoming.page} across shard/page inputs`,
      );
    }
    const basePage = baseByPage.get(incoming.page);
    byPage.set(incoming.page, {
      ...incoming,
      // Preserve deterministic base geometry, raw OCR draft, and render metadata if worker omitted them.
      ...(incoming.geometry
        ? { geometry: incoming.geometry }
        : basePage?.geometry
          ? { geometry: basePage.geometry }
          : {}),
      ...(incoming.rawOcrDraft
        ? { rawOcrDraft: incoming.rawOcrDraft }
        : basePage?.rawOcrDraft
          ? { rawOcrDraft: basePage.rawOcrDraft }
          : {}),
      ...(incoming.render
        ? { render: incoming.render }
        : basePage?.render
          ? { render: basePage.render }
          : {}),
    });
  };

  for (const sf of inputFiles) {
    if (sf.endsWith(".md")) {
      const mdText = await fs.readFile(sf, "utf8");
      const compiled = compilePdfPageMarkdown(mdText, sf);
      const mdErrors = compiled.diagnostics.filter(
        (d) => d.severity === "error",
      );
      if (mdErrors.length > 0) {
        fail(
          mdErrors[0].code,
          `${sf}:${mdErrors[0].line ?? 1}: ${mdErrors[0].message}`,
          mdErrors,
        );
      }
      if (
        compiled.sourceSha256 &&
        compiled.sourceSha256 !== base.source.sha256
      ) {
        fail(
          "SOURCE_HASH_MISMATCH",
          `Page Markdown ${sf} sourceSha256 (${compiled.sourceSha256}) does not match base spec (${base.source.sha256})`,
        );
      }
      const basePage = baseByPage.get(compiled.pageNumber);
      if (!basePage) {
        fail(
          "PDF_SHARD_RANGE",
          `Page Markdown ${sf} declares page ${compiled.pageNumber} not found in base spec`,
        );
      }
      registerMergedPage({
        ...basePage,
        ...(compiled.sectionId ? { sectionId: compiled.sectionId } : {}),
        blocks: compiled.blocks,
        footnotes: compiled.footnotes,
        ...(compiled.transcription
          ? { transcription: compiled.transcription }
          : {}),
        ...(compiled.render ? { render: compiled.render } : {}),
      });
      continue;
    }

    const raw = await readJson<unknown>(sf);
    const kind =
      raw && typeof raw === "object" && "kind" in raw
        ? (raw as { kind?: unknown }).kind
        : undefined;
    if (kind === "quillbind-pdf-page") {
      const parsed = pdfPageFileSchema.safeParse(raw);
      if (!parsed.success) {
        fail("PDF_SHARD_INVALID", `${sf}: ${parsed.error.message}`);
      }
      const pageFile: PdfPageFile = parsed.data;
      if (pageFile.sourceSha256 !== base.source.sha256) {
        fail(
          "SOURCE_HASH_MISMATCH",
          `Page file ${sf} sourceSha256 (${pageFile.sourceSha256}) does not match base spec (${base.source.sha256})`,
        );
      }
      registerMergedPage(pageFile.page);
    } else {
      const parsed = pdfShardFileSchema.safeParse(raw);
      if (!parsed.success) {
        fail("PDF_SHARD_INVALID", `${sf}: ${parsed.error.message}`);
      }
      const shardData = parsed.data;
      if (shardData.sourceSha256 !== base.source.sha256) {
        fail(
          "SOURCE_HASH_MISMATCH",
          `Shard ${sf} sourceSha256 (${shardData.sourceSha256}) does not match base spec (${base.source.sha256})`,
        );
      }
      for (const p of shardData.pages) {
        if (
          p.page < shardData.shard.pageStart ||
          p.page > shardData.shard.pageEnd
        ) {
          fail(
            "PDF_SHARD_RANGE",
            `Shard ${shardData.shard.id} contains out-of-slice page ${p.page} (expected ${shardData.shard.pageStart}..${shardData.shard.pageEnd})`,
          );
        }
        registerMergedPage(p);
      }
    }
  }

  for (const expectedPage of base.pages) {
    if (!byPage.has(expectedPage.page)) {
      fail(
        "PDF_SHARD_GAP",
        `Missing page ${expectedPage.page} in merged shards`,
      );
    }
  }

  const mergedPages = [...byPage.values()].sort((a, b) => a.page - b.page);
  stitchPdfPagesInPlace(mergedPages);

  // Enforce global footnote ID uniqueness and valid table grids before emitting merged spec.
  const fnIssues = validateSpecFootnotes(mergedPages, {
    checkPairing: false,
  }).filter((d) => d.severity === "error");
  if (fnIssues.length > 0) {
    fail(fnIssues[0].code, fnIssues.map((i) => i.message).join("; "), fnIssues);
  }
  const tableIssues = mergedPages.flatMap((p) =>
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

  const mergedSpec: PdfSpec = pdfSpecSchema.parse({
    ...base,
    pages: mergedPages,
  });
  await fs.writeFile(outPath, JSON.stringify(mergedSpec, null, 2) + "\n", {
    flag: "wx",
  });
  const unverifiedPages = mergedSpec.pages
    .filter((p) => pageRequiresOcrVerification(p) && !p.verification)
    .map((p) => p.page);
  return {
    status: "pass",
    operation: "pdf-merge-shards",
    output: outPath,
    mergedInputs: inputFiles.length,
    pageCount: mergedSpec.pages.length,
    unverifiedPages,
  };
}

function normalizedEditDistanceRatio(a: string, b: string): number {
  const norm = (s: string) => s.replace(/\s+/gu, "").slice(0, 1200);
  const s1 = Array.from(norm(a));
  const s2 = Array.from(norm(b));
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 0;
  let prev = new Int32Array(s2.length + 1);
  let curr = new Int32Array(s2.length + 1);
  for (let j = 0; j <= s2.length; j++) prev[j] = j;
  for (let i = 1; i <= s1.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return Math.round((prev[s2.length] / maxLen) * 10000) / 10000;
}

function detectCharsetAnomalies(text: string): string[] {
  const anomalies: string[] = [];
  const puaCount = (text.match(/[\uE000-\uF8FF]/gu) ?? []).length;
  if (puaCount > 0) {
    anomalies.push(`Private-use area (PUA) characters detected (${puaCount})`);
  }
  const replCount = (text.match(/\uFFFD/gu) ?? []).length;
  if (replCount > 0) {
    anomalies.push(
      `Unicode replacement characters U+FFFD detected (${replCount})`,
    );
  }
  const kangxiCount = (text.match(/[\u2F00-\u2FDF]/gu) ?? []).length;
  if (kangxiCount > 0) {
    anomalies.push(`Unnormalized Kangxi radicals detected (${kangxiCount})`);
  }
  const simpHits = (text.match(SIMPLIFIED_MARKERS) ?? []).length;
  const tradHits = (text.match(TRADITIONAL_MARKERS) ?? []).length;
  if (simpHits >= 2 && tradHits >= 2) {
    anomalies.push(
      `Mixed Simplified (${simpHits}) and Traditional (${tradHits}) Chinese markers on same page`,
    );
  }
  const halfwidthInCjk = (
    text.match(/[\u4E00-\u9FFF][,.;:?!][\u4E00-\u9FFF]/gu) ?? []
  ).length;
  if (halfwidthInCjk >= 2) {
    anomalies.push(
      `Halfwidth ASCII punctuation embedded directly inside CJK text (${halfwidthInCjk})`,
    );
  }
  return anomalies;
}

/**
 * Compute cheap deterministic per-page QA signals (projection line count, ink-area char estimate,
 * edit distance vs hidden OCR draft, charset/script anomalies, table grid validity, footnote pairing,
 * and verification record checks) to focus verifier review.
 */
export async function checkPdfSpec(
  specInput: string | PdfSpec,
  options: {
    renderManifest?: string | PdfRenderManifest;
    verification?: string | PdfVerificationFile;
  } = {},
): Promise<PdfCheckReport> {
  const rawSpec =
    typeof specInput === "string"
      ? await readJson<unknown>(path.resolve(specInput))
      : specInput;
  const spec = pdfSpecSchema.parse(rawSpec);

  const manifest: PdfRenderManifest | undefined = options.renderManifest
    ? typeof options.renderManifest === "string"
      ? pdfRenderManifestSchema.parse(
          await readJson<unknown>(path.resolve(options.renderManifest)),
        )
      : pdfRenderManifestSchema.parse(options.renderManifest)
    : spec.renderManifestPath && (await exists(spec.renderManifestPath))
      ? pdfRenderManifestSchema.parse(
          await readJson<unknown>(spec.renderManifestPath),
        )
      : undefined;

  const verification: PdfVerificationFile | undefined = options.verification
    ? typeof options.verification === "string"
      ? pdfVerificationFileSchema.parse(
          await readJson<unknown>(path.resolve(options.verification)),
        )
      : pdfVerificationFileSchema.parse(options.verification)
    : undefined;

  const manifestByPage = new Map(
    (manifest?.pages ?? []).map((p) => [p.page, p]),
  );
  const globalErrors: PdfDiagnostic[] = [];
  const globalWarnings: PdfDiagnostic[] = [];

  const fnDiagnostics = validateSpecFootnotes(spec.pages, {
    checkPairing: true,
  });
  const verDiagnostics = verification
    ? verifyPdfSpecPages(spec, { verification, renderManifest: manifest })
    : [];

  const pageSignals: PdfPageQaSignal[] = [];

  for (const page of spec.pages) {
    const errors: PdfDiagnostic[] = [];
    const warnings: PdfDiagnostic[] = [];

    for (const d of [...fnDiagnostics, ...verDiagnostics]) {
      if (d.page !== page.page) continue;
      if (d.severity === "error") errors.push(d);
      else warnings.push(d);
    }

    for (const b of page.blocks) {
      if (b.kind === "table") {
        errors.push(...validateTableGrid(b, { page: page.page }));
      }
    }

    const transcribedLines = collectPageTranscribedLines(page);
    const fullText = transcribedLines.join("\n");
    const transcribedCharCount = fullText.replace(/\s+/gu, "").length;
    const charsetAnomalies = detectCharsetAnomalies(fullText);
    for (const anomaly of charsetAnomalies) {
      warnings.push({
        code: "PDF_QA_CHARSET_ANOMALY",
        severity: "warning",
        page: page.page,
        message: anomaly,
      });
    }

    const renderPath = manifestByPage.get(page.page)?.path ?? page.render?.path;
    let projectionLineCount: number | undefined;
    let estimatedCharsFromInk: number | undefined;
    if (renderPath && (await exists(renderPath))) {
      const proj = await detectLineGeometryFromImage(
        renderPath,
        page.widthPt,
        page.heightPt,
      );
      projectionLineCount = proj.geometry.length;
      estimatedCharsFromInk = proj.estimatedChars;
      if (
        projectionLineCount >= 4 &&
        transcribedLines.length > 0 &&
        Math.abs(projectionLineCount - transcribedLines.length) /
          projectionLineCount >
          0.45
      ) {
        warnings.push({
          code: "PDF_QA_LINE_COUNT_DRIFT",
          severity: "warning",
          page: page.page,
          message: `Page ${page.page} projection detected ${projectionLineCount} lines vs ${transcribedLines.length} transcribed blocks/lines`,
        });
      }
      if (
        estimatedCharsFromInk >= 30 &&
        (transcribedCharCount < estimatedCharsFromInk * 0.35 ||
          transcribedCharCount > estimatedCharsFromInk * 2.5)
      ) {
        warnings.push({
          code: "PDF_QA_CHAR_COUNT_DRIFT",
          severity: "warning",
          page: page.page,
          message: `Page ${page.page} ink estimate ~${estimatedCharsFromInk} chars vs ${transcribedCharCount} transcribed chars`,
        });
      }
    }

    let rawOcrEditDistanceRatio: number | undefined;
    if (page.rawOcrDraft && page.rawOcrDraft.trim()) {
      rawOcrEditDistanceRatio = normalizedEditDistanceRatio(
        page.rawOcrDraft,
        fullText,
      );
      if (rawOcrEditDistanceRatio > 0.45) {
        warnings.push({
          code: "PDF_QA_OCR_DIFF_HIGH",
          severity: "warning",
          page: page.page,
          message: `Page ${page.page} edit distance vs embedded OCR draft is ${(rawOcrEditDistanceRatio * 100).toFixed(1)}% (review for omission or rewrite)`,
        });
      }
    }

    const unresolvedCount = page.transcription?.unresolved.length ?? 0;
    if (unresolvedCount > 0) {
      errors.push({
        code: "PDF_UNRESOLVED_ITEMS",
        severity: "error",
        page: page.page,
        message: `Page ${page.page} has ${unresolvedCount} unresolved transcription item(s)`,
      });
    }

    pageSignals.push({
      page: page.page,
      classification: page.classification,
      ocrTrust: page.ocrTrust,
      requiresVerification: pageRequiresOcrVerification(page),
      transcribedLineCount: transcribedLines.length,
      transcribedCharCount,
      ...(projectionLineCount !== undefined ? { projectionLineCount } : {}),
      ...(estimatedCharsFromInk !== undefined ? { estimatedCharsFromInk } : {}),
      ...(rawOcrEditDistanceRatio !== undefined
        ? { rawOcrEditDistanceRatio }
        : {}),
      unresolvedCount,
      charsetAnomalies,
      warnings,
      errors,
    });
    globalErrors.push(...errors);
    globalWarnings.push(...warnings);
  }

  for (const d of [...fnDiagnostics, ...verDiagnostics]) {
    if (d.page !== undefined) continue;
    if (d.severity === "error") globalErrors.push(d);
    else globalWarnings.push(d);
  }

  return {
    schemaVersion: PDF_SPEC_SCHEMA_VERSION,
    operation: "pdf-check-spec",
    status: globalErrors.length === 0 ? "pass" : "fail",
    pageCount: spec.pages.length,
    pages: pageSignals,
    errors: globalErrors,
    warnings: globalWarnings,
  };
}
