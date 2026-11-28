import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import zlib from "node:zlib";
import sharp from "sharp";
import {
  BILINGUAL_SCHEMA_VERSION,
  PDF_SPEC_SCHEMA_VERSION,
  computePageContentSha256,
  type PdfSpec,
  type PdfVerificationFile,
  type TranslationMergedFile,
  type TranslationPlan,
  type TranslationVerificationFile,
} from "../packages/core/src/index.js";
import { noteFixture } from "../tests/note-fixture.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const skill = path.resolve(repoRoot, "../../skills/quillbind");
const execute = promisify(execFile);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await fs.readFile(file, "utf8")) as T;
const json = async (file: string, value: unknown) =>
  fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");

interface TraceEntry {
  args: string[];
  exitCode: number;
  durationMs: number;
  output: unknown;
}

interface ScenarioContext {
  scenarioId: string;
  root: string;
  raw: string;
  config: string;
  output: string;
  epub: string;
  sourceBefore: Record<string, string>;
  trace: TraceEntry[];
  evidence: string[];
  setEnvironment: (dir: string) => void;
  invoke: (args: string[], exitCode?: number) => Promise<any>;
  prepare: () => Promise<any>;
}

const catalog = await readJson<{
  scenarios: { id: string; prompt: string; expected: string[] }[];
}>(path.join(repoRoot, "tests/skill-evals/scenarios.json"));
const destination = path.join(repoRoot, "dist/skill-evals");
await fs.mkdir(destination, { recursive: true });
const results: {
  id: string;
  status: string;
  trace: TraceEntry[];
  evidence: string[];
  error?: string;
  workspace?: string;
}[] = [];

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    const entries = await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    await Promise.all(
      entries.map(async (entry) => {
        const name = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) {
          await visit(name);
        } else if (entry.isFile()) {
          files[name] = sha256(await fs.readFile(path.join(root, name)));
        } else {
          files[name] = `symlink:${await fs.readlink(path.join(root, name))}`;
        }
      }),
    );
  }
  await visit("");
  return files;
}

async function runtimeWithoutTools(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  const copiedEntries = [
    "package.json",
    "tsconfig.json",
    "bin",
    "standards",
    "styles",
    "packages/core/src",
    "packages/core/package.json",
    "packages/cli/src",
    "packages/cli/package.json",
  ];
  await Promise.all(
    copiedEntries.map(async (file) => {
      await fs.mkdir(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      await fs.cp(path.join(repoRoot, file), path.join(directory, file), {
        recursive: true,
      });
    }),
  );
  await fs.cp(skill, path.resolve(directory, "../../skills/quillbind"), {
    recursive: true,
  });
  await Promise.all(
    ["node_modules", "packages/core/node_modules"].map((relative) =>
      fs.symlink(
        path.join(repoRoot, relative),
        path.join(directory, relative),
        "dir",
      ),
    ),
  );
  // Resolve the copied CLI to its copied core; only third-party dependencies are shared.
  const scope = path.join(directory, "packages/cli/node_modules/@quillbind");
  await fs.mkdir(scope, { recursive: true });
  await fs.symlink(
    path.join(directory, "packages/core"),
    path.join(scope, "core"),
    "dir",
  );
}

async function runInspectScenario(ctx: ScenarioContext): Promise<boolean> {
  const before = await snapshot(ctx.root);
  const inspection = await ctx.invoke(["inspect", ctx.epub]);
  assert.equal(inspection.summary.validation, "not-run");
  assert.ok(
    inspection.navigation.some(
      (nav: any) => nav.format === "ncx" && nav.items.length,
    ),
  );
  assert.ok(
    inspection.metadata.records.some(
      (record: any) => record.value === "Example Translator",
    ),
  );
  if (ctx.scenarioId === "no-rebuild")
    await ctx.invoke(["epub", "audit", ctx.epub]);
  assert.deepEqual(await snapshot(ctx.root), before);
  assert.ok(
    ctx.trace.every(
      (call) => !call.args.includes("build") && !call.args.includes("repair"),
    ),
  );
  ctx.evidence.push(
    "Original EPUB and entire input tree unchanged",
    "Original bibliography and NCX returned; validation marked not-run",
  );
  return false;
}

async function runBlogPreparationScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  const preparation = await ctx.prepare();
  assert.equal(preparation.readiness.metadata, "pass");
  assert.equal(preparation.readiness.release, "not-run");
  await Promise.all(
    preparation.copiedFiles.map(async (item: { path: string }) => {
      assert.equal(
        sha256(await fs.readFile(path.join(ctx.output, item.path))),
        ctx.sourceBefore[item.path],
      );
    }),
  );
  const preflight = await ctx.invoke(["preflight", ctx.output]);
  assert.equal(preflight.documents[0].footnotes[0].references.length, 2);
  assert.deepEqual(
    preflight.documents.map((doc: { source: string }) => doc.source),
    ["posts/first.md", "posts/second.md"],
  );
  assert.ok(!JSON.stringify(preflight).includes("EVAL_PRIVATE_FIELD"));
  assert.ok(!JSON.stringify(preparation).includes("EVAL_PRIVATE_FIELD"));
  const preview = await ctx.invoke(["preview", ctx.output]);
  assert.equal(preview.status, "preview");
  assert.equal(preview.releaseGates, "not-run");
  assert.equal(preview.publicationReady, false);
  assert.equal(
    sha256(await fs.readFile(preview.candidate.path)),
    preview.candidate.sha256,
  );
  await assert.rejects(fs.stat(path.join(ctx.output, "dist/book.epub")));
  const inspection = await ctx.invoke(["inspect", preview.candidate.path]);
  assert.ok(!JSON.stringify(inspection).includes("EVAL_PRIVATE_FIELD"));
  const metadata = await ctx.invoke(["metadata", "resolve", ctx.output]);
  assert.deepEqual(metadata.metadata.publication, { isbn: null });
  assert.equal(metadata.metadata.identifier.scheme, "uuid");
  assert.ok(
    !(await readJson<any>(path.join(ctx.output, "metadata/decisions.json")))
      .isbn,
  );
  ctx.evidence.push(
    "One init call produced a schema-valid project with explicit chapter order",
    "Copied Markdown/SVG hashes match originals",
    "Repeated notes, Properties whitelist and UUID metadata verified in parsed/output data",
  );
  return false;
}

async function runAuthorPreviewScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  await ctx.prepare();
  const environment = path.join(
    ctx.root,
    "runtime-without-tools/tools/quillbind",
  );
  ctx.setEnvironment(environment);
  await runtimeWithoutTools(environment);
  const dist = path.join(ctx.output, "dist");
  await fs.mkdir(path.join(dist, "reports"), { recursive: true });
  await fs.writeFile(path.join(dist, "book.epub"), "previous release");
  await json(path.join(dist, "reports/summary.json"), {
    runId: "previous-release",
    status: "pass",
  });
  const before = await snapshot(dist);
  const preview = await ctx.invoke(["preview", ctx.output]);
  assert.equal(preview.status, "preview");
  assert.equal(preview.publicationReady, false);
  assert.equal(preview.releaseGates, "not-run");
  assert.equal(
    preview.candidate.path,
    path.join(await fs.realpath(ctx.output), "dist/preview/candidate.epub"),
  );
  assert.equal(
    sha256(await fs.readFile(preview.candidate.path)),
    preview.candidate.sha256,
  );
  assert.equal(
    (await ctx.invoke(["inspect", preview.candidate.path, "--summary"]))
      .validation,
    "not-run",
  );
  const after = await snapshot(dist);
  assert.equal(after["preview/candidate.epub"], preview.candidate.sha256);
  delete after["preview/candidate.epub"];
  assert.deepEqual(after, before);
  ctx.evidence.push(
    "Preview succeeded without pinned release validators and reported publicationReady false with releaseGates not-run",
    "Candidate path, SHA-256 and read-only EPUB inspection verified",
    "Previous release artifact and complete reports tree unchanged; only the preview candidate was added",
  );
  return false;
}

async function runMissingValidatorScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  await ctx.prepare();
  const environment = path.join(
    ctx.root,
    "runtime-without-tools/tools/quillbind",
  );
  ctx.setEnvironment(environment);
  await runtimeWithoutTools(environment);
  assert.equal(
    (await ctx.invoke(["inspect", ctx.epub, "--summary"])).validation,
    "not-run",
  );
  const previous = Buffer.from("previous artifact remains protected");
  await fs.mkdir(path.join(ctx.output, "dist"));
  await fs.writeFile(path.join(ctx.output, "dist/book.epub"), previous);
  const failure = await ctx.invoke(["build", ctx.output], 1);
  assert.equal(failure.code, "ENVIRONMENT_ERROR");
  const summary = await readJson<any>(failure.reports.summaryJson);
  assert.equal(summary.status, "fail");
  assert.equal(summary.artifact, undefined);
  assert.equal(summary.checks.environment.status, "fail");
  assert.equal(summary.checks.conformance.status, "not-run");
  assert.equal(summary.checks.browser.status, "not-run");
  assert.deepEqual(
    await fs.readFile(path.join(ctx.output, "dist/book.epub")),
    previous,
  );
  ctx.evidence.push(
    "Inspection succeeded in a runtime with no pinned validators",
    "Build returned ENVIRONMENT_ERROR and current-run not-run checks",
    "Earlier artifact was preserved and not claimed as a release",
  );
  return false;
}

async function runUnsupportedInputScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  const tex = path.join(ctx.root, "original.tex");
  await fs.writeFile(
    tex,
    "\\documentclass{book}\n\\begin{document}Evaluation input only\\end{document}\n",
  );
  const before = sha256(await fs.readFile(tex));
  const formats = await ctx.invoke(["formats"]);
  assert.ok(!formats.inputs.includes("latex"));
  assert.ok(formats.inputs.includes("pdf"));
  const failure = await ctx.invoke(
    ["init", ctx.output, "--from", tex, "--config", ctx.config],
    1,
  );
  assert.equal(failure.code, "UNSUPPORTED_FORMAT");
  assert.equal(sha256(await fs.readFile(tex)), before);
  await assert.rejects(fs.stat(ctx.output));
  ctx.evidence.push(
    "Unsupported LaTeX source rejected with a nonzero exit; no output project or conversion claim",
  );
  return false;
}

function buildMinimalScannedEvalPdf(): Buffer {
  const imgRaw = zlib.deflateSync(Buffer.alloc(120 * 160 * 3, 0xee));
  const objects = new Map<number, Buffer>();
  objects.set(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
  objects.set(
    2,
    Buffer.from(
      "<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 595 842] >>",
      "latin1",
    ),
  );
  objects.set(
    3,
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
      "latin1",
    ),
  );
  objects.set(
    4,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 120 /Height 160 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${imgRaw.length} >>\nstream\n`,
        "latin1",
      ),
      imgRaw,
      Buffer.from("\nendstream", "latin1"),
    ]),
  );
  const contentRaw = zlib.deflateSync(
    Buffer.from("q 595 0 0 842 0 0 cm /Im1 Do Q", "latin1"),
  );
  objects.set(
    5,
    Buffer.concat([
      Buffer.from(
        `<< /Filter /FlateDecode /Length ${contentRaw.length} >>\nstream\n`,
        "latin1",
      ),
      contentRaw,
      Buffer.from("\nendstream", "latin1"),
    ]),
  );
  const header = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const chunks: Buffer[] = [header];
  let offset = header.length;
  const offsets = new Map<number, number>();
  for (const num of [1, 2, 3, 4, 5]) {
    offsets.set(num, offset);
    const wrapped = Buffer.concat([
      Buffer.from(`${num} 0 obj\n`, "latin1"),
      objects.get(num)!,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(wrapped);
    offset += wrapped.length;
  }
  const xrefLines = ["xref\n0 6\n0000000000 65535 f \n"];
  for (let i = 1; i <= 5; i++) {
    xrefLines.push(`${String(offsets.get(i)!).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(
    Buffer.from(xrefLines.join(""), "latin1"),
    Buffer.from(
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
      "latin1",
    ),
  );
  return Buffer.concat(chunks);
}

async function runPdfWorkflowScenario(ctx: ScenarioContext): Promise<boolean> {
  const pdfPath = path.join(ctx.root, "scanned.pdf");
  const pdfBytes = buildMinimalScannedEvalPdf();
  await fs.writeFile(pdfPath, pdfBytes);
  const sourceBefore = sha256(pdfBytes);

  const inspectRes = await ctx.invoke(["pdf", "inspect", pdfPath]);
  assert.equal(inspectRes.classification, "scanned");

  const baseSpecPath = path.join(ctx.root, "base.spec.json");
  const initRes = await ctx.invoke([
    "pdf",
    "init-spec",
    pdfPath,
    "--output",
    baseSpecPath,
  ]);
  assert.deepEqual(initRes.unverifiedPages, [1]);

  const blocked = await ctx.invoke(
    [
      "pdf",
      "build-epub",
      baseSpecPath,
      "--output",
      path.join(ctx.root, "blocked.epub"),
    ],
    1,
  );
  assert.equal(blocked.code, "PDF_OCR_VERIFICATION_REQUIRED");

  const coverRaw = path.join(ctx.root, "cover-raw.png");
  const coverRestored = path.join(ctx.root, "cover-restored.png");
  const coverReports = path.join(ctx.root, "enhance-reports");
  const coverCanvas = Buffer.alloc(160 * 240 * 3, 240);
  for (let y = 30; y < 210; y++) {
    for (let x = 25; x < 135; x++) {
      const idx = (y * 160 + x) * 3;
      coverCanvas[idx] = (x * 2) % 255;
      coverCanvas[idx + 1] = 80;
      coverCanvas[idx + 2] = (y * 2) % 255;
    }
  }
  await sharp(coverCanvas, { raw: { width: 160, height: 240, channels: 3 } })
    .png()
    .toFile(coverRaw);

  const enhanceRes = await ctx.invoke([
    "pdf",
    "enhance-image",
    coverRaw,
    "--output",
    coverRestored,
    "--denoise",
    "--sharpen",
    "--reports",
    coverReports,
  ]);
  assert.equal(enhanceRes.generativeRedraw, false);
  assert.ok((await fs.stat(enhanceRes.comparisonImage)).size > 0);

  const shardsDir = path.join(ctx.root, "shards");
  await ctx.invoke([
    "pdf",
    "shard-init",
    baseSpecPath,
    "--output",
    shardsDir,
    "--format",
    "md",
  ]);
  const baseSpec = await readJson<PdfSpec>(baseSpecPath);
  const renderPng = path.join(ctx.root, "p0001.png");
  await fs.copyFile(coverRaw, renderPng);
  const renderSha = sha256(await fs.readFile(renderPng));

  const editedDir = path.join(ctx.root, "edited-pages");
  await fs.mkdir(editedDir, { recursive: true });
  await fs.writeFile(
    path.join(editedDir, "p0001.md"),
    `---
page: 1
sourceSha256: "${baseSpec.source.sha256}"
transcribedBy: "worker-eval"
renderPath: "${renderPng}"
renderSha256: "${renderSha}"
dpi: 300
tilesReviewed: []
unresolved: []
---

# 第一章 山径

清风入林，泉水潺潺[^1]。

[^1]: 经独立核验的扫描页脚注。
`,
  );

  const mergedPath = path.join(ctx.root, "merged.spec.json");
  await ctx.invoke([
    "pdf",
    "merge-shards",
    baseSpecPath,
    "--shards",
    editedDir,
    "--output",
    mergedPath,
  ]);

  const mergedSpec = await readJson<PdfSpec>(mergedPath);
  mergedSpec.metadata.title = "扫描重建样本";
  mergedSpec.metadata.authors = ["测试作者"];
  mergedSpec.metadata.publisher = "测试出版社";
  mergedSpec.frontmatter.coverImage = coverRestored;
  mergedSpec.frontmatter.includeColophon = true;
  mergedSpec.frontmatter.colophon = {
    publisher: "测试出版社",
    copyright: "© 2026 测试出版社",
    lines: [],
  };
  await json(mergedPath, mergedSpec);

  const verPath = path.join(ctx.root, "verification.json");
  const verPayload: PdfVerificationFile = {
    schemaVersion: PDF_SPEC_SCHEMA_VERSION,
    kind: "quillbind-pdf-verification",
    sourceSha256: mergedSpec.source.sha256,
    verifierId: "verifier-eval",
    verifiedAt: "2026-11-21T00:00:00Z",
    pages: [
      {
        page: 1,
        renderSha256: renderSha,
        dpi: 300,
        tilesReviewed: [],
        transcribedBy: "worker-eval",
        verifiedBy: "verifier-eval",
        contentSha256: computePageContentSha256(mergedSpec.pages[0]),
        status: "verified",
        unresolved: [],
      },
    ],
  };
  await json(verPath, verPayload);

  const outEpub = path.join(ctx.root, "rebuilt.epub");
  const built = await ctx.invoke([
    "pdf",
    "build-epub",
    mergedPath,
    "--verification",
    verPath,
    "--output",
    outEpub,
  ]);
  assert.equal(built.status, "pass");
  assert.deepEqual(built.frontmatterSpine, [
    "EPUB/cover.xhtml",
    "EPUB/titlepage.xhtml",
    "EPUB/colophon.xhtml",
    "EPUB/toc.xhtml",
  ]);
  assert.equal(built.colophonExcludedFromToc, true);
  assert.equal(built.validation.status, "pass");

  const inspectedEpub = await ctx.invoke(["inspect", outEpub]);
  assert.ok(
    !JSON.stringify(inspectedEpub.navigation).includes("colophon.xhtml"),
  );
  const validated = await ctx.invoke(["validate", outEpub]);
  assert.equal(validated.status, "pass");

  const repairedPdf = path.join(ctx.root, "repaired.pdf");
  const backupPdf = path.join(ctx.root, "scanned.backup.pdf");
  const repairRes = await ctx.invoke([
    "pdf",
    "repair-ocr",
    pdfPath,
    "--spec",
    mergedPath,
    "--verification",
    verPath,
    "--output",
    repairedPdf,
    "--backup",
    backupPdf,
  ]);
  assert.equal(repairRes.status, "pass");
  assert.equal(repairRes.incrementalUpdate, true);
  assert.equal(repairRes.ocrLayerVerified, true);
  assert.equal(repairRes.preservedImageStreams.verifiedBitIdentical, true);
  assert.equal(sha256(await fs.readFile(backupPdf)), sourceBefore);
  const repairedBytes = await fs.readFile(repairedPdf);
  assert.ok(repairedBytes.subarray(0, pdfBytes.length).equals(pdfBytes));
  assert.equal(sha256(await fs.readFile(pdfPath)), sourceBefore);

  ctx.evidence.push(
    "Unverified scanned PDF rejected with PDF_OCR_VERIFICATION_REQUIRED",
    "Independent verifier record enabled EPUB 3.3 rebuild with cover->titlepage->colophon->toc and colophon excluded from TOC",
    "Incremental PDF OCR repair preserved source prefix bytes and bit-identical image streams while verifying readback text",
    "Deterministic image enhancement produced comparison PNG without generative redraw; EPUBCheck passed and source PDF unchanged",
  );
  return false;
}

async function runScriptedNotesScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  const source = path.join(ctx.root, "scripted.epub");
  const reports = path.join(ctx.root, "notes-reports");
  const repaired = path.join(ctx.root, "reading.epub");
  const planPath = path.join(ctx.root, "reading-plan.json");
  const bytes = noteFixture();
  await fs.writeFile(source, bytes);
  const inspection = await ctx.invoke(["epub", "check-notes", source]);
  assert.equal(inspection.interactions.status, "not-run");
  assert.equal(inspection.notes.kind, "scripted-note-candidate");
  const before = await ctx.invoke([
    "epub",
    "check-notes",
    source,
    "--execute-scripts",
    "--reports",
    reports,
  ]);
  assert.equal(before.status, "pass");
  assert.equal(before.interactions.cases.length, 2);
  await ctx.invoke([
    "epub",
    "repair-plan",
    source,
    "--purpose",
    "reading",
    "--output",
    planPath,
  ]);
  const copy = await ctx.invoke([
    "epub",
    "repair-copy",
    source,
    "--plan",
    planPath,
    "--output",
    repaired,
  ]);
  assert.equal(copy.publicationReady, false);
  assert.equal(copy.checks.scriptedNotes, "not-run");
  assert.equal(copy.checks.sampledBrowser, "not-run");
  const after = await ctx.invoke([
    "epub",
    "check-notes",
    repaired,
    "--execute-scripts",
    "--reports",
    reports,
  ]);
  assert.equal(after.status, "pass");
  assert.ok(
    after.interactions.cases.every((c: any) =>
      c.checks.includes("focus-returned"),
    ),
  );
  assert.equal(sha256(await fs.readFile(source)), sha256(bytes));
  await fs.cp(reports, path.join(destination, "scripted-notes/reports"), {
    recursive: true,
  });
  ctx.evidence.push(
    "Static inspection did not execute scripts; actual click/keyboard checks passed before and after reading repair",
    "Reading-copy summary retained non-publication and unexecuted-script status; source hash unchanged",
  );
  return false;
}

async function runReleaseHandoffScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  await ctx.prepare();
  const release = await ctx.invoke(["build", ctx.output]);
  assert.equal(release.status, "pass");
  const summary = await readJson<any>(release.reports.summaryJson);
  assert.equal(summary.runId, release.runId);
  assert.equal(
    summary.artifact.sha256,
    sha256(await fs.readFile(release.artifact.path)),
  );
  assert.ok(
    Object.values(summary.checks).every(
      (check: any) => check.status === "pass",
    ),
  );
  assert.equal(summary.scope.nativeReaderTesting, "not-run");
  assert.equal(
    summary.checks.kindle.distribution,
    release.gates.kindle.distribution,
  );
  assert.ok((await fs.stat(release.reports.summaryMarkdown)).size > 0);
  await fs.cp(
    release.reports.directory,
    path.join(destination, "release-handoff/reports"),
    { recursive: true },
  );
  await fs.copyFile(
    release.artifact.path,
    path.join(destination, "release-handoff/book.epub"),
  );
  ctx.evidence.push(
    "All release gates ran through the actual Skill helper",
    "Artifact hash, runId, human summary, warnings and distribution results verified",
  );
  return true;
}

async function runBilingualTranslationScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  // Build a real EPUB 3.3 book via `preview`, then run the full zero-API-key bilingual workflow.
  await ctx.prepare();
  const prev = await ctx.invoke(["preview", ctx.output]);
  const srcEpub = prev.candidate.path as string;
  const srcBefore = sha256(await fs.readFile(srcEpub));

  const planPath = path.join(ctx.root, "translation-plan.json");
  const planOut = await ctx.invoke([
    "epub",
    "translate-plan",
    srcEpub,
    "--target-lang",
    "zh-Hans",
    "--output",
    planPath,
  ]);
  assert.equal(planOut.status, "pass");
  assert.ok(planOut.undecidedSignatures > 0);

  // Undecided plan MUST be blocked from shard-init
  const blockedShard = await ctx.invoke(
    [
      "epub",
      "translate-shard-init",
      planPath,
      "--output",
      path.join(ctx.root, "blocked-shards"),
    ],
    1,
  );
  assert.equal(blockedShard.code, "TRANSLATION_PLAN_UNDECIDED");

  // Coordinator classifies every signature against samples
  const plan = await readJson<TranslationPlan>(planPath);
  for (const row of plan.ledger) {
    row.action = row.key.endsWith(" #num") ? "skip" : "translate";
    row.decidedBy = "agent";
    row.contentType = row.key.endsWith(" #num")
      ? "folio-number"
      : "book-content";
  }
  await json(planPath, plan);

  const shardsDir = path.join(ctx.root, "shards");
  const shardInit = await ctx.invoke([
    "epub",
    "translate-shard-init",
    planPath,
    "--format",
    "md",
    "--output",
    shardsDir,
  ]);
  assert.equal(shardInit.status, "pass");

  // Worker subagents fill per-shard Markdown files preserving inline markers
  const unitById = new Map(plan.units.map((u) => [u.id, u]));
  for (const [idx, s] of (shardInit.shards as { file: string }[]).entries()) {
    let md = await fs.readFile(s.file, "utf8");
    md = md.replace(
      'translatedBy: ""',
      `translatedBy: "worker-eval-${idx + 1}"`,
    );
    md = md.replace(
      /^(:{3,})target\{id="([^"]+)"\}\n\1$/gmu,
      (_, fence: string, uid: string) => {
        const unit = unitById.get(uid)!;
        const markers = unit.markers.map((m) => m.token).join(" ");
        return `${fence}target{id="${uid}"}\n中文双语译文（${uid}）${markers ? ` ${markers}` : ""}。\n${fence}`;
      },
    );
    await fs.writeFile(s.file, md, "utf8");
  }

  const valOut = await ctx.invoke([
    "epub",
    "translate-validate-shard",
    shardsDir,
    "--plan",
    planPath,
  ]);
  assert.equal(valOut.status, "pass");

  const mergedPath = path.join(ctx.root, "translations.merged.json");
  const mergeOut = await ctx.invoke([
    "epub",
    "translate-merge",
    planPath,
    "--shards",
    shardsDir,
    "--output",
    mergedPath,
  ]);
  assert.equal(mergeOut.status, "pass");
  const merged = await readJson<TranslationMergedFile>(mergedPath);

  // Self-approved verification MUST fail
  const selfVerPath = path.join(ctx.root, "self-ver.json");
  await json(selfVerPath, {
    schemaVersion: BILINGUAL_SCHEMA_VERSION,
    kind: "quillbind-translation-verification",
    sourceSha256: merged.sourceSha256,
    planSha256: merged.planSha256,
    verifierId: merged.shards[0].translatedBy,
    verifiedAt: "2026-11-28T00:00:00Z",
    shards: merged.shards.map((s) => ({
      shardId: s.shardId,
      translatedBy: s.translatedBy,
      verifiedBy: s.translatedBy,
      contentSha256: s.contentSha256,
      status: "verified",
      unresolved: [],
    })),
  } satisfies TranslationVerificationFile);
  const selfCheck = await ctx.invoke(
    [
      "epub",
      "translate-check",
      mergedPath,
      "--plan",
      planPath,
      "--verification",
      selfVerPath,
    ],
    1,
  );
  assert.equal(selfCheck.status, "fail");

  // Independent verifier signs off and build passes EPUBCheck + reading QA
  const verPath = path.join(ctx.root, "verification.json");
  await json(verPath, {
    schemaVersion: BILINGUAL_SCHEMA_VERSION,
    kind: "quillbind-translation-verification",
    sourceSha256: merged.sourceSha256,
    planSha256: merged.planSha256,
    verifierId: "verifier-eval",
    verifiedAt: "2026-11-28T00:00:00Z",
    shards: merged.shards.map((s) => ({
      shardId: s.shardId,
      translatedBy: s.translatedBy,
      verifiedBy: "verifier-eval",
      contentSha256: s.contentSha256,
      status: "verified",
      unresolved: [],
    })),
  } satisfies TranslationVerificationFile);
  const goodCheck = await ctx.invoke([
    "epub",
    "translate-check",
    mergedPath,
    "--plan",
    planPath,
    "--verification",
    verPath,
  ]);
  assert.equal(goodCheck.status, "pass");

  const outEpub = path.join(ctx.root, "bilingual.epub");
  const built = await ctx.invoke([
    "epub",
    "translate-build",
    srcEpub,
    "--plan",
    planPath,
    "--translations",
    mergedPath,
    "--verification",
    verPath,
    "--output",
    outEpub,
  ]);
  assert.equal(built.status, "pass");
  assert.equal(built.reproducible, true);
  assert.equal(built.validation.status, "pass");
  assert.equal(built.reading.status, "pass");
  assert.equal(sha256(await fs.readFile(srcEpub)), srcBefore);

  ctx.evidence.push(
    "Undecided translation plan blocked before coordinator classification",
    "Worker Markdown shards round-tripped with atomic inline markers preserved",
    "Self-approved verification rejected; independent verifier record enabled verified bilingual EPUB build",
    "Bilingual EPUB passed internal validation, lintCss, EPUBCheck, and sampled reading QA with source unchanged",
  );
  return false;
}

const scenarioHandlers: Record<
  string,
  (ctx: ScenarioContext) => Promise<boolean>
> = {
  "inspect-only": runInspectScenario,
  "no-rebuild": runInspectScenario,
  "blog-preparation": runBlogPreparationScenario,
  "properties-whitelist": runBlogPreparationScenario,
  "isbn-null": runBlogPreparationScenario,
  "author-preview": runAuthorPreviewScenario,
  "missing-validator": runMissingValidatorScenario,
  "unsupported-input": runUnsupportedInputScenario,
  "pdf-workflow": runPdfWorkflowScenario,
  "bilingual-translation": runBilingualTranslationScenario,
  "scripted-notes": runScriptedNotesScenario,
  "release-handoff": runReleaseHandoffScenario,
};

async function runScenario(scenario: { id: string }): Promise<void> {
  const root = await fs.mkdtemp(
    path.join(
      scenario.id === "release-handoff" ? destination : os.tmpdir(),
      "quillbind-skill-eval-",
    ),
  );
  let retain = false;
  const trace: TraceEntry[] = [];
  const evidence: string[] = [];
  let environment = repoRoot;
  const invoke = async (args: string[], exitCode = 0): Promise<any> => {
    const started = performance.now();
    let actualExitCode = 0;
    const result = await execute(
      process.execPath,
      [path.join(skill, "scripts/quillbind.ts"), ...args, "--json"],
      {
        cwd: root,
        timeout: 600000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, QUILLBIND_ROOT: environment },
      },
    ).catch((error: unknown) => {
      const failure = error as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      if (typeof failure.code !== "number") throw error;
      actualExitCode = failure.code;
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    });
    let output: unknown;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Skill helper did not emit JSON: ${result.stderr}`);
    }
    trace.push({
      args,
      exitCode: actualExitCode,
      durationMs: performance.now() - started,
      output,
    });
    assert.equal(actualExitCode, exitCode, JSON.stringify(output));
    return output;
  };
  try {
    const raw = path.join(root, "raw");
    const config = path.join(root, "plan.yaml");
    const output = path.join(root, "book");
    const epub = path.join(root, "existing.epub");
    await fs.cp(path.join(repoRoot, "tests/skill-evals/fixtures/raw"), raw, {
      recursive: true,
    });
    await fs.copyFile(
      path.join(repoRoot, "tests/skill-evals/fixtures/book.yaml"),
      config,
    );
    await fs.copyFile(path.join(repoRoot, "examples/repair/legacy.epub"), epub);
    const sourceBefore = await snapshot(raw);
    const configBefore = sha256(await fs.readFile(config));
    const epubBefore = sha256(await fs.readFile(epub));
    const handler = scenarioHandlers[scenario.id];
    if (!handler) throw new Error(`Unimplemented scenario: ${scenario.id}`);
    retain = await handler({
      scenarioId: scenario.id,
      root,
      raw,
      config,
      output,
      epub,
      sourceBefore,
      trace,
      evidence,
      setEnvironment: (dir) => {
        environment = dir;
      },
      invoke,
      prepare: () =>
        invoke(["init", output, "--from", raw, "--config", config]),
    });
    assert.deepEqual(await snapshot(raw), sourceBefore);
    assert.equal(sha256(await fs.readFile(config)), configBefore);
    assert.equal(sha256(await fs.readFile(epub)), epubBefore);
    const result = {
      id: scenario.id,
      status: "pass",
      evidence,
      trace,
      ...(retain ? { workspace: root } : {}),
    };
    results.push(result);
    await json(path.join(destination, `${scenario.id}.json`), result);
    process.stdout.write(
      `${scenario.id}: pass (${trace.length} helper calls)\n`,
    );
  } catch (error) {
    const result = {
      id: scenario.id,
      status: "fail",
      error: String(error),
      evidence,
      trace,
    };
    results.push(result);
    await json(path.join(destination, `${scenario.id}.json`), result);
    process.stderr.write(`${scenario.id}: ${String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (!retain) await fs.rm(root, { recursive: true, force: true });
  }
}

let scenarioChain = Promise.resolve();
for (const scenario of catalog.scenarios) {
  scenarioChain = scenarioChain.then(() => runScenario(scenario));
}
await scenarioChain;

const report = {
  schemaVersion: 1,
  mode: "scripted-skill-workflows",
  helper: "../../skills/quillbind/scripts/quillbind.ts",
  node: process.versions.node,
  skillSha256: sha256(await fs.readFile(path.join(skill, "SKILL.md"))),
  status: process.exitCode ? "fail" : "pass",
  scenarios: results,
  independentAgentEvaluation: {
    status: "not-run",
    reason:
      "These runs execute explicit workflows; they do not measure an independent model choosing actions from the prompt.",
  },
};
await json(path.join(destination, "report.json"), report);
await fs.writeFile(
  path.join(destination, "report.md"),
  [
    "# Skill workflow evaluation",
    "",
    `Result: ${report.status}`,
    "",
    "Executed the real Skill helper in isolated fixtures. Assertions inspect command exits, parsed artifacts, source hashes and current-run reports.",
    "",
    ...results.map(
      (result) =>
        `- ${result.id}: ${result.status} (${result.trace.length} helper calls)`,
    ),
    "",
    "Independent agent selection: NOT RUN. The scenario catalog can be used for a separate agent run; these scripted workflows do not establish autonomous task selection or answer quality.",
    "",
  ].join("\n"),
);
