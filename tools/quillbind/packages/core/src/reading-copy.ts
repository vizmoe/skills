import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applyRepair } from "./repair.js";
import { planFromBytes, type RepairPlan } from "./repair-plan.js";
import { inspectBytes } from "./epub.js";
import { describeInspection } from "./inspection.js";
import { validateInternal, checkEpubConformance } from "./validate.js";
import { compatibilityLint } from "./compatibility.js";
import { readingQa } from "./reading-qa.js";
import { doctor } from "./pipeline.js";
import { fail, checkAbort } from "./errors.js";
import { exists, readSourceFile } from "./files.js";
import { json } from "./json.js";
import { sha256 } from "./hash.js";

/** A personal reading copy preserves the source edition; it is never a publication release. */
export async function repairReadingCopy(
  file: string,
  options: {
    plan: RepairPlan;
    output: string;
    reports?: string;
    signal?: AbortSignal;
  },
) {
  if (options.plan.purpose !== "reading")
    fail("REPAIR_PURPOSE", "repair-copy requires a reading plan");
  const output = path.resolve(options.output);
  if (path.resolve(file) === output || (await exists(output)))
    fail("OUTPUT_EXISTS", "Reading-copy output must be a new path");
  const reports = path.resolve(options.reports ?? output + ".reports");
  await fs.mkdir(reports, { recursive: true });
  const runId = randomUUID();
  const candidate = output + `.${runId}.candidate.epub`;
  const summaryPath = path.join(reports, "summary.json");
  const markdownPath = path.join(reports, "summary.md");
  const base = {
    runId,
    operation: "repair-copy",
    purpose: "personal-reading",
    input: path.resolve(file),
    publicationReady: false,
    releaseGates: "not-run",
    reports: { json: summaryPath, markdown: markdownPath },
  };
  await json(summaryPath, { ...base, status: "running" });
  try {
    checkAbort(options.signal);
    const environment = await doctor();
    await json(path.join(reports, "environment.json"), environment);
    if (environment.status === "fail")
      fail(
        "ENVIRONMENT_ERROR",
        "Reading-copy checks require the installed toolchain",
        environment,
      );
    const bytes = await readSourceFile(file);
    const applied = applyRepair(bytes, options.plan);
    await json(path.join(reports, "plan.json"), options.plan);
    await json(path.join(reports, "changes.json"), applied.changes);
    await json(path.join(reports, "content-integrity.json"), applied.integrity);
    const again = applyRepair(
      applied.bytes,
      planFromBytes(applied.bytes, "reading"),
    );
    if (!again.bytes.equals(applied.bytes))
      fail("REPAIR_NOT_IDEMPOTENT", "A second reading repair changed bytes");
    await json(path.join(reports, "reproducibility.json"), {
      status: "pass",
      idempotent: true,
      sha256: sha256(applied.bytes),
    });
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(candidate, applied.bytes, { flag: "wx" });
    const info = inspectBytes(applied.bytes, true);
    const internal = validateInternal(info);
    const inspection = describeInspection(info, applied.bytes.length);
    await json(path.join(reports, "inspection.json"), inspection);
    await json(path.join(reports, "publication-policy.json"), internal);
    const conformance = await checkEpubConformance(candidate, {
      reports,
      signal: options.signal,
    });
    const blockedBrowser = internal.diagnostics.filter((d) =>
      [
        "ACTIVE_CONTENT",
        "EVENT_HANDLER",
        "SVG_ACTIVE",
        "CSS_ACTIVE",
        "CSS_REMOTE",
        "UNSAFE_URI",
      ].includes(d.code),
    );
    const browser = blockedBrowser.length
      ? {
          status: "not-run",
          reason: "Active or unsupported resource findings",
          diagnostics: blockedBrowser,
        }
      : await readingQa(info, path.join(reports, "browser"), options.signal);
    const apple = await compatibilityLint(info, "apple-books");
    const kindle = await compatibilityLint(info, "kindle");
    await json(path.join(reports, "apple-books-lint.json"), apple);
    await json(path.join(reports, "kindle-lint.json"), kindle);
    const unresolved = options.plan.actions.filter(
      (a) => a.classification !== "safe",
    );
    const references = inspection.references.filter((ref) =>
      ["missing-resource", "missing-fragment", "unsafe"].includes(
        ref.resolution,
      ),
    );
    await json(path.join(reports, "remaining-findings.json"), {
      unresolved,
      references,
      conformance,
      browser,
      publicationPolicy: internal,
      notes: inspection.notes,
      apple,
      kindle,
    });
    checkAbort(options.signal);
    if (sha256(await readSourceFile(file)) !== options.plan.inputSha256)
      fail(
        "SOURCE_CHANGED",
        "Original changed while the reading copy was checked",
      );
    // link() refuses to overwrite a path created concurrently after the initial check.
    await fs.link(candidate, output);
    await fs.unlink(candidate);
    const hash = sha256(applied.bytes);
    const result = {
      ...base,
      status: "repaired",
      copy: {
        path: output,
        sha256: hash,
        size: applied.bytes.length,
        version: info.version,
      },
      inputSha256: options.plan.inputSha256,
      originalUnchanged: true,
      contentIntegrity: "pass",
      idempotent: true,
      changedResources: new Set(applied.changes.map((a) => a.resource)).size,
      changes: applied.changes.length,
      checks: {
        conformance: conformance.status,
        sampledBrowser: browser.status,
        apple: apple.status,
        kindle: kindle.status,
        fullPublicationQa: "not-run",
        ace: "not-run",
        scriptedNotes: "not-run",
      },
      unresolved: unresolved.length,
      brokenReferences: references.length,
    };
    await json(summaryPath, result);
    await fs.writeFile(
      markdownPath,
      `# ${info.title}\n\n[Repaired reading copy](<${output}>)\n\nThe original is unchanged. Text, images, metadata and reading order passed integrity checks; a second repair is byte-identical. The source EPUB ${info.version} edition is preserved. This is a personal reading copy, not a publication release.\n\nSHA-256: \`${hash}\`\n\n- Repair actions: ${result.changes}\n- Remaining broken references: ${references.length}\n- EPUBCheck: ${conformance.status}\n- Sampled browser check: ${browser.status}\n- Scripted note interactions: not run; use epub check-notes for explicit checks\n- Full publication QA and Ace: not run\n\n[Remaining findings](remaining-findings.json) · [Integrity evidence](content-integrity.json) · [Repair changes](changes.json)\n`,
    );
    return result;
  } catch (error) {
    const e = error as Error & { code?: string };
    await json(summaryPath, {
      ...base,
      status: "fail",
      error: { code: e.code, message: e.message },
    });
    throw error;
  }
}
