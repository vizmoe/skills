# PDF inspection, visual tiling, sharding and transcription QA

Quillbind handles PDFs without external OCR models. Responsibilities are strictly divided:

- **Multimodal LLM (`worker` / `verifier`)**: reads rendered page images and cropped visual tiles to transcribe and structure text (`blocks`, `footnotes`, inline `:ruby`, TeX math, tables, voices, explicit cross-page flags) and records illegible passages in `unresolved[]`.
- **Deterministic runtime tools (`pdf ...`)**: inspect PDF structure and `ocrTrust`, extract native digital PDFs via `pdftotext -bbox-layout` with selective NFKC normalization and embedded figure extraction, render high-DPI page PNGs and overlapping visual tiles (`--tiles`), compute deterministic line coordinates (`geometry`), budget page shards by vision image tokens, compile per-page Markdown into strict spec blocks, run cheap non-LLM QA signals, and enforce independent `verifier` sign-off.

For multi-page scans, parallelize isolated page shards using the `coordinator` / `worker` / `verifier` pattern in [parallel subagent workflow](parallel-workflow.md).

## Triage, `ocrTrust` gating and visual tiling

Inspect every PDF first and export rendered PNGs with visual tiles when pages require visual transcription:

```sh
node <skill-directory>/scripts/quillbind.ts pdf inspect /absolute/books/source.pdf --render-dir /tmp/work/pages-view --dpi 300 --tiles --token-budget 16000 --json
```

`pdf inspect` reports per-page `classification` (`digital`, `scanned`, `hybrid`, `empty`), `ocrTrust` (`digital-native`, `verified`, `unverified-embedded`, `none`), embedded image stream inventory (`streamSha256`, dimensions, filter, estimated DPI), `/Outlines` bookmarks, suspect scanner OCR (`/ReaddleObject` or invisible `3 Tr` streams), and token-budgeted `shards` (`--token-budget`, or explicit `--shard-size N`). Encrypted PDFs fail with `PDF_ENCRYPTED`; never bypass DRM.

- **Verification gate uses `ocrTrust`, not `classification`**: only pages with `ocrTrust: "unverified-embedded"` or non-empty pages with `ocrTrust: "none"` require visual LLM transcription and independent verification. A `hybrid` page with native visible text plus an embedded photo has `ocrTrust: "digital-native"` and does not require LLM OCR proofreading.
- **Why `--tiles` is required for high-DPI scans**: a 300 DPI A4 page (~2480×3508 px) is downsampled by most vision models, making ruby furigana, superscript footnote callouts, and small bottom-of-page notes unreadable. `--tiles` slices each rendered page into overlapping horizontal `band` strips plus dedicated `header`, `footer`, and `footnote-zone` crops and records pixel + normalized coordinates and SHA-256 digests in `render-manifest.json`. Always view the full page first to confirm layout/columns/figures, then transcribe from the tiles and list the reviewed tile IDs in `tilesReviewed`.

## Spec initialization and per-page Markdown / shard authoring

Initialize the base spec (`quillbind-pdf-spec`), capturing deterministic `geometry` coordinates (priority: 1. existing OCR layer boxes, 2. `pdftotext -bbox-layout` boxes, 3. `sharp` horizontal-projection line boxes on rendered PNGs) separately from transcribed `blocks`:

```sh
node <skill-directory>/scripts/quillbind.ts pdf init-spec /absolute/books/source.pdf --output /tmp/work/spec.base.json --render-dir /tmp/work/pages-view --dpi 300 --tiles --assets-dir /tmp/work/assets --json
```

Generate editable drafts for workers with `pdf shard-init` (default `--format md` writes one Markdown file per page under each shard folder, pre-populated with render/tile paths and draft text from native or hidden OCR layers; `--format json` writes `quillbind-pdf-shard` JSON skeletons):

```sh
node <skill-directory>/scripts/quillbind.ts pdf shard-init /tmp/work/spec.base.json --output /tmp/work/shards --format md --render-manifest /tmp/work/pages-view/render-manifest.json --json
```

Prefer **per-page Markdown (`p0001.md`)** over hand-writing nested JSON. Each worker writes one file per completed page so interrupted runs can resume cleanly:

```markdown
---
page: 12
sourceSha256: "<64-hex>"
transcribedBy: "worker-shard-01"
renderPath: "/tmp/work/pages-view/p0012.png"
renderSha256: "<64-hex>"
dpi: 300
tilesReviewed:
  - "p0012-band-01"
  - "p0012-band-02"
  - "p0012-footnote-zone"
unresolved: []
---

::continue-prev

上一页未完的句子在此衔接，文中含 :ruby[金石]{reading="jīn shí"} 与注释[^1] 以及公式 $E=mc^2$。

::no-stitch-next

:::voice{kind="verse"}
断碑残字入苍苔，
千载摩挲辨劫灰。
:::

[^1]: 本页脚注自动命名为 `p12-1`。

::footnote-continue[上一页跨页脚注的续接文本。]{id="p11-1" label="①"}
```

Supported per-page Markdown constructs:

- Frontmatter: `page`, `sourceSha256`, `transcribedBy`, `renderPath`, `renderSha256`, `dpi`, `tilesReviewed[]`, optional `sectionId`, and `unresolved[]`.
- Inline syntax: `**bold**`, `*italic*`, `` `code` ``, `:sup[text]`, `:sub[text]`, `:ruby[base]{reading="rt"}`, `$tex$`, `[^1]` (automatically page-namespaced to `p<page>-1`), and `:unresolved[reason]{location="..."}`.
- Block directives: `::continue-prev`, `::no-continue-prev`, `::stitch-next`, `::no-stitch-next`, `::subtitle[...]`, `::byline[...]`, `:::voice{kind="epigraph|quote|verse|dialogue|signature"}`, `::caption[...]` before GFM tables (or a fenced `json table` block for `rowspan`/`colspan` tables), `::figure[caption]{src="..." alt="..."}`, `::footnote-continue[text]{id="p11-1" label="①"}`, and `::unresolved[reason]{location="..."}`.
- `quillbind-pdf-shard` / `quillbind-pdf-page` JSON files remain supported when structured JSON is preferred (`schemaVersion: 1`, `kind: "quillbind-pdf-shard" | "quillbind-pdf-page"`, `sourceSha256`, `pages[]` or `page`).

Validate worker outputs with line-numbered diagnostics before merging:

```sh
node <skill-directory>/scripts/quillbind.ts pdf validate-shard /tmp/work/shards --json
```

Merge shard JSONs, per-page JSONs, or per-page Markdown files deterministically through the coordinator:

```sh
node <skill-directory>/scripts/quillbind.ts pdf merge-shards /tmp/work/spec.base.json --shards /tmp/work/shards --output /tmp/work/spec.merged.json --json
```

`pdf merge-shards` preserves deterministic `geometry` and `rawOcrDraft` from the base spec, enforces global footnote ID uniqueness (`FOOTNOTE_ID_COLLISION`), validates `rowspan`/`colspan` table grids (`PDF_TABLE_GRID_INVALID`), requires explicit `continueFromPrevPage: true` for cross-page footnote continuations, and never overwrites explicit `stitchWithNextPage: false` or `continueFromPrevPage: false` judgments made by the LLM.

## Proofreading checklist for multimodal LLMs

Never blindly trust embedded scan OCR (`/ReaddleObject` or invisible `3 Tr` streams), and actively guard against failure modes specific to multimodal LLMs:

- **Do not silently "correct" original typography**: preserve source misprints, variant glyphs (异体字), and old glyph forms (旧字形) faithfully instead of normalizing them to modern standard forms.
- **Do not auto-convert Chinese scripts**: never convert Simplified to Traditional or Traditional to Simplified during transcription.
- **Do not normalize punctuation width**: preserve original fullwidth vs halfwidth punctuation and quotation conventions (`「」`, `“”`, `——`, `……`).
- **Follow visual layout reading order**: transcribe columns, marginalia, and notes according to page layout rather than reordering sentences semantically.
- **Never guess illegible glyphs**: whenever a character, superscript, or symbol cannot be read with certainty from the full page and tiles, record it in `unresolved[]` (or `::unresolved[...]`) instead of inventing plausible text.
- **Check classic scan-recognition pitfalls**: decorative headings (`的` vs `前`/`内`/`时`), near-homoglyphs (`间`/`问`, `人`/`入`, `己`/`已`/`巳`, `未`/`末`, `0`/`O`, `1`/`l`/`I`, `rn`/`m`), dropped line-end particles, and small ruby/superscript footnote callouts.

## Independent verification and deterministic QA signals

A bare self-reported boolean is insufficient: workers must never self-approve their own pages. The read-only `verifier` runs deterministic QA checks first:

```sh
node <skill-directory>/scripts/quillbind.ts pdf check-spec /tmp/work/spec.merged.json --render-manifest /tmp/work/pages-view/render-manifest.json --json
```

`pdf check-spec` computes non-LLM review signals per page to spotlight anomalies for the `verifier`:

| Signal | Deterministic check | Defects surfaced |
| --- | --- | --- |
| Line count | `sharp` horizontal-projection line count vs transcribed line count | Dropped or duplicated lines |
| Character count | Ink-area / line-width estimate vs transcribed character count | Truncation or hallucinated additions |
| Original OCR diff | Edit distance against original hidden OCR draft (`rawOcrDraft`, signal only — never ground truth) | Whole-paragraph omissions or unintended rewrites |
| Script and charset | PUA chars (`U+E000..U+F8FF`), `U+FFFD`, unnormalized Kangxi radicals, Simplified/Traditional mixing, halfwidth ASCII punctuation inside CJK | Script conversion, punctuation drift, encoding artifacts |
| Structure | 2D table grid occupancy (`rowspan`/`colspan` column alignment) and 1-to-1 `noteref` ↔ `footnote` pairing | Broken tables, missing or unreferenced footnotes, ID collisions |

After visually auditing the rendered pages, tiles, and flagged signals, the `verifier` writes a separate read-only verification file (`quillbind-pdf-verification`) binding `sourceSha256`, `verifierId` (strictly distinct from every page's `transcribedBy`), and per-page `renderSha256`, `dpi`, `tilesReviewed[]`, `contentSha256`, `status: "verified" | "rejected"`, and `unresolved[]`. Re-run `pdf check-spec --verification <verification.json> --render-manifest <render-manifest.json>` to confirm zero errors (`PDF_SELF_APPROVAL_FORBIDDEN`, `PDF_VERIFICATION_STALE`, `PDF_RENDER_HASH_MISMATCH`, `PDF_UNRESOLVED_ITEMS`).

## Reflowable horizontal layout and typographic preservation

PDF-to-EPUB output defaults to **single-column horizontal reflowable EPUB 3.3**:

- Package metadata sets `rendition:layout` to `reflowable`, `rendition:spread` to `none`, and `rendition:orientation` to `auto`; `<spine page-progression-direction="ltr">` marks every `<itemref>` with `properties="rendition:spread-none"`.
- Stylesheets set `writing-mode: horizontal-tb` and `column-count: 1` without `@charset`, fixed viewport heights or `body` font-size/color/line-height overrides (`BODY_OVERRIDE`). Note in handoff when relevant that wide desktop viewers such as Calibre `ebook-viewer` default to multi-column paged view above `70em` unless switched to Flow mode or 1 column per screen in viewer preferences.
- Preserve source typographic hierarchy semantically: chapter `<h1>` headings (one top `<h1>` per spine file with monotonic `<h2>`–`<h6>` subheadings), `.chapter-subtitle`, `.chapter-byline`, `<ruby>漢字<rt>かんじ</rt></ruby>`, typographic voices (`epigraph`, `quote`, `verse`, `dialogue`, right-aligned `signature`), scene-break spacing (`gapBefore`), and bidirectional popup footnotes (`a[epub:type="noteref"][role="doc-noteref"]` paired 1-to-1 with `aside[epub:type="footnote"][role="doc-footnote"]` and `role="doc-backlink"`).
- Orphan `continueFromPrevPage` paragraphs, tables, or footnotes that cannot merge into a preceding block are never silently dropped: they are preserved as standalone elements with an explicit `STITCH_ORPHAN_*` warning. Footnotes without a matching in-text `noteref` fail immediately with `FOOTNOTE_UNREFERENCED` rather than fabricating a chapter-top anchor.

### Canonical PDF frontmatter order

Parsed directly by [scripts/skill-rules.ts](../scripts/skill-rules.ts):

| Order | Role | Path | Spine position | TOC inclusion |
| --- | --- | --- | --- | --- |
| `1` | `cover` | `EPUB/cover.xhtml` | `first` | `optional` |
| `2` | `titlepage` | `EPUB/titlepage.xhtml` | `after-cover` | `optional` |
| `3` | `colophon` | `EPUB/colophon.xhtml` | `after-titlepage` | `forbidden` |
| `4` | `toc` | `EPUB/toc.xhtml` | `after-colophon` | `landmarks-only` |

- **① Cover (`EPUB/cover.xhtml`)**: book title, author and original cover artwork (`epub:type="cover"`, `properties="cover-image"` on the manifest asset).
- **② Titlepage (`EPUB/titlepage.xhtml`)**: book title, subtitle, author/translator credits and publisher (`epub:type="titlepage"`).
- **③ Colophon (`EPUB/colophon.xhtml`)**: copyright notice, publishing record, edition/impression and ISBN (`epub:type="colophon"`). **Never place the colophon at the end of the book, and never include `colophon.xhtml` in `EPUB/toc.xhtml`, `EPUB/nav.xhtml` (`epub:type="toc"`) or any NCX navigation map.**
- **④ Table of contents (`EPUB/toc.xhtml`)**: single-column hierarchical links to parts, chapters and sections (`epub:type="toc"`, `role="doc-toc"`), immediately preceding bodymatter.

## Chapter ToC, formulas, complex tables and deterministic image restoration

- **Chapter ToC and landmarks**: generate complete hierarchical navigation in both `EPUB/nav.xhtml` (`toc`, `landmarks`, and `page-list` linked to per-page `doc-pagebreak` anchors) and `EPUB/toc.xhtml` with monotonic spine order and zero broken fragments.
- **Formulas (`math-inline` and `math-block`)**: reconstruct inline and display equations as native EPUB 3.3 **MathML** (`<math xmlns="http://www.w3.org/1998/Math/MathML" alttext="...">`), setting `properties="mathml"` on every containing XHTML item in `package.opf`. Reject unsafe TeX macros (`\require`, `\href`, `\includegraphics`).
- **Complex tables (`table`)**: reconstruct semantic HTML tables inside `<div class="table-container" tabindex="0" role="region" aria-label="...">` with `<caption>`, `<thead>`, `<tbody>`, optional `<tfoot>`, explicit `<th scope="col|row|colgroup|rowgroup">`, `rowspan`, `colspan`, and alignment classes. Every table passes 2D grid occupancy validation (`PDF_TABLE_GRID_INVALID`).
- **Deterministic image restoration (`pdf enhance-image`)**: extract native raster streams or clean crops from high-DPI page renders. To stay consistent with the no-external-model policy, enhance blurry, noisy, or skewed figures strictly through deterministic non-generative image processing (`pdf enhance-image` powered by `sharp`), never external generative or AI redraw models:

```sh
node <skill-directory>/scripts/quillbind.ts pdf enhance-image /tmp/work/raw-fig-01.png --output /tmp/work/restored-fig-01.png --deskew -1.2 --denoise --sharpen --normalize --upscale 2 --verify-against /tmp/work/raw-fig-01.png --reports /tmp/work/image-reports --json
```

`pdf enhance-image` computes coarse geometric/structural sanity metrics (`multiScaleSsim`, `edgeCorrelation`, `aspectRatioDelta`) and emits a side-by-side plus amplified difference-heatmap PNG (`comparisonImage`: `[Original | Restored | Diff Heatmap]`). Numeric scores guard only coarse geometry and global structure; the `verifier` must still inspect `comparisonImage` visually to confirm zero glyph or detail distortion before recording `provenance` (`sourceSha256`, `outputSha256`, `mode: "non-destructive-restoration"`, `generativeRedraw: false`).

### Image restoration policy

Parsed directly by [scripts/skill-rules.ts](../scripts/skill-rules.ts) and aligned with the canonical operation prefixes emitted by `pdf enhance-image` (`IMAGE_FIDELITY_VIOLATION`):

| Operation | Allowed | Fidelity rule |
| --- | --- | --- |
| `deskew` | `yes` | Correct scan rotation/tilt within bounded geometry without cropping away figure content. |
| `dewarp` | `yes` | Flatten page-curl or perspective distortion while preserving original linework and text glyphs. |
| `denoise` | `yes` | Suppress scanner speckle or JPEG mosquito/block artifacts without erasing fine strokes or halftones. |
| `deblur` | `yes` | Apply restrained unsharp masking/deconvolution without haloing or inventing strokes. |
| `super-resolution` | `yes` | Upscale low-DPI figures conservatively (`lanczos3`) while preserving exact composition, aspect ratio and lettering. |
| `background-clean` | `yes` | Normalize uneven paper tint or bleed-through without clipping highlights or greyscale tonal ramps. |
| `generative-redraw` | `no` | Never redraw, restyle or replace original illustrations, diagrams or photographs (`generativeRedraw: false`). |
| `content-alteration` | `no` | Never add, remove, rearrange or inpaint semantic objects, labels or watermarks. |
| `style-transfer` | `no` | Never alter artistic medium, color palette intent or typographic character. |
| `text-hallucination` | `no` | Never fabricate or rewrite illegible in-image characters; keep faithful pixels or transcribe in caption/body notes. |

## Build and mandatory post-generation validation

Build the EPUB from the verified spec and verifier record (or pass a digital/hybrid PDF with `ocrTrust: "digital-native"` directly to `epub convert`):

```sh
node <skill-directory>/scripts/quillbind.ts doctor --json
node <skill-directory>/scripts/quillbind.ts pdf build-epub /tmp/work/spec.merged.json --verification /tmp/work/verification.json --render-manifest /tmp/work/pages-view/render-manifest.json --output /tmp/work/staged.epub --json
# Digital/native-text PDF direct shortcut (also accepts --spec and --verification):
node <skill-directory>/scripts/quillbind.ts epub convert /absolute/books/digital.pdf --output /tmp/work/staged.epub --json
```

**Never hand off a generated EPUB immediately after packaging.** Complete metadata supplementation and run the full post-generation standard verification gates (ideally delegated to a read-only `verifier` subagent per [parallel workflow](parallel-workflow.md)):

1. **Supplement bibliography and controlled tags** when requested or incomplete via [bibliography](bibliography.md) (`metadata catalog`, `metadata edition` or [BookWalker](bookwalker.md)) and reviewed `metadata bibliography-clean` / `metadata tags-apply` ([tags](tags.md)).
2. **Verify structure and frontmatter contract**: run `inspect <staged.epub> --json` and confirm spine order `EPUB/cover.xhtml` → `EPUB/titlepage.xhtml` → `EPUB/colophon.xhtml` → `EPUB/toc.xhtml` → chapters, `colophon.xhtml` absent from all TOC lists, `mathml` manifest properties present on formula chapters, and 0 missing assets.
3. **Run EPUB 3.3 conformance**: run `validate <staged.epub> --json` and require internal checks plus actual **EPUBCheck** to pass with **0 errors and 0 warnings**.
4. **Audit reading structure and footnotes**: run `epub audit <staged.epub> --json` and `epub check-notes <staged.epub> --json` to confirm popup `noteref` / `footnote` round-trip integrity.
5. **Run browser QA**: run `qa <staged.epub> --json` when the host environment permits Chromium (`ENVIRONMENT_ERROR` on restricted sandboxes must be reported explicitly per [environment](environment.md)).
6. **Verify Calibre sidecar safety and hash chain**: run `scripts/delivery-audit.ts audit` against the pre-run `snapshot` ([quality](quality.md)) supplying on-disk `pdfImportReport`, `verificationReport`, and `enhanceReports` paths before delivering the final `.epub`.

## Scanned PDF OCR layer and bookmark repair

When the user wants a searchable scanned PDF (rather than or in addition to EPUB 3.3), write the independently verified proofread text back into the PDF using a **PDF incremental update**:

```sh
node <skill-directory>/scripts/quillbind.ts pdf repair-ocr /absolute/books/scanned.pdf --spec /tmp/work/spec.merged.json --verification /tmp/work/verification.json --render-manifest /tmp/work/pages-view/render-manifest.json --output /tmp/work/repaired.pdf --backup /tmp/work/scanned.backup.pdf --reports /tmp/work/repair-reports --json
```

Guarantees and explicit limits of `pdf repair-ocr`:

- **Proofread `blocks` are the sole text authority**: text written into the invisible (`3 Tr`) layer comes strictly from verified `blocks` and `footnotes`, never from stale hidden OCR streams or `rawOcrDraft`.
- **Deterministic line geometry with explicit block-level fallback**: each page maps proofread lines sequentially onto `geometry` boxes (priority: 1. existing OCR layer boxes, 2. `pdftotext -bbox-layout`, 3. `sharp` horizontal-projection line cuts on the rendered page PNG). When transcribed line counts do not match detected geometry boxes (or no line boxes exist), the writer falls back explicitly to block-level bounding boxes and records `mode: "block-fallback"` in `pdf-repair.json` (`pageAlignments[]`) rather than silently fabricating uniform line coordinates.
- **Embedded GlyphLess TrueType font and `Tz` horizontal fit**: embeds a minimal valid 1-glyph TrueType font (`/FontFile2`) with an explicit `/CIDToGIDMap` and `/ToUnicode` CMap, scaling each line horizontally via `Tz` to fit its target box within page bounds without right-edge clipping.
- **PDF incremental update**: preserves the original PDF byte prefix untouched (leaving all original image XObject streams, untouched objects, generation numbers, and `/ID[0]` intact) and appends updated page dictionaries (with `/ReaddleObject` and stale `3 Tr` OCR streams stripped), new invisible text streams, optional `/Outlines` bookmarks, and an incremental cross-reference section matching the source format (classic `xref` table or PDF 1.5+ `/XRef` stream).
- **Mandatory post-write readback gate**: verifies original byte-prefix preservation, bit-identical image XObject SHA-256 digests (`PDF_IMAGE_STREAM_MUTATED`), and normalized text readback via `pdftotext` (or internal parser fallback when Poppler is unavailable) against the verified spec; any text drift fails immediately with `PDF_OCR_LAYER_STALE`. Supply `pdfRepairReport` (`pdf-repair.json`) and `verificationReport` to `scripts/delivery-audit.ts audit`.
