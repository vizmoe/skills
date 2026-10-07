import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { BiliSource } from "../packages/core/src/novel-bili.js";
import {
  fetchNovelBook,
  inspectNovel,
  selectNovelVolumes,
} from "../packages/core/src/novel.js";
import { novelAddress, NovelHttp } from "../packages/core/src/novel-http.js";
import { openBook } from "../packages/core/src/config.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { validateInternal } from "../packages/core/src/validate.js";
import { preflightBook } from "../packages/core/src/preflight.js";
import { candidate, bodymatterItems } from "./helpers.js";
import {
  novelFixture,
  nuxtFixture,
  shelfFixture,
  shelfTransport,
} from "./novel-fixture.js";

const temporary: string[] = [];
async function destination() {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "quillbind-novel-test-"),
  );
  temporary.push(parent);
  return path.join(parent, "book");
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const file of temporary.splice(0))
    await fs.rm(file, { recursive: true, force: true });
});

describe("novel URL and volume contracts", () => {
  it.each([
    ["https://bilinovel.com/novel/12.html?ref=x", "bilinovel", "12"],
    ["https://www.bilinovel.com/novel/12/catalog", "bilinovel", "12"],
    ["https://tw.linovelib.com/novel/12/vol_99.html", "bilinovel", "12"],
    ["https://www.lightnovel.fun/book/45", "lightnovel-fun", "45"],
    ["https://www.lightnovel.app/book/info/8", "lightnovel-app", "8"],
  ])("recognizes %s", (url, site, id) => {
    expect(novelAddress(url)).toMatchObject({ site, id });
  });
  it.each([
    "https://www.lightnovel.app/home",
    "https://www.lightnovel.fun/",
    "https://www.bilinovel.com/novel/42/101.html",
    "https://bilinovel.com.evil.example/novel/42.html",
    "https://www.bilinovel.com:8080/novel/42.html",
    "https://user:secret@www.bilinovel.com/novel/42.html",
    "http://www.bilinovel.com/novel/42.html",
    "file:///etc/passwd",
  ])("rejects %s", (url) => {
    expect(() => novelAddress(url)).toThrow();
  });
  it("selects and deduplicates ranges in source order", async () => {
    const f = await novelFixture(),
      catalog = await inspectNovel(f.url, { fetcher: f.fetcher, delayMs: 0 });
    expect(
      selectNovelVolumes(catalog.volumes, "2,1-2").map((v) => v.number),
    ).toEqual([1, 2]);
    for (const value of [
      "",
      "0",
      "2-1",
      "3",
      "1-999999999",
      "all,1",
      "1,,2",
      "-1",
    ])
      expect(() => selectNovelVolumes(catalog.volumes, value)).toThrow();
  });
});

it("prepares a merged offline book with cover, all pages, images and nested navigation", async () => {
  const f = await novelFixture(),
    output = await destination();
  const result = await fetchNovelBook(f.url, {
    output,
    fetcher: f.fetcher,
    delayMs: 0,
    prepareOnly: true,
  });
  expect(result).toMatchObject({
    status: "prepared",
    publicationReady: false,
    mode: "merged",
  });
  expect(result.projects[0]).toMatchObject({
    chapters: 3,
    volumes: [1, 2],
    readiness: { metadata: "pass", release: "not-run" },
  });
  const book = await openBook(output);
  expect(book.config.book).toMatchObject({
    title: "测试故事 & 旅行",
    authors: ["测试作者"],
    language: "zh-Hans",
  });
  expect(book.config.navigation).toHaveLength(2);
  const text = await fs.readFile(
    path.join(output, "chapters/v001-0001.md"),
    "utf8",
  );
  expect(text).toContain("第一页");
  expect(text).toContain("第二页的最后一句");
  const preflight = await preflightBook(output);
  expect(preflight.status, JSON.stringify(preflight.diagnostics)).toBe("pass");
  const bytes = await candidate(output),
    info = inspectBytes(bytes);
  expect(validateInternal(bytes).status).toBe("pass");
  expect(
    info.manifest.filter((item) => item.mediaType.startsWith("image/")),
  ).toHaveLength(1);
  expect(bodymatterItems(info)).toHaveLength(5);
  const body = [...info.documents.values()]
    .map((doc) => doc.toString())
    .join("\n");
  expect(body).toContain("山谷的线条插画");
  expect(body).toContain("*星号*、$x$ 和 :::include");
  expect(body).not.toContain("<script");
  expect(await candidate(output)).toEqual(bytes);
  expect(
    f.requests.filter((url) => url.startsWith("https://images.example.com")),
  ).toHaveLength(1);
  const evidence = JSON.parse(
    await fs.readFile(path.join(output, "metadata/novel-source.json"), "utf8"),
  );
  expect(evidence.chapters[0].pages).toEqual([
    `${f.base}/novel/42/101.html`,
    `${f.base}/novel/42/101_2.html`,
  ]);
  expect(await fs.readdir(output)).not.toContain("novel-token");
});

it("imports selected volumes only and creates self-contained split projects", async () => {
  const f = await novelFixture(),
    output = await destination();
  const result = await fetchNovelBook(f.url, {
    output,
    fetcher: f.fetcher,
    delayMs: 0,
    prepareOnly: true,
    splitVolumes: true,
    volumes: "2",
  });
  expect(result.projects).toHaveLength(1);
  expect(result.projects[0].root).toBe(path.join(output, "volume-002"));
  expect(f.requests).not.toContain(`${f.base}/novel/42/101.html`);
  expect(
    validateInternal(await candidate(result.projects[0].root)).status,
  ).toBe("pass");
});
it("shares downloads across split volumes while each book retains its assets", async () => {
  const f = await novelFixture(),
    output = await destination();
  const result = await fetchNovelBook(f.url, {
    output,
    fetcher: f.fetcher,
    delayMs: 0,
    prepareOnly: true,
    splitVolumes: true,
  });
  expect(result.projects).toHaveLength(2);
  for (const project of result.projects)
    expect(validateInternal(await candidate(project.root)).status).toBe("pass");
  expect(
    f.requests.filter((url) => url.startsWith("https://images.example.com")),
  ).toHaveLength(1);
});
it("keeps source WebP bytes and records PNG conversion for EPUB", async () => {
  const f = await novelFixture(),
    output = await destination();
  const webp = await sharp(f.image).webp({ lossless: true }).toBuffer();
  f.pages.set("https://images.example.com/cover.png", webp);
  await fetchNovelBook(f.url, {
    output,
    fetcher: f.fetcher,
    delayMs: 0,
    prepareOnly: true,
    volumes: "2",
  });
  const evidence = JSON.parse(
    await fs.readFile(path.join(output, "metadata/novel-source.json"), "utf8"),
  );
  expect(evidence.images[0].action).toBe("webp-to-png");
  expect(
    await fs.readFile(path.join(output, evidence.images[0].original)),
  ).toEqual(webp);
  const converted = await fs.readFile(
    path.join(output, evidence.images[0].path),
  );
  expect(await sharp(converted).raw().toBuffer()).toEqual(
    await sharp(webp).raw().toBuffer(),
  );
  expect(validateInternal(await candidate(output)).status).toBe("pass");
});
it.each(["backward", "forward"])(
  "recovers missing Bilinovel links using %s source navigation",
  async (direction) => {
    const f = await novelFixture();
    const catalog = `${f.base}/novel/42/catalog`;
    const missing = direction === "backward" ? 102 : 201;
    f.pages.set(
      catalog,
      String(f.pages.get(catalog)).replace(
        `/novel/42/${missing}.html`,
        "javascript:cid(1)",
      ),
    );
    if (direction === "backward")
      f.pages.set(
        `${f.base}/novel/42/201.html`,
        `<script>var ReadParams={url_previous:'/novel/42/102.html'}</script>`,
      );
    else
      f.pages.set(
        `${f.base}/novel/42/102.html`,
        `<div id="footlink"><a class="nextlink">下一页</a></div><script>var ReadParams={url_next:'/novel/42/102_2.html'}</script>`,
      );
    f.pages.set(
      `${f.base}/novel/42/102_2.html`,
      `<script>var ReadParams={url_next:'/novel/42/201.html'}</script>`,
    );
    const result = await inspectNovel(f.url, {
      fetcher: f.fetcher,
      delayMs: 0,
    });
    expect(result.volumes.flatMap((v) => v.chapters.map((c) => c.id))).toEqual([
      "101",
      "102",
      "201",
    ]);
  },
);
it("restores known paragraph order without moving illustrations or executing script", async () => {
  const f = await novelFixture();
  // Known six-item tail for chapter 101; includes non-paragraph slots and an empty p.
  const scrambled = [
    ...Array.from({ length: 20 }, (_, i) => i),
    22,
    21,
    23,
    20,
    24,
    25,
  ];
  const script = `if(!count)return;var fixed=-0x8b*0x37+0x20f6+-0x305;function shuffle(){};var seed=add(mul(Number(chapter),126),232),rest=[];state=mod(add(mul(state,9302),49397),233280);throw new Error('never execute');`;
  const html = `<div id="acontent">${scrambled.map((n) => `<p>段落 ${n}</p>${n === 21 ? '<img src="/art.png"><p> </p>' : ""}`).join("")}</div><script src="/chapterlog.js"></script>`;
  f.pages.set(`${f.base}/novel/42/101.html`, html);
  f.pages.set(`${f.base}/chapterlog.js`, script);
  const source = new BiliSource(
    new NovelHttp(novelAddress(f.url), { fetcher: f.fetcher, delayMs: 0 }),
  );
  const chapter = (await source.catalog()).volumes[0].chapters[0];
  const pages = await source.chapter(chapter);
  expect(
    [...pages[0].html.matchAll(/段落 (\d+)/g)].map((m) => Number(m[1])),
  ).toEqual(Array.from({ length: 26 }, (_, i) => i));
  expect(pages[0].html).toContain('<p>段落 21</p><img src="/art.png"><p> </p>');
  f.pages.set(
    `${f.base}/chapterlog.js`,
    script.replace("-0x8b*0x37+0x20f6+-0x305", "21"),
  );
  const changed = new BiliSource(
    new NovelHttp(novelAddress(f.url), { fetcher: f.fetcher, delayMs: 0 }),
  );
  await expect(changed.chapter(chapter)).rejects.toMatchObject({
    code: "NOVEL_ORDER",
  });
});
it.each([
  [
    "truncated chapter",
    `<div id="acontent"><p>内容……（內容加載失敗！請刷新或更換瀏覽器）</p></div>`,
    "NOVEL_CONTENT_INCOMPLETE",
  ],
  ["empty chapter", `<div id="acontent"></div>`, "NOVEL_CONTENT_EMPTY"],
  ["unknown body", `<html><body>login</body></html>`, "NOVEL_CONTENT_EMPTY"],
  [
    "changed shuffle script",
    `<div id="acontent"><p>正文</p></div><script src="/chapterlog.js"></script>`,
    "NOVEL_ORDER",
  ],
  [
    "cross-chapter next page",
    `<div id="acontent"><p>正文</p></div><div id="footlink"><a class="nextlink" href="/novel/42/102_2.html">下一页</a></div>`,
    "NOVEL_PAGINATION",
  ],
])("fails without leaving a book for %s", async (_, html, code) => {
  const f = await novelFixture(),
    output = await destination();
  f.pages.set(`${f.base}/novel/42/101.html`, html);
  f.pages.set(
    `${f.base}/chapterlog.js`,
    "throw new Error('must never execute');",
  );
  await expect(
    fetchNovelBook(f.url, {
      output,
      fetcher: f.fetcher,
      delayMs: 0,
      prepareOnly: true,
    }),
  ).rejects.toMatchObject({ code });
  expect(await fs.readdir(path.dirname(output))).toEqual([]);
});
it("rejects cycles, missing images and duplicate catalog chapters", async () => {
  for (const mode of ["cycle", "image", "duplicate"]) {
    const f = await novelFixture(),
      output = await destination();
    if (mode === "cycle")
      f.pages.set(
        `${f.base}/novel/42/101_2.html`,
        `<div id="acontent"><p>text</p></div><div id="footlink"><a class="nextlink" href="/novel/42/101_2.html">下一页</a></div>`,
      );
    if (mode === "image")
      f.pages.set(
        "https://images.example.com/cover.png",
        "<!doctype html><html>not an image</html>",
      );
    if (mode === "duplicate")
      f.pages.set(
        `${f.base}/novel/42/catalog`,
        String(f.pages.get(`${f.base}/novel/42/catalog`)).replace(
          "/201.html",
          "/101.html",
        ),
      );
    await expect(
      fetchNovelBook(f.url, {
        output,
        fetcher: f.fetcher,
        delayMs: 0,
        prepareOnly: true,
      }),
    ).rejects.toThrow();
    expect(await fs.readdir(path.dirname(output))).toEqual([]);
  }
});
it("preserves an existing output and cancels a pending request", async () => {
  const f = await novelFixture(),
    output = await destination();
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, "keep"), "original");
  await expect(
    fetchNovelBook(f.url, { output, fetcher: f.fetcher }),
  ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
  expect(f.requests).toEqual([]);
  expect(await fs.readFile(path.join(output, "keep"), "utf8")).toBe("original");
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await expect(
    inspectNovel(f.url, { fetcher: f.fetcher, signal: abort.signal }),
  ).rejects.toThrow("cancelled");
});

it("reads Nuxt data including volumes omitted from the visible initial chapter grid", async () => {
  const f = await novelFixture(),
    output = await destination(),
    url = "https://www.lightnovel.fun/book/42";
  const book = {
    id: "42",
    title: "测试故事",
    author: "测试作者",
    summary: "故事简介。",
    cover: "https://images.example.com/cover.png",
  };
  const catalog = [1, 2].map((n) => ({
    id: String(n),
    title: `第${n}卷`,
    chapters: [{ id: String(n * 100), title: "标题" }],
    chapterCount: 1,
    chaptersLoaded: true,
  }));
  f.pages.set(
    url,
    nuxtFixture("pc-book-detail-42", { book, catalog, catalogComplete: true }),
  );
  for (const n of [1, 2])
    f.pages.set(
      `https://www.lightnovel.fun/reader/42/${n * 100}`,
      nuxtFixture(`reader-bootstrap-42-${n * 100}-public`, {
        currentChapter: {
          bookId: "42",
          chapterId: String(n * 100),
          locked: false,
          contentHtml: `<p>卷${n}正文。</p><img src="https://images.example.com/cover.png">`,
        },
      }),
    );
  const result = await fetchNovelBook(url, {
    output,
    fetcher: f.fetcher,
    delayMs: 0,
    prepareOnly: true,
  });
  expect(result.projects[0].chapters).toBe(2);
  expect(validateInternal(await candidate(output)).status).toBe("pass");
});
it("rejects locked or mismatched Nuxt reader data", async () => {
  const f = await novelFixture(),
    output = await destination(),
    url = "https://www.lightnovel.fun/book/42";
  f.pages.set(
    url,
    nuxtFixture("pc-book-detail-42", {
      book: { id: "42", title: "故事" },
      catalog: [
        {
          id: "1",
          title: "一",
          chapters: [{ id: "1", title: "一" }],
          chaptersLoaded: true,
        },
      ],
      catalogComplete: true,
    }),
  );
  f.pages.set(
    "https://www.lightnovel.fun/reader/42/1",
    nuxtFixture("reader-bootstrap-42-1-public", {
      currentChapter: {
        bookId: "42",
        chapterId: "1",
        locked: true,
        contentHtml: "<p>付费提示</p>",
      },
    }),
  );
  await expect(
    fetchNovelBook(url, {
      output,
      fetcher: f.fetcher,
      delayMs: 0,
      prepareOnly: true,
    }),
  ).rejects.toMatchObject({ code: "NOVEL_ACCESS" });
});
it("retains the traditional locale on Nuxt chapter URLs", async () => {
  const f = await novelFixture(),
    url = "https://www.lightnovel.fun/tw/book/42";
  f.pages.set(
    url,
    nuxtFixture("pc-book-detail-42", {
      book: { id: 42, title: "故事" },
      catalog: [
        {
          id: 1,
          title: "第一卷",
          chapters: [{ id: 2, title: "第一章" }],
          chaptersLoaded: true,
        },
      ],
      catalogComplete: true,
    }),
  );
  const result = await inspectNovel(url, { fetcher: f.fetcher, delayMs: 0 });
  expect(result.language).toBe("zh");
  expect(result.volumes[0].chapters[0].url).toBe(
    "https://www.lightnovel.fun/tw/reader/42/2",
  );
});
it("imports lightnovel.app series, numeric chapter order and closes its hub", async () => {
  const output = await destination(),
    hub = shelfFixture();
  const result = await fetchNovelBook(
    "https://www.lightnovel.app/book/info/7",
    {
      output,
      hub,
      delayMs: 0,
      prepareOnly: true,
      fetcher: async () => {
        throw new Error("Unexpected HTTP request");
      },
    },
  );
  expect(hub.closed).toBe(true);
  expect(result.projects[0].chapters).toBe(4);
  expect(
    hub.calls.filter((call) => call.startsWith("GetNovelContent")),
  ).toEqual(
    [7, 8].flatMap((Bid) =>
      [1, 2].map(
        (SortNum) => `GetNovelContent:${JSON.stringify({ Bid, SortNum })}`,
      ),
    ),
  );
  expect(validateInternal(await candidate(output)).status).toBe("pass");
});
it("uses the real JSON SignalR transport, isolates credentials and closes polling", async () => {
  const transport = shelfTransport(),
    output = await destination();
  const result = await fetchNovelBook(
    "https://www.lightnovel.app/book/info/7",
    {
      output,
      fetcher: transport.fetcher,
      token: "synthetic-test-token",
      delayMs: 0,
      prepareOnly: true,
    },
  );
  expect(result.projects[0].chapters).toBe(4);
  expect(
    transport.requests.some(
      (r) => r.headers.Authorization === "Bearer synthetic-test-token",
    ),
  ).toBe(true);
  expect(
    transport.requests.every(
      (r) => new URL(r.url).hostname === "api.lightnovel.life",
    ),
  ).toBe(true);
  expect(transport.requests.some((r) => r.method === "DELETE")).toBe(true);
  expect(
    await fs.readFile(path.join(output, "novel-requests.json"), "utf8"),
  ).not.toContain("synthetic-test-token");
  expect(
    await fs.readFile(path.join(output, "metadata/novel-source.json"), "utf8"),
  ).not.toContain("synthetic-test-token");
});
it("reports a JSON SignalR authorization failure as a source access error", async () => {
  const transport = shelfTransport(true);
  await expect(
    inspectNovel("https://www.lightnovel.app/book/info/7", {
      fetcher: transport.fetcher,
      delayMs: 0,
    }),
  ).rejects.toMatchObject({ code: "NOVEL_ACCESS" });
  expect(transport.requests.some((r) => r.method === "DELETE")).toBe(true);
});
it("closes the lightnovel.app hub after API failure", async () => {
  const hub = shelfFixture();
  hub.invoke = async () => {
    throw new Error("access denied");
  };
  await expect(
    inspectNovel("https://www.lightnovel.app/book/info/7", {
      hub,
      fetcher: async () => {
        throw new Error("unused");
      },
    }),
  ).rejects.toThrow("access denied");
  expect(hub.closed).toBe(true);
});
it("preserves the source failure when hub cleanup also fails", async () => {
  const hub = shelfFixture(),
    output = await destination();
  hub.invoke = async () => {
    throw new Error("original source error");
  };
  hub.close = async () => {
    throw new Error("cleanup error");
  };
  for (const operation of [inspectNovel, fetchNovelBook])
    await expect(
      operation("https://www.lightnovel.app/book/info/7", {
        hub,
        output,
        fetcher: async () => {
          throw new Error("unused");
        },
      }),
    ).rejects.toThrow("original source error");
  expect(await fs.readdir(path.dirname(output))).toEqual([]);
});
it.each(["font", "identity"])(
  "fails safely on a lightnovel.app chapter %s problem",
  async (problem) => {
    const hub = shelfFixture(),
      invoke = hub.invoke.bind(hub),
      output = await destination();
    hub.invoke = async (method, params) => {
      if (method === "GetBookInfo") return invoke(method, params);
      return {
        Chapter: {
          BookId: params.Bid,
          Id: problem === "identity" ? 999 : params.Bid * 10 + params.SortNum,
          SortNum: params.SortNum,
          Content: "<p>文本。</p>",
          ...(problem === "font" ? { Font: "/read.woff" } : {}),
        },
      };
    };
    await expect(
      fetchNovelBook("https://www.lightnovel.app/book/info/7", {
        hub,
        output,
        prepareOnly: true,
        delayMs: 0,
        fetcher: async () => {
          throw new Error("unused");
        },
      }),
    ).rejects.toMatchObject({
      code: problem === "font" ? "NOVEL_SOURCE_FONT" : "NOVEL_RESPONSE",
    });
    expect(hub.closed).toBe(true);
    expect(await fs.readdir(path.dirname(output))).toEqual([]);
  },
);

it.each(["complete", "duplicate", "short"])(
  "reads lazy Nuxt catalog pages and checks %s responses",
  async (mode) => {
    const f = await novelFixture(),
      url = "https://www.lightnovel.fun/book/42";
    f.pages.set(
      url,
      nuxtFixture("pc-book-detail-42", {
        book: { id: 42, title: "目录测试" },
        catalog: [],
        catalogComplete: false,
      }),
    );
    const calls: string[] = [];
    const catalogFetcher: typeof f.fetcher = async (request) => {
      if (request.method !== "POST") return f.fetcher(request);
      const body = JSON.parse(request.body!);
      const endpoint = new URL(request.url).pathname.split("/").at(-1);
      calls.push(`${endpoint}:${body.page}`);
      const data =
        endpoint === "get-book-volumes"
          ? {
              list: [{ volume_id: 1, title: "卷一", chapter_count: 2 }],
              pagination: { page: 1, page_count: 1, total: 1 },
            }
          : {
              list:
                body.page === 2 && mode === "short"
                  ? []
                  : [
                      {
                        chapter_id: mode === "duplicate" ? 10 : body.page * 10,
                        title: `章 ${body.page}`,
                      },
                    ],
              pagination: {
                current_page: body.page,
                page_size: 1,
                page_count: 2,
                total_count: 2,
              },
            };
      return {
        status: 200,
        headers: {},
        bytes: Buffer.from(JSON.stringify({ code: 0, data })),
      };
    };
    const result = inspectNovel(url, { fetcher: catalogFetcher, delayMs: 0 });
    if (mode !== "complete")
      await expect(result).rejects.toMatchObject({
        code: mode === "duplicate" ? "NOVEL_PAGINATION" : "NOVEL_CATALOG",
      });
    else
      expect(
        (await result).volumes[0].chapters.map((chapter) => chapter.id),
      ).toEqual(["10", "20"]);
    expect(calls).toEqual([
      "get-book-volumes:1",
      "get-volume-chapters:1",
      "get-volume-chapters:2",
    ]);
  },
);

describe("source network boundaries", () => {
  it("allows public image redirects while blocking site navigation outside its hosts", async () => {
    const f = await novelFixture();
    const fetcher = vi.fn(async () => ({
      status: 302,
      headers: { location: "https://evil.example/novel/42.html" },
      bytes: Buffer.alloc(0),
    }));
    const http = new NovelHttp(novelAddress(f.url), { fetcher, delayMs: 0 });
    await expect(http.html(f.url)).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => http.allowed("http://127.0.0.1/image.png", true)).toThrow();
    expect(() =>
      http.allowed("https://user:secret@images.example.com/p.png", true),
    ).toThrow();
  });
  it("rejects successful HTTP challenge pages and invalid option ranges", async () => {
    const address = novelAddress("https://www.bilinovel.com/novel/42.html");
    const http = new NovelHttp(address, {
      delayMs: 0,
      fetcher: async () => ({
        status: 200,
        headers: {},
        bytes: Buffer.from(
          '<title>Just a moment...</title><form id="challenge-form">',
        ),
      }),
    });
    await expect(http.html(address.url)).rejects.toMatchObject({
      code: "NOVEL_ACCESS",
    });
    for (const delayMs of [-1, NaN, 0.5, 60001])
      expect(() => new NovelHttp(address, { delayMs })).toThrow();
  });
});
