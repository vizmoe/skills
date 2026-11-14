import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  collectBookWalker,
  collectBookWalkerSearch,
  collectCatalog,
  collectEdition,
  coverAddress,
  parseBookWalkerSearch,
  readBookWalkerLock,
  readBookWalkerSearchLock,
  readCatalogLock,
  readCoverLock,
  readEditionLock,
  resolveBookWalkerSearch,
  resolveCoverFetch,
} from "../packages/core/src/index.js";
import { formatHuman } from "../packages/cli/src/human.js";
import { stable } from "../packages/core/src/json.js";
import type {
  NovelFetcher,
  NovelResponse,
} from "../packages/core/src/novel-http.js";
import { run } from "../packages/core/src/process.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import {
  japaneseHtml,
  jpUrl,
  selection,
  taiwanHtml,
} from "./bookwalker-fixture.js";

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
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "quillbind-bw-search-cover-"),
  );
  temporary.push(root);
  return root;
}

function isbn(prefix: string) {
  const sum = [...prefix].reduce(
    (total, d, i) => total + Number(d) * (i % 2 ? 3 : 1),
    0,
  );
  return prefix + ((10 - (sum % 10)) % 10);
}

async function sampleJpeg(width = 160, height = 240) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 70, b: 130 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function samplePng(width = 140, height = 210) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 90, g: 50, b: 120 },
    },
  })
    .png()
    .toBuffer();
}

const jpSearchHtml = `<!doctype html><html><body>
<div class="m-book-item">
  <div class="m-thumb">
    <a href="/de00000000-0000-4000-8000-000000000001/?adpcnt=123">
      <img src="/resources/images/bg-now-loading.png" data-original="https://c.bookwalker.jp/coverImage_1001.jpg">
    </a>
  </div>
  <div class="m-book-item__tag-box"><span class="a-tag-LN">ラノベ</span></div>
  <p class="m-book-item__title">
    <a href="/de00000000-0000-4000-8000-000000000001/" title="架空物語 1 【電子特典付き】">架空物語…</a>
  </p>
  <p class="m-book-item__author">著者：作者甲 / イラスト：画家乙(イラスト)</p>
  <p class="m-book-item__label">架空文庫</p>
  <a href="/series/501/">シリーズ一覧</a>
</div>
<div class="m-book-item">
  <div class="m-thumb">
    <a href="/de00000000-0000-4000-8000-000000000002/">
      <img src="https://c.bookwalker.jp/coverImage_1002.jpg">
    </a>
  </div>
  <div class="m-book-item__tag-box"><span class="a-tag-manga">マンガ</span></div>
  <p class="m-book-item__title">
    <a href="/de00000000-0000-4000-8000-000000000002/" title="架空物語 コミック (2)">架空物語 コミック (2)</a>
  </p>
  <p class="m-book-item__author">漫画：漫画家丁</p>
  <p class="m-book-item__label">架空コミックス</p>
</div>
</body></html>`;

const twSearchHtml = `<!doctype html><html><body>
<div class="book_package">
  <div class="cat-label">輕小說</div>
  <div class="bookitem">
    <div class="bookcover">
      <a href="/product/1001?bw=1" title="虛構物語 (1)">
        <img data-src="https://image.bookwalker.com.tw/upload/product/1001/zoom_big_1001.jpg" alt="虛構物語 (1)">
      </a>
    </div>
    <h4 class="bookname"><a href="/product/1001">虛構物語 (1)</a></h4>
    <h5 class="booknamesub">作者：作者甲、画家乙</h5>
    <div class="lablename">台灣文庫</div>
  </div>
</div>
<div class="book_package">
  <div class="cat-label">漫畫</div>
  <div class="bookitem">
    <div class="bookcover">
      <a href="/product/1002"><img src="https://image.bookwalker.com.tw/upload/product/1002/zoom_big_1002.jpg"></a>
    </div>
    <h4 class="bookname">虛構物語 漫畫 2</h4>
    <h5 class="booknamesub">作者：漫画家丁</h5>
  </div>
</div>
<div class="book_package">
  <div class="cat-label">實用書</div>
  <div class="bookitem">
    <h4 class="bookname"><a href="/product/9999">無關實用書</a></h4>
  </div>
</div>
</body></html>`;

describe("BookWalker candidate search and lock replay", () => {
  it("parses JP and TW search cards, filters non-LN/manga categories, and respects kind filters", () => {
    const jpAll = parseBookWalkerSearch(jpSearchHtml, "jp");
    expect(jpAll).toEqual([
      {
        site: "jp",
        url: "https://bookwalker.jp/de00000000-0000-4000-8000-000000000001/",
        title: "架空物語 1 【電子特典付き】",
        kind: "light-novel",
        number: "1",
        creators: ["作者甲", "画家乙"],
        imprint: "架空文庫",
        seriesUrl: "https://bookwalker.jp/series/501/",
        coverUrl: "https://c.bookwalker.jp/coverImage_1001.jpg",
      },
      {
        site: "jp",
        url: "https://bookwalker.jp/de00000000-0000-4000-8000-000000000002/",
        title: "架空物語 コミック (2)",
        kind: "manga",
        number: "2",
        creators: ["漫画家丁"],
        imprint: "架空コミックス",
        coverUrl: "https://c.bookwalker.jp/coverImage_1002.jpg",
      },
    ]);

    const twLn = parseBookWalkerSearch(twSearchHtml, "tw", "light-novel");
    expect(twLn).toEqual([
      {
        site: "tw",
        url: "https://www.bookwalker.com.tw/product/1001",
        title: "虛構物語 (1)",
        kind: "light-novel",
        number: "1",
        creators: ["作者甲", "画家乙"],
        imprint: "台灣文庫",
        coverUrl:
          "https://image.bookwalker.com.tw/upload/product/1001/zoom_big_1001.jpg",
      },
    ]);
  });

  it("writes immutable search locks, replays offline, handles partial site failures, and enforces CI offline guard", async () => {
    const root = await workspace();
    const queryPath = path.join(root, "query.json");
    const lockPath = path.join(root, "search.lock.json");
    await fs.writeFile(
      queryPath,
      JSON.stringify({ query: "架空物語", kind: "light-novel" }),
    );

    const requestedUrls: string[] = [];
    const fetcher: NovelFetcher = async ({ url }): Promise<NovelResponse> => {
      requestedUrls.push(url);
      if (url.startsWith("https://bookwalker.jp/"))
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          bytes: Buffer.from(jpSearchHtml),
        };
      return {
        status: 503,
        headers: { "content-type": "text/html" },
        bytes: Buffer.from("maintenance"),
      };
    };

    const online = await resolveBookWalkerSearch(queryPath, {
      output: lockPath,
      online: true,
      fetcher,
      now: () => new Date("2026-11-14T00:00:00Z"),
    });
    expect(online.mode).toBe("online");
    expect(requestedUrls[0]).toContain("qcat=3");
    expect(online.candidates).toHaveLength(1);
    expect(online.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BOOKWALKER_SEARCH_HTTP",
        site: "tw",
      }),
    );
    expect(formatHuman("metadata", online)).toContain("Candidates: 1");

    await expect(
      resolveBookWalkerSearch(queryPath, {
        output: lockPath,
        online: true,
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });

    const offline = await resolveBookWalkerSearch(queryPath, {
      output: lockPath,
    });
    expect(offline.mode).toBe("offline");
    expect(offline.digest).toBe(online.digest);

    await fs.writeFile(queryPath, JSON.stringify({ query: "別の作品" }));
    await expect(
      resolveBookWalkerSearch(queryPath, { output: lockPath }),
    ).rejects.toMatchObject({ code: "BOOKWALKER_SEARCH_LOCK_STALE" });

    const lockText = await fs.readFile(lockPath, "utf8");
    expect(() =>
      readBookWalkerSearchLock(lockText.replace("架空物語", "改ざん")),
    ).toThrow(/lock content changed/);

    await expect(
      collectBookWalkerSearch(
        { query: "架空物語" },
        {
          online: true,
          fetcher: async () => ({
            status: 500,
            headers: {},
            bytes: Buffer.from("err"),
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "BOOKWALKER_SEARCH_UNAVAILABLE" });

    await expect(
      collectBookWalkerSearch({ query: "架空物語" }, { online: false }),
    ).rejects.toMatchObject({ code: "BOOKWALKER_OFFLINE" });

    vi.stubEnv("CI", "true");
    await expect(
      collectBookWalkerSearch({ query: "架空物語" }, { online: true }),
    ).rejects.toMatchObject({ code: "CI_NETWORK_DISABLED" });
  });
});

describe("coverUrl extraction and cover-fetch lock workflow", () => {
  it("extracts HTTPS coverUrl across BookWalker, Edition, and Catalog locks while keeping legacy locks valid", async () => {
    // 1. Legacy BookWalker lock without coverUrl remains valid; new HTML with cover metadata populates coverUrl
    const legacyBwLock = await collectBookWalker(selection, {
      online: true,
      fetcher: async ({ url }) => ({
        status: 200,
        headers: { "content-type": "text/html" },
        bytes: Buffer.from(url === jpUrl ? japaneseHtml() : taiwanHtml()),
      }),
    });
    expect(legacyBwLock.metadata.coverUrl).toBeUndefined();
    expect(readBookWalkerLock(stable(legacyBwLock)).digest).toBe(
      legacyBwLock.digest,
    );

    const jpWithCover = japaneseHtml().replace(
      "</head>",
      '<meta property="og:image" content="https://c.bookwalker.jp/jp-cover.jpg"></head>',
    );
    const twPageObj = {
      props: {
        product_id: 1001,
        breadcrumb: [{ name: "輕小說" }],
        productData: {
          product_name: "虛構物語 (1)",
          product_series_name: "虛構物語",
          product_cover:
            "https://image.bookwalker.com.tw/upload/product/1001/cover.jpg",
          product_detail: { introduction: "<p>中文介紹。</p>" },
          product_detail_info: {
            author: "作者甲",
            illustrator: "画家乙",
            translator: "譯者丙",
            publisher: "台灣出版社",
            publisher_isbn: "9780306406157",
            sell_date_start: "2022年06月10日",
          },
        },
      },
    };
    const twWithCover = `<div id="app" data-page="${JSON.stringify(twPageObj).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></div>`;
    const bwWithCover = await collectBookWalker(selection, {
      online: true,
      fetcher: async ({ url }) => ({
        status: 200,
        headers: { "content-type": "text/html" },
        bytes: Buffer.from(url === jpUrl ? jpWithCover : twWithCover),
      }),
    });
    expect(bwWithCover.records[0].edition.coverUrl).toBe(
      "https://c.bookwalker.jp/jp-cover.jpg",
    );
    expect(bwWithCover.metadata.coverUrl).toBe(
      "https://image.bookwalker.com.tw/upload/product/1001/cover.jpg",
    );
    expect(readBookWalkerLock(stable(bwWithCover)).metadata.coverUrl).toBe(
      "https://image.bookwalker.com.tw/upload/product/1001/cover.jpg",
    );

    // 2. Edition lock extracts coverUrl from JSON-LD and Open Graph without EDITION_CONFLICT
    const editionHtml = `<!doctype html><html><head>
      <meta property="og:image" content="https://cdn.example.com/og-cover.jpg">
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Book",
        name: "Harbor Architecture",
        author: { "@type": "Person", name: "Mara Quill" },
        isbn: isbn("978000000021"),
        image: { "@type": "ImageObject", url: "/assets/book-cover.png" },
      })}</script>
    </head><body><h1>Harbor Architecture</h1></body></html>`;
    const edLock = await collectEdition(
      {
        url: "https://press.example.com/books/harbor",
        matchEvidence: ["Matched publisher page."],
      },
      {
        online: true,
        fetcher: async () => ({
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          bytes: Buffer.from(editionHtml),
        }),
      },
    );
    expect(edLock.metadata.coverUrl).toBe(
      "https://press.example.com/assets/book-cover.png",
    );
    expect(edLock.metadata.provenance.coverUrl).toBe("json-ld");
    expect(
      edLock.diagnostics.some(
        (d) => d.code === "EDITION_CONFLICT" && d.field === "coverUrl",
      ),
    ).toBe(false);
    expect(readEditionLock(stable(edLock)).metadata.coverUrl).toBe(
      "https://press.example.com/assets/book-cover.png",
    );

    // 3. Catalog lock extracts coverUrl across openBD, Open Library, and Google Books
    const targetIsbn = isbn("978400000051");
    const catLock = await collectCatalog(
      {
        isbn: targetIsbn,
        providers: ["openbd", "openlibrary", "google-books"],
        matchEvidence: ["Matched ISBN."],
      },
      {
        online: true,
        googleBooksApiKey: "test-key",
        fetcher: async ({ url }): Promise<NovelResponse> => {
          if (url.startsWith("https://api.openbd.jp/"))
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              bytes: Buffer.from(
                JSON.stringify([
                  {
                    summary: {
                      isbn: targetIsbn,
                      title: "港の設計",
                      author: "港,花子",
                      cover: `https://cover.openbd.jp/${targetIsbn}.jpg`,
                    },
                    onix: { RecordReference: targetIsbn },
                  },
                ]),
              ),
            };
          if (url.startsWith("https://openlibrary.org/api/books"))
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              bytes: Buffer.from(
                JSON.stringify({
                  [`ISBN:${targetIsbn}`]: {
                    title: "港の設計",
                    identifiers: { isbn_13: [targetIsbn] },
                    cover: {
                      large: "https://covers.openlibrary.org/b/id/999-L.jpg",
                    },
                  },
                }),
              ),
            };
          if (url.startsWith("https://openlibrary.org/isbn/"))
            return { status: 404, headers: {}, bytes: Buffer.from("{}") };
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            bytes: Buffer.from(
              JSON.stringify({
                items: [
                  {
                    id: "gb1",
                    volumeInfo: {
                      title: "港の設計",
                      industryIdentifiers: [
                        { type: "ISBN_13", identifier: targetIsbn },
                      ],
                      imageLinks: {
                        thumbnail:
                          "http://books.google.com/books/content?id=gb1&printsec=frontcover&img=1",
                      },
                    },
                  },
                ],
              }),
            ),
          };
        },
      },
    );
    expect(catLock.records.map((r) => r.coverUrl)).toEqual([
      `https://cover.openbd.jp/${targetIsbn}.jpg`,
      "https://covers.openlibrary.org/b/id/999-L.jpg",
      "https://books.google.com/books/content?id=gb1&printsec=frontcover&img=1",
    ]);
    expect(catLock.metadata.coverUrl).toBe(
      `https://cover.openbd.jp/${targetIsbn}.jpg`,
    );
    expect(catLock.metadata.provenance.coverUrl).toBe("openbd");
    expect(
      catLock.diagnostics.some(
        (d) => d.code === "CATALOG_CONFLICT" && d.field === "coverUrl",
      ),
    ).toBe(false);
    expect(readCatalogLock(stable(catLock)).metadata.coverUrl).toBe(
      `https://cover.openbd.jp/${targetIsbn}.jpg`,
    );
  });

  it("downloads verified JPEG/PNG covers from direct URLs and locks, replays offline, and enforces security boundaries", async () => {
    const root = await workspace();
    const jpegBytes = await sampleJpeg(200, 300);
    const pngBytes = await samplePng(180, 270);

    // URL validation boundaries
    expect(() => coverAddress("http://example.com/cover.jpg")).toThrow(/HTTPS/);
    expect(() => coverAddress("https://localhost/cover.jpg")).toThrow(
      /Disallowed/,
    );
    expect(() => coverAddress("https://127.0.0.1/cover.jpg")).toThrow(
      /Disallowed/,
    );
    expect(() => coverAddress("https://user:pass@example.com/c.jpg")).toThrow(
      /credentials/,
    );

    // Direct URL cover-fetch with redirect + offline replay
    const directSel = path.join(root, "direct-cover.json");
    const directOut = path.join(root, "cover.jpg");
    await fs.writeFile(
      directSel,
      JSON.stringify({
        url: "https://press.example.com/cover-redirect",
        matchEvidence: ["Publisher front cover."],
      }),
    );
    const fetcher: NovelFetcher = async ({ url }): Promise<NovelResponse> => {
      if (url.endsWith("/cover-redirect"))
        return {
          status: 302,
          headers: { location: "https://cdn.example.com/covers/final.jpg" },
          bytes: Buffer.alloc(0),
        };
      if (url.endsWith(".png"))
        return {
          status: 200,
          headers: { "content-type": "image/png" },
          bytes: pngBytes,
        };
      return {
        status: 200,
        headers: { "content-type": "image/jpeg" },
        bytes: jpegBytes,
      };
    };

    const fetched = await resolveCoverFetch(directSel, {
      output: directOut,
      online: true,
      fetcher,
      now: () => new Date("2026-11-14T01:00:00Z"),
    });
    expect(fetched).toMatchObject({
      status: "pass",
      operation: "cover-fetch",
      mode: "online",
      sourceUrl: "https://cdn.example.com/covers/final.jpg",
      image: {
        mediaType: "image/jpeg",
        extension: ".jpg",
        width: 200,
        height: 300,
      },
    });
    expect(formatHuman("metadata", fetched)).toContain(`Cover: ${directOut}`);

    // Replay offline
    const replayed = await resolveCoverFetch(directSel, { output: directOut });
    expect(replayed.mode).toBe("offline");
    expect(replayed.digest).toBe(fetched.digest);
    expect(
      readCoverLock(await fs.readFile(`${directOut}.lock.json`, "utf8")).digest,
    ).toBe(fetched.digest);

    // Extension mismatch rejected before writing output
    await expect(
      resolveCoverFetch(directSel, {
        output: path.join(root, "wrong-ext.png"),
        online: true,
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "COVER_EXTENSION" });

    // Lock-backed cover-fetch from an edition lock
    const edLock = await collectEdition(
      {
        url: "https://press.example.com/books/png-edition",
        matchEvidence: ["Edition page."],
      },
      {
        online: true,
        fetcher: async () => ({
          status: 200,
          headers: { "content-type": "text/html" },
          bytes: Buffer.from(
            `<html><head><meta property="og:title" content="PNG Book"><meta property="og:image" content="https://cdn.example.com/covers/edition.png"></head><body></body></html>`,
          ),
        }),
      },
    );
    const edLockPath = path.join(root, "edition.lock.json");
    await fs.writeFile(edLockPath, stable(edLock) + "\n");
    const fromLockSel = path.join(root, "from-lock.json");
    await fs.writeFile(
      fromLockSel,
      JSON.stringify({
        lock: "./edition.lock.json",
        matchEvidence: ["Verified edition cover."],
      }),
    );
    const lockOut = path.join(root, "edition-cover.png");
    const customLock = path.join(root, "custom-cover.lock.json");
    const lockFetched = await resolveCoverFetch(fromLockSel, {
      output: lockOut,
      lock: customLock,
      online: true,
      fetcher,
    });
    expect(lockFetched.image.mediaType).toBe("image/png");
    const lockReplayed = await resolveCoverFetch(fromLockSel, {
      output: lockOut,
      lock: customLock,
    });
    expect(lockReplayed.mode).toBe("offline");

    // Tampered cover image detected on offline replay (same format, different dimensions/bytes)
    await fs.writeFile(lockOut, await samplePng(100, 150));
    await expect(
      resolveCoverFetch(fromLockSel, { output: lockOut, lock: customLock }),
    ).rejects.toMatchObject({ code: "COVER_MISMATCH" });

    // Tampered cover image with wrong format detected on offline replay
    await fs.writeFile(lockOut, jpegBytes);
    await expect(
      resolveCoverFetch(fromLockSel, { output: lockOut, lock: customLock }),
    ).rejects.toMatchObject({ code: "COVER_EXTENSION" });

    // Lock without coverUrl raises COVER_SOURCE_MISSING
    const noCoverLock = await collectEdition(
      {
        url: "https://press.example.com/books/no-cover",
        matchEvidence: ["Edition page without image."],
      },
      {
        online: true,
        fetcher: async () => ({
          status: 200,
          headers: { "content-type": "text/html" },
          bytes: Buffer.from(
            `<html><head><meta property="og:title" content="Plain Book"></head><body></body></html>`,
          ),
        }),
      },
    );
    const noCoverLockPath = path.join(root, "no-cover.lock.json");
    await fs.writeFile(noCoverLockPath, stable(noCoverLock) + "\n");
    const missingSel = path.join(root, "missing-cover.json");
    await fs.writeFile(
      missingSel,
      JSON.stringify({
        lock: "./no-cover.lock.json",
        matchEvidence: ["Attempted cover lookup."],
      }),
    );
    await expect(
      resolveCoverFetch(missingSel, {
        output: path.join(root, "never.jpg"),
        online: true,
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "COVER_SOURCE_MISSING" });

    // CLI offline replay & argument guards
    const bin = path.join(repoRoot, "bin/quillbind.mjs");
    const cliReplay = await run(process.execPath, [
      bin,
      "metadata",
      "cover-fetch",
      directSel,
      "--output",
      directOut,
      "--json",
    ]);
    expect(cliReplay.exitCode).toBe(0);
    expect(JSON.parse(cliReplay.stdout)).toMatchObject({
      status: "pass",
      operation: "cover-fetch",
      mode: "offline",
    });

    const badArg = await run(process.execPath, [
      bin,
      "metadata",
      "catalog",
      directSel,
      "--output",
      directOut,
      "--lock",
      customLock,
      "--json",
    ]);
    expect(badArg.exitCode).toBe(1);
    expect(JSON.parse(badArg.stdout).code).toBe("ARGUMENT_CONFLICT");
  });
});
