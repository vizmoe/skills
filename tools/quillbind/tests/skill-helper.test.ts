import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

it("locates the checkout from an unrelated directory without Python or QUILLBIND_ROOT", async () => {
  const helper = fileURLToPath(
    new URL("../../../skills/quillbind/scripts/quillbind.mjs", import.meta.url),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: path.dirname(process.execPath),
  };
  delete env.QUILLBIND_ROOT;
  const result = await promisify(execFile)(
    process.execPath,
    [helper, "version", "--json"],
    { cwd: os.tmpdir(), env },
  );
  expect(JSON.parse(result.stdout)).toMatchObject({
    version: expect.any(String),
  });
  expect(result.stderr).toBe("");
});

it("runs a relocated skill against the explicitly configured runtime", async () => {
  const runtime = fileURLToPath(new URL("../", import.meta.url));
  const source = fileURLToPath(
    new URL("../../../skills/quillbind/", import.meta.url),
  );
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "quillbind-installed-"),
  );
  try {
    const installed = path.join(temporary, "skill");
    await fs.cp(source, installed, { recursive: true });
    const result = await promisify(execFile)(
      process.execPath,
      [path.join(installed, "scripts/quillbind.mjs"), "version", "--json"],
      { cwd: temporary, env: { ...process.env, QUILLBIND_ROOT: runtime } },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: expect.any(String),
    });
    expect(result.stderr).toBe("");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
