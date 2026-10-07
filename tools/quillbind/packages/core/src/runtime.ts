import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./json.js";
import { exists } from "./files.js";

export const VERSION = "0.1.0";
export const repoRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
).replace(/\/dist\/$/, "/");
export async function javaExecutable() {
  const lock = await readJson<{
    java: { targets: Record<string, { executable: string }> };
  }>(path.join(repoRoot, "standards/tools.lock.json"));
  const target = lock.java.targets[`${process.platform}-${process.arch}`];
  if (target) {
    const local = path.join(repoRoot, ".cache/tools", target.executable);
    if (await exists(local)) return local;
  }
  return "java";
}
