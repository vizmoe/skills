import fs from "node:fs/promises";
import path from "node:path";
import { conversionTarget, type ConversionOptions } from "./zhconvert.js";
import { convertChineseContent } from "./chinese-conversion.js";
import { convertWithLock } from "./conversion-lock.js";
import { doctor, releaseGates } from "./pipeline.js";
import { ReleaseReporter } from "./reporting.js";
import { checkAbort, fail } from "./errors.js";
import { json } from "./json.js";
import { readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";

export async function convertEpub(
  file: string,
  options: ConversionOptions & { output: string },
) {
  conversionTarget(options.target);
  checkAbort(options.signal);
  const output = path.resolve(options.output);
  if (
    path.resolve(file) === output ||
    (await fs.lstat(output).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    ))
  )
    fail(
      "OUTPUT_EXISTS",
      "Conversion output must be a new path; original EPUB is protected",
    );
  const bytes = await readSourceFile(file);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const lockfile = output + ".conversion.lock";
  const lock = await fs
    .open(lockfile, "wx")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        fail("CONVERSION_BUSY", "Another conversion owns the output lock");
      throw error;
    });
  const reports = output + ".reports";
  const summary = new ReleaseReporter(reports, "convert", path.resolve(file));
  const candidate = output + `.${summary.runId}.candidate.epub`;
  try {
    await summary.save();
    await json(path.join(reports, "build.json"), {
      status: "running",
      runId: summary.runId,
      reports: summary.paths,
    });
    const environment = await summary.check("environment", () => doctor());
    await json(path.join(reports, "environment.json"), environment);
    if (environment.status === "fail")
      fail(
        "ENVIRONMENT_ERROR",
        "Required toolchain is unavailable",
        environment.checks,
      );
    const converted = await summary.check("conversion", async () => {
      const converted = await convertWithLock(
        bytes,
        options,
        `${path.resolve(file)}.${options.target}.conversion.lock.json`,
      );
      await json(path.join(reports, "conversion.json"), converted.report);
      return converted;
    });
    checkAbort(options.signal);
    await fs.writeFile(candidate, converted.bytes, { flag: "wx" });
    const gates = await releaseGates(candidate, reports, {
      signal: options.signal,
      reporter: summary,
    });
    const reproducibility = await summary.check("reproducibility", async () => {
      const repeated = await convertChineseContent(bytes, converted.session);
      const firstSha256 = sha256(converted.bytes),
        secondSha256 = sha256(repeated.bytes);
      const result = {
        status: firstSha256 === secondSha256 ? "pass" : "fail",
        firstSha256,
        secondSha256,
        conversion: "frozen API responses",
      };
      await json(path.join(reports, "reproducibility.json"), result);
      if (result.status === "fail")
        fail("NONDETERMINISTIC_BUILD", "Repeated converted EPUB bytes differ");
      return result;
    });
    checkAbort(options.signal);
    // A concurrent creator or dangling symlink must never be overwritten.
    await fs.link(candidate, output);
    const artifact = {
      path: output,
      sha256: sha256(converted.bytes),
      size: converted.bytes.length,
      mediaType: "application/epub+zip",
    };
    const report = {
      status: "pass" as const,
      artifact,
      gates,
      conversion: converted.report,
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
      code: e.code ?? "CONVERSION_FAILED",
      message: e.message,
      details: e.details,
      runId: summary.runId,
      reports: summary.paths,
    });
    throw error;
  } finally {
    await fs.rm(candidate, { force: true });
    await lock.close();
    await fs.unlink(lockfile);
  }
}
