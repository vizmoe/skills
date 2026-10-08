# Configuration, metadata and themes

`quillbind schema --json` emits JSON Schema 2020-12 from the Zod configuration schema. Unknown configuration fields are rejected. `schemaVersion` is `1`; `book`, `theme`, `chapters` and a fixed `build.epoch` are required. Optional settings include `direction`, `writingMode`, `cover`, author `styles`, licensed `fonts` and bibliography `references`.

Optional `conversion.target` selects Chinese conversion during build or preview: `simplified`, `traditional`, `china`, `taiwan` or `hongkong`. `build --to` overrides this setting. Conversions read saved responses offline by default; use `--online` to create or refresh the book-side lock. See [Chinese conversion](chinese-conversion.md) for the API, preserved content, language tags and reports.

`markdown.cjkEmphasis` accepts `auto` (default), `on` or `off`. Auto enables CJK-friendly emphasis and strikethrough for chapters with Chinese, Japanese or Korean script metadata; off retains strict CommonMark delimiter rules. See [Markdown semantics](markdown.md) for examples and exact format coverage.

`markdown.profile` is `quillbind` by default; `blog` accepts Astro-style `.md` chapters without explicit IDs or body H1s and uses GitHub heading slugs and chapter-relative Markdown images. `markdown.chapterMetadata.fields` selects from the fixed whitelist `author`, `date`, `source` (all by default); aliases `authors` and `pubDate` map to their canonical fields. Unknown Properties are omitted from publications and reports. `display` is `byline` by default, or `hidden` to retain selected fields only in the XHTML head. Use `fields: []` to ignore optional Properties. See [blog import](blog-markdown.md) for field types and limits.

Optional `navigation` groups the table of contents using chapter-path leaves and objects with `title` and `children`. Its leaves must contain every `chapters` entry exactly once, in the same order. Each group opens its first chapter, and article headings remain nested under their chapter. Omitting `navigation` keeps the flat chapter list.

The engine adds the clickable contents page, its top-level TOC entry and its `toc` landmark automatically; include only source chapters in `chapters` and `navigation`. `book.language` determines `Contents`, Simplified Chinese `目录`, or Traditional Chinese `目錄`, with explicit script subtags taking precedence over region defaults. Configured cover artwork is retained as the EPUB cover image and displayed on a separate first page before the contents. Set only `cover.path`; the image alternative text is generated as `Title — Author 1, Author 2` from the resolved book title and authors, in their declared order. Remove `cover.alt` from older configurations and resolve metadata again. Raster covers with a short edge below 1400 pixels produce a `COVER_RESOLUTION_LOW` preflight warning; 1400 pixels passes, and SVG is exempt. See [cover resolution guidance](images.md) for the report and preservation behavior. Contents headings are centered; nested entries retain indentation without numeric markers. See [generated navigation and cover structure](architecture.md).

The [metadata reference](../../../skills/quillbind/references/metadata.md) defines resolution and confirmation. Required bibliography is title, authors, description, language and tags. Language validation uses the Node/ICU BCP 47 parser with underscore rejection; the normative source is [RFC 5646](https://www.rfc-editor.org/rfc/rfc5646). ISBN validation requires 978/979 prefix and a valid ISBN-13 check digit, while edition confirmation remains a separate decision under [ISBN Agency guidance](https://www.isbn-international.org/).

`book.publication.isbn` is the sole publication-state input: Quillbind treats `null` as unpublished and a valid ISBN as published. This is a configuration convention. No separate status is stored in configuration or resolved metadata. An explicit `null` uses the persistent UUID and needs no ISBN decision; a supplied ISBN requires electronic-edition confirmation. Missing values, empty strings and invalid ISBNs fail validation. Existing configurations must remove `book.publication.status` and rerun metadata resolution.

`metadata/identity.json` persists the UUID. `sources.lock.json` binds metadata to configuration text, decisions and taxonomy version. `candidates.json` records discovery evidence; `decisions.json` records the user's electronic edition decision. Supplied values remain authoritative. Inference can suggest a first-chapter title or a controlled software subject; those suggestions never fill missing required fields automatically. After choosing a candidate, update `book.yaml`, retain the decision, and resolve again.

With `--online` and a valid non-null ISBN, the online provider queries [LoC digital collections](https://www.loc.gov/apis/json-and-yaml/requests/) by normalized ISBN and records conflicts. Null or invalid ISBNs do not trigger a lookup. This API is not the complete Library of Congress catalog. There is no fabricated universal ISBN API or automatic electronic-edition match. CI prohibits live lookup; normal build uses supplied and locked data. Provider failures are reported as metadata warnings and do not manufacture missing information.

`taxonomy/subjects.v1.yaml` defines twelve stable English identifiers. Every entry records its parent, LCC-inspired class basis, official source, aliases and deprecation state. These identifiers are Quillbind categories, not official LCC classification codes; the reference is the [LCC outline](https://www.loc.gov/aba/cataloging/classification/lcco/). New entries can be added compatibly. Deprecated entries must retain migration information, and the build rejects deprecated or unknown tags.

`styles/base/epub.css` controls reflow and semantic blocks. The two theme files add narrative indentation or technical paragraph spacing. The transform explicitly marks chapter openings and paragraphs after headings, scene separators and quotes. Body font, size, line height, colors and alignment remain controlled by readers, following [Apple's flowing-book guidance](https://help.apple.com/itc/booksassetguide/en.lproj/static.html) and [Kindle body defaults](https://kdp.amazon.com/en_US/help/topic/GH4DRT75GWWAGBTU). CSS lint parses selectors, declarations and values; raw author CSS cannot introduce script, network imports, hidden content or rigid body layout.

The complete generated field constraints are in [book.schema.json](book.schema.json); regenerate it with `quillbind schema --json` after changing `config.ts`.

| Field                                                      | Meaning and default                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `schemaVersion`                                            | Required literal `1`                                                                |
| `book.title`, `authors`, `description`, `language`, `tags` | Required metadata; empty unresolved values block publication                        |
| `book.publication.isbn`                                    | Required: `null` for UUID identity, or an electronic ISBN-13 requiring confirmation |
| `theme`                                                    | Required `literature` or `technical`, independent of tags                           |
| `chapters`                                                 | One or more ordered relative Markdown paths, no duplicate path                      |
| `direction`                                                | `ltr` default; `rtl` controls text direction                                        |
| `pageProgression`                                          | Optional `ltr`, `rtl` or `default` page turns; independent of text direction        |
| `writingMode`                                              | `horizontal-tb` default, or `vertical-rl`                                           |
| `cover`                                                    | Optional relative `path`; alternative text comes from the book title and authors    |
| `styles`                                                   | Optional relative author stylesheet paths, default empty                            |
| `fonts`                                                    | Optional relative `path`, CSS `family` and `license` declaration                    |
| `references`                                               | Optional bibliography entries with unique `id`, `text` and optional HTTPS `url`     |
| `build.epoch`                                              | Required integer Unix timestamp within ZIP's 1980–2107 range                        |
| `build.stripImageMetadata`                                 | Only `false` is accepted (default); image metadata is preserved                     |
| `build.optimizeImages`                                     | `true` default; verified lossless PNG compression; `false` preserves image bytes    |
| `qa.coverage`                                              | `full` default; explicit `stratified` samples extra reader modes for large books    |
| `qa.screenshots`                                           | `failures-and-samples` default; `all` keeps every matrix screenshot                 |

Resource paths stay inside the book directory and do not permit traversal. `metadata/identity.json` and `sources.lock.json` belong with the book sources. `dist/` is generated output. See the two executable examples for complete configurations.

There are no source-size or pixel quotas. [Image processing](images.md) describes format support, preservation and platform guidance. Existing configurations with `stripImageMetadata: true` must change it to `false` or omit it, then resolve metadata again. `pageProgression` optionally sets `ltr`, `rtl` or `default` page turns; when omitted it follows `vertical-rl` (right-to-left) or the horizontal text direction. Japanese vertical text normally uses `direction: ltr` for top-to-bottom lines and `pageProgression: rtl` for page turns. Chinese language values need an explicit `zh-Hans` or `zh-Hant` script for Apple Books. Vertical writing is applied to the document root, including navigation.

For light novels and manga, optional top-level `bookwalker` references a project-relative source lock. [BookWalker enrichment](../../../skills/quillbind/references/bookwalker.md) describes selection and offline resolution.
