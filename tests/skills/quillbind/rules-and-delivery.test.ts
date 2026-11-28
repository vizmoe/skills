import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readBibliographyRules,
  readBilingualTranslationRules,
  readDeliveryRules,
  readNamingRules,
  readParallelWorkflowRules,
  readPdfRules,
  readWorkTypeTagRules,
} from "../../../skills/quillbind/scripts/skill-rules.ts";
import { installSkillCopy, runNode, sha256, SKILL_DIR } from "./support.ts";

const DELIVERY = path.join(SKILL_DIR, "scripts/delivery-audit.ts");
const NAMING = path.join(SKILL_DIR, "scripts/naming.ts");

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function runDeliveryCli(
  args: string[],
  options: { script?: string; cwd?: string } = {},
) {
  const res = await runNode([options.script ?? DELIVERY, ...args], {
    cwd: options.cwd,
  });
  const body = res.stdout.trim() || res.stderr.trim();
  return {
    rc: res.exitCode,
    payload: JSON.parse(body) as Record<string, any>,
  };
}

describe("reference rule table parser", () => {
  it("parses all reference rule tables and detects table mutations", async () => {
    const refsDir = path.join(SKILL_DIR, "references");
    const [tags, naming, bibliography, delivery, parallel, pdf, bilingual] =
      await Promise.all([
        readWorkTypeTagRules(refsDir),
        readNamingRules(refsDir),
        readBibliographyRules(refsDir),
        readDeliveryRules(refsDir),
        readParallelWorkflowRules(refsDir),
        readPdfRules(refsDir),
        readBilingualTranslationRules(refsDir),
      ]);

    expect(tags["light-novel"]).toEqual({
      required: "Literature.Light Novel",
      forbidden: ["Literature.Manga"],
    });
    expect(tags["art-book"]).toEqual({
      forbidden: ["Literature.Light Novel", "Literature.Manga"],
      requiresPrefix: "Arts.",
    });
    expect(naming.kinds).toEqual([
      "main",
      "side-story",
      "short-story-collection",
      "extra",
    ]);
    expect(naming.bases).toEqual([
      "official-unified",
      "official-subseries",
      "local-insertion",
    ]);
    expect(
      bibliography.isbnDispositions.unresolved?.requiresAttemptedSources,
    ).toBe(true);
    expect(
      bibliography.editionClasses["self-made"]?.requiresIdentification,
    ).toBe(true);
    expect(delivery.statuses.completed?.filesWritten).toBe(true);
    expect(delivery.statuses["plan-only"]?.filesWritten).toBe(false);
    expect(new Set(Object.keys(parallel.roles))).toEqual(
      new Set(["coordinator", "worker", "verifier"]),
    );
    expect(parallel.roles.verifier?.writeScope).toBe("read-only-reports");
    expect(parallel.roles.worker?.selfApproval).toBe(false);
    expect(parallel.roles.coordinator?.selfApproval).toBe(false);
    expect(pdf.frontmatter.map((item) => item.role)).toEqual([
      "cover",
      "titlepage",
      "colophon",
      "toc",
    ]);
    expect(
      pdf.frontmatter.find((item) => item.role === "colophon")?.tocInclusion,
    ).toBe("forbidden");
    expect(pdf.imageOperations["super-resolution"]?.allowed).toBe(true);
    expect(pdf.imageOperations["generative-redraw"]?.allowed).toBe(false);
    expect(bilingual.rules["external-api-key"]).toBe("forbidden");
    expect(bilingual.rules["default-mode"]).toBe("bilingual");
    expect(bilingual.rules["shard-execution"]).toBe("worker-subagent");
    expect(bilingual.rules["independent-verification"]).toBe(
      "verifier-required",
    );

    const tmp1 = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-rules-1-"));
    tempDirs.push(tmp1);
    const copied1 = path.join(tmp1, "references");
    await fs.cp(refsDir, copied1, { recursive: true });
    const tagsMd = path.join(copied1, "tags.md");
    await fs.writeFile(
      tagsMd,
      (await fs.readFile(tagsMd, "utf8")).replace(
        "| `manga` |",
        "| `comic-strip` |",
      ),
      "utf8",
    );
    await expect(readWorkTypeTagRules(copied1)).rejects.toMatchObject({
      code: "RULE_TABLE_INVALID",
    });

    const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-rules-2-"));
    tempDirs.push(tmp2);
    const copied2 = path.join(tmp2, "references");
    await fs.cp(refsDir, copied2, { recursive: true });
    const parallelMd = path.join(copied2, "parallel-workflow.md");
    await fs.writeFile(
      parallelMd,
      (await fs.readFile(parallelMd, "utf8")).replace(
        "| `worker` | `assigned-slice-only` | `forbidden` |",
        "| `worker` | `assigned-slice-only` | `allowed` |",
      ),
      "utf8",
    );
    await expect(readParallelWorkflowRules(copied2)).rejects.toMatchObject({
      code: "RULE_TABLE_INVALID",
    });

    const tmp3 = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-rules-3-"));
    tempDirs.push(tmp3);
    const copied3 = path.join(tmp3, "references");
    await fs.cp(refsDir, copied3, { recursive: true });
    const pdfMd = path.join(copied3, "pdf.md");
    await fs.writeFile(
      pdfMd,
      (await fs.readFile(pdfMd, "utf8")).replace(
        "| `3` | `colophon` | `EPUB/colophon.xhtml` | `after-titlepage` | `forbidden` |",
        "| `3` | `colophon` | `EPUB/colophon.xhtml` | `after-titlepage` | `optional` |",
      ),
      "utf8",
    );
    await expect(readPdfRules(copied3)).rejects.toMatchObject({
      code: "RULE_TABLE_INVALID",
    });

    const tmp4 = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-rules-4-"));
    tempDirs.push(tmp4);
    const copied4 = path.join(tmp4, "references");
    await fs.cp(refsDir, copied4, { recursive: true });
    const bilingualMd = path.join(copied4, "bilingual-translation.md");
    await fs.writeFile(
      bilingualMd,
      (await fs.readFile(bilingualMd, "utf8")).replace(
        "| `external-api-key` | `forbidden` |",
        "| `external-api-key` | `optional` |",
      ),
      "utf8",
    );
    await expect(readBilingualTranslationRules(copied4)).rejects.toMatchObject({
      code: "RULE_TABLE_INVALID",
    });
  });
});

describe("delivery audit helper", () => {
  it("protects Calibre sidecars using stat-only inspection for metadata.db", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "quillbind-delivery-sidecar-"),
    );
    tempDirs.push(root);
    const libraryDir = path.join(root, "Library");
    const bookDir = path.join(libraryDir, "Author Name", "Book Title (1)");
    await fs.mkdir(bookDir, { recursive: true });

    const dbFile = path.join(libraryDir, "metadata.db");
    await fs.writeFile(dbFile, "synthetic-calibre-db-placeholder");
    const opfFile = path.join(bookDir, "metadata.opf");
    await fs.writeFile(opfFile, "<package/>", "utf8");
    const coverFile = path.join(bookDir, "cover.jpg");
    await fs.writeFile(coverFile, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const bookFile = path.join(bookDir, "book.epub");
    const bookBytes = Buffer.from("synthetic-epub-archive");
    await fs.writeFile(bookFile, bookBytes);

    const snapPath = path.join(root, "before.json");
    const { rc, payload: snap } = await runDeliveryCli([
      "snapshot",
      "--path",
      bookFile,
      "--output",
      snapPath,
    ]);
    expect(rc).toBe(0);

    const [realDb, realOpf] = await Promise.all([
      fs.realpath(dbFile),
      fs.realpath(opfFile),
    ]);
    const byPath = Object.fromEntries(
      (snap.entries as Array<Record<string, any>>).map((e) => [e.path, e]),
    );
    expect(byPath[realDb]?.inspection).toBe("stat-only");
    expect(byPath[realDb]?.state).not.toHaveProperty("sha256");
    expect(byPath[realOpf]?.state?.sha256).toBe(sha256("<package/>"));

    const outFile = path.join(root, "out.epub");
    const outBytes = Buffer.from("verified-staged-and-final-epub");
    await fs.writeFile(outFile, outBytes);

    const report = {
      schemaVersion: 1,
      status: "completed",
      items: [
        {
          source: { path: bookFile, sha256: sha256(bookBytes) },
          staged: { path: outFile, sha256: sha256(outBytes) },
          final: { path: outFile, sha256: sha256(outBytes) },
          bookType: "light-novel",
          language: "zh-Hans",
          editionClass: "self-made",
          identificationEvidence: ["Title and colophon match Volume 1."],
          isbn: {
            disposition: "added",
            value: "9780306406157",
          },
          synopsis: {
            value: "少年与少女在边境重逢的故事。",
            sourceLanguage: "ja",
            translationSource:
              "https://bookwalker.jp/de00000000-0000-4000-8000-000000000001/",
          },
        },
      ],
    };
    const reportPath = path.join(root, "report.json");
    await fs.writeFile(reportPath, JSON.stringify(report), "utf8");
    const okRes = await runDeliveryCli([
      "audit",
      "--input",
      reportPath,
      "--before",
      snapPath,
    ]);
    expect(okRes.rc).toBe(0);
    expect(okRes.payload.ok).toBe(true);

    await fs.writeFile(opfFile, "<package modified='yes'/>", "utf8");
    const sidecarRes = await runDeliveryCli([
      "audit",
      "--input",
      reportPath,
      "--before",
      snapPath,
    ]);
    expect(sidecarRes.rc).toBe(1);
    expect(
      (sidecarRes.payload.issues as Array<{ code: string }>).map((i) => i.code),
    ).toContain("CALIBRE_SIDECAR_MODIFIED");
  });

  it("catches in-place backup, ISBN, edition, and synopsis violations", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "quillbind-delivery-violations-"),
    );
    tempDirs.push(root);
    const epub = path.join(root, "target.epub");
    const epubBytes = Buffer.from("updated-inplace-bytes");
    await fs.writeFile(epub, epubBytes);

    const badReport = {
      schemaVersion: 1,
      status: "completed",
      items: [
        {
          source: { path: epub, sha256: sha256("original-bytes") },
          final: { path: epub, sha256: sha256(epubBytes) },
          bookType: "light-novel",
          language: "zh-Hans",
          editionClass: "self-made",
          isbn: { disposition: "unresolved" },
          synopsis: {
            value: "自制录入本，未找到 ISBN。物語がはじまる。",
            sourceLanguage: "ja",
          },
        },
      ],
    };
    const reportPath = path.join(root, "bad-report.json");
    await fs.writeFile(reportPath, JSON.stringify(badReport), "utf8");
    const { rc, payload } = await runDeliveryCli([
      "audit",
      "--input",
      reportPath,
    ]);
    expect(rc).toBe(1);
    const codes = new Set(
      (payload.issues as Array<{ code: string }>).map((i) => i.code),
    );
    expect(codes).toEqual(
      new Set([
        "BACKUP_REQUIRED_FOR_INPLACE",
        "MISSING_ISBN_ATTEMPTED_SOURCES",
        "MISSING_IDENTIFICATION_EVIDENCE",
        "SYNOPSIS_CONTAINS_PROVENANCE",
        "MISSING_TRANSLATION_SOURCE",
        "UNTRANSLATED_JAPANESE_SYNOPSIS",
      ]),
    );
  });

  it("verifies real source hashes and destination collisions in naming plans", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "quillbind-delivery-naming-"),
    );
    tempDirs.push(root);
    const vol1 = path.join(root, "raw-1.epub");
    const vol2 = path.join(root, "raw-2.epub");
    await fs.writeFile(vol1, "volume-1");
    await fs.writeFile(vol2, "volume-2");

    const inv = {
      schemaVersion: 1,
      series: { name: "某系列", edition: "台版", evidence: ["Catalog"] },
      coverage: {
        mainComplete: true,
        extrasComplete: true,
        evidence: ["Complete"],
      },
      chronology: null,
      books: [
        {
          id: "v1",
          edition: "台版",
          kind: "main",
          originalTitle: "某系列 1",
          volumeTitle: null,
          firstPublished: "2020",
          source: { path: vol1, sha256: sha256("volume-1") },
          evidence: ["Vol 1"],
          official: {
            unified: { number: "1", evidence: ["Vol 1"] },
            subseries: null,
            unavailableEvidence: [],
          },
        },
        {
          id: "v2",
          edition: "台版",
          kind: "main",
          originalTitle: "某系列 2",
          volumeTitle: null,
          firstPublished: "2021",
          source: { path: vol2, sha256: sha256("volume-2") },
          evidence: ["Vol 2"],
          official: {
            unified: { number: "2", evidence: ["Vol 2"] },
            subseries: null,
            unavailableEvidence: [],
          },
        },
      ],
    };
    const invPath = path.join(root, "inv.json");
    const planPath = path.join(root, "plan.json");
    await fs.writeFile(invPath, JSON.stringify(inv), "utf8");
    const planRes = await runNode([
      NAMING,
      "plan",
      "--input",
      invPath,
      "--output",
      planPath,
    ]);
    expect(planRes.exitCode).toBe(0);

    const okRes = await runDeliveryCli(["verify-naming", "--plan", planPath]);
    expect(okRes.rc).toBe(0);
    expect(okRes.payload.sourceVerification).toBe("verified-on-disk");

    await fs.writeFile(
      path.join(root, "某系列 (01).epub"),
      "existing-collision",
    );
    await fs.writeFile(vol2, "mutated-volume-2");
    const badRes = await runDeliveryCli(["verify-naming", "--plan", planPath]);
    expect(badRes.rc).toBe(1);
    expect(
      new Set(
        (badRes.payload.issues as Array<{ code: string }>).map((i) => i.code),
      ),
    ).toEqual(new Set(["DESTINATION_EXISTS", "SOURCE_HASH_MISMATCH"]));
  });

  it("audits on-disk PDF import, verification, enhance, and repair evidence reports", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "quillbind-delivery-pdf-"),
    );
    tempDirs.push(root);

    const srcPdf = path.join(root, "scan.pdf");
    const outEpub = path.join(root, "rebuilt.epub");
    const outPdf = path.join(root, "repaired.pdf");
    const figOut = path.join(root, "fig-restored.png");
    const figCmp = path.join(root, "fig-restored.png.compare.png");
    await Promise.all([
      fs.writeFile(srcPdf, "%PDF-1.7\nsource-scan"),
      fs.writeFile(outEpub, "epub-bytes"),
      fs.writeFile(outPdf, "%PDF-1.7\nsource-scan\nrepaired"),
      fs.writeFile(figOut, "restored-figure-png"),
      fs.writeFile(figCmp, "compare-heatmap-png"),
    ]);
    const [srcSha, epubSha, repPdfSha, figSha, cmpSha] = await Promise.all([
      fs.readFile(srcPdf).then(sha256),
      fs.readFile(outEpub).then(sha256),
      fs.readFile(outPdf).then(sha256),
      fs.readFile(figOut).then(sha256),
      fs.readFile(figCmp).then(sha256),
    ]);

    const verPath = path.join(root, "verification.json");
    const verBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: "quillbind-pdf-verification",
        sourceSha256: srcSha,
        verifierId: "verifier-01",
        verifiedAt: "2026-11-21T00:00:00Z",
        pages: [
          {
            page: 1,
            renderSha256: "a".repeat(64),
            dpi: 300,
            tilesReviewed: ["p0001-band-01"],
            transcribedBy: "worker-01",
            verifiedBy: "verifier-01",
            contentSha256: "b".repeat(64),
            status: "verified",
            unresolved: [],
          },
        ],
      }),
    );
    await fs.writeFile(verPath, verBytes);
    const verSha = sha256(verBytes);

    const enhPath = path.join(root, "fig-restored.png.enhance.json");
    await fs.writeFile(
      enhPath,
      JSON.stringify({
        schemaVersion: 1,
        source: {
          path: srcPdf,
          sha256: srcSha,
          width: 100,
          height: 100,
          format: "png",
        },
        output: {
          path: figOut,
          sha256: figSha,
          width: 200,
          height: 200,
          format: "png",
        },
        comparisonImage: figCmp,
        comparisonImageSha256: cmpSha,
        operations: [
          "deskew:-1.2",
          "denoise:median3",
          "background-clean:normalize",
          "super-resolution:2x-lanczos3",
          "deblur:unsharp",
        ],
        multiScaleSsim: 0.92,
        edgeCorrelation: 0.9,
        aspectRatioDelta: 0.01,
        mode: "non-destructive-restoration",
        generativeRedraw: false,
      }),
    );

    const importRepPath = path.join(root, "pdf-import.json");
    await fs.writeFile(
      importRepPath,
      JSON.stringify({
        status: "pass",
        operation: "pdf-to-epub",
        source: srcPdf,
        sourceSha256: srcSha,
        output: outEpub,
        outputSha256: epubSha,
        frontmatterSpine: [
          "EPUB/cover.xhtml",
          "EPUB/titlepage.xhtml",
          "EPUB/colophon.xhtml",
          "EPUB/toc.xhtml",
        ],
        tocHrefs: ["EPUB/text/ch-001.xhtml"],
        colophonExcludedFromToc: true,
        figureProvenance: [
          { mode: "non-destructive-restoration", generativeRedraw: false },
        ],
        verification: {
          pagesRequiringVerification: [1],
          verifierId: "verifier-01",
          verificationFileSha256: verSha,
        },
        validation: { status: "pass" },
      }),
    );

    const repairRepPath = path.join(root, "pdf-repair.json");
    await fs.writeFile(
      repairRepPath,
      JSON.stringify({
        schemaVersion: 1,
        operation: "pdf-repair-ocr",
        status: "pass",
        source: { path: srcPdf, sha256: srcSha },
        output: { path: outPdf, sha256: repPdfSha },
        incrementalUpdate: true,
        ocrLayerVerified: true,
        preservedImageStreams: { count: 1, verifiedBitIdentical: true },
        verification: {
          pagesRequiringVerification: [1],
          verifierId: "verifier-01",
          verificationFileSha256: verSha,
        },
      }),
    );

    const goodDelivery = path.join(root, "good-pdf-delivery.json");
    await fs.writeFile(
      goodDelivery,
      JSON.stringify({
        schemaVersion: 1,
        status: "completed",
        items: [
          {
            source: { path: srcPdf, sha256: srcSha },
            final: { path: outEpub, sha256: epubSha },
            pdfImportReport: importRepPath,
            verificationReport: verPath,
            enhanceReports: [enhPath],
          },
          {
            source: { path: srcPdf, sha256: srcSha },
            final: { path: outPdf, sha256: repPdfSha },
            pdfRepairReport: repairRepPath,
            verificationReport: verPath,
          },
        ],
      }),
    );
    const okRes = await runDeliveryCli(["audit", "--input", goodDelivery]);
    expect(okRes.rc, JSON.stringify(okRes.payload)).toBe(0);
    expect(okRes.payload.ok).toBe(true);

    // Negative cases: self-reported unbacked PDF claims, self-approval, colophon in TOC, forbidden op, non-incremental repair
    const badVerPath = path.join(root, "bad-ver.json");
    await fs.writeFile(
      badVerPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "quillbind-pdf-verification",
        sourceSha256: srcSha,
        verifierId: "worker-01",
        verifiedAt: "2026-11-21T00:00:00Z",
        pages: [
          {
            page: 1,
            renderSha256: "a".repeat(64),
            dpi: 300,
            tilesReviewed: [],
            transcribedBy: "worker-01",
            verifiedBy: "worker-01",
            contentSha256: "b".repeat(64),
            status: "verified",
            unresolved: [{ reason: "blur" }],
          },
        ],
      }),
    );
    const badEnhPath = path.join(root, "bad.enhance.json");
    await fs.writeFile(
      badEnhPath,
      JSON.stringify({
        output: { path: figOut, sha256: "0".repeat(64) },
        comparisonImage: path.join(root, "missing-compare.png"),
        comparisonImageSha256: cmpSha,
        operations: ["generative-redraw:ai"],
        mode: "generative",
        generativeRedraw: true,
      }),
    );
    const badImportPath = path.join(root, "bad-import.json");
    await fs.writeFile(
      badImportPath,
      JSON.stringify({
        status: "pass",
        operation: "pdf-to-epub",
        sourceSha256: srcSha,
        output: outEpub,
        outputSha256: epubSha,
        frontmatterSpine: ["EPUB/toc.xhtml", "EPUB/colophon.xhtml"],
        tocHrefs: ["EPUB/colophon.xhtml"],
        colophonExcludedFromToc: false,
        validation: { status: "pass" },
        verification: { pagesRequiringVerification: [1] },
      }),
    );
    const badRepairPath = path.join(root, "bad-repair.json");
    await fs.writeFile(
      badRepairPath,
      JSON.stringify({
        operation: "pdf-repair-ocr",
        status: "pass",
        source: { path: srcPdf, sha256: srcSha },
        output: { path: outPdf, sha256: repPdfSha },
        incrementalUpdate: false,
        ocrLayerVerified: false,
        preservedImageStreams: { count: 1, verifiedBitIdentical: false },
      }),
    );
    const badDelivery = path.join(root, "bad-pdf-delivery.json");
    await fs.writeFile(
      badDelivery,
      JSON.stringify({
        schemaVersion: 1,
        status: "completed",
        items: [
          {
            source: { path: srcPdf, sha256: srcSha },
            final: { path: outEpub, sha256: epubSha },
            pdfConversion: { ocrVerified: true },
          },
          {
            source: { path: srcPdf, sha256: srcSha },
            final: { path: outEpub, sha256: epubSha },
            pdfImportReport: badImportPath,
            verificationReport: badVerPath,
            enhanceReports: [badEnhPath],
          },
          {
            source: { path: srcPdf, sha256: srcSha },
            final: { path: outPdf, sha256: repPdfSha },
            pdfRepairReport: badRepairPath,
          },
        ],
      }),
    );
    const badRes = await runDeliveryCli(["audit", "--input", badDelivery]);
    expect(badRes.rc).toBe(1);
    const codes = new Set(
      (badRes.payload.issues as Array<{ code: string }>).map((i) => i.code),
    );
    for (const expectedCode of [
      "PDF_EVIDENCE_REPORT_MISSING",
      "PDF_FRONTMATTER_ORDER_INVALID",
      "COLOPHON_IN_TOC",
      "PDF_SELF_APPROVAL_FORBIDDEN",
      "PDF_UNRESOLVED_ITEMS",
      "GENERATIVE_REDRAW_FORBIDDEN",
      "FORBIDDEN_IMAGE_OPERATION",
      "ENHANCE_OUTPUT_HASH_MISMATCH",
      "ENHANCE_COMPARISON_MISSING",
      "PDF_REPAIR_NOT_INCREMENTAL",
      "PDF_OCR_LAYER_UNVERIFIED",
      "PDF_IMAGE_STREAM_MUTATED",
    ]) {
      expect(
        codes.has(expectedCode),
        `Expected issue code ${expectedCode}`,
      ).toBe(true);
    }
  });

  it("audits on-disk bilingual EPUB translation and independent verification evidence", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "quillbind-delivery-bilingual-"),
    );
    tempDirs.push(root);

    const srcEpub = path.join(root, "source.epub");
    const outEpub = path.join(root, "bilingual.epub");
    await Promise.all([
      fs.writeFile(srcEpub, "source-epub-bytes"),
      fs.writeFile(outEpub, "bilingual-epub-bytes"),
    ]);
    const [srcSha, outSha] = await Promise.all([
      fs.readFile(srcEpub).then(sha256),
      fs.readFile(outEpub).then(sha256),
    ]);
    const planSha = "c".repeat(64);

    const verPath = path.join(root, "translation-verification.json");
    const verBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: "quillbind-translation-verification",
        sourceSha256: srcSha,
        planSha256: planSha,
        verifierId: "verifier-01",
        verifiedAt: "2026-11-28T00:00:00Z",
        shards: [
          {
            shardId: "shard-001",
            translatedBy: "worker-01",
            verifiedBy: "verifier-01",
            contentSha256: "d".repeat(64),
            status: "verified",
            unresolved: [],
          },
        ],
      }),
    );
    await fs.writeFile(verPath, verBytes);
    const verSha = sha256(verBytes);

    const repPath = path.join(root, "translation.json");
    await fs.writeFile(
      repPath,
      JSON.stringify({
        status: "pass",
        operation: "epub-translate-build",
        source: srcEpub,
        sourceSha256: srcSha,
        output: outEpub,
        outputSha256: outSha,
        planSha256: planSha,
        reproducible: true,
        validation: { status: "pass" },
        verification: {
          verifierId: "verifier-01",
          verificationFileSha256: verSha,
          shardCount: 1,
        },
      }),
    );

    const goodDelivery = path.join(root, "good-bilingual.json");
    await fs.writeFile(
      goodDelivery,
      JSON.stringify({
        schemaVersion: 1,
        status: "completed",
        items: [
          {
            source: { path: srcEpub, sha256: srcSha },
            final: { path: outEpub, sha256: outSha },
            translationReport: repPath,
            translationVerificationReport: verPath,
          },
        ],
      }),
    );
    const okRes = await runDeliveryCli(["audit", "--input", goodDelivery]);
    expect(okRes.rc, JSON.stringify(okRes.payload)).toBe(0);
    expect(okRes.payload.ok).toBe(true);

    // Negative cases: unbacked claim, self-approval, unresolved item, non-reproducible build
    const badVerPath = path.join(root, "bad-trans-ver.json");
    await fs.writeFile(
      badVerPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "quillbind-translation-verification",
        sourceSha256: srcSha,
        planSha256: planSha,
        verifierId: "worker-01",
        verifiedAt: "2026-11-28T00:00:00Z",
        shards: [
          {
            shardId: "shard-001",
            translatedBy: "worker-01",
            verifiedBy: "worker-01",
            contentSha256: "d".repeat(64),
            status: "rejected",
            unresolved: [{ reason: "idiom unclear" }],
          },
        ],
      }),
    );
    const badRepPath = path.join(root, "bad-translation.json");
    await fs.writeFile(
      badRepPath,
      JSON.stringify({
        status: "pass",
        operation: "epub-translate-build",
        source: srcEpub,
        sourceSha256: srcSha,
        output: outEpub,
        outputSha256: outSha,
        planSha256: planSha,
        reproducible: false,
        validation: { status: "fail" },
        verification: {
          verifierId: "worker-01",
          verificationFileSha256: "0".repeat(64),
        },
      }),
    );
    const badDelivery = path.join(root, "bad-bilingual.json");
    await fs.writeFile(
      badDelivery,
      JSON.stringify({
        schemaVersion: 1,
        status: "completed",
        items: [
          {
            source: { path: srcEpub, sha256: srcSha },
            final: { path: outEpub, sha256: outSha },
            bilingualTranslation: { mode: "bilingual" },
          },
          {
            source: { path: srcEpub, sha256: srcSha },
            final: { path: outEpub, sha256: outSha },
            translationReport: badRepPath,
            translationVerificationReport: badVerPath,
          },
        ],
      }),
    );
    const badRes = await runDeliveryCli(["audit", "--input", badDelivery]);
    expect(badRes.rc).toBe(1);
    const badCodes = new Set(
      (badRes.payload.issues as Array<{ code: string }>).map((i) => i.code),
    );
    for (const expectedCode of [
      "TRANSLATION_EVIDENCE_REPORT_MISSING",
      "TRANSLATION_NOT_REPRODUCIBLE",
      "TRANSLATION_VALIDATION_FAILED",
      "TRANSLATION_VERIFICATION_HASH_MISMATCH",
      "TRANSLATION_SELF_APPROVAL_FORBIDDEN",
      "TRANSLATION_SHARD_UNVERIFIED",
      "TRANSLATION_UNRESOLVED_ITEMS",
    ]) {
      expect(
        badCodes.has(expectedCode),
        `Expected issue code ${expectedCode}`,
      ).toBe(true);
    }
  });
});

describe("installed standalone delivery-audit helper", () => {
  it("runs standalone and refuses to overwrite existing snapshot outputs", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "quillbind-installed-delivery-"),
    );
    tempDirs.push(root);
    const installed = await installSkillCopy(root);
    const helper = path.join(installed, "scripts/delivery-audit.ts");
    const book = path.join(root, "sample.cbz");
    await fs.writeFile(book, "cbz-bytes");
    const snap = path.join(root, "snap.json");

    const first = await runNode(
      [helper, "snapshot", "--path", book, "--output", snap],
      { cwd: root },
    );
    expect(first.exitCode).toBe(0);

    const second = await runNode(
      [helper, "snapshot", "--path", book, "--output", snap],
      { cwd: root },
    );
    expect(second.exitCode).toBe(2);
    expect((JSON.parse(second.stderr) as { code: string }).code).toBe(
      "OUTPUT_EXISTS",
    );
  });
});
