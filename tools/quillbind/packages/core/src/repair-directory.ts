import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { repairReadingCopy } from "./reading-copy.js";
import { planFromBytes } from "./repair-plan.js";
import { atomicWrite, bookOutput, exists, readSourceFile } from "./files.js";
import { json, readJson } from "./json.js";
import { sha256 } from "./hash.js";
import { checkAbort, fail } from "./errors.js";

const savedCopy = z.object({
  status: z.literal("repaired"),
  inputSha256: z.string(),
  originalUnchanged: z.literal(true),
  contentIntegrity: z.literal("pass"),
  idempotent: z.literal(true),
  copy: z.object({ sha256: z.string() }),
  changes: z.number().int().nonnegative(),
  brokenReferences: z.number().int().nonnegative(),
  checks: z.record(z.string(), z.string()),
});
export interface DirectoryRepairEntry {
  source: string;
  relativePath: string;
  inputSha256: string;
  status: "repaired" | "fail";
  resumed: boolean;
  copy?: { path: string; sha256: string };
  changes?: number;
  brokenReferences?: number;
  checks?: Record<string, string>;
  reports: { directory: string; json: string; markdown: string };
  error?: { code: string; message: string };
}

/** Snapshot inputs once, repair independently, and resume only hash-verified copies. */
export async function repairDirectory(
  input: string,
  options: { output: string; jobs?: number; signal?: AbortSignal },
) {
  const jobs = options.jobs ?? 2;
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4)
    fail("ARGUMENT_INVALID", "--jobs must be an integer from 1 to 4");
  checkAbort(options.signal);
  const source = await fs.realpath(input);
  if (!(await fs.stat(source)).isDirectory())
    fail("UNSUPPORTED_FORMAT", "Directory repair requires a source directory");
  const requested = path.resolve(options.output);
  if (requested === source)
    fail("OUTPUT_EXISTS", "Use a distinct output directory");
  await fs.mkdir(requested, { recursive: true });
  const output = await fs.realpath(requested);
  if (source === output || source.startsWith(output + path.sep))
    fail("OUTPUT_EXISTS", "Output must be outside the source's ancestor chain");
  const reports = {
    json: path.join(output, "repair-summary.json"),
    markdown: path.join(output, "README.md"),
  };
  const previous = await readJson<{ source?: string }>(reports.json).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      fail(
        "OUTPUT_EXISTS",
        "Existing repair index cannot be verified; preserved",
      );
    },
  );
  if (
    (previous && previous.source !== source) ||
    (!previous && (await exists(reports.markdown)))
  )
    fail(
      "OUTPUT_EXISTS",
      "Existing output index belongs to other content; preserved",
    );
  const lockfile = path.join(output, ".repair-directory.lock");
  const lock = await fs
    .open(lockfile, "wx")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        fail("REPAIR_BUSY", "Another directory repair owns this output");
      throw error;
    });
  try {
    const inputs: { file: string; relative: string; hash: string }[] = [];
    const visit = async (directory: string) => {
      const children = (
        await fs.readdir(directory, { withFileTypes: true })
      ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of children) {
        checkAbort(options.signal);
        const file = path.join(directory, entry.name);
        if (
          file === output ||
          file.startsWith(output + path.sep) ||
          entry.isSymbolicLink()
        )
          continue;
        if (entry.isDirectory()) await visit(file);
        else if (
          entry.isFile() &&
          /\.epub$/i.test(entry.name) &&
          !/\.candidate\.epub$/i.test(entry.name)
        )
          inputs.push({
            file,
            relative: path.relative(source, file),
            hash: sha256(await readSourceFile(file)),
          });
      }
    };
    await visit(source);
    if (!inputs.length) fail("INPUT_EMPTY", "No original EPUB files found");
    const results: (DirectoryRepairEntry | undefined)[] = new Array(
      inputs.length,
    );
    const aggregate = (finished = false) => {
      const rows = results.filter(
        (row): row is DirectoryRepairEntry => row !== undefined,
      );
      const repaired = rows.filter((row) => row.status === "repaired").length;
      return {
        status: finished
          ? repaired === inputs.length
            ? "pass"
            : "fail"
          : "running",
        operation: "repair-directory",
        source,
        output,
        total: inputs.length,
        completed: rows.length,
        repaired,
        failed: rows.length - repaired,
        publicationReady: false,
        reports,
        results: rows,
      };
    };
    let saving = Promise.resolve();
    const save = () => {
      saving = saving.then(() => json(reports.json, aggregate()));
      return saving;
    };
    const repair = async (
      item: (typeof inputs)[number],
    ): Promise<DirectoryRepairEntry> => {
      const target = path.join(output, item.relative);
      const directory = path.join(
        output,
        ".quillbind-reports",
        sha256(item.relative).slice(0, 16),
      );
      const row: DirectoryRepairEntry = {
        source: item.file,
        relativePath: item.relative,
        inputSha256: item.hash,
        status: "fail",
        resumed: false,
        reports: {
          directory,
          json: path.join(directory, "summary.json"),
          markdown: path.join(directory, "summary.md"),
        },
      };
      try {
        checkAbort(options.signal);
        const bytes = await readSourceFile(item.file);
        if (sha256(bytes) !== item.hash)
          fail("SOURCE_CHANGED", "Source changed after the directory snapshot");
        const targetStat = await fs
          .lstat(target)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          });
        if (targetStat) {
          const parsed = savedCopy.safeParse(
            await readJson<unknown>(row.reports.json).catch(() => undefined),
          );
          if (
            !targetStat.isFile() ||
            !parsed.success ||
            parsed.data.inputSha256 !== item.hash ||
            parsed.data.copy.sha256 !== sha256(await readSourceFile(target))
          )
            fail(
              "OUTPUT_EXISTS",
              "Existing output has no matching verified summary; preserved",
            );
          return {
            ...row,
            status: "repaired",
            resumed: true,
            copy: { path: target, sha256: parsed.data.copy.sha256 },
            changes: parsed.data.changes,
            brokenReferences: parsed.data.brokenReferences,
            checks: parsed.data.checks,
          };
        }
        const relativeParent = path.dirname(item.relative);
        if (relativeParent !== ".") await bookOutput(output, relativeParent);
        await bookOutput(output, path.relative(output, directory));
        const plan = planFromBytes(bytes, "reading");
        const result = await repairReadingCopy(item.file, {
          plan,
          output: target,
          reports: directory,
          signal: options.signal,
        });
        return {
          ...row,
          status: "repaired",
          copy: { path: result.copy.path, sha256: result.copy.sha256 },
          changes: result.changes,
          brokenReferences: result.brokenReferences,
          checks: result.checks,
        };
      } catch (error) {
        const e = error as Error & { code?: string };
        return {
          ...row,
          error: {
            code: options.signal?.aborted
              ? "CANCELLED"
              : (e.code ?? "REPAIR_FAILED"),
            message: e.message,
          },
        };
      }
    };
    let next = 0;
    const worker = async () => {
      while (next < inputs.length && !options.signal?.aborted) {
        const index = next++;
        results[index] = await repair(inputs[index]);
        await save();
      }
    };
    await save();
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(jobs, inputs.length) }, worker),
    );
    await saving;
    const failure = workers.find((worker) => worker.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const result = aggregate(true);
    await json(reports.json, result);
    const label = (value: string) =>
      value.replace(/[\r\n]/g, " ").replace(/[\\`*_{}[\]<>|]/g, "\\$&");
    await atomicWrite(
      reports.markdown,
      [
        "# EPUB reading copies",
        "",
        `${result.repaired}/${result.total} repaired. Publication ready: false. Originals are preserved; reports record remaining findings and sampled browser coverage.`,
        "",
        "| Book | Result | Report |",
        "| --- | --- | --- |",
        ...result.results.map(
          (row) =>
            `| ${row.copy ? `[${label(row.relativePath)}](<${encodeURI(row.copy.path)}>)` : label(row.relativePath)} | ${row.status}${row.resumed ? " (resumed)" : ""} | ${row.status === "repaired" ? `[Report](<${encodeURI(row.reports.markdown)}>)` : "See repair-summary.json"} |`,
        ),
        "",
      ].join("\n"),
    );
    checkAbort(options.signal);
    return result;
  } finally {
    await lock.close();
    await fs.unlink(lockfile);
  }
}
