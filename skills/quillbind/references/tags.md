# Library-authoritative tag management

## Select the source of truth

| Source / input | Role and precedence | Verification |
| --- | --- | --- |
| Explicit `--vocabulary <path>` | Highest precedence for `scripts/tags.mjs` and `metadata tags-audit` / `tags-apply` (e.g., `reports/book-taxonomy/controlled-vocabulary.json`). Fails with `TAXONOMY_INVALID` or `ENOENT` if missing/invalid; never falls back silently. | [scripts/tag-vocabulary.mjs](../scripts/tag-vocabulary.mjs) |
| `QUILLBIND_VOCABULARY` env var | Used when `--vocabulary` is omitted across tag audits, file writers and publishing commands. | SHA-256 bound in audit/tag plans and metadata locks |
| Bundled [tag-vocabulary.json](tag-vocabulary.json) | Portable `Major.Controlled Subclass` baseline when no external library file is supplied; never overrides a newer supplied library vocabulary. | Validated by `loadVocabulary()` |
| Calibre database / sidecars / historical scripts | Read-only label reference at most; never open `metadata.db`, never write `metadata.opf` or `cover.jpg`, and never rerun historical fixed-ID scripts. | `scripts/delivery-audit.mjs` |

### Label formation and exclusions

| Rule area | Requirement | Forbidden in tags |
| --- | --- | --- |
| Structure | Exact `Major.Controlled Subclass` spelling, case and ASCII spaces under fixed LCC-inspired majors ([LCC outline](https://www.loc.gov/catdir/cpso/lcco/) is structural background only, not call numbers or lookup authority). | Invented one-off tags, added/renamed majors, or comma-containing subclasses (`TAXONOMY_INVALID`). |
| Semantic scope | Subject, discipline or an explicitly allowed work type supported by inspecting the work and its [type-specific bibliography](bibliography.md). | Author names, nationalities, book/series titles, publishers, source sites, file formats, marketing, ratings, reading states or script labels (`简体中文`, `#chinese_script`). |
| Language vs subject | `Language.English` denotes English-learning material only; store actual book language/script in `dc:language` / `LanguageISO`. | Tagging every English-written book with `Language.English`. |
| Vocabulary gaps & legacy IDs | Migrate `Technology.SoftwareEngineering` → `Science.Software Engineering` and `Technology.ComputerScience` → `Science.Computer Science` after checking content; report unmapped legacy labels (`Literature.Poetry`, `Literature.Nonfiction`, `Technology.WebDevelopment`, `Technology.Engineering`, `History.AsianHistory`, `History.WorldHistory`) as `UNKNOWN_TAG` / `VOCABULARY_GAP`. | Silent mapping to a broader parent class. |

## Work-type tag rules

Parsed directly by [scripts/skill-rules.mjs](../scripts/skill-rules.mjs), [scripts/tags.mjs](../scripts/tags.mjs) and `metadata tags-audit` / `tags-apply`:

| Work kind | Required tag | Forbidden tags | Required prefix | Evidence rule |
| --- | --- | --- | --- | --- |
| `light-novel` | `Literature.Light Novel` | `Literature.Manga` | - | Confirmed prose light novel from BookWalker/publisher and book text; add supported genres (e.g., source library policy requires `Literature.Light Novel` + `Literature.Fantasy` on confirmed prose NO GAME NO LIFE volumes). |
| `manga` | `Literature.Manga` | `Literature.Light Novel` | - | Confirmed comic/manga edition; adaptations are classified separately from prose originals. |
| `art-book` | - | `Literature.Light Novel`, `Literature.Manga` | `Arts.` | Confirmed illustration/art collection; caller must supply at least one verified `Arts.*` tag (`ART_SUBJECT_REQUIRED` otherwise). |

## Audit an inventory or apply tags to files

### Multi-book JSON inventory audit (standalone Node.js)

```sh
node <skill-directory>/scripts/tags.mjs audit \
  --input inventory.json --vocabulary /absolute/path/to/controlled-vocabulary.json \
  --decisions decisions.json --output new-tag-audit.json
```

| Artifact / option | Shape and contract |
| --- | --- |
| `inventory.json` | Array of `{"id": 1, "path": "/abs/book.epub", "sha256": "<hex>", "title": "Example", "tags": ["Fantasy"]}` with unique positive integer IDs. Normalizes case/spacing, `flat_to_hierarchical` aliases and duplicates; preserves unknown tags in `proposed` and `unresolved`. |
| `decisions.json` | Optional array of `{"id": 1, "kind": "light-novel", "add": ["Literature.Fantasy"], "remove": ["简体中文"], "evidence": ["..."]}`. Every ID must exist in `inventory.json`, `add` must be canonical, `remove` must match an exact original tag, and `evidence` must be non-empty. |
| Output report | Binds input/vocabulary/decision SHA-256 digests; `status` is `reviewable` or `needs-review` (exit `0` means the audit ran, never that a file was written; `libraryWritten: false`, `publicationReady: false`). Refuses existing `--output` paths (`OUTPUT_EXISTS`). |

### Direct EPUB / CBZ file tag maintenance

```sh
node <skill-directory>/scripts/quillbind.mjs metadata tags-audit book.epub --decisions tag-decision.json --output tags-plan.json --json
node <skill-directory>/scripts/quillbind.mjs metadata tags-apply book.epub --plan tags-plan.json --output tagged.epub --json
```

| Stage / diagnostic | Behavior across `.epub` and `.cbz` |
| --- | --- |
| `tags-audit` | Reads embedded EPUB `dc:subject` (via `META-INF/container.xml`, including `id`, `refines` and external references) or CBZ root `ComicInfo.xml` `Genre`, binds source/metadata/vocabulary SHA-256, and evaluates `decision` (`kind`, `add`, `remove`, `clearEvidence`, `evidence`). |
| Review & refinements | Set `reviewed: true` after checking `before`, `proposed` and `unresolved`. Removing/replacing an EPUB `dc:subject` with attached `meta[refines]` requires an explicit `refinementDecisions` entry (`action: "drop-refinements"` + `evidence`, `TAGS_REFINEMENT`); external links/spine references block removal (`TAGS_REFERENCE`). |
| `tags-apply` | Rejects unresolved tags (`TAGS_UNRESOLVED`), stale source/vocabulary hashes (`METADATA_STALE`, `TAGS_VOCABULARY_STALE`), or edited inventories (`TAGS_INVENTORY`). Writes namespace-clean `dc:subject` (preserving EPUB 2 vs EPUB 3) or ComicInfo 2.0 `Genre` in exact XSD sequence order, preserves all non-target metadata and archive member bytes, runs EPUBCheck or `xmllint --nonet`, and verifies independent readback (`METADATA_READBACK`). |
| Authoring (`book.yaml`) | Inspect labels via `taxonomy list --json` or `taxonomy explain '<tag>' --json` through `scripts/quillbind.mjs`, place canonical labels in `book.tags`, and run [metadata resolution](metadata.md). |
