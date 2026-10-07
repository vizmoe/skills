import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fetchNovelBook } from "../packages/core/src/novel.js";
import { buildBook } from "../packages/core/src/pipeline.js";
import { novelFixture } from "./novel-fixture.js";

vi.mock("../packages/core/src/pipeline.js", () => ({ buildBook: vi.fn() }));
const temporary: string[] = [];
async function output() {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "novel-release-test-"),
  );
  temporary.push(parent);
  return path.join(parent, "book");
}
afterEach(async () => {
  vi.resetAllMocks();
  for (const root of temporary.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
it("runs the existing publication pipeline by default and reports its actual artifact", async () => {
  const f = await novelFixture(),
    root = await output();
  const artifact = {
    path: path.join(root, "dist/book.epub"),
    sha256: "a".repeat(64),
    size: 123,
    mediaType: "application/epub+zip",
  };
  vi.mocked(buildBook).mockResolvedValue({ artifact } as Awaited<
    ReturnType<typeof buildBook>
  >);
  const result = await fetchNovelBook(f.url, {
    output: root,
    fetcher: f.fetcher,
    delayMs: 0,
    qa: { coverage: "stratified" },
  });
  expect(buildBook).toHaveBeenCalledWith(root, {
    signal: undefined,
    qa: { coverage: "stratified" },
  });
  expect(result).toMatchObject({
    status: "pass",
    publicationReady: true,
    projects: [{ artifact, status: "pass", readiness: { release: "pass" } }],
  });
  expect(
    JSON.parse(await fs.readFile(path.join(root, "novel.json"), "utf8")),
  ).toEqual(result);
});
it("preserves prepared sources and per-volume outcomes after a release gate fails", async () => {
  const f = await novelFixture(),
    root = await output(),
    failure = Object.assign(new Error("required validator missing"), {
      code: "ENVIRONMENT_ERROR",
    });
  vi.mocked(buildBook)
    .mockResolvedValueOnce({
      artifact: { path: path.join(root, "volume-001/dist/book.epub") },
    } as Awaited<ReturnType<typeof buildBook>>)
    .mockRejectedValueOnce(failure);
  await expect(
    fetchNovelBook(f.url, {
      output: root,
      fetcher: f.fetcher,
      delayMs: 0,
      splitVolumes: true,
    }),
  ).rejects.toBe(failure);
  const result = JSON.parse(
    await fs.readFile(path.join(root, "novel.json"), "utf8"),
  );
  expect(result).toMatchObject({
    status: "fail",
    publicationReady: false,
    projects: [
      { status: "pass", volumes: [1] },
      { status: "fail", volumes: [2] },
    ],
  });
  expect(failure).toHaveProperty(
    "reports.novel",
    path.join(root, "novel.json"),
  );
  expect(
    await fs.readFile(
      path.join(root, "volume-002/chapters/v002-0001.md"),
      "utf8",
    ),
  ).toContain("第二卷结尾");
  expect(buildBook).toHaveBeenCalledTimes(2);
});
