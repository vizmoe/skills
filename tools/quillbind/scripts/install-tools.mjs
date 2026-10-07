import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "scripts/install-tools.ts"],
  { stdio: "inherit", shell: false, timeout: 600000 },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
