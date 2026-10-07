# Architecture and public API

The ESM pnpm workspace contains `@quillbind/core` and `@quillbind/cli`. Core TypeScript owns the publication model, serialization, OCF packing and validation. Markdown parser nodes are private to `markdown.ts`; public `Publication`, `Document`, `Block`, `Inline`, resources, navigation, metadata and diagnostic types live in `model.ts`. Block and inline nodes are discriminated unions: images require a target and alternative text, headings require identity and level, and math nodes contain a complete `MathExpression` with TeX, MathML and display mode. Publication resources are a flat inventory; there is no unused resource-edge graph.

| Module                                                                 | Responsibility                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `config.ts`, `metadata.ts`                                             | Strict configuration, controlled subjects, persisted identity and provenance                     |
| `markdown.ts`, `preflight.ts`                                          | Chapter conversion and book-level authoring checks                                               |
| `publication.ts`                                                       | Assemble prepared documents, metadata and deduplicated resources                                 |
| `math.ts`, `highlight.ts`                                              | Isolated TeX conversion and source-preserving Shiki tokens                                       |
| `render.ts`, `render-chapters.ts`, `render-package.ts`, `xhtml.ts`     | XHTML chapters, frontmatter, OPF and navigation                                                  |
| `zip.ts`, `epub.ts`, `xml.ts`, `css.ts`                                | OCF inspection, package structure, XML parsing and CSS rules                                     |
| `validate.ts`, `compatibility.ts`                                      | Internal conformance, EPUBCheck and platform diagnostics                                         |
| `qa.ts`, `qa-environment.ts`, `ace.ts`                                 | Browser lifecycle, local EPUB server and Ace execution                                           |
| `qa-page.ts`, `qa-links.ts`, `qa-pagination.ts`, `qa-ready.ts`         | Reader matrix, link/note round trips, pagination and layout stability                            |
| `qa-plan.ts`                                                           | Shared browser-cost projection, deterministic coverage assignments and screenshot policy         |
| `repair.ts`, `repair-plan.ts`, `repair-images.ts`, `repair-content.ts` | Structural repair/release, input-bound plans, image alignment and protected-content fingerprints |
| `pipeline.ts`, `preview.ts`                                            | Mandatory release gates, byte equality and isolated author preview                               |
| `inspection.ts`                                                        | Read-only navigation, bibliography, reading order and resource references                        |
| `init.ts`, `source-files.ts`                                           | Staged source preparation and shared referenced-image discovery                                  |
| `reporting.ts`                                                         | Current-run release summaries, unexecuted checks and delivery evidence                           |

The exported `formats` value declares `markdown-book`, `novel-url` and `epub` maintenance input, and `epub` output. The CLI reports that static contract. `novel.ts` stages URL imports as ordinary Markdown books, then invokes `buildBook` for each requested output. `novel-http.ts` owns bounded HTTPS requests and public-address pinning; the three source modules return a shared `NovelCatalog` and chapter pages. `novel-html.ts` imports source text and images without executing website code. Source metadata and response/image hashes remain in local provenance reports. See [novel sources](novel-sources.md) for the supported site contracts. EPUB maintenance performs audit/repair/conversion without manufacturing a Markdown domain model. Internal rendering returns candidate entries in memory. `previewBook` renders once to `dist/preview/candidate.epub`, returns explicit non-release status, and writes no release reports. `buildBook`, `repairEpub` and `convertEpub` write release artifacts after all gates pass.

`zhconvert.ts` owns the fixed HTTPS API, bounded requests, deduplication and restorable response snapshots. `chinese-conversion.ts` changes only selected XML text and language/display attributes in rendered EPUB entries, shared by optional build conversion and `convert-epub.ts`. The independent rebuild repeats rendering and conversion against the frozen response snapshot. It fails on new source text and never fetches again during the byte comparison. `conversion-lock.ts` binds persistent text responses to an input publication hash, target and recipe; default replay works offline across runs. Reports identify the dictionary revision and lock source. See [Chinese conversion](chinese-conversion.md).

The build uses the metadata lock produced by resolution and passes preflight documents into `publicationFromBook`, avoiding another lock read and chapter parse. Preflight compiles formulas, so conversion errors belong to the preflight gate. One lazy MathJax input/document and expression cache serve each import; equation tags and dynamic command tables reset between expressions. Rendering consumes stored MathML and does not mutate the publication. Shiki's existing singleton shorthand continues to reuse its highlighter. Reproducibility still reopens the book and reconstructs the entire publication with a fresh math compiler and cache.

`epub.ts` owns `EpubInspection` and `inspectBytes`. One inspection is shared by conformance, browser QA, both platform lints and the release manifest. Audit shares its inspection with validation and repair planning. `validateOcf` checks the unpacked entry evidence, including when validation receives a permissive inspection; reuse cannot omit strict OCF checks. Inspection reuse is local to an operation, with no global cache keyed by mutable byte arrays. Repair obtains its own mutable XML documents, preserving the original bytes and metadata under the existing content-integrity checks.

```ts
import {
  openBook,
  resolveMetadata,
  preflightBook,
  buildBook,
  validateEpub,
  runQa,
  inspectEpub,
  auditEpub,
  createRepairPlan,
  repairEpub,
} from "@quillbind/core";

const controller = new AbortController();
const book = await openBook("./book");
const metadata = await resolveMetadata(book);
if (metadata.status === "pass") {
  const result = await buildBook(book, { signal: controller.signal });
}
```

Long-running build, resolution, validation, repair and QA methods accept `AbortSignal`. The metadata fetcher is injectable for recorded-response tests; injected test responses do not perform CI network requests. Results are JSON serializable. Exceptions carry stable `code`, `message` and optional structured `details`; diagnostics carry severity, source and rule evidence. Publication resources contain byte arrays; file inspection returns hashes and sizes instead of serializing ZIP maps.

Rendering follows the [EPUB 3.3 package, navigation and OCF rules](https://www.w3.org/TR/epub-33/): package `version="3.0"`, manifest/spine references, one TOC, landmarks, and `page-list` only from explicit source page markers. Each Markdown chapter becomes one XHTML spine document. Math uses [MathML 3](https://www.w3.org/TR/MathML3/) through MathJax's direct Node API; conversion errors block build. Shiki token spans retain exact code text and use controlled classes without injected color styles.

Every new book includes a clickable `contents.xhtml` before the chapters in the spine. The navigation document links to it as a top-level TOC leaf, after the cover when configured and alongside chapter groups, and its `toc` landmark targets the same page. Both documents render the same chapter tree and optional cover link; the reading page omits its own self-link and the machine navigation landmarks. A dedicated frontmatter stylesheet centers the contents heading and hides list markers at every depth while retaining nested indentation and semantic lists. It is loaded only by generated frontmatter and navigation documents; chapter typography is unchanged. The page title, heading and navigation label use `Contents` for English and other non-Chinese languages, `目录` for Simplified Chinese, and `目錄` for Traditional Chinese. `Intl.Locale` resolves the book language: an explicit `Hans`/`Hant` script wins over the region; otherwise `zh-TW`, `zh-HK` and `zh-MO` resolve to Traditional Chinese, while bare `zh` defaults to Simplified Chinese. These are Quillbind localization defaults under the pinned Node/ICU runtime. The `bodymatter` landmark still targets the first chapter, and the generated pages inherit its direction and writing mode.

Configured cover artwork is both an OPF `cover-image` resource and the image in `cover.xhtml`, the first spine document before `contents.xhtml` and the chapters. The cover has no extra visible book title; the resolved book title and ordered author names generate its alternative text as `Title — Author 1, Author 2`, and the document title retains the book title. Its image stays proportional, horizontally centered and within the viewport, with no specified page background. A first-level `Cover` or Chinese `封面` link appears in the TOC and reading-page contents, and a `cover` landmark targets the same page. This follows the Apple Books preference for this project. [KDP's different cover submission guidance](https://kdp.amazon.com/en_US/help/topic/G6GTK3T3NUHKLEFX) is excluded from platform lint by project policy; it does not remove the page or create a second artifact. Existing EPUB repair preserves source cover pages. [Apple's navigation examples](https://help.apple.com/itc/booksassetguide/en.lproj/itc0f175a5b9.html) and [Kindle's navigation guidance](https://kdp.amazon.com/en_US/help/topic/GY3AD8C6C6GAG42N) were checked on 2026-09-06.

The ZIP writer uses deflate level 9 with fixed timestamps and ordering. It stores `mimetype` and entries whose compressed bytes would not be smaller. A separate reader verifies local headers, central directory, data descriptors, CRCs, declared lengths, entry ranges and names without source-size quotas. The pinned Node/zlib runtime and independent byte-equality gate establish compression reproducibility. `compression.json` records the policy, runtime and method counts. Existing ZIP input supports both methods. PNG resources use verified lossless IDAT recompression under the pinned Node/zlib runtime, described in [image processing](images.md). The exact dependency versions and integrity values are in `pnpm-lock.yaml` and `standards/dependencies.lock.json`.

Supporting modules have narrow responsibilities: `files.ts` protects source/output paths and atomic writes; `paths.ts` validates archive references; `process.ts` owns child-process cleanup; `json.ts`, `hash.ts`, `xml.ts`, `runtime.ts` and `standards.ts` handle their named contracts. CLI package subpaths expose only `json` and `errors`; the former generic `io` export is removed.
