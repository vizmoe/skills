import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { repoRoot } from "../packages/core/src/runtime.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-locks-"));
  roots.push(root);
  for (const file of [
    ".node-version",
    "Dockerfile.qa",
    "package.json",
    "packages/core/package.json",
    "packages/cli/package.json",
    "standards/tools.lock.json",
    "standards/dependencies.lock.json",
    "scripts/check-locks.mjs",
  ]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(path.join(repoRoot, file), path.join(root, file));
  }
  for (const name of [
    "typescript",
    "@typescript/native",
    "typescript-eslint",
    ".bin/tsc",
  ]) {
    const target = path.join(root, "node_modules", name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(path.join(repoRoot, "node_modules", name), target);
  }
  return root;
}

const check = (root: string) =>
  promisify(execFile)(
    process.execPath,
    [path.join(root, "scripts/check-locks.mjs")],
    {
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      timeout: 20000,
    },
  );

it("accepts the installed compiler and lint API through the public lock check", async () => {
  expect((await check(await fixture())).stderr).toBe("");
});

it("rejects a compiler alias pointing at the lint package even when both are in the ledger", async () => {
  const root = await fixture();
  const file = path.join(root, "package.json");
  const manifest = JSON.parse(await fs.readFile(file, "utf8"));
  manifest.devDependencies["@typescript/native"] =
    manifest.devDependencies.typescript;
  await fs.writeFile(file, JSON.stringify(manifest));
  await expect(check(root)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      "@typescript/native TypeScript alias drifted",
    ),
  });
});

it("rejects tsc routed to TypeScript 6 while package pins remain valid", async () => {
  const root = await fixture();
  const bin = path.join(root, "node_modules/.bin/tsc");
  await fs.unlink(bin);
  await fs.symlink(path.join(repoRoot, "node_modules/.bin/tsc6"), bin);
  await expect(check(root)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      "tsc must resolve to the pinned native build compiler",
    ),
  });
});
