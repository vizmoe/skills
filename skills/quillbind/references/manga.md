# Manga scans to CBZ

Use this workflow for caller-supplied manga scans. A native EPUB stays EPUB and uses [BookWalker EPUB enrichment](bookwalker.md#supplement-an-existing-epub); do not extract or flatten its pages into this workflow.

For an existing CBZ's labels or bibliography, use [embedded metadata maintenance](embedded-metadata.md#cbz-edit-comicinfo-without-processing-pages). Edit root `ComicInfo.xml` on a staged copy while preserving existing page bytes and order. Packaging below generates new ComicInfo from its source lock and does not import the library's controlled tags; completing a library tag task requires the separate field mapping and readback workflow.

## Prepare one volume

Confirm the work, edition and volume, then obtain a manga source lock through the [BookWalker workflow](bookwalker.md). Chinese metadata comes from Taiwan; Japanese metadata and the original date come from Japan. The date policy is Japanese print publication first, Japanese electronic release only if print is absent.

Provide one scan directory or ZIP/CBZ containing JPEG, PNG or static WebP/TIFF/GIF images. Nested image directories are supported. RAR/CBR/7z, PDF, SVG, existing JXL pages, animation and multi-page images are not accepted by this importer; prepare supported, explicitly ordered page files without changing the originals. Unknown payloads cause an error. Existing `ComicInfo.xml`, `quillbind.json` and macOS sidecars remain in the source and are listed as omitted in the new archive's provenance.

Review numeric filename order across the entire relative path; `2.png` precedes `10.png`. Filenames cannot establish volume or cover identity. Keep separate volumes separate. For a custom order, supply a JSON array containing every image's relative path exactly once, for example `["cover.jpg", "pages/001.png"]`. Set reading direction only when established from the source; it is otherwise left unspecified. No page is guessed to be a cover, and spreads are not split or resized.

## Package and verify

Install libjxl's `cjxl` and `djxl` on the runtime host. `QUILLBIND_CJXL` and `QUILLBIND_DJXL` can select their executable paths. Missing or unsupported tools block packaging; no lossy fallback is used.

```sh
node <skill-directory>/scripts/quillbind.mjs manga package scans/ --bookwalker manga.lock.json --output volume-01.cbz --reading-direction rtl --json
# Add --page-order order.json when filename order is insufficient.
```

The destination and its `<output>.reports` directory must be new and outside the source directory; choose a new output path when retaining a previous failed run's reports. The operation does not fetch images or change originals. Every new page is encoded using `cjxl -d 0`; JPEG reconstruction must match the original bytes exactly. Other images must decode to the same samples, dimensions and bit depth, with retained ICC, EXIF, XMP and orientation when present. Static WebP/TIFF/GIF use a separately verified lossless PNG intermediate. PNG container details and ancillary fields outside those checks are not promised to be reproduced; the original files remain the preservation copy. Unsupported samples or a failed comparison block output.

The CBZ contains numbered `.jxl` pages, `ComicInfo.xml` and `quillbind.json` provenance. JPEG XL pages are stored without redundant ZIP compression. Packaging verifies the archive round trip, repeated archive bytes and unchanged sources. An exclusive `<output>.manga.lock` protects concurrent writers, and failed candidates are removed. Inspect the owner before removing a stale lock.

The importer bounds input to 10,000 entries, 100 MiB per file, 1 GiB aggregate bytes and 100 million pixels per page. These are archive/decoder safety limits, separate from EPUB's image policy. A limit failure requires splitting the input into appropriate volumes or reviewing the implementation; never silently omit pages.

## ComicInfo and handoff

ComicInfo uses the stable [2.0 schema](https://anansi-project.github.io/docs/comicinfo/schemas/v2.0). Title, series, issue `Number`, summary, publisher, imprint and source URL come from the selected edition. `Year`, `Month` and `Day` always come from the Japanese original. Actual packaged images determine `PageCount` and zero-based page indices; store page totals and series counts are not copied. `LanguageISO` contains the base ISO language; the full Chinese script tag stays in provenance.

Declared authors, original authors and adaptation writers map to `Writer`; explicit manga artists map to `Penciller`. All original roles remain in `Notes` and provenance, including illustrators and translators. Version 2.0 has no `Translator` field, so do not invent one or mislabel translators as writers. Unknown issue totals, series-year `Volume`, genre, ratings, cover roles and reading direction are omitted. Explicit right-to-left reading uses `Manga=YesAndRightToLeft`; otherwise it uses `Yes`.

Use the artifact SHA-256 and `<output>.reports/report.json` for handoff; `provenance.json` records page hashes, codec versions, compression settings and source-lock evidence. A successful CBZ is an image archive, not an EPUB publication, accessibility certification or Apple Books/Kindle compatibility result. **The reader must support JPEG XL inside CBZ.** Native reader testing is reported as not run. Existing EPUB release gates are unchanged.
