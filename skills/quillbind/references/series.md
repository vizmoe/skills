# Normalize story series in existing files

Use this workflow when Series and reading order are selected, including full library-rule cleanup. Sources follow [bibliography by book type](bibliography.md): BOOK☆WALKER for light novels and manga; publisher/book evidence for other books. One appropriate source may establish the facts. Treat a retailer's series label as a candidate, not proof of narrative membership. Do not modify Calibre's database, titles, filenames, tags, ISBNs, ratings or book content as a side effect.

## Decide membership and order

- Keep a series for works with a connected story. Independent cases can qualify when both a recurring protagonist and the same story world are established.
- A shared author, publisher imprint, subject, marketing bundle or author omnibus is insufficient. Nonfiction multivolume works do not become Series from their volume count or shared topic.
- When a marketing bundle contains a genuine story subseries, inspect each book and assign its actual subseries. The bundle's name and bundle position are not the subseries's name and reading position.
- Keep the actual name, including intrinsic wording such as `銀河三部曲`. Remove explicit quantity marketing such as `全3册`, `共三冊` or `套装共3册`; do not remove the intrinsic `三部曲` merely because it contains a number. For a complex marketing string, supply the evidenced actual name rather than guessing with increasingly broad string replacement.
- Verify position independently of membership, using the selected edition's volume or the supported reading order. This does not require another source: one source can establish both facts. Preserve supported existing positions, including fractions such as `1.5`; failed lookup is not a reason to clear one. Never use a series total as the position, default a missing number to `1`, or renumber by filename sorting. Use `null` when the position is absent or evidenced as invalid, and explain the gap or removal in the external report.
- For a non-series grouping, explicitly clear both name and position. Removing a bad grouping does not authorize splitting the book or changing its title.

## Arabic series positions for all books

Whenever a field expresses a book's position in a series, use ASCII Arabic digits, for every book type. This includes EPUB `group-position`, embedded `calibre:series_index`, CBZ `Number`, and any other explicitly selected, supported series-order field. The rule does not create story membership for a non-series collection or expand the selected edit scope.

Resolve the value against the target publication edition: an evidenced `II` or `Ⅱ` becomes `2`, `六` becomes `6`, and `０６` becomes `6`. Do not mix another edition's numbering, parse numeral-like words in a title, or guess an ambiguous number. Record the original notation, selected numeric value and source evidence. A missing lookup does not authorize clearing an existing value; report unresolved cases and do not claim complete normalization.

Preserve the original title's language, characters, numeral forms and punctuation. Two-digit zero padding belongs to the filename/title naming convention, not the numeric metadata value. Local insertion labels such as `06.5` and `06.5-01` are filename/sort decisions, not evidence of official volume numbers. Do not copy them into official metadata or invent `6.501` to fit a numeric field. A genuine official fractional position may remain numeric, such as `6.5`, with its own evidence. The source title and local filename are never sufficient evidence for that decision.

The existing normalization writer accepts only numeric positions and leaves evidence-based numeral conversion to the plan author. For a format with several selected representations, read them back together after writing and confirm all express the same supported Arabic value. Unsupported hierarchical, lettered or ranged positions require a compatible scoped representation; do not force them into a decimal or substitute a default.

## Audit and apply an evidenced decision

```sh
node <skill-directory>/scripts/quillbind.mjs metadata series-audit original.epub --output series.json --json
node <skill-directory>/scripts/quillbind.mjs metadata series-normalize original.epub --plan series.json --output normalized.epub --json
```

The same commands accept CBZ files. Inspect the original `before` fields and `collections`; do not edit those inventory records or their source/metadata hashes. Fill `decision` with the supported relationship, actual name, position, sources and evidence. For example, after verifying the facts:

```json
{
  "relation": "story-continuity",
  "series": "銀河三部曲",
  "position": "1.5",
  "sources": ["book:contents and volume title page"],
  "evidence": ["The inspected volume belongs to this continuing story."],
  "positionEvidence": "The contents identify this interlude between volumes 1 and 2."
}
```

The runtime schema defines the relationship choices. Use `shared-protagonist-world` for independently evidenced cases in the same narrative world. Non-story choices require `series: null` and `position: null`; the tool does not infer this classification from the title. For an absent, unknown position, also set `positionEvidence: null`. Removing a present position while retaining a story series requires `positionEvidence` explaining why that old order is invalid; an unsuccessful search is insufficient. The shared EPUB/Calibre compatibility route accepts nonnegative integer or fractional numeric positions. Do not coerce a hierarchical position such as `2.2.1`, a lettered issue or a volume range into a decimal; keep it unresolved for a compatible scoped writer.

Every existing EPUB collection needs a `collectionDecisions` disposition. The audit preselects explicitly typed `series` records for normalization and explicitly typed `set` records for preservation; inspect those choices. A missing/unknown collection type requires an explicit `normalize` or `preserve` decision with evidence. Preserve unrelated collections. When normalizing several conflicting representations into one selected story series, account for every old name/order and provide `conflictResolution`; the tool refuses to silently pick a winner. Nested collection hierarchies or ambiguous IDs require a separately planned repair.

The writer synchronizes the selected EPUB collections and any existing `calibre:series` / `calibre:series_index` compatibility fields. EPUB 2 uses compatibility fields and retains its version; EPUB 3 uses a typed collection, without adding compatibility fields when absent. Selected collection refinements are replaced with the evidenced name/type/position, so inspect their authority, alternate-script or sorting metadata in the recorded original XML before normalizing. Unselected collections remain intact. CBZ uses `Series` and `Number`; `Count`, `Volume`, alternate-series fields, story arcs and groups have different meanings and remain outside this writer's field scope. Any additional correction needs its own explicit field decision.

The operation uses the [file-maintenance protections](embedded-metadata.md): new destination only, retained original, fixed source hash, planned EPUB 3 modification time, non-target ZIP preservation, independent metadata readback, actual EPUBCheck/ComicInfo XSD validation and external reports. An unchanged file remains byte-identical. `<output>.reports/metadata.json` records old/new values, decisions, conflict handling and integrity/validator evidence. This does not claim native-reader rendering or a publication release.

Resolve Series after source-driven supplementation, and do not run an importer afterward that reintroduces rejected bundle names or positions. Check the final file's supported representations together. A tags-only operation keeps Series untouched; this operation likewise keeps scores and tags unchanged.

Format references checked 2026-10-08: EPUB [collections](https://www.w3.org/TR/epub-33/#sec-belongs-to-collection) and [group positions](https://www.w3.org/TR/epub-33/#sec-group-position), ComicInfo [field meanings](https://anansi-project.github.io/docs/comicinfo/documentation), and Calibre [fractional series indexes](https://manual.calibre-ebook.com/template_lang.html#advanced-formatting). Narrative-membership and marketing exclusions are this library's policy, not a universal format restriction.
