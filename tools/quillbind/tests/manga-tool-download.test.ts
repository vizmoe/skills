import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { downloadMangaPackage } from "../scripts/download-manga-package.js";
import { run } from "../packages/core/src/process.js";

const bytes = Buffer.from("synthetic pinned package bytes");
const entry = {
  name: "test-package",
  url: "https://example.invalid/package.deb",
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const success = () => new Response(bytes);

it("recovers from transient HTTP responses with bounded waits and verified bytes", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("gateway", { status: 502 }))
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    .mockResolvedValueOnce(new Response("timeout", { status: 504 }))
    .mockResolvedValueOnce(success());
  const wait = vi.fn(async (_milliseconds: number) => {});
  expect(await downloadMangaPackage(entry, { fetcher, wait })).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(wait.mock.calls.map(([delay]) => delay)).toEqual([2000, 5000, 10000]);
});

it.each([
  new TypeError("connection reset"),
  new DOMException("timed out", "TimeoutError"),
])("retries a temporary transport failure: %s", async (error) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(success());
  const wait = vi.fn(async (_milliseconds: number) => {});
  expect(await downloadMangaPackage(entry, { fetcher, wait })).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(wait).toHaveBeenCalledOnce();
});

it("retries a failed response body read", async () => {
  const incomplete = success();
  vi.spyOn(incomplete, "arrayBuffer").mockRejectedValueOnce(
    new TypeError("truncated body"),
  );
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(incomplete)
    .mockResolvedValueOnce(success());
  expect(
    await downloadMangaPackage(entry, { fetcher, wait: async () => {} }),
  ).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("stops after the retry budget is exhausted", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () => new Response("unavailable", { status: 503 }),
    );
  const wait = vi.fn(async (_milliseconds: number) => {});
  await expect(downloadMangaPackage(entry, { fetcher, wait })).rejects.toThrow(
    "test-package (503)",
  );
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(wait).toHaveBeenCalledTimes(3);
});

it.each(["http", "checksum", "unexpected"])(
  "fails immediately for %s errors",
  async (kind) => {
    const fetcher = vi.fn<typeof fetch>();
    if (kind === "http")
      fetcher.mockResolvedValue(new Response("missing", { status: 404 }));
    if (kind === "checksum")
      fetcher.mockResolvedValue(new Response("wrong package"));
    if (kind === "unexpected")
      fetcher.mockRejectedValue(new Error("unexpected failure"));
    const wait = vi.fn(async (_milliseconds: number) => {});
    await expect(
      downloadMangaPackage(entry, { fetcher, wait }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  },
);

it("loads with native Node and retries actual HTTP fetches from an isolated server", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(requests === 1 ? 503 : 200);
    response.end(requests === 1 ? "temporary" : bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test server address");
    const input = {
      ...entry,
      url: `http://127.0.0.1:${address.port}/package.deb`,
    };
    const module = new URL(
      "../scripts/download-manga-package.ts",
      import.meta.url,
    ).href;
    const result = await run(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import { downloadMangaPackage } from ${JSON.stringify(module)};
      const bytes = await downloadMangaPackage(${JSON.stringify(input)}, { wait: async () => {} });
      process.stdout.write(bytes);
    `,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(bytes.toString());
    expect(requests).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
