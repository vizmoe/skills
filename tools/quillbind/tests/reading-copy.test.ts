import { it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { repoRoot } from "../packages/core/src/runtime.js";
import { run } from "../packages/core/src/process.js";
import { sha256 } from "../packages/core/src/hash.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { repairImageFixture } from "./repair-image-fixture.js";

it("creates a checked personal reading copy through the actual tsx CLI and protects it on rerun", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-reading-"));
  try {
    const input = path.join(root, "original.epub");
    const original = await repairImageFixture({
      body: '<h2>SUPERCALIFRAGILISTICEXPIALIDOCIOUS</h2><div style="width:32em"><p>A directory block fits a narrow screen.</p></div><p><img width="1500" src="swatch.svg" alt="Oversized source image"/></p>',
    });
    await fs.writeFile(input, original);
    const output = path.join(root, "copy.epub");
    const plan = path.join(root, "plan.json");
    const cli = path.join(repoRoot, "packages/cli/src/index.ts");
    const planned = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        cli,
        "epub",
        "repair-plan",
        input,
        "--purpose",
        "reading",
        "--output",
        plan,
        "--json",
      ],
      { cwd: repoRoot },
    );
    expect(planned.exitCode).toBe(0);
    const args = [
      "--import",
      "tsx",
      cli,
      "epub",
      "repair-copy",
      input,
      "--plan",
      plan,
      "--output",
      output,
      "--json",
    ];
    const execution = await run(process.execPath, args, {
      cwd: repoRoot,
      timeout: 120000,
    });
    expect(execution.exitCode, execution.stdout + execution.stderr).toBe(0);
    const report = JSON.parse(execution.stdout);
    expect(report).toMatchObject({
      status: "repaired",
      publicationReady: false,
      originalUnchanged: true,
      contentIntegrity: "pass",
      idempotent: true,
      checks: {
        sampledBrowser: "pass",
        fullPublicationQa: "not-run",
        ace: "not-run",
      },
    });
    const bytes = await fs.readFile(output);
    expect(report.copy.sha256).toBe(sha256(bytes));
    expect(inspectBytes(bytes).version).toBe("2.0");
    expect(await fs.readFile(input)).toEqual(original);
    const again = await run(process.execPath, args, { cwd: repoRoot });
    expect(JSON.parse(again.stdout).code).toBe("OUTPUT_EXISTS");
    expect(await fs.readFile(output)).toEqual(bytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120000);
