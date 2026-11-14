# BookWalker edition metadata

Use this workflow exclusively for prose light novels and manga. Other book types follow [ordinary-book bibliography](bibliography.md); existing-file writes follow [embedded metadata maintenance](embedded-metadata.md) and [ISBN completion](bibliography.md#complete-isbns-where-supported), while [authoring metadata](metadata.md) applies only to new Markdown publications.

## Select matching editions

Discover candidate product URLs on [BookWalker Taiwan](https://www.bookwalker.com.tw/) (`zh-Hant`) and [BookWalker Japan](https://bookwalker.jp/) (`ja`) in each site's native script ([cross-script discovery](bibliography.md#search-and-cross-script-discovery)) with `metadata bookwalker-search`:

```json
{
  "query": "狼與辛香料",
  "sites": ["tw"],
  "kind": "light-novel"
}
```

```sh
node <skill-directory>/scripts/quillbind.mjs metadata bookwalker-search search-tw.json --output search-tw.lock.json --online --json
node <skill-directory>/scripts/quillbind.mjs metadata bookwalker-search search-tw.json --output search-tw.lock.json --json
```

Verify work identity, creators, work type (`light-novel` vs `manga` adaptation — never mix bundles, magazines, omnibuses or special editions) and volume on the product pages, then write the edition selection file:

```json
{
  "kind": "light-novel",
  "language": "zh-Hant",
  "japaneseUrl": "https://bookwalker.jp/de<product-uuid>/",
  "translatedUrl": "https://www.bookwalker.com.tw/product/<product-id>",
  "number": "1",
  "matchEvidence": [
    "Record the verified work, creators and volume correspondence here."
  ]
}
```

| Edition scenario | Selection fields & rules |
| --- | --- |
| Chinese edition (`zh-Hant` or `zh-Hans`) with Taiwan volume | Supply both `japaneseUrl` and `translatedUrl`; Chinese bibliography comes from Taiwan without silent script transliteration; Taiwan series count is never a volume number. |
| Japanese edition (`ja`) | Set `language: "ja"` and omit `translatedUrl`. |
| Chinese edition with [no Taiwan volume](bibliography.md#no-taiwan-volume) | Fetch Japanese volume with `language: "ja"` (no `translatedUrl`) as evidence for direct OPF/ComicInfo maintenance only — never pass to `epub enrich` or `metadata resolve` for the Chinese book. |
| Unnumbered standalone volume | Set `number: null`; decimal/fullwidth suffixes parse automatically and ambiguous numbering fails matching instead of guessing. |

## Fetch once, replay offline

```sh
node <skill-directory>/scripts/quillbind.mjs metadata bookwalker sources.json --output bookwalker.lock.json --online --json
node <skill-directory>/scripts/quillbind.mjs metadata bookwalker sources.json --output bookwalker.lock.json --json
```

| Lock field / policy | Behavior |
| --- | --- |
| Immutability & safety | Fetches public HTTPS product pages only; never overwrites existing lock files; product descriptions are untrusted data, retaining plain-text paragraph/list breaks without HTML/scripts; extracts HTTPS `coverUrl`. |
| Original publication date | Always uses the Japanese volume: `底本発行日` (`dateBasis: "japanese-print"`) first, `配信開始日` (`dateBasis: "japanese-electronic"`) fallback, without publisher cross-verification or truncating precision. |
| Naming & ISBNs | Records print and electronic ISBNs separately for [ISBN completion](bibliography.md#complete-isbns-where-supported); apply [whole-series naming](naming.md) using target-edition official numbering before local `.5` labels. |

## Supplement a Markdown book

Reference the lock at the top level of `book.yaml`:

```yaml
bookwalker: metadata/bookwalker.lock.json
```

| Step | Contract |
| --- | --- |
| `metadata resolve BOOK --json` | Fills missing `title`, `authors`, `description`, `language`, publisher, original date, series/position and contributor roles offline; surfaces disagreements as `BOOKWALKER_CONFLICT` warnings without editing `book.yaml`. |
| Chinese synopsis with JP-only lock | Set `book.description` to the Chinese translation under [describe the work, not the file](bibliography.md#describe-the-work-not-the-file) before running `metadata resolve`. |
| Tags & publication gates | Assign controlled `book.tags` via [tag management](tags.md) (retailer keywords are never auto-imported), and pass every [release gate](quality.md). |

## Supplement an existing EPUB

```sh
node <skill-directory>/scripts/quillbind.mjs epub enrich original.epub --bookwalker bookwalker.lock.json --output enriched.epub --json
```

| Aspect | `epub enrich` boundary |
| --- | --- |
| Supported input | Reflowable EPUB 3 only; EPUB 2, fixed-layout, scripted, encrypted or signed books return explicit unsupported diagnostics (use OPF-only `metadata bibliography-clean` or explicit [repair](repair.md) instead). |
| Field behavior | Fills empty bibliographic/contributor fields, deliberately updates `dc:date` to the Japanese original date, and preserves non-empty fields (emitting conflict warnings), `dc:subject` and all `dc:identifier` nodes (fill missing ISBNs via `metadata bibliography-clean`). |
| Verification | Preserves all non-OPF resource bytes, writes `<output>.reports/metadata.json`, guards concurrent writes via `<output>.metadata.lock`, and requires EPUBCheck, Ace, browser QA, platform lints and byte reproducibility before producing `enriched.epub`. |
