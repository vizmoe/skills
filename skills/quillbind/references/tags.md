# Library-authoritative tag management

## Select the source of truth

Read the target library's current organization instructions before classifying books. If they identify a controlled vocabulary, use that file; for the source Calibre workspace it is `reports/book-taxonomy/controlled-vocabulary.json`. Historical batch reports, existing dirty tags and Quillbind's former taxonomy do not override it. Never rerun historical scripts with fixed IDs or backups.

The bundled [vocabulary](tag-vocabulary.json) contains the source library's reusable classes, subclasses, aliases and classification rules, excluding its book assignments. It is a portable baseline when no current library file is available, not an override for a newer library vocabulary. Both the audit helper and publishing runtime use this same data and [loader](../scripts/tag-vocabulary.mjs). Select the current file for publishing commands with `QUILLBIND_VOCABULARY=/absolute/path/to/controlled-vocabulary.json`; `--vocabulary` selects it explicitly for the audit helper and takes precedence over that environment variable. A missing or invalid selected file fails; there is no silent fallback.

Keep the library's fixed majors, exact spelling, case and spaces, in `Major.Controlled Subclass` form. Reuse subclasses first. A genuine gap requires a reasoned definition and mapping in the library vocabulary under an existing major; report the gap until that change is within the user's scope. Do not invent a tag for one book or add/rename majors. The organization is inspired by the [LCC outline](https://www.loc.gov/catdir/cpso/lcco/), not an assignment of official call numbers.

Use the existing [BookWalker workflow](bookwalker.md) and publisher official pages for external classification and bibliography evidence; inspect book contents to confirm the edition and subject. Do not introduce another lookup provider for tag work. The LCC link only explains the vocabulary's structural background, not a bibliography lookup or authority to replace the library's labels.

Tags describe subject, discipline or an explicitly allowed work type. Exclude author names/nationalities, titles, series, publishers, source sites, file formats, marketing, ratings and processing states. Keep multiple supported classifications concise. `Language.English` describes English learning content, not every book written in English. Use native language metadata for language/script; preserve existing compatibility columns such as `#chinese_script` without turning them into Tags or converting the text.

Confirmed prose light novels include `Literature.Light Novel` plus independently supported genres. Manga uses `Literature.Manga`; art books require a supported `Arts.*` subject. Illustrations, nationality, author or series branding alone do not establish work type. For the source library's confirmed NO GAME NO LIFE prose volumes, its explicit policy requires `Literature.Light Novel` and `Literature.Fantasy`; record the verified volume and that policy in the decision evidence. The corresponding manga/art books require separate decisions.

## Audit and make a reviewable plan

First fix the target books and fields. Obtain a JSON inventory with stable Calibre IDs, titles and tag arrays, using the installed `calibredb list --help` and the [official CLI documentation](https://manual.calibre-ebook.com/generated/en/calibredb.html#list). For example, export only the caller's selected search to a new file outside the library:

```sh
calibredb list --with-library "/absolute/library/books" \
  --fields title,tags --search '<selected search expression>' --for-machine
```

The command prints JSON including IDs. Retain the inventory and run the [standalone helper](../scripts/tags.mjs), which needs only Node.js and never opens a Calibre database:

```sh
node <skill-directory>/scripts/tags.mjs audit \
  --input inventory.json --vocabulary /absolute/path/to/controlled-vocabulary.json \
  --output new-tag-audit.json
```

The input is an array such as `[{"id":1,"title":"Example","tags":["Fantasy"]}]`. Other exported fields are ignored and remain untouched. The helper normalizes recognized case/spacing variants, declared flat aliases and duplicates. It does not infer synonyms or genres from titles, authors, language or descriptions. Unknown values remain in `proposed` and `unresolved`, never disappear silently. An undeclared flat subclass is also unknown even if its name seems familiar.

For content decisions, inspect the actual work and edition-matched BookWalker records or publisher official pages. Supply a separate JSON array through `--decisions decisions.json`:

```json
[
  {
    "id": 1,
    "kind": "light-novel",
    "add": ["Literature.Fantasy"],
    "remove": ["简体中文"],
    "evidence": [
      "Record the exact volume, source URL and access date or book location supporting the work type and genre.",
      "Script is a language property under the current library policy."
    ]
  }
]
```

Replace the example with real evidence; it is not permission to classify an unrelated book. All decision IDs must occur in the scoped inventory. `kind` is optional and accepts `light-novel`, `manga` or `art-book`. It adds the required work-type tag when available and removes contradictory prose/comic type tags. Art books are not automatically assigned a particular Arts subclass. `add` accepts exact controlled tags; `remove` names exact original tags. Each decision requires nonempty evidence and conflicting decisions fail. Evidence is supplied by the caller: the helper records it but cannot verify whether a source supports the claim. Confirm every decision before treating its proposal as applicable.

The report binds the inventory, vocabulary and optional decisions to their paths and SHA-256 hashes, then records per-book `before`, `proposed`, additions, removals, reasons, evidence and unresolved findings. Exit 0 means the audit ran, including when `status` is `needs-review`; it does not mean every tag is correct or any write occurred. `reviewable` also requires semantic review. Malformed input returns a nonzero JSON error; `--output` refuses existing files, including symlinks. A report has `libraryWritten: false` and `publicationReady: false`.

## Use the same labels in EPUB authoring

Run `taxonomy list --json` or `taxonomy explain 'Literature.Light Novel' --json` through the publishing helper with the selected `QUILLBIND_VOCABULARY`. Put exact controlled labels in `book.tags`, then follow [metadata resolution](metadata.md). EPUB `dc:subject` values retain the full hierarchy. The vocabulary byte hash participates in the metadata lock, so any vocabulary change requires resolution again even if its version number was not bumped.

Old projects may contain `Technology.SoftwareEngineering` or `Technology.ComputerScience`. After checking their subject, migrate them explicitly to `Science.Software Engineering` or `Science.Computer Science`. Former tags such as `Literature.Poetry`, `Literature.Nonfiction`, `Technology.WebDevelopment`, `Technology.Engineering`, `History.AsianHistory` and `History.WorldHistory` have no exact controlled counterpart in the source vocabulary: review content or request a justified vocabulary extension. Do not silently map them to a broader category. The runtime rejects obsolete labels; the audit preserves them for review. Neither tool edits existing projects automatically.

BookWalker metadata enrichment does not classify or rewrite existing EPUB subjects. A tag-only repair must use the scoped metadata process below; do not run a full rebuild or unrelated repair merely to change tags.

## Apply only authorized library changes

Skill maintenance and an audit request do not authorize library writes. When the user's task includes applying changes, continue within that existing authorization; an additional confirmation is not required merely because the audit is complete. Recheck that the chosen IDs, original tag values, vocabulary hash and target file hashes still match. Re-plan changed items instead of overwriting concurrent work.

For the source library, follow its staging and synchronization rules:

1. Enumerate each selected book's formats and save the original fields and hashes. Stage changed copies outside the library. If the user selected only certain formats, retain that boundary and report excluded formats.
2. Before live writes, stop competing Calibre writers and preserve a uniquely named, verified snapshot of the entire library. Retain earlier backups. A database/OPF-only copy is not a full library backup.
3. Use the official Calibre API/CLI for the database, never direct SQL writes. Limit changes to Tags and the corresponding subject fields. Do not assume a database edit updates sidecars or embedded metadata. Broad metadata embedding can rewrite unrelated fields, so inspect and preserve them rather than blindly invoking it for a tag-only change.
4. Synchronize database Tags, sidecar `metadata.opf` subjects and all in-scope embedded format subjects. EPUB uses `dc:subject`; for PDFs check both Keywords and XMP subject. Different representations must carry the same tag set. Unsupported format writers remain explicit unresolved items, not claimed successes.
5. Preserve title, authors, series/order, identifiers/UUID, descriptions and paragraph breaks, language/script, covers, ratings, reading state, annotations, navigation and content unless separately authorized. The library's other cleanup policies do not expand a tags-only task. Keep evidence and processing status in external reports.
6. Let Calibre's sidecar export finish, close writing handles and independently read all three layers back from disk. Check language normalization and zero-rating nodes as possible collateral changes. If Calibre was running before the task, restore it and verify fields after reopening. On interruption inspect actual disk state before recovery; preserve user changes and original backups.

For changed EPUBs, compare non-target OPF semantics and every non-OPF ZIP member's bytes, check CRC and structure, and rerun EPUBCheck on the actual changed files. A missing/broken validator is incomplete verification. PDF tag edits require independent metadata readback and content/page preservation checks, with rendering coverage stated accurately. Verify database integrity and non-target differences; final installed hashes must equal verified staged hashes. For a Quillbind publication artifact, all [release gates](quality.md) still apply.

Deliver scoped counts, a readable report, per-book before/after and evidence, unresolved items, verified final hashes and backup location. Distinguish an audit proposal, staged files, actual synchronized writes and publication release. Do not claim native-reader rendering, whole-library synchronization or a verified write from the helper's JSON alone.
