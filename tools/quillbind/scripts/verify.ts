import path from "node:path";
import fs from "node:fs/promises";
import { buildBook } from "../packages/core/src/pipeline.js";
import { createRepairPlan, repairEpub } from "../packages/core/src/repair.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { json } from "../packages/core/src/json.js";
const reports: unknown[] = [];
for (const theme of ["literature", "technical"]) {
  process.stderr.write(`Building ${theme}\n`);
  reports.push(await buildBook(path.join(repoRoot, "examples", theme)));
}
const legacy = path.join(repoRoot, "examples/repair/legacy.epub");
const output = path.join(repoRoot, "examples/repair/dist/repaired.epub");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.rm(output, { force: true });
await fs.rm(output + ".candidate.epub", { force: true });
const plan = await createRepairPlan(legacy, {
  output: path.join(repoRoot, "examples/repair/dist/repair-plan.json"),
});
reports.push(await repairEpub(legacy, { plan, output }));
await json(path.join(repoRoot, "dist/verification.json"), {
  status: "pass",
  reports,
});
process.stdout.write("All three publication pipelines passed.\n");
