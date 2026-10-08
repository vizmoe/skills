# Library-authoritative tag management

## Select the source of truth

Read the target library's classification rules and controlled vocabulary; for the source Calibre workspace the file is `reports/book-taxonomy/controlled-vocabulary.json`. The library is the label authority, not the write target. The current file-only workflow overrides historical instructions to update Calibre's database or sidecars. Historical batch reports, existing dirty tags and Quillbind's former taxonomy do not override the vocabulary. Never rerun historical scripts with fixed IDs or backups.

The bundled [vocabulary](tag-vocabulary.json) contains the source library's reusable classes, subclasses, aliases and classification rules, excluding its book assignments. It is a portable baseline when no current library file is available, not an override for a newer library vocabulary. Both the audit helper and publishing runtime use this same data and [loader](../scripts/tag-vocabulary.mjs). Select the current file for publishing commands with `QUILLBIND_VOCABULARY=/absolute/path/to/controlled-vocabulary.json`; `--vocabulary` selects it explicitly for the audit helper and takes precedence over that environment variable. A missing or invalid selected file fails; there is no silent fallback.

Keep the library's fixed majors, exact spelling, case and spaces, in `Major.Controlled Subclass` form. Reuse subclasses first. A genuine gap requires a reasoned definition and mapping in the library vocabulary under an existing major; report the gap until that change is within the user's scope. Do not invent a tag for one book or add/rename majors. The organization is inspired by the [LCC outline](https://www.loc.gov/catdir/cpso/lcco/), not an assignment of official call numbers.

Use [type-specific bibliography](bibliography.md): BookWalker is the special route for light novels and manga; other books use publisher official information and book contents. Inspect the actual work before assigning a genre. The LCC link only explains the vocabulary's structural background, not a bibliography lookup or authority to replace the library's labels.

Tags describe subject, discipline or an explicitly allowed work type. Exclude author names/nationalities, titles, series, publishers, source sites, file formats, marketing, ratings and processing states. Keep multiple supported classifications concise. `Language.English` describes English learning content, not every book written in English. Use native language metadata for language/script; preserve existing compatibility columns such as `#chinese_script` without turning them into Tags or converting the text.

Confirmed prose light novels include `Literature.Light Novel` plus independently supported genres. Manga uses `Literature.Manga`; art books require a supported `Arts.*` subject. Illustrations, nationality, author or series branding alone do not establish work type. For the source library's confirmed NO GAME NO LIFE prose volumes, its explicit policy requires `Literature.Light Novel` and `Literature.Fantasy`; record the verified volume and that policy in the decision evidence. The corresponding manga/art books require separate decisions.

## Audit and make a reviewable plan

Fix the target files and fields. Read tags from EPUB package `dc:subject` or CBZ `ComicInfo.xml` using the [format mappings](embedded-metadata.md), then make a JSON inventory with titles and tag arrays. Assign a stable positive integer `id` within this audit and retain its file path and source hash in the inventory; the ID does not need to be a Calibre book ID. An already supplied Calibre export can be reused as evidence, but does not replace file readback or authorize database writes.

Retain that file mapping and run the [standalone helper](../scripts/tags.mjs), which needs only Node.js and never opens a Calibre database or edits an ebook:

```sh
node <skill-directory>/scripts/tags.mjs audit \
  --input inventory.json --vocabulary /absolute/path/to/controlled-vocabulary.json \
  --output new-tag-audit.json
```

The input is an array such as `[{"id":1,"path":"/absolute/books/example.epub","title":"Example","tags":["Fantasy"]}]`; retain the actual source SHA-256 alongside `path`. Extra fields participate in the inventory file hash but are not interpreted or repeated in per-book proposals. Join report IDs back to the retained inventory to locate files. The helper normalizes recognized case/spacing variants, declared flat aliases and duplicates. It does not infer synonyms or genres from titles, authors, language or descriptions. Unknown values remain in `proposed` and `unresolved`, never disappear silently. An undeclared flat subclass is also unknown even if its name seems familiar.

For content decisions, inspect the actual work and the source selected for its book type. Supply a separate JSON array through `--decisions decisions.json`:

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

## Apply tags directly to the selected files

Skill maintenance and an audit request do not authorize ebook writes. When the task includes applying changes, use that existing authorization without an extra phase confirmation. Recheck report IDs against the retained file mapping, original tag values, vocabulary hash and source file hashes. Re-plan changed items instead of overwriting concurrent work.

1. Back up the selected files and stage edits separately. Follow [embedded metadata maintenance](embedded-metadata.md) for EPUB package `dc:subject` and CBZ root `ComicInfo.xml` (`Genre` in the stable 2.0 profile). Keep the full canonical labels. Unsupported writers remain explicit unresolved items.
2. Change only selected fields. Preserve title, contributors, series/order, identifiers/UUID, descriptions, language/script, covers, ratings, reading state, annotations and content during a tag-only edit.
3. Validate staged files, then install them at the requested output paths. For in-place replacement, recheck the original hash, retain the backup and atomically replace only the target file with the verified result.
4. Independently read each final file and compare its parsed tags with the accepted canonical set. Confirm the final SHA-256 matches the verified staged file. Leave Calibre's database, sidecar `metadata.opf` and `cover.jpg` untouched; no Calibre export, shutdown/reopen or whole-library backup is required for this workflow.

For changed CBZs, validate the supported ComicInfo schema and compare non-target XML fields and every other member's bytes, names and order; metadata edits never re-encode pages. For changed EPUBs, compare non-target OPF semantics and every non-OPF member's bytes, check CRC/structure, and run EPUBCheck on the changed files. Include the EPUB 3 modification timestamp as a planned housekeeping change. A missing/broken validator is incomplete verification. A separately selected PDF task needs its own writer, Info/XMP readback and page-preservation checks; the EPUB/CBZ procedure does not establish PDF support. For a Quillbind publication artifact, all [release gates](quality.md) still apply.

Deliver file paths, scoped counts, before/after tags and evidence, unresolved items, verified final hashes and backup location. Distinguish proposals, staged files, completed file writes and publication release. Do not claim that Calibre's displayed metadata was updated, or that the audit helper's JSON proves a file write.
