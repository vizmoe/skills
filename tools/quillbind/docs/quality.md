# Quality implementation

The [evidence and delivery reference](../../../skills/quillbind/references/quality.md) is authoritative for operation outcomes, release gates, report interpretation, platform exclusions and handoff claims. This page describes how browser and visual checks obtain their evidence. Runtime versions come from [tools.lock.json](../standards/tools.lock.json); dependency integrity comes from [dependencies.lock.json](../standards/dependencies.lock.json).

## Browser checks

QA serves packaged XHTML and assets from an isolated loopback HTTP server. It rejects unsafe inputs before opening Chromium, blocks external requests and reports loading or script failures. Full coverage is the default: every spine and navigation document runs at 320, 390, 768 and 1280 CSS pixels, with device scale factor 1, locale `en-US` and timezone UTC. The four modes are default, 200% text with monospace and line-spacing overrides, dark reader colors and grayscale. Each document has 16 matrix cases plus one CSS-column pagination case. The scale values describe these modes; they are not another multiplier.

`preflight` and `preview` return `qaProjection` before browser work: document assignments, case counts and estimated screenshot storage. Preflight uses parsed sources plus generated front matter; a failed parse marks the projection incomplete. Preview uses the packaged candidate. PNG estimates use 32–256 KiB per full-page screenshot, with no size guarantee; long or image-heavy pages may exceed that range. These estimates exclude Ace, EPUBCheck, rendering time and other reports.

For large books, explicitly select `qa.coverage: stratified` in `book.yaml` or pass `--qa-coverage stratified` to preflight, preview, build or standalone QA. Every document still runs default mode at all four widths, initial axe/code/link checks and pagination. Extra reader modes run on 12 evenly spaced documents, augmented by the first/middle/last document in each detected layout stratum: code, tables, MathML, images, footnotes, RTL, vertical writing, cover and navigation. Selection is deterministic in reading order. Small books may still select every document. `coverage.json` records policy version, selection reasons, per-document modes, planned/executed cases and unexecuted cases; missing planned cases fail QA. Release summaries state the strategy and full-matrix document count. This is sampled reader-mode coverage, not exhaustive testing of every mode on every page. All other release gates retain their full scope.

The default screenshot policy is `failures-and-samples`: keep every failed case plus each mode at 390px for the first/middle/last selected document. Passing matrix runs normally retain at most 12 screenshots, independently of book length. `qa.screenshots: all` restores every matrix screenshot. Coverage records retained paths, reasons and actual bytes; current-run screenshot files replace the prior set, and names include the full document path hash to avoid basename collisions. Screenshot retention does not change which checks run. Visual regression diffs remain separate.

Checks cover visible content, hidden or clipped blocks, horizontal overflow, image decoding/aspect ratio, keyboard-scrollable wide tables, exact code text, MathML dimensions, local links, page-marker anchors and footnote/backlink navigation. Axe runs WCAG-tagged automatic rules and additional contrast checks in dark and grayscale modes. Pagination checks source text equality and rendered text fragments. The fixture set includes CJK literature, English technical writing, Arabic RTL, Japanese vertical writing and long code/tables.

## Visual regression

[Dockerfile.qa](../Dockerfile.qa) pins a Linux arm64 Ubuntu Noble browser image and the Node image by immutable digest. Tool archives are pinned by SHA-256 and npm dependencies by lockfile integrity. The base image fonts are supplemented with the checksum-pinned Noto CJK regular/bold faces in [qa-fonts.lock.json](../standards/qa-fonts.lock.json). Native macOS QA supports development; reference pixel comparisons run in `linux-arm64-noble-v2`.

`tests/visual/publication.spec.ts` compares actual EPUB chapter screenshots with committed PNGs at zero pixel difference. `tests/baselines/review.json` records review criteria, browser, theme hashes and the QA font lock hash. Missing or mismatched references fail. CI never updates snapshots. To change a reference, explicitly generate candidates with `scripts/baseline-candidate.ts` in the pinned container with `CI` unset, inspect the images, record the reason and hashes, then commit the reviewed files. The candidate script cannot replace approved files.

Separate packaged-EPUB regressions check block-image centering, inline-image flow and Markdown typography in both themes, LTR, RTL and vertical writing. Typography checks simulate serif/sans-serif font changes, enlarged text, dark colors and grayscale; they assert emphasis, quotation styling, table alignment and positive CJK glyph advances so zero-advance font failures cannot pass on CSS properties alone.

## Determinism

A fixed `build.epoch` controls ZIP timestamps and `dcterms:modified`. Sorted entries, stable resource names and XML serialization combine with fixed-level deflate under the pinned Node/zlib runtime. `mimetype` remains stored; other entries stay stored when compression would grow them. Every release build reconstructs the publication and compares complete bytes. Saved Chinese conversion locks fix external responses across builds. Report durations and absolute local paths are observational data and are outside byte equality.

Use the commands and lock maintenance procedure in [development.md](development.md) for repository verification.
