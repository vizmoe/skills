import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inspectBytes } from "./epub.js";
import { inspectNotes } from "./epub-notes.js";
import { noteCases } from "./note-cases.js";
import { runNoteCases } from "./note-browser.js";
import { readSourceFile } from "./files.js";
import { json } from "./json.js";
import { sha256 } from "./hash.js";
import { checkAbort, fail } from "./errors.js";

export async function checkNotes(
  file: string,
  options: {
    executeScripts?: boolean;
    cases?: unknown;
    reports?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
) {
  checkAbort(options.signal);
  const bytes = await readSourceFile(file),
    info = inspectBytes(bytes);
  const notes = inspectNotes(info),
    selection = noteCases(notes, info.sha256, options.cases);
  for (const test of selection.cases)
    if (!info.documents.has(test.document))
      fail(
        "NOTE_CASE_DOCUMENT",
        `Case document is not a packaged XHTML resource: ${test.document}`,
      );
  const reports =
    options.executeScripts || options.reports
      ? path.join(
          path.resolve(options.reports ?? file + ".notes-reports"),
          randomUUID(),
        )
      : undefined;
  let interactions:
    | Awaited<ReturnType<typeof runNoteCases>>
    | { status: "not-run"; reason: string } = {
    status: "not-run",
    reason:
      "Book scripts are disabled; use --execute-scripts for explicit interaction checks",
  };
  if (options.executeScripts) {
    if (
      info.unsupported.some((feature) => feature !== "interactive-content") ||
      info.entries.has("META-INF/signatures.xml") ||
      notes.active.length ||
      notes.issues.some(
        (i) =>
          i.severity === "error" &&
          (selection.coverage !== "explicit-cases" ||
            ["NOTE_SCRIPT_RESOURCE", "NOTE_ACTIVE_URI"].includes(i.code)),
      )
    )
      fail(
        "NOTES_UNSUPPORTED",
        "Resolve unsafe or ambiguous publication/note resources before executing scripts",
        {
          unsupported: info.unsupported,
          active: notes.active,
          issues: notes.issues,
        },
      );
    if (!selection.cases.length || selection.unassigned.length)
      fail(
        "NOTE_CASES_REQUIRED",
        "Provide source-bound --cases for notes without a local popup target and return control",
        { unassigned: selection.unassigned },
      );
    await fs.mkdir(reports!, { recursive: true });
    interactions = await runNoteCases(info, selection.cases, {
      reports: reports!,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }
  checkAbort(options.signal);
  if (sha256(await readSourceFile(file)) !== info.sha256)
    fail("SOURCE_CHANGED", "EPUB changed while checking notes");
  const report = {
    schemaVersion: 1,
    operation: "check-notes",
    status:
      interactions.status === "fail" ||
      notes.issues.some((i) => i.severity === "error")
        ? "fail"
        : interactions.status === "pass"
          ? "pass"
          : "inspected",
    inputSha256: info.sha256,
    originalUnchanged: true,
    notes,
    casePlan: {
      schemaVersion: 1,
      inputSha256: info.sha256,
      cases: selection.cases,
    },
    coverage: {
      selection: selection.coverage,
      completeness:
        selection.coverage === "explicit-cases"
          ? "not-assessed"
          : selection.unassigned.length
            ? "partial"
            : "all-identified-references-selected",
      identifiedReferences: notes.references.length,
      selectedCases: selection.cases.length,
      unassigned: selection.unassigned,
    },
    interactions,
    notClaimed: [
      "EPUB publication conformance",
      "Apple Books or Kindle native popup behavior",
      "Arbitrary script safety or behavior outside the recorded cases",
    ],
    ...(reports
      ? { reports: { json: path.join(reports, "report.json") } }
      : {}),
  };
  if (reports) await json(path.join(reports, "report.json"), report);
  return report;
}
