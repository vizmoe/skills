import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { bodymatterItems, candidate, copyBook } from "./helpers.js";
import { openBook } from "../packages/core/src/config.js";
import { preflightBook } from "../packages/core/src/markdown.js";
import {
  inspectBytes,
  validateInternal,
} from "../packages/core/src/validate.js";
import { attr, elements, NS } from "../packages/core/src/xml.js";
import { json } from "../packages/core/src/json.js";

const roots: string[] = [];
async function fixture(
  body: string,
  properties = "",
  settings: Record<string, unknown> = {},
) {
  const root = await copyBook("technical");
  roots.push(root);
  const { config } = await openBook(root);
  await json(path.join(root, "book.yaml"), {
    ...config,
    chapters: [config.chapters[0]],
    markdown: { ...config.markdown, profile: "blog", ...settings },
  });
  await fs.writeFile(
    path.join(root, config.chapters[0]),
    `---\ntitle: 博客文章\nlang: zh-Hans\n${properties}\n---\n\n${body}\n`,
  );
  return root;
}
async function render(root: string) {
  const bytes = await candidate(root);
  const info = inspectBytes(bytes, true);
  const entry = bodymatterItems(info)[0];
  return {
    bytes,
    info,
    document: info.documents.get(entry.path)!,
    html: info.entries.get(entry.path)!.bytes.toString(),
  };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

it("imports Astro frontmatter without a chapter id or duplicated H1, preserving the source", async () => {
  const root = await fixture(
    "正文。\n\n## 结论\n\n结束。",
    "author: Atlas Geographica\ndate: '2023-10-29'\nsource: https://read.pmthinking.com/p/67",
  );
  const { config } = await openBook(root);
  const original = await fs.readFile(path.join(root, config.chapters[0]));
  const first = await preflightBook(root);
  const second = await preflightBook(root);
  expect(first.status).toBe("pass");
  expect(first.documents[0].id).toBe(second.documents[0].id);
  const { document, bytes } = await render(root);
  expect(elements(document, "h1").map((h) => h.textContent)).toEqual([
    "博客文章",
  ]);
  expect(validateInternal(bytes).diagnostics).toEqual([]);
  expect(
    (await fs.readFile(path.join(root, config.chapters[0]))).equals(original),
  ).toBe(true);
});
it("publishes only whitelisted byline properties and keeps book-level identity intact", async () => {
  const root = await fixture(
    "正文。",
    "author: Atlas Geographica\ndate: '2023-10-29'\nsource: https://read.pmthinking.com/p/67\nlayout: DO_NOT_PUBLISH_LAYOUT\nprivate: DO_NOT_PUBLISH_PRIVATE\ndraft: true\ncustom:\n  command: DO_NOT_PUBLISH_COMMAND",
  );
  const preflight = await preflightBook(root);
  expect(JSON.stringify(preflight)).not.toContain("DO_NOT_PUBLISH");
  const { html, info, document } = await render(root);
  expect(html).toContain('class="chapter-meta"');
  expect(html).toContain("Atlas Geographica");
  expect(html).toContain('<time datetime="2023-10-29">2023-10-29</time>');
  const byline = elements(document, "p").find(
    (p) => attr(p, "class") === "chapter-meta",
  )!;
  expect(byline.textContent).toBe("Atlas Geographica · 2023-10-29");
  expect(elements(byline, "a")).toHaveLength(0);
  expect(attr(elements(elements(document, "h1")[0], "a")[0], "href")).toBe(
    "https://read.pmthinking.com/p/67",
  );
  const nav = info.documents.get(
    info.manifest.find((item) => item.properties.includes("nav"))!.path,
  )!;
  const chapterLinks = elements(nav, "a").filter(
    (a) => a.textContent === "博客文章",
  );
  expect(chapterLinks).toHaveLength(1);
  expect(attr(chapterLinks[0], "href")).toBe(
    bodymatterItems(info)[0].path.replace(/^EPUB\//, ""),
  );
  for (const entry of info.entries.values())
    expect(entry.bytes.toString()).not.toContain("DO_NOT_PUBLISH");
  expect(
    elements(info.packageDocument, "creator", NS.dc).map((e) => e.textContent),
  ).toEqual(["Quillbind Example Authors"]);
});
it("maps Astro pubDate/authors aliases and unwraps a quoted Markdown source link", async () => {
  const root = await fixture(
    "正文。",
    'authors: [Alice, Bob]\npubDate: 2023-10-29\nsource: "[原文](https://example.org/post)"',
  );
  const { html } = await render(root);
  expect(html).toContain("Alice");
  expect(html).toContain("Bob");
  expect(html).toContain("2023-10-29");
  expect(html).toContain('href="https://example.org/post"');
  expect(html).not.toContain("[原文]");
});
it("keeps chapter attribution out of quoted, listed and footnote H1 headings", async () => {
  const root = await fixture(
    "# 博客文章\n\n> # [引用标题](https://example.org/quoted)\n\n- # [列表标题](https://example.org/listed)\n\n说明[^note]。\n\n[^note]: # [脚注标题](https://example.org/note)\n",
    "author: Alice\ndate: 2025-05-15\nsource: https://example.org/post",
  );
  const { document, bytes } = await render(root);
  const headings = elements(document, "h1");
  expect(headings.map((heading) => heading.textContent)).toEqual([
    "博客文章",
    "引用标题",
    "列表标题",
    "脚注标题",
  ]);
  expect(
    headings.map((heading) =>
      elements(heading, "a").map((anchor) => attr(anchor, "href")),
    ),
  ).toEqual([
    ["https://example.org/post"],
    ["https://example.org/quoted"],
    ["https://example.org/listed"],
    ["https://example.org/note"],
  ]);
  expect(
    elements(document, "p")
      .filter((paragraph) => attr(paragraph, "class") === "chapter-meta")
      .map((paragraph) => paragraph.textContent),
  ).toEqual(["Alice · 2025-05-15"]);
  expect(validateInternal(bytes).diagnostics).toEqual([]);
});
it("allows narrowing the metadata whitelist and hiding the byline", async () => {
  const root = await fixture(
    "正文。",
    "author: OMIT_THIS_AUTHOR\ndate: '2023-10-29'\nsource: https://example.org/post",
    { chapterMetadata: { fields: ["source"], display: "hidden" } },
  );
  const preflight = await preflightBook(root);
  expect(JSON.stringify(preflight)).not.toContain("OMIT_THIS_AUTHOR");
  const { html } = await render(root);
  expect(html).not.toContain("OMIT_THIS_AUTHOR");
  expect(html).not.toContain("2023-10-29");
  expect(html).not.toContain('class="chapter-meta"');
  expect(html).toContain('name="dc.source" content="https://example.org/post"');
  expect(html).not.toContain('href="https://example.org/post"');
});
it.each([
  ["author: Alice\nsource: https://example.org/post", "Alice", true],
  ["date: 2025-05-15\nsource: https://example.org/post", "2025-05-15", true],
  ["source: https://example.org/post", undefined, true],
  ["author: Alice", "Alice", false],
  ["date: 2025-05-15", "2025-05-15", false],
  ["", undefined, false],
])(
  "omits missing byline fields without moving the source link: %s",
  async (properties, expected, linked) => {
    const { document, bytes } = await render(
      await fixture("正文。", properties),
    );
    const bylines = elements(document, "p").filter(
      (p) => attr(p, "class") === "chapter-meta",
    );
    expect(bylines.map((p) => p.textContent)).toEqual(
      expected ? [expected] : [],
    );
    const links = elements(elements(document, "h1")[0], "a");
    expect(links.map((a) => attr(a, "href"))).toEqual(
      linked ? ["https://example.org/post"] : [],
    );
    expect(validateInternal(bytes).diagnostics).toEqual([]);
  },
);
it.each([
  ["2025-5-15", "2025-05-15"],
  ["2025/5/15", "2025-05-15"],
  ["2025 年 5 月 15 日", "2025-05-15"],
  ["May 15, 2025", "2025-05-15"],
  ["Jul 08 2022", "2022-07-08"],
  ["2025-05-15T00:30:00+08:00", "2025-05-15"],
  ["2025-05-15T23:30:00-08:00", "2025-05-15"],
  ["2025-02-29", undefined],
  ["05/06/2025", undefined],
])(
  "formats the visible date while preserving the original metadata: %s",
  async (date, expected) => {
    const { document } = await render(
      await fixture("正文。", `author: Alice\ndate: '${date}'`),
    );
    const byline = elements(document, "p").find(
      (p) => attr(p, "class") === "chapter-meta",
    )!;
    expect(byline.textContent).toBe(expected ? `Alice · ${expected}` : "Alice");
    expect(
      elements(byline, "time").map((time) => attr(time, "datetime")),
    ).toEqual(expected ? [expected] : []);
    expect(
      attr(
        elements(document, "meta").find(
          (meta) => attr(meta, "name") === "dc.date",
        )!,
        "content",
      ),
    ).toBe(date);
  },
);
it("links formatted chapter titles without nesting existing hyperlinks", async () => {
  const { document, bytes } = await render(
    await fixture(
      "# **博客**[文章](https://example.org/old)\n\n正文。",
      "source: https://example.org/post",
    ),
  );
  const heading = elements(document, "h1")[0];
  const links = elements(heading, "a");
  expect(links.map((a) => attr(a, "href"))).toEqual([
    "https://example.org/post",
  ]);
  expect(elements(links[0], "a")).toHaveLength(0);
  expect(elements(heading, "strong")[0].textContent).toBe("博客");
  expect(validateInternal(bytes).diagnostics).toEqual([]);
});
it("keeps title footnotes separate from the original-article link", async () => {
  const root = await fixture(
    "# **博客文章[^title]**\n\n正文。\n\n[^title]: 标题注释。",
    "source: https://example.org/post",
  );
  const { config } = await openBook(root);
  const chapter = path.join(root, config.chapters[0]);
  await fs.writeFile(
    chapter,
    (await fs.readFile(chapter, "utf8")).replace(
      "title: 博客文章",
      "title: 博客文章1",
    ),
  );
  const { document, bytes } = await render(root);
  const heading = elements(document, "h1")[0];
  const links = elements(heading, "a");
  expect(links).toHaveLength(2);
  expect(attr(links[0], "href")).toBe("https://example.org/post");
  expect(attr(links[1], "role")).toBe("doc-noteref");
  expect(links.every((a) => elements(a, "a").length === 0)).toBe(true);
  expect(validateInternal(bytes).diagnostics).toEqual([]);
});
it("ignores unselected properties even when their values are not publishable", async () => {
  const root = await fixture(
    "正文。",
    "author: 42\ndate: [DO_NOT_PUBLISH]\nsource: javascript:alert(1)",
    { chapterMetadata: { fields: [] } },
  );
  const { html } = await render(root);
  expect(html).not.toContain('class="chapter-meta"');
  expect(html).not.toContain("DO_NOT_PUBLISH");
  expect(html).not.toContain("javascript:");
  expect(
    (await preflightBook(root)).documents[0].chapterMetadata,
  ).toBeUndefined();
});
it("does not allow book configuration to expand the property whitelist", async () => {
  const root = await fixture("正文。", "private: DO_NOT_PUBLISH", {
    chapterMetadata: { fields: ["private"] },
  });
  await expect(openBook(root)).rejects.toThrow();
});
it("matches Astro heading IDs for punctuation, formatted text, CJK, and repeated headings", async () => {
  const root = await fixture(
    "[one](#hello-world) [two](#hello-world-1) [中文](#中文标题)\n\n## Hello, **World**!\n\nFirst.\n\n## Hello, World!\n\nSecond.\n\n## 中文标题\n\n正文。",
  );
  const { bytes, document } = await render(root);
  expect(elements(document, "h2").map((h) => attr(h, "id"))).toEqual([
    "hello-world",
    "hello-world-1",
    "中文标题",
  ]);
  expect(validateInternal(bytes).diagnostics).toEqual([]);
});
it("does not consume a blog heading slug for an H1 supplied by its layout", async () => {
  const root = await fixture("[heading](#博客文章)\n\n## 博客文章\n\n正文。");
  const { bytes, document } = await render(root);
  expect(elements(document, "h2").map((h) => attr(h, "id"))).toEqual([
    "博客文章",
  ]);
  expect(validateInternal(bytes).diagnostics).toEqual([]);
});
it("keeps repeated named footnotes and rich definitions linked to every original reference", async () => {
  const root = await fixture(
    "第一次[^same]，第二次[^same]，中文注释[^中文]。\n\n[^same]: **粗体说明**与[链接](https://example.org)。\n\n    第二段。\n\n    - 列表项\n\n[^中文]: 中文定义。",
  );
  const { document, bytes } = await render(root);
  const refs = elements(document, "a").filter(
    (a) => attr(a, "epub:type") === "noteref",
  );
  expect(refs).toHaveLength(3);
  expect(attr(refs[0], "href")).toBe(attr(refs[1], "href"));
  expect(new Set(refs.map((r) => attr(r, "id"))).size).toBe(3);
  for (const ref of refs) {
    const note = elements(document).find(
      (n) => attr(n, "id") === attr(ref, "href").slice(1),
    )!;
    expect(
      elements(note, "a").some(
        (a) => attr(a, "href") === `#${attr(ref, "id")}`,
      ),
    ).toBe(true);
  }
  expect(validateInternal(bytes).diagnostics).toEqual([]);
});
it("keeps escaped footnote markers and code literal", async () => {
  const root = await fixture(
    "字面 \\[^missing]，`[^code]`，&#91;^entity]。\n\n```md\n[^fenced]\n```",
  );
  const { html } = await render(root);
  expect(html).toContain("[^missing]");
  expect(html).not.toContain('epub:type="noteref"');
});
it("resolves cross-chapter encoded anchors and isolates identical footnote labels by chapter", async () => {
  const root = await fixture(
    "[下一章](02-verification.md#%E7%BB%93%E8%AE%BA)\n\n第一章[^same]。\n\n[^same]: 第一章注释。",
  );
  const { config } = await openBook(root);
  await json(path.join(root, "book.yaml"), {
    ...config,
    chapters: [config.chapters[0], "chapters/02-verification.md"],
  });
  await fs.writeFile(
    path.join(root, "chapters/02-verification.md"),
    "---\ntitle: 第二章\nlang: zh-Hans\n---\n\n## 结论\n\n第二章[^same]。\n\n[^same]: 第二章注释。\n",
  );
  const { bytes, info } = await render(root);
  expect(validateInternal(bytes).diagnostics).toEqual([]);
  const notes = bodymatterItems(info).map((item) =>
    info.documents.get(item.path)!,
  );
  expect(elements(notes[0], "aside")[0].textContent).toContain("第一章注释");
  expect(elements(notes[1], "aside")[0].textContent).toContain("第二章注释");
});
it("resolves Astro chapter-relative inline and reference images", async () => {
  const root = await fixture(
    "![Diagram](./diagram.svg)\n\n![Reference][image]\n\n[image]: diagram.svg",
  );
  await fs.copyFile(
    path.join(root, "assets/images/flow.svg"),
    path.join(root, "chapters/diagram.svg"),
  );
  const { bytes, document } = await render(root);
  expect(elements(document, "img")).toHaveLength(2);
  expect(validateInternal(bytes).diagnostics).toEqual([]);
});
it("rejects conflicting aliases and does not turn a Markdown source link into YAML syntax", async () => {
  const conflict = await preflightBook(
    await fixture("正文。", "date: '2023-10-29'\npubDate: '2024-01-01'"),
  );
  expect(conflict.diagnostics.some((d) => d.code === "CHAPTER_PROPERTY")).toBe(
    true,
  );
  const malformed = await preflightBook(
    await fixture(
      "正文。",
      "source: [https://example.org](https://example.org)\nsecret: DO_NOT_INCLUDE_IN_ERROR",
    ),
  );
  expect(malformed.status).toBe("fail");
  expect(JSON.stringify(malformed)).not.toContain("DO_NOT_INCLUDE_IN_ERROR");
});
it("still rejects an undefined footnote", async () => {
  const result = await preflightBook(await fixture("正文[^missing]。"));
  expect(result.diagnostics.some((d) => d.code === "REFERENCE_MISSING")).toBe(
    true,
  );
});
it.each([
  "source: javascript:alert(1)",
  "source: file:///etc/passwd",
  "author: 42",
])("rejects malformed whitelisted properties: %s", async (properties) => {
  const result = await preflightBook(await fixture("正文。", properties));
  expect(result.status).toBe("fail");
});
