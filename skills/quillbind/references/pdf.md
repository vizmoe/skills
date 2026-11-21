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
