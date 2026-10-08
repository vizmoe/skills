import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { enrichEpub } from "../packages/core/src/enrich-epub.js";
import { collectBookWalker } from "../packages/core/src/bookwalker.js";
import { candidate, copyBook } from "./helpers.js";
import { bookwalkerFetcher, selection } from "./bookwalker-fixture.js";
import type { ReleaseReporter } from "../packages/core/src/reporting.js";
const mocked = vi.hoisted(() => ({ doctor: vi.fn(), gates: vi.fn() }));
vi.mock("../packages/core/src/pipeline.js", () => ({
  doctor: mocked.doctor,
  releaseGates: mocked.gates,
}));
const temporary: string[] = [];
beforeEach(() => {
  mocked.doctor.mockReset().mockResolvedValue({ status: "pass", checks: [] });
  mocked.gates
    .mockReset()
    .mockImplementation(
      async (
        _file: string,
        _reports: string,
        options: { reporter: ReleaseReporter },
      ) => {
        for (const name of [
          "conformance",
          "accessibility",
          "browser",
          "apple-books",
          "kindle",
        ])
          await options.reporter.check(name, async () => ({ status: "pass" }));
        return { status: "pass" };
      },
    );
});
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await copyBook();
  temporary.push(root);
  const file = path.join(root, "source.epub"),
    output = path.join(root, "result.epub"),
    bookwalker = path.join(root, "bookwalker.json");
  const bytes = await candidate(root);
  await fs.writeFile(file, bytes);
  await fs.writeFile(
    bookwalker,
    JSON.stringify(
      await collectBookWalker(selection, {
        online: true,
        fetcher: bookwalkerFetcher,
      }),
    ),
  );
  return { root, file, output, bookwalker, bytes };
}
it("publishes only after gate orchestration and retains bound metadata evidence (mocked gates)", async () => {
  const input = await fixture();
  const result = await enrichEpub(input.file, input);
  expect(result.status).toBe("pass");
  expect(result.reproducibility.status).toBe("pass");
  expect(mocked.gates).toHaveBeenCalledOnce();
  expect(await fs.readFile(input.file)).toEqual(input.bytes);
  expect(result.metadata.resources.length).toBeGreaterThan(1);
  const report = JSON.parse(
    await fs.readFile(result.reports.summaryJson, "utf8"),
  );
  expect(Object.values(report.checks)).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: "pass" })]),
  );
  expect(
    (await fs.readdir(input.root)).some(
      (name) =>
        name.endsWith(".candidate.epub") || name.endsWith(".metadata.lock"),
    ),
  ).toBe(false);
});
it("keeps no released candidate after missing tooling or failed publication gates", async () => {
  const input = await fixture();
  mocked.doctor.mockResolvedValueOnce({ status: "fail", checks: [] });
  await expect(enrichEpub(input.file, input)).rejects.toMatchObject({
    code: "ENVIRONMENT_ERROR",
  });
  expect(mocked.gates).not.toHaveBeenCalled();
  mocked.gates.mockRejectedValueOnce(
    Object.assign(new Error("Rejected by EPUBCheck"), {
      code: "VALIDATION_FAILED",
    }),
  );
  await expect(enrichEpub(input.file, input)).rejects.toMatchObject({
    code: "VALIDATION_FAILED",
  });
  await expect(fs.lstat(input.output)).rejects.toMatchObject({
    code: "ENOENT",
  });
  const report = JSON.parse(
    await fs.readFile(input.output + ".reports/summary.json", "utf8"),
  );
  expect(report.status).toBe("fail");
  expect(
    (await fs.readdir(input.root)).some(
      (name) =>
        name.endsWith(".candidate.epub") || name.endsWith(".metadata.lock"),
    ),
  ).toBe(false);
});
it("respects concurrent owners, cancellation and a creator racing the final output link", async () => {
  const input = await fixture();
  const lockfile = input.output + ".metadata.lock";
  await fs.writeFile(lockfile, "owner");
  await expect(enrichEpub(input.file, input)).rejects.toMatchObject({
    code: "METADATA_BUSY",
  });
  expect(await fs.readFile(lockfile, "utf8")).toBe("owner");
  await fs.unlink(lockfile);
  const controller = new AbortController();
  mocked.gates.mockImplementationOnce(async () => {
    controller.abort(new Error("Cancelled"));
  });
  await expect(
    enrichEpub(input.file, { ...input, signal: controller.signal }),
  ).rejects.toThrow("Cancelled");
  await expect(fs.lstat(input.output)).rejects.toMatchObject({
    code: "ENOENT",
  });
  mocked.gates.mockImplementationOnce(async () => {
    await fs.writeFile(input.output, "another creator", { flag: "wx" });
  });
  await expect(enrichEpub(input.file, input)).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await fs.readFile(input.output, "utf8")).toBe("another creator");
  expect(await fs.readFile(input.file)).toEqual(input.bytes);
});
