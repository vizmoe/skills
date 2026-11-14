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
} from "./tag-vocabulary.mjs";
import {
  readBibliographyRules,
  readDeliveryRules,
  readNamingRules,
} from "./skill-rules.mjs";

const check = (condition, message) =>
  requireValue(condition, "DELIVERY_INPUT", message);

function validIsbn13(value) {
  if (typeof value !== "string") return false;
  const digits = value.replace(/[-\s]/gu, "");
  if (!/^97[89]\d{10}$/u.test(digits)) return false;
  const sum = [...digits].reduce(
    (acc, ch, index) => acc + Number(ch) * (index % 2 ? 3 : 1),
    0,
  );
  return sum % 10 === 0;
}

async function writeExclusiveJson(outputPath, value) {
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
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, payload, { flag: "wx" });
  process.stdout.write(payload);
}

async function inspectSidecar(filePath, mode) {
  const stat = await fs.lstat(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
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

async function collectDirectories(targets) {
  const dirs = new Set();
  for (const target of targets) {
    check(typeof target === "string" && target.trim(), "Invalid target path");
    const resolved = path.resolve(target);
    const stat = await fs.lstat(resolved).catch((error) => {
      if (error.code === "ENOENT") return null;
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

async function snapshotSidecars(targets, protectedSidecars) {
  const directories = await collectDirectories(targets);
  const entries = [];
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

async function verifyNamingPlan(planPath, targetDir) {
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
  const issues = [];
  const plannedDestinations = new Map();
  const sourcePaths = new Set();
  for (const book of plan.books) {
    check(object(book) && typeof book.id === "string", "Invalid book entry");
    if (book.kind !== undefined && !namingRules.kinds.includes(book.kind)) {
      issues.push({
        code: "UNKNOWN_NAMING_KIND",
        id: book.id,
        detail: `Unsupported book kind: ${book.kind}`,
      });
    }
    if (!namingRules.bases.includes(book.basis)) {
      issues.push({
        code: "UNKNOWN_NAMING_BASIS",
        id: book.id,
        detail: `Unsupported numbering basis: ${book.basis}`,
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
    const stat = await fs.lstat(sourceResolved).catch((error) => {
      if (error.code === "ENOENT") return null;
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
    const stem = String(book.filenameStem ?? "");
    if (!stem || /[\/\\:*?"<>|\u0000-\u001f]/u.test(stem) || stem.endsWith(".")) {
      issues.push({
        code: "ILLEGAL_FILENAME_STEM",
        id: book.id,
        filenameStem: stem,
      });
      continue;
    }
    const ext = path.extname(sourceResolved);
    const destDir = targetDir ? path.resolve(targetDir) : path.dirname(sourceResolved);
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
    const destStat = await fs.lstat(destPath).catch((error) => {
      if (error.code === "ENOENT") return null;
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

async function auditDelivery(reportPath, beforePath) {
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
  const issues = [];
  const statusRule = deliveryRules.statuses[report.status];
  if (!statusRule) {
    issues.push({
      code: "UNKNOWN_DELIVERY_STATUS",
      status: report.status,
    });
  }

  if (beforePath) {
    const beforeInput = await readInput(beforePath);
    const beforeEntries = beforeInput.value?.entries;
    check(Array.isArray(beforeEntries), "Invalid Calibre snapshot file");
    for (const entry of beforeEntries) {
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

  for (const [index, item] of report.items.entries()) {
    const label = item?.source?.path ?? `item[${index}]`;
    if (!object(item) || !object(item.source) || typeof item.source.path !== "string") {
      issues.push({ code: "INVALID_ITEM", item: label });
      continue;
    }
    const format = path.extname(item.source.path).toLowerCase().slice(1);
    const verifyHash = async (role, ref) => {
      if (!ref) return null;
      if (!object(ref) || typeof ref.path !== "string" || !/^[a-f0-9]{64}$/u.test(ref.sha256 ?? "")) {
        issues.push({ code: "INVALID_FILE_REF", item: label, role });
        return null;
      }
      const bytes = await fs.readFile(path.resolve(ref.path)).catch(() => null);
      if (!bytes) {
        issues.push({ code: "FILE_MISSING", item: label, role, path: ref.path });
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

    const inPlace =
      object(item.final) &&
      typeof item.final.path === "string" &&
      path.resolve(item.final.path) === path.resolve(item.source.path);

    if (!inPlace) await verifyHash("source", item.source);
    if (item.backup) await verifyHash("backup", item.backup);
    if (item.staged) await verifyHash("staged", item.staged);
    if (item.final) await verifyHash("final", item.final);

    if (statusRule?.filesWritten && !item.final) {
      issues.push({ code: "MISSING_FINAL_FILE", item: label });
    }
    if (!statusRule?.filesWritten && item.final && report.status !== "partial") {
      issues.push({
        code: "UNEXPECTED_FINAL_WRITE",
        item: label,
        status: report.status,
      });
    }
    if (inPlace) {
      if (!item.backup) {
        issues.push({ code: "BACKUP_REQUIRED_FOR_INPLACE", item: label });
      } else if (item.backup.sha256 !== item.source.sha256) {
        issues.push({
          code: "BACKUP_SOURCE_HASH_MISMATCH",
          item: label,
          sourceSha256: item.source.sha256,
          backupSha256: item.backup.sha256,
        });
      }
    }
    if (item.staged && item.final && item.staged.sha256 !== item.final.sha256) {
      issues.push({
        code: "FINAL_STAGED_HASH_MISMATCH",
        item: label,
        stagedSha256: item.staged.sha256,
        finalSha256: item.final.sha256,
      });
    }

    if (item.isbn !== undefined) {
      const isbnInfo = item.isbn;
      const disp = isbnInfo?.disposition;
      const rule = bibRules.isbnDispositions[disp];
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
        if (rule.requiresIsbn && !validIsbn13(isbnInfo.value)) {
          issues.push({
            code: "INVALID_ADOPTED_ISBN",
            item: label,
            value: isbnInfo.value ?? null,
          });
        }
        if (
          rule.requiresAttemptedSources &&
          (!strings(isbnInfo.attemptedSources) ||
            !isbnInfo.attemptedSources.length ||
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
      const edRule = bibRules.editionClasses[item.editionClass];
      if (!edRule) {
        issues.push({
          code: "UNKNOWN_EDITION_CLASS",
          item: label,
          editionClass: item.editionClass,
        });
      } else if (
        edRule.requiresIdentification &&
        (!strings(item.identificationEvidence) ||
          !item.identificationEvidence.length)
      ) {
        issues.push({
          code: "MISSING_IDENTIFICATION_EVIDENCE",
          item: label,
          editionClass: item.editionClass,
        });
      }
    }

    if (object(item.synopsis)) {
      const text = item.synopsis.value;
      if (typeof text === "string" && provenanceNoise.test(text)) {
        issues.push({
          code: "SYNOPSIS_CONTAINS_PROVENANCE",
          item: label,
        });
      }
      const bookLang = String(item.language ?? "");
      const srcLang = String(item.synopsis.sourceLanguage ?? "");
      const isLnOrManga = ["light-novel", "manga"].includes(item.bookType);
      if (
        isLnOrManga &&
        /^zh(?:-|$)/iu.test(bookLang) &&
        srcLang === "ja"
      ) {
        if (
          typeof item.synopsis.translationSource !== "string" ||
          !item.synopsis.translationSource.trim()
        ) {
          issues.push({
            code: "MISSING_TRANSLATION_SOURCE",
            item: label,
          });
        }
        if (typeof text === "string" && japaneseKana.test(text)) {
          issues.push({
            code: "UNTRANSLATED_JAPANESE_SYNOPSIS",
            item: label,
          });
        }
      }
      if (
        item.bookType === "ordinary" &&
        item.synopsis.translated === true
      ) {
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

try {
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
        "delivery-audit.mjs snapshot --path FILE_OR_DIR [--path ...] [--output SNAPSHOT.json]",
        "delivery-audit.mjs verify-naming --plan NAMING_PLAN.json [--directory TARGET_DIR] [--output AUDIT.json]",
        "delivery-audit.mjs audit --input REPORT.json [--before SNAPSHOT.json] [--output AUDIT.json]",
        "Read-only verification helper; never opens a Calibre database or modifies ebooks.",
        "",
      ].join("\n"),
    );
  } else if (positionals[0] === "snapshot") {
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
    const result = await verifyNamingPlan(values.plan, values.directory);
    await writeExclusiveJson(values.output, result);
    if (!result.ok) process.exitCode = 1;
  } else if (positionals[0] === "audit") {
    check(Boolean(values.input), "Supply --input REPORT.json");
    const result = await auditDelivery(values.input, values.before);
    await writeExclusiveJson(values.output, result);
    if (!result.ok) process.exitCode = 1;
  } else {
    check(false, "Choose snapshot, verify-naming, or audit; see --help");
  }
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      status: "fail",
      code: error.code ?? "DELIVERY_INPUT",
      message: error.message,
    }) + "\n",
  );
  process.exitCode = 2;
}
