# Name a whole light-novel series consistently

Apply this naming policy to a selected light-novel family, including main volumes, side stories, short-story collections and extras. It does not change the naming of other book types; [Arabic series-position metadata](series.md#arabic-series-positions-for-all-books) applies to every book type. Use [BOOK☆WALKER and publisher evidence](bibliography.md) under the existing source policy. No mandatory second-source confirmation is needed.

## Establish the edition and naming components

Use one evidenced standard main-series name throughout the family. A work-type label such as `SPIN OFF` or `SIDE ARMS` is not automatically part of that name. Keep an official independent subseries only when the publisher establishes its name and numbering; record that decision explicitly and use one standard spelling across its volumes. Resolve aliases from the sources before planning; the helper detects equivalent spelling variants but cannot establish semantic identity from different names. Never infer a subseries merely from a filename, retailer category or the words on a cover.

The formats are:

```text
{main series} ({number}) {volume title, if any}
{main series} {official subseries} ({number}) {volume title, if any}
```

Separate components with one ASCII space, use ASCII parentheses, and pad each integer component to at least two Arabic digits: `(01)`, `(02)`, `(10)`. Never truncate `(100)`. Preserve the volume title's original language, characters and punctuation, including numeral forms and internal spaces; do not translate, convert scripts or Unicode-normalize it as a naming side effect. If there is no independent volume title, omit that component and its preceding space. An illegal filename character is a constraint to resolve, not permission to silently rewrite a title.

Use one target publication edition and its numbering system. A source-language edition may supply first-publication chronology without supplying the translated edition's volume numbers. Record the mapping to the target edition; do not copy numbers across versions. A series count is not a volume number.

## Choose numbers in this order

1. **Official unified numbering.** If the selected edition numbers main volumes, extras or collections in one sequence, use those numbers directly. Do not add `.5`, add an extra work-type series label, or replace this sequence with another edition's independent numbering.
2. **Official independent subseries.** If no applicable unified number exists but the publisher supplies a separate subseries name and number, retain both. Use the subseries's own `(01)`, `(02)`, etc.; do not convert it to `.5`.
3. **Local insertion only.** Only an extra that needs placement among main volumes and lacks either applicable official scheme gets a local label. Record the lookup/evidence establishing the absence of official numbering. Missing evidence or an unparsed official Roman numeral does not establish that absence.

For local insertion, order works by their **first publication**, not filename order, reissue date, ebook upload date or retrieval time. Use the number of the latest preceding main volume as the anchor. An extra published after the main story ends uses the final main-volume anchor. A single extra at that anchor uses `(06.5)`. When several unnumbered extras share it, **all** use `(06.5-01)`, `(06.5-02)`, etc., in first-publication order. Include reference-only main volumes and extras when they are outside the selected files, so a partial selection does not incorrectly look like a single insertion.

Date precision must not be invented. Disjoint year/month/day intervals can establish order. For same-date, overlapping or unavailable dates, obtain explicit bibliographic order evidence. If it remains ambiguous, report the gap. Do not manufacture a `(00.5)` position before the first main volume or move an extra to a convenient gap. Check local labels against official fractional numbers too; a collision needs an evidenced resolution.

Examples supplied by the user:

```text
TIGER×DRAGON (01)
TIGER×DRAGON (02)
TIGER×DRAGON SPIN OFF (01) 幸福的櫻色龍捲風
TIGER×DRAGON SPIN OFF (02) 秋高虎肥

某系列 (06)
某系列 (06.5) 番外篇
某系列 (07)
```

With two unnumbered extras instead of one:

```text
某系列 (06)
某系列 (06.5-01) 外傳第一卷
某系列 (06.5-02) 外傳第二卷
某系列 (07)
```

## Generate a reviewable plan

The standalone helper needs Node.js and works from an installed skill without the publication runtime:

```sh
node <skill-directory>/scripts/naming.mjs plan --input inventory.json --output new-naming-plan.json
```

Start from [the synthetic inventory example](naming-example.json); replace its illustrative identity, evidence, paths and hashes with the selected books' inspected facts. The helper reads that JSON only, hashes it, and produces proposals. It does not open the declared ebook paths, fetch sources, rename files or write metadata. `sourceVerification: "declared-only"` makes this boundary explicit. Existing report paths, including symlink aliases, are refused.

The input records these decisions:

- `series`: one standard `name`, target `edition` identifier and `evidence` array. Every book's `edition` must match it.
- `coverage`: `mainComplete`, `extrasComplete` and `evidence`. Local insertions require the complete known main-volume and unnumbered-extra inventory, including reference-only records. These are evidence-backed declarations, not a claim that the helper discovered every book.
- `chronology`: `null` when dates establish the needed order, otherwise `{order: [main and unnumbered-extra IDs once, in first-publication order], evidence: [...]}`. Include every relevant main/extra record; unrelated officially numbered subseries need no chronology unless explicitly included. The helper refuses an order contradicting non-overlapping dates. The evidence must establish actual publication order, not preferred reading order.
- Each book: stable unique `id`; `kind` (`main`, `side-story`, `short-story-collection`, `extra`); exact `originalTitle`; independent `volumeTitle` or `null`; `firstPublished` (`YYYY`, `YYYY-MM`, `YYYY-MM-DD` or `null`); and identity/title/chronology `evidence`.
- Each selected book's `source`: inspected absolute `path` and SHA-256. A reference-only book has `source: null` and still affects numbering. Hashes are declared in this input and must be checked against actual files before application.
- Each book's `official`: `unified` is `null` or `{number, evidence}`; `subseries` is `null` or `{name, number, evidence}`; `unavailableEvidence` records why neither official scheme applies, otherwise it may be empty. `subseries.name` is the official subseries component, e.g. `SPIN OFF`, not the repeated main-series prefix. Convert evidenced official numeral notation to an Arabic numeric string before planning; unknown/ranged/hierarchical official numbers need resolution instead of local fallback.

The report preserves evidence, reference-only records, the input hash and original titles. `filenameStem` excludes the original extension. `order` lists selected IDs in numeric order within each series/subseries; do not rely on lexical filename sorting across `(99)` and `(100)`. `sortKey` is a structured local key (series, integer digits, fractional digits, insertion sequence), not a decimal metadata number.

## Apply only selected names and fields

Review the complete before/after table and source evidence. For official schemes, `officialMetadata` proposes the formatted title, selected series name and **unpadded Arabic** position. Apply only fields authorized by the naming task and the existing [Series membership rules](series.md); a proposal does not authorize unrelated metadata changes.

For local insertions, `officialMetadata: null` means **no metadata proposal**, not “clear existing metadata.” Custom `.5` / `.5-ss` labels are only for local filenames and sorting. Do not put them into EPUB `dc:title`, `group-position`, `calibre:series_index` or ComicInfo `Number` as official numbering, or invent values such as `6.501`. Retain the original embedded title unless a separate evidenced title correction is selected. If a source genuinely assigns an official fractional volume, its independently evidenced numeric value remains eligible under the official scheme.

Before applying a plan, recheck the inventory/source hashes and all destination paths, including existing files, Unicode/case equivalence and the target filesystem's name restrictions. Keep source originals and extensions; use staged new outputs and refuse overwrites. A plan for the whole family can include reference-only books without authorizing changes to those files. For embedded title/series corrections, use [file-level maintenance](embedded-metadata.md), validate the actual EPUB/ComicInfo format and read back the selected fields and all non-target integrity checks. Finish naming after source-driven supplementation so a later importer does not restore inconsistent names.

Report old/new filenames, selected embedded title/series values, official versus local numbering basis, chronology evidence, conflicts and actual validation. No Calibre database, sidecar OPF, library `cover.jpg`, import or restart is part of this operation. A generated naming plan is not an applied rename or a validated ebook delivery.
