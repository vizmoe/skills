# Bibliography for existing ebook files

Supplement or correct existing EPUB and CBZ files by locking upstream records and applying selected fields through [embedded metadata maintenance](embedded-metadata.md). Never write Calibre's database, sidecar `metadata.opf` or `cover.jpg`; the library supplies only the [controlled tag vocabulary](tags.md).

## Choose sources by book type

| Book type | Upstream source route | Date rule | Cross-verification |
| --- | --- | --- | --- |
| Confirmed prose light novels and manga | [BookWalker workflow](bookwalker.md) (`metadata bookwalker-search` → `metadata bookwalker`); adaptations and prose originals are separate works. Chinese editions pair Taiwan (`zh-Hant`) + Japan (`ja`), or use [no Taiwan volume](#no-taiwan-volume). | Japanese original volume: `底本発行日` (print) first, `配信開始日` (electronic) fallback, at full stated precision. | Not required; adopt selected field directly. |
| Ordinary fiction, nonfiction and art books (CN / JP / EN) | Three-tier ordinary-book hierarchy below (`metadata edition` and `metadata catalog`), plus the book's own title/copyright pages when upstream records lack a field. | Selected edition's publication date at its stated precision (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`). | Not required; combine catalog + edition locks on the same edition when needed. |
| Self-made and non-retail editions | Identify the published work first under [self-made and non-retail editions](#self-made-and-non-retail-editions), then follow the work's book-type route above. | Same as the identified work's book type. | Record identification evidence in the external report only. |

### Ordinary-book source tiers and CN / JP / EN routing

| Tier | Source class | Runtime command | Allowed and excluded scope |
| --- | --- | --- | --- |
| Tier 1 | Official publisher or imprint edition page | `metadata edition` (`--online` or `--page saved.html`) | Primary authority for edition title, contributor roles, publisher/imprint, ISBN, date, series, synopsis and official `coverUrl`. |
| Tier 2 | Public institutional and industry bibliographic catalogs | `metadata catalog` (`openbd`, `ndl`, `cinii`, `loc`, `openlibrary`, optional `google-books`) or `metadata edition --page` on saved national library pages | Structured ISBN, MARC-880 vernacular CJK creators/publishers, publication date, series and JPRO/ONIX or Open Library synopses/covers when Tier 1 is offline, bot-gated or lacks structured fields. |
| Tier 3 | Verified edition-specific bibliography or bookstore product pages | `metadata edition` (`--online` or `--page saved.html`) plus the book's own title/copyright pages | Edition-specific pages (Douban Books `book.douban.com/subject/<id>/` for mainland Chinese editions, Books.com.tw / Eslite for Taiwan editions, or major JP/EN bookstore product pages) after cross-checking title, credited people, publisher and ISBN/volume. Never adopt community ratings/tags/reviews, raw search snippets, multi-edition wiki articles (Wikipedia, Baidu Baike, work-level Bangumi pages) or download sites. |

| Language / ISBN group | Catalog providers (`metadata catalog`) | Typical field coverage and Tier 1 / Tier 3 pairing |
| --- | --- | --- |
| Mainland Chinese (`zh-Hans`, `978-7`) | `loc` (SRU MODS 3.8 + MARC-880 vernacular CJK), `ndl`, `cinii`, `openlibrary`, optional `google-books` | Pair `metadata catalog` bibliography with a publisher page or verified Douban Books edition subject page (`metadata edition --page`) for Chinese synopses, translator/series details or domestic presses absent from international catalogs. |
| Traditional Chinese (`zh-Hant`, `978-957` / `978-986` / `978-988`) | `loc` (vernacular `zh-Hant` MARC-880), `ndl`, `cinii`, `openlibrary`, optional `google-books` | Pair publisher/imprint pages (`metadata edition`) with `metadata catalog` and verified Taiwan/HK bookstore edition pages (such as Books.com.tw) when publisher sites omit synopses or ISBNs. |
| Japanese (`ja`, `978-4`) | `openbd` (JPRO/ONIX), `ndl` (NDL Search DC-NDL), `cinii`, `loc` | `openbd` supplies publisher ONIX synopses, contributor roles, imprints, print/eISBNs and official `coverUrl`; `ndl` and `cinii` cover backlist, academic and non-JPRO editions. |
| English (`en`, `978-0` / `978-1`) | `loc` (SRU MODS 3.8), `openlibrary`, optional `google-books` | Combine publisher edition pages (`metadata edition`) with `loc` authority bibliography and `openlibrary` / `google-books` synopses and covers. |

### Query public book catalogs

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

Omit `providers` for automatic language/ISBN routing (`google-books` joins when `GOOGLE_BOOKS_API_KEY` is set, with API keys redacted from saved URLs). Review `CATALOG_CONFLICT`, `CATALOG_MATCH` and `CATALOG_UNAVAILABLE` diagnostics before adopting fields; omit `--online` to replay offline.

### Extract an ordinary book's edition page

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

| Extractor aspect | Behavior |
| --- | --- |
| Retrieval modes | `--online` fetches only that public HTTPS URL; when bot-gated or script-rendered, save the page yourself and pass `--page saved.html` (never spoof User-Agents or bypass anti-bot challenges). Omit both flags to verify an existing lock offline. |
| Extraction & cleaning | Parses JSON-LD/microdata first, then synopsis blocks, detail rows, citation/DC meta and Open Graph while stripping nav/header/footer/aside/review/recommendation noise, storefront title suffixes, credit role/nationality prefixes, invalid ISBNs and truncated meta descriptions; extracts HTTPS `coverUrl`. |
| Diagnostics | `EDITION_MATCH` fails when expected ISBN is absent; `EDITION_ISBN_AMBIGUOUS` leaves ISBN unset when multiple appear without an expected ISBN; `EDITION_CONFLICT` and `EDITION_CLEANED` surface candidate disagreements and stripped residue for review. |

### Search and cross-script discovery

| Target site | Native script & indexing | Discovery rule |
| --- | --- | --- |
| `bookwalker.com.tw` | Traditional Chinese (`zh-Hant`) Taiwan edition titles | Convert `zh-Hans` or mainland translated titles to Taiwan `zh-Hant` titles/creators before running `metadata bookwalker-search` (`sites: ["tw"]`). |
| `bookwalker.jp` | Japanese original title & Japanese kanji/kana | Locate the Japanese original title/creators via general search first, then run `metadata bookwalker-search` (`sites: ["jp"]`). |
| Publisher / bookstore sites | Edition-native script (`zh-Hans`, `zh-Hant`, `ja`, `en`) | Use search snippets and wikis (Wikipedia, Bangumi) as discovery leads only; verify identity and extract fields exclusively from the matched authoritative product/catalog record. |

## No Taiwan volume

When a Chinese light novel or manga has no matching BOOK☆WALKER Taiwan volume (e.g., a mainland `zh-Hans`-only edition), fetch the matched BOOK☆WALKER Japan volume as a [Japanese-only lock](bookwalker.md#select-matching-editions) (`language: "ja"`):

| Field group | Source rule when Taiwan BookWalker has no matching volume |
| --- | --- |
| Date & series position | Adopt from the Japanese BookWalker lock (`底本発行日` then `配信開始日`, Arabic series position). |
| Description | Translate the Japanese synopsis faithfully into the book's Chinese script (`zh-Hans` or `zh-Hant`) under [describe the work, not the file](#describe-the-work-not-the-file), recording source URL and translation in the report. |
| Title, series name, creators, language | Keep the Chinese book's own title, series name, Chinese creator names and `zh-Hans` / `zh-Hant` language; never run `epub enrich` (which would overwrite title and language with Japanese). |
| Publisher, imprint & ISBN | Adopt only from a verified Chinese-edition source (copyright page, `metadata catalog` `978-7` record, or `metadata edition` on the Chinese publisher/edition page); otherwise leave unchanged and report the gap. |

## Self-made and non-retail editions

Parsed directly by [scripts/skill-rules.mjs](../scripts/skill-rules.mjs) and verified by [scripts/delivery-audit.mjs](../scripts/delivery-audit.mjs):

| Edition class | Identification evidence | Metadata rule |
| --- | --- | --- |
| `retail` | `optional` | Match edition by ISBN/title/creators/volume and adopt fields from the book-type source route. |
| `self-made` | `required` | Identify the published work by title, credited people and volume against internal title/colophon/text (any embedded ISBN is a lead to verify, not proof); adopt full bibliography/ISBN from the work's source route and keep `self-made` / 录入本 notes strictly in the external report. |
| `compilation` | `required` | Identify the published anthology or constituent volume before adopting edition metadata; never write personal-compilation provenance into `dc:description` or `Summary`. |
| `doujin` | `required` | Identify circle/creator, event/release date and issue from the work and creator/publisher pages; leave absent commercial ISBNs as `unresolved` with `attemptedSources`. |
| `scan-derived` | `required` | Identify the underlying print/digital volume by title, creators and volume; adopt official edition metadata while keeping scan provenance in the external report. |

## Complete ISBNs where supported

Parsed directly by [scripts/skill-rules.mjs](../scripts/skill-rules.mjs) and verified by [scripts/delivery-audit.mjs](../scripts/delivery-audit.mjs):

| Disposition | Requires ISBN | Requires attemptedSources | Rule |
| --- | --- | --- | --- |
| `retained` | `yes` | `no` | Existing valid ISBN matches the work/edition, or upstream lookup failed/conflicted without a verified replacement (never clear an existing valid ISBN on lookup failure). |
| `added` | `yes` | `no` | Missing ISBN filled from the matched edition source (prefer print ISBN when both print and electronic ISBNs exist; use eISBN only when no print ISBN exists; no new-publication eISBN approval gate applies). Written in [ISBN identifier form](embedded-metadata.md#isbn-identifiers) without altering EPUB `unique-identifier`. |
| `corrected` | `yes` | `no` | Evidenced wrong ISBN replaced in place by the matched edition's normalized 13-digit ISBN while keeping primary UUID untouched. |
| `skipped-format` | `no` | `no` | Target is CBZ ComicInfo 2.0, which has no ISBN element; skip without inventing XML tags or writing ISBNs into `Notes`/`Summary`. |
| `unresolved` | `no` | `yes` | Previously absent ISBN remains empty after checking relevant catalog/publisher/edition sources; report `attemptedSources` and `reason` while completing other fields. |
| `out-of-scope` | `no` | `no` | Task was explicitly scoped to non-ISBN fields (such as tags-only or naming-only). |

## Build a small field plan

Bind each target file path and SHA-256, recording old/new values only for selected fields:

| Field | Adoption rule |
| --- | --- |
| Title & contributors | Matched edition title and split contributor roles (`aut`, `trl`, `ill`, `edt`, `ant`, `art`, `pht`); apply [whole-series naming](naming.md) only when light-novel naming is in scope. Never guess original-script names from translations. |
| Description | Work synopsis only under [describe the work, not the file](#describe-the-work-not-the-file); never import retailer/community scores. |
| Language / script | Match actual book text (`zh-Hans`, `zh-Hant`, `ja`, `en`); never convert text during metadata maintenance. |
| Tags | Canonical labels from [tag management](tags.md) supported by content and type-specific source. |
| Publisher, series & position | Verified edition publisher/imprint and narrative [story series](series.md) with Arabic positions; exclude marketing bundles and author collections. |
| Date & ISBN | Type-specific source date at stated precision and ISBN under the disposition table above. |

## Describe the work, not the file

| Book type & language | Source synopsis language | Required action |
| --- | --- | --- |
| Any book where source language matches book language | Same language | Adopt plain-text synopsis with paragraph breaks; strip HTML, watermarks, credit lists, ISBN explanations and file provenance (`SYNOPSIS_CONTAINS_PROVENANCE`). |
| Chinese (`zh-Hans` / `zh-Hant`) light novel or manga | Japanese (`ja`, BookWalker JP or JP publisher) | Translate faithfully into the book's Chinese script (`zh-Hans` or `zh-Hant`) and record `translationSource` in the run report (`MISSING_TRANSLATION_SOURCE` / `UNTRANSLATED_JAPANESE_SYNOPSIS`). |
| Ordinary Chinese book or any Japanese/English book | Foreign-language source only | Do **not** translate (`ORDINARY_SYNOPSIS_TRANSLATED`); keep source text only when appropriate for the edition or preserve existing value and report the gap. |

## Choose a file operation

| Operation | Scope and boundary |
| --- | --- |
| `metadata bibliography-audit` / `bibliography-clean` | Reviewed cleanup and source-locked field assignments for existing `.epub` and `.cbz` files ([embedded metadata](embedded-metadata.md#epub-clean-bibliography-with-a-reviewed-plan)); leaves primary UUID, subjects, series, ratings, covers and non-metadata ZIP members intact. |
| `metadata cover-fetch` / `cover-audit` / `cover-adopt` | Official cover retrieval, visual inspection and lossless file-level adoption ([covers](covers.md)) when cover work is in scope. |
| `epub enrich` | Offline BookWalker supplementation for reflowable EPUB 3 light novels/manga (`bookwalker.md#supplement-an-existing-epub`); updates original JP date and fills empty fields, but does not fill missing ISBNs or rewrite `dc:subject`. |
| `metadata resolve` | New Markdown publication configuration only ([authoring metadata](metadata.md)); never convert an existing ebook to Markdown or apply its eISBN approval gate to file maintenance. |
