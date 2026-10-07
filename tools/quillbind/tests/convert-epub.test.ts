import { beforeEach, afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { candidate, copyBook } from "./helpers.js";
import { recordedZhconvert } from "./zhconvert-fixture.js";
import { readJson } from "../packages/core/src/json.js";
import type { ReleaseReporter } from "../packages/core/src/reporting.js";

const gates = vi.hoisted(() => ({ doctor: vi.fn(), releaseGates: vi.fn() }));
vi.mock("../packages/core/src/pipeline.js", () => gates);
import { convertEpub } from "../packages/core/src/convert-epub.js";

const temporary: string[] = [];
beforeEach(() => {
  gates.doctor.mockReset().mockResolvedValue({ status: "pass", checks: [] });
  gates.releaseGates
    .mockReset()
    .mockImplementation(
      async (
        _file: string,
        _reports: string,
        options: { reporter: ReleaseReporter },
      ) => {
        for (const step of [
          "conformance",
          "accessibility",
          "browser",
          "apple-books",
          "kindle",
        ])
          await options.reporter.check(step, async () => ({ status: "pass" }));
        return { status: "pass" };
      },
    );
});
afterEach(async () => {
  for (const root of temporary.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function source() {
  const root = await copyBook();
  temporary.push(root);
  const file = path.join(root, "original.epub");
  const bytes = await candidate(root);
  await fs.writeFile(file, bytes);
  return { root, file, bytes, output: path.join(root, "traditional.epub") };
}

it("releases to a new file only after every gate and replays the snapshot without network calls", async () => {
  const { root, file, bytes, output } = await source();
  const fetcher = recordedZhconvert();
  const result = await convertEpub(file, {
    output,
    target: "traditional",
    online: true,
    fetcher,
  });
  expect(result.status).toBe("pass");
  expect(result.artifact.path).toBe(output);
  expect(result.reproducibility.firstSha256).toBe(
    result.reproducibility.secondSha256,
  );
  expect(await fs.readFile(file)).toEqual(bytes);
  expect(gates.releaseGates).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(result.conversion.requests);
  const summary = await readJson<any>(result.reports.summaryJson);
  expect(
    Object.values(summary.checks).every(
      (check: any) => check.status === "pass",
    ),
  ).toBe(true);
  expect(summary.operation).toBe("convert");
  expect(
    (await fs.readdir(root)).some(
      (name) =>
        name.includes("candidate.epub") || name.endsWith("conversion.lock"),
    ),
  ).toBe(false);
});

it("blocks release on a failed gate and records which checks were not run", async () => {
  const { file, bytes, output } = await source();
  gates.releaseGates.mockImplementationOnce(
    async (_file, _reports, { reporter }) => {
      await reporter.check("conformance", async () => {
        throw Object.assign(new Error("rejected fixture"), {
          code: "VALIDATION_FAILED",
        });
      });
    },
  );
  await expect(
    convertEpub(file, {
      output,
      target: "traditional",
      online: true,
      fetcher: recordedZhconvert(),
    }),
  ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(fs.lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(file)).toEqual(bytes);
  const summary = await readJson<any>(output + ".reports/summary.json");
  expect(summary.status).toBe("fail");
  expect(summary.checks.conformance.status).toBe("fail");
  expect(summary.checks.browser.status).toBe("not-run");
  expect(summary.artifact).toBeUndefined();
});

it("stops before networking when required tooling is missing", async () => {
  const { file, output } = await source();
  gates.doctor.mockResolvedValueOnce({
    status: "fail",
    checks: [{ tool: "epubcheck", status: "fail" }],
  });
  const fetcher = recordedZhconvert();
  await expect(
    convertEpub(file, { output, target: "traditional", online: true, fetcher }),
  ).rejects.toMatchObject({ code: "ENVIRONMENT_ERROR" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(gates.releaseGates).not.toHaveBeenCalled();
});

it("preserves originals, existing output and dangling symlinks without network requests", async () => {
  const { root, file, bytes, output } = await source();
  const fetcher = recordedZhconvert();
  for (const target of [file, output]) {
    if (target === output) await fs.writeFile(output, "keep this output");
    await expect(
      convertEpub(file, {
        output: target,
        target: "traditional",
        online: true,
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
  }
  const symlink = path.join(root, "dangling.epub");
  await fs.symlink(path.join(root, "absent"), symlink);
  await expect(
    convertEpub(file, {
      output: symlink,
      target: "traditional",
      online: true,
      fetcher,
    }),
  ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await fs.readFile(file)).toEqual(bytes);
  expect(await fs.readFile(output, "utf8")).toBe("keep this output");
  expect((await fs.lstat(symlink)).isSymbolicLink()).toBe(true);
});

it("never overwrites an output created while validation was running", async () => {
  const { file, output } = await source();
  const original = gates.releaseGates.getMockImplementation()!;
  gates.releaseGates.mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    await fs.writeFile(output, "concurrent output");
    return result;
  });
  await expect(
    convertEpub(file, {
      output,
      target: "traditional",
      online: true,
      fetcher: recordedZhconvert(),
    }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await fs.readFile(output, "utf8")).toBe("concurrent output");
});
