# Markdown semantics and reading styles

The engine uses [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/) with [GFM extensions](https://github.github.com/gfm/), math, footnotes and Quillbind directives. The publication policies below make this a documented subset and extension of Markdown, not a claim to accept every GFM document.

| Source feature                              | EPUB behavior                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| ATX and setext headings                     | Semantic headings and stable anchors; emphasis, links and code retain their text in navigation labels      |
| `**strong**`, `__strong__`                  | `<strong>` with explicit bold styling                                                                      |
| `*emphasis*`, `_emphasis_`, nested emphasis | `<em>` and nested semantic markup; font choice remains with the reader                                     |
| `~~deleted~~`                               | `<del>` with a visible line through the text                                                               |
| Escapes, character references, inline code  | Literal content remains literal; code is not processed as emphasis                                         |
| Fenced and indented code                    | Selectable, copyable code with preserved whitespace and monospace styling                                  |
| Soft and hard line breaks                   | A soft break remains whitespace; two trailing spaces or a backslash create `<br/>`                         |
| Ordered, unordered and nested lists         | Reading order, ordered starts, nesting, and tight versus loose paragraph structure are retained            |
| Block quotes and nested quotes              | `<blockquote>` with relative margins, padding and an inherited-color border on the reading-start edge      |
| GFM tables                                  | Header semantics and left/center/right column alignment are retained on headers and data cells             |
| Inline and reference links, URL autolinks   | HTTPS links and their optional titles are retained; local chapter/fragment links are resolved              |
| Inline and reference images                 | Alternative text and optional titles are retained; standalone images center, inline images follow the text |
| Footnotes and thematic breaks               | Linked notes with backlinks, and semantic `<hr/>` separators                                               |

Tables require an explicit `::caption[...]`. Each chapter requires frontmatter and an unskipped heading hierarchy. The default profile requires one matching H1; the [blog profile](blog-markdown.md) can supply it from the frontmatter title in memory. That guide documents Astro heading anchors, named and repeated footnotes, chapter links and the Properties whitelist. Raw HTML, MDX, task-list checkboxes, unknown directives, unclosed fences, and non-HTTPS external links are rejected explicitly. These are Quillbind authoring/security policies, not requirements imposed by CommonMark, Apple Books or Kindle. Underline, highlight and superscript Markdown shortcuts are not part of the supported dialect.

## CJK punctuation and emphasis

Strict CommonMark treats `**重点。**后文` as literal text because the punctuation and following character prevent the closing delimiter from matching. Changing fonts or CSS cannot fix a missing semantic element.

`markdown.cjkEmphasis` defaults to `auto`: chapters whose BCP 47 language resolves to Chinese, Japanese or Korean script use the pinned [CJK-friendly parsing extension](https://github.com/tats-u/markdown-cjk-friendly), including its GFM strikethrough extension. Set it to `on` for a mixed-language book that needs this behavior, or `off` for strict CommonMark emphasis rules. This is a named extension, not a change to the CommonMark specification.

```yaml
markdown:
  cjkEmphasis: auto
```

The extension changes delimiter recognition without rewriting source files, inserting spaces or zero-width characters, or processing code as emphasis. Escape literal punctuation or use inline code when the asterisks themselves belong in the published text. A deliberate reader override that removes all font weights or decorations can still suppress visual emphasis; the EPUB retains its semantic markup.

## Reader controls and quotation styling

The [Kindle text guide](https://kdp.amazon.com/en_US/help/topic/GH4DRT75GWWAGBTU) allows selected bold/italic emphasis and distinctive styling for special paragraphs while preserving default body settings. It recommends applying emphasis to text styling so it survives font changes. [Apple's font guidance](https://help.apple.com/itc/booksassetguide/en.lproj/itc75f516c09.html) likewise preserves reader scaling; its [font overview](https://help.apple.com/itc/booksassetguide/en.lproj/itc74d42b31e.html) calls for actual bold faces when embedding a font family.

Neither vendor prescribes a universal quote background or border. Quillbind uses a modest border and spacing as its editorial default, keeps quote text at the reader's text size and color, and removes body-style first-line indentation inside quotes, lists and asides. It does not force a quote font, italicize an entire quote, lock a background color, or use `!important` to fight reader settings. The border follows LTR, RTL and vertical writing.

Every paragraph inside a quote has zero first-line indentation, including later paragraphs and nested quotes. Soft line breaks remain within their paragraph; Markdown hard breaks create a new line without adding indentation. The quote's margin and padding inset the whole block. Once the quote ends, ordinary paragraphs resume the theme's normal indentation: `literature` uses two em for Chinese/Japanese and 1.5 em otherwise, while `technical` uses no first-line indentation. Only paragraphs immediately after headings or thematic breaks keep the existing no-indent exception.

Astro leaves Markdown presentation to the site stylesheet. Its [official blog starter](https://github.com/withastro/astro/blob/main/examples/blog/src/styles/global.css), [AstroPaper](https://github.com/satnaing/astro-paper/blob/main/src/styles/typography.css) and [Fuwari](https://github.com/saicaca/fuwari/blob/main/src/styles/markdown.css) distinguish quotation blocks through their own borders and spacing; the inspected styles do not introduce a special first paragraph after a quote. Quillbind follows that separation while retaining its book themes and reader controls. This is an editorial choice, not an Astro, Apple Books or Kindle requirement.

`tests/markdown.test.ts` checks source-to-EPUB semantics. `tests/visual/typography.spec.ts` checks both themes, writing directions, font substitutions, enlarged text, dark mode and grayscale in the browser. Browser checks simulate reading settings; they do not claim native Apple Books/Kindle device execution.

Sources checked: 2026-09-05.
