import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectBookWalker,
  parseBookWalker,
  resolveBookWalker,
} from "../packages/core/src/bookwalker.js";
import type { NovelResponse } from "../packages/core/src/novel-http.js";
import { fetchBookWalker } from "../packages/core/src/bookwalker-http.js";
import { run } from "../packages/core/src/process.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import {
  bookwalkerFetcher,
  japaneseHtml,
  jpUrl,
  selection,
  taiwanHtml,
  twUrl,
} from "./bookwalker-fixture.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
it("replays immutable source locks offline through the CLI and rejects stale selections", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookwalker-"));
  temporary.push(root);
  const file = path.join(root, "sources.json"),
    output = path.join(root, "lock.json");
  await fs.writeFile(file, JSON.stringify(selection));
  await resolveBookWalker(file, {
    output,
    online: true,
    fetcher: bookwalkerFetcher,
  });
  const bytes = await fs.readFile(output);
  expect(await resolveBookWalker(file, { output })).toMatchObject({
    status: "pass",
    mode: "offline",
  });
  const cli = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "packages/cli/src/index.ts",
      "metadata",
      "bookwalker",
      file,
      "--output",
      output,
      "--json",
    ],
    { cwd: repoRoot },
  );
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout)).toMatchObject({
    metadata: { releaseDate: "2020-04-20" },
    mode: "offline",
  });
  await expect(
    resolveBookWalker(file, {
      output,
      online: true,
      fetcher: bookwalkerFetcher,
    }),
  ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
  expect(await fs.readFile(output)).toEqual(bytes);
  expect((await fs.readdir(root)).sort()).toEqual([
    "lock.json",
    "sources.json",
  ]);
  await fs.writeFile(file, JSON.stringify({ ...selection, number: "2" }));
  await expect(resolveBookWalker(file, { output })).rejects.toMatchObject({
    code: "BOOKWALKER_LOCK_STALE",
  });
});
it("rejects missing/contradictory selection evidence and supports Japanese-only editions", async () => {
  for (const input of [
    { ...selection, matchEvidence: [] },
    { ...selection, japaneseUrl: twUrl },
    { ...selection, translatedUrl: jpUrl },
    { ...selection, translatedUrl: undefined },
    { ...selection, language: "ja" },
  ]) {
    await expect(
      collectBookWalker(input, { online: true, fetcher: bookwalkerFetcher }),
    ).rejects.toMatchObject({ code: "BOOKWALKER_SELECTION" });
  }
  const lock = await collectBookWalker(
    { ...selection, language: "ja", translatedUrl: undefined },
    { online: true, fetcher: bookwalkerFetcher },
  );
  expect(lock.records).toHaveLength(1);
  expect(lock.metadata).toMatchObject({
    title: "架空物語 1",
    publisher: "日本出版社",
    language: "ja",
  });
});
it("fails closed on incomplete layouts, mismatched canonical IDs and unknown roles", () => {
  for (const [html, url] of [
    ["<p>Login required</p>", twUrl],
    [japaneseHtml().replace(jpUrl, twUrl), jpUrl],
    [
      japaneseHtml().replace("t-c-detail-about-information__data", "elsewhere"),
      jpUrl,
    ],
    [japaneseHtml().replace("(著者)", "(Unknown)"), jpUrl],
    [taiwanHtml({ kind: "文學" }), twUrl],
  ])
    expect(() => parseBookWalker(html, url)).toThrow();
  expect(
    parseBookWalker(japaneseHtml({ title: "架空物語 ８．５【特典】" }), jpUrl)
      .number,
  ).toBe("8.5");
  expect(
    parseBookWalker(japaneseHtml({ title: "架空物語" }), jpUrl).number,
  ).toBeNull();
});
it("bounds requests, restricts redirects and respects cancellation and offline CI", async () => {
  vi.stubEnv("CI", "true");
  await expect(fetchBookWalker(jpUrl, { online: true })).rejects.toMatchObject({
    code: "CI_NETWORK_DISABLED",
  });
  const responses: [NovelResponse, string][] = [
    [{ status: 403, headers: {}, bytes: Buffer.alloc(0) }, "BOOKWALKER_HTTP"],
    [
      { status: 200, headers: {}, bytes: Buffer.alloc(4 * 1024 * 1024 + 1) },
      "BOOKWALKER_LIMIT",
    ],
    [
      { status: 302, headers: {}, bytes: Buffer.alloc(0) },
      "BOOKWALKER_REDIRECT",
    ],
    [
      { status: 302, headers: { location: twUrl }, bytes: Buffer.alloc(0) },
      "BOOKWALKER_REDIRECT",
    ],
    [
      { status: 302, headers: { location: jpUrl }, bytes: Buffer.alloc(0) },
      "BOOKWALKER_REDIRECT",
    ],
  ];
  for (const [response, code] of responses)
    await expect(
      fetchBookWalker(jpUrl, { online: true, fetcher: async () => response }),
    ).rejects.toMatchObject({ code });
  const fetcher = vi.fn(bookwalkerFetcher);
  const abort = new AbortController();
  abort.abort(new Error("Stopped"));
  await expect(
    fetchBookWalker(jpUrl, { online: true, fetcher, signal: abort.signal }),
  ).rejects.toThrow("Stopped");
  expect(fetcher).not.toHaveBeenCalled();
  let calls = 0;
  const bytes = await fetchBookWalker(jpUrl, {
    online: true,
    fetcher: async (request): Promise<NovelResponse> => {
      expect(request).toMatchObject({
        maxBytes: 4 * 1024 * 1024,
        timeout: 20000,
        method: "GET",
      });
      if (calls++ === 0)
        return {
          status: 302,
          headers: { location: `${jpUrl}?src=redirect` },
          bytes: Buffer.alloc(0),
        };
      return { status: 200, headers: {}, bytes: Buffer.from(japaneseHtml()) };
    },
  });
  expect(bytes.toString()).toContain("架空物語");
  expect(calls).toBe(2);
});
