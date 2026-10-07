import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { copyBook } from "./helpers.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { recordedZhconvert } from "./zhconvert-fixture.js";
import { preflightBook } from "../packages/core/src/preflight.js";

vi.mock("../packages/core/src/pipeline.js", () => ({
  doctor: () => {
    throw new Error("Preview must not require validators");
  },
}));
import * as rendering from "../packages/core/src/render.js";
import { previewBook } from "../packages/core/src/preview.js";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function book() {
  const root = await copyBook();
  roots.push(root);
  return root;
}

it("renders once and leaves release artifacts and reports unchanged", async () => {
  const root = await book();
  await fs.mkdir(path.join(root, "dist/reports"), { recursive: true });
  await fs.writeFile(path.join(root, "dist/book.epub"), "previous release");
  await fs.writeFile(
    path.join(root, "dist/reports/summary.json"),
    "previous report",
  );
  const render = vi.spyOn(rendering, "renderPublication");
  const result = await previewBook(root);
  expect(result).toMatchObject({
    status: "preview",
    publicationReady: false,
    releaseGates: "not-run",
  });
  expect(render).toHaveBeenCalledTimes(1);
  const preflight = await preflightBook(root);
  expect(result.qaProjection).toMatchObject({
    strategy: "full",
    basis: "packaged-preview",
    complete: true,
    documents: preflight.qaProjection.documents,
    cases: preflight.qaProjection.cases,
    screenshots: { policy: "failures-and-samples", passing: 12 },
  });
  expect(result.candidate.path).toBe(
    path.join(root, "dist/preview/candidate.epub"),
  );
  expect(inspectBytes(await fs.readFile(result.candidate.path)).version).toBe(
    "3.0",
  );
  expect(await fs.readFile(path.join(root, "dist/book.epub"), "utf8")).toBe(
    "previous release",
  );
  expect(
    await fs.readFile(path.join(root, "dist/reports/summary.json"), "utf8"),
  ).toBe("previous report");
  expect(await fs.readdir(path.join(root, "dist/reports"))).toEqual([
    "summary.json",
  ]);
  expect(await fs.readdir(path.join(root, "dist/preview"))).toEqual([
    "candidate.epub",
  ]);
});

it("reuses the conversion lock offline and rejects concurrent builds", async () => {
  const root = await book();
  const first = await previewBook(root, {
    online: true,
    conversion: { target: "traditional", fetcher: recordedZhconvert() },
  });
  const fetcher = vi.fn<typeof fetch>();
  const second = await previewBook(root, {
    conversion: { target: "traditional", fetcher },
  });
  expect(second.candidate.sha256).toBe(first.candidate.sha256);
  expect(fetcher).not.toHaveBeenCalled();
  await fs.writeFile(path.join(root, "dist/.build.lock"), "another process");
  await expect(previewBook(root)).rejects.toMatchObject({ code: "BUILD_BUSY" });
  expect(await fs.readFile(path.join(root, "dist/.build.lock"), "utf8")).toBe(
    "another process",
  );
});

it("rejects invalid source before writing a preview", async () => {
  const root = await book();
  await fs.appendFile(
    path.join(root, "chapters/01-arrival.md"),
    "\n# Duplicate title\n",
  );
  await expect(previewBook(root)).rejects.toMatchObject({
    code: "PREFLIGHT_FAILED",
  });
  await expect(
    fs.lstat(path.join(root, "dist/preview/candidate.epub")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    fs.lstat(path.join(root, "dist/.build.lock")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
