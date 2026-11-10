import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectEdition,
  decodePage,
  readEditionLock,
  resolveEdition,
} from "../packages/core/src/edition.js";
import type {
  NovelFetcher,
  NovelResponse,
} from "../packages/core/src/novel-http.js";
import { stable } from "../packages/core/src/json.js";
import { run } from "../packages/core/src/process.js";
import { repoRoot } from "../packages/core/src/runtime.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-edition-"));
  temporary.push(root);
  return root;
}
/** ISBN-13 with a computed check digit, so fixtures never borrow a real book's number. */
function isbn(prefix: string) {
  const sum = [...prefix].reduce(
    (total, d, i) => total + Number(d) * (i % 2 ? 3 : 1),
    0,
  );
  return prefix + ((10 - (sum % 10)) % 10);
}
const tables = new Map<string, Map<string, Buffer>>();
/** Encode through the platform decoder's own table, avoiding an extra dependency. */
function encode(text: string, label: string) {
  let table = tables.get(label);
  if (!table) {
    table = new Map();
    const decoder = new TextDecoder(label);
    for (let a = 0x81; a <= 0xfe; a++)
      for (let b = 0x40; b <= 0xfe; b++) {
        const bytes = Buffer.from([a, b]);
        const char = decoder.decode(bytes);
        if ([...char].length === 1 && char !== "\ufffd" && !table.has(char))
          table.set(char, bytes);
      }
    tables.set(label, table);
  }
  return Buffer.concat(
    [...text].map((char) =>
      char.charCodeAt(0) < 0x80
        ? Buffer.from(char)
        : (table.get(char) ?? Buffer.from("?")),
    ),
  );
}
const evidence = [
  "Title, author and edition verified against the copyright page.",
];
const printIsbn = isbn("978000000001");
const ebookIsbn = isbn("978000000002");
const otherIsbn = isbn("978000000003");

const publisherPage = `<!doctype html><html><head>
<title>The Quiet Harbor | Example Press</title>
<meta property="og:title" content="The Quiet Harbor | Example Press">
<meta property="og:site_name" content="Example Press">
<meta property="og:description" content="A lighthouse keeper's daughter returns...">
<link rel="canonical" href="/books/quiet-harbor">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"Organization","name":"Example Press"},
 {"@type":"Book","name":"The Quiet Harbor","author":[{"@type":"Person","name":"Mara Quill"}],
  "translator":{"@type":"Person","name":"Ines Ward"},
  "publisher":{"@type":"Organization","name":"Example Press"},
  "datePublished":"2021-03-09","inLanguage":"en",
  "description":"<p>A lighthouse keeper's daughter returns home.</p><p>Second paragraph &amp; more.</p>",
  "isPartOf":{"@type":"BookSeries","name":"Harbor Novels","position":"第二卷"},
  "workExample":[
   {"@type":"Book","bookFormat":"https://schema.org/Hardcover","isbn":"${printIsbn.slice(0, 3)}-${printIsbn.slice(3)}"},
   {"@type":"Book","bookFormat":"https://schema.org/EBook","isbn":"${ebookIsbn}"}]}
]}</script>
<script type="application/ld+json">{"@type":"Review","datePublished":"2099-01-01","author":"Critic"}</script>
<script type="application/ld+json">{not json</script>
</head><body>
<nav>ISBN: ${otherIsbn}</nav>
<main><h1>The Quiet Harbor</h1><p>Publication date: March 9, 2021</p></main>
<div class="related-books"><dl><dt>ISBN</dt><dd>${otherIsbn}</dd><dt>Author</dt><dd>Someone Else</dd></dl></div>
<footer>Publisher: Wrong Press</footer>
</body></html>`;

const doubanPage = `<html><head><meta charset="utf-8"><title>解忧杂货店 (豆瓣)</title>
<script type="application/ld+json">{"@context":"http://schema.org","@type":"Book","name":"解忧杂货店","author":[{"@type":"Person","name":"[日] 东野圭吾"}],"isbn":"${isbn("978754420001")}"}</script>
</head><body><div id="wrapper"><h1><span property="v:itemreviewed">解忧杂货店</span></h1>
<div class="subject clearfix"><div id="info">
<span>
  <span class="pl"> 作者</span>:
    <a href="/author/1">[日] 东野圭吾</a>
</span><br/>
<span class="pl">出版社:</span>
  <a href="/press/1">南海出版公司</a>
<br>
<span class="pl">原作名:</span> ナミヤ雑貨店の奇蹟<br/>
<span><span class="pl"> 译者</span>: <a href="/search">李盈春</a></span><br/>
<span class="pl">出版年:</span> 2014-5<br/>
<span class="pl">丛书:</span>&nbsp;<a href="/series/1">新经典文库·东野圭吾作品</a><br/>
<span class="pl">ISBN:</span> ${isbn("978754420001")}<br/>
</div></div>
<div class="related_info"><h2><span>内容简介</span>&nbsp;&nbsp;·&nbsp;·&nbsp;·</h2>
<div class="indent" id="link-report"><span class="short"><div class="intro"><p>现代人内心流失的东西……</p></div><a>(展开全部)</a></span>
<span class="all hidden"><div class="intro"><p>现代人内心流失的东西，这家杂货店能帮你找回。</p><p>僻静的街道旁有一家杂货店。</p></div></span></div>
<div id="comments"><span class="pl">ISBN:</span> ${otherIsbn}</div>
</div></div></body></html>`;

const taiwanPage = `<html><head><meta charset="big5"><title>挪威的森林 - 博客來</title>
<meta property="og:description" content="這是一段被截斷的介紹…"></head><body>
<div class="type02_p003"><ul>
<li>作者： <a>村上春樹</a></li>
<li>原文作者：<a>Haruki Murakami</a></li>
<li>譯者： <a>賴明珠</a></li>
<li>出版社：<a>時報出版</a></li>
<li>出版日期：2003/03/01</li>
<li>語言：繁體中文</li>
</ul></div>
<div class="mod_b type02_m057"><h3>內容簡介</h3><div class="content"><p>這是一部動人心弦的、平緩舒雅的戀愛小說。</p></div></div>
<ul><li>ISBN：${isbn("978957130001")}</li><li>叢書系列：<a>村上春樹作品集</a></li><li>ISBN：1234567890</li></ul>
</body></html>`;

const japanesePage = `<html><head><title>人間失格</title></head><body><article>
<dl class="detail"><dt>著者</dt><dd>太宰 治（著）</dd><dt>発売日</dt><dd>2006年1月</dd>
<dt>ISBN</dt><dd>${isbn("978410100001")}</dd><dt>電子書ISBN</dt><dd>${isbn("978410100002")}</dd>
<dt>レーベル</dt><dd>新潮文庫</dd></dl>
<table><tr><th>出版社</th><td>新潮社</td></tr></table>
</article></body></html>`;

const fetcherFor =
  (html: Buffer | string, headers: Record<string, string> = {}): NovelFetcher =>
  async () => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    bytes: Buffer.isBuffer(html) ? html : Buffer.from(html),
  });
const collect = (
  html: Buffer | string,
  selection: Record<string, unknown> = {},
  headers?: Record<string, string>,
) =>
  collectEdition(
    {
      url: "https://books.example.com/item/1",
      matchEvidence: evidence,
      ...selection,
    },
    {
      online: true,
      fetcher: fetcherFor(html, headers),
      now: () => new Date("2026-11-10T00:00:00Z"),
    },
  );

describe("edition extraction and cleaning", () => {
  it("prefers structured publisher data and ignores navigation, recommendations and reviews", async () => {
    const lock = await collect(publisherPage);
    expect(lock.metadata).toMatchObject({
      title: "The Quiet Harbor",
      contributors: [
        { name: "Mara Quill", role: "aut" },
        { name: "Ines Ward", role: "trl" },
      ],
      publisher: "Example Press",
      date: "2021-03-09",
      printIsbn,
      electronicIsbn: ebookIsbn,
      series: "Harbor Novels",
      position: "2",
      language: "en",
      description:
        "A lighthouse keeper's daughter returns home.\n\nSecond paragraph & more.",
    });
    expect(lock.metadata.provenance).toMatchObject({
      title: "json-ld",
      description: "json-ld",
      printIsbn: "json-ld",
    });
    expect(lock.record.canonicalUrl).toBe(
      "https://books.example.com/books/quiet-harbor",
    );
    expect(lock.record.siteName).toBe("Example Press");
    const values = lock.record.candidates.map((item) => item.value).join("\n");
    expect(values).not.toContain(otherIsbn);
    expect(values).not.toContain("Wrong Press");
    expect(values).not.toContain("2099");
    expect(values).not.toContain("Someone Else");
  });

  it("reads Douban-style label lines, original title, series and the full synopsis", async () => {
    const lock = await collect(doubanPage);
    expect(lock.metadata).toMatchObject({
      title: "解忧杂货店",
      originalTitle: "ナミヤ雑貨店の奇蹟",
      contributors: [
        { name: "东野圭吾", role: "aut" },
        { name: "李盈春", role: "trl" },
      ],
      publisher: "南海出版公司",
      date: "2014-05",
      printIsbn: isbn("978754420001"),
      series: "新经典文库·东野圭吾作品",
      description:
        "现代人内心流失的东西，这家杂货店能帮你找回。\n\n僻静的街道旁有一家杂货店。",
    });
    expect(lock.metadata.provenance.description).toBe("section");
    expect(lock.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "EDITION_CLEANED",
        field: "contributor",
        values: ["[日]"],
      }),
    );
    expect(lock.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "EDITION_CLEANED",
        field: "title",
        values: ["(豆瓣)"],
      }),
    );
  });

  it("decodes Big5 pages, prefers the synopsis block over a truncated meta description and rejects bad ISBNs", async () => {
    const bytes = encode(taiwanPage, "big5");
    const lock = await collect(bytes, {}, { "content-type": "text/html" });
    expect(lock.record.charset).toBe("big5");
    expect(lock.metadata).toMatchObject({
      title: "挪威的森林",
      contributors: [
        { name: "村上春樹", role: "aut" },
        { name: "賴明珠", role: "trl" },
      ],
      publisher: "時報出版",
      date: "2003-03-01",
      language: "zh-Hant",
      printIsbn: isbn("978957130001"),
      series: "村上春樹作品集",
      description: "這是一部動人心弦的、平緩舒雅的戀愛小說。",
    });
    expect(lock.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "EDITION_ISBN_INVALID",
        values: ["1234567890"],
      }),
    );
  });

  it("reads dt/dd and th/td detail tables with the HTTP charset and separates electronic ISBNs", async () => {
    const lock = await collect(
      encode(japanesePage, "shift_jis"),
      {},
      {
        "content-type": "text/html; charset=Shift_JIS",
      },
    );
    expect(lock.metadata).toMatchObject({
      title: "人間失格",
      contributors: [{ name: "太宰 治", role: "aut" }],
      publisher: "新潮社",
      imprint: "新潮文庫",
      date: "2006-01",
      printIsbn: isbn("978410100001"),
      electronicIsbn: isbn("978410100002"),
    });
  });

  it("keeps ambiguous ISBNs unset unless the selection names the expected edition", async () => {
    const page = `<html><head><title>Two Editions</title></head><body><ul><li>ISBN: ${printIsbn}</li><li>ISBN: ${otherIsbn}</li></ul></body></html>`;
    const ambiguous = await collect(page);
    expect(ambiguous.metadata.printIsbn).toBeUndefined();
    expect(ambiguous.diagnostics).toContainEqual(
      expect.objectContaining({ code: "EDITION_ISBN_AMBIGUOUS" }),
    );
    const selected = await collect(page, { isbn: otherIsbn });
    expect(selected.metadata.printIsbn).toBe(otherIsbn);
    await expect(collect(page, { isbn: ebookIsbn })).rejects.toMatchObject({
      code: "EDITION_MATCH",
    });
  });

  it("reports conflicts, keeps more precise compatible dates and omits truncated-only synopses", async () => {
    const page = `<html><head><title>Conflict | Shop</title>
<meta name="citation_title" content="Conflicting Title">
<meta name="description" content="Short teaser...">
<script type="application/ld+json">{"@type":"Book","name":"Conflict","datePublished":"2020"}</script>
</head><body><p>出版日期：2020年7月</p><p>Release date: 2019-01-01</p><p>出版日期：2021-02-30</p></body></html>`;
    const lock = await collect(page);
    expect(lock.metadata.title).toBe("Conflict");
    expect(lock.metadata.date).toBe("2020-07");
    expect(lock.metadata.description).toBeUndefined();
    const codes = lock.diagnostics.map((item) => `${item.code}:${item.field}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        "EDITION_CONFLICT:title",
        "EDITION_CONFLICT:date",
        "EDITION_DATE_INVALID:date",
        "EDITION_DESCRIPTION_TRUNCATED:description",
      ]),
    );
  });

  it("requires a title and decodes declared charsets", async () => {
    await expect(
      collect("<html><body><p>No book here</p></body></html>"),
    ).rejects.toMatchObject({
      code: "EDITION_PARSE",
    });
    expect(
      decodePage(encode("解忧", "gbk"), "text/html; charset=GB2312"),
    ).toEqual({
      html: "解忧",
      charset: "gbk",
    });
    expect(() =>
      decodePage(Buffer.from("x"), "text/html; charset=x-unknown"),
    ).toThrow(/Unsupported page charset/);
  });
});

describe("edition retrieval and locks", () => {
  it("follows HTTPS redirects and refuses unsafe or unexpected responses", async () => {
    const redirect: NovelFetcher = async (request): Promise<NovelResponse> =>
      request.url.endsWith("/old")
        ? { status: 301, headers: { location: "/new" }, bytes: Buffer.alloc(0) }
        : {
            status: 200,
            headers: { "content-type": "text/html" },
            bytes: Buffer.from(japanesePage),
          };
    const lock = await collectEdition(
      { url: "https://books.example.com/old", matchEvidence: evidence },
      { online: true, fetcher: redirect },
    );
    expect(lock.record.finalUrl).toBe("https://books.example.com/new");
    for (const [fetcher, code] of [
      [
        async () => ({
          status: 302,
          headers: { location: "http://books.example.com/x" },
          bytes: Buffer.alloc(0),
        }),
        "EDITION_URL",
      ],
      [
        async () => ({ status: 302, headers: {}, bytes: Buffer.alloc(0) }),
        "EDITION_REDIRECT",
      ],
      [
        async () => ({ status: 403, headers: {}, bytes: Buffer.alloc(0) }),
        "EDITION_HTTP",
      ],
      [
        async () => ({
          status: 200,
          headers: { "content-type": "application/pdf" },
          bytes: Buffer.from("%PDF"),
        }),
        "EDITION_CONTENT_TYPE",
      ],
      [
        async () => ({
          status: 200,
          headers: {},
          bytes: Buffer.alloc(4 * 1024 * 1024 + 1),
        }),
        "EDITION_LIMIT",
      ],
      [
        async () => ({
          status: 301,
          headers: { location: "/loop" },
          bytes: Buffer.alloc(0),
        }),
        "EDITION_REDIRECT",
      ],
    ] as [NovelFetcher, string][])
      await expect(
        collectEdition(
          { url: "https://books.example.com/old", matchEvidence: evidence },
          { online: true, fetcher },
        ),
      ).rejects.toMatchObject({ code });
  });

  it("rejects invalid selections, offline collection and CI network access", async () => {
    for (const selection of [
      { url: "http://books.example.com/1", matchEvidence: evidence },
      { url: "https://user:pass@books.example.com/1", matchEvidence: evidence },
      { url: "https://books.example.com/1", matchEvidence: [] },
      {
        url: "https://books.example.com/1",
        matchEvidence: evidence,
        isbn: "9780306406158",
      },
    ])
      await expect(
        collectEdition(selection, {
          online: true,
          fetcher: fetcherFor(japanesePage),
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^EDITION_(URL|SELECTION)$/),
      });
    await expect(
      collectEdition({
        url: "https://books.example.com/1",
        matchEvidence: evidence,
      }),
    ).rejects.toMatchObject({ code: "EDITION_OFFLINE" });
    vi.stubEnv("CI", "true");
    await expect(
      collectEdition(
        { url: "https://books.example.com/1", matchEvidence: evidence },
        { online: true },
      ),
    ).rejects.toMatchObject({ code: "CI_NETWORK_DISABLED" });
  });

  it("creates immutable locks from a saved page and verifies them offline", async () => {
    const root = await workspace();
    const selection = path.join(root, "selection.json");
    const page = path.join(root, "page.html");
    const output = path.join(root, "locks", "edition.lock.json");
    await fs.writeFile(
      selection,
      JSON.stringify({
        url: "https://books.example.com/item/1#reviews",
        matchEvidence: evidence,
        isbn: printIsbn,
      }),
    );
    await fs.writeFile(page, publisherPage);
    const saved = await resolveEdition(selection, { output, page });
    expect(saved).toMatchObject({
      status: "pass",
      operation: "edition-metadata",
      mode: "saved-page",
    });
    const lock = JSON.parse(await fs.readFile(output, "utf8"));
    expect(lock.selection.url).toBe("https://books.example.com/item/1");
    expect(lock.record.retrieval).toBe("saved-page");
    const offline = await resolveEdition(selection, { output });
    expect(offline).toMatchObject({ mode: "offline", digest: saved.digest });
    expect(offline.metadata).toEqual(saved.metadata);
    await expect(
      resolveEdition(selection, { output, page }),
    ).rejects.toMatchObject({
      code: "OUTPUT_EXISTS",
    });
    await expect(
      resolveEdition(selection, { output, page, online: true }),
    ).rejects.toMatchObject({
      code: "ARGUMENT_CONFLICT",
    });

    await fs.writeFile(
      selection,
      JSON.stringify({
        url: "https://books.example.com/item/2",
        matchEvidence: evidence,
      }),
    );
    await expect(resolveEdition(selection, { output })).rejects.toMatchObject({
      code: "EDITION_LOCK_STALE",
    });

    const tampered = structuredClone(lock);
    tampered.metadata.title = "Changed";
    expect(() => readEditionLock(stable(tampered))).toThrow(/changed/);
    const edited = structuredClone(lock);
    edited.record.candidates[0].value = "Edited";
    expect(() => readEditionLock(stable(edited))).toThrow(/changed/);
    expect(() => readEditionLock("{")).toThrow(/Invalid edition JSON lock/);
    expect(() => readEditionLock(JSON.stringify({ schemaVersion: 2 }))).toThrow(
      /structure/,
    );
  });

  it("runs through the CLI with a saved page, replays offline and rejects misplaced options", async () => {
    const root = await workspace();
    const selection = path.join(root, "selection.json");
    const page = path.join(root, "page.html");
    const output = path.join(root, "edition.lock.json");
    await fs.writeFile(
      selection,
      JSON.stringify({
        url: "https://books.example.com/item/1",
        matchEvidence: evidence,
      }),
    );
    await fs.writeFile(page, doubanPage);
    const cli = (...args: string[]) =>
      run(
        process.execPath,
        ["--import", "tsx", "packages/cli/src/index.ts", ...args, "--json"],
        {
          cwd: repoRoot,
        },
      );
    const saved = await cli(
      "metadata",
      "edition",
      selection,
      "--output",
      output,
      "--page",
      page,
    );
    expect(saved.exitCode).toBe(0);
    expect(JSON.parse(saved.stdout)).toMatchObject({
      operation: "edition-metadata",
      mode: "saved-page",
      metadata: { title: "解忧杂货店", date: "2014-05" },
    });
    const offline = await cli(
      "metadata",
      "edition",
      selection,
      "--output",
      output,
    );
    expect(JSON.parse(offline.stdout)).toMatchObject({ mode: "offline" });
    for (const args of [
      ["metadata", "edition", selection, "--output", output, "--plan", page],
      ["metadata", "ratings-audit", page, "--page", page],
    ]) {
      const rejected = await cli(...args);
      expect(rejected.exitCode).not.toBe(0);
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        code: "ARGUMENT_CONFLICT",
      });
    }
  });
});
