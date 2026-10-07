import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { bodymatterItems, candidate, copyBook } from "./helpers.js";
import { openBook } from "../packages/core/src/config.js";
import { inspectBytes } from "../packages/core/src/validate.js";
import { json } from "../packages/core/src/json.js";
import { preflightBook } from "../packages/core/src/markdown.js";

const roots: string[] = [];
async function fixture(body: string, language = "en", cjkEmphasis?: string) {
  const root = await copyBook("technical");
  roots.push(root);
  const book = await openBook(root);
  await json(path.join(root, "book.yaml"), {
    ...book.config,
    book: { ...book.config.book, language },
    chapters: [book.config.chapters[0]],
    ...(cjkEmphasis ? { markdown: { cjkEmphasis } } : {}),
  });
  await fs.writeFile(
    path.join(root, book.config.chapters[0]),
    `---\nid: syntax\ntitle: Markdown styles\nlang: ${language}\n---\n\n# Markdown styles\n\n${body}\n`,
  );
  return root;
}
async function render(body: string, language = "en", cjkEmphasis?: string) {
  const root = await fixture(body, language, cjkEmphasis);
  const info = inspectBytes(await candidate(root), true);
  const chapter = bodymatterItems(info)[0];
  return {
    root,
    info,
    document: info.documents.get(chapter.path)!,
    html: info.entries.get(chapter.path)!.bytes.toString(),
  };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

it("keeps ordinary paragraphs after blockquotes in the normal indentation flow", async () => {
  const { html } = await render(
    "标题后首段。\n\n> 引用第一行。\n> 引用第二行。\n>\n> 引用第二段。\n>\n> > 嵌套引用。\n\n引用后第一段。\n\n引用后第二段。\n\n---\n\n分隔线后首段。",
    "zh-Hans",
  );
  expect(html).toContain('<p class="no-indent">标题后首段。</p>');
  expect(html).toContain("<p>引用后第一段。</p>");
  expect(html).toContain("<p>引用后第二段。</p>");
  expect(html).toContain('<p class="no-indent">分隔线后首段。</p>');
});

it.each([
  [
    "zh-Hans",
    "**最佳的软件是信息化软件。**人们继续学习。",
    "<strong>最佳的软件是信息化软件。</strong>人们继续学习。",
  ],
  ["zh-Hant", "前文**「重點」**後文", "前文<strong>「重點」</strong>後文"],
  [
    "ja",
    "**重要です。**次の文です。",
    "<strong>重要です。</strong>次の文です。",
  ],
  ["ko", "**중요하다(설명)**다음", "<strong>중요하다(설명)</strong>다음"],
  ["zh-Hans", "*强调。*后文", "<em>强调。</em>后文"],
  ["zh-Hans", "~~旧内容。~~新内容", "<del>旧内容。</del>新内容"],
])(
  "preserves CJK emphasis next to punctuation in %s: %s",
  async (language, source, expected) => {
    expect((await render(source, language)).html).toContain(expected);
  },
);

it("offers strict CommonMark emphasis and an explicit override for mixed-language books", async () => {
  const source = "**重点。**后文";
  expect((await render(source, "zh-Hans", "off")).html).toContain(source);
  expect((await render(source, "en")).html).toContain(source);
  expect((await render(source, "en", "on")).html).toContain(
    "<strong>重点。</strong>后文",
  );
});
it("preserves escaped delimiters, inline code, fenced code and entities", async () => {
  const { html } = await render(
    "\\*\\*字面。\\*\\*后文\n\n`**代码。**原样`\n\n```text\n**代码。**原样\n```\n\n&amp; &lt; \\*",
    "zh-Hans",
  );
  expect(html).not.toContain("<strong>");
  expect(html).toContain("<code>**代码。**原样</code>");
  expect(html).toContain("**字面。**后文");
  expect(html).toContain("&amp; &lt; *");
});
it("renders CommonMark emphasis variants, nesting, strike-through and line breaks", async () => {
  const { html } = await render(
    "*one* _two_ **three** __four__ ***five*** ~~six~~\n\nfirst  \nsecond\\\nthird\nsoft",
  );
  for (const expected of [
    "<em>one</em>",
    "<em>two</em>",
    "<strong>three</strong>",
    "<strong>four</strong>",
    "<em><strong>five</strong></em>",
    "<del>six</del>",
    "first<br/>second<br/>third\nsoft",
  ])
    expect(html).toContain(expected);
});
it("preserves formatting inside headings in navigation labels", async () => {
  const { info, html } = await render(
    "## **Strong** and *emphasis* with [a link](https://example.org) and `code`",
  );
  expect(html).toContain("<h2");
  const nav = info.manifest.find((item) => item.properties.includes("nav"))!;
  expect(info.entries.get(nav.path)!.bytes.toString()).toContain(
    "Strong and emphasis with a link and code</a>",
  );
});
it("retains GFM column alignments on headers and data cells", async () => {
  const { html } = await render(
    "::caption[Alignment]\n\n| Left | Center | Right | Default |\n| :--- | :---: | ---: | --- |\n| L | C | R | D |",
  );
  expect(html).toContain('<th scope="col" class="align-left">Left</th>');
  expect(html).toContain('<th scope="col" class="align-center">Center</th>');
  expect(html).toContain('<td class="align-right">R</td>');
  expect(html).toContain("<td>D</td>");
});
it("distinguishes tight and loose lists and retains ordered starts and nesting", async () => {
  const { document, html } = await render(
    "3. First\n4. Second\n   - Nested\n\n---\n\n- Loose first\n\n- Loose second",
  );
  const list = document.getElementsByTagName("ol")[0];
  expect(list.getAttribute("start")).toBe("3");
  expect(list.getElementsByTagName("p").length).toBe(0);
  expect(list.getElementsByTagName("ul").length).toBe(1);
  expect(html).toContain("<li><p>Loose first</p></li>");
});
it("preserves reference links, autolinks, images and their titles", async () => {
  const { html } = await render(
    '[Reference][site]\n\n[site]: https://example.org "Reference title"\n\n<https://example.org/path>\n\n![Diagram](assets/images/flow.svg "Diagram title")',
  );
  expect(html).toContain(
    '<a href="https://example.org" title="Reference title">Reference</a>',
  );
  expect(html).toContain(
    '<a href="https://example.org/path">https://example.org/path</a>',
  );
  expect(html).toContain('alt="Diagram" title="Diagram title"');
});
it("keeps nested quotes, footnotes, setext headings and indented code semantic", async () => {
  const { html } = await render(
    "Section\n---\n\n> Outer\n>\n> > Inner\n\nNote[^one].\n\n    indented code\n\n[^one]: A note.",
  );
  for (const expected of [
    '<h2 id="s-section">Section</h2>',
    "<blockquote><p>Outer</p><blockquote><p>Inner</p></blockquote></blockquote>",
    'epub:type="noteref"',
    'role="doc-footnote"',
    "<pre><code>",
  ])
    expect(html.replace(/>\n+</g, "><")).toContain(expected);
});
it.each([
  ["<div>raw HTML</div>", "RAW_HTML_FORBIDDEN"],
  ["- [x] task", "UNSUPPORTED_MARKDOWN"],
  ["| A |\n| --- |\n| B |", "TABLE_CAPTION"],
])(
  "reports unsupported or underspecified authoring instead of silently dropping it: %s",
  async (body, code) => {
    const result = await preflightBook(await fixture(body));
    expect(result.diagnostics.some((item) => item.code === code)).toBe(true);
  },
);
