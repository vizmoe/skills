import {
  HttpClient,
  HttpResponse,
  HttpTransportType,
  HubConnectionBuilder,
  LogLevel,
  type HttpRequest,
} from "@microsoft/signalr";
import { z } from "zod";
import { checkAbort, fail } from "./errors.js";
import { NovelHttp, remoteUrl } from "./novel-http.js";
import { assertComplete, checkCatalog, plainHtml } from "./novel-html.js";
import type {
  NovelCatalog,
  NovelChapter,
  NovelSource,
  NovelVolume,
} from "./novel-model.js";

export interface NovelHub {
  invoke(
    method: "GetBookInfo" | "GetNovelContent",
    params: Record<string, number>,
  ): Promise<unknown>;
  close(): Promise<void>;
}
class ShelfHttpClient extends HttpClient {
  constructor(private http: NovelHttp) {
    super();
  }
  async send(input: HttpRequest) {
    if (
      !input.url?.startsWith("https://api.lightnovel.life/hub/api") ||
      !["GET", "POST", "DELETE"].includes(input.method ?? "")
    )
      fail("SSRF_BLOCKED", "Unexpected lightnovel.app API request");
    const abort = new AbortController();
    if (input.abortSignal?.aborted) abort.abort();
    if (input.abortSignal) input.abortSignal.onabort = () => abort.abort();
    try {
      const response = await this.http.read(input.url, {
        protocol: true,
        method: input.method as "GET" | "POST" | "DELETE",
        body: typeof input.content === "string" ? input.content : undefined,
        headers: input.headers,
        signal: abort.signal,
        timeout: input.timeout ?? 100000,
      });
      return new HttpResponse(response.status, "", response.bytes.toString());
    } finally {
      if (input.abortSignal) input.abortSignal.onabort = null;
    }
  }
}
export class ShelfHub implements NovelHub {
  private connection;
  private started = false;
  constructor(private http: NovelHttp) {
    this.connection = new HubConnectionBuilder()
      .withUrl("https://api.lightnovel.life/hub/api", {
        transport: HttpTransportType.LongPolling,
        httpClient: new ShelfHttpClient(http),
        accessTokenFactory: () => http.options.token ?? "",
        withCredentials: false,
      })
      .configureLogging(LogLevel.None)
      .build();
  }
  async invoke(
    method: "GetBookInfo" | "GetNovelContent",
    params: Record<string, number>,
  ) {
    checkAbort(this.http.options.signal);
    await this.http.throttle();
    try {
      if (!this.started) {
        await this.connection.start();
        this.started = true;
      }
      const response = (await this.connection.invoke(method, params, {
        UseGzip: false,
      })) as {
        Success?: boolean;
        success?: boolean;
        Response?: unknown;
        response?: unknown;
        Status?: number;
      };
      checkAbort(this.http.options.signal);
      if (!(response.Success ?? response.success))
        fail(
          "NOVEL_ACCESS",
          "lightnovel.app requires access to this book; supply your own session token using QUILLBIND_LIGHTNOVEL_TOKEN",
        );
      return response.Response ?? response.response;
    } catch (error) {
      checkAbort(this.http.options.signal);
      if (error instanceof Error && "code" in error) throw error;
      if (
        error instanceof Error &&
        /unauthorized|unauthenticated|forbidden/i.test(error.message)
      )
        fail(
          "NOVEL_ACCESS",
          "lightnovel.app requires login for this book; supply your own session token using QUILLBIND_LIGHTNOVEL_TOKEN",
        );
      fail(
        "NOVEL_API",
        "lightnovel.app API connection failed; check site availability and your session token",
      );
    }
  }
  async close() {
    await this.connection.stop();
  }
}
const infoSchema = z.object({
  SeriesTitle: z.string().nullish(),
  Series: z
    .array(
      z.object({
        Id: z.number().int().positive(),
        Title: z.string(),
        Cover: z.string().nullish(),
      }),
    )
    .default([]),
  Book: z.object({
    Id: z.number().int().positive(),
    Type: z.literal("Novel"),
    Title: z.string().min(1),
    Author: z.string().nullish(),
    Introduction: z.string().nullish(),
    Cover: z.string().nullish(),
    Chapters: z.array(
      z.object({
        Id: z.number().int().positive(),
        SortNum: z.number().int().nonnegative(),
        Title: z.string().min(1),
      }),
    ),
  }),
});

export class ShelfSource implements NovelSource {
  constructor(
    private http: NovelHttp,
    private hub: NovelHub = new ShelfHub(http),
  ) {}
  private async info(id: number) {
    const parsed = infoSchema.safeParse(
      await this.hub.invoke("GetBookInfo", { Id: id }),
    );
    if (!parsed.success || parsed.data.Book.Id !== id)
      fail(
        "NOVEL_RESPONSE",
        "lightnovel.app returned invalid or mismatched book data",
      );
    return parsed.data;
  }
  async catalog(): Promise<NovelCatalog> {
    const address = this.http.address,
      first = await this.info(Number(address.id));
    const series = first.Series.length
      ? first.Series
      : [{ Id: first.Book.Id, Title: first.Book.Title }];
    if (
      !series.some((item) => item.Id === first.Book.Id) ||
      new Set(series.map((item) => item.Id)).size !== series.length
    )
      fail("NOVEL_CATALOG", "lightnovel.app returned an inconsistent series");
    const volumes: NovelVolume[] = [];
    for (const item of series) {
      const info = item.Id === first.Book.Id ? first : await this.info(item.Id);
      const book = info.Book;
      const ordered = [...book.Chapters].sort((a, b) => a.SortNum - b.SortNum);
      if (
        new Set(ordered.map((chapter) => chapter.SortNum)).size !==
        ordered.length
      )
        fail(
          "NOVEL_CATALOG",
          "lightnovel.app returned duplicate chapter order numbers",
        );
      volumes.push({
        number: volumes.length + 1,
        id: String(book.Id),
        title: book.Title,
        ...(book.Cover
          ? {
              cover: remoteUrl(book.Cover, "https://api.lightnovel.life/").href,
            }
          : {}),
        chapters: ordered.map((chapter) => ({
          id: String(chapter.Id),
          title: chapter.Title,
          bookId: book.Id,
          sortNum: chapter.SortNum,
          url: new URL(`/read/${book.Id}/${chapter.SortNum}`, address.url).href,
        })),
      });
    }
    return checkCatalog({
      ...address,
      title: first.SeriesTitle || first.Book.Title,
      authors: first.Book.Author ? [first.Book.Author] : [],
      description: plainHtml(first.Book.Introduction ?? ""),
      language: "zh-Hans",
      cover: volumes[0].cover,
      volumes,
      diagnostics: [],
    });
  }
  async chapter(chapter: NovelChapter) {
    const response = await this.hub.invoke("GetNovelContent", {
      Bid: chapter.bookId!,
      SortNum: chapter.sortNum!,
    });
    const parsed = z
      .object({
        Chapter: z.object({
          BookId: z.number(),
          Id: z.number(),
          SortNum: z.number(),
          Content: z.string(),
          Font: z.string().nullish(),
        }),
      })
      .safeParse(response);
    if (
      !parsed.success ||
      parsed.data.Chapter.BookId !== chapter.bookId ||
      parsed.data.Chapter.SortNum !== chapter.sortNum ||
      String(parsed.data.Chapter.Id) !== chapter.id
    )
      fail("NOVEL_RESPONSE", "lightnovel.app returned the wrong chapter");
    if (parsed.data.Chapter.Font)
      fail(
        "NOVEL_SOURCE_FONT",
        "This chapter needs a site-specific reading font; importing it as ordinary text would corrupt its characters",
      );
    assertComplete(parsed.data.Chapter.Content);
    return [
      {
        html: parsed.data.Chapter.Content,
        url: "https://api.lightnovel.life/",
      },
    ];
  }
  async close() {
    await this.hub.close();
  }
}
