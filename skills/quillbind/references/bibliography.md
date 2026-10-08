# Bibliography for existing ebook files

Use this workflow to supplement or correct existing books, then apply the selected fields through [embedded metadata maintenance](embedded-metadata.md). The output is metadata inside the ebook file. Calibre's database, sidecar OPF and cover file are outside the write scope; the library supplies only the [controlled tag vocabulary](tags.md).

## Choose sources by book type

- **Confirmed prose light novels and manga:** use the [BookWalker workflow](bookwalker.md) with the correct work type; an adaptation and its prose original are separate records. For Chinese metadata select the corresponding Taiwan volume; use the Japanese original's date, with the existing print-date-first, electronic-date-fallback rule. Use the chosen source field directly; publisher cross-verification is not required. Preserve its available precision rather than shortening a complete date or inventing a missing day.
- **Other books, including ordinary fiction, nonfiction and art books:** prefer the publisher's or imprint's official page for that book, edition and volume. Use the book's title/copyright pages and contents when the official page is unavailable or lacks a field. Apply this route without requiring a BookWalker record, Japanese counterpart or the light-novel/manga date policy. Use the selected edition's publication date from the available source; repeated cross-verification is not required.

Check title, credited people and volume/edition sufficiently to avoid a wrong work or adaptation. One appropriate source can support a field; do not turn every lookup into a mandatory two-source investigation. Record the source URL or book location and adopted values in an external report. If evidence conflicts or is missing, preserve that field and finish other supported changes. The source rule for light novels does not classify every book from the same author or series as a light novel.

## Complete ISBNs where supported

General metadata supplementation includes ISBN completion without a separate ISBN request. Inspect the current identifiers, then actively look for missing ISBNs in the matched type-specific source above and the book's bibliography. Use title, credited people, edition and volume to find the correct record; one inaccessible page is not proof that no ISBN is available. A tags-only task or an explicit list of other fields does not expand to ISBN edits.

Retain existing ISBNs when supported; replace an evidenced wrong value only when a supported replacement is available. Validate ISBN syntax and checksum, normalize a valid ISBN-10 to ISBN-13 where appropriate, and distinguish format normalization from work/edition matching. A valid checksum alone does not establish a match. Do not borrow a number from an adaptation, another volume, a bundle or another work by the same author.

For Chinese light novels and manga, adopt the ISBN on the matched BOOK☆WALKER Taiwan page for that work type and volume; print/electronic or script differences alone do not disqualify it under this source policy. For other books, use the matched publisher/edition record or book bibliography. Record whether the number identifies the electronic edition or the source/print edition; do not label a source ISBN as a proven eISBN. Existing-file maintenance requires no new-publication eISBN approval or mandatory second-source confirmation.

Failed lookup, conflicting candidates or uncertain edition evidence must not clear an existing value. Retain it and report the concern if no supported replacement is available. Leave a previously absent ISBN empty only when no reliable candidate is found after the relevant lookup, or the format cannot represent it; record the attempted sources and reason while completing other supported fields. Never invent an ISBN, overwrite unrelated identifiers or change the primary UUID/`unique-identifier` to fill one.

EPUB supports an additional ISBN `dc:identifier` using its existing version's conventions, independently of its primary identity. ComicInfo 2.0 has no ISBN field: report that format limitation and preserve other metadata rather than inventing an element or storing the ISBN in `Notes`/`Summary`. Follow the [embedded format rules](embedded-metadata.md) for a different existing, validated profile.

## Build a small field plan

Identify each target by file path and SHA-256. Read its current package metadata and relevant book content, then record old/new values only for the fields being maintained:

| Field | Adoption rule |
| --- | --- |
| Title and contributors | Use the matched edition's title and credited names/roles. Keep author, translator and illustrator distinct; do not guess an original name from a translation. |
| Description | Use the matching publisher/BookWalker description or a factual summary of inspected book content. Keep plain text and meaningful paragraph breaks; a collection-wide description is not automatically a single volume's description. |
| Language/script | Follow the actual text; preserve `zh-Hans` / `zh-Hant` where applicable. Do not convert the book's text as a metadata edit. |
| Tags | Use exact labels from the current library vocabulary, supported by the work's content and the type-appropriate source. |
| Publisher, series and position | Adopt actual edition information. Distinguish a story series from a marketing collection or publisher imprint. Do not infer series membership from a shared author. |
| Date | Use the type-specific source policy above, retain known precision and leave unavailable components unset. Record the source field; no repeated cross-check is required. |
| ISBN | Actively fill from matched evidence during general supplementation; preserve supported values and report unresolved cases under the ISBN policy above. |

A metadata supplementation task does not by itself select covers, ratings, reading state or body text for replacement. When a field is selected, correct an evidenced wrong value as well as filling a blank; keep ambiguous values for review. Do not fabricate missing bibliography from a filename or a plausible title.

## Choose a file operation

For general supplementation or selected corrections, patch the actual EPUB OPF on a staged copy, validate it, and write the verified result to the requested file. Preserve a recoverable copy before replacement. CBZ maintenance follows the corresponding `ComicInfo.xml` procedure. Read back the delivered file independently; no Calibre import, database update, sidecar export or application restart is part of completion.

The current runtime's `epub enrich` can supplement supported light-novel or manga EPUBs from a BookWalker lock, but preserves nonempty fields and deliberately updates the original date. It preserves all identifiers and does not fill a missing ISBN, even when the source lock contains one; complete that field through the direct OPF workflow and read it back. Use enrichment only when its changes fit the requested scope. Its output is a new EPUB; follow the file-installation procedure if the user requested replacement of the original. It is not the writer for a generic publisher record, a selected correction to a nonempty field, or a tags-only task.

`metadata resolve` configures new Markdown publications; its online LoC discovery and electronic-edition approval contract are separate from this maintenance workflow. Do not convert an existing book to Markdown or invoke those gates to supplement its metadata. A task-scoped ZIP/XML edit or suitable format-aware writer is valid; the skill does not claim a universal metadata-writing CLI or a publisher-specific scraper.
