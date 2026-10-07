import { afterEach, expect, it, vi } from "vitest";
import { ZhconvertSession } from "../packages/core/src/zhconvert.js";
import { recordedZhconvert, traditionalText } from "./zhconvert-fixture.js";

afterEach(() => vi.unstubAllEnvs());

it("batches under the advertised POST limit, preserves Unicode and freezes exact results", async () => {
  const fetcher = recordedZhconvert({ limit: 1800 });
  const session = new ZhconvertSession({ target: "traditional", fetcher });
  const long = "简体中文𠀀😀  \n".repeat(180);
  const source = ["简体书", long, "plain English", "简体书"];
  const result = await session.translate(source);
  expect(result).toEqual(source.map(traditionalText));
  expect(fetcher.mock.calls.length).toBeGreaterThan(3);
  for (const [url, init] of fetcher.mock.calls.slice(1)) {
    expect(url).toBe("https://api.zhconvert.org/convert");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(1800);
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("modules")).toBe('{"*":0}');
    expect(form.get("converter")).toBe("Traditional");
  }
  const calls = fetcher.mock.calls.length;
  session.freeze();
  expect(await session.translate(source)).toEqual(result);
  expect(fetcher).toHaveBeenCalledTimes(calls);
  expect(session.report()).toMatchObject({
    uniqueTexts: 2,
    target: "traditional",
    revision: "recorded-dictionary-v1",
  });
  await expect(session.translate(["新增文本"])).rejects.toMatchObject({
    code: "CONVERSION_SNAPSHOT_MISSING",
  });
});

it("does not contact the service for text without Han characters", async () => {
  const fetcher = recordedZhconvert();
  const session = new ZhconvertSession({ target: "simplified", fetcher });
  expect(await session.translate(["hello", "😀", ""])).toEqual([
    "hello",
    "😀",
    "",
  ]);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  ["simplified", "Simplified", "zh-Hans"],
  ["traditional", "Traditional", "zh-Hant"],
  ["china", "China", "zh-Hans-CN"],
  ["taiwan", "Taiwan", "zh-Hant-TW"],
  ["hongkong", "Hongkong", "zh-Hant-HK"],
] as const)("selects the %s converter", async (target, converter, language) => {
  const fetcher = recordedZhconvert();
  const session = new ZhconvertSession({ target, fetcher });
  await session.translate(["中文"]);
  expect(session.report()).toMatchObject({ converter, language });
});

it.each([
  [
    () => Response.json({ code: 7, msg: "do not echo source text" }),
    "ZHCONVERT_API",
  ],
  [() => new Response("invalid JSON"), "ZHCONVERT_RESPONSE"],
  [() => Response.json({ data: {} }), "ZHCONVERT_RESPONSE"],
  [() => new Response("unavailable", { status: 403 }), "ZHCONVERT_HTTP"],
  [() => new Response("x".repeat(1024 * 1024 + 1)), "ZHCONVERT_RESPONSE"],
])("rejects an unusable API response", async (response, code) => {
  const session = new ZhconvertSession({
    target: "traditional",
    fetcher: vi.fn<typeof fetch>(async () => response()),
  });
  await expect(session.translate(["中文"])).rejects.toMatchObject({ code });
});

it("retries rate limits with Retry-After and keeps credentials out of reports", async () => {
  const fetcher = recordedZhconvert();
  fetcher.mockImplementationOnce(
    async () =>
      new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
  );
  const session = new ZhconvertSession({
    target: "traditional",
    apiKey: "test-secret",
    fetcher,
  });
  expect(await session.translate(["简体书"])).toEqual(["簡體書"]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(
    new URLSearchParams(String(fetcher.mock.calls.at(-1)![1]?.body)).get(
      "apiKey",
    ),
  ).toBe("test-secret");
  expect(JSON.stringify(session.report())).not.toContain("test-secret");
});

it("bounds retries and refuses changed framing or mixed dictionary revisions", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
  );
  await expect(
    new ZhconvertSession({ target: "traditional", fetcher }).translate([
      "中文",
    ]),
  ).rejects.toMatchObject({ code: "ZHCONVERT_HTTP" });
  expect(fetcher).toHaveBeenCalledTimes(3);
  await expect(
    new ZhconvertSession({
      target: "traditional",
      fetcher: recordedZhconvert({ convert: () => "boundary lost" }),
    }).translate(["中文"]),
  ).rejects.toMatchObject({ code: "ZHCONVERT_FRAMING" });
  let revision = 0;
  const changing = recordedZhconvert({
    limit: 1800,
    revision: () => String(++revision),
  });
  await expect(
    new ZhconvertSession({
      target: "traditional",
      fetcher: changing,
    }).translate(["测试".repeat(300)]),
  ).rejects.toMatchObject({ code: "ZHCONVERT_REVISION_CHANGED" });
});

it("cancels an in-flight request and prohibits unrecorded CI networking", async () => {
  const abort = new AbortController();
  const reason = new Error("user cancelled");
  const fetcher = vi.fn<typeof fetch>(async () => {
    abort.abort(reason);
    throw reason;
  });
  await expect(
    new ZhconvertSession({
      target: "traditional",
      fetcher,
      signal: abort.signal,
    }).translate(["中文"]),
  ).rejects.toBe(reason);
  expect(fetcher).toHaveBeenCalledTimes(1);
  vi.stubEnv("CI", "true");
  await expect(
    new ZhconvertSession({ target: "traditional" }).translate(["中文"]),
  ).rejects.toMatchObject({ code: "NETWORK_DISABLED" });
});
