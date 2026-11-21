import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readBibliographyRules,
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
    const [tags, naming, bibliography, delivery, parallel, pdf] =
      await Promise.all([
        readWorkTypeTagRules(refsDir),
        readNamingRules(refsDir),
        readBibliographyRules(refsDir),
        readDeliveryRules(refsDir),
        readParallelWorkflowRules(refsDir),
        readPdfRules(refsDir),
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
