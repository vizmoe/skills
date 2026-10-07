import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { checkAbort, fail } from "./errors.js";
import { sha256 } from "./hash.js";
import { stable } from "./json.js";

export const conversionTargets = [
  "simplified",
  "traditional",
  "china",
  "taiwan",
  "hongkong",
] as const;
export type ConversionTarget = (typeof conversionTargets)[number];
const converters: Record<ConversionTarget, string> = {
  simplified: "Simplified",
  traditional: "Traditional",
  china: "China",
  taiwan: "Taiwan",
  hongkong: "Hongkong",
};
export const conversionLanguages: Record<ConversionTarget, string> = {
  simplified: "zh-Hans",
  traditional: "zh-Hant",
  china: "zh-Hans-CN",
  taiwan: "zh-Hant-TW",
  hongkong: "zh-Hant-HK",
};
export const zhconvertNotice =
  "本程式使用了繁化姬的 API 服務；繁化姬商用必須付費。https://zhconvert.org/";
export function conversionTarget(value: string): ConversionTarget {
  if (!conversionTargets.includes(value as ConversionTarget))
    fail("CONVERSION_TARGET", `Choose ${conversionTargets.join(", ")}`);
  return value as ConversionTarget;
}
export interface ConversionOptions {
  target: ConversionTarget;
  /** Refresh the persistent conversion lock using the online API. */
  online?: boolean;
  signal?: AbortSignal;
  apiKey?: string;
  /** Recorded responses for offline tests; production always uses HTTPS. */
  fetcher?: typeof fetch;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const han = /\p{Script=Han}/u;

// Prefer paragraph/sentence boundaries, retaining every code point and space.
function chunks(text: string, maxBytes: number): string[] {
  const result: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start,
      bytes = 0,
      boundary = start;
    while (end < text.length) {
      const character = String.fromCodePoint(text.codePointAt(end)!);
      const size = Buffer.byteLength(character);
      if (bytes + size > maxBytes) break;
      end += character.length;
      bytes += size;
      if (/[\n。！？；.!?]/u.test(character)) boundary = end;
    }
    if (end === start)
      fail("ZHCONVERT_LIMIT", "Service request limit cannot fit a character");
    if (end < text.length && boundary > start + (end - start) / 2)
      end = boundary;
    result.push(text.slice(start, end));
    start = end;
  }
  return result;
}

/** A response snapshot that can be persisted and frozen for independent builds. */
export class ZhconvertSession {
  readonly target: ConversionTarget;
  private readonly cache = new Map<string, string>();
  private locked?: ReadonlyMap<string, string>;
  private readonly options: ConversionOptions;
  private limit?: number;
  private frozen = false;
  private requests = 0;
  private revision?: string;
  private readonly apiKey: string;
  constructor(options: ConversionOptions) {
    this.target = conversionTarget(options.target);
    this.options = options;
    this.apiKey = options.apiKey ?? process.env.ZHCONVERT_API_KEY ?? "";
  }
  freeze() {
    this.frozen = true;
  }
  restore(
    entries: { sourceSha256: string; text: string }[],
    revision: string | null,
  ) {
    this.locked = new Map(
      entries.map((entry) => [entry.sourceSha256, entry.text]),
    );
    this.revision = revision ?? undefined;
    this.freeze();
  }
  snapshot() {
    return [...this.cache]
      .map(([source, text]) => ({
        sourceSha256: sha256(source),
        outputSha256: sha256(text),
        text,
      }))
      .sort((left, right) =>
        left.sourceSha256.localeCompare(right.sourceSha256, "en"),
      );
  }
  report() {
    const records = [...this.cache].map(([source, output]) => ({
      sourceSha256: sha256(source),
      outputSha256: sha256(output),
    }));
    return {
      status: "pass" as const,
      provider: "https://zhconvert.org/",
      notice: zhconvertNotice,
      target: this.target,
      converter: converters[this.target],
      language: conversionLanguages[this.target],
      revision: this.revision ?? null,
      requests: this.requests,
      uniqueTexts: records.length,
      snapshotSha256: sha256(stable(records)),
      reproducibility: "fixed conversion responses",
    };
  }
  private async request(endpoint: string, body?: string) {
    if (process.env.CI && !this.options.fetcher)
      fail("NETWORK_DISABLED", "CI requires recorded zhconvert responses");
    for (let attempt = 0; ; attempt++) {
      checkAbort(this.options.signal);
      const timeout = AbortSignal.timeout(30_000);
      const signal = this.options.signal
        ? AbortSignal.any([this.options.signal, timeout])
        : timeout;
      try {
        this.requests++;
        const response = await (this.options.fetcher ?? fetch)(
          `https://api.zhconvert.org/${endpoint}`,
          {
            method: body === undefined ? "GET" : "POST",
            headers: {
              Accept: "application/json",
              ...(body === undefined
                ? {}
                : {
                    "Content-Type":
                      "application/x-www-form-urlencoded;charset=UTF-8",
                  }),
            },
            body,
            redirect: "error",
            signal,
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          const retry = response.headers.get("retry-after");
          const wait =
            retry === null
              ? 1000 * 2 ** attempt
              : /^\d+$/.test(retry)
                ? Number(retry) * 1000
                : Math.max(0, Date.parse(retry) - Date.now());
          if (
            attempt < 2 &&
            [429, 502, 503, 504].includes(response.status) &&
            Number.isFinite(wait) &&
            wait <= 30_000
          ) {
            await delay(wait, undefined, { signal: this.options.signal });
            continue;
          }
          fail("ZHCONVERT_HTTP", `zhconvert HTTP ${response.status}`, {
            status: response.status,
          });
        }
        const reader = response.body?.getReader();
        if (!reader) fail("ZHCONVERT_RESPONSE", "Missing API response body");
        const buffers: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 1024 * 1024)
              fail("ZHCONVERT_RESPONSE", "API response exceeds 1 MiB");
            buffers.push(part.value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        checkAbort(this.options.signal);
        let result: Record<string, unknown>;
        try {
          result = object(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(buffers),
              ),
            ),
          );
        } catch {
          fail("ZHCONVERT_RESPONSE", "API returned invalid JSON or UTF-8");
        }
        if (typeof result.code !== "number")
          fail("ZHCONVERT_RESPONSE", "API response is missing its status code");
        if (result.code !== 0)
          fail("ZHCONVERT_API", `zhconvert service error ${result.code}`);
        return result;
      } catch (error) {
        checkAbort(this.options.signal);
        if (timeout.aborted)
          fail("ZHCONVERT_TIMEOUT", "zhconvert request exceeded 30 seconds");
        if (String((error as { code?: unknown }).code).startsWith("ZHCONVERT_"))
          throw error;
        fail("ZHCONVERT_NETWORK", "Could not reach the zhconvert HTTPS API");
      }
    }
  }
  private form(text: string) {
    return new URLSearchParams({
      text,
      converter: converters[this.target],
      modules: '{"*":0}',
      outputFormat: "json",
      diffEnable: "false",
      cleanUpText: "false",
      ensureNewlineAtEof: "false",
      translateTabsToSpaces: "-1",
      trimTrailingWhiteSpaces: "false",
      unifyLeadingHyphen: "false",
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
    }).toString();
  }
  async translate(values: readonly string[]): Promise<string[]> {
    checkAbort(this.options.signal);
    if (this.locked)
      for (const value of values) {
        if (!han.test(value) || this.cache.has(value)) continue;
        const text = this.locked.get(sha256(value));
        if (text !== undefined) this.cache.set(value, text);
      }
    const missing = [
      ...new Set(
        values.filter((value) => han.test(value) && !this.cache.has(value)),
      ),
    ];
    if (missing.length && this.frozen)
      fail(
        "CONVERSION_SNAPSHOT_MISSING",
        "Rebuild text differs from the frozen conversion input",
      );
    if (missing.length) {
      if (this.limit === undefined) {
        const info = object((await this.request("service-info")).data);
        if (
          !Number.isSafeInteger(info.maxPostBodyBytes) ||
          Number(info.maxPostBodyBytes) <= 0 ||
          !object(info.converters)[converters[this.target]] ||
          typeof info.allowEmptyApiKey !== "boolean"
        )
          fail(
            "ZHCONVERT_RESPONSE",
            "Invalid service limits or unavailable converter",
          );
        if (!info.allowEmptyApiKey && !this.apiKey)
          fail("ZHCONVERT_API_KEY", "Set ZHCONVERT_API_KEY for this service");
        this.limit = Math.min(Number(info.maxPostBodyBytes), 64 * 1024);
      }
      const chunkBytes = Math.floor(
        (this.limit - this.form("").length - 512) / 3,
      );
      if (chunkBytes < 4)
        fail(
          "ZHCONVERT_LIMIT",
          "Service request limit is too small for conversion framing",
        );
      const pieces = missing.flatMap((text, index) =>
        chunks(text, chunkBytes).map((text) => ({ text, index })),
      );
      const outputs = missing.map(() => "");
      let nonce: string;
      do {
        nonce = randomUUID();
      } while (missing.some((value) => value.includes(nonce)));
      const marker = (index: number) => `\n<<<quillbind:${nonce}:${index}>>>\n`;
      let start = 0;
      while (start < pieces.length) {
        checkAbort(this.options.signal);
        let text = marker(0),
          end = start;
        while (end < pieces.length) {
          const next = text + pieces[end].text + marker(end - start + 1);
          if (this.form(next).length > this.limit) break;
          text = next;
          end++;
        }
        if (end === start)
          fail(
            "ZHCONVERT_LIMIT",
            "Service request limit cannot fit a text chunk",
          );
        const response = await this.request("convert", this.form(text));
        const data = object(response.data);
        const revision = object(response.revisions).build;
        if (
          typeof data.text !== "string" ||
          data.converter !== converters[this.target] ||
          typeof revision !== "string" ||
          !revision
        )
          fail(
            "ZHCONVERT_RESPONSE",
            "Invalid converted text, converter or dictionary revision",
          );
        if (this.revision && this.revision !== revision)
          fail(
            "ZHCONVERT_REVISION_CHANGED",
            "zhconvert dictionary changed during conversion; rerun the operation",
          );
        this.revision = revision;
        const matches = [
          ...data.text.matchAll(
            new RegExp(`\\n<<<quillbind:${nonce}:(\\d+)>>>\\n`, "g"),
          ),
        ];
        if (
          matches.length !== end - start + 1 ||
          matches.some((match, index) => Number(match[1]) !== index) ||
          matches[0].index !== 0 ||
          matches.at(-1)!.index + matches.at(-1)![0].length !== data.text.length
        )
          fail(
            "ZHCONVERT_FRAMING",
            "API changed text boundaries; conversion was discarded",
          );
        for (let i = start; i < end; i++) {
          const left = matches[i - start],
            right = matches[i - start + 1];
          const value = data.text.slice(
            left.index + left[0].length,
            right.index,
          );
          if (!value && pieces[i].text)
            fail("ZHCONVERT_RESPONSE", "API removed a nonempty text chunk");
          outputs[pieces[i].index] += value;
        }
        start = end;
      }
      missing.forEach((text, index) => this.cache.set(text, outputs[index]));
    }
    return values.map((value) => this.cache.get(value) ?? value);
  }
}
