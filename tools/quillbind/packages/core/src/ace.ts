import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { browserPath } from "./qa-environment.js";
import { exists } from "./files.js";
import { checkAbort, fail } from "./errors.js";
import { run } from "./process.js";
import { json, readJson } from "./json.js";

export function aceExecutable() {
  try {
    return createRequire(import.meta.url).resolve(
      "@daisy/ace/bin/ace-puppeteer.js",
    );
  } catch {
    fail(
      "ENVIRONMENT_ERROR",
      "Ace is missing; install the core runtime dependencies",
    );
  }
}

export async function runAce(
  file: string,
  reports: string,
  signal?: AbortSignal,
) {
  checkAbort(signal);
  const executablePath = await browserPath();
  const acePath = aceExecutable();
  const output = path.join(reports, "ace");
  await fs.mkdir(output, { recursive: true });
  const execution = await run(
    process.execPath,
    [acePath, "--outdir", output, "--force", path.resolve(file)],
    {
      signal,
      timeout: 180000,
      env: { PUPPETEER_EXECUTABLE_PATH: executablePath },
    },
  );
  await fs.writeFile(path.join(output, "stdout.txt"), execution.stdout);
  await fs.writeFile(path.join(output, "stderr.txt"), execution.stderr);
  await json(path.join(output, "execution.json"), {
    ...execution,
    version: "1.4.6",
  });
  if (!(await exists(path.join(output, "report.json"))))
    fail("ACE_REPORT_MISSING", `Ace produced no report: ${execution.stderr}`);
  const report = await readJson<unknown>(path.join(output, "report.json"));
  const failures: unknown[] = [];
  const visit = (value: unknown) => {
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (
        ["earl:failed", "earl:fail", "failed", "fail"].includes(
          String(object["earl:outcome"]),
        )
      )
        failures.push(value);
      Object.values(object).forEach(visit);
    }
  };
  visit(report);
  return {
    status:
      execution.exitCode === 0 && !failures.length
        ? ("pass" as const)
        : ("fail" as const),
    version: "1.4.6",
    exitCode: execution.exitCode,
    failures: failures.length,
  };
}
