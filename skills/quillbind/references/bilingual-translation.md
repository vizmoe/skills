# Bilingual EPUB translation (zero API key, subagent-driven)

Quillbind produces bilingual (or explicitly requested target-only) EPUB editions **without external translation API keys or outbound LLM network calls**. Inspired by `bilingual_book_maker`'s coverage-complete DOM partitioning, atomic inline markers, and signature classification ledger, it splits execution deterministically across host-agent subagents using the portable three-role model in [parallel subagent workflow](parallel-workflow.md):

- **`coordinator` (main agent)**: handles intake, snapshots Calibre sidecars, runs `epub translate-plan`, reviews every undecided signature sample in the classification ledger, locks a shared book-wide `glossary.json`, fans out disjoint shards to dedicated translation `worker` subagents, merges completed shards, and triggers `epub translate-build` after independent verification.
- **`worker` (dedicated translation subagent)**: translates strictly within its assigned shard file(s) (`shard-001.md` or `.json`), adheres to `glossary.json` and style notes, preserves every atomic inline marker (`⟦code1⟧`, `⟦sup2⟧`, `⟦img3⟧`, `⟦a4⟧`), records its unique `translatedBy` identity, and flags genuinely ambiguous passages in `unresolved[]`. Never edits sibling shards, the source EPUB, or the classification plan, and never self-approves.
- **`verifier` (independent read-only subagent)**: runs deterministic `epub translate-check`, audits early/late translated shards and flagged QA signals against source text and glossary, emits a separate read-only verification record (`quillbind-translation-verification` with `verifiedBy !== translatedBy`), and spot-checks the built EPUB read-back and `scripts/delivery-audit.ts audit`.

When the host runtime lacks subagents, execute the exact same isolated shard files and distinct verification pass sequentially.

## Bilingual translation workflow rules

Parsed directly by [scripts/skill-rules.ts](../scripts/skill-rules.ts) and audited by [scripts/delivery-audit.ts](../scripts/delivery-audit.ts):

| Rule | Setting | Enforcement |
| --- | --- | --- |
| `external-api-key` | `forbidden` | Never require or transmit external LLM API keys; perform translation strictly via agent/subagent shard files. |
| `default-mode` | `bilingual` | Keep every original block paired with its translation unless the user explicitly asks for `target-only` output ("just Chinese", "replace the original", "single language"). |
| `plan-classification` | `coordinator-reviewed` | The `coordinator` reviews undecided (`action: null`) signature rows against real samples and sets `action`, `decidedBy: "agent"`, and `contentType` before sharding. |
| `shard-execution` | `worker-subagent` | Delegate disjoint token-budgeted translation shards (`shard-001.md` / `.json`) to dedicated `worker` subagents sharing a locked `glossary.json`. |
| `independent-verification` | `verifier-required` | An independent read-only `verifier` (`verifiedBy !== translatedBy`) runs `epub translate-check` and signs `quillbind-translation-verification` before `epub translate-build`. |
| `bilingual-css` | `lint-compliant` | `quillbind-bilingual.css` never locks body `line-height`, `font-size`, `font-family`, `color`, `background`, or `text-align: justify` (`BODY_OVERRIDE`). |

## Step 1: Intake, eligibility and pre-run snapshot (`coordinator`)

Confirm the source `.epub` path, target BCP 47 language tag (for example `zh-Hans`, `zh-Hant`, `ja`, `en`), optional chapter filter (`--only-docs` / `--exclude-docs`), optional style (`--style paired` default subtle left-accent bar, or `--style plain`), and mode (`bilingual` default; use `--mode target-only` only when explicitly requested). If the source is `.pdf`, `.mobi`, or `.azw3`, convert it to EPUB first via [conversion](conversion.md) or [PDF conversion](pdf.md).

Capture a single pre-run Calibre sidecar snapshot before writing any staged work:

```sh
node <skill-directory>/scripts/delivery-audit.ts snapshot --path /absolute/books/source.epub --output /tmp/work/before-sidecars.json
```

DRM/encrypted EPUBs (`TRANSLATE_ENCRYPTED`), fixed-layout EPUBs (`TRANSLATE_FIXED_LAYOUT`), font-obfuscated EPUBs (`TRANSLATE_FONT_OBFUSCATION`), multi-rendition, signed, and interactive scripted EPUBs (`TRANSLATE_UNSUPPORTED`) are refused loudly without modifying the source file.

## Step 2: Partition and classify the signature ledger (`coordinator`)

Run `epub translate-plan` to perform coverage-complete greedy DOM partitioning:

```sh
node <skill-directory>/scripts/quillbind.ts epub translate-plan /absolute/books/source.epub --target-lang zh-Hans --mode bilingual --token-budget 6000 --output /tmp/work/plan.json --json
```

`epub translate-plan` guarantees exact character accounting (`totalChars === translatableChars + sum(skippedChars)`), skips non-content (`<script>`, `<style>`, `<svg>`, `<math>`), ruby readings (`<rt>`, `<rp>`), pagebreaks, `translate="no"`, pure URLs, symbol-only runs, and CSS `display: none` apparatus while preserving CSS-hidden popup footnotes (`epub:type="footnote|endnote|..."`, `role="doc-footnote|doc-endnote"`). Short/wordless protected inline nodes (`<code>`, `<sup>`, `<img>`, `<br>`, `noteref`, `doc-backlink`) become collision-free atomic markers (`⟦code1⟧`, `⟦sup2⟧`, `⟦img3⟧`) rather than splitting sentences.

Inspect every `action: null` row in `plan.json`'s `ledger[]` (signature, unit count, character share, and up to 5 strided real samples) directly in the **`coordinator`** (never delegate classification blindly to a small worker):

- Set `action: "translate"` for real prose, headings, captions, table cells, footnotes, and TOC entries, or `action: "skip"` for running heads, folio page numbers (`#num`), boilerplate, or apparatus.
- Record `decidedBy: "agent"` (or `"user"`) and a descriptive `contentType` (for example `"narrative-prose"`, `"chapter-heading"`, `"folio-page-number"`) on every decided row. `epub translate-shard-init` refuses plans with remaining `action: null` rows (`TRANSLATION_PLAN_UNDECIDED`).

Create a shared book-wide glossary (`quillbind-translation-glossary`) locking character names, recurring terminology, and tone before launching parallel translation workers so terminology stays consistent across chapter shards:

```json
{
  "schemaVersion": 1,
  "kind": "quillbind-translation-glossary",
  "sourceLanguage": "en",
  "targetLanguage": "zh-Hans",
  "styleGuide": "Natural literary Simplified Chinese; preserve author register and punctuation conventions.",
  "terms": [
    { "source": "Valley", "target": "山谷", "notes": "Recurring geographic name" }
  ]
}
```

## Step 3: Initialize resumable shards and fan out `worker` subagents

Generate disjoint token-budgeted shard files (default `--format md` avoids JSON string-escaping failures on long prose; `--format json` is also supported):

```sh
node <skill-directory>/scripts/quillbind.ts epub translate-shard-init /tmp/work/plan.json --output /tmp/work/shards --format md --glossary /tmp/work/glossary.json --token-budget 6000 --json
```

Each Markdown shard (`shard-001.md`) contains YAML frontmatter (`sourceSha256`, `planSha256`, `glossarySha256`, `translatedBy`, `unresolved`) and paired `:::source{id="u-0001"}` / `:::target{id="u-0001"}` blocks.

Launch one **`worker` subagent** per shard (or disjoint batch of shards, respecting bounded concurrency). Give each worker a compact brief containing:

1. Its exact assigned shard path(s) (for example `/tmp/work/shards/shard-001.md`) and unique `translatedBy` ID (for example `worker-shard-001`).
2. Read-only path to `/tmp/work/glossary.json` and the target language / register instructions.
3. Strict rules: fill every `:::target{id="..."}` block naturally in the target language; preserve every `⟦...⟧` atomic inline marker in its natural target-language position without inventing or deleting markers; never alter `:::source` blocks, `sourceSha256`, `planSha256`, or sibling shards; record any genuinely untranslatable passage in `unresolved[]`.

Validate completed shards and merge them through the `coordinator`:

```sh
node <skill-directory>/scripts/quillbind.ts epub translate-validate-shard /tmp/work/shards --plan /tmp/work/plan.json --json
node <skill-directory>/scripts/quillbind.ts epub translate-merge /tmp/work/plan.json --shards /tmp/work/shards --output /tmp/work/translations.merged.json --json
```

## Step 4: Independent `verifier` audit and sign-off

Delegate verification to a separate read-only **`verifier` subagent** whose identity is strictly distinct from every worker's `translatedBy`. The verifier runs deterministic QA signals first:

```sh
node <skill-directory>/scripts/quillbind.ts epub translate-check /tmp/work/translations.merged.json --plan /tmp/work/plan.json --glossary /tmp/work/glossary.json --json
```

Review all surfaced signals:

- `TRANSLATION_UNIT_MISSING`: missing or blank unit translation (blocking error).
- `TRANSLATION_MARKER_MISSING` / `TRANSLATION_MARKER_INVENTED`: omitted or hallucinated `⟦...⟧` tokens.
- `TRANSLATION_ECHO_SUSPECT`: translated prose byte-identical to source text.
- `TRANSLATION_NUMERIC_SHIFT`: multi-digit numbers shifted across adjacent units (batch misalignment indicator).
- `TRANSLATION_SCRIPT_MISMATCH`: long translation lacking expected target script characters.
- `TRANSLATION_GLOSSARY_DRIFT`: unit contains a locked glossary source term without its target rendering.

Spot-check early and late shards against source prose and `glossary.json`. Route any defect back to the owning `worker` rather than co-editing the shard directly. Once clean, the `verifier` writes `/tmp/work/verification.json` (`kind: "quillbind-translation-verification"`, `sourceSha256`, `planSha256`, `verifierId`, `verifiedAt`, and per-shard `translatedBy`, `verifiedBy`, `contentSha256`, `status: "verified"`, `unresolved: []`) and confirms zero errors with:

```sh
node <skill-directory>/scripts/quillbind.ts epub translate-check /tmp/work/translations.merged.json --plan /tmp/work/plan.json --glossary /tmp/work/glossary.json --verification /tmp/work/verification.json --json
```

## Step 5: Deterministic build, CSS compliance and read-back delivery

Build the verified bilingual (or `target-only`) EPUB to a **new** output path (the source `.epub` is never overwritten):

```sh
node <skill-directory>/scripts/quillbind.ts epub translate-build /absolute/books/source.epub --plan /tmp/work/plan.json --translations /tmp/work/translations.merged.json --verification /tmp/work/verification.json --style paired --output /absolute/books/source-bilingual.epub --json
```

What `epub translate-build` guarantees:

- **Restricted content models & unique anchors**: prose blocks (`<p>`, `<li>`, `<blockquote>`, etc.) receive a paired sibling with `class="quillbind-translation"` and `lang`/`xml:lang` set to `targetLanguage` (with duplicate `id`/`xml:id`/`name` stripped and cloned bilingual `noteref` attributes sanitized so original footnote backlinks remain unique); restricted elements (`<figcaption>`, `<caption>`, `<legend>`, `<summary>`, `<td>`, `<th>`, `<h1>`–`<h6>`, and `<nav>` items) receive inline `<br/><span class="quillbind-translation" lang="...">` so EPUBCheck and document outlines stay valid. EPUB 2 `toc.ncx` labels stay synchronized.
- **Distinct deterministic identity & OPF language metadata**: derives a reproducible UUIDv5 `dc:identifier` (preserving original ID in `dc:source`), adds `targetLanguage` as a second `<dc:language>` in `bilingual` mode (or replaces `<dc:language>` in `target-only` mode), and checks double-render byte equality (`reproducible: true`).
- **`lintCss`-compliant bilingual styling**: injects `quillbind-bilingual.css` (`paired` subtle `currentColor` inline-start bar or `plain` vertical rhythm) with zero `BODY_OVERRIDE` violations so light/dark/sepia themes, font changes, and 200% zoom work seamlessly.
- **Mandatory validation & read-back**: runs internal EPUB validation, actual **EPUBCheck**, and sampled Chromium **reading QA** (default, 200% large 320px, dark mode), writing `<output>.reports/translation.json` (pass `--release` when full publication release gates including Ace and platform lint are required).

Before handoff, run post-build read-back checks (`inspect`, `epub check-notes` when footnotes exist) and audit delivery evidence + Calibre sidecars with `scripts/delivery-audit.ts audit` supplying `translationReport` (`<output>.reports/translation.json`) and `translationVerificationReport` (`/tmp/work/verification.json`) per [quality](quality.md).
