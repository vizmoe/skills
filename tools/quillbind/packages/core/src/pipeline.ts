import fs from "node:fs/promises";
import path from "node:path";
import { openBook, type BookProject } from "./config.js";
import type { QaOptions } from "./qa-plan.js";
import { resolveMetadataWithLock, type MetadataLock } from "./metadata.js";
import { preflightBook } from "./preflight.js";
import { publicationFromBook } from "./publication.js";
import { renderPublication } from "./render.js";
import { pack, compressionReport } from "./zip.js";
import { validateInspectedEpub, compatibilityLint } from "./validate.js";
import { runInspectedQa } from "./qa.js";
import { browserPath } from "./qa-environment.js";
import { runAce, aceExecutable } from "./ace.js";
import { inspectBytes, type EpubInspection } from "./epub.js";
import { describeInspection } from "./inspection.js";
import { json, readJson } from "./json.js";
import { sha256 } from "./hash.js";
import { repoRoot, VERSION, javaExecutable } from "./runtime.js";
import { readSourceFile, exists, bookOutput, atomicWrite } from "./files.js";
import { checkAbort, fail } from "./errors.js";
import { run } from "./process.js";
import type { Artifact } from "./model.js";
import { ReleaseReporter } from "./reporting.js";
import { ZhconvertSession, type ConversionOptions } from "./zhconvert.js";
import { convertChineseContent } from "./chinese-conversion.js";
import { convertWithLock } from "./conversion-lock.js";

export async function doctor() {
  const toolchain = await readJson<{
    node: string;
    java: { version: string };
    epubcheck: { version: string };
  }>(path.join(repoRoot, "standards/tools.lock.json"));
  const checks: {
    tool: string;
    status: "pass" | "fail";
    version?: string;
    detail?: string;
  }[] = [];
  checks.push({
    tool: "node",
    status: process.versions.node === toolchain.node ? "pass" : "fail",
    version: process.versions.node,
    detail: `Pinned runtime: ${toolchain.node}`,
  });
  try {
    const java = await run(await javaExecutable(), ["-version"], {
      timeout: 10000,
    });
    const expected = toolchain.java.version;
    checks.push({
      tool: "java",
      status:
        java.exitCode === 0 && java.stderr.includes(`version "${expected}"`)
          ? "pass"
          : "fail",
      version: java.stderr.split("\n")[0],
    });
  } catch (error) {
    checks.push({ tool: "java", status: "fail", detail: String(error) });
  }
  for (const [tool, file] of [
    [
      "epubcheck",
      `.cache/tools/epubcheck-${toolchain.epubcheck.version}/epubcheck.jar`,
    ],
  ])
    checks.push({
      tool,
      status: (await exists(path.join(repoRoot, file))) ? "pass" : "fail",
    });
  try {
    checks.push({
      tool: "ace",
      status: (await exists(aceExecutable())) ? "pass" : "fail",
    });
  } catch (error) {
    checks.push({ tool: "ace", status: "fail", detail: String(error) });
  }
  try {
    await browserPath();
    checks.push({ tool: "chromium", status: "pass" });
  } catch (error) {
    checks.push({ tool: "chromium", status: "fail", detail: String(error) });
  }
  return {
    status: checks.every((c) => c.status === "pass")
      ? ("pass" as const)
      : ("fail" as const),
    version: VERSION,
    checks,
  };
}
export async function releaseGates(
  candidate: string,
  reports: string,
  options: {
    signal?: AbortSignal;
    reporter?: ReleaseReporter;
    qa?: QaOptions;
  } = {},
) {
  checkAbort(options.signal);
  const check = <T>(id: string, run: () => Promise<T>) =>
    options.reporter ? options.reporter.check(id, run) : run();
  let inspection: EpubInspection | undefined;
  let byteLength = 0;
  const validation = await check("conformance", async () => {
    const bytes = await readSourceFile(candidate);
    byteLength = bytes.length;
    try {
      inspection = inspectBytes(bytes, true);
    } catch {
      // Preserve structured internal-validation diagnostics for malformed archives.
      return validateInspectedEpub(candidate, bytes, {
        reports,
        signal: options.signal,
      });
    }
    return validateInspectedEpub(candidate, inspection, {
      reports,
      signal: options.signal,
    });
  });
  if (validation.status === "fail")
    fail("VALIDATION_FAILED", "EPUB validation failed", validation);
  const ace = await check("accessibility", () =>
    runAce(candidate, reports, options.signal),
  );
  if (ace.status === "fail")
    fail("ACCESSIBILITY_FAILED", "Ace accessibility checks failed", ace);
  const qa = await check("browser", () =>
    runInspectedQa(candidate, inspection!, {
      ...options.qa,
      reports: path.join(reports, "qa"),
      signal: options.signal,
    }),
  );
  if (qa.status === "fail")
    fail("QA_FAILED", "Browser QA failed", qa.diagnostics);
  const apple = await check("apple-books", () =>
    compatibilityLint(inspection!, "apple-books"),
  );
  const kindle = await check("kindle", () =>
    compatibilityLint(inspection!, "kindle"),
  );
  await json(path.join(reports, "apple-books-lint.json"), apple);
  await json(path.join(reports, "kindle-lint.json"), kindle);
  await json(path.join(reports, "diagnostics.json"), {
    diagnostics: [
      ...validation.internal.diagnostics,
      ...qa.diagnostics,
      ...apple.diagnostics,
      ...kindle.diagnostics,
    ],
    epubcheck: validation.epubcheck,
    ace,
  });
  if (apple.status === "fail" || kindle.status === "fail")
    fail("COMPATIBILITY_FAILED", "Platform technical lint failed", {
      apple,
      kindle,
    });
  await json(
    path.join(reports, "manifest.json"),
    describeInspection(inspection!, byteLength),
  );
  const compression = compressionReport(inspection!.entries);
  await json(path.join(reports, "compression.json"), compression);
  return {
    compression,
    validation,
    ace,
    qa: {
      status: qa.status,
      cases: qa.cases.length,
      automatedAccessibilityChecks: qa.automatedAccessibilityChecks,
      coverage: qa.coverage,
    },
    apple,
    kindle,
  };
}
export async function buildBook(
  input: string | BookProject,
  options: {
    signal?: AbortSignal;
    online?: boolean;
    conversion?: Omit<ConversionOptions, "signal">;
    qa?: QaOptions;
  } = {},
) {
  const project = typeof input === "string" ? await openBook(input) : input;
  checkAbort(options.signal);
  const conversionOptions = options.conversion ?? project.config.conversion;
  let conversion: ZhconvertSession | undefined;
  let conversionReport:
    Awaited<ReturnType<typeof convertWithLock>>["report"] | undefined;
  const output = await bookOutput(project.root, "dist");
  const reports = await bookOutput(project.root, "dist/reports");
  const lockfile = path.join(output, ".build.lock");
  let lock;
  try {
    lock = await fs.open(lockfile, "wx");
  } catch {
    fail(
      "BUILD_BUSY",
      "Another build owns dist/.build.lock; inspect the running build before removing a stale lock",
    );
  }
  const candidate = path.join(output, "candidate.epub");
  const summary = new ReleaseReporter(reports, "build", project.root, {
    conversion: !!conversionOptions,
  });
  try {
    await summary.save();
    await json(path.join(reports, "build.json"), {
      status: "running",
      runId: summary.runId,
      reports: summary.paths,
    });
    let lockMetadata: MetadataLock | undefined;
    const metadata = await summary.check("metadata", async () => {
      const resolved = await resolveMetadataWithLock(project, {
        signal: options.signal,
      });
      lockMetadata = resolved.lock;
      return resolved.resolution;
    });
    await json(path.join(reports, "metadata.json"), metadata);
    if (metadata.status === "fail" || !lockMetadata)
      fail(
        "METADATA_UNRESOLVED",
        "Required metadata needs resolution",
        metadata.diagnostics,
      );
    await json(path.join(reports, "metadata-provenance.json"), lockMetadata);
    const preflight = await summary.check("preflight", () =>
      preflightBook(project, options),
    );
    await json(path.join(reports, "preflight.json"), {
      status: preflight.status,
      diagnostics: preflight.diagnostics,
      qaProjection: preflight.qaProjection,
      chapters: preflight.documents.map((d) => ({
        source: d.source,
        id: d.id,
        ...(d.chapterMetadata ? { chapterMetadata: d.chapterMetadata } : {}),
      })),
    });
    if (preflight.status === "fail")
      fail("PREFLIGHT_FAILED", "Preflight failed", preflight.diagnostics);
    const environment = await summary.check("environment", () => doctor());
    await json(path.join(reports, "environment.json"), environment);
    if (environment.status === "fail")
      fail(
        "ENVIRONMENT_ERROR",
        "Required toolchain is unavailable",
        environment.checks,
      );
    const prepared = { lock: lockMetadata, documents: preflight.documents };
    const rendered = await summary.check("packaging", async () => {
      const publication = await publicationFromBook(project, prepared);
      await json(
        path.join(reports, "images.json"),
        publication.resources
          .filter((r) => r.imageProcessing)
          .flatMap((r) =>
            r.imageProcessing!.map((image) => ({ href: r.href, ...image })),
          ),
      );
      const entries = await renderPublication(publication);
      return pack(entries, project.config.build.epoch);
    });
    const bytes = conversionOptions
      ? await summary.check("conversion", async () => {
          const converted = await convertWithLock(
            rendered,
            {
              ...conversionOptions,
              online: options.online ?? options.conversion?.online,
              signal: options.signal,
            },
            path.join(
              await bookOutput(project.root, "metadata"),
              `conversion.${conversionOptions.target}.lock.json`,
            ),
            project.config.build.epoch,
          );
          conversion = converted.session;
          conversionReport = converted.report;
          await json(path.join(reports, "conversion.json"), conversionReport);
          return converted.bytes;
        })
      : rendered;
    await atomicWrite(candidate, bytes);
    const gates = await releaseGates(candidate, reports, {
      ...options,
      qa: { ...project.config.qa, ...options.qa },
      reporter: summary,
    });
    checkAbort(options.signal);
    const reproducibility = await summary.check("reproducibility", async () => {
      const renderedAgain = pack(
        await renderPublication(
          await publicationFromBook(await openBook(project.root)),
        ),
        project.config.build.epoch,
      );
      const repeated = conversion
        ? (
            await convertChineseContent(
              renderedAgain,
              conversion,
              project.config.build.epoch,
            )
          ).bytes
        : renderedAgain;
      const firstHash = sha256(bytes),
        secondHash = sha256(repeated);
      const reproducibility = {
        status: firstHash === secondHash ? "pass" : "fail",
        firstSha256: firstHash,
        secondSha256: secondHash,
        epoch: project.config.build.epoch,
        ...(conversion ? { conversion: "frozen API responses" } : {}),
      };
      await json(path.join(reports, "reproducibility.json"), reproducibility);
      if (firstHash !== secondHash)
        fail("NONDETERMINISTIC_BUILD", "Repeated EPUB bytes differ");
      return reproducibility;
    });
    const firstHash = reproducibility.firstSha256;
    await json(
      path.join(reports, "dependencies.json"),
      await readJson(path.join(repoRoot, "standards/dependencies.lock.json")),
    );
    await json(
      path.join(reports, "standards.json"),
      await readJson(path.join(repoRoot, "standards/registry.json")),
    );
    const artifact: Artifact = {
      path: path.join(output, "book.epub"),
      mediaType: "application/epub+zip",
      sha256: firstHash,
      size: bytes.length,
    };
    await fs.rename(candidate, artifact.path);
    const report = {
      status: "pass" as const,
      version: VERSION,
      artifact,
      gates,
      ...(conversionReport ? { conversion: conversionReport } : {}),
      reproducibility,
      runId: summary.runId,
      reports: summary.paths,
    };
    await json(path.join(reports, "build.json"), report);
    await summary.finish(artifact);
    return report;
  } catch (error) {
    const e = error as Error & { code?: string; details?: unknown };
    await summary.finish(undefined, error);
    await json(path.join(reports, "build.json"), {
      status: "fail",
      runId: summary.runId,
      reports: summary.paths,
      code: e.code ?? "BUILD_FAILED",
      message: e.message,
      details: e.details,
    });
    await json(path.join(reports, "diagnostics.json"), {
      status: "fail",
      code: e.code ?? "BUILD_FAILED",
      message: e.message,
      details: e.details,
    });
    throw error;
  } finally {
    await lock.close();
    await fs.unlink(lockfile);
  }
}
