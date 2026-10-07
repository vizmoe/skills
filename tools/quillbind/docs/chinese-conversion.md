# Chinese script conversion

Quillbind uses the [繁化姬 zhconvert API](https://zhconvert.org/) for optional Chinese script conversion. 本程式使用了繁化姬的 API 服務；繁化姬商用必須付費。The service attribution and commercial-use notice also appear in CLI help and conversion reports, as required by the [API introduction](https://docs.zhconvert.org/api/). API documentation checked on 2026-09-11.

```sh
# Convert while building a Markdown book; source chapters and book.yaml stay intact.
pnpm quillbind build ./my-book --to traditional --online --json

# Convert an existing EPUB 3 into a new release.
pnpm quillbind epub convert ./original.epub --to simplified --output ./simplified.epub --online --json
```

`build --to` overrides the optional persistent setting in `book.yaml`:

```yaml
conversion:
  target: traditional
```

Conversion is offline by default. On the first conversion, pass `--online` to send eligible text and display metadata to `https://api.zhconvert.org` over HTTPS and save a response lock. Subsequent runs reuse that lock; `--online` explicitly refreshes it. Metadata discovery remains the separate `metadata resolve --online` command. Images, fonts, CSS and source files are not uploaded. If the service requires an API key, set `ZHCONVERT_API_KEY` in the environment; it is excluded from reports and configuration. CI rejects live API requests and uses injected recorded responses for tests.

| Target        | API converter | Output language |
| ------------- | ------------- | --------------- |
| `simplified`  | `Simplified`  | `zh-Hans`       |
| `traditional` | `Traditional` | `zh-Hant`       |
| `china`       | `China`       | `zh-Hans-CN`    |
| `taiwan`      | `Taiwan`      | `zh-Hant-TW`    |
| `hongkong`    | `Hongkong`    | `zh-Hant-HK`    |

The first two targets convert script. The other three also apply the corresponding converter's regional vocabulary. Additional optional replacement modules and text cleanup are disabled. These are the supported subset of the service's [conversion modes](https://docs.zhconvert.org/api/convert/); Quillbind does not expose pinyin or other non-book modes.

The book's primary language must be `zh` or a `zh-*` tag. Conversion covers XHTML text, navigation and NCX labels, `alt`, `title`, `aria-label`, `aria-description`, and XHTML author/description metadata. OPF title, author, contributor, description, subject, publisher, rights, coverage, file-as and alternate-script text are converted; Chinese language tags are updated. UUIDs, ISBNs, dates, custom metadata, paths, anchors, URLs, markup, spine order, images, fonts and styles retain their values. Text explicitly marked with a non-Chinese language or `translate="no"`, code/pre/kbd/samp, MathML and SVG are preserved. Text embedded in artwork is not converted. Text slots preserve markup boundaries; a phrase split across inline elements or a long-text chunk can lose some linguistic context.

Existing input must be a reflowable EPUB 3. Use the documented `epub repair` workflow to upgrade an EPUB 2 source first. Encrypted, scripted, fixed-layout, multiple-rendition and digitally signed books are rejected. Conversion changes readable content intentionally and is a separate operation from repair's text-preservation contract.

The client reads [`/service-info`](https://docs.zhconvert.org/api/service-info/) to check converter availability, key requirements and `maxPostBodyBytes`. It deduplicates equal text and sends sequential framed batches capped at the smaller of the service limit and 64 KiB of encoded POST data. Long text splits on Unicode code points, preferring sentence and paragraph boundaries. This is a request limit, not a book-size quota. Changed framing, malformed results, a dictionary revision change during a run or an unsuccessful API response stop the operation. Requests time out after 30 seconds, accept cancellation, and retry HTTP 429/502/503/504 up to twice with bounded `Retry-After` waits. Redirects are rejected and responses are bounded to 1 MiB.

## Persistent responses and previews

Markdown books save one target-specific lock at `metadata/conversion.<target>.lock.json`. Existing EPUBs save `<source.epub>.<target>.conversion.lock.json` beside the original. Keep these files with the source and metadata locks. Each conversion lock binds the exact input publication SHA-256, target, recipe version and dictionary revision to text-response hashes and converted text. It contains book text, but no API key. Source, metadata, assets or rendering-toolchain changes can invalidate the input hash; refresh explicitly after such a change.

Missing, stale, malformed or mismatched locks fail before any network request. An unsuccessful refresh preserves the previous lock. A successful conversion saves the dependency even if a later release gate fails. Offline replay performs no service discovery and rejects any text absent from the saved snapshot. The recipe version must change when conversion parameters or text-slot selection change.

`preview DIRECTORY --to TARGET [--online]` uses the same lock and renders once to `dist/preview/candidate.epub`. It records `publicationReady: false` and runs no release gates. It preserves existing release artifacts and reports.

Every converted release passes the same EPUBCheck, Ace, browser QA and platform checks as other releases. Its independent rebuild replays frozen responses and compares complete bytes. Saved locks make these responses stable across separate offline runs under the same toolchain; explicitly refreshing against a changed remote dictionary can change the result.

For builds, results remain in `dist/book.epub` and `dist/reports/`. Existing EPUB conversion requires a new output path and writes reports beside it in `<output>.reports/`; failed candidates are removed. `conversion.json` records the target, dictionary revision, request count, snapshot hash, lock path, input hash, response source and changed-resource hashes without recording the submitted text or API key. `build.json` and `summary.json` identify the run and every completed or unexecuted release check. The original EPUB is never overwritten.

Core callers can pass `conversion: { target: "traditional" }` to `buildBook` or call `convertEpub(file, { target: "simplified", output, signal, online: true })`. `ConversionOptions.fetcher` provides recorded responses for offline tests; production endpoints are fixed.
