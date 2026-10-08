import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "./files.js";
import { json } from "./json.js";
import type { Artifact, CompatibilityReport } from "./model.js";

type CheckStatus = "not-run" | "running" | "pass" | "fail";
interface Check {
  status: CheckStatus;
  distribution?: CompatibilityReport["distribution"];
  cases?: number;
  coverage?: {
    strategy: string;
    documents: number;
    fullMatrixDocuments: number;
  };
  code?: string;
  message?: string;
}
const steps = {
  build: [
    "metadata",
    "preflight",
    "environment",
    "packaging",
    "conformance",
    "accessibility",
    "browser",
    "apple-books",
    "kindle",
    "reproducibility",
  ],
  repair: [
    "environment",
    "content-integrity",
    "conformance",
    "accessibility",
    "browser",
    "apple-books",
    "kindle",
    "reproducibility",
  ],
  enrich: [
    "environment",
    "metadata",
    "conformance",
    "accessibility",
    "browser",
    "apple-books",
    "kindle",
    "reproducibility",
  ],
  convert: [
    "environment",
    "conversion",
    "conformance",
    "accessibility",
    "browser",
    "apple-books",
    "kindle",
    "reproducibility",
  ],
};
const clean = (value: string) =>
  value.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}[\]<>|]/g, "\\$&");
export class ReleaseReporter {
  readonly runId = randomUUID();
  readonly startedAt = new Date().toISOString();
  readonly checks: Record<string, Check>;
  readonly warnings: { code: string; message: string; source?: string }[] = [];
  readonly blockers: { code: string; message: string; source?: string }[] = [];
  readonly paths: {
    directory: string;
    summaryJson: string;
    summaryMarkdown: string;
  };
  private status: "running" | "pass" | "fail" = "running";
  private artifact?: Artifact;
  private failure?: { code: string; message: string };

  constructor(
    directory: string,
    readonly operation: "build" | "repair" | "convert" | "enrich",
    readonly source: string,
    options: { conversion?: boolean } = {},
  ) {
    this.paths = {
      directory: path.resolve(directory),
      summaryJson: path.resolve(directory, "summary.json"),
      summaryMarkdown: path.resolve(directory, "summary.md"),
    };
    const selected = [...steps[operation]];
    if (operation === "build" && options.conversion)
      selected.splice(selected.indexOf("packaging") + 1, 0, "conversion");
    this.checks = Object.fromEntries(
      selected.map((id) => [id, { status: "not-run" as const }]),
    );
  }
  private collectDiagnostics(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item) => this.collectDiagnostics(item));
      return;
    }
    const item = value as Record<string, unknown>;
    if (item.status === "fail" && typeof item.tool === "string")
      this.collectDiagnostics({
        severity: "error",
        code: "ENVIRONMENT_TOOL",
        message: `${item.tool}: ${typeof item.detail === "string" ? item.detail : "Required tool is unavailable or has the wrong version"}${typeof item.version === "string" ? ` (found: ${item.version})` : ""}`,
      });
    // EPUBCheck uses uppercase WARNING; project policy blocks those releases.
    // Lowercase warning is an advisory diagnostic from our own/platform checks.
    const isBlocker =
      ["error", "ERROR", "FATAL", "WARNING"].includes(String(item.severity)) ||
      ["review-required", "unsupported"].includes(String(item.classification));
    if (
      (item.severity === "warning" || isBlocker) &&
      typeof item.message === "string"
    ) {
      const warning = {
        code:
          typeof item.code === "string"
            ? item.code
            : typeof item.ID === "string"
              ? item.ID
              : isBlocker
                ? "RELEASE_BLOCKED"
                : "WARNING",
        message: item.message,
        ...(typeof item.source === "string" ? { source: item.source } : {}),
      };
      const destination = isBlocker ? this.blockers : this.warnings;
      if (
        !destination.some(
          (existing) => JSON.stringify(existing) === JSON.stringify(warning),
        )
      )
        destination.push(warning);
    }
    for (const key of [
      "diagnostics",
      "messages",
      "internal",
      "epubcheck",
      "checks",
    ])
      this.collectDiagnostics(item[key]);
  }
  async check<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const check = this.checks[id];
    if (!check) throw new Error(`Unknown release check: ${id}`);
    check.status = "running";
    await this.save();
    try {
      const value = await operation();
      const result = value as
        | {
            status?: string;
            distribution?: CompatibilityReport["distribution"];
            cases?: unknown[];
            coverage?: {
              strategy: string;
              documents: number;
              fullMatrixDocuments: number;
            };
          }
        | undefined;
      check.status = result?.status === "fail" ? "fail" : "pass";
      if (result?.distribution) check.distribution = result.distribution;
      if (Array.isArray(result?.cases)) check.cases = result.cases.length;
      if (result?.coverage) {
        const { strategy, documents, fullMatrixDocuments } = result.coverage;
        check.coverage = { strategy, documents, fullMatrixDocuments };
      }
      this.collectDiagnostics(value);
      await this.save();
      return value;
    } catch (error) {
      const e = error as Error & { code?: string };
      Object.assign(check, {
        status: "fail",
        code: e.code ?? "CHECK_FAILED",
        message: e.message,
      });
      throw error;
    }
  }
  async finish(artifact?: Artifact, error?: unknown) {
    if (error) {
      const e = error as Error & {
        code?: string;
        reports?: ReleaseReporter["paths"];
        details?: unknown;
      };
      this.status = "fail";
      this.failure = { code: e.code ?? "RELEASE_FAILED", message: e.message };
      e.reports = this.paths;
      this.collectDiagnostics(e.details);
    } else {
      if (
        !artifact ||
        Object.values(this.checks).some((check) => check.status !== "pass")
      )
        throw new Error("Cannot report a release before every check passes");
      this.status = "pass";
      this.artifact = artifact;
    }
    await this.save();
  }
  async save() {
    const nextActions =
      this.status === "fail"
        ? [
            this.failure?.code === "ENVIRONMENT_ERROR"
              ? "Restore the pinned toolchain, then rerun the operation."
              : "Resolve the reported failure and rerun the operation; remaining checks have not passed.",
          ]
        : this.status === "pass"
          ? ["Review the warnings and distribution status before delivery."]
          : [
              "Wait for this run to finish before using a publication artifact.",
            ];
    const report = {
      schemaVersion: 1,
      runId: this.runId,
      startedAt: this.startedAt,
      operation: this.operation,
      status: this.status,
      source: this.source,
      ...(this.artifact ? { artifact: this.artifact } : {}),
      checks: this.checks,
      warnings: this.warnings,
      blockers: this.blockers,
      ...(this.failure ? { failure: this.failure } : {}),
      nextActions,
      scope: {
        nativeReaderTesting: "not-run",
        vendorIngestion: "not-run",
        accessibilityCertification: "not-claimed",
      },
      reports: this.paths,
    };
    await json(this.paths.summaryJson, report);
    const evidence = [
      ["metadata", "metadata", "metadata.json"],
      ["preflight", "source preflight", "preflight.json"],
      ["environment", "environment", "environment.json"],
      ["packaging", "images", "images.json"],
      ["conversion", "Chinese conversion", "conversion.json"],
      ["conformance", "EPUBCheck", "epubcheck.txt"],
      ["accessibility", "Ace", "ace/report.html"],
      ["browser", "browser QA", "qa/report.json"],
      ["apple-books", "Apple lint", "apple-books-lint.json"],
      ["kindle", "Kindle lint", "kindle-lint.json"],
      ["reproducibility", "reproducibility", "reproducibility.json"],
    ].filter(([id]) => this.checks[id]?.status === "pass");
    const lines = [
      `# Quillbind ${this.operation}: ${this.status}`,
      "",
      `Run: ${this.runId} · ${this.startedAt}`,
      "",
      `Source: ${clean(this.source)}`,
      "",
      ...(this.artifact
        ? [
            `Artifact: ${clean(this.artifact.path)}`,
            "",
            `SHA-256: ${this.artifact.sha256}`,
            "",
            `Size: ${this.artifact.size} bytes`,
            "",
          ]
        : [
            "No artifact has been released by this run. An existing EPUB may belong to a previous run.",
            "",
          ]),
      "| Check | Result | Detail |",
      "| --- | --- | --- |",
      ...Object.entries(this.checks).map(
        ([id, check]) =>
          `| ${id} | ${check.status} | ${clean(check.distribution ?? check.message ?? (check.cases !== undefined ? `${check.cases} browser cases${check.coverage ? `; ${check.coverage.strategy}: full matrix on ${check.coverage.fullMatrixDocuments}/${check.coverage.documents} documents` : ""}` : ""))} |`,
      ),
      "",
      "## Blockers",
      "",
      ...(this.blockers.length
        ? this.blockers.map(
            (issue) =>
              `- ${clean(issue.code)}: ${clean(issue.message)}${issue.source ? ` (${clean(issue.source)})` : ""}`,
          )
        : [
            this.failure
              ? `${clean(this.failure.code)}: ${clean(this.failure.message)}`
              : "None recorded.",
          ]),
      "",
      "## Warnings",
      "",
      ...(this.warnings.length
        ? this.warnings.map(
            (warning) =>
              `- ${clean(warning.code)}: ${clean(warning.message)}${warning.source ? ` (${clean(warning.source)})` : ""}`,
          )
        : ["None recorded by the checks completed in this run."]),
      "",
      "## Next actions",
      "",
      ...(this.failure
        ? [`- ${clean(this.failure.code)}: ${clean(this.failure.message)}`]
        : []),
      ...nextActions.map((action) => `- ${action}`),
      "",
      "Conformance, automated accessibility, browser QA, platform guideline lint and distribution policy are separate results. Native Apple Books/Kindle testing and store ingestion were not run. Automated accessibility results are not certification.",
      "",
      `Detailed evidence: [run result](build.json)${evidence.map(([, title, file]) => `, [${title}](${file})`).join("")}. Unlinked reports can belong to an earlier run; use the run result for current failures.`,
      "",
    ];
    await atomicWrite(this.paths.summaryMarkdown, lines.join("\n"));
    return report;
  }
}
