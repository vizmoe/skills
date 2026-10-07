#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const tools = JSON.parse(
  readFileSync(path.join(root, "standards/tools.lock.json"), "utf8"),
);
const local = path.join(
  root,
  `.cache/tools/node-v${tools.node}-${process.platform}-${process.arch}/bin/node`,
);
const runtime = existsSync(local) ? local : process.execPath;
const timeoutSeconds = Number(process.env.QUILLBIND_TIMEOUT_SECONDS ?? "1800");
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0)
  throw new Error("QUILLBIND_TIMEOUT_SECONDS must be a positive integer");
const result = spawnSync(
  runtime,
  [
    "--import",
    fileURLToPath(
      new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
    ),
    path.join(root, "packages/cli/src/index.ts"),
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    shell: false,
    timeout: timeoutSeconds * 1000,
    env: {
      ...process.env,
      PATH: path.dirname(runtime) + path.delimiter + process.env.PATH,
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
