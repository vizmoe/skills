# Metadata for authored publications

For existing ebook metadata, use [bibliography by book type](bibliography.md) and [direct file maintenance](embedded-metadata.md). General supplementation actively completes ISBNs from supported evidence while preserving existing values when no supported replacement is available. Dates do not require cross-verification, and Calibre's database/sidecars are never write targets. The project resolution below serves new authored publications; do not impose its ISBN decision file or LoC lookup on existing-file edits.

Tags follow the current Calibre library's controlled vocabulary. Use [tag management](tags.md) for vocabulary selection, type-specific evidence, cleanup and migration of old Quillbind IDs. The publishing runtime and tag audit share the bundled vocabulary; set `QUILLBIND_VOCABULARY` to the current library file when supplied. Use canonical labels including spaces in `book.tags`; runtime resolution rejects unknown IDs rather than guessing replacements.

Resolve `title`, `authors`, `description`, BCP 47 `language`, and controlled English `tags` with `metadata resolve <book-directory> --json` through the skill helper before preview or release. Source preparation reports metadata readiness separately from preflight and release readiness; a metadata pass does not establish publication readiness. `authors` is the responsibility field in new-book configuration; [BookWalker locks](bookwalker.md) additionally carry declared contributor roles. Preserve all existing contributors in reading repair, publication repair and EPUB conversion.

Use `book.publication.isbn` as the sole publication-state input. In Quillbind's configuration convention, `null` means unpublished and uses the UUID persisted in `metadata/identity.json`; a valid ISBN means published and requires the electronic-edition decision below. An explicit `null` needs no additional confirmation. Empty strings and invalid ISBNs are errors. Remove the obsolete `book.publication.status` from older configurations, then resolve metadata again.

Normal resolution is offline. With a valid non-null ISBN, `--online` queries the multi-provider public catalog pipeline (`openbd`, `ndl`, `cinii`, `loc` SRU MODS 3.8 with MARC-880 vernacular CJK fields, `openlibrary`, and `google-books` when `GOOGLE_BOOKS_API_KEY` is configured), routed by language and ISBN prefix (`978-4` / `ja` → openBD + NDL + CiNii + LoC; `978-7` / `978-957` / `978-986` / `978-988` / `zh*` → LoC + NDL + CiNii + Open Library; `978-0` / `978-1` / `en` → LoC + Open Library) and records normalized candidates; null or invalid ISBNs skip lookup. Catalog search results are discovery evidence, not proof of an electronic edition. Prefer confirmed publisher or library records supplied by the user, and use publicly documented APIs rather than inventing endpoints.

Candidate files record value, provider, URL, record ID, retrieval time, match evidence, confidence, conflicts and approval. Do not overwrite supplied book metadata with a different author or edition. Present missing values and relevant candidates together. After the user's decision, update `book.yaml` and rerun resolution.

For a supplied ISBN, require confirmation that it belongs to the electronic edition. Record that exact decision with the normalized ISBN digits in `metadata/decisions.json`:

```json
{ "isbn": { "value": "9780306406157", "edition": "epub", "approved": true } }
```

The number above demonstrates the data shape only; it must not be assigned to an unrelated book.

Only write `approved: true` after actual user authorization or an explicit supplied edition decision. Never create an ISBN. See [ISBN Agency guidance](https://www.isbn-international.org/).

Keep `metadata/candidates.json`, `metadata/sources.lock.json`, `metadata/decisions.json`, and `metadata/identity.json` with the source book. Changing `book.yaml`, decisions, a configured BookWalker source lock or the taxonomy version invalidates the metadata lock; rerun resolution. Chinese conversion uses a separate response lock described in [conversion](conversion.md). The build epoch controls EPUB modification and ZIP timestamps; keep it stable for identical builds.
