import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildBook } from "../packages/core/src/pipeline.js";
import { candidate } from "../tests/helpers.js";
import { runQa } from "../packages/core/src/qa.js";
import {
  validateInternal,
  inspectBytes,
} from "../packages/core/src/validate.js";
import { pack } from "../packages/core/src/zip.js";
import { json } from "../packages/core/src/json.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { fail } from "../packages/core/src/errors.js";
const fixtures = [
  {
    id: "english",
    language: "en",
    title: "A Reading Test",
    theme: "literature",
    direction: "ltr",
    writingMode: "horizontal-tb",
    body: "A paragraph with **emphasis** and a [local link](#detail).\n\n## Detail {#detail}\n\nA second paragraph with a short sentence.",
  },
  {
    id: "rtl",
    language: "ar",
    title: "كتاب الاختبار",
    theme: "literature",
    direction: "rtl",
    writingMode: "horizontal-tb",
    body: "هذا نص عربي لاختبار ترتيب القراءة واتجاه الحروف.\n\n## مثال\n\nيتضمن النص كلمة `TypeScript` مع علامات الترقيم.",
  },
  {
    id: "vertical",
    language: "ja",
    title: "縦書きの本",
    theme: "literature",
    direction: "ltr",
    writingMode: "vertical-rl",
    body: 'これは縦書きの表示を確認するための文章です。\n\n## 読み方\n\n: ruby\n\n:ruby[本]{reading="ほん"} を読む。 EPUB と日本語の組み合わせを確認します。',
  },
  {
    id: "lossless-images",
    language: "en",
    title: "Lossless Image Publication",
    theme: "technical",
    direction: "ltr",
    writingMode: "horizontal-tb",
    body: "A full-resolution color swatch with original pixels.\n\n![Blue-green color swatch](large.png)\n\nInline ![Marker](large.png) follows the text size.",
  },
  {
    id: "typography",
    language: "zh-Hans",
    title: "语义与排版",
    theme: "literature",
    direction: "ltr",
    writingMode: "horizontal-tb",
    body: "**关键结论。**随后解释。*特别强调。*继续。~~旧观点。~~新观点。\n\n## **带强调的标题**\n\n> 引用原文，保留 **重要信息**，用边线与留白区分。\n>\n> > 嵌套引用。\n\n3. 第一项\n4. 第二项\n\n::caption[对齐检查]\n\n| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| 甲 | 乙 | 42 |\n\n`**字面代码。**` 保持原样。",
  },
  {
    id: "blog",
    language: "zh-Hans",
    title: "博客章节与脚注",
    theme: "literature",
    direction: "ltr",
    writingMode: "horizontal-tb",
    body: "第一处引用[^same]，并可跳到[结论](#结论)。\n\n第二处引用[^same]。\n\n## 结论\n\n正文 **重要信息。**继续。\n\n[^same]: **多次引用的脚注**。\n\n    第二段，以及[外部出处](https://example.org/note)。",
  },
  {
    id: "long-content",
    language: "en",
    title: "Long Content",
    theme: "technical",
    direction: "ltr",
    writingMode: "horizontal-tb",
    body:
      "Code remains copyable on a narrow screen.\n\n```text\n" +
      "a_very_long_identifier_".repeat(18) +
      "\n```\n\n::caption[Wide semantic data]\n\n| First field | Second field | Third field | Fourth field | Fifth field |\n| --- | --- | --- | --- | --- |\n| A long value | A second value | A third value | A fourth value | A fifth value |",
  },
];
const results = [];
for (const fixture of fixtures) {
  const directory = path.join(repoRoot, ".cache/qa-fixtures", fixture.id);
  await fs.mkdir(path.join(directory, "chapters"), { recursive: true });
  await json(path.join(directory, "book.yaml"), {
    schemaVersion: 1,
    book: {
      title: fixture.title,
      authors: ["Quillbind Fixtures"],
      description: "Original automated layout fixture.",
      language: fixture.language,
      publication: { isbn: null },
      tags: ["Literature.Essays"],
    },
    theme: fixture.theme,
    direction: fixture.direction,
    writingMode: fixture.writingMode,
    markdown: { profile: fixture.id === "blog" ? "blog" : "quillbind" },
    chapters: ["chapters/01.md"],
    build: { epoch: 946684800 },
  });
  await fs.writeFile(
    path.join(directory, "chapters/01.md"),
    fixture.id === "blog"
      ? `---\ntitle: ${fixture.title}\nlang: ${fixture.language}\nauthors: [示例作者, 第二位作者]\npubDate: 2023-10-29\nsource: https://example.org/post\nprivate: DO_NOT_PUBLISH\nlayout: DO_NOT_PUBLISH\n---\n\n${fixture.body}\n`
      : `---\nid: fixture\ntitle: ${fixture.title}\nlang: ${fixture.language}\n---\n\n# ${fixture.title}\n\n${fixture.body}\n`,
  );
  if (fixture.id === "lossless-images") {
    await sharp({
      create: { width: 3400, height: 3400, channels: 4, background: "#427788" },
    })
      .png({ compressionLevel: 0 })
      .toFile(path.join(directory, "large.png"));
  }
  if (
    ["lossless-images", "vertical", "typography", "blog"].includes(fixture.id)
  ) {
    const build = await buildBook(directory);
    if (fixture.id === "blog") {
      const output = inspectBytes(
        await fs.readFile(path.join(directory, "dist/book.epub")),
      );
      const preflight = await fs.readFile(
        path.join(directory, "dist/reports/preflight.json"),
        "utf8",
      );
      if (
        preflight.includes("DO_NOT_PUBLISH") ||
        [...output.entries.values()].some((entry) =>
          entry.bytes.toString().includes("DO_NOT_PUBLISH"),
        )
      )
        fail(
          "QA_PROPERTY_LEAK",
          "Non-whitelisted blog properties reached publication output",
        );
    }
    await fs.cp(
      path.join(directory, "dist/reports"),
      path.join(repoRoot, "dist/qa-fixtures", fixture.id),
      { recursive: true },
    );
    results.push({
      fixture: fixture.id,
      status: build.status,
      diagnostics: build.gates.apple.diagnostics,
    });
    continue;
  }
  const bytes = await candidate(directory);
  const file = path.join(directory, "fixture.epub");
  await fs.writeFile(file, bytes);
  const report = await runQa(file, {
    reports: path.join(repoRoot, "dist/qa-fixtures", fixture.id),
  });
  results.push({
    fixture: fixture.id,
    status: report.status,
    diagnostics: report.diagnostics,
  });
}
const base = await fs.readFile(
  path.join(repoRoot, "examples/technical/dist/book.epub"),
);
const info = inspectBytes(base);
const baseline = new Map(
  [...info.entries].map(([name, entry]) => [name, entry.bytes]),
);
const negativeCases = [
  {
    id: "fixed-height",
    change: (entries: Map<string, Buffer>) =>
      entries.set(
        "EPUB/styles/base.css",
        Buffer.from("p {height:1px;overflow:hidden}"),
      ),
  },
  {
    id: "remote-css",
    change: (entries: Map<string, Buffer>) =>
      entries.set(
        "EPUB/styles/base.css",
        Buffer.from('@import "https://example.org/track";'),
      ),
  },
  {
    id: "broken-image",
    change: (entries: Map<string, Buffer>) =>
      entries.delete([...entries.keys()].find((k) => k.endsWith(".svg"))!),
  },
  {
    id: "broken-toc",
    change: (entries: Map<string, Buffer>) =>
      entries.set(
        "EPUB/nav.xhtml",
        Buffer.from(
          entries
            .get("EPUB/nav.xhtml")!
            .toString()
            .replace("text/0001-contracts.xhtml", "text/missing.xhtml"),
        ),
      ),
  },
];
for (const item of negativeCases) {
  const entries = new Map(baseline);
  item.change(entries);
  const report = validateInternal(pack(entries, 946684800));
  results.push({
    fixture: item.id,
    status: report.status === "fail" ? "pass" : "fail",
    diagnostics: report.diagnostics,
  });
}
const invisible = new Map(baseline);
invisible.set(
  "EPUB/styles/base.css",
  Buffer.concat([
    invisible.get("EPUB/styles/base.css")!,
    Buffer.from("\np { transform: scale(0); }\n"),
  ]),
);
const invisibleBytes = pack(invisible, 946684800);
if (validateInternal(invisibleBytes).status !== "pass")
  fail(
    "QA_FIXTURE_SETUP",
    "Invisible fixture must reach the browser geometry checks",
  );
const invisibleFile = path.join(repoRoot, ".cache/qa-fixtures/invisible.epub");
await fs.writeFile(invisibleFile, invisibleBytes);
const invisibleReport = await runQa(invisibleFile, {
  reports: path.join(repoRoot, "dist/qa-fixtures/invisible"),
});
results.push({
  fixture: "invisible-browser-geometry",
  status:
    invisibleReport.status === "fail" &&
    invisibleReport.diagnostics.some((d) => d.code === "QA_HIDDEN")
      ? "pass"
      : "fail",
  diagnostics: invisibleReport.diagnostics,
});
await json(path.join(repoRoot, "dist/qa-fixtures/results.json"), results);
if (results.some((r) => r.status !== "pass"))
  fail("QA_FIXTURE_FAILED", "Layout fixture regression", results);
console.log(
  "Internationalization, long-content and negative QA fixtures passed.",
);
