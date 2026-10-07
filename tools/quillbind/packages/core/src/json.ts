import { atomicWrite, readSourceFile } from "./files.js";

export function stable(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, val) =>
        val && typeof val === "object" && !Array.isArray(val)
          ? Object.fromEntries(
              Object.entries(val).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            )
          : val,
      2,
    ) + "\n"
  );
}
export async function json(file: string, value: unknown) {
  await atomicWrite(file, stable(value));
}
export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse((await readSourceFile(file)).toString("utf8")) as T;
}
