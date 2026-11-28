# Evidence and delivery

## Match evidence to the operation

| Operation | Required verification & handoff evidence | Publication status |
| --- | --- | --- |
| Tag inventory audit (`scripts/tags.ts`) | Input/vocabulary/decision SHA-256 digests, per-book `proposed` and `unresolved` arrays; writes no ebooks. | `libraryWritten: false`, `publicationReady: false` |
| Embedded metadata maintenance (`metadata *-clean`, `tags-apply`, `series-normalize`, `cover-adopt`) | Source/backup/staged/final SHA-256 chain, `<output>.reports/metadata.json`, independent field readback, actual EPUBCheck or `xmllint --nonet` ComicInfo 2.0 XSD pass, ISBN disposition (`attemptedSources` when `unresolved`), [self-made identification](bibliography.md#self-made-and-non-retail-editions), [synopsis translation source](bibliography.md#describe-the-work-not-the-file), and unchanged Calibre sidecars via `scripts/delivery-audit.ts`. | File maintenance (`publicationReady: false` unless `epub enrich` release gates ran) |
| Preparation (`init`) | `metadata/preparation.json` with copied-source hashes and readiness. | Release gates `not-run` |
| Preview (`preview`) | CLI `status: preview`, `candidate` link for author review. | `publicationReady: false`, release gates `not-run` |
| Reading repair (`epub repair-copy`, `epub repair-dir`) | `summary.json`, `remaining-findings.json` (or `repair-summary.json`), `copy` SHA-256, content integrity, idempotence and sampled reading QA. | Ace and platform release gates `not-run` |
| Format conversion (`epub convert` without `--to`) | `<output>.reports/import.json` (Kindle: `mobi6`, `kf8`, `combo-kf8`) or `<output>.reports/pdf-import.json` (PDF: `digital`, `scanned`, `hybrid`), source/output SHA-256, internal validation, EPUBCheck, sampled reading QA and repeated-build byte equality. | `publicationReady: false`, release gates `not-run` |
| PDF reconstruction (`pdf build-epub`, `pdf enhance-image`) | [PDF workflow evidence](pdf.md#build-and-mandatory-post-generation-validation): `<output>.reports/pdf-import.json` (verified frontmatter spine `cover -> titlepage -> colophon -> toc`, `colophonExcludedFromToc: true`, `figureProvenance` with `generativeRedraw: false`, independent `verification` evidence, zero-error/zero-warning EPUBCheck, `inspect`, `epub audit`, `check-notes`, `qa`), `*.enhance.json` + comparison heatmaps, and evidence-backed `scripts/delivery-audit.ts audit` (`pdfImportReport`, `verificationReport`, `enhanceReports`). | `publicationReady: false` unless `--release` or `--to` ran all release gates |
| Scanned PDF OCR/bookmark repair (`pdf repair-ocr`) | [PDF OCR repair evidence](pdf.md#scanned-pdf-ocr-layer-and-bookmark-repair): `<output>.reports/pdf-repair.json` (`incrementalUpdate: true`, `ocrLayerVerified: true`, `preservedImageStreams.verifiedBitIdentical: true`, `pageAlignments[]`), independent `verificationReport`, optional backup hash, and evidence-backed `scripts/delivery-audit.ts audit` (`pdfRepairReport`, `verificationReport`). | Separate PDF artifact (not EPUB conformance) |
| Bilingual EPUB translation (`epub translate-build`) | [Bilingual EPUB translation evidence](bilingual-translation.md#step-5-deterministic-build-css-compliance-and-read-back-delivery): `<output>.reports/translation.json` (source/output/plan/verification SHA-256 chain, derived UUIDv5 identifier, `reproducible: true`, zero-error EPUBCheck, sampled reading QA), independent `translationVerificationReport` (`verifiedBy !== translatedBy`), read-back check, and evidence-backed `scripts/delivery-audit.ts audit` (`translationReport`, `translationVerificationReport`). | `publicationReady: false` unless `--release` ran all release gates |
| Manga scan packaging (`manga package`) | [Image/archive evidence](manga.md#comicinfo-and-handoff): CBZ SHA-256, per-page lossless JXL verification, BookWalker lock provenance and JXL reader note. | Separate CBZ contract (not EPUB conformance) |
| Popup-note verification (`epub check-notes`) | Separate static structure inventory and optional Chromium interaction results (`notes.md`); regular browser QA disables source scripts and never proves popups work. | Diagnostic check only |
| EPUB publication (`build`, publication `repair`, `epub convert --to`, `epub enrich`) | Every release gate in [release evidence](#release-evidence) passing with matched `runId`. | `publicationReady: true` |

### Maintenance delivery statuses

Parsed directly by [scripts/skill-rules.ts](../scripts/skill-rules.ts) and enforced by [scripts/delivery-audit.ts](../scripts/delivery-audit.ts):

| Status | Files written | Meaning |
| --- | --- | --- |
| `plan-only` | `no` | Read-only audit or naming/tag/bibliography plan produced; no target or output ebook written. |
| `staged-only` | `no` | Staged candidate built/validated in staging area, but final destination was not written or installed. |
| `partial` | `no` | Batch completed authorized writes on a subset of items while reporting blocked/unresolved items explicitly (`items[].final` present only on completed items). |
| `completed` | `yes` | Every scoped file write passed validation, independent readback and SHA-256 verification (with `backup` retained for any in-place replacement). |
| `blocked` | `no` | Missing validator, encrypted/signed book, ambiguous metadata or collision prevented writing; originals untouched. |

### Protected Calibre sidecars

Parsed directly by [scripts/skill-rules.ts](../scripts/skill-rules.ts) and checked before/after file maintenance by [scripts/delivery-audit.ts](../scripts/delivery-audit.ts):

| File | Inspection | Rule |
| --- | --- | --- |
| `metadata.db` | `stat-only` | Never open, query or modify a Calibre SQLite database; verify existence, file size and `mtimeMs` are unchanged without touching SQLite locks. |
| `metadata.opf` | `sha256` | Never export or edit Calibre's directory sidecar OPF; verify byte hash is unchanged. |
| `cover.jpg` | `sha256` | Never overwrite or sync Calibre's directory cover file; verify byte hash is unchanged. |

```sh
node <skill-directory>/scripts/delivery-audit.ts snapshot --path /absolute/books/target.epub --output before-sidecars.json
node <skill-directory>/scripts/delivery-audit.ts audit --input delivery-report.json --before before-sidecars.json --output delivery-audit.json
```

## Release evidence

Canonical publication output is [EPUB 3.3](https://www.w3.org/TR/epub-33/) (`version="3.0"`). Run `doctor --json` first (`QUILLBIND_TIMEOUT_SECONDS` extends the 1,800s default for large books); missing validators return `ENVIRONMENT_ERROR`, and any EPUBCheck warning or error blocks release. Match `runId` across `summary.md`, `summary.json` and `build.json` (`dist/reports/` for builds; `<output>.reports/` for `epub convert --to` and `epub enrich`).

| Detailed evidence | Verified gate |
| --- | --- |
| `build.json`, `preflight.json`, `metadata.json` | Source lock hashes, metadata readiness and release outcome (`pass` / `fail`) |
| `epubcheck.json`, `epubcheck.txt` | Zero-error, zero-warning EPUBCheck conformance |
| `ace/report.json`, `ace/report.html` | Automated accessibility (`automatedAccessibilityChecks: pass\|fail` — never claim WCAG certification or device testing) |
| `qa/report.json`, `coverage.json`, screenshots | Browser QA across widths, zoom, font/line/color overrides, grayscale, pagination and link/note round trips (`full` by default, or explicit `stratified` with strategy, document count and unexecuted cases reported; `qaProjection` estimates screenshot storage beforehand) |
| `apple-books-lint.json`, `kindle-lint.json` | Platform guidelines and `distribution` status (relay `COVER_RESOLUTION_LOW` with path and dimensions without resizing original covers; technical lint does not guarantee store acceptance) |
| `compression.json`, `reproducibility.json` | ZIP entry methods and repeated-build byte equality |
| `repair/content-integrity.json`, `images.json`, `conversion.json` | Protected-content preservation, lossless image hashes and `zhconvert` dictionary/lock provenance |
