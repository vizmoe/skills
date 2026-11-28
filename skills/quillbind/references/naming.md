# Name a whole book series consistently

Apply this naming policy to any selected book series family across all book types (novels, light novels, manga, fiction, nonfiction, academic and technical multivolume series, covering main volumes, side stories, short-story collections and extras). Standalone non-series books keep their matched edition titles, while [Arabic series-position metadata](series.md#arabic-series-positions-for-all-books) applies to every book type. Use type-appropriate [bibliography sources](bibliography.md) (BookWalker for light novels and manga; publisher, public catalog and verified edition sources for ordinary books) for one target publication edition without mixing volume numbers across languages or editions.

## Establish the edition and naming components

```text
{main series} ({number}) {volume title, if any}
{main series} {official subseries} ({number}) {volume title, if any}
```

| Component | Rule |
| --- | --- |
| Main series & subseries | Use one standard main-series name across the family. Retain an `official subseries` component (e.g., `SPIN OFF`) only when the publisher establishes its own subseries name and numbering, with one consistent spelling across its volumes. Work-type labels are never added to `main series` automatically. |
| Number formatting | ASCII parentheses and single ASCII spaces; pad integer parts to at least two digits (`(01)`, `(10)`, `(100)` — never truncate 3+ digits). Omit trailing space and `{volume title}` when no independent volume title exists. |
| Volume title | Preserve original language, script, numeral characters, internal spaces and punctuation; never translate, script-convert or silently strip filesystem-illegal characters (`ILLEGAL_FILENAME_STEM`). |

### Naming scope

Parsed directly by [scripts/skill-rules.ts](../scripts/skill-rules.ts), [scripts/naming.ts](../scripts/naming.ts) and [scripts/delivery-audit.ts](../scripts/delivery-audit.ts):

| Scope | Policy | Rule |
| --- | --- | --- |
| `book-types` | `all-series` | Apply `{main series} ({number}) {volume title, if any}` to any selected book series across all book types, not limited to light novels. |
| `standalone-books` | `keep-edition-title` | Standalone non-series books retain their matched edition titles. |

### Supported work kinds

Parsed directly by [scripts/skill-rules.ts](../scripts/skill-rules.ts), [scripts/naming.ts](../scripts/naming.ts) and [scripts/delivery-audit.ts](../scripts/delivery-audit.ts):

| Work kind | Official numbering requirement | Role in local `.5` insertion |
| --- | --- | --- |
| `main` | Requires `official.unified` number in the target edition. | Supplies main-volume anchors in first-publication chronology. |
| `side-story` | Uses `official-unified` or `official-subseries` when assigned; otherwise requires `unavailableEvidence`. | Eligible for `local-insertion` after its anchor main volume. |
| `short-story-collection` | Uses `official-unified` or `official-subseries` when assigned; otherwise requires `unavailableEvidence`. | Eligible for `local-insertion` after its anchor main volume. |
| `extra` | Uses `official-unified` or `official-subseries` when assigned; otherwise requires `unavailableEvidence`. | Eligible for `local-insertion` after its anchor main volume. |

## Choose numbers in this order

Parsed in priority order by [scripts/skill-rules.ts](../scripts/skill-rules.ts) and [scripts/naming.ts](../scripts/naming.ts):

| Priority | Basis | Condition | Filename label | Embedded `officialMetadata` proposal |
| --- | --- | --- | --- | --- |
| 1 | `official-unified` | Target edition numbers main volumes and extras in one unified sequence (including evidenced official decimals like `6.5`). | `(01)`, `(06.5)`, `(11)` | `{title, series: mainSeries, position}` (unpadded Arabic `position`). |
| 2 | `official-subseries` | No unified number, and publisher assigns a named subseries with its own numbering. | `{main} {subseries} (01)` | `{title, series: "{main} {subseries}", position}` (never converted to `.5`). |
| 3 | `local-insertion` | Neither official scheme exists (`unavailableEvidence` recorded); anchored to latest preceding main volume by **first publication** (`(06.5)` if sole extra at anchor, `(06.5-01)`, `(06.5-02)` for **all** extras sharing that anchor; post-final extras anchor to final main volume; never `(00.5)`). | `(06.5)` or `(06.5-01)` | `null` — local `.5` / `.5-ss` labels are filename/sort-only and never enter `dc:title`, `group-position`, `calibre:series_index` or ComicInfo `Number`. |

```text
三體 (01) 地球往事
The Art of Computer Programming (01) Fundamental Algorithms
TIGER×DRAGON (01)
TIGER×DRAGON SPIN OFF (01) 幸福的櫻色龍捲風
某系列 (06) / 某系列 (06.5) 番外篇 / 某系列 (07)
某系列 (06) / 某系列 (06.5-01) 外傳第一卷 / 某系列 (06.5-02) 外傳第二卷 / 某系列 (07)
```

## Generate and verify a reviewable plan

```sh
node <skill-directory>/scripts/naming.ts plan --input inventory.json --output new-naming-plan.json
node <skill-directory>/scripts/delivery-audit.ts verify-naming --plan new-naming-plan.json --output naming-verify.json
```

| Input / check | Contract |
| --- | --- |
| Inventory template | Start from [naming-example.json](naming-example.json) (`schemaVersion: 1`, `series`, `coverage`, `chronology`, `books`). Include reference-only volumes (`source: null`) when `local-insertion` is used so partial file selections do not miscount shared anchors (`coverage.mainComplete` and `extrasComplete` must be `true`). |
| Chronology | Disjoint `firstPublished` (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) intervals establish order; overlapping, same-date or `null` dates require `chronology: {order: [...], evidence: [...]}` matching actual first-publication order without contradicting known dates. |
| On-disk verification | `naming.ts` is `sourceVerification: "declared-only"`. Before renaming or editing files, run `delivery-audit.ts verify-naming` to verify every non-null `source.path` exists, matches `source.sha256`, uses legal filename characters, and has no batch or existing-file destination collision (`DESTINATION_EXISTS`, `DESTINATION_BATCH_COLLISION`, `SOURCE_HASH_MISMATCH`). |
| Embedded writes | Apply authorized embedded `dc:title` / `Series` changes after source supplementation via [embedded metadata maintenance](embedded-metadata.md) (respecting [story series boundaries](series.md) for embedded `Series` fields) so importers do not overwrite unified names, and never touch Calibre's database or sidecars. |
