import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { setTimeout as pause } from "node:timers/promises";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { isPublicAddress } from "./metadata.js";
import { checkAbort, fail } from "./errors.js";
import { sha256 } from "./hash.js";
import type { NovelAddress } from "./novel-model.js";

export const novelUserAgent =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const sites = {
  bilinovel: [
    "bilinovel.com",
    "www.bilinovel.com",
    "linovelib.com",
    "www.linovelib.com",
    "tw.linovelib.com",
  ],
  "lightnovel-fun": ["lightnovel.fun", "www.lightnovel.fun"],
  "lightnovel-app": [
    "lightnovel.app",
    "www.lightnovel.app",
    "api.lightnovel.life",
  ],
};
export function remoteUrl(value: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    fail("NOVEL_URL", "Expected a supported HTTPS book URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname.endsWith(".")
  )
    fail(
      "SSRF_BLOCKED",
      "Novel requests require HTTPS without credentials or a custom port",
    );
  url.hash = "";
  return url;
}
export function novelAddress(value: string): NovelAddress {
  const url = remoteUrl(value);
  const site = (Object.keys(sites) as NovelAddress["site"][]).find((site) =>
    sites[site].includes(url.hostname),
  );
  if (!site || url.hostname === "api.lightnovel.life")
    fail(
      "NOVEL_SITE_UNSUPPORTED",
      "Supported sites: bilinovel.com, lightnovel.fun and lightnovel.app",
    );
  const match =
    site === "bilinovel"
      ? /^\/novel\/(\d+)(?:\.html|\/catalog\/?|\/vol_\d+\.html)$/.exec(
          url.pathname,
        )
      : site === "lightnovel-fun"
        ? /^\/(?:cn\/|tw\/)?book\/(\d+)\/?$/.exec(url.pathname)
        : /^\/book\/info\/(\d+)\/?$/.exec(url.pathname);
  if (!match)
    fail(
      "NOVEL_BOOK_URL",
      "Supply a book page, not a home or reader page: /novel/ID.html, /book/ID or /book/info/ID",
    );
  url.search = "";
  if (site === "bilinovel") url.pathname = `/novel/${match[1]}.html`;
  return { site, id: match[1], url: url.href };
}
export interface NovelRequest {
  url: string;
  method: "GET" | "POST" | "DELETE";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  maxBytes: number;
  timeout: number;
}
export interface NovelResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Buffer;
}
export type NovelFetcher = (request: NovelRequest) => Promise<NovelResponse>;
export interface NovelNetworkOptions {
  signal?: AbortSignal;
  delayMs?: number;
  fetcher?: NovelFetcher;
  /** Supplied explicitly by the caller; never persisted in books or reports. */
  token?: string;
}

/** DNS is validated once and the connection is pinned to that address. */
export const fetchNovel: NovelFetcher = async (input) => {
  const url = remoteUrl(input.url);
  const timeout = AbortSignal.timeout(input.timeout);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  checkAbort(signal);
  let onAbort: () => void = () => {};
  let addresses;
  try {
    addresses = await Promise.race([
      lookup(url.hostname, { all: true }),
      new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Novel request cancelled"),
          );
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  // VPN Fake-IP answers are not destinations. Resolve public A records over
  // authenticated DoH, then apply the same address checks and connection pin.
  if (
    addresses.length &&
    addresses.every((item) => /^198\.(?:18|19)\./.test(item.address))
  ) {
    const resolver = new URL("https://dns.google/resolve");
    resolver.search = new URLSearchParams({
      name: url.hostname,
      type: "A",
      edns_client_subnet: "0.0.0.0/0",
    }).toString();
    const response = await requestAt(
      {
        url: resolver.href,
        method: "GET",
        headers: { accept: "application/json" },
        maxBytes: 65536,
        timeout: input.timeout,
      },
      resolver,
      "8.8.8.8",
      signal,
    );
    let data: {
      Status?: number;
      TC?: boolean;
      Answer?: { type: number; data: string }[];
    };
    try {
      data = JSON.parse(response.bytes.toString());
    } catch {
      fail("NOVEL_DNS", "Public DNS returned an invalid response");
    }
    if (
      response.status !== 200 ||
      data.Status !== 0 ||
      data.TC ||
      !Array.isArray(data.Answer)
    )
      fail("NOVEL_DNS", "Cannot resolve a public address for the novel source");
    addresses = data.Answer.filter(
      (item) => item.type === 1 && typeof item.data === "string",
    ).map((item) => ({ address: item.data, family: 4 }));
  }
  checkAbort(signal);
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicAddress(item.address))
  )
    fail("SSRF_BLOCKED", "Novel host resolves to a non-public address");
  const address = addresses.find((item) => item.family === 4) ?? addresses[0];
  return requestAt(input, url, address.address, signal);
};

function requestAt(
  input: NovelRequest,
  url: URL,
  address: string,
  signal: AbortSignal,
): Promise<NovelResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: address,
        servername: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: input.method,
        signal,
        headers: { ...input.headers, host: url.hostname },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.maxBytes)
            response.destroy(
              Object.assign(
                new Error("Novel response exceeds the request size limit"),
                { code: "NOVEL_RESPONSE_LIMIT" },
              ),
            );
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            let bytes = Buffer.concat(chunks);
            const encoding = response.headers["content-encoding"];
            const decompress =
              encoding === "gzip"
                ? gunzipSync
                : encoding === "br"
                  ? brotliDecompressSync
                  : encoding === "deflate"
                    ? inflateSync
                    : undefined;
            if (decompress)
              bytes = decompress(bytes, { maxOutputLength: input.maxBytes });
            else if (encoding && encoding !== "identity")
              fail("NOVEL_ENCODING", "Unsupported HTTP content encoding");
            resolve({
              status: response.statusCode ?? 0,
              headers: Object.fromEntries(
                Object.entries(response.headers).map(([k, v]) => [
                  k,
                  Array.isArray(v) ? v.join(", ") : (v ?? ""),
                ]),
              ),
              bytes,
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(input.body);
  });
}

export class NovelHttp {
  readonly evidence: {
    url: string;
    method: string;
    sha256: string;
    size: number;
  }[] = [];
  private nextRequest = 0;
  readonly delayMs: number;
  constructor(
    readonly address: NovelAddress,
    readonly options: NovelNetworkOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 1000;
    if (
      !Number.isInteger(this.delayMs) ||
      this.delayMs < 0 ||
      this.delayMs > 60000
    )
      fail(
        "NOVEL_OPTIONS",
        "--delay must be an integer from 0 to 60000 milliseconds",
      );
    if (process.env.CI && !options.fetcher)
      fail("CI_NETWORK_DISABLED", "Novel network access is disabled in CI");
  }
  allowed(url: string, asset = false) {
    const parsed = remoteUrl(url);
    if (!asset && !sites[this.address.site].includes(parsed.hostname))
      fail(
        "SSRF_BLOCKED",
        "Novel page is outside the selected site's host allowlist",
      );
    return parsed;
  }
  async throttle(signal = this.options.signal) {
    const now = Date.now();
    const wait = Math.max(0, this.nextRequest - now);
    this.nextRequest = now + wait + this.delayMs;
    await pause(wait, undefined, { signal });
  }
  async read(
    url: string,
    options: {
      asset?: boolean;
      referer?: string;
      method?: NovelRequest["method"];
      body?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      timeout?: number;
      protocol?: boolean;
    } = {},
  ): Promise<NovelResponse & { url: string }> {
    let current = this.allowed(url, options.asset);
    const signal =
      options.signal && this.options.signal
        ? AbortSignal.any([options.signal, this.options.signal])
        : (options.signal ?? this.options.signal);
    for (let redirects = 0, retries = 0; ;) {
      checkAbort(signal);
      if (!options.protocol) await this.throttle(signal);
      const response = await (this.options.fetcher ?? fetchNovel)({
        url: current.href,
        method: options.method ?? "GET",
        body: options.body,
        signal,
        timeout: options.timeout ?? 30000,
        maxBytes: options.asset ? 32 * 1024 * 1024 : 16 * 1024 * 1024,
        headers: {
          "user-agent": novelUserAgent,
          accept: options.asset
            ? "image/*"
            : "text/html,application/json;q=0.9,*/*;q=0.8",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "zh-CN,zh;q=0.9",
          referer: options.referer ?? this.address.url,
          ...(this.address.site === "bilinovel" && !options.asset
            ? { cookie: "night=0" }
            : {}),
          ...options.headers,
        },
      });
      checkAbort(signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (
          options.protocol ||
          options.method === "POST" ||
          ++redirects > 5 ||
          !response.headers.location
        )
          fail("NOVEL_REDIRECT", "Unexpected redirect from novel source");
        const next = this.allowed(
          remoteUrl(response.headers.location, current.href).href,
          options.asset,
        );
        if (options.headers && next.origin !== current.origin)
          fail(
            "NOVEL_REDIRECT",
            "Cannot forward request headers across origins",
          );
        current = next;
        continue;
      }
      if (
        !options.protocol &&
        (response.status === 429 || response.status >= 500) &&
        retries++ < 2
      ) {
        const retryAfter = response.headers["retry-after"];
        const requestedDelay = retryAfter
          ? /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Date.parse(retryAfter) - Date.now()
          : 0;
        if (requestedDelay > 60000)
          fail(
            "NOVEL_RATE_LIMIT",
            "Source requests a longer pause; try again later",
          );
        await pause(
          Math.max(1000 * 2 ** retries, requestedDelay || 0),
          undefined,
          { signal },
        );
        continue;
      }
      if (!options.protocol && response.status !== 200) {
        if ([401, 403].includes(response.status))
          fail(
            "NOVEL_ACCESS",
            `Source denied access (${response.status}); open the book in your browser to check access`,
          );
        fail("NOVEL_HTTP", `Novel source returned HTTP ${response.status}`);
      }
      if (!options.protocol)
        this.evidence.push({
          url: current.href,
          method: options.method ?? "GET",
          sha256: sha256(response.bytes),
          size: response.bytes.length,
        });
      return { ...response, url: current.href };
    }
  }
  async html(url: string) {
    const response = await this.read(url);
    const charset =
      /charset\s*=\s*["']?([^\s;"'>]+)/i.exec(
        response.headers["content-type"] ?? "",
      )?.[1] ?? "utf-8";
    let html: string;
    try {
      html = new TextDecoder(charset).decode(response.bytes);
    } catch {
      fail("NOVEL_ENCODING", "Unsupported novel page character encoding");
    }
    if (
      /<title[^>]*>\s*(?:Just a moment|Attention Required)|cf-chl-widget|id=["']challenge-form["']/i.test(
        html,
      )
    )
      fail(
        "NOVEL_ACCESS",
        "Source returned a browser challenge instead of book content",
      );
    return { html, url: response.url };
  }
  async post(url: string, body: unknown) {
    const response = await this.read(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    try {
      return JSON.parse(response.bytes.toString()) as unknown;
    } catch {
      fail("NOVEL_RESPONSE", "Source returned invalid JSON");
    }
  }
}
