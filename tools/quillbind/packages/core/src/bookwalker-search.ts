import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import { z } from "zod";
import { bookWalkerAddress } from "./bookwalker-model.js";
import type { BookWalkerOptions } from "./bookwalker-http.js";
import { checkAbort, fail } from "./errors.js";
import { readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stable } from "./json.js";
import { fetchNovel } from "./novel-http.js";

const text = z.string().trim().min(1).max(10000);
const httpsUrl = text.refine((value) => {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port
    );
  } catch {
    return false;
  }
}, "Expected an HTTPS URL without credentials or custom port");

export const bookWalkerSearchSiteSchema = z.enum(["jp", "tw"]);
export type BookWalkerSearchSite = z.infer<typeof bookWalkerSearchSiteSchema>;

export const bookWalkerSearchQuerySchema = z.strictObject({
  query: z.string().trim().min(1).max(200),
  sites: z.array(bookWalkerSearchSiteSchema).min(1).max(2).optional(),
  kind: z.enum(["light-novel", "manga"]).optional(),
});
export type BookWalkerSearchQuery = z.infer<typeof bookWalkerSearchQuerySchema>;

export const bookWalkerSearchCandidateSchema = z.strictObject({
  site: bookWalkerSearchSiteSchema,
  url: httpsUrl,
  title: text,
  kind: z.enum(["light-novel", "manga"]).optional(),
  number: z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .nullable(),
  creators: z.array(text).max(50),
  imprint: text.optional(),
  seriesUrl: httpsUrl.optional(),
  coverUrl: httpsUrl.optional(),
});
export type BookWalkerSearchCandidate = z.infer<
  typeof bookWalkerSearchCandidateSchema
>;

export const bookWalkerSearchRequestSchema = z.strictObject({
  site: bookWalkerSearchSiteSchema,
  url: httpsUrl,
  status: z.number().int().min(100).max(599),
  retrievedAt: z.iso.datetime(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  candidateCount: z.number().int().min(0),
});
export type BookWalkerSearchRequest = z.infer<
  typeof bookWalkerSearchRequestSchema
>;

export interface BookWalkerSearchDiagnostic {
  code: string;
  severity: "warning" | "error";
  site?: BookWalkerSearchSite;
  message: string;
}

export interface BookWalkerSearchLock {
  schemaVersion: 1;
  query: BookWalkerSearchQuery;
  sites: BookWalkerSearchSite[];
  requests: BookWalkerSearchRequest[];
  candidates: BookWalkerSearchCandidate[];
  diagnostics: BookWalkerSearchDiagnostic[];
  digest: string;
}

const clean = (value: unknown) =>
  typeof value === "string" || typeof value === "number"
    ? String(value).replace(/\s+/g, " ").trim().normalize("NFC")
    : "";

const volumeFromTitle = (title: string): string | null => {
  const normalized = title.normalize("NFKC");
  const parenthesized = /[(\uff08]\s*0*(\d+(?:\.\d+)?)\s*[)\uff09]/.exec(
    normalized,
  );
  if (parenthesized) return String(Number(parenthesized[1]));
  const match =
    /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(?:巻|卷|冊|册|集|\))?(?:\s*【[^】]*】)*$/.exec(
      normalized,
    );
  return match ? String(Number(match[1])) : null;
};

const safeHttpsUrl = (raw: string | undefined, base: string) => {
  if (!raw?.trim()) return undefined;
  try {
    const resolved = new URL(raw.trim(), base);
    if (
      resolved.protocol !== "https:" ||
      resolved.username ||
      resolved.password ||
      resolved.port
    )
      return undefined;
    resolved.hash = "";
    return resolved.href;
  } catch {
    return undefined;
  }
};

const tryProductUrl = (raw: string | undefined, base: string) => {
  const href = safeHttpsUrl(raw, base);
  if (!href) return undefined;
  try {
    return bookWalkerAddress(href).url;
  } catch {
    return undefined;
  }
};

const splitNames = (raw: string) => [
  ...new Set(
    raw
      .split(/[、,，/／;；\n]+/u)
      .map((item) =>
        item
          .trim()
          .replace(
            /^(?:著者[・/／]イラスト|著者|作者|漫画|マンガ|原作|イラスト|挿絵|訳者|翻訳|キャラクター原案)\s*[:：]\s*/u,
            "",
          )
          .replace(/\s*[(（][^()（）]+[)）]\s*$/u, "")
          .trim(),
      )
      .filter(Boolean),
  ),
];

export function parseBookWalkerSearch(
  html: string,
  site: BookWalkerSearchSite,
  filterKind?: "light-novel" | "manga",
): BookWalkerSearchCandidate[] {
  const $ = load(html);
  const candidates: BookWalkerSearchCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: BookWalkerSearchCandidate) => {
    if (seen.has(candidate.url)) return;
    if (filterKind && candidate.kind && candidate.kind !== filterKind) return;
    seen.add(candidate.url);
    candidates.push(candidate);
  };

  if (site === "jp") {
    const base = "https://bookwalker.jp";
    $(".m-book-item, .o-tile, .m-tile").each((_, element) => {
      const card = $(element);
      const productAnchor = card
        .find('a[href*="/de"]')
        .filter((__, node) =>
          Boolean(tryProductUrl($(node).attr("href"), base)),
        )
        .first();
      const url = tryProductUrl(productAnchor.attr("href"), base);
      if (!url) return;
      const titleNode = card
        .find(".m-book-item__title a, a.m-book-item__title")
        .first();
      const title =
        clean(titleNode.attr("title")) ||
        clean(titleNode.text()) ||
        clean(productAnchor.attr("title")) ||
        clean(card.find("img[alt]").first().attr("alt"));
      if (!title) return;
      const tagText = clean(
        card.find(".m-book-item__tag-box, [class*='a-tag-']").text(),
      );
      const hasLnClass = card.find(".a-tag-LN").length > 0;
      const hasMangaClass = card.find(".a-tag-manga, .a-tag-comic").length > 0;
      const kind: BookWalkerSearchCandidate["kind"] =
        hasMangaClass || /マンガ|コミック/u.test(tagText)
          ? "manga"
          : hasLnClass || /ラノベ|ライトノベル|新文芸/u.test(tagText)
            ? "light-novel"
            : undefined;
      const creators = splitNames(
        clean(card.find(".m-book-item__author").text()),
      );
      const imprint =
        clean(card.find(".m-book-item__label").first().text()) || undefined;
      const rawSeries = card.find('a[href*="/series/"]').first().attr("href");
      const seriesUrl = safeHttpsUrl(rawSeries, base);
      const img = card.find(".m-thumb img, img").first();
      const rawCover = img.attr("data-original") || img.attr("src");
      const coverUrl =
        rawCover && !rawCover.includes("bg-now-loading")
          ? safeHttpsUrl(rawCover, base)
          : undefined;
      push({
        site: "jp",
        url,
        title,
        ...(kind ? { kind } : {}),
        number: volumeFromTitle(title),
        creators,
        ...(imprint ? { imprint } : {}),
        ...(seriesUrl ? { seriesUrl } : {}),
        ...(coverUrl ? { coverUrl } : {}),
      });
    });
    return candidates;
  }

  const base = "https://www.bookwalker.com.tw";
  $(".book_package, .bookitem").each((_, element) => {
    const card = $(element);
    if (card.is(".bookitem") && card.closest(".book_package").length > 0)
      return;
    const anchor = card
      .find('a[href*="/product/"]')
      .filter((__, node) => Boolean(tryProductUrl($(node).attr("href"), base)))
      .first();
    const url = tryProductUrl(anchor.attr("href"), base);
    if (!url) return;
    const category = clean(card.find(".cat-label").first().text());
    let kind: BookWalkerSearchCandidate["kind"];
    if (category) {
      if (category.includes("漫畫")) kind = "manga";
      else if (category.includes("輕小說")) kind = "light-novel";
      else return;
    }
    const title =
      clean(card.find("h4.bookname, .bookname").first().text()) ||
      clean(anchor.attr("title")) ||
      clean(card.find("img[alt]").first().attr("alt"));
    if (!title) return;
    const creators = splitNames(
      clean(card.find("h5.booknamesub, .booknamesub").first().text()),
    );
    const imprint = clean(card.find(".lablename").first().text()) || undefined;
    const img = card.find(".bookcover img, img").first();
    const coverUrl = safeHttpsUrl(
      img.attr("data-src") || img.attr("src"),
      base,
    );
    push({
      site: "tw",
      url,
      title,
      ...(kind ? { kind } : {}),
      number: volumeFromTitle(title),
      creators,
      ...(imprint ? { imprint } : {}),
      ...(coverUrl ? { coverUrl } : {}),
    });
  });
  return candidates;
}

function queryFrom(value: unknown): BookWalkerSearchQuery {
  const parsed = bookWalkerSearchQuerySchema.safeParse(value);
  if (!parsed.success)
    fail(
      "BOOKWALKER_SEARCH_QUERY",
      "Supply a non-empty search query and optional sites/kind",
      parsed.error.issues,
    );
  const data = parsed.data;
  return {
    query: data.query,
    ...(data.sites ? { sites: [...new Set(data.sites)] } : {}),
    ...(data.kind ? { kind: data.kind } : {}),
  };
}

function searchUrl(query: BookWalkerSearchQuery, site: BookWalkerSearchSite) {
  if (site === "jp") {
    const params = new URLSearchParams({ word: query.query, np: "1" });
    if (query.kind === "light-novel") params.set("qcat", "3");
    else if (query.kind === "manga") params.set("qcat", "2");
    return `https://bookwalker.jp/search/?${params.toString()}`;
  }
  const params = new URLSearchParams({ w: query.query });
  return `https://www.bookwalker.com.tw/search?${params.toString()}`;
}

const allowedSearchHosts: Record<BookWalkerSearchSite, readonly string[]> = {
  jp: ["bookwalker.jp", "www.bookwalker.jp"],
  tw: ["www.bookwalker.com.tw", "bookwalker.com.tw"],
};

async function fetchSearchPage(
  url: string,
  site: BookWalkerSearchSite,
  options: BookWalkerOptions,
) {
  if (process.env.CI && !options.fetcher)
    fail(
      "CI_NETWORK_DISABLED",
      "Live BookWalker search requests are disabled in CI",
    );
  let current = new URL(url);
  const maxBytes = 4 * 1024 * 1024;
  for (let redirects = 0; redirects <= 3; redirects++) {
    checkAbort(options.signal);
    if (
      current.protocol !== "https:" ||
      current.username ||
      current.password ||
      current.port ||
      !allowedSearchHosts[site].includes(current.hostname)
    )
      fail(
        "BOOKWALKER_URL",
        `Disallowed BookWalker search URL: ${current.href}`,
      );
    const response = await (options.fetcher ?? fetchNovel)({
      url: current.href,
      method: "GET",
      signal: options.signal,
      timeout: 20000,
      maxBytes,
      headers: {
        "user-agent": "Quillbind/0.1 (public book metadata)",
        accept: "text/html",
        "accept-encoding": "gzip, deflate, br",
      },
    });
    checkAbort(options.signal);
    if (response.bytes.length > maxBytes)
      fail("BOOKWALKER_LIMIT", "BookWalker search response exceeds 4 MiB");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location)
        fail(
          "BOOKWALKER_REDIRECT",
          "Missing BookWalker search redirect location",
        );
      current = new URL(response.headers.location, current);
      continue;
    }
    return {
      status: response.status,
      bytes: response.bytes,
      finalUrl: current.href,
    };
  }
  fail("BOOKWALKER_REDIRECT", "Too many BookWalker search redirects");
}

export async function collectBookWalkerSearch(
  input: unknown,
  options: BookWalkerOptions & { now?: () => Date } = {},
): Promise<BookWalkerSearchLock> {
  if (!options.online)
    fail(
      "BOOKWALKER_OFFLINE",
      "Use a saved BookWalker search lock or explicitly request --online",
    );
  const query = queryFrom(input);
  const sites: BookWalkerSearchSite[] = query.sites ?? ["jp", "tw"];
  const requests: BookWalkerSearchRequest[] = [];
  const candidates: BookWalkerSearchCandidate[] = [];
  const diagnostics: BookWalkerSearchDiagnostic[] = [];
  const seen = new Set<string>();

  for (const site of sites) {
    const url = searchUrl(query, site);
    try {
      const response = await fetchSearchPage(url, site, options);
      const parsed =
        response.status === 200
          ? parseBookWalkerSearch(
              response.bytes.toString("utf8"),
              site,
              query.kind,
            )
          : [];
      requests.push({
        site,
        url,
        status: response.status,
        retrievedAt: (options.now?.() ?? new Date()).toISOString(),
        sha256: sha256(response.bytes),
        candidateCount: parsed.length,
      });
      if (response.status !== 200) {
        diagnostics.push({
          code: "BOOKWALKER_SEARCH_HTTP",
          severity: "warning",
          site,
          message: `BookWalker ${site.toUpperCase()} search returned HTTP ${response.status}`,
        });
      }
      for (const item of parsed) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          candidates.push(item);
        }
      }
    } catch (error) {
      checkAbort(options.signal);
      const code = (error as { code?: string })?.code;
      if (
        code === "CI_NETWORK_DISABLED" ||
        code === "SSRF_BLOCKED" ||
        code === "CANCELLED"
      )
        throw error;
      diagnostics.push({
        code: "BOOKWALKER_SEARCH_ERROR",
        severity: "warning",
        site,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!requests.some((item) => item.status === 200))
    fail(
      "BOOKWALKER_SEARCH_UNAVAILABLE",
      "All selected BookWalker search endpoints failed",
      diagnostics,
    );

  if (!candidates.length)
    diagnostics.push({
      code: "BOOKWALKER_SEARCH_NO_MATCH",
      severity: "warning",
      message: "No matching BookWalker light-novel or manga products found",
    });

  const content = {
    schemaVersion: 1 as const,
    query,
    sites,
    requests,
    candidates,
    diagnostics,
  };
  return { ...content, digest: sha256(stable(content)) };
}

export function readBookWalkerSearchLock(source: string): BookWalkerSearchLock {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail("BOOKWALKER_SEARCH_LOCK", "Invalid BookWalker search JSON lock");
  }
  const parsed = z
    .strictObject({
      schemaVersion: z.literal(1),
      query: bookWalkerSearchQuerySchema,
      sites: z.array(bookWalkerSearchSiteSchema).min(1).max(2),
      requests: z.array(bookWalkerSearchRequestSchema).min(1).max(2),
      candidates: z.array(bookWalkerSearchCandidateSchema).max(500),
      diagnostics: z.array(
        z.strictObject({
          code: text,
          severity: z.enum(["warning", "error"]),
          site: bookWalkerSearchSiteSchema.optional(),
          message: text,
        }),
      ),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .safeParse(value);
  if (!parsed.success)
    fail(
      "BOOKWALKER_SEARCH_LOCK",
      "Invalid BookWalker search lock structure",
      parsed.error.issues,
    );
  const { digest, ...content } = parsed.data;
  const query = queryFrom(content.query);
  if (
    digest !== sha256(stable(content)) ||
    stable(query) !== stable(content.query)
  )
    fail(
      "BOOKWALKER_SEARCH_LOCK",
      "BookWalker search lock content changed; run search again",
    );
  return { ...content, query, digest };
}

export async function resolveBookWalkerSearch(
  file: string,
  options: BookWalkerOptions & { output: string; now?: () => Date },
) {
  let raw: unknown;
  try {
    raw = JSON.parse((await readSourceFile(file)).toString("utf8"));
  } catch {
    fail("BOOKWALKER_SEARCH_QUERY", "Invalid BookWalker search query JSON");
  }
  const query = queryFrom(raw);
  const output = path.resolve(options.output);
  if (!options.online) {
    const lock = readBookWalkerSearchLock(
      (await readSourceFile(output)).toString("utf8"),
    );
    if (stable(lock.query) !== stable(query))
      fail(
        "BOOKWALKER_SEARCH_LOCK_STALE",
        "Search query changed; create a new online search lock",
      );
    return {
      status: "pass" as const,
      operation: "bookwalker-search",
      query: lock.query,
      candidates: lock.candidates,
      diagnostics: lock.diagnostics,
      lock: output,
      digest: lock.digest,
      mode: "offline" as const,
    };
  }
  const lock = await collectBookWalkerSearch(query, options);
  checkAbort(options.signal);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, stable(lock) + "\n", { flag: "wx" });
    checkAbort(options.signal);
    await fs.link(temporary, output).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        fail(
          "OUTPUT_EXISTS",
          "Search locks are immutable; select a new output path",
        );
      throw error;
    });
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return {
    status: "pass" as const,
    operation: "bookwalker-search",
    query: lock.query,
    candidates: lock.candidates,
    diagnostics: lock.diagnostics,
    lock: output,
    digest: lock.digest,
    mode: "online" as const,
  };
}
