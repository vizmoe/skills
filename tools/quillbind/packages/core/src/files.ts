import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { fail } from "./errors.js";
import { safeName } from "./paths.js";

export async function atomicWrite(file: string, value: string | Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = await fs.mkdtemp(
    path.join(path.dirname(file), ".quillbind-"),
  );
  try {
    await fs.writeFile(path.join(temporary, "value"), value);
    await fs.rename(path.join(temporary, "value"), file);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
export async function readSourceFile(file: string) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      fail("RESOURCE_TYPE", `Source is not a regular file: ${file}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export async function bookOutput(root: string, relative: string) {
  safeName(relative);
  let current = await fs.realpath(root);
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        fail(
          "OUTPUT_SYMLINK",
          `Output component is not an ordinary directory: ${relative}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current);
    }
  }
  return current;
}
export async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
export async function safeRead(root: string, relative: string) {
  safeName(relative);
  const base = await fs.realpath(root);
  const file = await fs
    .realpath(path.join(base, relative))
    .catch(() => fail("RESOURCE_MISSING", `Missing resource: ${relative}`));
  if (!file.startsWith(base + path.sep))
    fail("SYMLINK_ESCAPE", `Resource escapes book directory: ${relative}`);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      fail("RESOURCE_TYPE", `Source is not a regular file: ${relative}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
