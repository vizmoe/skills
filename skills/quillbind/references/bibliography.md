# Bibliography for existing ebook files

Use this workflow to supplement or correct existing books, then apply the selected fields through [embedded metadata maintenance](embedded-metadata.md). The output is metadata inside the ebook file. Calibre's database, sidecar OPF and cover file are outside the write scope; the library supplies only the [controlled tag vocabulary](tags.md).

## Choose sources by book type

- **Confirmed prose light novels and manga:** use the [BookWalker workflow](bookwalker.md) with the correct work type; an adaptation and its prose original are separate records. For Chinese metadata select the corresponding Taiwan volume, or apply [no Taiwan volume](#no-taiwan-volume) when none matches; use the Japanese original's date, with the existing print-date-first, electronic-date-fallback rule. Use the chosen source field directly; publisher cross-verification is not required. Preserve its available precision rather than shortening a complete date or inventing a missing day.
- **Other books, including ordinary fiction, nonfiction and art books:** follow the three-tier ordinary-book source hierarchy below across Chinese (`zh-Hans` / `zh-Hant`), Japanese (`ja`) and English (`en`) editions without requiring a BookWalker record, Japanese counterpart or the light-novel/manga date policy. Use the selected edition's publication date from the available source; repeated cross-verification is not required.
- **Self-made and non-retail editions** (录入本, personal compilations, doujin or self-published books, scan-derived EPUBs): use the route for the work's type above, after identifying the work as in [self-made and non-retail editions](#self-made-and-non-retail-editions).

| Tier | Source class | Runtime command | Allowed and excluded scope |
| --- | --- | --- | --- |
| Tier 1 | Official publisher or imprint edition page | `metadata edition` (`--online` or `--page saved.html`) | Primary authority for edition title, contributor roles, publisher/imprint, ISBN, date, series, synopsis and official `coverUrl`. |
| Tier 2 | Public institutional and industry bibliographic catalogs | `metadata catalog` (`openbd`, `ndl`, `cinii`, `loc`, `openlibrary`, optional `google-books`) or `metadata edition --page` on saved national library pages | Structured ISBN, MARC-880 vernacular CJK creators/publishers, publication date, series and JPRO/ONIX or Open Library synopses/covers when Tier 1 is offline, bot-gated or lacks structured fields. |
| Tier 3 | Verified edition-specific bibliography or bookstore product pages | `metadata edition` (`--online` or `--page saved.html`) plus the book's own title/copyright pages | Edition-specific pages (such as Douban Books `book.douban.com/subject/<id>/` for mainland Chinese editions, Books.com.tw / Eslite for Taiwan editions, or major JP/EN bookstore product pages) after cross-checking title, credited people, publisher and ISBN/volume. Never adopt community ratings/tags/reviews, raw search snippets, multi-edition wiki articles (Wikipedia, Baidu Baike, work-level Bangumi pages) or download sites. |

| Language / ISBN group | Catalog providers (`metadata catalog`) | Typical field coverage and Tier 1 / Tier 3 pairing |
| --- | --- | --- |
| Mainland Chinese (`zh-Hans`, `978-7`) | `loc` (SRU MODS 3.8 + MARC-880 vernacular CJK), `ndl`, `cinii`, `openlibrary`, optional `google-books` | Many mainland presses lack public product pages; pair `metadata catalog` bibliography with a verified edition page via `metadata edition` (such as the publisher page or Douban Books edition subject page `--page`) for Chinese synopsis, translator/series details or domestic presses absent from international catalogs. |
| Traditional Chinese (`zh-Hant`, `978-957` / `978-986` / `978-988`) | `loc` (vernacular `zh-Hant` MARC-880), `ndl`, `cinii`, `openlibrary`, optional `google-books` | Pair publisher/imprint pages (`metadata edition`) with `metadata catalog` and verified Taiwan/HK bookstore edition pages (such as Books.com.tw) when publisher sites omit synopses or ISBNs. |
| Japanese (`ja`, `978-4`) | `openbd` (JPRO/ONIX), `ndl` (NDL Search DC-NDL), `cinii`, `loc` | `openbd` supplies publisher ONIX synopses, contributor roles, imprints, print/eISBNs and official `coverUrl`; `ndl` and `cinii` cover backlist, academic and non-JPRO editions. |
| English (`en`, `978-0` / `978-1`) | `loc` (SRU MODS 3.8), `openlibrary`, optional `google-books` | Combine publisher edition pages (`metadata edition`) with `loc` authority bibliography and `openlibrary` / `google-books` synopses and covers. |

Check title, credited people and volume/edition sufficiently to avoid a wrong work or adaptation. One appropriate source can support a field; do not turn every lookup into a mandatory two-source investigation. You may combine a `metadata catalog` lock (for verified ISBN/date/publisher) with a `metadata edition` lock (for the matched edition's synopsis or full translator credits) on the same edition, recording each lock path and digest in the field plan. If evidence conflicts or is missing, preserve that field and finish other supported changes. The source rule for light novels does not classify every book from the same author or series as a light novel.

### Query public book catalogs

Query structured public catalogs by ISBN, title, author, publisher or language to produce an immutable, offline-replayable lock:

```json
{
  "isbn": "9784101010014",
  "title": "<expected title, optional when isbn is supplied>",
  "author": "<creator lead, optional>",
  "language": "ja",
  "matchEvidence": ["Record the verified title, creator and edition correspondence here."]
}
```

```sh
node <skill-directory>/scripts/quillbind.mjs metadata catalog query.json --output catalog.lock.json --online --json
node <skill-directory>/scripts/quillbind.mjs metadata catalog query.json --output catalog.lock.json --json
```

Omit `providers` to use automatic language/ISBN routing across `openbd`, `ndl`, `cinii`, `loc` and `openlibrary` (plus `google-books` when `GOOGLE_BOOKS_API_KEY` is set; any API key in request URLs is redacted before writing the lock), or pass an explicit `providers` subset. Each lock records per-provider HTTP status, SHA-256 response hashes, normalized `entries` (including MARC-880 vernacular CJK strings, split contributor roles, print vs electronic ISBNs and optional `coverUrl`), merged candidate fields and conflict diagnostics (`CATALOG_CONFLICT`, `CATALOG_MATCH`, `CATALOG_UNAVAILABLE`). Replay without `--online` verifies the saved lock offline.

### Extract an ordinary book's edition page

After locating the publisher, imprint or other selected edition page, extract its fields with the runtime instead of copying them by hand. Write a selection file naming the actual product URL, the expected ISBN when the file or a lead already supplies one, and your identity evidence:

```json
{
  "url": "https://publisher.example/books/<edition>",
  "isbn": "<expected ISBN, optional>",
  "matchEvidence": ["Record the verified title, people and edition correspondence here."]
}
```

```sh
node <skill-directory>/scripts/quillbind.mjs metadata edition selection.json --output edition.lock.json --online --json
node <skill-directory>/scripts/quillbind.mjs metadata edition selection.json --output edition.lock.json --page saved.html --json
node <skill-directory>/scripts/quillbind.mjs metadata edition selection.json --output edition.lock.json --json
```

`--online` fetches only that public HTTPS page; when it is refused or rendered by scripts, save the page yourself and pass it with `--page`. The last form replays an existing lock offline. Locks are immutable and record retrieval mode, hash, decoded charset, every field candidate with its source kind, the cleaned metadata and diagnostics.

The extractor reads structured data first (JSON-LD and microdata), then synopsis sections, labelled detail rows, citation/Dublin Core meta and Open Graph. It drops navigation, headers, footers, asides and recommendation, review and comment blocks. Cleaning splits credits into people and roles and removes nationality or era prefixes and placeholders. It strips storefront suffixes and marketing or format brackets from titles. ISBN checksums are validated and ISBN-10 is normalized to ISBN-13, with electronic numbers kept apart. Dates keep their stated precision. Synopses become plain text without reader-interface residue, and series positions become Arabic digits.

Treat the result as evidence for the field plan, not as a write. An `EDITION_MATCH` failure means the page lacks the expected ISBN; select the right edition page. `EDITION_ISBN_AMBIGUOUS` leaves the ISBN unset when the page lists several and none was expected. `EDITION_CONFLICT` and `EDITION_CLEANED` diagnostics show disagreements and removed text to review. A truncated meta description is never adopted as the synopsis. The page still has to be the matched edition under the rules above, and adopted values still follow the ISBN, description and file-write rules below.

### Search and cross-script discovery

Source sites index their own script and edition naming: `bookwalker.com.tw` uses Traditional Chinese (`zh-Hant`) and Taiwan edition titles, `bookwalker.jp` uses Japanese original titles and Japanese kanji/kana, and publisher sites use their edition's script and imprint title. Searching a source site directly with Simplified Chinese (`zh-Hans`), a mainland translated title or Chinese-script creator names can return zero results even when the volume exists.

Before using a source's in-site search, query a general search engine (for example `site:bookwalker.com.tw`, `site:bookwalker.jp`, or publisher, ISBN, title and creator queries) to locate candidate product URLs directly and to identify the work's Taiwan title (`zh-Hant`), Japanese original title and target-script creator names. When in-site search or series browsing on the target site is still needed, convert Simplified/Traditional characters and Chinese/Japanese kanji variants and search with that site's native script and edition title. Search snippets and third-party bibliography pages (such as Douban, Bangumi or Wikipedia) are discovery leads only: verify work identity, credited people, edition type and volume on the actual BookWalker or publisher product page (recording cross-script or translated-title correspondence in the match evidence), and adopt metadata only from the authoritative source.

## No Taiwan volume

When a Chinese light novel or manga has no matching BOOK☆WALKER Taiwan volume, for example a mainland Simplified-only edition, the matched BOOK☆WALKER Japan volume becomes the work source. Fetch it as a [Japanese-only lock](bookwalker.md#select-matching-editions). From it, adopt the date under the Japanese-original policy, the series position and a translated synopsis under the [description rule](#describe-the-work-not-the-file). Keep the book's own Chinese title, series name, contributors' Chinese names and language. Publisher, imprint and ISBN identify the Chinese edition, so fill them only from a verified Chinese-edition source — the book's copyright page, `metadata catalog` (`978-7` record), or the Chinese publisher / verified edition page via `metadata edition` — otherwise leave them as they are and report the gap. Apply these fields through direct OPF or ComicInfo maintenance; `epub enrich` would write the Japanese record's title and language.

## Self-made and non-retail editions

A file its retail publisher did not issue still describes a published work. Identify that work by title, credited people and volume, checked against the file's own title/copyright pages or text, instead of requiring an ISBN inside the file. An ISBN already in the file is a lead to verify like any other, not proof of the edition. Once the work is identified, fill every selected field — ISBN, publisher/imprint, date, series and description — from the work's type-specific source exactly as for a retail file, with the usual ISBN, edition and file-write checks. Record the edition class and the identification evidence in the run report; they never enter the book's metadata.

## Complete ISBNs where supported

General metadata supplementation includes ISBN completion without a separate ISBN request. Inspect the current identifiers, then actively look for missing ISBNs in the matched type-specific source above and the book's bibliography. Use title, credited people, edition and volume to find the correct record. One inaccessible page is not proof that no ISBN is available. A tags-only task or an explicit list of other fields does not expand to ISBN edits.

Retain existing ISBNs when supported; replace an evidenced wrong value only when a supported replacement is available. Validate ISBN syntax and checksum, normalize a valid ISBN-10 to ISBN-13 where appropriate, and distinguish format normalization from work/edition matching. A valid checksum alone does not establish a match. Do not borrow a number from an adaptation, another volume, a bundle or another work by the same author.

For Chinese light novels and manga, adopt the ISBN on the matched BOOK☆WALKER Taiwan page for that work type and volume; print/electronic or script differences alone do not disqualify it under this source policy. For other books, use the matched publisher/edition record or book bibliography. When the matched record lists both, write the print ISBN; use the electronic ISBN only when no print ISBN exists. Record which one was written and that the other exists; do not label a source ISBN as a proven eISBN. Existing-file maintenance requires no new-publication eISBN approval or mandatory second-source confirmation.

Failed lookup, conflicting candidates or uncertain edition evidence must not clear an existing value. Retain it and report the concern if no supported replacement is available. Leave a previously absent ISBN empty only when no reliable candidate is found after the relevant lookup, or the format cannot represent it; record the attempted sources and reason while completing other supported fields. Never invent an ISBN, overwrite unrelated identifiers or change the primary UUID/`unique-identifier` to fill one.

EPUB supports an additional ISBN `dc:identifier` independently of its primary identity; use the [ISBN identifier form](embedded-metadata.md#isbn-identifiers). ComicInfo 2.0 has no ISBN field: skip ISBN for that format without treating it as unresolved work. Do not invent an element or store the ISBN in `Notes`/`Summary`. Follow the [embedded format rules](embedded-metadata.md) for a different existing, validated profile.

## Build a small field plan

Identify each target by file path and SHA-256. Read its current package metadata and relevant book content, then record old/new values only for the fields being maintained:

| Field | Adoption rule |
| --- | --- |
| Title and contributors | Use the matched edition's title and credited names/roles. When light-novel naming is selected, apply [whole-series naming](naming.md) while preserving the volume title's original text. Keep author, translator and illustrator distinct; do not guess an original name from a translation. |
| Description | The work's synopsis under [describe the work, not the file](#describe-the-work-not-the-file). |
| Language/script | Follow the actual text; preserve `zh-Hans` / `zh-Hant` where applicable. Do not convert the book's text as a metadata edit. |
| Tags | Use exact labels from the current library vocabulary, supported by the work's content and the type-appropriate source. |
| Publisher, series and position | Adopt actual edition information. Follow [story series normalization](series.md) for narrative membership, quantity-marketing cleanup, subseries and verified order; shared authors, publisher collections and nonfiction volume counts do not establish Series. |
| Date | Use the type-specific source policy above, retain known precision and leave unavailable components unset. Record the source field; no repeated cross-check is required. |
| ISBN | Actively fill from matched evidence during general supplementation; preserve supported values and report unresolved cases under the ISBN policy above. |

A metadata supplementation task does not by itself select covers, ratings, reading state or body text for replacement. A request for complete library-rule cleanup includes the [score cleanup workflow](embedded-metadata.md#remove-score-metadata-completely); tags-only and explicitly restricted tasks retain their field boundaries. Never import retailer/reviewer scores when supplementing bibliography. When a field is selected, correct an evidenced wrong value as well as filling a blank; keep ambiguous values for review. Do not fabricate missing bibliography from a filename or a plausible title.

## Describe the work, not the file

`dc:description` and ComicInfo `Summary` hold only the work's synopsis: the matched source's description for that volume, or a factual summary of the inspected text. Keep plain text and meaningful paragraph breaks, and keep credited names in contributor fields. A collection-wide description is not a single volume's synopsis. Provenance, edition comparisons, source notes and reasons a field stayed empty belong in the run report; when correcting a description that mixes these into the synopsis, keep the synopsis and report what was removed. With no supported synopsis, preserve the current value or leave the field unset and report it.

Use the source's language as published, with one exception: a Chinese light novel or manga whose adopted description comes from a Japanese record (BOOK☆WALKER Japan or a Japanese publisher) gets a faithful Chinese translation in the book's script, `zh-Hans` or `zh-Hant`. Record the translation and its source in the run report. Other book types and Japanese-language books keep the source text.

## Choose a file operation

When cover supplementation is selected, follow [official cover adoption](covers.md) for edition matching, actual image inspection, original geometry and verified file-level application.

For general supplementation or selected corrections, use [bibliography cleanup](embedded-metadata.md#epub-clean-bibliography-with-a-reviewed-plan) for EPUB title, credit, publisher, date, description, language and ISBN fields, or patch the actual EPUB OPF on a staged copy for other fields; validate and write the verified result to the requested file. Preserve a recoverable copy before replacement. CBZ maintenance follows the corresponding `ComicInfo.xml` procedure. Read back the delivered file independently; no Calibre import, database update, sidecar export or application restart is part of completion.

The current runtime's `epub enrich` can supplement supported light-novel or manga EPUBs from a BookWalker lock, but preserves nonempty fields and deliberately updates the original date. It preserves all identifiers and does not fill a missing ISBN, even when the source lock contains one; complete that field through the direct OPF workflow and read it back. Use enrichment only when its changes fit the requested scope. Its output is a new EPUB; follow the file-installation procedure if the user requested replacement of the original. It is not the writer for a generic publisher record, a selected correction to a nonempty field, or a tags-only task.

`metadata resolve` configures new Markdown publications; its multi-provider catalog discovery and electronic-edition approval contract are separate from this maintenance workflow. Do not convert an existing book to Markdown or invoke those authoring gates to supplement its metadata. Use `metadata catalog` and `metadata edition` to gather lock-backed evidence for existing files, then apply changes through `metadata bibliography-audit` / `bibliography-clean` or a task-scoped format-aware writer. `metadata edition` is a generic page extractor, not a source of authority by itself: verify edition correspondence under the tiered hierarchy above.
