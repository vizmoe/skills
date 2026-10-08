import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bookOutput } from "../packages/core/src/files.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-output-"));
  root = await fs.realpath(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it("lets concurrent writers create the same ordinary output ancestors", async () => {
  const target = path.join(root, "reports"),
    original = fs.lstat;
  let arrived = 0,
    release!: () => void;
  const bothMissing = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Control only the interleaving: both callers actually observe ENOENT.
  vi.spyOn(fs, "lstat").mockImplementation(
    async (...args: Parameters<typeof fs.lstat>) => {
      try {
        return await original(...args);
      } catch (error) {
        if (
          args[0] === target &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          if (++arrived === 2) release();
          await bothMissing;
        }
        throw error;
      }
    },
  );
  const expected = path.join(root, "reports", "nested");
  await expect(
    Promise.all([
      bookOutput(root, "reports/nested"),
      bookOutput(root, "reports/nested"),
    ]),
  ).resolves.toEqual([expected, expected]);
  expect((await fs.lstat(expected)).isDirectory()).toBe(true);
});

it("rejects files and links, including a link inserted during directory creation", async () => {
  await fs.writeFile(path.join(root, "file"), "keep");
  await expect(bookOutput(root, "file/child")).rejects.toHaveProperty(
    "code",
    "OUTPUT_SYMLINK",
  );
  await fs.mkdir(path.join(root, "outside"));
  const target = path.join(root, "reports"),
    original = fs.mkdir;
  vi.spyOn(fs, "mkdir").mockImplementation(
    async (...args: Parameters<typeof fs.mkdir>) => {
      if (args[0] === target)
        await fs.symlink(path.join(root, "outside"), target);
      return original(...args);
    },
  );
  await expect(bookOutput(root, "reports/child")).rejects.toHaveProperty(
    "code",
    "OUTPUT_SYMLINK",
  );
  await expect(bookOutput(root, "reports/child")).rejects.toHaveProperty(
    "code",
    "OUTPUT_SYMLINK",
  );
  expect(await fs.readdir(path.join(root, "outside"))).toEqual([]);
  expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe("keep");
});

it("preserves permission errors instead of treating them as concurrent creation", async () => {
  const error = Object.assign(new Error("access denied"), { code: "EACCES" });
  vi.spyOn(fs, "mkdir").mockRejectedValue(error);
  await expect(bookOutput(root, "reports/child")).rejects.toBe(error);
});
