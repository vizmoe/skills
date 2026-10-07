# Authoring

`Book = Directory`, `Chapter = One Markdown Document`. `book.yaml` controls chapter order and metadata. Parse chapters independently; keep each fenced block, list and reference definition within its chapter. The default `quillbind` profile requires one H1 matching the frontmatter `title`, then H2 and deeper headings without skipping levels. Its chapter frontmatter includes a stable ASCII `id`, `title`, and optional `lang`. For Astro/blog `.md` files, read [blog-markdown.md](blog-markdown.md).

```yaml
schemaVersion: 1
book:
  title: A Book
  authors: [An Author]
  description: A confirmed description of this book.
  language: en
  publication:
    isbn: null
  tags: [Literature.Essays]
theme: literature
chapters: [chapters/01-introduction.md]
build:
  epoch: 946684800
  stripImageMetadata: false
  optimizeImages: true
```

Use `quillbind schema --json` for additional settings, and `taxonomy explain <id> --json` for controlled classifications. Themes express layout intent independently of tags.

## Prepare a project from local sources

When the metadata and chapter order are known, write the config above to a separate plan file and prepare the project with one command:

```sh
node <skill-directory>/scripts/quillbind.mjs init <new-book-directory> --from <raw-source-directory> --config <plan.yaml> --json
```

`--config` accepts the same complete schema as `book.yaml`; chapter and asset paths are relative to `--from`. Select `markdown.profile: blog` for Astro `.md` files. Preserve the supplied chapter order explicitly. Store the new project outside the raw source directory.

Write the plan as UTF-8 YAML using the example, and let `init` validate it against the CLI schema. The helper uses Node built-ins; the CLI validates YAML.

The command checks the config and chapters, copies only the declared chapters and referenced local images, cover, styles and fonts with byte preservation, resolves available metadata, and writes `metadata/preparation.json`. That report lists copied paths, sizes and SHA-256 values, readiness, metadata and preflight diagnostics, and the next CLI arguments. Its scope is the declared local Markdown and assets; website execution and remote downloads are outside preparation. Missing or escaping resources abort preparation without leaving a partial book.

Prepare the local `.md` files and assets before import. Chapters need initial YAML frontmatter with a title, and local image references need real files. For raw text that needs adaptation, create separate Markdown working copies while preserving the supplied originals. Keep raw HTML, MDX and unsupported source conversions outside this engine's format claims. Use the user-supplied book title, authors, language, description and controlled tags; chapter Properties do not establish book-level bibliography. Ask only for missing facts or edition decisions that block publication, grouped together.

With no sources yet, plain `init <directory>` creates an empty-book skeleton. Its `readiness.sourceContent: placeholder` and `requiredFields` are a work list: replace the sample chapter with actual content, set its title/language, and fill book metadata before building. With an existing configured project, use metadata resolution/preflight directly rather than initializing it again.

For text syntax and formatting diagnosis, read [markdown.md](markdown.md).

## Grouped table of contents

For year/month or other nested groups, keep `chapters` in reading order and add optional `navigation`. Each leaf is a chapter path; each group has `title` and `children`. Leaves must include every chapter exactly once in the same order as `chapters`. Group links open their first chapter, and chapter headings remain nested beneath each article. This changes navigation without merging Markdown files or losing chapter Properties.

The engine supplies a clickable contents page before the chapters, a top-level TOC entry and a `toc` landmark. Supply only source chapters; a separate Markdown contents chapter would duplicate it. `book.language` selects `Contents`, `目录` (`zh-Hans`) or `目錄` (`zh-Hant`); explicit scripts take precedence over region defaults. Configured cover artwork appears on a separate first page before the contents and remains a `cover-image` resource. Set only `cover.path`; the engine generates the image alternative text from the book title and ordered authors as `Title — Author 1, Author 2`. The cover has its own TOC and landmark entries; the contents heading is centered, and list numbering is hidden while nesting remains. For raster covers, preflight emits `COVER_RESOLUTION_LOW` when the short edge is below 1400 pixels, including the source path and actual dimensions. Relay the warning and continue the authorized build with the original image; suggest a higher-resolution original when available. SVG covers are exempt from this pixel threshold.

```yaml
chapters: [posts/2020-01.md, posts/2020-02.md]
navigation:
  - title: 2020 年
    children:
      - title: 1 月
        children: [posts/2020-01.md]
      - title: 2 月
        children: [posts/2020-02.md]
```

## Iterate and release

Run `metadata resolve` and `preflight` on the prepared project. Use `preview <book-directory> --json` for a single render to `dist/preview/candidate.epub`; its result is `status: preview`, `publicationReady: false`, with release gates `not-run`. Preview preserves existing release artifacts and reports. When the author is ready, `build` performs the complete release workflow described in [quality.md](quality.md).
