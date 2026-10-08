# Maintain embedded book metadata

Use this workflow to write metadata directly into existing EPUB packages and CBZ `ComicInfo.xml`. Choose sources with [bibliography by book type](bibliography.md): BookWalker for light novels/manga, publisher information and book contents for other types. It guides scoped file edits and verification; it does not add a generic runtime writer. `tags.mjs audit` only proposes labels, `epub enrich` has its own supplementation contract, and `manga package` makes a new image archive.

## Bind the plan to the book and selected fields

Follow [tag management](tags.md) for the current library vocabulary and work-type evidence. The library is a classification reference; do not write Calibre's database, sidecar `metadata.opf` or `cover.jpg`. Metadata maintenance does not require Calibre, an application restart, a database backup or three-layer synchronization. Store evidence and verification logs outside the ebook; do not add task records to `Notes`, `Summary` or OPF metadata.

Record file paths, selected fields, original archive and metadata hashes, vocabulary hash, per-field old/new values, evidence and expected final tags. A library ID is optional. Distinguish absent values, an intentional removal and unresolved facts. Resolve unknown labels before replacing a whole subject list; an audit's `proposed` array can still contain unknown values. An empty set requires an explicit clearing decision, not a failed lookup or missing input. Do not redefine the vocabulary from stale embedded tags.

Inspect every selected format before choosing a writer. Use a format-aware tool with demonstrated per-field control, or a task-scoped ZIP/XML patch on a new staged copy. Parse XML with namespaces and external entity/network access disabled; do not edit XML with regular expressions. Reject unsafe paths, duplicate/case-colliding entries, ambiguous metadata locations and unreadable/encrypted archives. Respect archive size limits. Preserve a uniquely named backup of each target before replacement; verify the staged copy before atomically replacing the requested file, after rechecking the source hash. For a requested new output, refuse destination collisions. If the available writer cannot preserve the required data, report that file as unresolved.

Only plan fields in the user's scope. A tag-only task leaves title, contributors, series, descriptions, identifiers, language, ratings and covers alone. Broader maintenance follows the current library's rules for the fields actually selected; it does not authorize text conversion, cover replacement, scan processing or reading-state cleanup.

## Field mapping

These mappings describe equivalent meanings, not permission to rewrite every field. The CBZ column uses Quillbind's stable ComicInfo 2.0 profile. EPUB edits retain the package's existing version and metadata conventions.

| Selected field | CBZ root `ComicInfo.xml` | EPUB package metadata |
| --- | --- | --- |
| Controlled library tags | `Genre`, comma-separated full labels | One `dc:subject` per full label |
| Title and description | `Title`, `Summary` | `dc:title`, `dc:description` |
| Contributors | Role-specific fields such as `Writer` and `Penciller` | `dc:creator` / `dc:contributor` and existing role refinements |
| Series and position | `Series`, `Number` | Existing collection metadata and position; preserve Calibre series compatibility fields when present |
| Publisher | `Publisher`, separately verified `Imprint` | `dc:publisher` |
| Publication date | Verified components in `Year`, `Month`, `Day` | `dc:date`, retaining known precision |
| Language/script | `LanguageISO` | `dc:language` |
| Identifiers, only when explicitly selected | No ISBN field in the 2.0 profile; report the limitation without inventing an element | Appropriate `dc:identifier`, preserving the publication's primary identity |

Keep description paragraphs and original contributor roles. Never flatten translators into authors because a format lacks a role field. `Number` is the book's series position; `Volume` has a different comic-series meaning and is not a substitute. Do not infer totals, dates, cover roles or reading direction from filenames. Use the [type-specific date policy](bibliography.md) without mandatory cross-verification; preserve available precision. ISBN is optional and does not block other metadata edits; preserve existing identifiers unless selected.

Preserve language/script during tag edits. When language is selected, use content-verified language tags and verify file readback; leave library compatibility columns untouched. The scan packager's base-language output is a separate contract, not a reason to truncate an existing `zh-Hans` or `zh-Hant` during maintenance. Scores and age classifications are distinct: authorized score cleanup can remove `CommunityRating` or OPF rating fields, but must not erase `AgeRating` as though it were a star score. Do not introduce zero-value score nodes to represent absence.

## CBZ: edit ComicInfo without processing pages

Locate exactly one root entry named `ComicInfo.xml`. Read the existing XML and its schema profile before patching. A missing file can be created only when embedded metadata writing is in scope and no competing nonstandard metadata copy creates ambiguity. Use a namespace-free `ComicInfo` root and insert only supported, verified fields in schema order. Malformed XML, duplicate fields, nested copies or case variants require an explicit repair decision; do not silently pick, rename or discard one. Other XML members are preserved as unrelated content.

For this library's controlled tags, use one `Genre` value such as `Literature.Manga, Literature.Fantasy`, after verifying both labels for the selected book. Preserve the full hierarchy and parse the comma-separated list back into the same canonical set. If a future vocabulary label contains a comma, flag the representation conflict instead of silently splitting it. This use of `Genre` is the library integration policy; it is not an official ComicInfo taxonomy.

ComicInfo 2.0 has no `Tags` element. Do not add it, or invent ISBN/translator elements, in a 2.0 document. Existing 2.1 draft fields, extensions or reader-specific tags require a documented compatible profile and validation before editing; preserve the source and report the limitation if that support is unavailable. Do not downgrade by deleting unrecognized metadata or leave conflicting tag representations while claiming synchronization.

Patch the selected XML nodes in place semantically. Retain unselected elements, attributes, comments, multiline text, `Pages` entries, bookmarks, dimensions, `PageCount` and `Manga` direction. Adding `Genre` must not rebuild the XML from a narrow bibliography object. A pre-existing page-count or direction inconsistency is a separate finding unless its correction is in scope.

Copy every other archive member unchanged, including existing JPEG/PNG/JXL bytes, cover pages, attachments and provenance. Preserve member names, relative paths, archive order, page order and stored/deflated methods. Keep other ZIP attributes when supported and report any unavoidable container-only differences. Do not run codecs, rename pages or use `manga package` to change metadata; its importer intentionally omits old metadata and has a different input contract.

Reopen the staged CBZ independently. Check ZIP CRCs, unique metadata location, XML validity and the applicable schema, then compare every non-target ComicInfo field and every other member's name/order/hash. Verify page mappings and tag-set equality. Validate 2.0 XML with a local schema and network access disabled; the runtime checkout supplies `standards/comicinfo/ComicInfo-2.0.xsd`:

```sh
xmllint --nonet --noout --schema /absolute/quillbind/standards/comicinfo/ComicInfo-2.0.xsd /absolute/staging/ComicInfo.xml
```

The XML passed to validation must be freshly extracted from the actual staged CBZ. Schema validity does not establish factual correctness, page preservation or reader support; retain those separate results. Metadata-only maintenance does not require image re-encoding or establish new lossless-codec evidence.

## EPUB: maintain the actual package metadata

Start with [EPUB inspection](inspection.md); full JSON includes the package path and metadata records with attributes/refinements. Resolve package paths through `META-INF/container.xml`, never assume `content.opf` or treat the library's sidecar `metadata.opf` as the embedded package. Inventory all declared rootfiles; an unsupported or ambiguous multi-rendition book remains unresolved rather than silently changing the first OPF.

Replace the selected subject set with one namespace-correct `dc:subject` per canonical label. Reuse unchanged nodes where possible. If removing/replacing a subject with an `id`, account for its `refines` links and attached authority/term metadata in the plan: do not leave dangling references or label the library's custom taxonomy as official LCC/BISAC. Unrelated refinements remain intact; an ambiguous reference blocks that edit until resolved.

Patch only approved metadata nodes. Preserve primary UUID/`unique-identifier`, other identifiers, creator roles, series/order, cover declarations and non-target custom metadata. Do not replace the primary identifier to repair an ISBN or disturb identifier-dependent font obfuscation. Signed or unsupported protected books require separate supported handling; do not strip protection or signatures to make an edit pass. Use the actual EPUB file as the write target, without a Calibre database or sidecar update.

Keep the existing EPUB version, manifest, spine, navigation, text, styles, fonts and images. For EPUB 3, record one UTC `dcterms:modified` value for the actual edit and include it as an expected housekeeping difference; publication date is separate. Reuse that planned timestamp for retries of the same edit, and leave an unchanged book alone. Do not add EPUB 3 metadata conventions to EPUB 2 as an incidental upgrade.

Reopen the staged archive, verify OCF packaging/CRC and all references, compare non-target OPF semantics, and require identical bytes for every non-OPF member. Run EPUBCheck on the changed file and record actual results, distinguishing pre-existing findings from new ones. A missing validator or failed launch is incomplete verification. Do not repair unrelated source warnings to make a tag edit look successful. Native-reader rendering remains unverified unless actually tested.

For edition-matched bibliography supplementation, [BookWalker enrichment](bookwalker.md#supplement-an-existing-epub) already preserves non-OPF resources and runs all release gates. It does not rewrite subjects, and its deliberate original-date update makes it inappropriate for tag-only edits. It also does not replace a general field-specific maintenance plan. Any result claimed as a Quillbind publication must still satisfy every [release gate](quality.md).

## Read back and report

Reopen the delivered EPUB or CBZ independently and compare each selected field with the plan, including the accepted canonical tag set. Parse the format's subject representation while retaining exact spelling, hierarchy and spaces. XML serialization alone is insufficient. If a format is unsupported or excluded, report the actual completed files and unresolved items.

Final file hashes must match the verified staged copies. Report file paths, old/new fields, sources, metadata location/profile, integrity checks, validator results and backup location. Distinguish a plan, verified staging, completed file writes and a publication release. Calibre's database and displayed records are not updated by this workflow and are not part of its acceptance checks.

Format references checked 2026-10-08: [ComicInfo 2.0 schema](https://anansi-project.github.io/docs/comicinfo/schemas/v2.0), [field documentation](https://anansi-project.github.io/docs/comicinfo/documentation), [2.1 draft status](https://anansi-project.github.io/docs/comicinfo/schemas/v2.1), and EPUB [subjects](https://www.w3.org/TR/epub-33/#sec-opf-dcsubject), [container](https://www.w3.org/TR/epub-33/#sec-container-metainf-container.xml) and [modified date](https://www.w3.org/TR/epub-33/#sec-metadata-last-modified). These are format specifications, not additional book lookup providers.
