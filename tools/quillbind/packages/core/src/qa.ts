import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "@playwright/test";
import { runPageChecks } from "./qa-page.js";
import {
  planQa,
  inspectedQaDocuments,
  type QaOptions,
  type QaPlan,
} from "./qa-plan.js";
export { paginationPreservesContent } from "./qa-pagination.js";
import { inspectBytes, type EpubInspection } from "./epub.js";
import { validateInternal } from "./validate.js";
import { browserPath, serveEpub } from "./qa-environment.js";
export { browserPath, serveEpub } from "./qa-environment.js";
export { runAce } from "./ace.js";
import { EPUB } from "./standards.js";
import { json } from "./json.js";
import { fail, diagnostic, result, checkAbort } from "./errors.js";
import { escapeXml } from "./xml.js";
import { readSourceFile } from "./files.js";
import type { Diagnostic } from "./model.js";

export interface QaScreenshot {
  file: string;
  document: string;
  reason: string;
  bytes: number;
}
export interface QaReport {
  status: "pass" | "fail";
  artifactSha256: string;
  automatedAccessibilityChecks: "pass" | "fail";
  diagnostics: Diagnostic[];
  cases: unknown[];
  environment: Record<string, unknown>;
  coverage: QaPlan & {
    executedCases: number;
    unexecutedCases: number;
    execution: {
      document: string;
      plannedCases: number;
      executedCases: number;
    }[];
    screenshots: QaPlan["screenshots"] & {
      retained: number;
      bytes: number;
      files: QaScreenshot[];
    };
  };
}
export async function runQa(
  file: string,
  options: QaOptions & { reports?: string; signal?: AbortSignal } = {},
): Promise<QaReport> {
  checkAbort(options.signal);
  const bytes = await readSourceFile(file);
  let info: EpubInspection;
  try {
    info = inspectBytes(bytes, true);
  } catch (error) {
    const e = error as Error & { code?: string };
    fail(
      "QA_UNSAFE_INPUT",
      "Internal validation must pass before browser execution",
      [diagnostic(e.code ?? "EPUB_INVALID", e.message, undefined, EPUB)],
    );
  }
  const safety = validateInternal(info);
  if (safety.status === "fail")
    fail(
      "QA_UNSAFE_INPUT",
      "Internal validation must pass before browser execution",
      safety.diagnostics,
    );
  return runInspectedQa(file, info, options);
}

/** Internal gate entry: validateInternal(info) must pass before opening a browser. */
export async function runInspectedQa(
  file: string,
  info: EpubInspection,
  options: QaOptions & { reports?: string; signal?: AbortSignal } = {},
): Promise<QaReport> {
  checkAbort(options.signal);
  const plan = planQa(inspectedQaDocuments(info), options);
  const output = options.reports ?? path.join(path.dirname(file), "reports/qa");
  await fs.rm(path.join(output, "screenshots"), {
    recursive: true,
    force: true,
  });
  await fs.mkdir(path.join(output, "screenshots"), { recursive: true });
  const executablePath = await browserPath();
  checkAbort(options.signal);
  const browser = await chromium
    .launch({ executablePath, headless: true, timeout: 30000 })
    .catch((error: unknown) => {
      checkAbort(options.signal);
      fail("ENVIRONMENT_ERROR", `Chromium could not start: ${String(error)}`, {
        tool: "chromium",
        reason: "launch-failed",
      });
    });
  let server: Awaited<ReturnType<typeof serveEpub>> | undefined;
  let browserClosing: Promise<void> | undefined;
  const closeBrowser = () => (browserClosing ??= browser.close());
  const onAbort = () => {
    void closeBrowser().catch(() => {});
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const diagnostics: Diagnostic[] = [];
  const cases: unknown[] = [];
  const screenshots: {
    file: string;
    document: string;
    reason: string;
    bytes: number;
  }[] = [];
  const execution: {
    document: string;
    plannedCases: number;
    executedCases: number;
  }[] = [];
  let axeFailures = 0;
  let browserVersion: string;
  let fontSet: string[] = [];
  try {
    checkAbort(options.signal);
    server = await serveEpub(info);
    const origin = server.origin;
    browserVersion = browser.version();
    for (const assignment of plan.assignments) {
      const name = assignment.path;
      checkAbort(options.signal);
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        locale: "en-US",
        timezoneId: "UTC",
        serviceWorkers: "block",
        javaScriptEnabled: true,
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          diagnostics.push(
            diagnostic(
              "QA_NETWORK",
              "Blocked unexpected browser request",
              name,
            ),
          );
          await route.abort();
        } else await route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) =>
        diagnostics.push(diagnostic("QA_SCRIPT", error.message, name)),
      );
      page.on("response", (response) => {
        if (response.status() >= 400)
          diagnostics.push(
            diagnostic(
              "QA_RESOURCE",
              `HTTP ${response.status()}: ${new URL(response.url()).pathname}`,
              name,
            ),
          );
      });
      try {
        const evidence = await runPageChecks(page, info.documents.get(name)!, {
          name,
          origin,
          output,
          signal: options.signal,
          assignment,
          screenshotPolicy: plan.screenshots.policy,
          observedErrors: () =>
            diagnostics.filter((diagnostic) => diagnostic.source === name)
              .length,
        });
        diagnostics.push(...evidence.diagnostics);
        cases.push(...evidence.cases);
        axeFailures += evidence.axeFailures;
        fontSet = evidence.fontSet;
        screenshots.push(...evidence.screenshots);
        execution.push({
          document: name,
          plannedCases: assignment.modes.length * plan.viewports.length + 1,
          executedCases: evidence.cases.length,
        });
      } catch (error) {
        checkAbort(options.signal);
        diagnostics.push(diagnostic("QA_EXECUTION", String(error), name));
      } finally {
        await context.close().catch((error: unknown) => {
          diagnostics.push(diagnostic("QA_CONTEXT_CLOSE", String(error), name));
        });
      }
    }
  } catch (error) {
    checkAbort(options.signal);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    const cleanup = await Promise.allSettled([closeBrowser(), server?.close()]);
    for (const [index, result] of cleanup.entries())
      if (result.status === "rejected")
        diagnostics.push(
          diagnostic(
            index === 0 ? "QA_BROWSER_CLOSE" : "QA_SERVER_CLOSE",
            String(result.reason),
          ),
        );
  }
  checkAbort(options.signal);
  if (cases.length !== plan.cases)
    diagnostics.push(
      diagnostic(
        "QA_INCOMPLETE",
        `Executed ${cases.length} of ${plan.cases} planned browser cases`,
      ),
    );
  const coverage = {
    ...plan,
    executedCases: cases.length,
    unexecutedCases: plan.cases - cases.length,
    execution,
    screenshots: {
      ...plan.screenshots,
      retained: screenshots.length,
      bytes: screenshots.reduce(
        (total, screenshot) => total + screenshot.bytes,
        0,
      ),
      files: screenshots,
    },
    checks: [
      "spine",
      "navigation",
      "resources",
      "reflow",
      "text-scaling",
      "font-override",
      "line-spacing",
      "reader-colors",
      "grayscale-render",
      "code-copy",
      "footnote-roundtrip",
      "MathML-dimensions",
      "pagination",
      "axe",
    ],
    notClaimed: [
      "Apple Books device execution",
      "Kindle device execution",
      "WCAG certification",
      "semantic correctness of alt text",
      "human perception of color-only information",
    ],
  };
  const report: QaReport = {
    ...result(diagnostics),
    artifactSha256: info.sha256,
    automatedAccessibilityChecks:
      axeFailures || diagnostics.some((d) => d.code === "QA_EXECUTION")
        ? "fail"
        : "pass",
    cases,
    environment: {
      os: os.platform(),
      release: os.release(),
      arch: os.arch(),
      node: process.version,
      browser: browserVersion,
      deviceScaleFactor: 1,
      locale: "en-US",
      timezone: "UTC",
      fontSet,
    },
    coverage,
  };
  await json(path.join(output, "report.json"), report);
  await json(path.join(output, "coverage.json"), coverage);
  await fs.writeFile(
    path.join(output, "report.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Quillbind QA</title><h1>Browser QA: ${report.status}</h1><pre>${escapeXml(JSON.stringify(report, null, 2))}</pre></html>`,
  );
  return report;
}
