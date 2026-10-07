import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { bodymatterItems, candidate, copyBook } from "./helpers.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { convertChineseContent } from "../packages/core/src/chinese-conversion.js";
import { ZhconvertSession } from "../packages/core/src/zhconvert.js";
import { pack } from "../packages/core/src/zip.js";
import {
  NS,
  attr,
  elements,
  serialize,
  xml,
} from "../packages/core/src/xml.js";
import { validateInternal } from "../packages/core/src/validate.js";
import { run } from "../packages/core/src/process.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { openBook } from "../packages/core/src/config.js";
import { recordedZhconvert } from "./zhconvert-fixture.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

it("converts Markdown output, navigation, display metadata and accessibility text while preserving protected content", async () => {
  const root = await copyBook();
  temporary.push(root);
  const original = await candidate(root);
  const info = inspectBytes(original);
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  const chapter = bodymatterItems(info)[0].path;
  const doc = info.documents.get(chapter)!;
  const sample = xml(`<div xmlns="${NS.xhtml}">
    <p id="简体锚点">简体书 <em>测试</em> <a href="#简体锚点" title="简体书">简体书</a></p>
    <p aria-label="简体书"><img src="../images/简体.png" alt="简体书"/></p>
    <pre><code>const 简体 = "简体书";</code></pre><p><code>简体书</code></p>
    <p translate="no">简体书</p><p lang="ja">简体书</p><p xml:lang="en">简体书 <span lang="zh">简体书</span></p>
    <p><a href="https://example.org/简体">https://example.org/简体</a></p>
    <math xmlns="${NS.math}"><mtext>简体书</mtext></math>
    <p><![CDATA[简体书 <标签>]]></p>
  </div>`).documentElement!;
  elements(doc, "body", NS.xhtml)[0].appendChild(doc.importNode(sample, true));
  entries.set(chapter, Buffer.from(serialize(doc)));
  const opf = info.packageDocument;
  elements(opf, "title", NS.dc)[0].textContent = "简体书";
  elements(opf, "creator", NS.dc)[0].textContent = "测试作者";
  const identifier = elements(opf, "identifier", NS.dc)[0].textContent;
  const meta = opf.createElementNS(NS.opf, "meta");
  meta.setAttribute("property", "custom:source");
  meta.textContent = "简体书";
  elements(opf, "metadata", NS.opf)[0].appendChild(meta);
  entries.set(info.packagePath, Buffer.from(serialize(opf)));
  const bytes = pack(entries, 946684800);
  const fetcher = recordedZhconvert();
  const session = new ZhconvertSession({ target: "traditional", fetcher });
  const converted = await convertChineseContent(bytes, session);
  const output = inspectBytes(converted.bytes, true);
  expect(output.title).toBe("簡體書");
  expect(output.language).toBe("zh-Hant");
  expect(
    elements(output.packageDocument, "creator", NS.dc)[0].textContent,
  ).toBe("測試作者");
  expect(
    elements(output.packageDocument, "identifier", NS.dc)[0].textContent,
  ).toBe(identifier);
  expect(
    elements(output.packageDocument, "meta", NS.opf).find(
      (element) => attr(element, "property") === "custom:source",
    )?.textContent,
  ).toBe("简体书");
  const result = output.entries.get(chapter)!.bytes.toString();
  expect(result).toContain('id="简体锚点">簡體書');
  expect(result).toContain('href="#简体锚点" title="簡體書">簡體書');
  expect(result).toContain('aria-label="簡體書"');
  expect(result).toContain('src="../images/简体.png" alt="簡體書"');
  expect(result).toContain('const 简体 = "简体书";');
  expect(result).toContain("<code>简体书</code>");
  expect(result).toContain('translate="no">简体书');
  expect(result).toContain('lang="ja">简体书');
  expect(result).toContain('xml:lang="en">简体书 <span lang="zh-Hant">簡體書');
  expect(result).toContain(
    'href="https://example.org/简体">https://example.org/简体',
  );
  expect(result).toContain("<mtext>简体书</mtext>");
  expect(result).toContain("簡體書 &lt;标签&gt;");
  expect(output.entries.get("EPUB/contents.xhtml")!.bytes.toString()).toContain(
    "目錄",
  );
  expect(output.entries.get("EPUB/nav.xhtml")!.bytes.toString()).toContain(
    "目錄",
  );
  for (const [file, entry] of info.entries)
    if (!info.documents.has(file) && file !== info.packagePath)
      expect(output.entries.get(file)!.bytes.equals(entry.bytes)).toBe(true);
  expect(output.spine).toEqual(info.spine);
  const requests = fetcher.mock.calls.length;
  session.freeze();
  expect(
    (await convertChineseContent(bytes, session)).bytes.equals(converted.bytes),
  ).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(requests);
  expect(await fs.readFile(path.join(root, "book.yaml"), "utf8")).toContain(
    "山间来信",
  );
});

it("produces internally valid EPUB and converts NCX labels without changing targets", async () => {
  const root = await copyBook();
  temporary.push(root);
  const info = inspectBytes(await candidate(root));
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="zh"><docTitle><text>简体书</text></docTitle><navMap><navPoint id="简体"><navLabel><text>简体书</text></navLabel><content src="chapters/简体.xhtml#简体"/></navPoint></navMap></ncx>`;
  entries.set("EPUB/toc.ncx", Buffer.from(ncx));
  const item = info.packageDocument.createElementNS(NS.opf, "item");
  item.setAttribute("id", "ncx");
  item.setAttribute("href", "toc.ncx");
  item.setAttribute("media-type", "application/x-dtbncx+xml");
  elements(info.packageDocument, "manifest", NS.opf)[0].appendChild(item);
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  const result = await convertChineseContent(
    pack(entries, 946684800),
    new ZhconvertSession({
      target: "traditional",
      fetcher: recordedZhconvert(),
    }),
  );
  const convertedNcx = inspectBytes(result.bytes)
    .entries.get("EPUB/toc.ncx")!
    .bytes.toString();
  expect(convertedNcx).toContain("<text>簡體書</text>");
  expect(convertedNcx).toContain('src="chapters/简体.xhtml#简体"');
  const valid = await convertChineseContent(
    await candidate(root),
    new ZhconvertSession({
      target: "traditional",
      fetcher: recordedZhconvert(),
    }),
  );
  expect(validateInternal(valid.bytes)).toEqual({
    status: "pass",
    diagnostics: [],
  });
});

it("accepts config targets and rejects missing or unsupported CLI targets before reading input", async () => {
  const root = await copyBook();
  temporary.push(root);
  await fs.appendFile(
    path.join(root, "book.yaml"),
    "\nconversion:\n  target: taiwan\n",
  );
  expect((await openBook(root)).config.conversion).toEqual({
    target: "taiwan",
  });
  for (const [args, code] of [
    [["build", "/missing", "--to", "invalid"], "CONVERSION_TARGET"],
    [
      ["epub", "convert", "/missing", "--output", "/unused"],
      "ARGUMENT_REQUIRED",
    ],
    [
      ["epub", "convert", "/missing", "--to", "traditional"],
      "ARGUMENT_REQUIRED",
    ],
  ] as const) {
    const result = await run(process.execPath, [
      "--import",
      "tsx",
      path.join(repoRoot, "packages/cli/src/index.ts"),
      ...args,
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe(code);
    expect(result.stderr).toBe("");
  }
});
