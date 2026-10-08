import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { collectBookWalker } from "../packages/core/src/bookwalker.js";
import { openBook } from "../packages/core/src/config.js";
import { inspectBytes } from "../packages/core/src/validate.js";
import { elements, NS } from "../packages/core/src/xml.js";
import { selection, bookwalkerFetcher } from "../tests/bookwalker-fixture.js";
import { buildBook } from "../packages/core/src/pipeline.js";
import { createRepairPlan, repairEpub } from "../packages/core/src/repair.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { json } from "../packages/core/src/json.js";
const reports: unknown[] = [];
for (const theme of ["literature", "technical"]) {
  process.stderr.write(`Building ${theme}\n`);
  reports.push(await buildBook(path.join(repoRoot, "examples", theme)));
}
const enriched = path.join(repoRoot, "dist/verification/bookwalker");
await fs.rm(enriched, { recursive: true, force: true });
await fs.cp(path.join(repoRoot, "examples/literature"), enriched, {
  recursive: true,
  filter: (source) => !source.split(path.sep).includes("dist"),
});
const config = (await openBook(enriched)).config;
Object.assign(config.book, {
  title: "",
  authors: [],
  description: "",
  language: "",
});
config.bookwalker = "metadata/bookwalker.lock.json";
await fs.writeFile(path.join(enriched, "book.yaml"), JSON.stringify(config));
await json(
  path.join(enriched, config.bookwalker),
  await collectBookWalker(selection, {
    online: true,
    fetcher: bookwalkerFetcher,
  }),
);
process.stderr.write(
  "Building BookWalker metadata fixture (offline transport fixture)\n",
);
const enrichedResult = await buildBook(enriched);
const enrichedInfo = inspectBytes(
  await fs.readFile(enrichedResult.artifact.path),
);
assert.equal(
  elements(enrichedInfo.packageDocument, "date", NS.dc)[0]?.textContent,
  "2020-04-20",
);
assert.equal(
  elements(enrichedInfo.packageDocument, "publisher", NS.dc)[0]?.textContent,
  "台灣出版社",
);
reports.push(enrichedResult);
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
process.stdout.write("All publication pipelines passed.\n");
