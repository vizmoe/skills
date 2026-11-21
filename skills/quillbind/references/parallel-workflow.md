# Parallel subagent workflow (coordinator, worker, verifier)

When the host runtime provides subagent, multi-agent, task-fanout or worker-pool capabilities, accelerate multi-slice `quillbind` tasks by splitting execution into three explicit roles: **`coordinator`**, **`worker`**, and **`verifier`**.

This workflow is **agent-agnostic**: it does not depend on any vendor, IDE, CLI harness or specific model name. Map the three roles onto whatever subagent or parallel-task primitives the current agent environment offers; when running in a single-agent environment without subagents, execute the same isolated slices and independent verification gates sequentially.

## Subagent role contracts

Parsed directly by [scripts/skill-rules.ts](../scripts/skill-rules.ts):

| Role | Write scope | Self-approval | Responsibility |
| --- | --- | --- | --- |
| `coordinator` | `shared-plan-and-merge` | `forbidden` | Inspect inputs, take pre-run `scripts/delivery-audit.ts snapshot`, lock shared vocabularies/sources, partition non-overlapping slices, merge verified worker outputs, and assemble the final report. |
| `worker` | `assigned-slice-only` | `forbidden` | Execute deterministic transformations, source extraction or staged file writes strictly inside its assigned book, chapter or volume slice; never touch sibling slices or shared library sidecars. |
| `verifier` | `read-only-reports` | `allowed` | Independently audit worker outputs against source evidence, SHA-256 chains, rule tables, EPUBCheck/Ace/QA gates and Calibre sidecar snapshots; report defects back to the owning `worker` without editing target artifacts directly. |

### Non-collision invariants

1. **Disjoint ownership before launch**: never assign two `worker` instances to write the same file, staging directory, `.build.lock` or `.conversion.lock`. Every worker receives an explicit input digest, slice boundary and isolated staging path.
2. **Verifier never co-edits**: a `verifier` is strictly read-only on target books and intermediate specs, writing only isolated verification logs or read-only verification reports. When a check fails, route exact file/page/code diagnostics back to the owning `worker` to fix, then re-verify.
3. **No self-approval**: a `worker` or `coordinator` must never sign off on its own output as `verifier`; verification records must identify an independent `verifier` identity distinct from the producer.
4. **Single pre-run snapshot and shared locks**: the `coordinator` captures `scripts/delivery-audit.ts snapshot` and resolves shared read-only inputs (such as `--vocabulary` tag files or series-wide search locks) once before fanning out `worker` tasks, then runs `scripts/delivery-audit.ts audit` after all slices complete.
5. **Bounded concurrency for external services and heavy tools**: respect upstream rate limits (`novel`, `metadata catalog`, `bookwalker-search`, `zhconvert`) and host CPU/RAM budgets (Chromium `qa`, `cjxl`, EPUBCheck JVMs) by batching into sensible shard counts rather than spawning unbounded parallel processes.

## Parallelizable task blueprints across Quillbind

Use subagent parallelism whenever a task has clear isolation boundaries across any multi-book, multi-volume or multi-chapter operation:

| Task family | Isolation unit (`worker` slice) | `coordinator` synthesis | `verifier` gate |
| --- | --- | --- | --- |
| [PDF inspection, visual tiling & sharded transcription](pdf.md) | Token-budgeted page shard (`shard-01`, `shard-02`, …) writing one `.md` or `.json` file per completed page from rendered full-page PNGs and `--tiles` crops | Run `pdf inspect --render-dir --tiles`, `pdf init-spec`, and `pdf shard-init`; validate with `pdf validate-shard`; run `pdf merge-shards` preserving explicit `false` stitch judgments and checking global footnote ID uniqueness | Run `pdf check-spec` (line-projection, ink-area, OCR edit-distance, charset, table-grid and footnote signals), inspect tiles visually, and emit read-only `quillbind-pdf-verification` with `verifiedBy !== transcribedBy` and page `contentSha256` / `renderSha256` |
| [Batch embedded metadata, tags, ratings, series & covers](embedded-metadata.md) | One ebook (`.epub` or `.cbz`) and its private staging path per worker (`bibliography-audit/clean`, `tags-audit/apply`, `ratings-clean`, `series-normalize`, `cover-audit/adopt`) | Snapshot Calibre sidecars once (`delivery-audit.ts snapshot`), freeze `--vocabulary` (`tag-vocabulary.json`), partition books, and consolidate final `delivery-report.json` | Independent metadata readback, `EPUBCheck` or `xmllint --nonet` ComicInfo XSD check, and `scripts/delivery-audit.ts audit` confirming untouched `metadata.db`, `metadata.opf` and `cover.jpg` |
| [Whole-series light-novel naming](naming.md) | Per-volume or per-subseries bibliographic/BookWalker evidence gathering (`metadata bookwalker`, `edition`, `catalog`) | Combine verified volume evidence into one series inventory and run `scripts/naming.ts plan` | Run `scripts/delivery-audit.ts verify-naming` to verify all source SHA-256 digests, official vs `.5` numbering evidence, and zero destination collisions |
| [Markdown / blog authoring, novel collection & Chinese conversion](authoring.md) | Disjoint chapter `.md` files (formatting tables, `:ruby`, TeX math, footnotes) or independent volumes via `novel fetch --prepare-only` | Assemble `book.yaml` navigation order, resolve project metadata/conversion locks, and run `preflight` + `build` | Inspect `dist/reports/summary.json`, `epubcheck.json`, `ace/report.json`, `qa/report.json` and `conversion.json` (`runId` match and byte reproducibility) |
| [Batch EPUB repair & anthology splitting](local-splitting.md) | Disjoint subdirectories/books for `epub repair` / `repair-copy`, or per-volume inspection after `epub split-plan` / `epub split` | Approve split boundaries or per-book repair plans and aggregate batch outcomes (`partial` vs `completed`) | Verify chapter/asset/footnote closure (`epub check-notes`), `remaining-findings.json`, `validate` and unchanged source anthology hashes |
| [Multi-volume manga scan packaging](manga.md) | One volume scan directory/archive + its matched BookWalker lock (`manga package`) into a dedicated output `.cbz` | Resolve series BookWalker candidate URLs, assign volume slices, and collect per-volume SHA-256 manifests | Verify lossless JPEG XL round-trip evidence, page order, `ComicInfo.xml` 2.0 XSD validity, original JP release date policy, and untouched source scans |

## Standard handoff payload between roles

Keep inter-agent handoffs compact and deterministic by exchanging file paths and digests rather than pasting full book text into prompts:

1. **`coordinator` → `worker` brief**:
   - Task branch and reference file to follow (for example, `references/embedded-metadata.md`).
   - Exact owned input path(s), SHA-256 digest(s), and chapter/volume/book slice bounds.
   - Exact owned output staging path(s) and forbidden paths (sibling slices, source originals unless backed up, Calibre sidecars).
   - Completion criteria and required JSON summary fields.
2. **`worker` → `verifier` / `coordinator` report**:
   - Produced artifact/slice path(s) and SHA-256 digest(s).
   - Deterministic command exit codes and report file paths.
   - Explicit anomalies or unresolved items (never hidden or guessed).
3. **`verifier` → `worker` (on defect) or `coordinator` (on pass)**:
   - On defect: exact failing check code, file/page/line location, and minimal reproduction command routed directly to the owning `worker`.
   - On pass: verified artifact SHA-256 chain, executed validator list (`EPUBCheck`, `Ace`, `qa`, `xmllint`, `delivery-audit`), and remaining scope disclosures (`nativeReaderTesting: not-run`, sandbox browser limits, or unresolved upstream ISBNs).
