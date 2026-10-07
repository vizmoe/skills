import sharp from "sharp";
import type {
  NovelFetcher,
  NovelRequest,
} from "../packages/core/src/novel-http.js";
import type { NovelHub } from "../packages/core/src/novel-shelf.js";

export function nuxtFixture(key: string, state: unknown) {
  const table: unknown[] = [];
  const flatten = (value: unknown): number => {
    const index = table.length;
    table.push(null);
    table[index] = Array.isArray(value)
      ? value.map(flatten)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, flatten(child)]),
          )
        : value;
    return index;
  };
  flatten({ data: { [key]: state } });
  return `<html><body><script type="application/json" id="__NUXT_DATA__">${JSON.stringify(table).replace(/</g, "\\u003c")}</script></body></html>`;
}
export async function novelFixture() {
  const image = await sharp({
    create: { width: 64, height: 96, channels: 3, background: "#557788" },
  })
    .png()
    .toBuffer();
  const base = "https://www.bilinovel.com";
  const pages = new Map<string, string | Buffer>([
    [
      `${base}/novel/42.html`,
      `<h1 class="book-title">测试故事 &amp; 旅行</h1><div class="book-rand-a"><span>测试作者</span></div><div class="book-layout"><img src="https://images.example.com/cover.png"></div><div id="bookSummary"><content>两卷原创测试文本。</content></div>`,
    ],
    [
      `${base}/novel/42/catalog`,
      `<ul class="volume-chapters"><li class="chapter-bar">第一卷</li><li class="volume-cover"><img src="/images/book-cover-no.svg" data-src="https://images.example.com/cover.png"></li><li class="jsChapter"><a href="/novel/42/101.html">开始</a></li><li class="jsChapter"><a href="/novel/42/102.html">插图</a></li></ul><ul class="volume-chapters"><li class="chapter-bar">第二卷</li><li class="volume-cover"><img src="https://images.example.com/cover.png"></li><li class="jsChapter"><a href="/novel/42/201.html">结尾</a></li></ul>`,
    ],
    [
      `${base}/novel/42/101.html`,
      `<div id="acontent"><p>第一页 &amp; A &lt; B。</p><p>文字里的 *星号*、$x$ 和 :::include 不应执行。</p></div><div id="footlink"><a class="nextlink">下一页</a></div><script>var ReadParams={url_next:'/novel/42/101_2.html'};</script>`,
    ],
    [
      `${base}/novel/42/101_2.html`,
      `<div id="acontent"><p>第二页的最后一句。</p></div><div id="footlink"><a class="nextlink" href="/novel/42/102.html">下一章</a></div>`,
    ],
    [
      `${base}/novel/42/102.html`,
      `<div id="acontent"><p><img data-src="https://images.example.com/cover.png" src="/loading.gif" alt="山谷的线条插画"></p></div>`,
    ],
    [
      `${base}/novel/42/201.html`,
      `<div id="acontent"><p>第二卷结尾。</p><img src="https://images.example.com/cover.png" alt="同一张画"></div>`,
    ],
    ["https://images.example.com/cover.png", image],
  ]);
  const requests: string[] = [];
  const fetcher: NovelFetcher = async (request) => {
    requests.push(request.url);
    const bytes = pages.get(request.url);
    if (bytes === undefined)
      throw new Error(`Unexpected fixture request: ${request.url}`);
    return {
      status: 200,
      bytes: Buffer.from(bytes),
      headers: {
        "content-type":
          typeof bytes === "string" ? "text/html; charset=utf-8" : "image/png",
      },
    };
  };
  return {
    base,
    url: `${base}/novel/42.html`,
    pages,
    requests,
    fetcher,
    image,
  };
}
export function shelfFixture(): NovelHub & {
  calls: string[];
  closed: boolean;
} {
  return {
    calls: [],
    closed: false,
    async invoke(method, params) {
      this.calls.push(`${method}:${JSON.stringify(params)}`);
      if (method === "GetBookInfo")
        return {
          SeriesTitle: "系列名",
          Series: [
            { Id: 7, Title: "卷一" },
            { Id: 8, Title: "卷二" },
          ],
          Book: {
            Id: params.Id,
            Type: "Novel",
            Title: `卷${params.Id}`,
            Author: "测试作者",
            Introduction: "<p>系列简介。</p>",
            Cover: "",
            Chapters: [
              { Id: params.Id * 10 + 2, SortNum: 2, Title: "第二章" },
              { Id: params.Id * 10 + 1, SortNum: 1, Title: "第一章" },
            ],
          },
        };
      return {
        Chapter: {
          BookId: params.Bid,
          Id: params.Bid * 10 + params.SortNum,
          SortNum: params.SortNum,
          Content: "<p>测试正文。</p>",
        },
      };
    },
    async close() {
      this.closed = true;
    },
  };
}

/** Original JSON SignalR conversation, exercised through the real Microsoft client. */
export function shelfTransport(denied = false) {
  const requests: NovelRequest[] = [],
    hub = shelfFixture();
  const queue: string[] = [];
  let firstPoll = true,
    wake: (() => void) | undefined;
  const push = (message: unknown) => {
    queue.push(JSON.stringify(message) + "\x1e");
    wake?.();
  };
  const fetcher: NovelFetcher = async (request) => {
    requests.push(request);
    const response = (text: string) => ({
      status: 200,
      headers: {},
      bytes: Buffer.from(text),
    });
    if (new URL(request.url).pathname.endsWith("/negotiate"))
      return response(
        JSON.stringify({
          negotiateVersion: 1,
          connectionId: "test",
          connectionToken: "test-connection",
          availableTransports: [
            { transport: "LongPolling", transferFormats: ["Text"] },
          ],
        }),
      );
    if (request.method === "DELETE") return response("");
    if (request.method === "POST") {
      for (const raw of request.body!.split("\x1e").filter(Boolean)) {
        const message = JSON.parse(raw);
        if (message.protocol) push({});
        else if (message.type === 1) {
          push({
            type: 3,
            invocationId: message.invocationId,
            ...(denied
              ? { error: "Failed to invoke because user is unauthorized" }
              : {
                  result: {
                    success: true,
                    response: await hub.invoke(
                      message.target,
                      message.arguments[0],
                    ),
                  },
                }),
          });
        }
      }
      return response("");
    }
    if (firstPoll) {
      firstPoll = false;
      return response("");
    }
    if (!queue.length) {
      let onAbort: () => void = () => {};
      try {
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          onAbort = () => reject(new Error("poll aborted"));
          request.signal?.addEventListener("abort", onAbort, { once: true });
          if (request.signal?.aborted) onAbort();
        });
      } finally {
        wake = undefined;
        request.signal?.removeEventListener("abort", onAbort);
      }
    }
    return response(queue.splice(0).join(""));
  };
  return { fetcher, requests, hub };
}
