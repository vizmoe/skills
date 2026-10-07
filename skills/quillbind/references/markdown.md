# Markdown formatting and images

CommonMark plus tables, footnotes, math and directives are implemented. Keep each fenced block, list and reference definition within its chapter. Cross-chapter links are chapter-relative; standard-profile image paths are book-root relative. For blog paths and note navigation, read [blog-markdown.md](blog-markdown.md). Raw HTML and task-list checkboxes are rejected.

## Text and figures

`markdown.cjkEmphasis` defaults to `auto`, which enables CJK-compatible emphasis and strikethrough for Chinese/Japanese/Korean chapter languages. This handles punctuation-adjacent text such as `**重点。**后文` without editing source characters. Use `on` for mixed-language chapters or `off` for strict CommonMark emphasis. Keep literal asterisks escaped or in code. Preserve authored characters while fixing parser configuration.

Headings retain formatted text in navigation labels; lists retain start numbers, nesting and tight/loose structure; table alignment markers apply to headers and cells. Images and links preserve titles. Quotes use an inherited-color border and spacing while retaining reader-controlled text settings. If formatting looks wrong, check for actual `<strong>`, `<em>`, `<del>` or `<blockquote>` in the EPUB first, then inspect styles and reader overrides. Verify affected chapters in font-change, large-text and dark-mode browser checks.

| Content       | Syntax                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Table caption | `::caption[Caption]` immediately before a table                                                                    |
| Ruby          | `:ruby[本]{reading="ほん"}`                                                                                        |
| Citation      | `:cite[reference-id]`; the ID is in `book.yaml` references                                                         |
| Bibliography  | `::bibliography`                                                                                                   |
| Figure        | `:::figure{src="assets/images/image.png" alt="Meaningful description"}` followed by caption text and closing `:::` |
| Note          | `:::admonition{title="Note"}` with block content and closing `:::`                                                 |
| Definition    | `:::definition{term="Term"}` with definition text and closing `:::`                                                |
| Poem          | `:::poem` with text and Markdown hard line breaks, then closing `:::`                                              |
| Page break    | `::pagebreak`; add `{id="p1" label="1"}` only for a real source page boundary                                      |
| Math          | Inline `$x^2$` or display `$$` blocks                                                                              |
| Code caption  | Fenced code info such as `typescript caption="Listing 1"`                                                          |

Information images need descriptive alt. A decorative Markdown image uses empty alt and title `"decorative"`. Fonts require a license declaration; use TrueType or OpenType. Keep text selectable, equations as MathML, tables semantic, and body fonts, sizes, line spacing and colors under reader control.

Use JPEG, PNG, GIF or passive SVG for the shared platform target. PNG uses lossless compression only when it reduces size and preserves exact image data and metadata. Set `build.optimizeImages: false` to preserve all image bytes. JPEG, GIF and SVG stay unchanged. Keep source image pixels and metadata; use the supported formats and report platform size warnings as delivery decisions. The engine has no source byte or pixel quota. Platform-size warnings remain visible for delivery decisions. Chinese language metadata must explicitly use `zh-Hans` or `zh-Hant`; Japanese vertical writing uses `writingMode: vertical-rl` and `direction: ltr` for top-to-bottom text, with `pageProgression: rtl` for right-to-left page turns. The page direction defaults to `rtl` for vertical-rl books; other books default to their text direction.

Use the examples in the repository for executable syntax. Resolve missing authors or intended ISBN through [metadata.md](metadata.md).
