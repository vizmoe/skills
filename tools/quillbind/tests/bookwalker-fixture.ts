import type { NovelFetcher } from "../packages/core/src/novel-http.js";

export const jpUrl =
  "https://bookwalker.jp/de00000000-0000-4000-8000-000000000001/";
export const twUrl = "https://www.bookwalker.com.tw/product/1001";
export const selection = {
  kind: "light-novel" as const,
  language: "zh-Hant" as const,
  japaneseUrl: jpUrl,
  translatedUrl: twUrl,
  number: "1",
  matchEvidence: [
    "The selected product pages identify the same story, author and first volume.",
  ],
};
export function japaneseHtml(
  options: {
    kind?: string;
    print?: string;
    electronic?: string;
    title?: string;
  } = {},
) {
  return `<html><head><link rel="canonical" href="${jpUrl}"><meta property="og:title" content="${options.title ?? "架空物語 1"}"><meta property="og:description" content="架空の紹介。"></head><body>
<dl class="t-c-detail-about-information__data">
<dt>シリーズ</dt><dd><a>架空物語（架空文庫）</a></dd>
<dt>著者</dt><dd><ul><li><a>作者甲(著者)</a></li><li><a>画家乙(イラスト)</a></li></ul></dd>
<dt>レーベル</dt><dd>架空文庫</dd><dt>出版社</dt><dd>日本出版社</dd>
<dt>カテゴリ</dt><dd>${options.kind ?? "ライトノベル"}</dd>
<dt>配信開始日</dt><dd>${options.electronic ?? "2020/5/3"}</dd>
<dt>底本発行日</dt><dd>${options.print ?? "2020/4/20"}</dd></dl>
<aside><dt>配信開始日</dt><dd>2099/1/1</dd><a>Recommendation writer</a></aside>
<script type="application/ld+json">{"@type":"Review","datePublished":"2099-01-01"}</script>
</body></html>`;
}
export function taiwanHtml(
  options: { number?: string; kind?: string; introduction?: string } = {},
) {
  const page = {
    props: {
      product_id: 1001,
      breadcrumb: [{ name: options.kind ?? "輕小說" }],
      productData: {
        product_name: `虛構物語 (${options.number ?? "1"})`,
        product_series_name: "虛構物語",
        product_series_num: 99,
        product_detail: {
          introduction: options.introduction ?? "<p>中文介紹 &amp; 資料。</p>",
        },
        product_detail_info: {
          author: "作者甲",
          illustrator: "画家乙",
          translator: "譯者丙",
          publisher: "台灣出版社",
          publisher_isbn: "9780306406157",
          publisher_eisbn: "",
          sell_date_start: "2022年06月10日",
        },
        product_recommendation: [
          { author: "Wrong author", date: "2099-01-01" },
        ],
      },
    },
  };
  return `<div id="app" data-page="${JSON.stringify(page).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></div>`;
}
export const bookwalkerFetcher: NovelFetcher = async ({ url }) => ({
  status: 200,
  headers: { "content-type": "text/html" },
  bytes: Buffer.from(url === jpUrl ? japaneseHtml() : taiwanHtml()),
});
