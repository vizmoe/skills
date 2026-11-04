# Bibliography for existing ebook files

Use this workflow to supplement or correct existing books, then apply the selected fields through [embedded metadata maintenance](embedded-metadata.md). The output is metadata inside the ebook file. Calibre's database, sidecar OPF and cover file are outside the write scope; the library supplies only the [controlled tag vocabulary](tags.md).

## Choose sources by book type

- **Confirmed prose light novels and manga:** use the [BookWalker workflow](bookwalker.md) with the correct work type; an adaptation and its prose original are separate records. For Chinese metadata select the corresponding Taiwan volume, or apply [no Taiwan volume](#no-taiwan-volume) when none matches; use the Japanese original's date, with the existing print-date-first, electronic-date-fallback rule. Use the chosen source field directly; publisher cross-verification is not required. Preserve its available precision rather than shortening a complete date or inventing a missing day.
- **Other books, including ordinary fiction, nonfiction and art books:** prefer the publisher's or imprint's official page for that book, edition and volume. Use the book's title/copyright pages and contents when the official page is unavailable or lacks a field. Apply this route without requiring a BookWalker record, Japanese counterpart or the light-novel/manga date policy. Use the selected edition's publication date from the available source; repeated cross-verification is not required.
- **Self-made and non-retail editions** (录入本, personal compilations, doujin or self-published books, scan-derived EPUBs): use the route for the work's type above, after identifying the work as in [self-made and non-retail editions](#self-made-and-non-retail-editions).

Check title, credited people and volume/edition sufficiently to avoid a wrong work or adaptation. One appropriate source can support a field; do not turn every lookup into a mandatory two-source investigation. Record the source URL or book location and adopted values in an external report. If evidence conflicts or is missing, preserve that field and finish other supported changes. The source rule for light novels does not classify every book from the same author or series as a light novel.

### Search and cross-script discovery

Source sites index their own script and edition naming: `bookwalker.com.tw` uses Traditional Chinese (`zh-Hant`) and Taiwan edition titles, `bookwalker.jp` uses Japanese original titles and Japanese kanji/kana, and publisher sites use their edition's script and imprint title. Searching a source site directly with Simplified Chinese (`zh-Hans`), a mainland translated title or Chinese-script creator names can return zero results even when the volume exists.

Before using a source's in-site search, query a general search engine (for example `site:bookwalker.com.tw`, `site:bookwalker.jp`, or publisher, ISBN, title and creator queries) to locate candidate product URLs directly and to identify the work's Taiwan title (`zh-Hant`), Japanese original title and target-script creator names. When in-site search or series browsing on the target site is still needed, convert Simplified/Traditional characters and Chinese/Japanese kanji variants and search with that site's native script and edition title. Search snippets and third-party bibliography pages (such as Douban, Bangumi or Wikipedia) are discovery leads only: verify work identity, credited people, edition type and volume on the actual BookWalker or publisher product page (recording cross-script or translated-title correspondence in the match evidence), and adopt metadata only from the authoritative source.

## No Taiwan volume

When a Chinese light novel or manga has no matching BOOK☆WALKER Taiwan volume, for example a mainland Simplified-only edition, the matched BOOK☆WALKER Japan volume becomes the source. Fetch it as a [Japanese-only lock](bookwalker.md#select-matching-editions). From it, adopt the date under the Japanese-original policy, the series position and a translated synopsis under the [description rule](#describe-the-work-not-the-file). Keep the book's own Chinese title, series name, contributors' Chinese names and language. Publisher, imprint and ISBN identify the Chinese edition, so fill them only from a Chinese-edition source such as the book's copyright page or its publisher; otherwise leave them as they are and report the gap. Apply these fields through direct OPF or ComicInfo maintenance; `epub enrich` would write the Japanese record's title and language.

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

For general supplementation or selected corrections, patch the actual EPUB OPF on a staged copy, validate it, and write the verified result to the requested file. Preserve a recoverable copy before replacement. CBZ maintenance follows the corresponding `ComicInfo.xml` procedure. Read back the delivered file independently; no Calibre import, database update, sidecar export or application restart is part of completion.

The current runtime's `epub enrich` can supplement supported light-novel or manga EPUBs from a BookWalker lock, but preserves nonempty fields and deliberately updates the original date. It preserves all identifiers and does not fill a missing ISBN, even when the source lock contains one; complete that field through the direct OPF workflow and read it back. Use enrichment only when its changes fit the requested scope. Its output is a new EPUB; follow the file-installation procedure if the user requested replacement of the original. It is not the writer for a generic publisher record, a selected correction to a nonempty field, or a tags-only task.

`metadata resolve` configures new Markdown publications; its online LoC discovery and electronic-edition approval contract are separate from this maintenance workflow. Do not convert an existing book to Markdown or invoke those gates to supplement its metadata. A task-scoped ZIP/XML edit or suitable format-aware writer is valid; the skill does not claim a universal metadata-writing CLI or a publisher-specific scraper.
