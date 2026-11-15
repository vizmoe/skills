#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  digest,
  object,
  readInput,
  requireValue,
  strings,
} from "./tag-vocabulary.ts";
import {
  readBibliographyRules,
  readDeliveryRules,
  readNamingRules,
  type ProtectedSidecarRule,
} from "./skill-rules.ts";

interface CodedError extends Error {
  code?: string;
}

interface SidecarState {
  exists: boolean;
  type?: "file" | "symlink" | "other";
  size?: number;
  mtimeMs?: number;
  sha256?: string;
}

interface SidecarSnapshotEntry {
  path: string;
  filename: string;
  inspection: string;
  state: SidecarState;
}

interface AuditIssue {
  code: string;
  [key: string]: unknown;
}

function check(condition: unknown, message: string): asserts condition {
  requireValue(condition, "DELIVERY_INPUT", message);
}

function validIsbn13(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const digits = value.replace(/[-\s]/gu, "");
  if (!/^97[89]\d{10}$/u.test(digits)) return false;
  const sum = [...digits].reduce(
    (acc, ch, index) => acc + Number(ch) * (index % 2 ? 3 : 1),
    0,
  );
  return sum % 10 === 0;
}

async function writeExclusiveJson(
  outputPath: string | undefined,
  value: unknown,
): Promise<void> {
  const payload = JSON.stringify(value, null, 2) + "\n";
  if (!outputPath) {
    process.stdout.write(payload);
    return;
  }
  const resolved = path.resolve(outputPath);
  await fs
    .lstat(resolved)
    .then(() => {
      throw Object.assign(
        new Error(`Refusing to overwrite existing output: ${resolved}`),
        { code: "OUTPUT_EXISTS" },
      );
    })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, payload, { flag: "wx" });
  process.stdout.write(payload);
}

async function inspectSidecar(
  filePath: string,
  mode: string,
): Promise<SidecarState> {
  const stat = await fs.lstat(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return { exists: false };
  // Never open a Calibre SQLite database file; stat-only inspection avoids touching SQLite locks/bytes.
  if (mode === "stat-only" || !stat.isFile()) {
    return {
      exists: true,
      type: stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : "other",
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    };
  }
  const bytes = await fs.readFile(filePath);
  return {
    exists: true,
    type: "file",
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    sha256: digest(bytes),
  };
}

async function collectDirectories(targets: string[]): Promise<string[]> {
  const dirs = new Set<string>();
  for (const target of targets) {
    check(typeof target === "string" && target.trim(), "Invalid target path");
    const resolved = path.resolve(target);
    const stat = await fs.lstat(resolved).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    const baseDir = stat?.isDirectory() ? resolved : path.dirname(resolved);
    const realBase = await fs.realpath(baseDir).catch(() => baseDir);
    const parent = path.dirname(realBase);
    const grandParent = path.dirname(parent);
    dirs.add(realBase);
    dirs.add(parent);
    dirs.add(grandParent);
  }
  return [...dirs].sort();
}

async function snapshotSidecars(
  targets: string[],
  protectedSidecars: ProtectedSidecarRule[],
): Promise<SidecarSnapshotEntry[]> {
  const directories = await collectDirectories(targets);
  const entries: SidecarSnapshotEntry[] = [];
  for (const dir of directories) {
    for (const item of protectedSidecars) {
      const candidate = path.join(dir, item.filename);
      entries.push({
        path: candidate,
        filename: item.filename,
        inspection: item.inspection,
        state: await inspectSidecar(candidate, item.inspection),
      });
    }
  }
  return entries;
}

async function verifyNamingPlan(planPath: string, targetDir?: string) {
  const namingRules = await readNamingRules();
  const planInput = await readInput(planPath);
  const plan = planInput.value;
  check(
    object(plan) &&
      plan.schemaVersion === 1 &&
      plan.operation === "light-novel-naming-plan" &&
      Array.isArray(plan.books),
    "Expected a schemaVersion 1 light-novel-naming-plan JSON file",
  );
  const issues: AuditIssue[] = [];
  const plannedDestinations = new Map<string, string>();
  const sourcePaths = new Set<string>();
  for (const book of plan.books) {
    check(object(book) && typeof book.id === "string", "Invalid book entry");
    if (
      book.kind !== undefined &&
      (typeof book.kind !== "string" || !namingRules.kinds.includes(book.kind))
    ) {
      issues.push({
        code: "UNKNOWN_NAMING_KIND",
        id: book.id,
        detail: `Unsupported book kind: ${String(book.kind)}`,
      });
    }
    if (
      typeof book.basis !== "string" ||
      !namingRules.bases.includes(book.basis)
    ) {
      issues.push({
        code: "UNKNOWN_NAMING_BASIS",
        id: book.id,
        detail: `Unsupported numbering basis: ${String(book.basis)}`,
      });
    }
    if (book.source === null) continue;
    check(
      object(book.source) &&
        typeof book.source.path === "string" &&
        typeof book.source.sha256 === "string",
      `Invalid declared source for ${book.id}`,
    );
    const sourceResolved = path.resolve(book.source.path);
    sourcePaths.add(sourceResolved.normalize("NFC").toLowerCase());
    const stat = await fs.lstat(sourceResolved).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!stat || !stat.isFile()) {
      issues.push({
        code: "SOURCE_MISSING",
        id: book.id,
        path: sourceResolved,
      });
      continue;
    }
    const actualSha = digest(await fs.readFile(sourceResolved));
    if (actualSha !== book.source.sha256) {
      issues.push({
        code: "SOURCE_HASH_MISMATCH",
        id: book.id,
        path: sourceResolved,
        expected: book.source.sha256,
        actual: actualSha,
      });
    }
    const stem = typeof book.filenameStem === "string" ? book.filenameStem : "";
    if (
      !stem ||
      /[/\\:*?"<>|]/u.test(stem) ||
      [...stem].some((ch) => ch.charCodeAt(0) <= 0x1f) ||
      stem.endsWith(".")
    ) {
      issues.push({
        code: "ILLEGAL_FILENAME_STEM",
        id: book.id,
        filenameStem: stem,
      });
      continue;
    }
    const ext = path.extname(sourceResolved);
    const destDir = targetDir
      ? path.resolve(targetDir)
      : path.dirname(sourceResolved);
    const destPath = path.join(destDir, `${stem}${ext}`);
    const destKey = destPath.normalize("NFC").toLowerCase();
    if (plannedDestinations.has(destKey)) {
      issues.push({
        code: "DESTINATION_BATCH_COLLISION",
        id: book.id,
        conflictsWith: plannedDestinations.get(destKey),
        destination: destPath,
      });
    } else {
      plannedDestinations.set(destKey, book.id);
    }
    const destStat = await fs.lstat(destPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (destStat && destKey !== sourceResolved.normalize("NFC").toLowerCase()) {
      issues.push({
        code: "DESTINATION_EXISTS",
        id: book.id,
        destination: destPath,
      });
    }
  }
  return {
    schemaVersion: 1,
    operation: "naming-plan-verification",
    ok: issues.length === 0,
    plan: planInput.source,
    sourceVerification: "verified-on-disk",
    issues,
  };
}

const provenanceNoise =
  /(?:录入本|掃描版|扫描版|自制电子书|自製電子書|未找到\s*ISBN|无\s*ISBN|跳过\s*ISBN|https?:\/\/)/iu;
const japaneseKana = /[\u3040-\u309f\u30a0-\u30ff]{3,}/u;

async function auditDelivery(reportPath: string, beforePath?: string) {
  const [bibRules, deliveryRules, reportInput] = await Promise.all([
    readBibliographyRules(),
    readDeliveryRules(),
    readInput(reportPath),
  ]);
  const report = reportInput.value;
  check(
    object(report) &&
      report.schemaVersion === 1 &&
      typeof report.status === "string" &&
      Array.isArray(report.items),
    "Expected a schemaVersion 1 delivery report with status and items[]",
  );
  const issues: AuditIssue[] = [];
  const statusRule = deliveryRules.statuses[report.status];
  if (!statusRule) {
    issues.push({
      code: "UNKNOWN_DELIVERY_STATUS",
      status: report.status,
    });
  }

  if (beforePath) {
    const beforeInput = await readInput(beforePath);
    const beforeValue = beforeInput.value;
    const beforeEntries = object(beforeValue) ? beforeValue.entries : undefined;
    check(Array.isArray(beforeEntries), "Invalid Calibre snapshot file");
    for (const entry of beforeEntries) {
      check(
        object(entry) &&
          typeof entry.path === "string" &&
          typeof entry.inspection === "string",
        "Invalid Calibre snapshot entry",
      );
      const current = await inspectSidecar(entry.path, entry.inspection);
      if (JSON.stringify(current) !== JSON.stringify(entry.state)) {
        issues.push({
          code: "CALIBRE_SIDECAR_MODIFIED",
          path: entry.path,
          before: entry.state,
          after: current,
        });
      }
    }
  }

  for (const [index, rawItem] of report.items.entries()) {
    const sourceObj =
      object(rawItem) && object(rawItem.source) ? rawItem.source : null;
    const label =
      sourceObj && typeof sourceObj.path === "string"
        ? sourceObj.path
        : `item[${index}]`;
    if (!object(rawItem) || !sourceObj || typeof sourceObj.path !== "string") {
      issues.push({ code: "INVALID_ITEM", item: label });
      continue;
    }
    const item = rawItem;
    const sourcePath = sourceObj.path;
    const format = path.extname(sourcePath).toLowerCase().slice(1);
    const verifyHash = async (
      role: string,
      ref: unknown,
    ): Promise<string | null> => {
      if (!ref) return null;
      if (
        !object(ref) ||
        typeof ref.path !== "string" ||
        typeof ref.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(ref.sha256)
      ) {
        issues.push({ code: "INVALID_FILE_REF", item: label, role });
        return null;
      }
      const bytes = await fs.readFile(path.resolve(ref.path)).catch(() => null);
      if (!bytes) {
        issues.push({
          code: "FILE_MISSING",
          item: label,
          role,
          path: ref.path,
        });
        return null;
      }
      const actual = digest(bytes);
      if (actual !== ref.sha256) {
        issues.push({
          code: "HASH_MISMATCH",
          item: label,
          role,
          path: ref.path,
          expected: ref.sha256,
          actual,
        });
      }
      return actual;
    };

    const finalObj = object(item.final) ? item.final : null;
    const backupObj = object(item.backup) ? item.backup : null;
    const stagedObj = object(item.staged) ? item.staged : null;
    const inPlace =
      finalObj !== null &&
      typeof finalObj.path === "string" &&
      path.resolve(finalObj.path) === path.resolve(sourcePath);

    if (!inPlace) await verifyHash("source", item.source);
    if (item.backup) await verifyHash("backup", item.backup);
    if (item.staged) await verifyHash("staged", item.staged);
    if (item.final) await verifyHash("final", item.final);

    if (statusRule?.filesWritten && !item.final) {
      issues.push({ code: "MISSING_FINAL_FILE", item: label });
    }
    if (
      !statusRule?.filesWritten &&
      Boolean(item.final) &&
      report.status !== "partial"
    ) {
      issues.push({
        code: "UNEXPECTED_FINAL_WRITE",
        item: label,
        status: report.status,
      });
    }
    if (inPlace) {
      if (!backupObj) {
        issues.push({ code: "BACKUP_REQUIRED_FOR_INPLACE", item: label });
      } else if (backupObj.sha256 !== sourceObj.sha256) {
        issues.push({
          code: "BACKUP_SOURCE_HASH_MISMATCH",
          item: label,
          sourceSha256: sourceObj.sha256,
          backupSha256: backupObj.sha256,
        });
      }
    }
    if (stagedObj && finalObj && stagedObj.sha256 !== finalObj.sha256) {
      issues.push({
        code: "FINAL_STAGED_HASH_MISMATCH",
        item: label,
        stagedSha256: stagedObj.sha256,
        finalSha256: finalObj.sha256,
      });
    }

    if (item.isbn !== undefined) {
      const isbnInfo = object(item.isbn) ? item.isbn : null;
      const disp =
        isbnInfo && typeof isbnInfo.disposition === "string"
          ? isbnInfo.disposition
          : undefined;
      const rule = disp ? bibRules.isbnDispositions[disp] : undefined;
      if (!rule) {
        issues.push({
          code: "UNKNOWN_ISBN_DISPOSITION",
          item: label,
          disposition: disp,
        });
      } else {
        if (disp === "skipped-format" && format !== "cbz") {
          issues.push({
            code: "INVALID_SKIPPED_FORMAT_ISBN",
            item: label,
            format,
          });
        }
        if (rule.requiresIsbn && !validIsbn13(isbnInfo?.value)) {
          issues.push({
            code: "INVALID_ADOPTED_ISBN",
            item: label,
            value: isbnInfo?.value ?? null,
          });
        }
        if (
          rule.requiresAttemptedSources &&
          (!strings(isbnInfo?.attemptedSources) ||
            isbnInfo.attemptedSources.length === 0 ||
            typeof isbnInfo.reason !== "string" ||
            !isbnInfo.reason.trim())
        ) {
          issues.push({
            code: "MISSING_ISBN_ATTEMPTED_SOURCES",
            item: label,
          });
        }
      }
    }

    if (item.editionClass !== undefined) {
      const edClass =
        typeof item.editionClass === "string" ? item.editionClass : "";
      const edRule = bibRules.editionClasses[edClass];
      if (!edRule) {
        issues.push({
          code: "UNKNOWN_EDITION_CLASS",
          item: label,
          editionClass: item.editionClass,
        });
      } else if (
        edRule.requiresIdentification &&
        (!strings(item.identificationEvidence) ||
          item.identificationEvidence.length === 0)
      ) {
        issues.push({
          code: "MISSING_IDENTIFICATION_EVIDENCE",
          item: label,
          editionClass: item.editionClass,
        });
      }
    }

    if (object(item.synopsis)) {
      const synopsisValue = item.synopsis.value;
      if (
        typeof synopsisValue === "string" &&
        provenanceNoise.test(synopsisValue)
      ) {
        issues.push({
          code: "SYNOPSIS_CONTAINS_PROVENANCE",
          item: label,
        });
      }
      const bookLang = typeof item.language === "string" ? item.language : "";
      const srcLang =
        typeof item.synopsis.sourceLanguage === "string"
          ? item.synopsis.sourceLanguage
          : "";
      const isLnOrManga =
        item.bookType === "light-novel" || item.bookType === "manga";
      if (isLnOrManga && /^zh(?:-|$)/iu.test(bookLang) && srcLang === "ja") {
        if (
          typeof item.synopsis.translationSource !== "string" ||
          !item.synopsis.translationSource.trim()
        ) {
          issues.push({
            code: "MISSING_TRANSLATION_SOURCE",
            item: label,
          });
        }
        if (
          typeof synopsisValue === "string" &&
          japaneseKana.test(synopsisValue)
        ) {
          issues.push({
            code: "UNTRANSLATED_JAPANESE_SYNOPSIS",
            item: label,
          });
        }
      }
      if (item.bookType === "ordinary" && item.synopsis.translated === true) {
        issues.push({
          code: "ORDINARY_SYNOPSIS_TRANSLATED",
          item: label,
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    operation: "delivery-audit",
    ok: issues.length === 0,
    status: report.status,
    report: reportInput.source,
    issues,
  };
}

async function run(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: "string" },
      plan: { type: "string" },
      before: { type: "string" },
      directory: { type: "string" },
      output: { type: "string" },
      path: { type: "string", multiple: true },
      help: { type: "boolean" },
    },
  });
  if (values.help || !positionals.length) {
    process.stdout.write(
      [
        "delivery-audit.ts snapshot --path FILE_OR_DIR [--path ...] [--output SNAPSHOT.json]",
        "delivery-audit.ts verify-naming --plan NAMING_PLAN.json [--directory TARGET_DIR] [--output AUDIT.json]",
        "delivery-audit.ts audit --input REPORT.json [--before SNAPSHOT.json] [--output AUDIT.json]",
        "Read-only verification helper; never opens a Calibre database or modifies ebooks.",
        "",
      ].join("\n"),
    );
    return;
  }
  if (positionals[0] === "snapshot") {
    const paths = values.path ?? [];
    check(paths.length > 0, "Supply at least one --path to snapshot");
    const { protectedSidecars } = await readDeliveryRules();
    const entries = await snapshotSidecars(paths, protectedSidecars);
    await writeExclusiveJson(values.output, {
      schemaVersion: 1,
      operation: "calibre-sidecar-snapshot",
      entries,
    });
  } else if (positionals[0] === "verify-naming") {
    check(Boolean(values.plan), "Supply --plan NAMING_PLAN.json");
    const result = await verifyNamingPlan(values.plan!, values.directory);
    await writeExclusiveJson(values.output, result);
    if (!result.ok) process.exitCode = 1;
  } else if (positionals[0] === "audit") {
    check(Boolean(values.input), "Supply --input REPORT.json");
    const result = await auditDelivery(values.input!, values.before);
    await writeExclusiveJson(values.output, result);
    if (!result.ok) process.exitCode = 1;
  } else {
    check(false, "Choose snapshot, verify-naming, or audit; see --help");
  }
}

try {
  await run();
} catch (error) {
  const err = error as CodedError;
  process.stderr.write(
    JSON.stringify({
      status: "fail",
      code: err.code ?? "DELIVERY_INPUT",
      message: err.message ?? String(error),
    }) + "\n",
  );
  process.exitCode = 2;
}
