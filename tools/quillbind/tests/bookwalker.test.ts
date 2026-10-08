import { expect, it } from "vitest";
import {
  collectBookWalker,
  parseBookWalker,
  readBookWalkerLock,
} from "../packages/core/src/bookwalker.js";
import {
  bookwalkerFetcher,
  japaneseHtml,
  jpUrl,
  selection,
  taiwanHtml,
  twUrl,
} from "./bookwalker-fixture.js";

it("reads only the selected edition's fields and preserves responsibility roles", () => {
  const tw = parseBookWalker(taiwanHtml(), twUrl);
  expect(tw).toMatchObject({
    title: "虛構物語 (1)",
    series: "虛構物語",
    number: "1",
    kind: "light-novel",
    publisher: "台灣出版社",
    printIsbn: "9780306406157",
    electronicDate: "2022-06-10",
  });
  expect(tw.contributors).toEqual([
    { name: "作者甲", role: "aut" },
    { name: "画家乙", role: "ill" },
    { name: "譯者丙", role: "trl" },
  ]);
  expect(tw.description).toBe("中文介紹 & 資料。");
  expect(parseBookWalker(japaneseHtml(), jpUrl)).toMatchObject({
    series: "架空物語",
    printDate: "2020-04-20",
    electronicDate: "2020-05-03",
  });
});

it("combines Chinese edition fields with the Japanese original's print date", async () => {
  const lock = await collectBookWalker(selection, {
    online: true,
    fetcher: bookwalkerFetcher,
  });
  expect(lock.metadata).toMatchObject({
    title: "虛構物語 (1)",
    language: "zh-Hant",
    publisher: "台灣出版社",
    releaseDate: "2020-04-20",
    dateBasis: "japanese-print",
    originalTitle: "架空物語 1",
  });
  expect(lock.records).toHaveLength(2);
  expect(lock.records[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(readBookWalkerLock(JSON.stringify(lock))).toEqual(lock);
});

it("falls back only to the Japanese electronic date and never to translation dates", async () => {
  const fetcher = async (input: Parameters<typeof bookwalkerFetcher>[0]) => ({
    ...(await bookwalkerFetcher(input)),
    ...(input.url === jpUrl
      ? { bytes: Buffer.from(japaneseHtml({ print: "" })) }
      : {}),
  });
  const lock = await collectBookWalker(selection, { online: true, fetcher });
  expect(lock.metadata).toMatchObject({
    releaseDate: "2020-05-03",
    dateBasis: "japanese-electronic",
  });
  await expect(
    collectBookWalker(selection, {
      online: true,
      fetcher: async (input) => ({
        ...(await fetcher(input)),
        ...(input.url === jpUrl
          ? { bytes: Buffer.from(japaneseHtml({ print: "", electronic: "" })) }
          : {}),
      }),
    }),
  ).rejects.toMatchObject({ code: "BOOKWALKER_DATE" });
});

it("rejects a different volume or work type instead of combining editions", async () => {
  for (const html of [
    taiwanHtml({ number: "2" }),
    taiwanHtml({ kind: "漫畫" }),
  ]) {
    await expect(
      collectBookWalker(selection, {
        online: true,
        fetcher: async (input) => ({
          ...(await bookwalkerFetcher(input)),
          ...(input.url === twUrl ? { bytes: Buffer.from(html) } : {}),
        }),
      }),
    ).rejects.toMatchObject({ code: "BOOKWALKER_MATCH" });
  }
});

it("requires online consent and rejects an altered derived lock", async () => {
  await expect(collectBookWalker(selection)).rejects.toMatchObject({
    code: "BOOKWALKER_OFFLINE",
  });
  const lock = await collectBookWalker(selection, {
    online: true,
    fetcher: bookwalkerFetcher,
  });
  lock.metadata.releaseDate = "2022-06-10";
  expect(() => readBookWalkerLock(JSON.stringify(lock))).toThrow();
});

it("validates source identity, dates and source URL boundaries", () => {
  for (const url of [
    "http://bookwalker.jp/",
    "https://evil.example/product/1001",
    "https://bookwalker.jp/series/1/",
    "https://user:password@www.bookwalker.com.tw/product/1001",
  ]) {
    expect(() => parseBookWalker(taiwanHtml(), url)).toThrow();
  }
  expect(() =>
    parseBookWalker(japaneseHtml({ print: "2020/2/31" }), jpUrl),
  ).toThrow();
  expect(() =>
    parseBookWalker(taiwanHtml(), twUrl.replace("1001", "1002")),
  ).toThrow();
});
