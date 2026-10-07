import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { repoRoot } from "../packages/core/src/runtime.js";
import { sha256 } from "../packages/core/src/hash.js";

const repair = vi.hoisted(() => vi.fn());
vi.mock("../packages/core/src/reading-copy.js", () => ({
  repairReadingCopy: repair,
}));
import { repairDirectory } from "../packages/core/src/repair-directory.js";
const roots: string[] = [];
let active = 0;
let maximum = 0;
beforeEach(() => {
  active = maximum = 0;
  repair
    .mockReset()
    .mockImplementation(
      async (input: string, options: { output: string; reports: string }) => {
        active++;
        maximum = Math.max(maximum, active);
        await setTimeout(10);
        const bytes = await fs.readFile(input);
        await fs.writeFile(options.output, bytes, { flag: "wx" });
        const report = {
          status: "repaired",
          publicationReady: false,
          inputSha256: sha256(bytes),
          originalUnchanged: true,
          contentIntegrity: "pass",
          idempotent: true,
          copy: { path: options.output, sha256: sha256(bytes) },
          changes: 0,
          brokenReferences: 0,
          checks: { sampledBrowser: "pass", fullPublicationQa: "not-run" },
        };
        await fs.writeFile(
          path.join(options.reports, "summary.json"),
          JSON.stringify(report),
        );
        active--;
        return report;
      },
    );
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-directory-"));
  roots.push(root);
  const source = path.join(root, "originals");
  await fs.mkdir(path.join(source, "nested"), { recursive: true });
  const bytes = await fs.readFile(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  for (const relative of ["a.epub", "nested/a.epub", "nested/b.EPUB"])
    await fs.writeFile(path.join(source, relative), bytes);
  return { root, source, bytes, output: path.join(source, "copies") };
}

it("snapshots originals, isolates reports, continues failures, bounds concurrency and resumes verified copies", async () => {
  const { source, output, bytes } = await fixture();
  await fs.writeFile(path.join(source, "broken.epub"), "not an EPUB");
  await fs.writeFile(path.join(source, "old.candidate.epub"), "exclude me");
  await fs.symlink(
    path.join(source, "a.epub"),
    path.join(source, "linked.epub"),
  );
  const result = await repairDirectory(source, { output, jobs: 2 });
  expect(result).toMatchObject({
    status: "fail",
    total: 4,
    completed: 4,
    repaired: 3,
    failed: 1,
    publicationReady: false,
  });
  expect(maximum).toBe(2);
  expect(new Set(result.results.map((row) => row.reports.directory)).size).toBe(
    4,
  );
  expect(await fs.readFile(path.join(source, "a.epub"))).toEqual(bytes);
  expect(await fs.readFile(path.join(output, "nested/a.epub"))).toEqual(bytes);
  const again = await repairDirectory(source, { output });
  expect(again.total).toBe(4); // Output subtree is excluded from the next snapshot.
  expect(again.results.filter((row) => row.resumed)).toHaveLength(3);
  expect(repair).toHaveBeenCalledTimes(3);
  expect(JSON.parse(await fs.readFile(again.reports.json, "utf8"))).toEqual(
    again,
  );
});

it("preserves unrelated and changed output instead of trusting its filename or an old summary", async () => {
  const { source, output } = await fixture();
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, "a.epub"), "existing personal book");
  const first = await repairDirectory(source, { output });
  expect(first.results[0].error?.code).toBe("OUTPUT_EXISTS");
  expect(await fs.readFile(path.join(output, "a.epub"), "utf8")).toBe(
    "existing personal book",
  );
  await fs.writeFile(
    path.join(output, "nested/a.epub"),
    "changed after repair",
  );
  const second = await repairDirectory(source, { output });
  expect(second.failed).toBe(2);
  expect(await fs.readFile(path.join(output, "nested/a.epub"), "utf8")).toBe(
    "changed after repair",
  );
  await expect(
    repairDirectory(source, { output: source }),
  ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
  await expect(
    repairDirectory(source, { output, jobs: 5 }),
  ).rejects.toMatchObject({ code: "ARGUMENT_INVALID" });
});

it("detects source changes after snapshot and releases the output lock on cancellation", async () => {
  const { source, output } = await fixture();
  const original = repair.getMockImplementation()!;
  repair.mockImplementationOnce(async (...args: unknown[]) => {
    await fs.appendFile(path.join(source, "nested/a.epub"), "source changed");
    return original(...args);
  });
  const result = await repairDirectory(source, { output, jobs: 1 });
  expect(result.results[1].error?.code).toBe("SOURCE_CHANGED");
  await fs.rm(output, { recursive: true });
  const controller = new AbortController();
  repair.mockImplementationOnce(async (...args: unknown[]) => {
    controller.abort();
    return original(...args);
  });
  const otherOutput = output + "-cancelled";
  await expect(
    repairDirectory(source, {
      output: otherOutput,
      jobs: 1,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  const saved = JSON.parse(
    await fs.readFile(path.join(otherOutput, "repair-summary.json"), "utf8"),
  );
  expect(saved).toMatchObject({ status: "fail", completed: 1, total: 3 });
  await expect(
    fs.lstat(path.join(otherOutput, ".repair-directory.lock")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
