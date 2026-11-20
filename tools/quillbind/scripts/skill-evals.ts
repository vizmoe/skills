import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { noteFixture } from "../tests/note-fixture.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const skill = path.resolve(repoRoot, "../../skills/quillbind");
const execute = promisify(execFile);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await fs.readFile(file, "utf8")) as T;
const json = async (file: string, value: unknown) =>
  fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");

interface TraceEntry {
  args: string[];
  exitCode: number;
  durationMs: number;
  output: unknown;
}

interface ScenarioContext {
  scenarioId: string;
  root: string;
  raw: string;
  config: string;
  output: string;
  epub: string;
  sourceBefore: Record<string, string>;
  trace: TraceEntry[];
  evidence: string[];
  setEnvironment: (dir: string) => void;
  invoke: (args: string[], exitCode?: number) => Promise<any>;
  prepare: () => Promise<any>;
}

const catalog = await readJson<{
  scenarios: { id: string; prompt: string; expected: string[] }[];
}>(path.join(repoRoot, "tests/skill-evals/scenarios.json"));
const destination = path.join(repoRoot, "dist/skill-evals");
await fs.mkdir(destination, { recursive: true });
const results: {
  id: string;
  status: string;
  trace: TraceEntry[];
  evidence: string[];
  error?: string;
  workspace?: string;
}[] = [];

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    const entries = await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    await Promise.all(
      entries.map(async (entry) => {
        const name = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) {
          await visit(name);
        } else if (entry.isFile()) {
          files[name] = sha256(await fs.readFile(path.join(root, name)));
        } else {
          files[name] = `symlink:${await fs.readlink(path.join(root, name))}`;
        }
      }),
    );
  }
  await visit("");
  return files;
}

async function runtimeWithoutTools(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  const copiedEntries = [
    "package.json",
    "tsconfig.json",
    "bin",
    "standards",
    "styles",
    "packages/core/src",
    "packages/core/package.json",
    "packages/cli/src",
    "packages/cli/package.json",
  ];
  await Promise.all(
    copiedEntries.map(async (file) => {
      await fs.mkdir(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      await fs.cp(path.join(repoRoot, file), path.join(directory, file), {
        recursive: true,
      });
    }),
  );
  await fs.cp(skill, path.resolve(directory, "../../skills/quillbind"), {
    recursive: true,
  });
  await Promise.all(
    ["node_modules", "packages/core/node_modules"].map((relative) =>
      fs.symlink(
        path.join(repoRoot, relative),
        path.join(directory, relative),
        "dir",
      ),
    ),
  );
  // Resolve the copied CLI to its copied core; only third-party dependencies are shared.
  const scope = path.join(directory, "packages/cli/node_modules/@quillbind");
  await fs.mkdir(scope, { recursive: true });
  await fs.symlink(
    path.join(directory, "packages/core"),
    path.join(scope, "core"),
    "dir",
  );
}

async function runInspectScenario(ctx: ScenarioContext): Promise<boolean> {
  const before = await snapshot(ctx.root);
  const inspection = await ctx.invoke(["inspect", ctx.epub]);
  assert.equal(inspection.summary.validation, "not-run");
  assert.ok(
    inspection.navigation.some(
      (nav: any) => nav.format === "ncx" && nav.items.length,
    ),
  );
  assert.ok(
    inspection.metadata.records.some(
      (record: any) => record.value === "Example Translator",
    ),
  );
  if (ctx.scenarioId === "no-rebuild")
    await ctx.invoke(["epub", "audit", ctx.epub]);
  assert.deepEqual(await snapshot(ctx.root), before);
  assert.ok(
    ctx.trace.every(
      (call) => !call.args.includes("build") && !call.args.includes("repair"),
    ),
  );
  ctx.evidence.push(
    "Original EPUB and entire input tree unchanged",
    "Original bibliography and NCX returned; validation marked not-run",
  );
  return false;
}

async function runBlogPreparationScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  const preparation = await ctx.prepare();
  assert.equal(preparation.readiness.metadata, "pass");
  assert.equal(preparation.readiness.release, "not-run");
  await Promise.all(
    preparation.copiedFiles.map(async (item: { path: string }) => {
      assert.equal(
        sha256(await fs.readFile(path.join(ctx.output, item.path))),
        ctx.sourceBefore[item.path],
      );
    }),
  );
  const preflight = await ctx.invoke(["preflight", ctx.output]);
  assert.equal(preflight.documents[0].footnotes[0].references.length, 2);
  assert.deepEqual(
    preflight.documents.map((doc: { source: string }) => doc.source),
    ["posts/first.md", "posts/second.md"],
  );
  assert.ok(!JSON.stringify(preflight).includes("EVAL_PRIVATE_FIELD"));
  assert.ok(!JSON.stringify(preparation).includes("EVAL_PRIVATE_FIELD"));
  const preview = await ctx.invoke(["preview", ctx.output]);
  assert.equal(preview.status, "preview");
  assert.equal(preview.releaseGates, "not-run");
  assert.equal(preview.publicationReady, false);
  assert.equal(
    sha256(await fs.readFile(preview.candidate.path)),
    preview.candidate.sha256,
  );
  await assert.rejects(fs.stat(path.join(ctx.output, "dist/book.epub")));
  const inspection = await ctx.invoke(["inspect", preview.candidate.path]);
  assert.ok(!JSON.stringify(inspection).includes("EVAL_PRIVATE_FIELD"));
  const metadata = await ctx.invoke(["metadata", "resolve", ctx.output]);
  assert.deepEqual(metadata.metadata.publication, { isbn: null });
  assert.equal(metadata.metadata.identifier.scheme, "uuid");
  assert.ok(
    !(await readJson<any>(path.join(ctx.output, "metadata/decisions.json")))
      .isbn,
  );
  ctx.evidence.push(
    "One init call produced a schema-valid project with explicit chapter order",
    "Copied Markdown/SVG hashes match originals",
    "Repeated notes, Properties whitelist and UUID metadata verified in parsed/output data",
  );
  return false;
}

async function runAuthorPreviewScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  await ctx.prepare();
  const environment = path.join(
    ctx.root,
    "runtime-without-tools/tools/quillbind",
  );
  ctx.setEnvironment(environment);
  await runtimeWithoutTools(environment);
  const dist = path.join(ctx.output, "dist");
  await fs.mkdir(path.join(dist, "reports"), { recursive: true });
  await fs.writeFile(path.join(dist, "book.epub"), "previous release");
  await json(path.join(dist, "reports/summary.json"), {
    runId: "previous-release",
    status: "pass",
  });
  const before = await snapshot(dist);
  const preview = await ctx.invoke(["preview", ctx.output]);
  assert.equal(preview.status, "preview");
  assert.equal(preview.publicationReady, false);
  assert.equal(preview.releaseGates, "not-run");
  assert.equal(
    preview.candidate.path,
    path.join(await fs.realpath(ctx.output), "dist/preview/candidate.epub"),
  );
  assert.equal(
    sha256(await fs.readFile(preview.candidate.path)),
    preview.candidate.sha256,
  );
  assert.equal(
    (await ctx.invoke(["inspect", preview.candidate.path, "--summary"]))
      .validation,
    "not-run",
  );
  const after = await snapshot(dist);
  assert.equal(after["preview/candidate.epub"], preview.candidate.sha256);
  delete after["preview/candidate.epub"];
  assert.deepEqual(after, before);
  ctx.evidence.push(
    "Preview succeeded without pinned release validators and reported publicationReady false with releaseGates not-run",
    "Candidate path, SHA-256 and read-only EPUB inspection verified",
    "Previous release artifact and complete reports tree unchanged; only the preview candidate was added",
  );
  return false;
}

async function runMissingValidatorScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  await ctx.prepare();
  const environment = path.join(
    ctx.root,
    "runtime-without-tools/tools/quillbind",
  );
  ctx.setEnvironment(environment);
  await runtimeWithoutTools(environment);
  assert.equal(
    (await ctx.invoke(["inspect", ctx.epub, "--summary"])).validation,
    "not-run",
  );
  const previous = Buffer.from("previous artifact remains protected");
  await fs.mkdir(path.join(ctx.output, "dist"));
  await fs.writeFile(path.join(ctx.output, "dist/book.epub"), previous);
  const failure = await ctx.invoke(["build", ctx.output], 1);
  assert.equal(failure.code, "ENVIRONMENT_ERROR");
  const summary = await readJson<any>(failure.reports.summaryJson);
  assert.equal(summary.status, "fail");
  assert.equal(summary.artifact, undefined);
  assert.equal(summary.checks.environment.status, "fail");
  assert.equal(summary.checks.conformance.status, "not-run");
  assert.equal(summary.checks.browser.status, "not-run");
  assert.deepEqual(
    await fs.readFile(path.join(ctx.output, "dist/book.epub")),
    previous,
  );
  ctx.evidence.push(
    "Inspection succeeded in a runtime with no pinned validators",
    "Build returned ENVIRONMENT_ERROR and current-run not-run checks",
    "Earlier artifact was preserved and not claimed as a release",
  );
  return false;
}

async function runUnsupportedInputScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  const pdf = path.join(ctx.root, "original.pdf");
  await fs.writeFile(pdf, "%PDF-1.7\nEvaluation input only\n");
  const before = sha256(await fs.readFile(pdf));
  const formats = await ctx.invoke(["formats"]);
  assert.ok(!formats.inputs.includes("pdf"));
  const failure = await ctx.invoke(
    ["init", ctx.output, "--from", pdf, "--config", ctx.config],
    1,
  );
  assert.equal(failure.code, "UNSUPPORTED_FORMAT");
  assert.equal(sha256(await fs.readFile(pdf)), before);
  await assert.rejects(fs.stat(ctx.output));
  ctx.evidence.push(
    "Unsupported source rejected with a nonzero exit; no output project or conversion claim",
  );
  return false;
}

async function runScriptedNotesScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  const source = path.join(ctx.root, "scripted.epub");
  const reports = path.join(ctx.root, "notes-reports");
  const repaired = path.join(ctx.root, "reading.epub");
  const planPath = path.join(ctx.root, "reading-plan.json");
  const bytes = noteFixture();
  await fs.writeFile(source, bytes);
  const inspection = await ctx.invoke(["epub", "check-notes", source]);
  assert.equal(inspection.interactions.status, "not-run");
  assert.equal(inspection.notes.kind, "scripted-note-candidate");
  const before = await ctx.invoke([
    "epub",
    "check-notes",
    source,
    "--execute-scripts",
    "--reports",
    reports,
  ]);
  assert.equal(before.status, "pass");
  assert.equal(before.interactions.cases.length, 2);
  await ctx.invoke([
    "epub",
    "repair-plan",
    source,
    "--purpose",
    "reading",
    "--output",
    planPath,
  ]);
  const copy = await ctx.invoke([
    "epub",
    "repair-copy",
    source,
    "--plan",
    planPath,
    "--output",
    repaired,
  ]);
  assert.equal(copy.publicationReady, false);
  assert.equal(copy.checks.scriptedNotes, "not-run");
  assert.equal(copy.checks.sampledBrowser, "not-run");
  const after = await ctx.invoke([
    "epub",
    "check-notes",
    repaired,
    "--execute-scripts",
    "--reports",
    reports,
  ]);
  assert.equal(after.status, "pass");
  assert.ok(
    after.interactions.cases.every((c: any) =>
      c.checks.includes("focus-returned"),
    ),
  );
  assert.equal(sha256(await fs.readFile(source)), sha256(bytes));
  await fs.cp(reports, path.join(destination, "scripted-notes/reports"), {
    recursive: true,
  });
  ctx.evidence.push(
    "Static inspection did not execute scripts; actual click/keyboard checks passed before and after reading repair",
    "Reading-copy summary retained non-publication and unexecuted-script status; source hash unchanged",
  );
  return false;
}

async function runReleaseHandoffScenario(
  ctx: ScenarioContext,
): Promise<boolean> {
  await ctx.prepare();
  const release = await ctx.invoke(["build", ctx.output]);
  assert.equal(release.status, "pass");
  const summary = await readJson<any>(release.reports.summaryJson);
  assert.equal(summary.runId, release.runId);
  assert.equal(
    summary.artifact.sha256,
    sha256(await fs.readFile(release.artifact.path)),
  );
  assert.ok(
    Object.values(summary.checks).every(
      (check: any) => check.status === "pass",
    ),
  );
  assert.equal(summary.scope.nativeReaderTesting, "not-run");
  assert.equal(
    summary.checks.kindle.distribution,
    release.gates.kindle.distribution,
  );
  assert.ok((await fs.stat(release.reports.summaryMarkdown)).size > 0);
  await fs.cp(
    release.reports.directory,
    path.join(destination, "release-handoff/reports"),
    { recursive: true },
  );
  await fs.copyFile(
    release.artifact.path,
    path.join(destination, "release-handoff/book.epub"),
  );
  ctx.evidence.push(
    "All release gates ran through the actual Skill helper",
    "Artifact hash, runId, human summary, warnings and distribution results verified",
  );
  return true;
}

const scenarioHandlers: Record<
  string,
  (ctx: ScenarioContext) => Promise<boolean>
> = {
  "inspect-only": runInspectScenario,
  "no-rebuild": runInspectScenario,
  "blog-preparation": runBlogPreparationScenario,
  "properties-whitelist": runBlogPreparationScenario,
  "isbn-null": runBlogPreparationScenario,
  "author-preview": runAuthorPreviewScenario,
  "missing-validator": runMissingValidatorScenario,
  "unsupported-input": runUnsupportedInputScenario,
  "scripted-notes": runScriptedNotesScenario,
  "release-handoff": runReleaseHandoffScenario,
};

async function runScenario(scenario: { id: string }): Promise<void> {
  const root = await fs.mkdtemp(
    path.join(
      scenario.id === "release-handoff" ? destination : os.tmpdir(),
      "quillbind-skill-eval-",
    ),
  );
  let retain = false;
  const trace: TraceEntry[] = [];
  const evidence: string[] = [];
  let environment = repoRoot;
  const invoke = async (args: string[], exitCode = 0): Promise<any> => {
    const started = performance.now();
    let actualExitCode = 0;
    const result = await execute(
      process.execPath,
      [path.join(skill, "scripts/quillbind.ts"), ...args, "--json"],
      {
        cwd: root,
        timeout: 600000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, QUILLBIND_ROOT: environment },
      },
    ).catch((error: unknown) => {
      const failure = error as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      if (typeof failure.code !== "number") throw error;
      actualExitCode = failure.code;
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    });
    let output: unknown;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Skill helper did not emit JSON: ${result.stderr}`);
    }
    trace.push({
      args,
      exitCode: actualExitCode,
      durationMs: performance.now() - started,
      output,
    });
    assert.equal(actualExitCode, exitCode, JSON.stringify(output));
    return output;
  };
  try {
    const raw = path.join(root, "raw");
    const config = path.join(root, "plan.yaml");
    const output = path.join(root, "book");
    const epub = path.join(root, "existing.epub");
    await fs.cp(path.join(repoRoot, "tests/skill-evals/fixtures/raw"), raw, {
      recursive: true,
    });
    await fs.copyFile(
      path.join(repoRoot, "tests/skill-evals/fixtures/book.yaml"),
      config,
    );
    await fs.copyFile(path.join(repoRoot, "examples/repair/legacy.epub"), epub);
    const sourceBefore = await snapshot(raw);
    const configBefore = sha256(await fs.readFile(config));
    const epubBefore = sha256(await fs.readFile(epub));
    const handler = scenarioHandlers[scenario.id];
    if (!handler) throw new Error(`Unimplemented scenario: ${scenario.id}`);
    retain = await handler({
      scenarioId: scenario.id,
      root,
      raw,
      config,
      output,
      epub,
      sourceBefore,
      trace,
      evidence,
      setEnvironment: (dir) => {
        environment = dir;
      },
      invoke,
      prepare: () =>
        invoke(["init", output, "--from", raw, "--config", config]),
    });
    assert.deepEqual(await snapshot(raw), sourceBefore);
    assert.equal(sha256(await fs.readFile(config)), configBefore);
    assert.equal(sha256(await fs.readFile(epub)), epubBefore);
    const result = {
      id: scenario.id,
      status: "pass",
      evidence,
      trace,
      ...(retain ? { workspace: root } : {}),
    };
    results.push(result);
    await json(path.join(destination, `${scenario.id}.json`), result);
    process.stdout.write(
      `${scenario.id}: pass (${trace.length} helper calls)\n`,
    );
  } catch (error) {
    const result = {
      id: scenario.id,
      status: "fail",
      error: String(error),
      evidence,
      trace,
    };
    results.push(result);
    await json(path.join(destination, `${scenario.id}.json`), result);
    process.stderr.write(`${scenario.id}: ${String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (!retain) await fs.rm(root, { recursive: true, force: true });
  }
}

let scenarioChain = Promise.resolve();
for (const scenario of catalog.scenarios) {
  scenarioChain = scenarioChain.then(() => runScenario(scenario));
}
await scenarioChain;

const report = {
  schemaVersion: 1,
  mode: "scripted-skill-workflows",
  helper: "../../skills/quillbind/scripts/quillbind.ts",
  node: process.versions.node,
  skillSha256: sha256(await fs.readFile(path.join(skill, "SKILL.md"))),
  status: process.exitCode ? "fail" : "pass",
  scenarios: results,
  independentAgentEvaluation: {
    status: "not-run",
    reason:
      "These runs execute explicit workflows; they do not measure an independent model choosing actions from the prompt.",
  },
};
await json(path.join(destination, "report.json"), report);
await fs.writeFile(
  path.join(destination, "report.md"),
  [
    "# Skill workflow evaluation",
    "",
    `Result: ${report.status}`,
    "",
    "Executed the real Skill helper in isolated fixtures. Assertions inspect command exits, parsed artifacts, source hashes and current-run reports.",
    "",
    ...results.map(
      (result) =>
        `- ${result.id}: ${result.status} (${result.trace.length} helper calls)`,
    ),
    "",
    "Independent agent selection: NOT RUN. The scenario catalog can be used for a separate agent run; these scripted workflows do not establish autonomous task selection or answer quality.",
    "",
  ].join("\n"),
);
