import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { noteFixture } from "./note-fixture.js";
import { run } from "../packages/core/src/process.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { checkNotes } from "../packages/core/src/check-notes.js";
import { runNoteCases } from "../packages/core/src/note-browser.js";
import { noteCases } from "../packages/core/src/note-cases.js";
import { inspectNotes } from "../packages/core/src/epub-notes.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { formatHuman } from "../packages/cli/src/human.js";
vi.mock("../packages/core/src/note-browser.js", () => ({
  runNoteCases: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(edit?: Parameters<typeof noteFixture>[0]) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "quillbind-notes-contract-"),
  );
  roots.push(root);
  const file = path.join(root, "notes.epub");
  await fs.writeFile(file, noteFixture(edit));
  return { root, file };
}

it("reports static scope without acquiring a browser and rejects stale or ambiguous plans", async () => {
  const { root, file } = await fixture();
  const report = await checkNotes(file, { reports: root });
  expect(runNoteCases).not.toHaveBeenCalled();
  expect(formatHuman("epub", report)).toContain("Interactions: not-run");
  expect(JSON.parse(await fs.readFile(report.reports!.json, "utf8"))).toEqual(
    report,
  );
  const plan = report.casePlan;
  await expect(
    checkNotes(file, {
      executeScripts: true,
      cases: { ...plan, inputSha256: "0".repeat(64) },
    }),
  ).rejects.toHaveProperty("code", "NOTE_CASES_STALE");
  await expect(
    checkNotes(file, {
      cases: { ...plan, cases: [plan.cases[0], plan.cases[0]] },
    }),
  ).rejects.toHaveProperty("code", "NOTE_CASES_DUPLICATE");
  await expect(
    checkNotes(file, {
      cases: {
        ...plan,
        cases: [{ ...plan.cases[0], document: "elsewhere.xhtml" }],
      },
    }),
  ).rejects.toHaveProperty("code", "NOTE_CASE_DOCUMENT");
  for (const activations of [["touch"], ["hover", "hover"]])
    await expect(
      checkNotes(file, {
        cases: { ...plan, cases: [{ ...plan.cases[0], activations }] },
      }),
    ).rejects.toHaveProperty("code", "NOTE_CASE_ACTIVATION");
  await expect(
    checkNotes(file, {
      cases: {
        ...plan,
        cases: [{ ...plan.cases[0], dismiss: { gesture: "release" } }],
      },
    }),
  ).rejects.toHaveProperty("code", "NOTE_CASE_ACTIVATION");
  expect(runNoteCases).not.toHaveBeenCalled();
});

it("requires explicit cases for unpaired notes and blocks remote scripts even with reviewed selectors", async () => {
  const unpaired = await fixture((entries) =>
    entries.set(
      "OEBPS/chapter.xhtml",
      Buffer.from(
        entries
          .get("OEBPS/chapter.xhtml")!
          .toString()
          .replace('href="#ref"', 'href="#other"'),
      ),
    ),
  );
  const report = await checkNotes(unpaired.file);
  expect(report.coverage.unassigned).toHaveLength(1);
  await expect(
    checkNotes(unpaired.file, { executeScripts: true }),
  ).rejects.toHaveProperty("code", "NOTE_CASES_REQUIRED");
  const remote = await fixture((entries) =>
    entries.set(
      "OEBPS/chapter.xhtml",
      Buffer.from(
        entries
          .get("OEBPS/chapter.xhtml")!
          .toString()
          .replace('src="notes.js"', 'src="https://example.invalid/note.js"'),
      ),
    ),
  );
  const before = await checkNotes(remote.file);
  expect(before.status).toBe("fail");
  expect(formatHuman("epub", before)).toContain("NOTE_SCRIPT_RESOURCE");
  await expect(
    checkNotes(remote.file, { executeScripts: true, cases: before.casePlan }),
  ).rejects.toHaveProperty("code", "NOTES_UNSUPPORTED");
  expect(runNoteCases).not.toHaveBeenCalled();
});

it("retains failed execution evidence and never claims a concurrently changed source unchanged", async () => {
  const { file, root } = await fixture();
  vi.mocked(runNoteCases).mockResolvedValue({
    status: "fail",
    cases: [],
    findings: [{ code: "NOTE_SCRIPT", message: "script failed" }],
    environment: {},
  } as never);
  const report = await checkNotes(file, {
    executeScripts: true,
    reports: root,
  });
  expect(report.status).toBe("fail");
  expect(report.casePlan.cases).toHaveLength(1);
  expect(formatHuman("epub", report)).toContain("script failed");
  expect(JSON.parse(await fs.readFile(report.reports!.json, "utf8"))).toEqual(
    report,
  );
  vi.mocked(runNoteCases).mockImplementation(async () => {
    await fs.appendFile(file, "concurrent change");
    return {
      status: "pass",
      cases: [],
      findings: [],
      environment: {},
    } as never;
  });
  await expect(
    checkNotes(file, { executeScripts: true, reports: root }),
  ).rejects.toHaveProperty("code", "SOURCE_CHANGED");
});

it("exports exact auto case expectations and labels explicit coverage as unassessed", async () => {
  const { file } = await fixture();
  const report = await checkNotes(file);
  expect(report.casePlan.cases[0]).toMatchObject({
    expectedText: "A popup note.",
    activations: ["click", "keyboard"],
  });
  const explicit = await checkNotes(file, { cases: report.casePlan });
  expect(explicit.coverage).toMatchObject({
    selection: "explicit-cases",
    completeness: "not-assessed",
  });
  const info = inspectBytes(await fs.readFile(file));
  expect(noteCases(inspectNotes(info), info.sha256).cases).toEqual(
    report.casePlan.cases,
  );
});
it("offers a read-only CLI note inspection without executing source scripts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-notes-cli-"));
  roots.push(root);
  const file = path.join(root, "notes.epub");
  const bytes = noteFixture();
  await fs.writeFile(file, bytes);
  const result = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "packages/cli/src/index.ts",
      "epub",
      "check-notes",
      file,
      "--json",
    ],
    { cwd: repoRoot },
  );
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "inspected",
    interactions: { status: "not-run" },
    notes: { kind: "scripted-note-candidate" },
    originalUnchanged: true,
  });
  expect(await fs.readFile(file)).toEqual(bytes);
});
