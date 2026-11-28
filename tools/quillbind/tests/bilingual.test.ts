import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BILINGUAL_SCHEMA_VERSION,
  MarkerOrdinalSupply,
  activePlanUnits,
  assertTranslationVerified,
  bilingualStylesheetCss,
  buildBilingualEpub,
  canBeInlineMarker,
  checkNotes,
  checkTranslationMerged,
  compileTranslationShardMarkdown,
  computeShardContentSha256,
  createTranslationPlan,
  deriveBilingualUuid,
  findMarkers,
  initTranslationShards,
  isTranslationMode,
  isTranslationStyle,
  isWordlessInline,
  mergeTranslationShards,
  partitionEpubForTranslation,
  reconcileMarkers,
  renderBilingualEpub,
  resolveBodyElementPath,
  resolveRelativeElementPath,
  splitOnMarkers,
  validateInternal,
  validateLedgerRowState,
  validateTranslationShard,
  verifyTranslationRecords,
  type TranslationGlossary,
  type TranslationMergedFile,
  type TranslationPlan,
  type TranslationShardFile,
  type TranslationVerificationFile,
} from "../packages/core/src/index.js";
import { lintCss } from "../packages/core/src/css.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { sha256 } from "../packages/core/src/hash.js";
import { json, readJson } from "../packages/core/src/json.js";
import { run } from "../packages/core/src/process.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { pack } from "../packages/core/src/zip.js";

const temporary: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-bilingual-"));
  const real = await fs.realpath(dir);
  temporary.push(real);
  return real;
}

afterEach(async () => {
  for (const dir of temporary.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function buildSampleEpub(
  options: {
    extraMeta?: string;
    extraEntries?: Record<string, string | Buffer>;
    ch1Body?: string;
    ch2Body?: string;
    css?: string;
  } = {},
): Buffer {
  const css =
    options.css ??
    `.hidden-apparatus { display: none; }
.hidden-note { display: none; }
.custom-block { display: block; }
@media print { .print-only-hide { display: none; } }`;

  const ch1Body =
    options.ch1Body ??
    `<h1 id="ch1">Chapter 1: Morning in the Valley</h1>
<h3 class="folio">190</h3>
<p class="epigraph">Truth begins where curiosity awakens.</p>
<p id="p1">Press <code>Ctrl+C</code> to stop the reactor<sup><a id="ref-1" epub:type="noteref" role="doc-noteref" href="#fn-1">1</a></sup> immediately<img src="../images/dot.svg" alt="icon"/>.</p>
<p>Literal marker text ⟦code1⟧ beside <code>npm test</code> stays distinct.</p>
<p>Study <ruby>金石<rt>jīn shí</rt></ruby> with <span translate="no">SKU-42</span> and <span epub:type="pagebreak" role="doc-pagebreak">42</span> care.</p>
<p class="hidden-apparatus">Hidden running head should be skipped.</p>
<p class="print-only-hide">Visible on screen even if hidden in print.</p>
<p>https://example.org/docs/path</p>
<p>* * *</p>
<p>Fence edge case ::: line inside prose.</p>
<div class="math-box"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi><mo>+</mo><mn>1</mn></math></div>
<figure><img src="../images/dot.svg" alt="Valley diagram"/><figcaption>Figure 1.1 Valley cross-section</figcaption></figure>
<table><caption>Table 1.1 Observations</caption><thead><tr><th scope="col">Metric</th><th scope="col">Value</th></tr></thead><tbody><tr><td>Elevation</td><td>1200 m</td></tr></tbody></table>
<section class="footnotes" epub:type="footnotes"><aside id="fn-1" class="hidden-note" epub:type="footnote" role="doc-footnote"><p>Emergency shutdown note. <a role="doc-backlink" href="#ref-1">↩</a></p></aside></section>`;

  const ch2Body =
    options.ch2Body ??
    `<h1 id="ch2">Chapter 2: The Archive</h1>
<p>In year 1984 the archive opened 2500 volumes for study across three public reading rooms beside the northern courtyard.</p>
<p>By 2026 more than 4800 manuscripts were catalogued carefully, with dedicated climate shelves and optical preservation records for every folio.</p>
<p>Visitors who travelled from distant universities spent entire autumn seasons comparing marginalia, glosses, and watermarks in quiet morning light.</p>
<p>Each afternoon the chief archivist recorded provenance notes, binding repairs, and cross-references in a cloth-bound register kept near the main desk.</p>`;

  const navXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" role="doc-toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="text/ch-001.xhtml">Chapter 1: Morning in the Valley</a></li>
      <li><a href="text/ch-002.xhtml">Chapter 2: The Archive</a></li>
    </ol>
  </nav>
</body>
</html>`;

  const wrapXhtml = (title: string, body: string) =>
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><title>${title}</title><link rel="stylesheet" type="text/css" href="../styles/book.css"/></head>
<body>${body}</body>
</html>`;

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="uid" xml:lang="en">
  <metadata>
    <dc:identifier id="uid">urn:uuid:11111111-2222-4333-8444-555555555555</dc:identifier>
    <dc:title>Valley Studies</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Ada Author</dc:creator>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
    <meta property="schema:accessMode">textual</meta>
    <meta property="schema:accessModeSufficient">textual</meta>
    <meta property="schema:accessibilityFeature">tableOfContents</meta>
    <meta property="schema:accessibilityHazard">none</meta>
    <meta property="schema:accessibilitySummary">Sample test publication.</meta>
    ${options.extraMeta ?? ""}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/book.css" media-type="text/css"/>
    <item id="img1" href="images/dot.svg" media-type="image/svg+xml"/>
    <item id="ch1" href="text/ch-001.xhtml" media-type="application/xhtml+xml" properties="mathml"/>
    <item id="ch2" href="text/ch-002.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

  const entries = new Map<string, Uint8Array>([
    ["mimetype", Buffer.from("application/epub+zip")],
    [
      "META-INF/container.xml",
      Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      ),
    ],
    ["EPUB/package.opf", Buffer.from(opf)],
    ["EPUB/nav.xhtml", Buffer.from(navXhtml)],
    ["EPUB/styles/book.css", Buffer.from(css)],
    [
      "EPUB/images/dot.svg",
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><circle cx="6" cy="6" r="4"/></svg>`,
      ),
    ],
    ["EPUB/text/ch-001.xhtml", Buffer.from(wrapXhtml("Chapter 1", ch1Body))],
    ["EPUB/text/ch-002.xhtml", Buffer.from(wrapXhtml("Chapter 2", ch2Body))],
  ]);

  for (const [k, v] of Object.entries(options.extraEntries ?? {})) {
    entries.set(k, typeof v === "string" ? Buffer.from(v) : v);
  }
  return pack(entries, 946684800);
}

describe("Bilingual atomic inline markers", () => {
  it("classifies wordless inline content, avoids literal marker collisions, and reconciles replies leniently", () => {
    expect(isTranslationMode("bilingual")).toBe(true);
    expect(isTranslationMode("target-only")).toBe(true);
    expect(isTranslationMode("other")).toBe(false);
    expect(isTranslationStyle("paired")).toBe(true);
    expect(isTranslationStyle("plain")).toBe(true);
    expect(isTranslationStyle("fancy")).toBe(false);

    expect(isWordlessInline("https://example.org/a/b?x=1&y=2")).toBe(true);
    expect(isWordlessInline("0 . 2 1 ( 9 6 0 ) + 2 4 6 3 = 2 6 6 4")).toBe(
      true,
    );
    expect(isWordlessInline("This inline code contains real prose words")).toBe(
      false,
    );
    // Combining marks in Indic script must not make prose look wordless
    expect(
      isWordlessInline("साहित्य की परंपरा बहुत प्राचीन और समृद्ध है"),
    ).toBe(false);

    expect(canBeInlineMarker("Ctrl+C")).toBe(true);
    expect(
      canBeInlineMarker(
        "https://example.org/very/long/url/that/exceeds/forty/characters/without/prose",
      ),
    ).toBe(true);
    expect(
      canBeInlineMarker(
        "This inline snippet exceeds forty characters and clearly contains real English prose words.",
      ),
    ).toBe(false);

    const supply = new MarkerOrdinalSupply(1);
    const taken = new Set<string>();
    const tok = supply.allocate("code", "Literal ⟦code1⟧ in book", taken);
    expect(tok).toBe("⟦code2⟧");
    taken.add(tok);
    expect(findMarkers("A ⟦code1⟧ B ⟦code2⟧ C ⟦code2⟧")).toEqual([
      "⟦code1⟧",
      "⟦code2⟧",
    ]);

    // Reconcile preserves literal source markers, scrubs invented ones, dedupes repeats, appends missing
    const rec = reconcileMarkers(
      "Literal ⟦x1⟧ with ⟦code2⟧ and ⟦sup3⟧.",
      "译文 ⟦x1⟧ 含 ⟦code2⟧ 重复 ⟦code2⟧ 与幻觉 ⟦fake9⟧。",
      ["⟦code2⟧", "⟦sup3⟧"],
    );
    expect(rec.missing).toEqual(["⟦sup3⟧"]);
    expect(rec.invented).toEqual(["⟦fake9⟧"]);
    expect(rec.duplicates).toEqual(["⟦code2⟧"]);
    expect(rec.text).toBe("译文 ⟦x1⟧ 含 ⟦code2⟧ 重复  与幻觉 。 ⟦sup3⟧");

    expect(
      splitOnMarkers("按 ⟦code2⟧ 退出⟦sup3⟧。", ["⟦code2⟧", "⟦sup3⟧"]),
    ).toEqual([
      { kind: "text", value: "按 " },
      { kind: "marker", value: "⟦code2⟧" },
      { kind: "text", value: " 退出" },
      { kind: "marker", value: "⟦sup3⟧" },
      { kind: "text", value: "。" },
    ]);
  });
});

describe("Coverage-complete EPUB translation planner and refusal guards", () => {
  it("enforces exact character accounting, inline markers, popup footnote preservation, and ledger invariants", () => {
    const epubBytes = buildSampleEpub();
    const plan = partitionEpubForTranslation(epubBytes, {
      sourcePath: "/tmp/valley.epub",
      targetLanguage: "zh-Hans",
    });

    // Exact accounting invariant: totalChars === translatableChars + sum(skippedChars)
    const skippedSum = Object.values(plan.coverage.skippedChars).reduce(
      (a, b) => a + b,
      0,
    );
    expect(plan.coverage.totalChars).toBe(
      plan.coverage.translatableChars + skippedSum,
    );
    expect(plan.coverage.skippedChars.ruby).toBeGreaterThan(0);
    expect(plan.coverage.skippedChars.pagebreak).toBeGreaterThan(0);
    expect(plan.coverage.skippedChars["translate-no"]).toBeGreaterThan(0);
    expect(plan.coverage.skippedChars.hidden).toBeGreaterThan(0);
    expect(plan.coverage.skippedChars.link).toBeGreaterThan(0);
    expect(plan.coverage.skippedChars.symbol).toBeGreaterThan(0);
    expect(plan.coverage.skippedChars["non-content"]).toBeGreaterThan(0);
    expect(plan.coverage.skippedChars["excluded-tag"]).toBeGreaterThan(0);

    // Inline code/sup/img become atomic markers without splitting the sentence
    const reactorUnit = plan.units.find((u) =>
      u.sourceText.includes("stop the reactor"),
    )!;
    expect(reactorUnit).toBeDefined();
    expect(reactorUnit.markers.map((m) => m.tag)).toEqual([
      "code",
      "sup",
      "img",
    ]);
    for (const m of reactorUnit.markers) {
      expect(reactorUnit.sourceText).toContain(m.token);
    }

    // Literal ⟦code1⟧ collision avoidance in the next paragraph
    const literalUnit = plan.units.find((u) =>
      u.sourceText.includes("Literal marker text ⟦code1⟧"),
    )!;
    expect(literalUnit.markers).toHaveLength(1);
    expect(literalUnit.markers[0].token).not.toBe("⟦code1⟧");

    // Ruby reading <rt> is NOT spliced into base text
    const rubyUnit = plan.units.find((u) => u.sourceText.includes("金石"))!;
    expect(rubyUnit.sourceText).not.toContain("jīn shí");

    // CSS-hidden popup footnote IS preserved for translation, while CSS-hidden apparatus is skipped
    expect(
      plan.units.some((u) => u.sourceText.includes("Emergency shutdown note")),
    ).toBe(true);
    expect(
      plan.units.some((u) => u.sourceText.includes("Hidden running head")),
    ).toBe(false);
    // Print-only display:none stays visible on screen
    expect(
      plan.units.some((u) =>
        u.sourceText.includes("Visible on screen even if hidden in print"),
      ),
    ).toBe(true);

    // Restricted content model flags
    expect(
      plan.units.find((u) => u.tag === "figcaption")?.restrictedContentModel,
    ).toBe(true);
    expect(
      plan.units.find((u) => u.tag === "caption")?.restrictedContentModel,
    ).toBe(true);
    expect(plan.units.find((u) => u.tag === "td")?.restrictedContentModel).toBe(
      true,
    );
    expect(plan.units.find((u) => u.tag === "h1")?.restrictedContentModel).toBe(
      true,
    );
    expect(
      plan.units.find((u) => u.docPath === "EPUB/nav.xhtml")
        ?.restrictedContentModel,
    ).toBe(true);
    expect(reactorUnit.restrictedContentModel).toBe(false);

    // DOM ownerPath + marker ownerChildPath resolve cleanly against inspected XHTML
    const info = inspectBytes(epubBytes);
    const ch1Doc = info.documents.get("EPUB/text/ch-001.xhtml")!;
    const ownerEl = resolveBodyElementPath(ch1Doc, reactorUnit.ownerPath);
    expect(ownerEl?.localName).toBe("p");
    for (const m of reactorUnit.markers) {
      const markerEl = resolveRelativeElementPath(ownerEl!, m.ownerChildPath);
      expect(markerEl?.localName).toBe(m.tag);
    }

    // Default ledger rows await explicit classification (action: null) and separate numeric folio #num
    expect(plan.ledger.every((r) => r.action === null)).toBe(true);
    expect(plan.ledger.some((r) => r.key === "block:h3.folio #num")).toBe(true);

    // Auto-classify skips #num and translates prose
    const autoPlan = partitionEpubForTranslation(epubBytes, {
      sourcePath: "/tmp/valley.epub",
      targetLanguage: "zh-Hans",
      autoClassify: true,
    });
    expect(
      autoPlan.ledger.find((r) => r.key === "block:h3.folio #num")?.action,
    ).toBe("skip");
    expect(autoPlan.ledger.find((r) => r.key === "block:p")?.action).toBe(
      "translate",
    );
    expect(
      autoPlan.ledger.every((r) => validateLedgerRowState(r) === null),
    ).toBe(true);
  });

  it("refuses DRM, fixed-layout, font-obfuscated, signed, invalid language, and bad doc filters", () => {
    const valid = buildSampleEpub();
    expect(() =>
      partitionEpubForTranslation(valid, {
        sourcePath: "/tmp/a.epub",
        targetLanguage: "not a lang!",
      }),
    ).toThrow(/Invalid target BCP 47/);

    expect(() =>
      partitionEpubForTranslation(valid, {
        sourcePath: "/tmp/a.epub",
        targetLanguage: "zh-Hans",
        onlyDocs: ["EPUB/text/does-not-exist.xhtml"],
      }),
    ).toThrow(/not present in EPUB/);

    const fixedLayout = buildSampleEpub({
      extraMeta: `<meta property="rendition:layout">pre-paginated</meta>`,
    });
    expect(() =>
      partitionEpubForTranslation(fixedLayout, {
        sourcePath: "/tmp/fxl.epub",
        targetLanguage: "zh-Hans",
      }),
    ).toThrow(/Fixed-layout/);

    const encrypted = buildSampleEpub({
      extraEntries: {
        "META-INF/encryption.xml": `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>`,
      },
    });
    expect(() =>
      partitionEpubForTranslation(encrypted, {
        sourcePath: "/tmp/drm.epub",
        targetLanguage: "zh-Hans",
      }),
    ).toThrow(/Encrypted or DRM/);

    const obfuscated = buildSampleEpub({
      extraEntries: {
        "META-INF/encryption.xml": `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></EncryptedData></encryption>`,
      },
    });
    expect(() =>
      partitionEpubForTranslation(obfuscated, {
        sourcePath: "/tmp/obf.epub",
        targetLanguage: "zh-Hans",
      }),
    ).toThrow(/Font-obfuscated/);

    const signed = buildSampleEpub({
      extraEntries: {
        "META-INF/signatures.xml": `<signatures xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>`,
      },
    });
    expect(() =>
      partitionEpubForTranslation(signed, {
        sourcePath: "/tmp/signed.epub",
        targetLanguage: "zh-Hans",
      }),
    ).toThrow(/Cannot translate this EPUB structure/);
  });
});

describe("Translation sharding, Markdown/JSON round-trip, QA signals, verifier separation, and CLI", () => {
  it("runs plan -> classify -> shard-init (md & json) -> validate -> merge -> check -> independent verifier", async () => {
    const root = await makeTempDir();
    const epubPath = path.join(root, "valley.epub");
    await fs.writeFile(epubPath, buildSampleEpub());

    const planPath = path.join(root, "plan.json");
    const planRes = await createTranslationPlan(epubPath, planPath, {
      targetLanguage: "zh-Hans",
      tokenBudget: 350,
    });
    expect(planRes.undecidedSignatures).toBeGreaterThan(0);

    // Undecided plan MUST be blocked from shard-init
    await expect(
      initTranslationShards(planPath, path.join(root, "blocked-shards")),
    ).rejects.toMatchObject({ code: "TRANSLATION_PLAN_UNDECIDED" });

    // Invalid ledger row (action without contentType) MUST fail
    const plan = await readJson<TranslationPlan>(planPath);
    const badPlan = structuredClone(plan);
    badPlan.ledger[0].action = "translate";
    badPlan.ledger[0].decidedBy = "agent";
    badPlan.ledger[0].contentType = null;
    expect(() => activePlanUnits(badPlan)).toThrow(/Invalid classification/);

    // Classify every signature cleanly as coordinator ("agent")
    for (const row of plan.ledger) {
      if (row.key.endsWith(" #num")) {
        row.action = "skip";
        row.decidedBy = "agent";
        row.contentType = "folio-page-number";
      } else {
        row.action = "translate";
        row.decidedBy = "agent";
        row.contentType = "book-content";
      }
    }
    await json(planPath, plan);
    const planSha256 = sha256(await fs.readFile(planPath));

    const glossaryPath = path.join(root, "glossary.json");
    const glossary: TranslationGlossary = {
      schemaVersion: BILINGUAL_SCHEMA_VERSION,
      kind: "quillbind-translation-glossary",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      styleGuide: "Literary Simplified Chinese.",
      terms: [{ source: "Valley", target: "山谷" }],
    };
    await json(glossaryPath, glossary);

    // Init Markdown shards & check dynamic 4-colon fence for source containing :::
    const mdDir = path.join(root, "shards-md");
    const mdInit = await initTranslationShards(planPath, mdDir, {
      format: "md",
      glossary: glossaryPath,
      tokenBudget: 200,
    });
    expect(mdInit.shards.length).toBeGreaterThanOrEqual(2);
    expect(mdInit.planSha256).toBe(planSha256);
    const allMdText = (
      await Promise.all(mdInit.shards.map((s) => fs.readFile(s.file, "utf8")))
    ).join("\n");
    expect(allMdText).toContain("::::source{");

    // Untranslated shards fail validation (missing translatedBy + empty targets)
    const emptyVal = await validateTranslationShard(mdDir, { plan: planPath });
    expect(emptyVal.status).toBe("fail");
    expect(
      emptyVal.diagnostics.some((d) => d.code === "TRANSLATION_WORKER_MISSING"),
    ).toBe(true);
    expect(
      emptyVal.diagnostics.some((d) => d.code === "TRANSLATION_UNIT_EMPTY"),
    ).toBe(true);

    // Markdown syntax error diagnostics
    expect(
      compileTranslationShardMarkdown("no frontmatter", "bad.md").diagnostics[0]
        ?.code,
    ).toBe("TRANSLATION_MD_FRONTMATTER");
    const unclosed = compileTranslationShardMarkdown(
      `---\nshardId: "s1"\nsourceSha256: "${plan.source.sha256}"\nplanSha256: "${planSha256}"\ntargetLanguage: "zh-Hans"\nmode: "bilingual"\ntranslatedBy: "w1"\n---\n\n:::source{id="u-0001"}\nHi\n:::\n:::target{id="u-0001"}\n你好\n`,
      "unclosed.md",
    );
    expect(
      unclosed.diagnostics.some((d) => d.code === "TRANSLATION_MD_BLOCK"),
    ).toBe(true);

    // Fill translations in every Markdown shard (simulating worker subagents)
    const unitById = new Map(plan.units.map((u) => [u.id, u]));
    for (const [idx, shardInfo] of mdInit.shards.entries()) {
      let md = await fs.readFile(shardInfo.file, "utf8");
      md = md.replace('translatedBy: ""', `translatedBy: "worker-${idx + 1}"`);
      md = md.replace(
        /^(:{3,})target\{id="([^"]+)"\}\n\1$/gmu,
        (_, fence: string, uid: string) => {
          const unit = unitById.get(uid)!;
          const markers = unit.markers.map((m) => m.token).join(" ");
          const hasValley = unit.sourceText.toLowerCase().includes("valley");
          const digits = (unit.sourceText.match(/\d{2,}/gu) ?? []).join(" ");
          const body = `中文译文（${uid}${hasValley ? " 山谷" : ""}${digits ? ` ${digits}` : ""}）${markers ? ` ${markers}` : ""}。`;
          return `${fence}target{id="${uid}"}\n${body}\n${fence}`;
        },
      );
      await fs.writeFile(shardInfo.file, md, "utf8");
    }

    const validRes = await validateTranslationShard(mdDir, { plan: planPath });
    expect(validRes.status).toBe("pass");

    const mergedPath = path.join(root, "merged.json");
    const mergedRes = await mergeTranslationShards(planPath, mdDir, mergedPath);
    expect(mergedRes.status).toBe("pass");
    expect(mergedRes.shardCount).toBe(mdInit.shards.length);

    const merged = await readJson<TranslationMergedFile>(mergedPath);

    // Check deterministic QA signals on clean translations
    const cleanCheck = await checkTranslationMerged(mergedPath, {
      plan: planPath,
      glossary: glossaryPath,
    });
    expect(cleanCheck.status).toBe("pass");
    expect(cleanCheck.signals).toEqual({
      missingUnits: 0,
      echoSuspects: 0,
      markerIssues: 0,
      numericShiftShards: 0,
      scriptMismatches: 0,
      glossaryDrifts: 0,
    });

    // Self-approval & stale verification MUST fail
    const selfVer: TranslationVerificationFile = {
      schemaVersion: BILINGUAL_SCHEMA_VERSION,
      kind: "quillbind-translation-verification",
      sourceSha256: merged.sourceSha256,
      planSha256: merged.planSha256,
      verifierId: "worker-1",
      verifiedAt: "2026-11-28T00:00:00Z",
      shards: merged.shards.map((s) => ({
        shardId: s.shardId,
        translatedBy: s.translatedBy,
        verifiedBy: s.translatedBy,
        contentSha256: s.contentSha256,
        status: "verified",
        unresolved: [],
      })),
    };
    expect(
      verifyTranslationRecords(merged, selfVer).some(
        (d) => d.code === "TRANSLATION_SELF_APPROVAL_FORBIDDEN",
      ),
    ).toBe(true);
    expect(() => assertTranslationVerified(merged)).toThrow(
      /Independent verifier record/,
    );

    const goodVerPath = path.join(root, "verification.json");
    const goodVer: TranslationVerificationFile = {
      ...selfVer,
      verifierId: "verifier-alpha",
      shards: selfVer.shards.map((s) => ({
        ...s,
        verifiedBy: "verifier-alpha",
      })),
    };
    await json(goodVerPath, goodVer);
    expect(() => assertTranslationVerified(merged, goodVer)).not.toThrow();

    const verifiedCheck = await checkTranslationMerged(mergedPath, {
      plan: planPath,
      glossary: glossaryPath,
      verification: goodVerPath,
    });
    expect(verifiedCheck.status).toBe("pass");

    // Mutating one translation after verification triggers TRANSLATION_VERIFICATION_STALE
    const tampered = structuredClone(merged);
    tampered.shards[0].contentSha256 = computeShardContentSha256(
      tampered.shards[0].shardId,
      [{ unitId: tampered.shards[0].unitIds[0], translation: "篡改译文" }],
    );
    expect(
      verifyTranslationRecords(tampered, goodVer).some(
        (d) => d.code === "TRANSLATION_VERIFICATION_STALE",
      ),
    ).toBe(true);

    // Defective translations surface echo, missing marker, numeric slot shift, script mismatch, glossary drift
    const defective = structuredClone(merged);
    const reactorUnit = plan.units.find((u) =>
      u.sourceText.includes("stop the reactor"),
    )!;
    const epigraphUnit = plan.units.find((u) =>
      u.sourceText.includes("curiosity awakens"),
    )!;
    const year1984 = plan.units.find((u) => u.sourceText.includes("1984"))!;
    const year2026 = plan.units.find((u) => u.sourceText.includes("2026"))!;
    const valleyTitle = plan.units.find((u) =>
      u.sourceText.includes("Morning in the Valley"),
    )!;
    defective.translations[reactorUnit.id] = "请立刻停止反应堆。"; // missing markers
    defective.translations[epigraphUnit.id] = epigraphUnit.sourceText; // echo + script mismatch
    defective.translations[valleyTitle.id] = "第一章：清晨之景"; // glossary drift (missing 山谷)
    // Swap 1984/2500 and 2026/4800 across adjacent units to trigger numeric slot shift
    defective.translations[year1984.id] = "到2026年已编目超过4800份手稿。";
    defective.translations[year2026.id] = "1984年档案馆开放了2500册藏书。";
    const defPath = path.join(root, "defective-merged.json");
    await json(defPath, defective);
    const defCheck = await checkTranslationMerged(defPath, {
      plan: planPath,
      glossary: glossaryPath,
    });
    expect(defCheck.signals.markerIssues).toBeGreaterThanOrEqual(1);
    expect(defCheck.signals.echoSuspects).toBeGreaterThanOrEqual(1);
    expect(defCheck.signals.scriptMismatches).toBeGreaterThanOrEqual(1);
    expect(defCheck.signals.glossaryDrifts).toBeGreaterThanOrEqual(1);
    expect(defCheck.signals.numericShiftShards).toBeGreaterThanOrEqual(1);

    // JSON shard format round-trip
    const jsonDir = path.join(root, "shards-json");
    const jsonInit = await initTranslationShards(planPath, jsonDir, {
      format: "json",
    });
    for (const s of jsonInit.shards) {
      const data = await readJson<TranslationShardFile>(s.file);
      data.translatedBy = "worker-json";
      data.entries = data.entries.map((e) => ({
        ...e,
        translation: `译文 ${e.unitId}`,
      }));
      await json(s.file, data);
    }
    expect(
      (await validateTranslationShard(jsonDir, { plan: planPath })).status,
    ).toBe("pass");
  });

  it("exposes epub translate-plan, translate-shard-init, translate-validate-shard, translate-merge, and translate-check via CLI", async () => {
    const root = await makeTempDir();
    const epubPath = path.join(root, "cli-book.epub");
    await fs.writeFile(epubPath, buildSampleEpub());
    const cli = path.join(repoRoot, "packages/cli/src/index.ts");
    const invoke = (args: string[]) =>
      run(process.execPath, ["--import", "tsx", cli, ...args], {
        cwd: repoRoot,
      });

    const planPath = path.join(root, "cli-plan.json");
    const planCli = await invoke([
      "epub",
      "translate-plan",
      epubPath,
      "--target-lang",
      "zh-Hans",
      "--auto-classify",
      "--token-budget",
      "500",
      "--output",
      planPath,
      "--json",
    ]);
    expect(planCli.exitCode, planCli.stderr).toBe(0);
    expect(JSON.parse(planCli.stdout)).toMatchObject({
      status: "pass",
      operation: "epub-translate-plan",
      targetLanguage: "zh-Hans",
      mode: "bilingual",
      undecidedSignatures: 0,
    });

    const shardsDir = path.join(root, "cli-shards");
    const shardCli = await invoke([
      "epub",
      "translate-shard-init",
      planPath,
      "--format",
      "json",
      "--output",
      shardsDir,
      "--json",
    ]);
    expect(shardCli.exitCode, shardCli.stderr).toBe(0);
    const shardPayload = JSON.parse(shardCli.stdout) as {
      shards: { file: string }[];
    };

    for (const s of shardPayload.shards) {
      const shard = await readJson<TranslationShardFile>(s.file);
      shard.translatedBy = "cli-worker";
      shard.entries = shard.entries.map((e) => ({
        ...e,
        translation: `中文翻译 ${e.unitId}`,
      }));
      await json(s.file, shard);
    }

    const valCli = await invoke([
      "epub",
      "translate-validate-shard",
      shardsDir,
      "--plan",
      planPath,
      "--json",
    ]);
    expect(valCli.exitCode, valCli.stderr).toBe(0);
    expect(JSON.parse(valCli.stdout).status).toBe("pass");

    const mergedPath = path.join(root, "cli-merged.json");
    const mergeCli = await invoke([
      "epub",
      "translate-merge",
      planPath,
      "--shards",
      shardsDir,
      "--output",
      mergedPath,
      "--json",
    ]);
    expect(mergeCli.exitCode, mergeCli.stderr).toBe(0);

    const checkCli = await invoke([
      "epub",
      "translate-check",
      mergedPath,
      "--plan",
      planPath,
      "--json",
    ]);
    expect(checkCli.exitCode, checkCli.stderr).toBe(0);
    expect(JSON.parse(checkCli.stdout).status).toBe("pass");

    // Argument guards
    const badMode = await invoke([
      "epub",
      "translate-plan",
      epubPath,
      "--target-lang",
      "zh-Hans",
      "--mode",
      "side-by-side",
      "--output",
      path.join(root, "bad-mode.json"),
      "--json",
    ]);
    expect(badMode.exitCode).toBe(1);
    expect(JSON.parse(badMode.stdout).code).toBe("ARGUMENT_CONFLICT");

    const strayFlag = await invoke([
      "inspect",
      epubPath,
      "--target-lang",
      "zh-Hans",
      "--json",
    ]);
    expect(strayFlag.exitCode).toBe(1);
    expect(JSON.parse(strayFlag.stdout).code).toBe("ARGUMENT_CONFLICT");
  }, 60_000);
});

describe("Bilingual EPUB write-back builder, lintCss styling, and CLI translate-build", () => {
  it("produces lintCss-compliant bilingual stylesheets and deterministic distinct UUIDv5 identities", () => {
    expect(
      lintCss(bilingualStylesheetCss("paired"), "bilingual.css").status,
    ).toBe("pass");
    expect(
      lintCss(bilingualStylesheetCss("plain"), "bilingual.css").status,
    ).toBe("pass");
    const id1 = deriveBilingualUuid("urn:uuid:abc", "zh-Hans", "bilingual");
    const id2 = deriveBilingualUuid("urn:uuid:abc", "zh-Hans", "bilingual");
    const idTargetOnly = deriveBilingualUuid(
      "urn:uuid:abc",
      "zh-Hans",
      "target-only",
    );
    const idJa = deriveBilingualUuid("urn:uuid:abc", "ja", "bilingual");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(id1).not.toBe("urn:uuid:abc");
    expect(id1).not.toBe(idTargetOnly);
    expect(id1).not.toBe(idJa);
  });

  it("builds verified bilingual and target-only EPUB 3.3 books with unique IDs, restored markers, restricted models, and passes EPUBCheck + reading QA", async () => {
    const root = await makeTempDir();
    const epubPath = path.join(root, "source.epub");
    const sourceBytes = buildSampleEpub();
    await fs.writeFile(epubPath, sourceBytes);

    const buildWorkflow = async (mode: "bilingual" | "target-only") => {
      const subDir = path.join(root, mode);
      await fs.mkdir(subDir, { recursive: true });
      const planPath = path.join(subDir, "plan.json");
      await createTranslationPlan(epubPath, planPath, {
        targetLanguage: "zh-Hans",
        mode,
        autoClassify: true,
        tokenBudget: 300,
      });
      const plan = await readJson<TranslationPlan>(planPath);
      const shardsDir = path.join(subDir, "shards");
      const initRes = await initTranslationShards(planPath, shardsDir, {
        format: "md",
      });
      const unitById = new Map(plan.units.map((u) => [u.id, u]));
      for (const [idx, s] of initRes.shards.entries()) {
        let md = await fs.readFile(s.file, "utf8");
        md = md.replace(
          'translatedBy: ""',
          `translatedBy: "worker-${idx + 1}"`,
        );
        md = md.replace(
          /^(:{3,})target\{id="([^"]+)"\}\n\1$/gmu,
          (_, fence: string, uid: string) => {
            const unit = unitById.get(uid)!;
            const markers = unit.markers.map((m) => m.token).join(" ");
            const text = `中文译文（${uid}）${markers ? ` ${markers}` : ""}。`;
            return `${fence}target{id="${uid}"}\n${text}\n${fence}`;
          },
        );
        await fs.writeFile(s.file, md, "utf8");
      }
      const mergedPath = path.join(subDir, "merged.json");
      await mergeTranslationShards(planPath, shardsDir, mergedPath);
      const merged = await readJson<TranslationMergedFile>(mergedPath);
      const verPath = path.join(subDir, "verification.json");
      const ver: TranslationVerificationFile = {
        schemaVersion: BILINGUAL_SCHEMA_VERSION,
        kind: "quillbind-translation-verification",
        sourceSha256: merged.sourceSha256,
        planSha256: merged.planSha256,
        verifierId: "verifier-qa",
        verifiedAt: "2026-11-28T00:00:00Z",
        shards: merged.shards.map((s) => ({
          shardId: s.shardId,
          translatedBy: s.translatedBy,
          verifiedBy: "verifier-qa",
          contentSha256: s.contentSha256,
          status: "verified",
          unresolved: [],
        })),
      };
      await json(verPath, ver);
      const outPath = path.join(subDir, `out-${mode}.epub`);
      const res = await buildBilingualEpub(epubPath, outPath, {
        plan: planPath,
        translations: mergedPath,
        verification: verPath,
        style: "paired",
      });
      return { res, outPath, planPath, mergedPath, verPath, plan, merged, ver };
    };

    // 1. Bilingual mode
    const bi = await buildWorkflow("bilingual");
    expect(bi.res.status).toBe("pass");
    expect(bi.res.reproducible).toBe(true);
    expect(bi.res.bilingualStylesheet).toBe("EPUB/quillbind-bilingual.css");
    expect(await fs.readFile(epubPath)).toEqual(sourceBytes);

    const biBytes = await fs.readFile(bi.outPath);
    const biInternal = validateInternal(biBytes);
    expect(
      biInternal.diagnostics.filter((d) =>
        [
          "DUPLICATE_ID",
          "FOOTNOTE_BACKLINK",
          "MANIFEST_MISSING",
          "UNMANIFESTED_RESOURCE",
          "BODY_OVERRIDE",
        ].includes(d.code),
      ),
    ).toEqual([]);
    const biInfo = inspectBytes(biBytes, true);
    expect(
      lintCss(
        biInfo.entries.get("EPUB/quillbind-bilingual.css")!.bytes.toString(),
        "EPUB/quillbind-bilingual.css",
      ).status,
    ).toBe("pass");
    const biOpf = biInfo.entries.get("EPUB/package.opf")!.bytes.toString();
    expect(biOpf).toContain(bi.res.derivedIdentifier);
    expect(biOpf).toContain(
      "<dc:source>urn:uuid:11111111-2222-4333-8444-555555555555</dc:source>",
    );
    expect(biOpf).toContain("<dc:language>en</dc:language>");
    expect(biOpf).toContain("<dc:language>zh-Hans</dc:language>");
    expect(biOpf).toContain("quillbind-bilingual.css");

    const biCh1 = biInfo.entries
      .get("EPUB/text/ch-001.xhtml")!
      .bytes.toString();
    expect(biCh1).toContain("../quillbind-bilingual.css");
    // Original prose keeps id="p1" and gets quillbind-source; sibling translation has lang="zh-Hans" and NO duplicate id
    expect(biCh1).toContain('id="p1" class="quillbind-source"');
    expect(biCh1).toContain('class="quillbind-translation" lang="zh-Hans"');
    expect(biCh1.split('id="p1"').length - 1).toBe(1);
    expect(biCh1.split('id="ref-1"').length - 1).toBe(1);
    // Cloned translation restores inline code, footnote link (without duplicate noteref role), and image
    expect(biCh1.split("<code>Ctrl+C</code>").length - 1).toBe(2);
    expect(biCh1.split('href="#fn-1"').length - 1).toBe(2);
    // Restricted elements use inline <br/><span class="quillbind-translation">
    expect(biCh1).toContain(
      '<h1 id="ch1">Chapter 1: Morning in the Valley<br/><span class="quillbind-translation"',
    );
    expect(biCh1).toContain(
      '<figcaption>Figure 1.1 Valley cross-section<br/><span class="quillbind-translation"',
    );
    expect(biCh1).toContain(
      '<td>Elevation<br/><span class="quillbind-translation"',
    );
    // Skipped folio <h3>190</h3> untouched
    expect(biCh1).toContain('<h3 class="folio">190</h3>');

    const biNav = biInfo.entries.get("EPUB/nav.xhtml")!.bytes.toString();
    expect(biNav).toContain(
      'Chapter 1: Morning in the Valley<br/><span class="quillbind-translation"',
    );

    // Bidirectional footnote round-trip still passes checkNotes cleanly
    const noteReport = await checkNotes(bi.outPath);
    expect(noteReport.notes.issues).toEqual([]);

    // 2. Target-only mode
    const to = await buildWorkflow("target-only");
    expect(to.res.status).toBe("pass");
    expect(to.res.bilingualStylesheet).toBeUndefined();
    const toBytes = await fs.readFile(to.outPath);
    expect(
      validateInternal(toBytes).diagnostics.filter((d) =>
        [
          "DUPLICATE_ID",
          "FOOTNOTE_BACKLINK",
          "MANIFEST_MISSING",
          "UNMANIFESTED_RESOURCE",
          "BODY_OVERRIDE",
        ].includes(d.code),
      ),
    ).toEqual([]);
    const toInfo = inspectBytes(toBytes, true);
    const toOpf = toInfo.entries.get("EPUB/package.opf")!.bytes.toString();
    expect(toOpf).toContain("<dc:language>zh-Hans</dc:language>");
    const toCh1 = toInfo.entries
      .get("EPUB/text/ch-001.xhtml")!
      .bytes.toString();
    expect(toCh1).not.toContain("Morning in the Valley");
    expect(toCh1).toContain('id="p1"');
    expect(toCh1).toContain('id="ref-1"');
    expect(toCh1).toContain("<code>Ctrl+C</code>");

    // 3. CLI `epub translate-build` with --style plain + error guards
    const cli = path.join(repoRoot, "packages/cli/src/index.ts");
    const invoke = (args: string[]) =>
      run(process.execPath, ["--import", "tsx", cli, ...args], {
        cwd: repoRoot,
      });
    const cliOut = path.join(root, "cli-bilingual.epub");
    const cliBuild = await invoke([
      "epub",
      "translate-build",
      epubPath,
      "--plan",
      bi.planPath,
      "--translations",
      bi.mergedPath,
      "--verification",
      bi.verPath,
      "--style",
      "plain",
      "--output",
      cliOut,
      "--json",
    ]);
    expect(cliBuild.exitCode, cliBuild.stdout + cliBuild.stderr).toBe(0);
    const cliPayload = JSON.parse(cliBuild.stdout) as {
      status: string;
      style: string;
      outputSha256: string;
      reports: string;
    };
    expect(cliPayload.status).toBe("pass");
    expect(cliPayload.style).toBe("plain");
    expect(sha256(await fs.readFile(cliOut))).toBe(cliPayload.outputSha256);
    const savedRep = await readJson<typeof cliPayload>(
      path.join(cliPayload.reports, "translation.json"),
    );
    expect(savedRep.outputSha256).toBe(cliPayload.outputSha256);

    const badStyle = await invoke([
      "epub",
      "translate-build",
      epubPath,
      "--plan",
      bi.planPath,
      "--translations",
      bi.mergedPath,
      "--verification",
      bi.verPath,
      "--style",
      "neon",
      "--output",
      path.join(root, "bad-style.epub"),
      "--json",
    ]);
    expect(badStyle.exitCode).toBe(1);
    expect(JSON.parse(badStyle.stdout).code).toBe("ARGUMENT_CONFLICT");

    // Self-approved verification rejected by renderBilingualEpub
    const selfVer: TranslationVerificationFile = {
      ...bi.ver,
      verifierId: bi.merged.shards[0].translatedBy,
    };
    expect(() =>
      renderBilingualEpub(sourceBytes, bi.plan, bi.merged, {
        planSha256: bi.merged.planSha256,
        verification: selfVer,
      }),
    ).toThrow(/cannot be verified by its translator/);
  }, 120_000);

  it("synchronizes EPUB 2 NCX dtb:uid and navLabels while clearing stale opf:scheme on derived identifiers", async () => {
    const root = await makeTempDir();
    const epub2Path = path.join(root, "epub2-source.epub");
    const entries = new Map<string, Uint8Array>([
      ["mimetype", Buffer.from("application/epub+zip", "utf8")],
      [
        "META-INF/container.xml",
        Buffer.from(
          `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
          "utf8",
        ),
      ],
      [
        "OEBPS/content.opf",
        Buffer.from(
          `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="BookId" opf:scheme="ISBN">9780123456789</dc:identifier>
    <dc:title>Legacy Reader</dc:title>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
  </spine>
</package>`,
          "utf8",
        ),
      ],
      [
        "OEBPS/toc.ncx",
        Buffer.from(
          `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="9780123456789"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>Legacy Reader</text></docTitle>
  <navMap>
    <navPoint id="np-1" playOrder="1">
      <navLabel><text>Opening Chapter</text></navLabel>
      <content src="ch1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,
          "utf8",
        ),
      ],
      [
        "OEBPS/ch1.xhtml",
        Buffer.from(
          `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head><title>Opening Chapter</title></head>
  <body>
    <h1>Opening Chapter</h1>
    <p>An analytical engine weaves algebraic patterns.</p>
  </body>
</html>`,
          "utf8",
        ),
      ],
    ]);
    await fs.writeFile(epub2Path, pack(entries, 946684800));

    const planPath = path.join(root, "plan.json");
    await createTranslationPlan(epub2Path, planPath, {
      targetLanguage: "zh-Hans",
      mode: "bilingual",
      autoClassify: true,
    });
    const shardsDir = path.join(root, "shards");
    const initRes = await initTranslationShards(planPath, shardsDir, {
      format: "json",
    });
    for (const s of initRes.shards) {
      const data = await readJson<TranslationShardFile>(s.file);
      data.translatedBy = "worker-epub2";
      data.entries = data.entries.map((e) => ({
        ...e,
        translation:
          e.sourceText === "Opening Chapter"
            ? "开篇"
            : "分析机能够编织代数图案。",
      }));
      await json(s.file, data);
    }
    const mergedPath = path.join(root, "merged.json");
    await mergeTranslationShards(planPath, shardsDir, mergedPath);
    const merged = await readJson<TranslationMergedFile>(mergedPath);
    const verPath = path.join(root, "verification.json");
    await json(verPath, {
      schemaVersion: BILINGUAL_SCHEMA_VERSION,
      kind: "quillbind-translation-verification",
      sourceSha256: merged.sourceSha256,
      planSha256: merged.planSha256,
      verifierId: "verifier-epub2",
      verifiedAt: "2026-11-28T00:00:00Z",
      shards: merged.shards.map((s) => ({
        shardId: s.shardId,
        translatedBy: s.translatedBy,
        verifiedBy: "verifier-epub2",
        contentSha256: s.contentSha256,
        status: "verified",
        unresolved: [],
      })),
    } satisfies TranslationVerificationFile);

    const outPath = path.join(root, "epub2-bilingual.epub");
    const built = await buildBilingualEpub(epub2Path, outPath, {
      plan: planPath,
      translations: mergedPath,
      verification: verPath,
    });
    expect(built.status).toBe("pass");
    const outInfo = inspectBytes(await fs.readFile(outPath), true);
    const opf = outInfo.entries.get("OEBPS/content.opf")!.bytes.toString();
    expect(opf).toContain(built.derivedIdentifier);
    expect(opf).not.toContain('opf:scheme="ISBN"');
    expect(opf).toContain("<dc:source>9780123456789</dc:source>");
    const ncx = outInfo.entries.get("OEBPS/toc.ncx")!.bytes.toString();
    expect(ncx).toContain(
      `<meta name="dtb:uid" content="${built.derivedIdentifier}"`,
    );
    expect(ncx).toContain("<text>Opening Chapter / 开篇</text>");
  }, 60_000);
});
