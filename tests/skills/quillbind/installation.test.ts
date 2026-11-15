import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installSkillCopy, runNode } from "./support.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("installed quillbind launcher", () => {
  it("installs cleanly and reports ENVIRONMENT_ERROR when QUILLBIND_ROOT is missing", async () => {
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "quillbind-skill-install-"),
    );
    tempDirs.push(project);
    const installed = await installSkillCopy(project);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: path.join(project, "empty-path"),
    };
    delete env.QUILLBIND_ROOT;

    const result = await runNode(
      [path.join(installed, "scripts/quillbind.ts"), "version", "--json"],
      { cwd: project, env },
    );
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as {
      code: string;
      message: string;
    };
    expect(payload.code).toBe("ENVIRONMENT_ERROR");
    expect(payload.message).toContain("QUILLBIND_ROOT");
  });
});
