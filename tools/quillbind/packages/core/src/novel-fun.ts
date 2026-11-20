import { load } from "cheerio";
import { parse } from "devalue";
import { z } from "zod";
import { fail } from "./errors.js";
import { NovelHttp, remoteUrl } from "./novel-http.js";
import {
  assertComplete,
  checkCatalog,
  cleanText,
  plainHtml,
} from "./novel-html.js";
import type {
  NovelCatalog,
  NovelChapter,
  NovelSource,
  NovelVolume,
} from "./novel-model.js";

const id = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform(String);
const chapterSchema = z.object({
  id,
  title: z.string().min(1),
  locked: z.boolean().optional(),
});
const volumeSchema = z.object({
  id,
  title: z.string().min(1),
  cover: z.string().nullish(),
  chapters: z.array(chapterSchema),
  chapterCount: z.number().optional(),
  chaptersLoaded: z.boolean().optional(),
});
const bootstrapSchema = z.object({
  book: z.object({
    id,
    title: z.string().min(1),
    author: z.string().nullish(),
    summary: z.string().nullish(),
    cover: z.string().nullish(),
  }),
  catalog: z.array(volumeSchema),
  catalogComplete: z.boolean(),
});
function nuxtData(html: string, prefix: string): unknown {
  const raw = load(html)("#__NUXT_DATA__").text();
  if (!raw)
    fail(
      "NOVEL_LAYOUT",
      "Cannot find the site's book data; its page layout may have changed",
    );
  try {
    const state = parse(raw, {
      ShallowReactive: (value) => value,
      Reactive: (value) => value,
      Ref: (value) => value,
      ShallowRef: (value) => value,
    }) as { data?: Record<string, unknown> };
    return Object.entries(state.data ?? {}).find(([key]) =>
      key.startsWith(prefix),
    )?.[1];
  } catch {
    fail("NOVEL_LAYOUT", "Cannot decode the site's book data");
  }
}
function record(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success)
    fail("NOVEL_RESPONSE", "Source catalog API returned an invalid object");
  return parsed.data;
}
function sourceString(value: unknown) {
  const parsed = z.union([z.string().min(1), z.number()]).safeParse(value);
  if (!parsed.success)
    fail(
      "NOVEL_RESPONSE",
      "Source catalog API returned a missing identifier or title",
    );
  return parsed.data.toString();
}
function optionalCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0)
    fail("NOVEL_RESPONSE", "Source catalog API returned an invalid count");
  return count;
}
function parseCatalogPageItems(
  data: Record<string, unknown>,
  seen: Set<string>,
  items: Record<string, unknown>[],
) {
  const parsedItems = z
    .array(z.record(z.string(), z.unknown()))
    .safeParse(data.items ?? data.list);
  if (!parsedItems.success)
    fail("NOVEL_RESPONSE", "Source catalog API returned an invalid item list");
  for (const item of parsedItems.data) {
    const key = sourceString(item.chapter_id ?? item.volume_id ?? item.id);
    if (seen.has(key))
      fail("NOVEL_PAGINATION", "Source catalog repeated an item across pages");
    seen.add(key);
    items.push(item);
  }
  return parsedItems.data;
}
function parseHasMore(
  pagination: Record<string, unknown>,
  data: Record<string, unknown>,
): boolean | undefined {
  const hasMore =
    pagination.has_next ??
    pagination.has_more ??
    data.hasMore ??
    data.has_more ??
    data.has_next;
  if (hasMore === undefined) return undefined;
  if (
    ![false, true, 0, 1, "0", "1"].includes(
      hasMore as string | number | boolean,
    )
  )
    fail(
      "NOVEL_RESPONSE",
      "Source catalog returned an invalid continuation flag",
    );
  return [true, 1, "1"].includes(hasMore as string | number | boolean);
}
function parseCatalogPagination(data: Record<string, unknown>, page: number) {
  const pagination = record(data.pagination ?? data.page_info ?? {});
  const count = optionalCount(
    pagination.total ??
      pagination.total_count ??
      pagination.count ??
      data.total,
  );
  const pageCount = optionalCount(
    pagination.page_count ?? pagination.total_page ?? pagination.page_total,
  );
  const pageSize =
    optionalCount(
      pagination.page_size ??
        pagination.per_page ??
        pagination.pageSize ??
        data.page_size ??
        data.pageSize,
    ) ?? 50;
  const currentPage =
    optionalCount(
      pagination.page ??
        pagination.current_page ??
        pagination.cur_page ??
        data.page,
    ) ?? page;
  if (!pageSize || currentPage !== page)
    fail(
      "NOVEL_PAGINATION",
      "Source catalog returned the wrong page or an invalid page size",
    );
  const more = parseHasMore(pagination, data);
  return { count, pageCount, pageSize, more };
}
function isCatalogPageComplete(
  more: boolean | undefined,
  page: number,
  pageCount: number | undefined,
  count: number | undefined,
  totalItems: number,
  pageItemsLength: number,
  pageSize: number,
): boolean {
  if (more !== undefined) return !more;
  if (pageCount !== undefined && pageCount > 0) return page >= pageCount;
  if (count !== undefined) return totalItems >= count;
  return pageItemsLength < pageSize;
}

export class FunSource implements NovelSource {
  constructor(private readonly http: NovelHttp) {}
  private async fetchCatalogPage(
    endpoint: "get-book-volumes" | "get-volume-chapters",
    volumeId: string | undefined,
    page: number,
    items: Record<string, unknown>[],
    seen: Set<string>,
  ): Promise<Record<string, unknown>[]> {
    if (page > 1000)
      fail(
        "NOVEL_PAGINATION",
        "Source catalog pagination exceeded the request limit",
      );
    const url = new URL(
      `/api/pc-proxy/api/new-content-read/${endpoint}`,
      this.http.address.url,
    ).href;
    const response = record(
      await this.http.post(url, {
        book_id: this.http.address.id,
        ...(volumeId ? { volume_id: volumeId } : {}),
        page,
        pageSize: 50,
        page_size: 50,
      }),
    );
    if (![0, 200].includes(Number(response.code)))
      fail("NOVEL_ACCESS", "Source catalog API denied access");
    const data = record(response.data);
    const pageItems = parseCatalogPageItems(data, seen, items);
    const { count, pageCount, pageSize, more } = parseCatalogPagination(
      data,
      page,
    );
    if (
      isCatalogPageComplete(
        more,
        page,
        pageCount,
        count,
        items.length,
        pageItems.length,
        pageSize,
      )
    ) {
      if (count !== undefined && items.length !== count)
        fail(
          "NOVEL_CATALOG",
          "Source catalog count does not match its returned items",
        );
      return items;
    }
    if (!pageItems.length)
      fail(
        "NOVEL_PAGINATION",
        "Source catalog ended before its declared total",
      );
    return this.fetchCatalogPage(endpoint, volumeId, page + 1, items, seen);
  }
  private catalogPages(
    endpoint: "get-book-volumes" | "get-volume-chapters",
    volumeId?: string,
  ) {
    return this.fetchCatalogPage(endpoint, volumeId, 1, [], new Set());
  }
  private async appendVolume(
    volumes: NovelVolume[],
    raw: z.infer<typeof volumeSchema>,
    pageUrl: string,
    localePrefix: string,
  ) {
    const address = this.http.address;
    let chapters = raw.chapters;
    if (
      !raw.chaptersLoaded ||
      (raw.chapterCount !== undefined && chapters.length !== raw.chapterCount)
    ) {
      chapters = (await this.catalogPages("get-volume-chapters", raw.id)).map(
        (item) => ({
          id: sourceString(item.chapter_id ?? item.id),
          title: sourceString(item.title ?? item.chapter_title ?? item.name),
          locked: !!(item.locked ?? item.is_locked),
        }),
      );
    }
    if (raw.chapterCount !== undefined && chapters.length !== raw.chapterCount)
      fail("NOVEL_CATALOG", "Source volume chapter count is incomplete");
    volumes.push({
      number: volumes.length + 1,
      id: raw.id,
      title: cleanText(raw.title),
      ...(raw.cover ? { cover: remoteUrl(raw.cover, pageUrl).href } : {}),
      chapters: chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        url: new URL(
          `${localePrefix}/reader/${address.id}/${chapter.id}`,
          pageUrl,
        ).href,
      })),
    });
  }
  async catalog(): Promise<NovelCatalog> {
    const address = this.http.address,
      page = await this.http.html(address.url);
    const parsed = bootstrapSchema.safeParse(
      nuxtData(page.html, `pc-book-detail-${address.id}`),
    );
    if (!parsed.success || parsed.data.book.id !== address.id)
      fail(
        "NOVEL_LAYOUT",
        "Source book metadata or catalog does not match the requested book",
      );
    const bootstrap = parsed.data;
    const localePrefix =
      /^\/(?:cn|tw)(?=\/)/.exec(new URL(page.url).pathname)?.[0] ?? "";
    let rawVolumes = bootstrap.catalog;
    if (!bootstrap.catalogComplete) {
      rawVolumes = (await this.catalogPages("get-book-volumes")).map(
        (item) => ({
          id: sourceString(item.volume_id ?? item.id),
          title: sourceString(item.title ?? item.volume_title ?? item.name),
          cover:
            typeof (item.cover_url ?? item.cover) === "string"
              ? String(item.cover_url ?? item.cover)
              : undefined,
          chapters: [],
          chaptersLoaded: false,
          chapterCount: optionalCount(item.chapter_count),
        }),
      );
    }
    const volumes: NovelVolume[] = [];
    let chain = Promise.resolve();
    for (const raw of rawVolumes)
      chain = chain.then(() =>
        this.appendVolume(volumes, raw, page.url, localePrefix),
      );
    await chain;
    return checkCatalog({
      ...address,
      title: bootstrap.book.title,
      authors: bootstrap.book.author ? [bootstrap.book.author] : [],
      description: plainHtml(bootstrap.book.summary ?? ""),
      // Nuxt contains the original Chinese text even under /tw/; the browser's
      // display conversion is not part of the source data we import.
      language: "zh",
      ...(bootstrap.book.cover
        ? { cover: remoteUrl(bootstrap.book.cover, page.url).href }
        : {}),
      volumes,
      diagnostics: [],
    });
  }
  async chapter(chapter: NovelChapter) {
    const page = await this.http.html(chapter.url);
    const state = z
      .object({
        currentChapter: z.object({
          bookId: id,
          chapterId: id,
          locked: z.boolean(),
          contentHtml: z.string(),
        }),
      })
      .safeParse(
        nuxtData(
          page.html,
          `reader-bootstrap-${this.http.address.id}-${chapter.id}-`,
        ),
      );
    if (
      !state.success ||
      state.data.currentChapter.bookId !== this.http.address.id ||
      state.data.currentChapter.chapterId !== chapter.id
    )
      fail(
        "NOVEL_LAYOUT",
        "Reader response does not match the requested chapter",
      );
    if (state.data.currentChapter.locked)
      fail(
        "NOVEL_ACCESS",
        "Source chapter is locked; no partial EPUB was released",
      );
    const html = state.data.currentChapter.contentHtml;
    assertComplete(html);
    return [{ html, url: page.url }];
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
