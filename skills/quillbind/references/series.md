# Normalize story series in existing files

Use this workflow when Series membership and reading order are in scope, sourcing facts from [bibliography by book type](bibliography.md) without touching Calibre's database, titles, filenames, tags, ISBNs, ratings or body content. Light-novel filename/title unification is a separate [whole-series naming](naming.md) operation.

## Decide membership and order

| Relationship / case | `decision` values | Rule |
| --- | --- | --- |
| Continuing narrative (`story-continuity`) or recurring protagonist + world (`shared-protagonist-world`) | `series: "<actual name>"`, `position: "<Arabic>" \| null` | Strip explicit quantity marketing (`全3册`, `共三冊`, `套装共3册`) while preserving intrinsic wording (`銀河三部曲`). When a marketing bundle wraps a real story subseries, assign the subseries's own name and position. |
| Shared author, imprint, topic, publisher collection, omnibus or multivolume nonfiction | Non-story relation, `series: null`, `position: null` | Clear non-story groupings without splitting the book or altering its title. |
| Missing, unverified or invalid position on a valid story series | `position: null`, `positionEvidence` (`null` if absent; required explanation if clearing an invalid old number) | Never use series totals (`Count`), default to `1`, guess from filename sorting, or clear an existing valid position due to lookup failure. |

## Arabic series positions for all books

| Input / case | Required metadata value | Title & filename boundary |
| --- | --- | --- |
| Evidenced target-edition Roman, CJK or fullwidth numerals (`II`, `Ⅱ`, `六`, `０６`) | ASCII Arabic digits (`2`, `6`) across EPUB `group-position`, `calibre:series_index` and CBZ `Number`. | Preserve original numerals and punctuation inside `dc:title` / `Title`; two-digit zero padding (`06`) belongs only to filenames/naming. |
| Evidenced official fractional volume (`1.5`, `6.5`) | Exact numeric string (`1.5`, `6.5`) with `positionEvidence`. | Distinct from local `.5` / `.5-01` insertion labels in [naming.md](naming.md), which never enter embedded series metadata or become `6.501`. |
| Hierarchical (`2.2.1`), lettered (`1A`) or ranged (`1-3`) positions | Leave unresolved for a compatible scoped writer; never force into a decimal. | Report the format constraint explicitly. |

## Audit and apply an evidenced decision

```sh
node <skill-directory>/scripts/quillbind.mjs metadata series-audit original.epub --output series.json --json
node <skill-directory>/scripts/quillbind.mjs metadata series-normalize original.epub --plan series.json --output normalized.epub --json
```

```json
{
  "relation": "story-continuity",
  "series": "銀河三部曲",
  "position": "1.5",
  "sources": ["book:contents and volume title page"],
  "evidence": ["The inspected volume belongs to this continuing story."],
  "positionEvidence": "The publisher explicitly numbers this selected-edition interlude 1.5."
}
```

| Format / guard | Behavior (`.epub` and `.cbz`) |
| --- | --- |
| EPUB collections & compatibility | Keep `before` and `collections` untouched; give every existing collection a `collectionDecisions` (`normalize` or `preserve` + `evidence`), and supply `conflictResolution` when multiple prior representations disagree. EPUB 3 writes typed `belongs-to-collection` (syncing `calibre:series*` only if already present); EPUB 2 writes `calibre:series*` and keeps `version="2.0"`. |
| CBZ `ComicInfo.xml` | Writes `Series` and `Number` only (`Count`, `Volume`, story arcs and groups remain untouched). |
| Delivery & order | Run after source supplementation so importers do not restore bundle names; enforces new-output collision checks, non-target byte preservation, EPUBCheck / ComicInfo 2.0 XSD validation and independent readback ([embedded-metadata.md](embedded-metadata.md)). |

Format references: EPUB 3.3 [collections](https://www.w3.org/TR/epub-33/#sec-belongs-to-collection) and [group-position](https://www.w3.org/TR/epub-33/#sec-group-position), ComicInfo [documentation](https://anansi-project.github.io/docs/comicinfo/documentation), and Calibre [series indexes](https://manual.calibre-ebook.com/template_lang.html#advanced-formatting).
