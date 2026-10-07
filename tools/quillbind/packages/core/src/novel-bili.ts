import { load } from "cheerio";
import { fail } from "./errors.js";
import { NovelHttp, remoteUrl } from "./novel-http.js";
import {
  assertComplete,
  checkCatalog,
  cleanText,
  imageUrl,
  plainHtml,
} from "./novel-html.js";
import type {
  NovelCatalog,
  NovelChapter,
  NovelPage,
  NovelSource,
  NovelVolume,
} from "./novel-model.js";
import { restoreBiliParagraphs } from "./novel-bili-order.js";

export class BiliSource implements NovelSource {
  private scripts = new Map<string, string>();
  private pages = new Map<string, NovelPage>();
  constructor(private http: NovelHttp) {}
  private async page(url: string) {
    if (!this.pages.has(url)) this.pages.set(url, await this.http.html(url));
    return this.pages.get(url)!;
  }
  private chapterLink(value: string | undefined, page: string) {
    if (!value) return undefined;
    const url = remoteUrl(value, page);
    const match = new RegExp(
      `^/novel/${this.http.address.id}/(\\d+)(?:_\\d+)?\\.html$`,
    ).exec(url.pathname);
    if (!match) return undefined;
    this.http.allowed(url.href);
    return {
      id: match[1],
      url: new URL(`/novel/${this.http.address.id}/${match[1]}.html`, url).href,
    };
  }
  private async resolveMissing(chapters: NovelChapter[]) {
    // ReadParams provides the site's own links; never guess chapter IDs or execute cid().
    for (let i = chapters.length - 1; i >= 0; i--) {
      const chapter = chapters[i],
        next = chapters[i + 1];
      if (chapter.url || !next?.url) continue;
      const page = await this.page(next.url);
      const previous = this.chapterLink(
        /url_previous\s*:\s*['"]([^'"]+)['"]/.exec(page.html)?.[1],
        page.url,
      );
      if (previous && previous.id !== next.id) Object.assign(chapter, previous);
    }
    for (let i = 1; i < chapters.length; i++) {
      const chapter = chapters[i],
        previous = chapters[i - 1];
      if (chapter.url || !previous.url) continue;
      let pageUrl = previous.url;
      const seen = new Set<string>();
      while (seen.size < 200 && !seen.has(pageUrl)) {
        seen.add(pageUrl);
        const page = await this.page(pageUrl),
          $ = load(page.html);
        const raw = /url_next\s*:\s*['"]([^'"]+)['"]/.exec(page.html)?.[1];
        const target = this.chapterLink(raw, page.url);
        if (!target) break;
        if (/^下一[页頁]$/.test(cleanText($("#footlink .nextlink").text()))) {
          if (target.id !== previous.id) break;
          pageUrl = remoteUrl(raw!, page.url).href;
        } else {
          if (target.id !== previous.id) Object.assign(chapter, target);
          break;
        }
      }
    }
    if (chapters.some((chapter) => !chapter.url))
      fail(
        "NOVEL_CATALOG",
        "A chapter URL could not be recovered from adjacent source navigation; no chapter was skipped",
      );
  }
  async catalog(): Promise<NovelCatalog> {
    const address = this.http.address;
    const page = await this.http.html(address.url),
      $ = load(page.html);
    const title =
      cleanText($(".book-title, #bookinfo h1").first().text()) ||
      $("meta[property='og:novel:book_name']").attr("content") ||
      "";
    const author =
      cleanText($(".book-rand-a span").first().text()) ||
      $("meta[property='og:novel:author']").attr("content") ||
      "";
    const cover = imageUrl($, $(".book-layout img").first(), page.url);
    const catalogPage = await this.http.html(
      new URL(`/novel/${address.id}/catalog`, page.url).href,
    );
    const $$ = load(catalogPage.html),
      volumes: NovelVolume[] = [];
    let volume: NovelVolume | undefined;
    $$(".volume-chapters > li").each((_, node) => {
      const item = $$(node);
      if (item.hasClass("chapter-bar")) {
        const number = volumes.length + 1;
        volume = {
          number,
          id: String(number),
          title: cleanText(item.text()),
          chapters: [],
        };
        volumes.push(volume);
      } else if (item.hasClass("volume-cover")) {
        if (volume)
          volume.cover = imageUrl(
            $$,
            item.find("img").first(),
            catalogPage.url,
          );
      } else if (item.hasClass("jsChapter")) {
        if (!volume) {
          volume = { number: 1, id: "1", title, chapters: [] };
          volumes.push(volume);
        }
        const link = item.find("a").first(),
          href = link.attr("href");
        if (!href || /^(?:javascript:|#)/i.test(href)) {
          volume.chapters.push({
            id: "",
            title: cleanText(link.text()),
            url: "",
          });
          return;
        }
        const url = remoteUrl(href, catalogPage.url);
        const match = new RegExp(`^/novel/${address.id}/(\\d+)\\.html$`).exec(
          url.pathname,
        );
        if (!match)
          fail("NOVEL_CATALOG", "Unexpected chapter URL in source catalog");
        this.http.allowed(url.href);
        volume.chapters.push({
          id: match[1],
          title: cleanText(link.text()),
          url: url.href,
        });
      }
    });
    await this.resolveMissing(volumes.flatMap((volume) => volume.chapters));
    return checkCatalog({
      ...address,
      title,
      authors: author ? [author] : [],
      description: plainHtml(
        $("#bookSummary content, #bookSummary .content, #intro")
          .first()
          .html() ?? "",
      ),
      language: address.url.includes("tw.linovelib.com")
        ? "zh-Hant"
        : "zh-Hans",
      cover,
      volumes,
      diagnostics: [],
    });
  }
  async chapter(chapter: NovelChapter): Promise<NovelPage[]> {
    const pages: NovelPage[] = [],
      seen = new Set<string>();
    let next: string | undefined = chapter.url;
    const expected = new URL(chapter.url).pathname.replace(/\.html$/, "");
    while (next) {
      if (seen.has(next) || seen.size >= 200)
        fail("NOVEL_PAGINATION", "Cyclic or excessive chapter pagination");
      seen.add(next);
      const page = await this.page(next),
        $ = load(page.html);
      this.pages.delete(next);
      const body = $("#acontent, .bcontent").first();
      if (!body.length)
        fail("NOVEL_CONTENT_EMPTY", "Cannot find the source chapter body");
      assertComplete(body.html() ?? "");
      body.find("script,ins,.tp,.bd,figure.ads,div.ads").remove();
      const script = $("script[src*='chapterlog.js']").attr("src");
      if (script) {
        const scriptUrl = remoteUrl(script, page.url).href;
        if (!this.scripts.has(scriptUrl))
          this.scripts.set(
            scriptUrl,
            (await this.http.read(scriptUrl)).bytes.toString(),
          );
        restoreBiliParagraphs(
          $,
          body,
          this.scripts.get(scriptUrl)!,
          Number(chapter.id),
        );
      }
      pages.push({ url: page.url, html: body.html()! });
      const link = $("#footlink .nextlink").first();
      if (!/^(?:下一[页頁])$/.test(cleanText(link.text()))) break;
      const href =
        link.attr("href") ||
        /url_next\s*:\s*['"]([^'"]+)['"]/.exec(page.html)?.[1];
      if (!href) fail("NOVEL_PAGINATION", "Next-page control has no URL");
      const target = remoteUrl(href, page.url);
      if (
        !target.pathname.startsWith(expected + "_") ||
        !/_\d+\.html$/.test(target.pathname)
      )
        fail(
          "NOVEL_PAGINATION",
          "Next-page control points outside the current chapter",
        );
      this.http.allowed(target.href);
      next = target.href;
    }
    return pages;
  }
  async close() {}
}
