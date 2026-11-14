import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  catalogAddress,
  collectCatalog,
  parseCiniiJson,
  parseGoogleBooks,
  parseLocSruMods,
  parseNdlOpenSearch,
  parseOpenBd,
  parseOpenLibraryBooks,
  parseOpenLibrarySearch,
  readCatalogLock,
  resolveCatalog,
  selectCatalogProviders,
} from "../packages/core/src/catalog.js";
import type {
  NovelFetcher,
  NovelResponse,
} from "../packages/core/src/novel-http.js";
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-catalog-"));
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

const jpIsbn = isbn("978400000001");
const jpEbookIsbn = isbn("978400000002");
const cnIsbn = isbn("978700000001");
const twIsbn = isbn("978986000001");
const enIsbn = isbn("978000000011");
const otherIsbn = isbn("978000000012");
const evidence = ["Verified title and creator against the book's title page."];

const response = (
  body: string | object,
  contentType = typeof body === "string"
    ? "application/xml; charset=utf-8"
    : "application/json; charset=utf-8",
  status = 200,
): NovelResponse => ({
  status,
  headers: { "content-type": contentType },
  bytes: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
});

const openBdFixture = [
  {
    summary: {
      isbn: jpIsbn,
      title: "静かな港 = Quiet Harbor : 海辺の記録",
      volume: "2",
      series: "海辺叢書",
      publisher: "例示書房",
      pubdate: "202305",
      author: "港,花子",
    },
    onix: {
      RecordReference: jpIsbn,
      ProductIdentifier: { ProductIDType: "15", IDValue: jpIsbn },
      DescriptiveDetail: {
        ProductForm: "BA",
        TitleDetail: {
          TitleType: "01",
          TitleElement: [
            {
              TitleElementLevel: "01",
              TitleText: { content: "静かな港" },
              Subtitle: { content: "海辺の記録" },
            },
            {
              TitleElementLevel: "02",
              TitleText: { content: "海辺叢書" },
              PartNumber: "第2巻",
            },
          ],
        },
        Contributor: [
          {
            SequenceNumber: "1",
            ContributorRole: ["A01"],
            PersonName: { content: "港, 花子, 1981-" },
          },
          {
            SequenceNumber: "2",
            ContributorRole: ["B06"],
            PersonName: { content: "森, 太郎" },
          },
          {
            SequenceNumber: "3",
            ContributorRole: ["A12"],
            PersonName: { content: "川辺, 彩" },
          },
        ],
        Language: [{ LanguageRole: "01", LanguageCode: "jpn" }],
      },
      CollateralDetail: {
        TextContent: [
          { TextType: "04", Text: "第一章 出航 第二章 帰港" },
          { TextType: "13", Text: "1981年生まれの小説家。" },
          {
            TextType: "03",
            Text: "<p>灯台守の娘が故郷の港へ戻る物語。</p><p>第二段落のあらすじ。</p>",
          },
        ],
      },
      PublishingDetail: {
        Publisher: { PublisherName: "例示書房" },
        Imprint: { ImprintName: "例示文庫" },
        PublishingDate: [
          { PublishingDateRole: "11", Date: "202304" },
          { PublishingDateRole: "01", Date: "20230512" },
        ],
      },
    },
  },
];

const ndlXmlFixture = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:openSearch="http://a9.com/-/spec/opensearchrss/1.0/"
     xmlns:dcndl="http://ndl.go.jp/dcndl/terms/"
     xmlns:dcterms="http://purl.org/dc/terms/"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     version="2.0">
  <channel>
    <openSearch:totalResults>1</openSearch:totalResults>
    <item>
      <title>静かな港 : 海辺の記録</title>
      <link>https://ndlsearch.ndl.go.jp/books/R100000002-I000000001</link>
      <guid isPermaLink="true">https://ndlsearch.ndl.go.jp/books/R100000002-I000000001</guid>
      <description><![CDATA[<p>例示書房,2023,${jpIsbn}</p><ul><li>タイトル：静かな港</li><li>責任表示：港花子 著 ; 森太郎 訳</li><li>NDC(10)：913.6</li></ul>]]></description>
      <dc:title>静かな港 = Quiet Harbor : 海辺の記録</dc:title>
      <dcndl:volume>2</dcndl:volume>
      <dc:creator>港, 花子, 1981-</dc:creator>
      <dcndl:seriesTitle>海辺叢書</dcndl:seriesTitle>
      <dc:publisher>例示書房</dc:publisher>
      <dc:date xsi:type="dcterms:W3CDTF">2023</dc:date>
      <dcterms:issued>2023.5</dcterms:issued>
      <dcterms:language xsi:type="dcterms:ISO639-2">jpn</dcterms:language>
      <dc:identifier xsi:type="dcndl:ISBN">${jpIsbn.slice(0, 3)}-${jpIsbn.slice(3)}</dc:identifier>
      <dc:identifier xsi:type="dcndl:NDLBibID">000000001</dc:identifier>
      <dc:description>索引あり</dc:description>
      <dc:description>出版</dc:description>
    </item>
  </channel>
</rss>`;

const ciniiJsonFixture = {
  "@graph": [
    {
      "opensearch:totalResults": 2,
      items: [
        {
          "@id": "https://ci.nii.ac.jp/ncid/BD00000010",
          title: "远岸灯火 = Distant Lights : 海岸纪事",
          "dc:creator": "[著者] 林海音 ; 陈墨译",
          "dc:publisher": ["示例出版社", "总经销社 (总经销)"],
          "prism:publicationDate": "2022-08",
          "dcterms:isPartOf": [
            {
              "@id": "https://ci.nii.ac.jp/ncid/BB00000001",
              "dc:title": "海风文库, 012 / 王某主编",
            },
          ],
          "dcterms:hasPart": [{ "@id": `urn:isbn:${cnIsbn}` }],
        },
        {
          "@id": "https://ci.nii.ac.jp/ncid/BD00000099",
          title: "Unrelated Volume",
          "dc:creator": "Someone Else",
          "dcterms:hasPart": [{ "@id": `urn:isbn:${otherIsbn}` }],
        },
      ],
    },
  ],
};

const locModsCnFixture = `<?xml version="1.0" encoding="UTF-8"?>
<zs:searchRetrieveResponse xmlns:zs="http://www.loc.gov/zing/srw/">
  <zs:version>1.1</zs:version>
  <zs:numberOfRecords>1</zs:numberOfRecords>
  <zs:records>
    <zs:record>
      <zs:recordSchema>mods</zs:recordSchema>
      <zs:recordData>
        <mods xmlns="http://www.loc.gov/mods/v3" version="3.8">
          <titleInfo altRepGroup="01" script="Latn">
            <title>Yuan an deng huo</title>
            <subTitle>hai an ji shi</subTitle>
          </titleInfo>
          <titleInfo altRepGroup="01">
            <title>远岸灯火</title>
            <subTitle>海岸纪事</subTitle>
          </titleInfo>
          <name type="personal" altRepGroup="02" script="Latn">
            <namePart>Lin, Haiyin, 1975-</namePart>
            <role><roleTerm type="text">author</roleTerm></role>
          </name>
          <name type="personal" altRepGroup="02">
            <namePart>林海音, 1975-</namePart>
            <role><roleTerm type="text">author</roleTerm></role>
          </name>
          <name type="personal" altRepGroup="03">
            <namePart>陈墨,</namePart>
            <role><roleTerm type="text">translator</roleTerm></role>
          </name>
          <originInfo altRepGroup="04" script="Latn">
            <publisher>Shi li chu ban she</publisher>
            <dateIssued>[2022]</dateIssued>
          </originInfo>
          <originInfo altRepGroup="04">
            <publisher>示例出版社</publisher>
            <dateIssued>[2022]</dateIssued>
          </originInfo>
          <language><languageTerm type="code" authority="iso639-2b">chi</languageTerm></language>
          <abstract>一部关于海岸灯塔与归乡记忆的小说。</abstract>
          <relatedItem type="series">
            <titleInfo><title>海风文库</title><partNumber>第12册</partNumber></titleInfo>
          </relatedItem>
          <identifier type="isbn">${cnIsbn} (hardcover)</identifier>
          <recordInfo><recordIdentifier>2022000001</recordIdentifier></recordInfo>
        </mods>
      </zs:recordData>
    </zs:record>
  </zs:records>
</zs:searchRetrieveResponse>`;

const locModsEnFixture = `<?xml version="1.0" encoding="UTF-8"?>
<zs:searchRetrieveResponse xmlns:zs="http://www.loc.gov/zing/srw/">
  <zs:version>1.1</zs:version>
  <zs:numberOfRecords>1</zs:numberOfRecords>
  <zs:records>
    <zs:record>
      <zs:recordData>
        <mods xmlns="http://www.loc.gov/mods/v3" version="3.8">
          <titleInfo>
            <title>Systems in Practice</title>
            <subTitle>Reliable Storage Engines</subTitle>
          </titleInfo>
          <name type="personal">
            <namePart>Kleppmann, Mara, 1980-</namePart>
            <role><roleTerm type="text">author</roleTerm></role>
          </name>
          <name type="personal">
            <namePart>Ward, Ines,</namePart>
            <role><roleTerm type="code">edt</roleTerm></role>
          </name>
          <originInfo>
            <publisher>Harbor Technical Press</publisher>
            <dateIssued>c2021</dateIssued>
          </originInfo>
          <language><languageTerm type="code">eng</languageTerm></language>
          <abstract>An engineering treatise on distributed storage durability.</abstract>
          <identifier type="isbn">${enIsbn}</identifier>
          <identifier type="isbn">${otherIsbn} (ebook)</identifier>
          <recordInfo><recordIdentifier>2021999999</recordIdentifier></recordInfo>
        </mods>
      </zs:recordData>
    </zs:record>
  </zs:records>
</zs:searchRetrieveResponse>`;

describe("catalog provider parsers and routing", () => {
  it("routes providers automatically by ISBN prefix, language, and optional Google Books key", () => {
    expect(
      selectCatalogProviders({
        isbn: jpIsbn,
        matchEvidence: evidence,
      }),
    ).toEqual(["openbd", "ndl", "cinii", "openlibrary"]);
    expect(
      selectCatalogProviders({
        title: "静かな港",
        language: "ja",
        matchEvidence: evidence,
      }),
    ).toEqual(["ndl", "cinii", "openlibrary"]);
    expect(
      selectCatalogProviders({
        isbn: cnIsbn,
        matchEvidence: evidence,
      }),
    ).toEqual(["openlibrary", "cinii", "loc", "ndl"]);
    expect(
      selectCatalogProviders({
        isbn: twIsbn,
        matchEvidence: evidence,
      }),
    ).toEqual(["openlibrary", "cinii", "loc", "ndl"]);
    expect(
      selectCatalogProviders(
        {
          isbn: enIsbn,
          matchEvidence: evidence,
        },
        { hasGoogleBooksKey: true },
      ),
    ).toEqual(["loc", "openlibrary", "cinii", "google-books"]);
  });

  it("parses openBD ONIX fields, roles, dates, and TextType 03 synopsis while ignoring TOC and bio", () => {
    const entries = parseOpenBd(openBdFixture);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: "openbd",
      title: "静かな港",
      subtitle: "海辺の記録",
      contributors: [
        { name: "港花子", role: "aut" },
        { name: "森太郎", role: "trl" },
        { name: "川辺彩", role: "ill" },
      ],
      publisher: "例示書房",
      imprint: "例示文庫",
      date: "2023-05-12",
      printIsbns: [jpIsbn],
      series: "海辺叢書",
      position: "2",
      language: "ja",
      description: "灯台守の娘が故郷の港へ戻る物語。\n\n第二段落のあらすじ。",
    });
  });

  it("parses NDL OpenSearch DC-NDL fields and responsibility roles without treating catalog notes as synopsis", () => {
    const entries = parseNdlOpenSearch(ndlXmlFixture);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: "ndl",
      title: "静かな港",
      subtitle: "海辺の記録",
      contributors: [
        { name: "港花子", role: "aut" },
        { name: "森太郎", role: "trl" },
      ],
      publisher: "例示書房",
      date: "2023-05",
      printIsbns: [jpIsbn],
      series: "海辺叢書",
      position: "2",
      language: "ja",
    });
    expect(entries[0].description).toBeUndefined();
  });

  it("parses CiNii Books JSON-LD responsibility roles, series numbers, and ISBNs", () => {
    const entries = parseCiniiJson(ciniiJsonFixture);
    expect(entries[0]).toMatchObject({
      provider: "cinii",
      title: "远岸灯火",
      subtitle: "海岸纪事",
      contributors: [
        { name: "林海音", role: "aut" },
        { name: "陈墨", role: "trl" },
      ],
      publisher: "示例出版社",
      date: "2022-08",
      printIsbns: [cnIsbn],
      series: "海风文库",
      position: "12",
    });
  });

  it("parses LoC SRU MODS preferring native CJK MARC-880 fields and normalizing Western personal names", () => {
    const cn = parseLocSruMods(locModsCnFixture);
    expect(cn[0]).toMatchObject({
      provider: "loc",
      title: "远岸灯火",
      subtitle: "海岸纪事",
      contributors: [
        { name: "林海音", role: "aut" },
        { name: "陈墨", role: "trl" },
      ],
      publisher: "示例出版社",
      date: "2022",
      printIsbns: [cnIsbn],
      series: "海风文库",
      position: "12",
      language: "zh",
      description: "一部关于海岸灯塔与归乡记忆的小说。",
    });
    const en = parseLocSruMods(locModsEnFixture);
    expect(en[0]).toMatchObject({
      provider: "loc",
      title: "Systems in Practice",
      subtitle: "Reliable Storage Engines",
      contributors: [
        { name: "Mara Kleppmann", role: "aut" },
        { name: "Ines Ward", role: "edt" },
      ],
      publisher: "Harbor Technical Press",
      date: "2021",
      printIsbns: [enIsbn],
      electronicIsbns: [otherIsbn],
      language: "en",
      description: "An engineering treatise on distributed storage durability.",
    });
  });

  it("parses Open Library edition + work synopsis and search results", () => {
    const books = parseOpenLibraryBooks(
      enIsbn,
      {
        [`ISBN:${enIsbn}`]: {
          key: "/books/OL1M",
          url: "https://openlibrary.org/books/OL1M/Systems_in_Practice",
          title: "Systems in Practice",
          subtitle: "Reliable Storage Engines",
          by_statement: "Mara Kleppmann ; edited by Ines Ward",
          authors: [{ name: "Mara Kleppmann" }],
          publishers: [{ name: "Harbor Technical Press" }],
          publish_date: "March 2021",
          identifiers: { isbn_13: [enIsbn] },
        },
      },
      {
        languages: [{ key: "/languages/eng" }],
        series: ["Harbor Engineering, Book 3"],
      },
      {
        description: {
          type: "/type/text",
          value: "Detailed work-level synopsis from Open Library.",
        },
      },
    );
    expect(books[0]).toMatchObject({
      provider: "openlibrary",
      title: "Systems in Practice",
      subtitle: "Reliable Storage Engines",
      contributors: [
        { name: "Mara Kleppmann", role: "aut" },
        { name: "Ines Ward", role: "edt" },
      ],
      publisher: "Harbor Technical Press",
      date: "2021-03",
      printIsbns: [enIsbn],
      series: "Harbor Engineering",
      position: "3",
      language: "en",
      description: "Detailed work-level synopsis from Open Library.",
    });

    const searched = parseOpenLibrarySearch({
      docs: [
        {
          key: "/works/OL2W",
          title: "鬼地方",
          author_name: ["陳思宏"],
          publisher: ["鏡文學"],
          first_publish_year: 2019,
          isbn: [twIsbn],
          language: ["chi"],
        },
      ],
    });
    expect(searched[0]).toMatchObject({
      provider: "openlibrary",
      title: "鬼地方",
      contributors: [{ name: "陳思宏", role: "aut" }],
      publisher: "鏡文學",
      date: "2019",
      printIsbns: [twIsbn],
      language: "zh",
    });
  });

  it("parses Google Books volumes and distinguishes eBook identifiers", () => {
    const entries = parseGoogleBooks({
      items: [
        {
          id: "vol1",
          volumeInfo: {
            title: "静かな港",
            authors: ["港花子"],
            publisher: "例示書房",
            publishedDate: "2023-05-12",
            description: "<p>電子版のあらすじ。</p>",
            industryIdentifiers: [{ type: "ISBN_13", identifier: jpEbookIsbn }],
            language: "ja",
            canonicalVolumeLink: "https://books.google.com/books?id=vol1",
          },
          saleInfo: { isEbook: true },
        },
      ],
    });
    expect(entries[0]).toMatchObject({
      provider: "google-books",
      title: "静かな港",
      electronicIsbns: [jpEbookIsbn],
      printIsbns: [],
      language: "ja",
      description: "電子版のあらすじ。",
    });
  });
});

describe("catalog collection, locks, security and CLI", () => {
  it("merges matched records by provider priority, records conflicts, and redacts Google Books API keys", async () => {
    vi.stubEnv("GOOGLE_BOOKS_API_KEY", "secret-test-api-key");
    const seenUrls: string[] = [];
    const fetcher: NovelFetcher = async ({ url }) => {
      seenUrls.push(url);
      if (url.startsWith("https://ci.nii.ac.jp/"))
        return response(ciniiJsonFixture);
      if (url.startsWith("https://lx2.loc.gov/"))
        return response(locModsCnFixture);
      if (url.startsWith("https://www.googleapis.com/"))
        return response({
          items: [
            {
              id: "cn1",
              volumeInfo: {
                title: "远岸灯火",
                authors: ["林海音"],
                publisher: "另一出版社",
                publishedDate: "2022-08-15",
                industryIdentifiers: [{ type: "ISBN_13", identifier: cnIsbn }],
                language: "zh-CN",
              },
            },
          ],
        });
      return response({});
    };

    const lock = await collectCatalog(
      {
        isbn: cnIsbn,
        providers: ["cinii", "loc", "google-books"],
        matchEvidence: evidence,
      },
      {
        online: true,
        fetcher,
        now: () => new Date("2026-11-14T00:00:00Z"),
      },
    );

    expect(seenUrls.some((u) => u.includes("key=secret-test-api-key"))).toBe(
      true,
    );
    expect(JSON.stringify(lock)).not.toContain("secret-test-api-key");
    expect(lock.metadata).toMatchObject({
      title: "远岸灯火",
      subtitle: "海岸纪事",
      contributors: [
        { name: "林海音", role: "aut" },
        { name: "陈墨", role: "trl" },
      ],
      publisher: "示例出版社",
      date: "2022-08-15",
      printIsbn: cnIsbn,
      series: "海风文库",
      position: "12",
      language: "zh",
      description: "一部关于海岸灯塔与归乡记忆的小说。",
      provenance: {
        title: "cinii",
        publisher: "cinii",
        description: "loc",
        date: "google-books",
      },
    });
    expect(
      lock.diagnostics.some(
        (d) => d.code === "CATALOG_CONFLICT" && d.field === "publisher",
      ),
    ).toBe(true);
    expect(readCatalogLock(JSON.stringify(lock))).toEqual(lock);
  });

  it("leaves printIsbn unset with CATALOG_ISBN_AMBIGUOUS when title search matches multiple editions", async () => {
    const firstIsbn = isbn("978700000021");
    const secondIsbn = isbn("978700000022");
    const fetcher: NovelFetcher = async () =>
      response({
        "@graph": [
          {
            "opensearch:totalResults": 2,
            items: [
              {
                "@id": "https://ci.nii.ac.jp/ncid/BD1",
                title: "远岸灯火",
                "dc:creator": "林海音著",
                "dc:publisher": ["初版社"],
                "dc:date": "2018",
                "dcterms:hasPart": [{ "@id": `urn:isbn:${firstIsbn}` }],
              },
              {
                "@id": "https://ci.nii.ac.jp/ncid/BD2",
                title: "远岸灯火",
                "dc:creator": "林海音著",
                "dc:publisher": ["再版社"],
                "dc:date": "2023",
                "dcterms:hasPart": [{ "@id": `urn:isbn:${secondIsbn}` }],
              },
            ],
          },
        ],
      });
    const lock = await collectCatalog(
      {
        title: "远岸灯火",
        author: "林海音",
        providers: ["cinii"],
        matchEvidence: evidence,
      },
      { online: true, fetcher },
    );
    expect(lock.records).toHaveLength(2);
    expect(lock.metadata.printIsbn).toBeUndefined();
    expect(
      lock.diagnostics.some((d) => d.code === "CATALOG_ISBN_AMBIGUOUS"),
    ).toBe(true);
  });

  it("continues when one provider fails and fails only when all providers fail or CI disables network", async () => {
    vi.stubEnv("CI", "true");
    await expect(
      collectCatalog(
        { isbn: jpIsbn, matchEvidence: evidence },
        { online: true },
      ),
    ).rejects.toMatchObject({ code: "CI_NETWORK_DISABLED" });

    const partialFetcher: NovelFetcher = async ({ url }) => {
      if (url.startsWith("https://api.openbd.jp/"))
        return response("unavailable", "text/plain", 503);
      return response(ndlXmlFixture);
    };
    const lock = await collectCatalog(
      {
        isbn: jpIsbn,
        providers: ["openbd", "ndl"],
        matchEvidence: evidence,
      },
      { online: true, fetcher: partialFetcher },
    );
    expect(lock.metadata.title).toBe("静かな港");
    expect(
      lock.diagnostics.some(
        (d) => d.code === "CATALOG_PROVIDER_FAILED" && d.provider === "openbd",
      ),
    ).toBe(true);

    await expect(
      collectCatalog(
        { isbn: jpIsbn, providers: ["openbd"], matchEvidence: evidence },
        {
          online: true,
          fetcher: async () => response("unavailable", "text/plain", 503),
        },
      ),
    ).rejects.toMatchObject({ code: "CATALOG_UNAVAILABLE" });
  });

  it("writes an immutable catalog lock, replays offline, detects tampering, and runs through CLI", async () => {
    const root = await workspace();
    const queryFile = path.join(root, "query.json");
    const lockFile = path.join(root, "catalog.lock.json");
    await fs.writeFile(
      queryFile,
      JSON.stringify({
        isbn: jpIsbn,
        providers: ["openbd"],
        matchEvidence: evidence,
      }),
    );
    const fetcher: NovelFetcher = async () => response(openBdFixture);
    const online = await resolveCatalog(queryFile, {
      output: lockFile,
      online: true,
      fetcher,
    });
    expect(online).toMatchObject({
      status: "pass",
      operation: "catalog-metadata",
      mode: "online",
    });
    await expect(
      resolveCatalog(queryFile, { output: lockFile, online: true, fetcher }),
    ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });

    const cli = await run(
      process.execPath,
      [
        path.join(repoRoot, "bin/quillbind.mjs"),
        "metadata",
        "catalog",
        queryFile,
        "--output",
        lockFile,
        "--json",
      ],
      { cwd: root },
    );
    expect(JSON.parse(cli.stdout)).toMatchObject({
      status: "pass",
      operation: "catalog-metadata",
      mode: "offline",
      metadata: { title: "静かな港", printIsbn: jpIsbn },
    });

    const tampered = JSON.parse(await fs.readFile(lockFile, "utf8"));
    tampered.metadata.publisher = "Tampered";
    expect(() => readCatalogLock(JSON.stringify(tampered))).toThrow();

    await fs.writeFile(
      queryFile,
      JSON.stringify({
        isbn: jpEbookIsbn,
        providers: ["openbd"],
        matchEvidence: evidence,
      }),
    );
    await expect(
      resolveCatalog(queryFile, { output: lockFile }),
    ).rejects.toMatchObject({ code: "CATALOG_LOCK_STALE" });
  });

  it("enforces query validation, SSRF allowlists, XXE rejection, and offline/size guards", async () => {
    for (const bad of [
      "http://api.openbd.jp/v1/get?isbn=9784000000018",
      "https://user:pass@api.openbd.jp/v1/get",
      "https://api.openbd.jp:8443/v1/get",
      "https://evil.example.com/v1/get",
    ])
      expect(() => catalogAddress("openbd", bad)).toThrow();

    await expect(
      collectCatalog({ matchEvidence: evidence }, { online: true }),
    ).rejects.toMatchObject({ code: "CATALOG_QUERY" });
    await expect(
      collectCatalog({ isbn: jpIsbn, matchEvidence: evidence }),
    ).rejects.toMatchObject({ code: "CATALOG_OFFLINE" });
    await expect(
      collectCatalog(
        { title: "静かな港", providers: ["openbd"], matchEvidence: evidence },
        { online: true, fetcher: async () => response([]) },
      ),
    ).rejects.toMatchObject({ code: "CATALOG_PROVIDERS_EMPTY" });

    await expect(
      collectCatalog(
        { isbn: jpIsbn, providers: ["openbd"], matchEvidence: evidence },
        {
          online: true,
          fetcher: async () => ({
            status: 302,
            headers: { location: "https://127.0.0.1/internal" },
            bytes: Buffer.alloc(0),
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" });

    expect(() =>
      parseNdlOpenSearch(
        `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel></channel></rss>`,
      ),
    ).toThrow();

    const empty = await collectCatalog(
      { isbn: jpIsbn, providers: ["openbd"], matchEvidence: evidence },
      { online: true, fetcher: async () => response([null]) },
    );
    expect(empty.records).toEqual([]);
    expect(empty.diagnostics.map((d) => d.code)).toContain("CATALOG_NO_MATCH");
  });
});
