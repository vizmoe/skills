# Maintain embedded book metadata

Write metadata directly into existing EPUB package OPFs and CBZ root `ComicInfo.xml` using sources from [bibliography by book type](bibliography.md). Never modify Calibre's database, sidecar `metadata.opf` or `cover.jpg`, and never record task logs inside `Notes`, `Summary` or OPF fields.

## Dedicated file-level metadata writers

| Field scope | Audit command | Apply command | Supported formats & guarantees |
| --- | --- | --- | --- |
| Controlled library tags ([tags.md](tags.md)) | `metadata tags-audit <file> [--decisions d.json] --output plan.json` | `metadata tags-apply <file> --plan plan.json --output out.<ext>` | `.epub` (`dc:subject` + refinement/link guards) & `.cbz` (`Genre` in XSD order). |
| Title, credits, publisher/imprint, date, synopsis, language & ISBN ([#epub-clean-bibliography-with-a-reviewed-plan](#epub-clean-bibliography-with-a-reviewed-plan)) | `metadata bibliography-audit <file> --output plan.json` | `metadata bibliography-clean <file> --plan plan.json --output out.<ext>` | `.epub` (EPUB 2/3 OPF + ISBN `dc:identifier`) & `.cbz` (`ComicInfo.xml` 2.0; skips ISBN / rejects `trl`/`pht` flattening). |
| Star & community scores ([#remove-score-metadata-completely](#remove-score-metadata-completely)) | `metadata ratings-audit <file> --output plan.json` | `metadata ratings-clean <file> --plan plan.json --output out.<ext>` | `.epub` (`calibre:rating` + reviewed `customScores`) & `.cbz` (`CommunityRating`; preserves `AgeRating`). |
| Story series & Arabic position ([series.md](series.md)) | `metadata series-audit <file> --output plan.json` | `metadata series-normalize <file> --plan plan.json --output out.<ext>` | `.epub` (`belongs-to-collection` / `calibre:series*`) & `.cbz` (`Series`, `Number`). |
| Official cover raster ([covers.md](covers.md)) | `metadata cover-audit <file> [--image img] --output plan.json` | `metadata cover-adopt <file> --image img --plan plan.json --output out.<ext>` | `.epub` & `.cbz` (lossless JXL reconstruction/verification, portrait/tablet/landscape render QA). |

### Shared archive, XML and installation invariants

| Invariant | Requirement |
| --- | --- |
| Scope & staging | Touch only user-selected fields; write to a new output path (`OUTPUT_EXISTS` blocks collisions). For an authorized in-place replacement, retain a uniquely named backup matching `sourceSha256`, verify the staged output, recheck the source hash, atomically replace the target, and run `scripts/delivery-audit.mjs audit`. |
| ZIP & XML safety | Parse XML with namespaces and external entity/network access disabled (never regex); reject path traversal, duplicate/case-colliding ZIP entries, signed/encrypted/multi-rendition EPUBs, and ambiguous `ComicInfo.xml` copies. Preserve every non-metadata archive member's bytes, order and compression method. |
| Housekeeping & validation | Keep EPUB 2 as `2.0` without adding EPUB 3 refinements; record one planned UTC `dcterms:modified` on changed EPUB 3 files; leave byte-identical files untouched. Validate every changed file with EPUBCheck or `xmllint --nonet` against `standards/comicinfo/ComicInfo-2.0.xsd`, reopen independently for semantic readback, and write `<output>.reports/metadata.json`. |

## Scripted EPUBs: preserve content during organization

| Operation class | Rule when `inspect` reports `interactive-content` or undeclared scripts |
| --- | --- |
| OPF-only metadata writes (`tags-apply`, `bibliography-clean`, `ratings-clean`, `series-normalize`, scoped OPF patch) & filename moves | Proceed normally without extra user permission or script execution. Treat JS/handlers as inert bytes: preserve XHTML, CSS, scripts, manifest, spine and script declarations byte-for-byte; report script interactions as not tested. Never delete scripts or add declarations to silence validator findings. |
| Content-changing operations (`repair`, `cover-adopt`, `split`, `convert`, `epub enrich`) | Respect each command's own support check (`repair-copy` supports eligible popup notes per [repair.md](repair.md)). If `epub enrich` rejects a scripted book during bibliography supplementation, apply the verified BookWalker lock through OPF-only `bibliography-clean` instead; if one operation in a batch is blocked, report the blocker and complete independent fields/files. |
| Explicit popup testing | Use [note checks](notes.md) (`epub check-notes`) only when interaction verification is requested. |

## Field mapping

| Selected field | CBZ root `ComicInfo.xml` (2.0 profile) | EPUB package metadata (2.0 / 3.0) |
| --- | --- | --- |
| Controlled library tags | Single `Genre` element, comma-separated canonical labels | One `dc:subject` per canonical label |
| Title & synopsis ([synopsis only](bibliography.md#describe-the-work-not-the-file)) | `Title`, `Summary` | `dc:title`, `dc:description` |
| Contributors | `Writer` (`aut`/`ant`), `Penciller` (`art`), `CoverArtist` (`ill`), `Editor` (`edt`); never flatten `trl`/`pht` into `Writer` (`COMICINFO_ROLE_UNSUPPORTED`) | `dc:creator` (`aut`) / `dc:contributor` with EPUB 3 `role` (`marc:relators`) or EPUB 2 `opf:role` |
| Series & position ([Arabic digits](series.md#arabic-series-positions-for-all-books)) | `Series`, `Number` (`Volume` and `Count` are distinct and untouched) | `belongs-to-collection` + `group-position` (EPUB 3) and/or `calibre:series` + `calibre:series_index` |
| Publisher & imprint | `Publisher`, `Imprint` | `dc:publisher` |
| Publication date | `Year`, optional `Month`, optional `Day` | `dc:date` retaining source precision |
| Language / script | `LanguageISO` (preserving `zh-Hans` / `zh-Hant` when edited) | `dc:language` |
| ISBN ([ISBN policy](bibliography.md#complete-isbns-where-supported)) | Unsupported in ComicInfo 2.0 (`COMICINFO_ISBN_UNSUPPORTED`; skip without inventing elements) | Additional `dc:identifier` per [ISBN identifiers](#isbn-identifiers); never alter `unique-identifier` |

## Remove score metadata completely

```sh
node <skill-directory>/scripts/quillbind.mjs metadata ratings-audit original.epub --output ratings.json --json
node <skill-directory>/scripts/quillbind.mjs metadata ratings-clean original.epub --plan ratings.json --output clean.epub --json
```

| Step | Requirement (`.epub` and `.cbz`) |
| --- | --- |
| Audit & classify | Automatically flags `calibre:rating`, rating-typed Calibre custom metadata, and ComicInfo `CommunityRating` (including zero/empty residue). Review opaque/candidate fields in `inventory`, classify each in `customScores` (`remove` or `retain` with `evidence`), and set `reviewed: true`. |
| Protected fields | Never erase `AgeRating`, prose opinions in `Review`/`Summary`, reading state or standard bibliography; never replace removed ratings with `0` or retailer scores. |
| Post-write check | Re-audit the output file to confirm zero recognized scores or unresolved score candidates remain. |

## Clean bibliography with a reviewed plan {#epub-clean-bibliography-with-a-reviewed-plan}

```sh
node <skill-directory>/scripts/quillbind.mjs metadata bibliography-audit original.epub --output bibliography.json --json
node <skill-directory>/scripts/quillbind.mjs metadata bibliography-clean original.epub --plan bibliography.json --output clean.epub --json
```

Both commands accept `.epub` and `.cbz` files. Keep `inventory` and `findings` unchanged, assign every finding `decision: "apply"` or `"retain"` with `evidence`, add optional source-backed `assignments`, and set `reviewed: true`:

```json
{ "field": "publisher", "value": "<publisher>", "evidence": "Matched edition page", "source": "edition.lock.json <digest>" }
```

| Category | Rules and diagnostics |
| --- | --- |
| Auto-proposed findings | Combined/role-suffixed/nationality-prefixed/placeholder/duplicate credits, title storefront/marketing/extension residue, placeholder/watermark publishers or imprints, `0101-01-01` or `-1` undefined dates, non-canonical date/language formats, HTML/watermark noise in descriptions, and hyphenated/ISBN-10/duplicate ISBNs. |
| Source-only findings (`proposed: null`) | Time-zone shifted or unrecognized dates, `und` languages, checksum-invalid ISBNs, primary-ID ISBNs, and CBZ credits containing unsupported `trl`/`pht` roles (`credit-unsupported-role`). Retain or supersede with an evidenced `assignment`. |
| Supported `assignments` | `title`, `publisher`, `imprint` (`.cbz`), `date` (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`), `description`, `language` (canonical BCP 47), `isbn` (`.epub` only; `.cbz` throws `COMICINFO_ISBN_UNSUPPORTED`) and `contributors` (`aut`, `trl`, `ill`, `edt`, `ant`, `art`, `pht`; `.cbz` throws `COMICINFO_ROLE_UNSUPPORTED` on `trl`/`pht`). Rejects duplicate or finding-conflicting assignments (`BIBLIOGRAPHY_CONFLICT`) and referenced credit splits (`BIBLIOGRAPHY_REFERENCE`). |

## CBZ: edit ComicInfo without processing pages

| Rule | Requirement |
| --- | --- |
| Location & schema | Require one root `ComicInfo.xml` in namespace-free ComicInfo 2.0 element sequence order (`standards/comicinfo/ComicInfo-2.0.xsd`); never invent `Tags`, `ISBN` or `Translator` elements in 2.0, and never downgrade/delete unrecognized 2.1 extensions silently. |
| Member preservation | Copy all image/archive entries (`JPEG`, `PNG`, `JXL`) byte-for-byte in original order and compression method; never run `manga package` or image codecs for a metadata edit. |
| Validation | Extract `ComicInfo.xml` from the staged CBZ and validate offline: |

```sh
xmllint --nonet --noout --schema /absolute/quillbind/standards/comicinfo/ComicInfo-2.0.xsd /absolute/staging/ComicInfo.xml
```

### ISBN identifiers

Recognize existing EPUB `dc:identifier` nodes as ISBNs when prefixed with `urn:isbn:`, carrying `opf:scheme="ISBN"`, refined by `onix:codelist5` `15` (ISBN-13) or `02` (ISBN-10), or carrying `03`/bare digits with a valid ISBN-10/13 checksum. Keep an already-matching normalized ISBN-13 node in place; otherwise update an evidenced wrong non-primary ISBN in place or append one normalized 13-digit node with an unused `id`:

```xml
<!-- EPUB 3 -->
<dc:identifier id="isbn">9780306406157</dc:identifier>
<meta refines="#isbn" property="identifier-type" scheme="onix:codelist5">15</meta>

<!-- EPUB 2 -->
<dc:identifier id="isbn" opf:scheme="ISBN">9780306406157</dc:identifier>
```

## Read back and report

Reopen delivered `.epub` / `.cbz` files independently to verify canonical field/tag equality, non-target metadata/member byte identity, validator pass and SHA-256 hashes, then validate the handoff report with `scripts/delivery-audit.mjs` ([quality.md](quality.md)). Format specifications: [ComicInfo 2.0 schema](https://anansi-project.github.io/docs/comicinfo/schemas/v2.0), [field documentation](https://anansi-project.github.io/docs/comicinfo/documentation), [2.1 draft](https://anansi-project.github.io/docs/comicinfo/schemas/v2.1), and EPUB 3.3 [subjects](https://www.w3.org/TR/epub-33/#sec-opf-dcsubject), [container](https://www.w3.org/TR/epub-33/#sec-container-metainf-container.xml) and [modified date](https://www.w3.org/TR/epub-33/#sec-metadata-last-modified).
