import { atomicWrite, readSourceFile } from "./files.js";

function compareKey(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortObjectKeys(_key: string, val: unknown): unknown {
  if (!val || typeof val !== "object" || Array.isArray(val)) return val;
  return Object.fromEntries(
    Object.entries(val).sort(([a], [b]) => compareKey(a, b)),
  );
}

export function stable(value: unknown): string {
  return JSON.stringify(value, sortObjectKeys, 2) + "\n";
}
export async function json(file: string, value: unknown) {
  await atomicWrite(file, stable(value));
}
export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse((await readSourceFile(file)).toString("utf8")) as T;
}
