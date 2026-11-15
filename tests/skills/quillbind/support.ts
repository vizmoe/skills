import { expect } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const SKILL_DIR = path.join(REPO_ROOT, "skills/quillbind");

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runNode(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {},
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const err = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    if (typeof err.code === "number") {
      return {
        exitCode: err.code,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
      };
    }
    throw error;
  }
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await fs.readdir(path.join(root, rel), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const next = rel ? path.posix.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(next);
      } else if (entry.isFile()) {
        results.push(next);
      }
    }
  }
  await walk("");
  return results.sort();
}

export async function installSkillCopy(projectDir: string): Promise<string> {
  await fs.mkdir(projectDir, { recursive: true });
  const installed = path.join(projectDir, ".agents/skills/quillbind");
  await fs.mkdir(path.dirname(installed), { recursive: true });
  await fs.cp(SKILL_DIR, installed, { recursive: true });

  const [installedLicense, rootLicense] = await Promise.all([
    fs.readFile(path.join(installed, "LICENSE")),
    fs.readFile(path.join(REPO_ROOT, "LICENSE")),
  ]);
  expect(installedLicense.equals(rootLicense)).toBe(true);

  const expected = await listRelativeFiles(SKILL_DIR);
  const actual = await listRelativeFiles(installed);
  expect(actual).toEqual(expected);

  for (const rel of expected) {
    const [installedBytes, sourceBytes] = await Promise.all([
      fs.readFile(path.join(installed, rel)),
      fs.readFile(path.join(SKILL_DIR, rel)),
    ]);
    expect(installedBytes.equals(sourceBytes), rel).toBe(true);
  }

  for (const forbidden of [
    ".git",
    "work",
    "tests",
    "evals",
    "dist",
    "AGENTS.md",
    "node_modules",
  ]) {
    const exists = await fs
      .lstat(path.join(installed, forbidden))
      .then(() => true)
      .catch(() => false);
    expect(exists, forbidden).toBe(false);
  }

  return installed;
}
