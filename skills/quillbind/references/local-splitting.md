# Split an existing local EPUB anthology

Use this workflow for an existing EPUB that contains several books or volumes. [Website collection](novels.md) and generic repair do not establish local volume boundaries. Read the actual contents, title/copyright pages, NAV/NCX, spine and chapter transitions. A bundle title, filename, publisher collection, common author or chapter count alone is insufficient evidence for a split or a story Series.

## Inventory and review boundaries

```sh
node <skill-directory>/scripts/quillbind.mjs epub split-plan anthology.epub --output split-plan.json --json
node <skill-directory>/scripts/quillbind.mjs epub split anthology.epub --plan split-plan.json --output new-volumes --json
```

Set `QUILLBIND_VOCABULARY` to the current library's controlled vocabulary as described in [tags](tags.md). Planning is read-only. The plan records the source hash, vocabulary version/hash, source metadata, reading order, navigation, resource hashes, notes, and ordered content units. Preserve those inventory fields. Re-audit changed sources or vocabulary instead of editing hashes. A new plan has no guessed volumes.

Fill `volumes` in source order. Each entry has a unique lowercase filename `key`, inclusive `from`/`through` unit keys, `boundaryEvidence`, an ordered `navigation` array of `{unit, label}`, and independently selected `metadata`. Inspect the unit's actual source content; its short text preview is only an index. Include each selected chapter once in its original order. Every retained reading document needs a navigation entry, and each volume needs a useful complete contents list. The writer generates independent NAV/NCX instead of copying bundle navigation.

Cuts at document boundaries are supported. Within a shared XHTML file, cuts require reliable block/container anchors. Paragraphs, lists, tables and figures are indivisible; do not split a paragraph or table because a nested link looks like a boundary. Wrapping sections are pruned while selected blocks and text are preserved. Ancestor anchors stay with their original starting content, preventing a link to volume one's beginning from silently becoming a link to volume two.

Every source reading-order unit must appear in exactly one volume or in `omit` as `{unit, reason}`. Use explicit exclusions for bundle front matter, an old visible contents page or unselected volumes; preserve the original anthology. Do not hide missing chapters by inventing an exclusion reason. Unused semantic notes similarly need `omitNotes` entries `{key, reason}`. Review the source inventory and TOC for non-spine content; TOC chapters outside the reading order require an explicit preparatory repair.

## Select single-volume metadata

Supply these fields in each volume's `metadata`:

| Field | Decision |
| --- | --- |
| `identifier`, `title`, `language` | New stable `urn:uuid:…` identity distinct from the bundle/other outputs, actual volume title and content language/script. Reuse that identity on a retry of the same plan. |
| `creators` | Array of `{name, role}` with actual credits (`aut`, `trl`, `ill`, `edt`). Missing credits may remain an empty array with a reason in the evidence; never invent a name. |
| `description`, `publisher`, `date` | Volume-specific values or `null` when unavailable. Preserve description paragraphs and available date precision (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`). |
| `isbn`, `isbnEvidence` | Actively find the matched volume ISBN under [bibliography](bibliography.md). Supply a validated ISBN-13, normalizing ISBN-10 if needed. Record matching evidence, or attempted sources/reason when no reliable number is found and `isbn` is null. Never borrow the bundle's ISBN. |
| `tags` | Exact current-library labels supported by this volume; do not blindly copy anthology tags. |
| `series` | A [Series decision](series.md) object, or `null`. A genuine subseries/reading position needs its own evidence; marketing counts and nonfiction volumes do not establish story membership. |
| `cover` | `null`, or `{image, document, evidence}` selecting an original, retained cover-only XHTML page and its matching JPEG/PNG resource. A bundle cover is not automatically a volume cover. Complex or new cover adoption follows [covers](covers.md). |
| `evidence` | Nonempty array recording the matched sources, book locations and reasons supporting the field decisions, including unavailable fields. |

Use BOOK☆WALKER for light novels and manga and matched publisher/book sources for other types. No mandatory cross-verification or forced date shortening. Single-volume metadata is written directly into its EPUB. Bundle descriptions, ISBNs, Series, cover declarations, scores and unrelated application state are not inherited by default. The original book and its identifiers remain intact. This workflow creates EPUBs; unsupported ComicInfo ISBN work is still skipped in CBZ maintenance.

## Preserve dependencies and resolve links

The writer retains referenced images, CSS imports/URLs, fonts and supported passive SVG resources, with unchanged resource bytes. It removes unrelated resources from each new archive. Semantic footnotes/endnotes and resolved note references carry their necessary note blocks and valid returns. A shared note may be copied to each referencing volume; foreign return anchors become plain text while the valid return remains. The report distinguishes duplicated auxiliary notes from duplicated body chapters.

Ordinary links into an excluded or different volume need an exact `crossLinks` decision `{source, id, href, action: "unlink", evidence}`. Unlinking preserves visible wording and the link's ID as a span; it does not silently discard text. Note references cannot be unlinked to bypass missing notes. Untagged/ambiguous notes need semantic or structural preparation with evidence before retrying. Cross-volume links cannot be guessed from titles. No remote assets are downloaded during splitting.

Supported input is a passive, single-rendition EPUB 2 or 3 with resolved local resources, usable reading order and safe block boundaries. The version remains unchanged. DRM/signatures, font obfuscation tied to the old identity, scripts, responsive/embedded media, ambiguous IDs, XML base overrides, dynamic/escaped CSS resource references, inline/nested note targets and unsafe partial boundaries are refused with actionable evidence. Preserve the source and perform only the required preparation on a staged copy; do not work around a refusal by deleting content or skipping validators.

## Verify and deliver

All planned outputs are staged first. Delivery requires independent source-to-output unit coverage and order checks, text/resource readback, complete local links and note returns, actual EPUBCheck for each volume and sampled browser reading checks. A selected cover also passes whole-cover display checks. Review the screenshots and each volume's title, opening/ending, contents, notes and return behavior. Check that metadata identifies the volume and that missing/duplicate chapter lists are empty or exclusions are explicitly justified.

No volume is published before every volume passes. Existing output directories are refused. The reports retain the plan, coverage, source/output hashes, per-volume metadata, preserved resources and actual validator/render results. Failed runs retain diagnostics and do not claim delivered volumes. This is a verified reading-copy split, not a full new-publication or native-reader certification; use [quality](quality.md) for that separate contract.

Report each final EPUB path, identity and hash, original anthology path, covered/excluded units, note/link decisions and actual checks. Keep the original and other formats. Do not delete the anthology, import outputs into Calibre, or modify the library database, sidecar OPFs or cover files.
