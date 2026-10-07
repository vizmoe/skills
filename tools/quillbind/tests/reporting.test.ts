import { it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { copyBook } from "./helpers.js";
import { buildBook } from "../packages/core/src/pipeline.js";
import { json, readJson } from "../packages/core/src/json.js";
import { ReleaseReporter } from "../packages/core/src/reporting.js";
const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
it("a failed run does not inherit an earlier release or unexecuted checks", async () => {
  const root = await copyBook();
  temporary.push(root);
  const reports = path.join(root, "dist/reports");
  await json(path.join(reports, "summary.json"), {
    status: "pass",
    artifact: { path: "old.epub" },
    checks: { browser: { status: "pass" } },
  });
  await fs.writeFile(path.join(root, "dist/book.epub"), "old artifact");
  const config = path.join(root, "book.yaml");
  await fs.writeFile(
    config,
    (await fs.readFile(config, "utf8")).replace("title: 山间来信", 'title: ""'),
  );
  await expect(buildBook(root)).rejects.toMatchObject({
    code: "METADATA_UNRESOLVED",
    reports: {
      summaryJson: path.join(await fs.realpath(reports), "summary.json"),
    },
  });
  const summary = await readJson<any>(path.join(reports, "summary.json"));
  expect(summary.status).toBe("fail");
  expect(summary.artifact).toBeUndefined();
  expect(summary.checks.metadata.status).toBe("fail");
  expect(summary.blockers).toContainEqual(
    expect.objectContaining({
      code: "METADATA_MISSING",
      message: "Fill book.title in book.yaml",
    }),
  );
  for (const key of [
    "preflight",
    "environment",
    "conformance",
    "accessibility",
    "browser",
    "apple-books",
    "kindle",
    "reproducibility",
  ])
    expect(summary.checks[key].status).toBe("not-run");
  expect(await fs.readFile(path.join(root, "dist/book.epub"), "utf8")).toBe(
    "old artifact",
  );
  expect(
    await fs.readFile(path.join(reports, "summary.md"), "utf8"),
  ).not.toContain("[browser QA](qa/report.json)");
});
it("names missing environment tools in the summary blockers", async () => {
  const root = await copyBook();
  temporary.push(root);
  const reporter = new ReleaseReporter(
    path.join(root, "summary"),
    "build",
    root,
  );
  const result = await reporter.check("environment", async () => ({
    status: "fail",
    checks: [{ tool: "epubcheck", status: "fail" }],
  }));
  await reporter.finish(
    undefined,
    Object.assign(new Error("Required toolchain is unavailable"), {
      code: "ENVIRONMENT_ERROR",
      details: result.checks,
    }),
  );
  const summary = await readJson<any>(reporter.paths.summaryJson);
  expect(summary.blockers).toEqual([
    {
      code: "ENVIRONMENT_TOOL",
      message:
        "epubcheck: Required tool is unavailable or has the wrong version",
    },
  ]);
  expect(await fs.readFile(reporter.paths.summaryMarkdown, "utf8")).toContain(
    "epubcheck:",
  );
});
it("separates platform warnings from technical success", async () => {
  const root = await copyBook();
  temporary.push(root);
  const reporter = new ReleaseReporter(
    path.join(root, "summary"),
    "repair",
    "fixture.epub",
  );
  await expect(
    reporter.finish({
      path: "new.epub",
      size: 1,
      sha256: "0",
      mediaType: "application/epub+zip",
    }),
  ).rejects.toThrow("every check passes");
  for (const key of Object.keys(reporter.checks))
    await reporter.check(key, async () =>
      key === "kindle"
        ? {
            status: "pass",
            distribution: "warning",
            diagnostics: [
              { code: "COVER", severity: "warning", message: "Cover omitted" },
            ],
          }
        : { status: "pass" },
    );
  await reporter.finish({
    path: "new.epub",
    size: 1,
    sha256: "0",
    mediaType: "application/epub+zip",
  });
  const summary = await readJson<any>(reporter.paths.summaryJson);
  expect(summary.status).toBe("pass");
  expect(summary.checks.kindle.distribution).toBe("warning");
  expect(summary.warnings).toEqual([
    { code: "COVER", message: "Cover omitted" },
  ]);
  expect(summary.scope.nativeReaderTesting).toBe("not-run");
});
