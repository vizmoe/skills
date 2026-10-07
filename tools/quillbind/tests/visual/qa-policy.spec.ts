import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { copyBook, candidate } from "../helpers.js";
import { openBook } from "../../packages/core/src/config.js";
import { runQa } from "../../packages/core/src/qa.js";
import { preflightBook } from "../../packages/core/src/preflight.js";
import { inspectBytes } from "../../packages/core/src/epub.js";
import { pack } from "../../packages/core/src/zip.js";

test("executes the recorded stratified plan while retaining fixed screenshot samples", async () => {
  test.setTimeout(180000);
  const root = await copyBook();
  try {
    const { config } = await openBook(root);
    config.markdown.profile = "blog";
    config.chapters = [];
    for (let i = 0; i < 13; i++) {
      const file = `chapters/article-${i}.md`;
      await fs.writeFile(
        path.join(root, file),
        `---\ntitle: Article ${i}\n---\n\n# Article ${i}\n\nA short paragraph for browser coverage.\n`,
      );
      config.chapters.push(file);
    }
    config.qa = { coverage: "stratified", screenshots: "failures-and-samples" };
    await fs.writeFile(path.join(root, "book.yaml"), JSON.stringify(config));
    const before = await preflightBook(root);
    expect(before.status, JSON.stringify(before.diagnostics)).toBe("pass");
    const epub = path.join(root, "candidate.epub");
    await fs.writeFile(epub, await candidate(root));
    const report = await runQa(epub, {
      ...config.qa,
      reports: path.join(root, "qa"),
    });
    expect(report.status, JSON.stringify(report.diagnostics)).toBe("pass");
    const coverage = report.coverage;
    expect(coverage.strategy).toBe("stratified");
    expect(coverage.fullMatrixDocuments).toBeLessThan(coverage.documents);
    expect(coverage.cases).toBe(before.qaProjection.cases);
    expect(coverage.executedCases).toBe(coverage.cases);
    expect(coverage.unexecutedCases).toBe(0);
    for (const entry of coverage.execution)
      expect(entry.executedCases).toBe(entry.plannedCases);
    expect(coverage.execution.some((entry) => entry.executedCases === 5)).toBe(
      true,
    );
    expect(coverage.screenshots.retained).toBe(12);
    expect(await fs.readdir(path.join(root, "qa/screenshots"))).toHaveLength(
      12,
    );
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, "qa/coverage.json"), "utf8"),
      ),
    ).toEqual(coverage);
    let bytes = 0;
    for (const screenshot of coverage.screenshots.files) {
      expect(screenshot.reason).toBe("sample");
      bytes += (
        await fs.stat(path.join(root, "qa/screenshots", screenshot.file))
      ).size;
    }
    expect(coverage.screenshots.bytes).toBe(bytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("retains failures beyond the samples and removes stale screenshots", async () => {
  test.setTimeout(120000);
  const root = await copyBook();
  try {
    const info = inspectBytes(await candidate(root));
    const entries = new Map(
      [...info.entries].map(([name, entry]) => [name, entry.bytes]),
    );
    entries.set(
      "EPUB/styles/base.css",
      Buffer.concat([
        entries.get("EPUB/styles/base.css")!,
        Buffer.from("\np {transform:scale(0)}"),
      ]),
    );
    const epub = path.join(root, "hidden.epub");
    await fs.writeFile(epub, pack(entries, 946684800));
    const reports = path.join(root, "qa");
    await fs.mkdir(path.join(reports, "screenshots"), { recursive: true });
    await fs.writeFile(
      path.join(reports, "screenshots/stale.png"),
      "previous run",
    );
    const report = await runQa(epub, { reports });
    expect(report.status).toBe("fail");
    expect(report.coverage.strategy).toBe("full");
    expect(report.coverage.executedCases).toBe(info.documents.size * 17);
    const files = report.coverage.screenshots.files;
    expect(
      files.filter((file) => file.reason === "failure").length,
    ).toBeGreaterThan(12);
    const onDisk = await fs.readdir(path.join(reports, "screenshots"));
    expect(onDisk).not.toContain("stale.png");
    expect(onDisk.sort()).toEqual(files.map((file) => file.file).sort());
    expect(new Set(onDisk).size).toBe(files.length);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
