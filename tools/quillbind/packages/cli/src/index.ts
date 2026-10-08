#!/usr/bin/env node
import { formatHuman } from "./human.js";
import { parseArgs } from "node:util";
import {
  resolveMetadata,
  resolveBookWalker,
  preflightBook,
  buildBook,
  previewBook,
  validateEpub,
  runQa,
  inspectEpub,
  auditEpub,
  createRepairPlan,
  repairEpub,
  repairReadingCopy,
  repairDirectory,
  convertEpub,
  enrichEpub,
  packageManga,
  checkNotes,
  conversionTarget,
  zhconvertNotice,
  taxonomy,
  schemaJson,
  formats,
  doctor,
  initBook,
  prepareBook,
  inspectNovel,
  fetchNovelBook,
  inspectionSummary,
  formatInspection,
  VERSION,
} from "@quillbind/core";
import { readJson, stable } from "@quillbind/core/json";
import { fail } from "@quillbind/core/errors";
import type { RepairPlan } from "@quillbind/core";

const HELP = [
  `Quillbind ${VERSION} — EPUB 3.3 and manga CBZ`,
  "",
  "quillbind init <directory> [--theme literature|technical]",
  "quillbind init <new-directory> --from <source-directory> --config <book.yaml>",
  "quillbind doctor",
  "quillbind novel inspect <book-url>",
  "quillbind novel fetch <book-url> [--output new-directory] [--volumes 1-3,5] [--split-volumes] [--prepare-only]",
  "quillbind metadata bookwalker SOURCES.json --output LOCK.json [--online]",
  "quillbind metadata resolve <book-directory> [--online]",
  "quillbind preflight <book-directory> [--qa-coverage full|stratified]",
  "quillbind build <book-directory> [--to simplified|traditional|china|taiwan|hongkong] [--online]",
  "quillbind preview <book-directory> [--to TARGET] [--online]",
  "quillbind inspect <file.epub> [--summary]",
  "quillbind validate|qa <file.epub>",
  "quillbind epub inspect|audit|repair-plan <file.epub> [--output plan.json]",
  "quillbind epub check-notes <file.epub> [--execute-scripts] [--cases CASES.json] [--reports DIRECTORY]",
  "quillbind epub repair <file.epub> --plan plan.json --output repaired.epub",
  "quillbind manga package <scan-directory|file.zip|file.cbz> --bookwalker LOCK.json --output volume.cbz [--page-order ORDER.json] [--reading-direction rtl|ltr]",
  "quillbind epub enrich <file.epub> --bookwalker LOCK.json --output enriched.epub",
  "quillbind epub convert <file.epub> --to simplified|traditional|china|taiwan|hongkong --output converted.epub [--online]",
  "quillbind epub repair-plan <file.epub> --purpose reading --output plan.json",
  "quillbind epub repair-copy <file.epub> --plan plan.json --output copy.epub [--reports directory]",
  "quillbind epub repair-directory <directory> --output <directory> [--jobs 2]",
  "quillbind taxonomy list|explain [tag]",
  "quillbind schema|formats|version",
  "",
  "--json writes JSON to stdout. Human logs go to stderr.",
  "inspect is read-only and does not run validators. No release gate can be skipped.",
  "Chinese conversion uses a saved lock; --online refreshes it through the zhconvert HTTPS API.",
  "build, preview, qa and novel fetch also accept --qa-coverage full|stratified; full is the default.",
  "novel fetch defaults to one merged EPUB; --prepare-only saves an offline Markdown book without release checks.",
  "novel accepts --delay milliseconds; fetch also accepts --title, --author (repeatable), --description and --language.",
  zhconvertNotice,
  "",
].join("\n");
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
let jsonMode = process.argv.includes("--json");
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      online: { type: "boolean" },
      "qa-coverage": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      theme: { type: "string" },
      output: { type: "string" },
      plan: { type: "string" },
      bookwalker: { type: "string" },
      "execute-scripts": { type: "boolean" },
      cases: { type: "string" },
      "page-order": { type: "string" },
      "reading-direction": { type: "string" },
      from: { type: "string" },
      config: { type: "string" },
      summary: { type: "boolean" },
      purpose: { type: "string" },
      reports: { type: "string" },
      to: { type: "string" },
      jobs: { type: "string" },
      volumes: { type: "string" },
      "split-volumes": { type: "boolean" },
      "prepare-only": { type: "boolean" },
      delay: { type: "string" },
      title: { type: "string" },
      author: { type: "string", multiple: true },
      description: { type: "string" },
      language: { type: "string" },
    },
  });
  jsonMode = !!values.json;
  const [command, subcommand, third] = positionals;
  if (
    command !== "novel" &&
    [
      values.volumes,
      values["split-volumes"],
      values["prepare-only"],
      values.delay,
      values.title,
      values.author,
      values.description,
      values.language,
    ].some((value) => value !== undefined)
  )
    fail(
      "ARGUMENT_CONFLICT",
      "Novel options are supported by novel inspect/fetch only",
    );
  if (
    values.to &&
    command !== "build" &&
    command !== "preview" &&
    !(command === "epub" && subcommand === "convert")
  )
    fail(
      "ARGUMENT_CONFLICT",
      "--to is supported by build, preview and epub convert",
    );
  if (
    values.bookwalker &&
    !(command === "epub" && subcommand === "enrich") &&
    !(command === "manga" && subcommand === "package")
  )
    fail(
      "ARGUMENT_CONFLICT",
      "--bookwalker is supported by epub enrich and manga package",
    );
  if (
    (values["page-order"] || values["reading-direction"]) &&
    !(command === "manga" && subcommand === "package")
  )
    fail(
      "ARGUMENT_CONFLICT",
      "Manga page options are supported by manga package only",
    );
  const required = (value: string | undefined, label: string) =>
    value ?? fail("ARGUMENT_REQUIRED", `Missing ${label}`);
  if (
    (values["execute-scripts"] || values.cases) &&
    !(command === "epub" && subcommand === "check-notes")
  )
    fail(
      "ARGUMENT_CONFLICT",
      "--execute-scripts and --cases are supported by epub check-notes only",
    );
  if (
    values["qa-coverage"] &&
    !["preflight", "preview", "build", "qa"].includes(command ?? "") &&
    !(command === "novel" && subcommand === "fetch")
  )
    fail(
      "ARGUMENT_CONFLICT",
      "--qa-coverage is supported by preflight, preview, build, qa and novel fetch",
    );
  const qaOptions = (coverage: string | undefined) => {
    if (coverage === undefined) return undefined;
    if (coverage === "full" || coverage === "stratified")
      return { coverage } as const;
    fail("QA_OPTIONS", "Choose full or stratified browser coverage");
  };
  let output: unknown;
  let humanOutput: string | undefined;
  if (values.help || (!command && !values.version)) {
    if (jsonMode) output = { version: VERSION, help: HELP };
    else {
      process.stderr.write(HELP);
      process.exit(0);
    }
  } else if (values.version || command === "version")
    output = { version: VERSION };
  else
    switch (command) {
      case "novel": {
        if (positionals.length > 3)
          fail("ARGUMENT_CONFLICT", "novel accepts exactly one book URL");
        if (values.delay !== undefined && !/^\d+$/.test(values.delay))
          fail(
            "NOVEL_OPTIONS",
            "--delay must be an integer number of milliseconds",
          );
        if (
          [
            values.online,
            values.theme,
            values.plan,
            values.from,
            values.config,
            values.summary,
            values.purpose,
            values.reports,
            values.jobs,
          ].some((value) => value !== undefined)
        )
          fail(
            "ARGUMENT_CONFLICT",
            "This option does not apply to novel collection",
          );
        const network = {
          signal: abort.signal,
          delayMs:
            values.delay === undefined ? undefined : Number(values.delay),
          token: process.env.QUILLBIND_LIGHTNOVEL_TOKEN,
        };
        if (subcommand === "inspect") {
          if (
            [
              values.output,
              values.volumes,
              values["split-volumes"],
              values["prepare-only"],
              values.title,
              values.author,
              values.description,
              values.language,
            ].some((value) => value !== undefined)
          )
            fail(
              "ARGUMENT_CONFLICT",
              "novel inspect accepts a book URL and --delay; output/volume/metadata options belong to novel fetch",
            );
          output = await inspectNovel(required(third, "book URL"), network);
        } else if (subcommand === "fetch") {
          output = await fetchNovelBook(required(third, "book URL"), {
            ...network,
            output: values.output,
            volumes: values.volumes,
            splitVolumes: values["split-volumes"],
            prepareOnly: values["prepare-only"],
            title: values.title,
            authors: values.author,
            description: values.description,
            language: values.language,
            qa: qaOptions(values["qa-coverage"]),
            onProgress: jsonMode
              ? undefined
              : (message) => {
                  process.stderr.write(message + "\n");
                },
          });
        } else fail("COMMAND_UNKNOWN", "Use novel inspect or novel fetch");
        break;
      }
      case "init":
        if (values.theme && !["literature", "technical"].includes(values.theme))
          fail("THEME_INVALID", "Choose literature or technical");
        if (values.from || values.config) {
          if (values.theme)
            fail(
              "ARGUMENT_CONFLICT",
              "Set the theme in --config when importing sources",
            );
          output = await prepareBook(
            required(subcommand, "directory"),
            required(values.from, "--from source directory"),
            required(values.config, "--config book.yaml"),
          );
        } else
          output = await initBook(required(subcommand, "directory"), {
            theme: values.theme as "literature" | "technical" | undefined,
          });
        break;
      case "doctor":
        output = await doctor();
        break;
      case "metadata":
        if (subcommand === "bookwalker")
          output = await resolveBookWalker(
            required(third, "sources JSON file"),
            {
              output: required(values.output, "--output lock.json"),
              online: values.online,
              signal: abort.signal,
            },
          );
        else if (subcommand === "resolve")
          output = await resolveMetadata(required(third, "book directory"), {
            online: values.online,
            signal: abort.signal,
          });
        else
          fail(
            "COMMAND_UNKNOWN",
            "Use metadata resolve or metadata bookwalker",
          );
        break;
      case "preflight":
        output = await preflightBook(required(subcommand, "book directory"), {
          qa: qaOptions(values["qa-coverage"]),
        });
        break;
      case "build":
      case "preview":
        output = await (command === "preview" ? previewBook : buildBook)(
          required(subcommand, "book directory"),
          {
            signal: abort.signal,
            online: values.online,
            qa: qaOptions(values["qa-coverage"]),
            ...(values.to
              ? { conversion: { target: conversionTarget(values.to) } }
              : {}),
          },
        );
        break;
      case "validate":
        output = await validateEpub(required(subcommand, "EPUB file"), {
          signal: abort.signal,
        });
        break;
      case "qa":
        output = await runQa(required(subcommand, "EPUB file"), {
          ...qaOptions(values["qa-coverage"]),
          signal: abort.signal,
        });
        break;
      case "inspect":
        {
          const inspection = await inspectEpub(
            required(subcommand, "EPUB file"),
          );
          humanOutput = formatInspection(inspection);
          output = values.summary ? inspectionSummary(inspection) : inspection;
        }
        break;
      case "manga":
        if (subcommand !== "package")
          fail("COMMAND_UNKNOWN", "Use manga package");
        output = await packageManga(
          required(third, "scan directory or archive"),
          {
            output: required(values.output, "--output"),
            bookwalker: required(values.bookwalker, "--bookwalker"),
            order: values["page-order"]
              ? await readJson<string[]>(values["page-order"])
              : undefined,
            direction: values["reading-direction"] as "rtl" | "ltr" | undefined,
            signal: abort.signal,
          },
        );
        break;
      case "epub": {
        const file = required(third, "EPUB file");
        if (subcommand === "repair-directory")
          output = await repairDirectory(file, {
            output: required(values.output, "--output"),
            jobs: values.jobs === undefined ? undefined : Number(values.jobs),
            signal: abort.signal,
          });
        else if (subcommand === "inspect") {
          const inspection = await inspectEpub(file);
          humanOutput = formatInspection(inspection);
          output = values.summary ? inspectionSummary(inspection) : inspection;
        } else if (subcommand === "check-notes")
          output = await checkNotes(file, {
            executeScripts: values["execute-scripts"],
            cases: values.cases ? await readJson(values.cases) : undefined,
            reports: values.reports,
            signal: abort.signal,
          });
        else if (subcommand === "convert")
          output = await convertEpub(file, {
            target: conversionTarget(required(values.to, "--to")),
            output: required(values.output, "--output"),
            signal: abort.signal,
            online: values.online,
          });
        else if (subcommand === "enrich")
          output = await enrichEpub(file, {
            output: required(values.output, "--output"),
            bookwalker: required(values.bookwalker, "--bookwalker"),
            signal: abort.signal,
          });
        else if (subcommand === "audit") output = await auditEpub(file);
        else if (subcommand === "repair-plan") {
          if (
            values.purpose &&
            !["reading", "publication"].includes(values.purpose)
          )
            fail("REPAIR_PURPOSE", "Choose reading or publication");
          output = await createRepairPlan(file, {
            output: values.output,
            purpose: values.purpose as RepairPlan["purpose"] | undefined,
          });
        } else if (subcommand === "repair-copy")
          output = await repairReadingCopy(file, {
            plan: await readJson<RepairPlan>(required(values.plan, "--plan")),
            output: required(values.output, "--output"),
            reports: values.reports,
            signal: abort.signal,
          });
        else if (subcommand === "repair")
          output = await repairEpub(file, {
            plan: await readJson<RepairPlan>(required(values.plan, "--plan")),
            output: required(values.output, "--output"),
            signal: abort.signal,
          });
        else fail("COMMAND_UNKNOWN", "Unknown EPUB operation");
        break;
      }
      case "taxonomy": {
        const data = await taxonomy();
        if (subcommand === "list") output = data;
        else if (subcommand === "explain") {
          output = data.subjects.find((t) => t.id === third);
          if (!output) fail("UNKNOWN_TAG", third ?? "Specify a tag");
        } else fail("COMMAND_UNKNOWN", "Use taxonomy list or explain");
        break;
      }
      case "schema":
        output = schemaJson();
        break;
      case "formats": {
        output = formats;
        break;
      }
      default:
        fail("COMMAND_UNKNOWN", `Unknown command: ${command}`);
    }
  if (jsonMode) process.stdout.write(stable(output));
  else if (humanOutput) process.stderr.write(humanOutput);
  else if (
    output &&
    typeof output === "object" &&
    "reports" in output &&
    "artifact" in output
  ) {
    const release = output as {
      artifact: { path: string; sha256: string };
      reports: { summaryMarkdown: string };
    };
    process.stderr.write(
      `Released: ${release.artifact.path}\nSHA-256: ${release.artifact.sha256}\nSummary: ${release.reports.summaryMarkdown}\n`,
    );
  } else process.stderr.write(formatHuman(command ?? "quillbind", output));
  if (
    output &&
    typeof output === "object" &&
    "status" in output &&
    output.status === "fail"
  )
    process.exitCode = 1;
} catch (error) {
  const e = error as Error & {
    code?: string;
    details?: unknown;
    reports?: unknown;
  };
  const output = {
    status: "fail",
    code: e.code ?? "QUILLBIND_ERROR",
    message: e.message,
    details: e.details,
    reports: e.reports,
  };
  if (jsonMode) process.stdout.write(stable(output));
  else process.stderr.write(formatHuman("quillbind", output));
  process.exitCode = 1;
}
