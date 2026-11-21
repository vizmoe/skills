# Format and Chinese conversion

## PDF to reflowable horizontal EPUB 3.3

For digital, scanned or hybrid `.pdf` sources — including visual tiling, per-page Markdown sharding, independent `verifier` sign-off (`quillbind-pdf-verification`), canonical `cover -> titlepage -> colophon -> toc` frontmatter ordering (excluding `colophon` from TOC), native MathML formulas, validated `rowspan`/`colspan` tables, deterministic non-destructive image restoration (`pdf enhance-image`), and parallel `coordinator` / `worker` / `verifier` execution — follow [PDF conversion](pdf.md) and [parallel subagent workflow](parallel-workflow.md).

Digital or hybrid PDFs whose pages all have `ocrTrust: "digital-native"` can run through `epub convert` directly (while pages with `ocrTrust: "unverified-embedded"` or `"none"` require `--spec` and an independent `--verification` file and fail with `PDF_OCR_VERIFICATION_REQUIRED` without them):

```sh
node <skill-directory>/scripts/quillbind.ts epub convert <source.pdf> [--spec <spec.json>] [--verification <verification.json>] --output <new.epub> --json
```

## MOBI and AZW3 to EPUB

Convert an existing `.mobi` or `.azw3` file to EPUB 3.3 through the skill helper:

```sh
node <skill-directory>/scripts/quillbind.ts epub convert <source.mobi|source.azw3> --output <new.epub> --json
```

The converter unpacks unencrypted PalmDB `BOOKMOBI` containers natively — MOBI 6, KF8 (`.azw3`), and combo MOBI+KF8 files using uncompressed, PalmDOC LZ77 or Huff/CDIC records — and reconstructs EPUB 3.3 chapters, stylesheets, images, cover metadata, navigation and internal links (`filepos` and `kindle:pos:fid`). For an anthology that also needs volume splitting, either convert it to EPUB first or pass the `.mobi`/`.azw3` directly to [local splitting](local-splitting.md).

DRM-protected or encrypted Kindle files fail with `MOBI_ENCRYPTED`; never strip DRM. Output paths must be new `.epub` files, and the original `.mobi` or `.azw3` remains untouched. Without `--to`, the command validates the converted EPUB through internal EPUB 3.3 checks, actual EPUBCheck (`epubcheck.json`), sampled Chromium reading checks (`reading/`) and repeated-unpack byte equality, writing `<output>.reports/import.json` with `publicationReady: false` and `releaseGates: not-run`. Adding `--to <target>` runs the Chinese conversion and full publication release gates below.

## Chinese script and regional vocabulary

Use `build <book-directory> --to simplified|traditional|china|taiwan|hongkong --json` for Markdown. Optional `conversion.target` in `book.yaml` persists the choice; `--to` wins. `preview` accepts the same options for a single-render author candidate. Existing EPUB 3, MOBI or AZW3 files use `epub convert <source.epub|source.mobi|source.azw3> --to <target> --output <new.epub> --json`. Run through the skill helper; check `doctor` before release work. EPUB 2 needs a publication repair upgrade first.

Follow the requested script and regional vocabulary; a repair request alone does not authorize text conversion. The first conversion needs `--online` to fetch responses from [繁化姬](https://zhconvert.org/). 本程式使用了繁化姬的 API 服務；繁化姬商用必須付費。This sends eligible text and display metadata over HTTPS. Set `ZHCONVERT_API_KEY` in the environment only if required; keep credentials out of book files and reports.

Later runs are offline by default. Book locks live at `metadata/conversion.<target>.lock.json`; existing EPUB locks at `<source.epub>.<target>.conversion.lock.json`. Preserve the lock with the sources: it contains converted text, dictionary revision and input/output hashes. Missing or stale locks fail with an instruction to refresh explicitly using `--online`. A failed refresh preserves the saved lock. Fixed source, lock and toolchain support byte equality across runs; refreshing a changed dictionary can change text.

The primary language must be `zh` or `zh-*`. Conversion updates text, navigation, display metadata and Chinese language tags. Identifiers, dates, links, structure, images, fonts, styles, code, MathML, SVG, `translate="no"` and explicitly non-Chinese text are preserved. Artwork text stays in its original script. Existing EPUB output requires a new path.

Read [quality.md](quality.md) before handoff. Release checks remain mandatory. Report the target, dictionary revision, lock source and current operation outcome from `conversion.json` and its summary; preview returns its conversion evidence directly in CLI JSON.
