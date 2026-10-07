import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { gzipSync } from "node:zlib";
import {
  fetchNovel,
  NovelHttp,
  novelAddress,
  type NovelRequest,
} from "../packages/core/src/novel-http.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
const lookupAll = vi.mocked(
  lookup as (host: string, options: { all: true }) => Promise<LookupAddress[]>,
);
const input: NovelRequest = {
  url: "https://www.bilinovel.com/novel/42.html",
  method: "GET",
  headers: {},
  maxBytes: 1024,
  timeout: 1000,
};
beforeEach(() => {
  lookupAll.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
});
afterEach(() => {
  vi.resetAllMocks();
});

function responses(
  ...replies: {
    bytes: Buffer;
    headers?: Record<string, string>;
    status?: number;
  }[]
) {
  const calls: RequestOptions[] = [];
  vi.mocked(request).mockImplementation(((
    options: RequestOptions,
    callback: (message: IncomingMessage) => void,
  ) => {
    calls.push(options);
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      queueMicrotask(() => {
        const reply = replies.shift();
        if (!reply) {
          req.emit("error", new Error("Unexpected network request"));
          return;
        }
        const response = new EventEmitter() as IncomingMessage;
        response.headers = reply.headers ?? {};
        response.statusCode = reply.status ?? 200;
        response.destroy = ((error: Error) => {
          response.destroyed = true;
          response.emit("error", error);
          return response;
        }) as typeof response.destroy;
        callback(response);
        response.emit("data", reply.bytes);
        if (!response.destroyed) response.emit("end");
      });
      return req;
    }) as typeof req.end;
    return req;
  }) as typeof request);
  return calls;
}
it("pins the validated DNS answer while retaining the TLS and Host identity", async () => {
  const calls = responses({ bytes: Buffer.from("ok") });
  expect((await fetchNovel(input)).bytes.toString()).toBe("ok");
  expect(calls[0]).toMatchObject({
    hostname: "1.1.1.1",
    servername: "www.bilinovel.com",
    headers: { host: "www.bilinovel.com" },
  });
  expect(lookup).toHaveBeenCalledTimes(1);
});
it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "2001:db8::1"])(
  "rejects private or reserved DNS answer %s before connecting",
  async (address) => {
    lookupAll.mockResolvedValue([
      { address, family: address.includes(":") ? 6 : 4 },
    ]);
    await expect(fetchNovel(input)).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
    expect(request).not.toHaveBeenCalled();
  },
);
it("rejects mixed public and private DNS answers", async () => {
  lookupAll.mockResolvedValue([
    { address: "1.1.1.1", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ]);
  await expect(fetchNovel(input)).rejects.toMatchObject({
    code: "SSRF_BLOCKED",
  });
  expect(request).not.toHaveBeenCalled();
});
it.each(["1.1.1.1", "127.0.0.1"])(
  "validates DoH answers after VPN Fake-IP resolution: %s",
  async (address) => {
    lookupAll.mockResolvedValue([{ address: "198.18.0.8", family: 4 }]);
    const calls = responses(
      {
        bytes: Buffer.from(
          JSON.stringify({ Status: 0, Answer: [{ type: 1, data: address }] }),
        ),
      },
      { bytes: Buffer.from("source") },
    );
    if (address === "1.1.1.1")
      expect((await fetchNovel(input)).bytes.toString()).toBe("source");
    else
      await expect(fetchNovel(input)).rejects.toMatchObject({
        code: "SSRF_BLOCKED",
      });
    expect(calls[0]).toMatchObject({
      hostname: "8.8.8.8",
      servername: "dns.google",
    });
    expect(calls[0].headers).not.toHaveProperty("authorization");
    expect(calls).toHaveLength(address === "1.1.1.1" ? 2 : 1);
  },
);
it("bounds both transferred and decompressed response sizes", async () => {
  responses({ bytes: Buffer.alloc(1025) });
  await expect(fetchNovel(input)).rejects.toMatchObject({
    code: "NOVEL_RESPONSE_LIMIT",
  });
  responses({
    bytes: gzipSync(Buffer.alloc(10000)),
    headers: { "content-encoding": "gzip" },
  });
  await expect(fetchNovel(input)).rejects.toThrow();
  responses({
    bytes: gzipSync(Buffer.from("正文")),
    headers: { "content-encoding": "gzip" },
  });
  expect((await fetchNovel(input)).bytes.toString()).toBe("正文");
});
it("cancels pending DNS promptly and never opens a later connection", async () => {
  let finish: (value: { address: string; family: number }[]) => void = () => {};
  lookupAll.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const abort = new AbortController(),
    reason = new Error("cancelled by caller");
  const pending = fetchNovel({ ...input, signal: abort.signal });
  abort.abort(reason);
  await expect(pending).rejects.toBe(reason);
  finish([{ address: "1.1.1.1", family: 4 }]);
  expect(request).not.toHaveBeenCalled();
});
it("bounds DNS resolution by the request timeout", async () => {
  lookupAll.mockImplementation(() => new Promise(() => {}));
  await expect(fetchNovel({ ...input, timeout: 20 })).rejects.toMatchObject({
    name: "TimeoutError",
  });
  expect(request).not.toHaveBeenCalled();
});
it("honors a server's long retry delay without issuing more requests", async () => {
  const fetcher = vi.fn(async () => ({
    status: 429,
    headers: { "retry-after": "120" },
    bytes: Buffer.alloc(0),
  }));
  const http = new NovelHttp(novelAddress(input.url), { fetcher, delayMs: 0 });
  await expect(http.read(input.url)).rejects.toMatchObject({
    code: "NOVEL_RATE_LIMIT",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
