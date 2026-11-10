import { describe, expect, it } from "vitest";
import {
  chineseNumber,
  cleanDescription,
  cleanTitle,
  findIsbns,
  normalizeDate,
  normalizeIsbn,
  normalizeLanguage,
  parseContributors,
  seriesPosition,
} from "../packages/core/src/bibliography-normalize.js";

describe("contributors", () => {
  it.each([
    [
      "[日] 东野圭吾 著；李盈春 译",
      [
        { name: "东野圭吾", role: "aut" },
        { name: "李盈春", role: "trl" },
      ],
    ],
    [
      "（美）卡勒德·胡赛尼 著，李继宏 译",
      [
        { name: "卡勒德·胡赛尼", role: "aut" },
        { name: "李继宏", role: "trl" },
      ],
    ],
    [
      "张三、李四 编著",
      [
        { name: "张三", role: "aut" },
        { name: "李四", role: "aut" },
      ],
    ],
    [
      "作者：王小波 / 插画：赵五",
      [
        { name: "王小波", role: "aut" },
        { name: "赵五", role: "ill" },
      ],
    ],
    ["〔清〕曹雪芹著", [{ name: "曹雪芹", role: "aut" }]],
    ["余华 等著", [{ name: "余华", role: "aut" }]],
    ["几米 绘", [{ name: "几米", role: "ill" }]],
    ["王小波 文", [{ name: "王小波", role: "aut" }]],
    [
      "Haruki Murakami (Author), Jay Rubin (Translator)",
      [
        { name: "Haruki Murakami", role: "aut" },
        { name: "Jay Rubin", role: "trl" },
      ],
    ],
    ["Translated by Anthea Bell", [{ name: "Anthea Bell", role: "trl" }]],
    ["Smith, John", [{ name: "Smith, John", role: "aut" }]],
    [
      "Neil Gaiman & Terry Pratchett",
      [
        { name: "Neil Gaiman", role: "aut" },
        { name: "Terry Pratchett", role: "aut" },
      ],
    ],
    ["東野 圭吾（著）", [{ name: "東野 圭吾", role: "aut" }]],
  ])("parses %s", (value, expected) => {
    expect(parseContributors(value).contributors).toEqual(expected);
  });
  it("keeps names whose last character is a weak role marker", () => {
    expect(parseContributors("李明文").contributors).toEqual([
      { name: "李明文", role: "aut" },
    ]);
    expect(parseContributors("王画").contributors).toEqual([
      { name: "王画", role: "aut" },
    ]);
  });
  it("uses the field role for unmarked names and reports removed text", () => {
    const parsed = parseContributors("[英] 某某", "trl");
    expect(parsed.contributors).toEqual([{ name: "某某", role: "trl" }]);
    expect(parsed.removed).toEqual(["[英]"]);
  });
  it("drops placeholders but keeps real anonymous attributions", () => {
    expect(parseContributors("Unknown").contributors).toEqual([]);
    expect(parseContributors("未知作者").removed).toEqual(["未知作者"]);
    expect(parseContributors("佚名").contributors).toEqual([
      { name: "佚名", role: "aut" },
    ]);
  });
});

describe("titles", () => {
  it.each([
    ["活着 - 博客來", [], "活着"],
    ["解忧杂货店 | 南海出版公司", ["南海出版公司"], "解忧杂货店"],
    ["【预售】三体（精装）", [], "三体"],
    ["Norwegian Wood (Chinese Edition)", [], "Norwegian Wood"],
    ["人間失格 Kindle版", [], "人間失格"],
    ["《活着》", [], "活着"],
    ["三体（上）", [], "三体（上）"],
    [
      "日本史の謎は「地形」で解ける (講談社現代新書)",
      [],
      "日本史の謎は「地形」で解ける (講談社現代新書)",
    ],
    ["Dune - Messiah", [], "Dune - Messiah"],
  ])("cleans %s", (value, suffixes, expected) => {
    expect(cleanTitle(value, { suffixes }).value).toBe(expected);
  });
  it("records removed residue", () => {
    expect(cleanTitle("【正版包邮】某书 | 某某网上书店").removed).toEqual([
      "某某网上书店",
      "【正版包邮】",
    ]);
  });
});

describe("descriptions", () => {
  it("removes markup, interface text, headings and watermarks while keeping paragraphs", () => {
    const cleaned = cleanDescription(
      "<h3>内容简介</h3><p>第一段 &amp; 内容。</p><p>第二段……(展开全部)</p><p>更多电子书请访问 www.example-books.com</p><p>Read more</p>",
    );
    expect(cleaned.value).toBe("第一段 & 内容。\n\n第二段……");
    expect(cleaned.removed).toEqual([
      "内容简介",
      "(展开全部)",
      "更多电子书请访问 www.example-books.com",
      "Read more",
    ]);
  });
  it("decodes descriptions stored as escaped markup", () => {
    expect(
      cleanDescription("&lt;p&gt;One&lt;/p&gt;&lt;p&gt;Two&lt;/p&gt;").value,
    ).toBe("One\n\nTwo");
  });
  it("keeps ordinary synopsis vocabulary", () => {
    const text = "本书整理了作者关于微信时代阅读的思考。";
    expect(cleanDescription(text).value).toBe(text);
  });
});

describe("identifiers, dates and positions", () => {
  it("validates and normalizes ISBNs", () => {
    expect(normalizeIsbn("978-0-306-40615-7")).toBe("9780306406157");
    expect(normalizeIsbn("ISBN 0-306-40615-2")).toBe("9780306406157");
    expect(normalizeIsbn("080442957X")).toBe("9780804429573");
    expect(normalizeIsbn("urn:isbn:9780306406157")).toBe("9780306406157");
    expect(normalizeIsbn("9780306406158")).toBeUndefined();
    expect(normalizeIsbn("0306406153")).toBeUndefined();
    expect(findIsbns("ISBN：978-7-5442-7087-8 / 9787544270870 / 123")).toEqual({
      valid: ["9787544270878"],
      invalid: ["9787544270870"],
    });
  });
  it.each([
    ["2014-5", "2014-05"],
    ["2020年5月1日", "2020-05-01"],
    ["2020/05/01", "2020-05-01"],
    ["2020.5", "2020-05"],
    ["2020年", "2020"],
    ["2019-11-05T00:00:00+08:00", "2019-11-05"],
    ["May 1, 2020", "2020-05-01"],
    ["1 September 2015", "2015-09-01"],
    ["March 2003", "2003-03"],
    ["2020年5月出版", "2020-05"],
  ])("normalizes date %s", (value, expected) => {
    expect(normalizeDate(value)).toBe(expected);
  });
  it.each(["0101-01-01T00:00:00+00:00", "2021-02-30", "2020-13", "soon", ""])(
    "rejects date %s",
    (value) => {
      expect(normalizeDate(value)).toBeUndefined();
    },
  );
  it.each([
    ["第3卷", "3"],
    ["3", "3"],
    ["卷三", "3"],
    ["第二十三册", "23"],
    ["Vol. 4", "4"],
    ["Book 2", "2"],
    ["1.5", "1.5"],
  ])("normalizes series position %s", (value, expected) => {
    expect(seriesPosition(value)).toBe(expected);
  });
  it("converts Chinese numerals and rejects other text", () => {
    expect(chineseNumber("一百零五")).toBe(105);
    expect(chineseNumber("十")).toBe(10);
    expect(seriesPosition("上")).toBeUndefined();
  });
  it.each([
    ["简体中文", "zh-Hans"],
    ["繁體中文", "zh-Hant"],
    ["日本語", "ja"],
    ["zh_cn", "zh-CN"],
    ["zh-hant-tw", "zh-Hant-TW"],
  ])("normalizes language %s", (value, expected) => {
    expect(normalizeLanguage(value)).toBe(expected);
  });
  it("leaves undetermined languages unresolved", () => {
    expect(normalizeLanguage("und")).toBeUndefined();
    expect(normalizeLanguage("Klingon dialect")).toBeUndefined();
  });
});
