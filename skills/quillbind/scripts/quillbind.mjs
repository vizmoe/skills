#!/usr/bin/env node
/** Locate the real CLI and forward argv; the repository launcher selects its pinned Node. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function main() {
  const roots = [
    ...(process.env.QUILLBIND_ROOT
      ? [path.resolve(process.env.QUILLBIND_ROOT)]
      : []),
    fileURLToPath(new URL("../../../tools/quillbind/", import.meta.url)),
  ];
  const entry = roots
    .map((root) => path.join(root, "bin/quillbind.mjs"))
    .find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  const seconds = Number(process.env.QUILLBIND_TIMEOUT_SECONDS ?? "1800");
  if (!Number.isSafeInteger(seconds) || seconds <= 0)
    throw Object.assign(
      new Error("QUILLBIND_TIMEOUT_SECONDS must be a positive integer"),
      { code: "ENVIRONMENT_ERROR" },
    );
  const result = spawnSync(
    entry ? process.execPath : "quillbind",
    [...(entry ? [entry] : []), ...process.argv.slice(2)],
    { stdio: "inherit", shell: false, timeout: seconds * 1000 },
  );
  if (result.error)
    throw Object.assign(
      new Error(
        result.error.code === "ENOENT"
          ? "Quillbind CLI is missing. Set QUILLBIND_ROOT to its checkout or put quillbind on PATH."
          : `Quillbind failed: ${result.error.message}`,
      ),
      { code: "ENVIRONMENT_ERROR" },
    );
  return result.status ?? (result.signal === "SIGINT" ? 130 : 1);
}
try {
  process.exitCode = main();
} catch (error) {
  const result = {
    status: "fail",
    code: error.code ?? "ENVIRONMENT_ERROR",
    message: error.message,
  };
  if (process.argv.includes("--json"))
    process.stdout.write(JSON.stringify(result) + "\n");
  else process.stderr.write(`${result.code}: ${result.message}\n`);
  process.exitCode = 1;
}
