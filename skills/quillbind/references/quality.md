# Evidence and delivery

## Match evidence to the operation

[Tag audits](tags.md) return input/vocabulary hashes, per-book proposals and unresolved findings; they do not write or verify a library. Live synchronization needs independent database, sidecar and embedded-format readback plus non-target preservation evidence. Publication release gates remain separate.

[Embedded metadata maintenance](embedded-metadata.md) requires source/staged/installed hashes, per-field evidence and independent readback. CBZ checks cover `ComicInfo.xml` schema, non-target XML semantics, ZIP CRCs and unchanged page/member bytes and order; EPUB checks cover OPF semantics, non-OPF member bytes and actual EPUBCheck results. Report staged-only or partial synchronization explicitly. These checks do not imply that images were re-encoded, native readers were tested or an EPUB publication was released.

| Operation      | Evidence and handoff                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preparation    | `metadata/preparation.json`: copied-source hashes and readiness; release is `not-run`.                                                                                                                                                |
| Preview        | CLI `status: preview`, `candidate`, `publicationReady: false`, release gates `not-run`. Link the candidate for author review. Existing release files and reports belong to their earlier run.                                         |
| Reading repair | Its own `summary.json` and `remaining-findings.json`, or directory `repair-summary.json`. Report the `copy` hash, integrity, idempotence, remaining findings and sampled browser coverage. Full publication QA and Ace are `not-run`. |
| Publication    | `build`, publication `repair`, `epub convert` and `epub enrich` require every release gate below.                                                                                                                                     |

Manga CBZ uses its own [image/archive evidence](manga.md#comicinfo-and-handoff): report the artifact hash, per-page lossless checks, source provenance and JPEG XL reader requirement. It does not claim EPUB conformance or platform publication. The release evidence below applies to EPUB.

[Popup-note checks](notes.md) have separate static and interaction results, source-bound cases, activation modes and screenshots. Static inspection and reading repair do not execute source scripts. Regular browser QA disables those scripts, so its success cannot establish a scripted popup works. Explicit note checks do not replace any release gate or native-reader verification.

A reading copy can satisfy personal use while retaining source conformance or accessibility findings. A preview supplies layout feedback after one render. Neither has a release artifact or `build.json`.

## Release evidence

The canonical target is [EPUB 3.3](https://www.w3.org/TR/epub-33/) with package `version="3.0"`. Metadata resolution, standalone preflight, internal validation, EPUBCheck, Ace, browser QA, both platform lints and repeated-byte verification gate new-book release. Publication repair additionally verifies protected content and idempotence. Existing EPUB conversion validates the converted publication through the same release gates.

Run `doctor --json` first. Missing tooling is an environment error. EPUBCheck warnings and errors block release; all required gates must pass. Large books can use `QUILLBIND_TIMEOUT_SECONDS` to extend the launcher's default 1,800-second limit while retaining gate checks.

Start with the current `summary.md` and `summary.json`. Match their `runId` with `build.json`. Each run starts its checks as `not-run`, then records `running`, `pass` or `fail`. A failed summary has no released artifact; older detailed files and an older EPUB may remain on disk. Failures before a run opens return a structured CLI error.

Name the released artifact and SHA-256, link the summary, state checks actually executed, and list actionable warnings or blockers. Report platform `distribution` separately from technical severity. Build reports live in `dist/reports/`; existing EPUB conversion uses `<output>.reports/`.

| Detailed evidence                                    | Meaning                                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `build.json`, `preflight.json`, `metadata.json`      | Source and release outcome                                                                                |
| `epubcheck.json`, `epubcheck.txt`                    | EPUB conformance                                                                                          |
| `ace/report.json`, `ace/report.html`, execution logs | Automated accessibility checks                                                                            |
| `qa/report.json`, `coverage.json`, screenshots       | Browser QA and environment coverage                                                                       |
| `apple-books-lint.json`, `kindle-lint.json`          | Guideline checks and distribution status                                                                  |
| `compression.json`, `reproducibility.json`           | ZIP policy, runtime, entry methods and repeated-build byte equality                                       |
| `repair/content-integrity.json`                      | Existing-publication preservation                                                                         |
| `images.json`                                        | Image hashes, sizes and lossless verification                                                             |
| `conversion.json`                                    | Target, dictionary revision, lock path/input hash, response snapshot and online refresh or saved-lock use |

## Report the actual scope

Browser QA exercises widths, enlarged text, reader font/line/color overrides, grayscale, resources, pagination and note round trips. Its coverage report gives the tested scope. Reviewed visual references belong to the pinned container; a failing comparison requires inspection and a documented baseline review.

Before a large release, use `qaProjection` from preflight or preview to report planned cases and estimated screenshot storage; the byte range is a heuristic. Full reader-mode coverage is the default. An explicit `--qa-coverage stratified` or `qa.coverage: stratified` keeps default-mode, link, axe and pagination checks on every document and samples extra reader modes. At handoff, state the recorded strategy, full-matrix document count and any unexecuted cases from `coverage.json`. Passing runs normally retain at most 12 representative screenshots; failures retain additional evidence. Screenshot count is not the count of checks run.

Use `automatedAccessibilityChecks: pass|fail`. Never claim device testing, WCAG certification, complete accessibility or store publication from automated checks. Semantic matters such as translation quality and meaningful image descriptions require appropriate human evidence.

Both platform lints inspect the same EPUB. KDP publication-language eligibility and additional HTML cover-page review are excluded from lint; relay the returned diagnostics. Source-size warnings are delivery decisions, not permission to resize or truncate content. Include `COVER_RESOLUTION_LOW` with its path and dimensions and continue the authorized build using the original cover. Technical compatibility does not establish vendor acceptance.
