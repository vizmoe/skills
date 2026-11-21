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
  readPdfRules,
  type BibliographyRules,
  type DeliveryStatusRule,
  type NamingRules,
  type PdfRules,
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

async function lstatIfExists(filePath: string) {
  return fs.lstat(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}

function sidecarType(
  stat: NonNullable<Awaited<ReturnType<typeof lstatIfExists>>>,
): "file" | "symlink" | "other" {
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return JSON.stringify(value) ?? typeof value;
}

function hasControlChar(value: string): boolean {
  return [...value].some((ch) => {
    const code = ch.codePointAt(0);
    return code !== undefined && code <= 0x1f;
  });
}

function isIllegalFilenameStem(stem: string): boolean {
  return (
    !stem ||
    /[/\\:*?"<>|]/u.test(stem) ||
    hasControlChar(stem) ||
    stem.endsWith(".")
  );
}

async function inspectSidecar(
  filePath: string,
  mode: string,
): Promise<SidecarState> {
  const stat = await lstatIfExists(filePath);
  if (!stat) return { exists: false };
  // Never open a Calibre SQLite database file; stat-only inspection avoids touching SQLite locks/bytes.
  if (mode === "stat-only" || !stat.isFile()) {
    return {
      exists: true,
      type: sidecarType(stat),
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

async function resolveTargetAncestors(target: string): Promise<string[]> {
  const resolved = path.resolve(target);
  const stat = await lstatIfExists(resolved);
  const baseDir = stat?.isDirectory() ? resolved : path.dirname(resolved);
  const realBase = await fs.realpath(baseDir).catch(() => baseDir);
  const parent = path.dirname(realBase);
  const grandParent = path.dirname(parent);
  return [realBase, parent, grandParent];
}

async function collectDirectories(targets: string[]): Promise<string[]> {
  for (const target of targets) {
    check(typeof target === "string" && target.trim(), "Invalid target path");
  }
  const groups = await Promise.all(targets.map(resolveTargetAncestors));
  const dirs = new Set(groups.flat());
  return [...dirs].sort((a, b) => a.localeCompare(b, "en"));
}

async function snapshotSidecars(
  targets: string[],
  protectedSidecars: ProtectedSidecarRule[],
): Promise<SidecarSnapshotEntry[]> {
  const directories = await collectDirectories(targets);
  const tasks = directories.flatMap((dir) =>
    protectedSidecars.map((item) => ({
      candidate: path.join(dir, item.filename),
      item,
    })),
  );
  return Promise.all(
    tasks.map(async ({ candidate, item }) => ({
      path: candidate,
      filename: item.filename,
      inspection: item.inspection,
      state: await inspectSidecar(candidate, item.inspection),
    })),
  );
}

interface ParsedNamingBook {
  id: string;
  kind: unknown;
  basis: unknown;
  source: { path: string; sha256: string } | null;
  filenameStem: string;
}

interface NamingBookDestinationCheck {
  destPath: string;
  destKey: string;
  destExists: boolean;
}

interface NamingBookDiskCheck {
  book: ParsedNamingBook;
  issues: AuditIssue[];
  destination: NamingBookDestinationCheck | null;
}

function parseNamingPlanBook(rawBook: unknown): ParsedNamingBook {
  check(
    object(rawBook) && typeof rawBook.id === "string",
    "Invalid book entry",
  );
  if (rawBook.source === null) {
    return {
      id: rawBook.id,
      kind: rawBook.kind,
      basis: rawBook.basis,
      source: null,
      filenameStem: "",
    };
  }
  check(
    object(rawBook.source) &&
      typeof rawBook.source.path === "string" &&
      typeof rawBook.source.sha256 === "string",
    `Invalid declared source for ${rawBook.id}`,
  );
  return {
    id: rawBook.id,
    kind: rawBook.kind,
    basis: rawBook.basis,
    source: { path: rawBook.source.path, sha256: rawBook.source.sha256 },
    filenameStem:
      typeof rawBook.filenameStem === "string" ? rawBook.filenameStem : "",
  };
}

function validateNamingBookRules(
  book: ParsedNamingBook,
  namingRules: NamingRules,
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  if (
    book.kind !== undefined &&
    (typeof book.kind !== "string" || !namingRules.kinds.includes(book.kind))
  ) {
    issues.push({
      code: "UNKNOWN_NAMING_KIND",
      id: book.id,
      detail: `Unsupported book kind: ${formatUnknownValue(book.kind)}`,
    });
  }
  if (
    typeof book.basis !== "string" ||
    !namingRules.bases.includes(book.basis)
  ) {
    issues.push({
      code: "UNKNOWN_NAMING_BASIS",
      id: book.id,
      detail: `Unsupported numbering basis: ${formatUnknownValue(book.basis)}`,
    });
  }
  return issues;
}

async function inspectNamingBookDisk(
  book: ParsedNamingBook,
  targetDir?: string,
): Promise<NamingBookDiskCheck> {
  if (book.source === null) {
    return { book, issues: [], destination: null };
  }
  const sourceResolved = path.resolve(book.source.path);
  const stat = await lstatIfExists(sourceResolved);
  if (!stat?.isFile()) {
    return {
      book,
      issues: [{ code: "SOURCE_MISSING", id: book.id, path: sourceResolved }],
      destination: null,
    };
  }
  const issues: AuditIssue[] = [];
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
  if (isIllegalFilenameStem(book.filenameStem)) {
    issues.push({
      code: "ILLEGAL_FILENAME_STEM",
      id: book.id,
      filenameStem: book.filenameStem,
    });
    return { book, issues, destination: null };
  }
  const ext = path.extname(sourceResolved);
  const destDir = targetDir
    ? path.resolve(targetDir)
    : path.dirname(sourceResolved);
  const destPath = path.join(destDir, `${book.filenameStem}${ext}`);
  const destKey = destPath.normalize("NFC").toLowerCase();
  const destStat = await lstatIfExists(destPath);
  const destExists =
    Boolean(destStat) &&
    destKey !== sourceResolved.normalize("NFC").toLowerCase();
  return {
    book,
    issues,
    destination: { destPath, destKey, destExists },
  };
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
  const books = plan.books.map(parseNamingPlanBook);
  const diskResults = await Promise.all(
    books.map((book) => inspectNamingBookDisk(book, targetDir)),
  );
  const issues: AuditIssue[] = [];
  const plannedDestinations = new Map<string, string>();
  for (const result of diskResults) {
    issues.push(
      ...validateNamingBookRules(result.book, namingRules),
      ...result.issues,
    );
    if (!result.destination) continue;
    const { destPath, destKey, destExists } = result.destination;
    if (plannedDestinations.has(destKey)) {
      issues.push({
        code: "DESTINATION_BATCH_COLLISION",
        id: result.book.id,
        conflictsWith: plannedDestinations.get(destKey),
        destination: destPath,
      });
    } else {
      plannedDestinations.set(destKey, result.book.id);
    }
    if (destExists) {
      issues.push({
        code: "DESTINATION_EXISTS",
        id: result.book.id,
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

interface ParsedSidecarEntry {
  path: string;
  inspection: string;
  state: unknown;
}

function parseSnapshotEntry(entry: unknown): ParsedSidecarEntry {
  check(
    object(entry) &&
      typeof entry.path === "string" &&
      typeof entry.inspection === "string",
    "Invalid Calibre snapshot entry",
  );
  return {
    path: entry.path,
    inspection: entry.inspection,
    state: entry.state,
  };
}

async function auditCalibreSidecars(beforePath: string): Promise<AuditIssue[]> {
  const beforeInput = await readInput(beforePath);
  const beforeValue = beforeInput.value;
  const beforeEntries = object(beforeValue) ? beforeValue.entries : undefined;
  check(Array.isArray(beforeEntries), "Invalid Calibre snapshot file");
  const parsedEntries = beforeEntries.map(parseSnapshotEntry);
  const currentStates = await Promise.all(
    parsedEntries.map((entry) => inspectSidecar(entry.path, entry.inspection)),
  );
  const issues: AuditIssue[] = [];
  for (const [index, entry] of parsedEntries.entries()) {
    const current = currentStates[index];
    if (JSON.stringify(current) !== JSON.stringify(entry.state)) {
      issues.push({
        code: "CALIBRE_SIDECAR_MODIFIED",
        path: entry.path,
        before: entry.state,
        after: current,
      });
    }
  }
  return issues;
}

async function verifyFileRefHash(
  label: string,
  role: string,
  ref: unknown,
): Promise<AuditIssue | null> {
  if (!ref) return null;
  if (
    !object(ref) ||
    typeof ref.path !== "string" ||
    typeof ref.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(ref.sha256)
  ) {
    return { code: "INVALID_FILE_REF", item: label, role };
  }
  const bytes = await fs.readFile(path.resolve(ref.path)).catch(() => null);
  if (!bytes) {
    return {
      code: "FILE_MISSING",
      item: label,
      role,
      path: ref.path,
    };
  }
  const actual = digest(bytes);
  if (actual !== ref.sha256) {
    return {
      code: "HASH_MISMATCH",
      item: label,
      role,
      path: ref.path,
      expected: ref.sha256,
      actual,
    };
  }
  return null;
}

interface ItemWriteInvariantCheck {
  item: Record<string, unknown>;
  sourceObj: Record<string, unknown>;
  finalObj: Record<string, unknown> | null;
  backupObj: Record<string, unknown> | null;
  stagedObj: Record<string, unknown> | null;
  inPlace: boolean;
  label: string;
  reportStatus: string;
  statusRule: DeliveryStatusRule | undefined;
}

function auditItemWriteInvariants(
  context: ItemWriteInvariantCheck,
): AuditIssue[] {
  const {
    item,
    sourceObj,
    finalObj,
    backupObj,
    stagedObj,
    inPlace,
    label,
    reportStatus,
    statusRule,
  } = context;
  const issues: AuditIssue[] = [];
  if (statusRule?.filesWritten && !item.final) {
    issues.push({ code: "MISSING_FINAL_FILE", item: label });
  }
  if (
    !statusRule?.filesWritten &&
    Boolean(item.final) &&
    reportStatus !== "partial"
  ) {
    issues.push({
      code: "UNEXPECTED_FINAL_WRITE",
      item: label,
      status: reportStatus,
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
  return issues;
}

async function auditItemFileChain(
  item: Record<string, unknown>,
  sourceObj: Record<string, unknown>,
  sourcePath: string,
  label: string,
  reportStatus: string,
  statusRule: DeliveryStatusRule | undefined,
): Promise<AuditIssue[]> {
  const finalObj = object(item.final) ? item.final : null;
  const backupObj = object(item.backup) ? item.backup : null;
  const stagedObj = object(item.staged) ? item.staged : null;
  const inPlace =
    finalObj !== null &&
    typeof finalObj.path === "string" &&
    path.resolve(finalObj.path) === path.resolve(sourcePath);

  const hashChecks: Array<[string, unknown]> = [];
  if (!inPlace) hashChecks.push(["source", item.source]);
  if (item.backup) hashChecks.push(["backup", item.backup]);
  if (item.staged) hashChecks.push(["staged", item.staged]);
  if (item.final) hashChecks.push(["final", item.final]);

  const hashResults = await Promise.all(
    hashChecks.map(([role, ref]) => verifyFileRefHash(label, role, ref)),
  );
  const issues = hashResults.filter(
    (issue): issue is AuditIssue => issue !== null,
  );
  issues.push(
    ...auditItemWriteInvariants({
      item,
      sourceObj,
      finalObj,
      backupObj,
      stagedObj,
      inPlace,
      label,
      reportStatus,
      statusRule,
    }),
  );
  return issues;
}

function hasValidAttemptedSources(isbn: Record<string, unknown>): boolean {
  return (
    strings(isbn.attemptedSources) &&
    isbn.attemptedSources.length > 0 &&
    typeof isbn.reason === "string" &&
    Boolean(isbn.reason.trim())
  );
}

function auditItemIsbn(
  isbn: unknown,
  format: string,
  label: string,
  bibRules: BibliographyRules,
): AuditIssue[] {
  if (isbn === undefined) return [];
  if (!object(isbn) || typeof isbn.disposition !== "string") {
    return [
      {
        code: "UNKNOWN_ISBN_DISPOSITION",
        item: label,
        disposition: undefined,
      },
    ];
  }
  const disp = isbn.disposition;
  const rule = Object.hasOwn(bibRules.isbnDispositions, disp)
    ? bibRules.isbnDispositions[disp]
    : undefined;
  if (!rule) {
    return [
      {
        code: "UNKNOWN_ISBN_DISPOSITION",
        item: label,
        disposition: disp,
      },
    ];
  }
  const issues: AuditIssue[] = [];
  if (disp === "skipped-format" && format !== "cbz") {
    issues.push({
      code: "INVALID_SKIPPED_FORMAT_ISBN",
      item: label,
      format,
    });
  }
  if (rule.requiresIsbn && !validIsbn13(isbn.value)) {
    issues.push({
      code: "INVALID_ADOPTED_ISBN",
      item: label,
      value: isbn.value ?? null,
    });
  }
  if (rule.requiresAttemptedSources && !hasValidAttemptedSources(isbn)) {
    issues.push({
      code: "MISSING_ISBN_ATTEMPTED_SOURCES",
      item: label,
    });
  }
  return issues;
}

function auditItemEditionClass(
  item: Record<string, unknown>,
  label: string,
  bibRules: BibliographyRules,
): AuditIssue[] {
  if (item.editionClass === undefined) return [];
  const edClass =
    typeof item.editionClass === "string" ? item.editionClass : "";
  const edRule = Object.hasOwn(bibRules.editionClasses, edClass)
    ? bibRules.editionClasses[edClass]
    : undefined;
  if (!edRule) {
    return [
      {
        code: "UNKNOWN_EDITION_CLASS",
        item: label,
        editionClass: item.editionClass,
      },
    ];
  }
  if (
    edRule.requiresIdentification &&
    (!strings(item.identificationEvidence) ||
      item.identificationEvidence.length === 0)
  ) {
    return [
      {
        code: "MISSING_IDENTIFICATION_EVIDENCE",
        item: label,
        editionClass: item.editionClass,
      },
    ];
  }
  return [];
}

function auditTranslatedJapaneseSynopsis(
  synopsis: Record<string, unknown>,
  label: string,
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  if (
    typeof synopsis.translationSource !== "string" ||
    !synopsis.translationSource.trim()
  ) {
    issues.push({
      code: "MISSING_TRANSLATION_SOURCE",
      item: label,
    });
  }
  if (typeof synopsis.value === "string" && japaneseKana.test(synopsis.value)) {
    issues.push({
      code: "UNTRANSLATED_JAPANESE_SYNOPSIS",
      item: label,
    });
  }
  return issues;
}

function auditItemSynopsis(
  item: Record<string, unknown>,
  label: string,
): AuditIssue[] {
  if (!object(item.synopsis)) return [];
  const issues: AuditIssue[] = [];
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
    issues.push(...auditTranslatedJapaneseSynopsis(item.synopsis, label));
  }
  if (item.bookType === "ordinary" && item.synopsis.translated === true) {
    issues.push({
      code: "ORDINARY_SYNOPSIS_TRANSLATED",
      item: label,
    });
  }
  return issues;
}

async function readEvidenceJson(
  filePath: string,
): Promise<
  { ok: true; value: Record<string, unknown>; sha256: string } | { ok: false }
> {
  const bytes = await fs.readFile(path.resolve(filePath)).catch(() => null);
  if (!bytes) return { ok: false };
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(parsed)) return { ok: false };
    return { ok: true, value: parsed, sha256: digest(bytes) };
  } catch {
    return { ok: false };
  }
}

async function verifyDiskFileSha256(
  filePath: unknown,
  expectedSha: unknown,
): Promise<"ok" | "missing" | "mismatch"> {
  if (
    typeof filePath !== "string" ||
    typeof expectedSha !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expectedSha)
  ) {
    return "mismatch";
  }
  const bytes = await fs.readFile(path.resolve(filePath)).catch(() => null);
  if (!bytes) return "missing";
  return digest(bytes) === expectedSha ? "ok" : "mismatch";
}

function auditFrontmatterSpineOrder(
  frontmatterSpine: unknown,
  pdfRules: PdfRules,
  label: string,
): AuditIssue[] {
  if (!Array.isArray(frontmatterSpine)) {
    return [{ code: "PDF_FRONTMATTER_INVALID", item: label }];
  }
  const orderByPath = new Map(
    pdfRules.frontmatter.map((entry) => [entry.path, entry.order]),
  );
  let lastOrder = 0;
  for (const item of frontmatterSpine) {
    if (typeof item !== "string" || !orderByPath.has(item)) {
      return [
        {
          code: "PDF_FRONTMATTER_ORDER_INVALID",
          item: label,
          path: formatUnknownValue(item),
        },
      ];
    }
    const order = orderByPath.get(item)!;
    if (order <= lastOrder) {
      return [
        {
          code: "PDF_FRONTMATTER_ORDER_INVALID",
          item: label,
          frontmatterSpine,
        },
      ];
    }
    lastOrder = order;
  }
  return [];
}

async function auditPdfVerificationEvidence(
  verPath: unknown,
  label: string,
  expectedSourceSha: string | undefined,
  requiredPages: number[],
  expectedFileSha: string | undefined,
): Promise<AuditIssue[]> {
  if (typeof verPath !== "string" || !verPath.trim()) {
    return requiredPages.length > 0
      ? [
          {
            code: "PDF_VERIFICATION_REPORT_MISSING",
            item: label,
            requiredPages,
          },
        ]
      : [];
  }
  const loaded = await readEvidenceJson(verPath);
  if (!loaded.ok) {
    return [
      {
        code: "PDF_EVIDENCE_INVALID",
        item: label,
        role: "verificationReport",
        path: verPath,
      },
    ];
  }
  const issues: AuditIssue[] = [];
  if (expectedFileSha && loaded.sha256 !== expectedFileSha) {
    issues.push({
      code: "PDF_VERIFICATION_HASH_MISMATCH",
      item: label,
      path: verPath,
      expected: expectedFileSha,
      actual: loaded.sha256,
    });
  }
  const v = loaded.value;
  if (
    v.kind !== "quillbind-pdf-verification" ||
    typeof v.verifierId !== "string" ||
    !v.verifierId.trim() ||
    !Array.isArray(v.pages)
  ) {
    return [
      ...issues,
      {
        code: "PDF_EVIDENCE_INVALID",
        item: label,
        role: "verificationReport",
        path: verPath,
      },
    ];
  }
  if (expectedSourceSha && v.sourceSha256 !== expectedSourceSha) {
    issues.push({
      code: "PDF_VERIFICATION_SOURCE_MISMATCH",
      item: label,
      expected: expectedSourceSha,
      actual: v.sourceSha256,
    });
  }
  const verifiedPages = new Set<number>();
  for (const rawPage of v.pages) {
    if (!object(rawPage) || typeof rawPage.page !== "number") {
      issues.push({
        code: "PDF_EVIDENCE_INVALID",
        item: label,
        role: "verificationReport.pages",
      });
      continue;
    }
    const pageNum = rawPage.page;
    const tBy =
      typeof rawPage.transcribedBy === "string"
        ? rawPage.transcribedBy.trim()
        : "";
    const vBy =
      typeof rawPage.verifiedBy === "string" ? rawPage.verifiedBy.trim() : "";
    if (!tBy || !vBy || tBy === vBy) {
      issues.push({
        code: "PDF_SELF_APPROVAL_FORBIDDEN",
        item: label,
        page: pageNum,
      });
    }
    if (
      typeof rawPage.renderSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(rawPage.renderSha256) ||
      typeof rawPage.contentSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(rawPage.contentSha256)
    ) {
      issues.push({
        code: "PDF_VERIFICATION_HASH_INVALID",
        item: label,
        page: pageNum,
      });
    }
    if (Array.isArray(rawPage.unresolved) && rawPage.unresolved.length > 0) {
      issues.push({
        code: "PDF_UNRESOLVED_ITEMS",
        item: label,
        page: pageNum,
        count: rawPage.unresolved.length,
      });
    }
    if (rawPage.status === "verified") {
      verifiedPages.add(pageNum);
    } else {
      issues.push({
        code: "PDF_PAGE_NOT_VERIFIED",
        item: label,
        page: pageNum,
        status: rawPage.status,
      });
    }
  }
  const missing = requiredPages.filter((p) => !verifiedPages.has(p));
  if (missing.length > 0) {
    issues.push({
      code: "PDF_VERIFICATION_INCOMPLETE",
      item: label,
      missingPages: missing,
    });
  }
  return issues;
}

async function auditPdfEnhanceEvidence(
  enhancePaths: unknown,
  label: string,
  pdfRules: PdfRules,
): Promise<AuditIssue[]> {
  if (enhancePaths === undefined) return [];
  if (!strings(enhancePaths)) {
    return [
      { code: "PDF_EVIDENCE_INVALID", item: label, role: "enhanceReports" },
    ];
  }
  const issues: AuditIssue[] = [];
  for (const repPath of enhancePaths) {
    const loaded = await readEvidenceJson(repPath);
    if (!loaded.ok) {
      issues.push({
        code: "PDF_EVIDENCE_INVALID",
        item: label,
        role: "enhanceReports",
        path: repPath,
      });
      continue;
    }
    const rep = loaded.value;
    if (
      rep.mode !== "non-destructive-restoration" ||
      rep.generativeRedraw !== false
    ) {
      issues.push({
        code: "GENERATIVE_REDRAW_FORBIDDEN",
        item: label,
        path: repPath,
      });
    }
    if (!Array.isArray(rep.operations)) {
      issues.push({
        code: "PDF_EVIDENCE_INVALID",
        item: label,
        role: "enhanceReports.operations",
        path: repPath,
      });
    } else {
      for (const rawOp of rep.operations) {
        if (typeof rawOp !== "string") {
          issues.push({
            code: "FORBIDDEN_IMAGE_OPERATION",
            item: label,
            operation: rawOp,
            path: repPath,
          });
          continue;
        }
        const opKey = rawOp.split(":")[0];
        if (!pdfRules.imageOperations[opKey]?.allowed) {
          issues.push({
            code: "FORBIDDEN_IMAGE_OPERATION",
            item: label,
            operation: rawOp,
            ruleKey: opKey,
            path: repPath,
          });
        }
      }
    }
    const outObj = object(rep.output) ? rep.output : null;
    const outCheck = await verifyDiskFileSha256(outObj?.path, outObj?.sha256);
    if (outCheck !== "ok") {
      issues.push({
        code: "ENHANCE_OUTPUT_HASH_MISMATCH",
        item: label,
        path: outObj?.path ?? repPath,
        reason: outCheck,
      });
    }
    const cmpCheck = await verifyDiskFileSha256(
      rep.comparisonImage,
      rep.comparisonImageSha256,
    );
    if (cmpCheck !== "ok") {
      issues.push({
        code:
          cmpCheck === "missing"
            ? "ENHANCE_COMPARISON_MISSING"
            : "ENHANCE_COMPARISON_HASH_MISMATCH",
        item: label,
        path: rep.comparisonImage ?? repPath,
      });
    }
  }
  return issues;
}

async function auditItemPdfEvidence(
  item: Record<string, unknown>,
  sourceObj: Record<string, unknown>,
  label: string,
  pdfRules: PdfRules,
): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const expectedSourceSha =
    typeof sourceObj.sha256 === "string" ? sourceObj.sha256 : undefined;
  const finalObj = object(item.final) ? item.final : null;
  const expectedFinalSha =
    typeof finalObj?.sha256 === "string" ? finalObj.sha256 : undefined;

  // Reject unbacked self-reported PDF claims lacking on-disk tool reports.
  if (
    item.pdfConversion !== undefined &&
    typeof item.pdfImportReport !== "string"
  ) {
    issues.push({
      code: "PDF_EVIDENCE_REPORT_MISSING",
      item: label,
      role: "pdfImportReport",
    });
  }
  if (
    item.pdfRepair !== undefined &&
    typeof item.pdfRepairReport !== "string"
  ) {
    issues.push({
      code: "PDF_EVIDENCE_REPORT_MISSING",
      item: label,
      role: "pdfRepairReport",
    });
  }

  let requiredVerificationPages: number[] = [];
  let expectedVerificationFileSha: string | undefined;

  if (typeof item.pdfImportReport === "string") {
    const loaded = await readEvidenceJson(item.pdfImportReport);
    if (!loaded.ok) {
      issues.push({
        code: "PDF_EVIDENCE_INVALID",
        item: label,
        role: "pdfImportReport",
        path: item.pdfImportReport,
      });
    } else {
      const rep = loaded.value;
      if (rep.operation !== "pdf-to-epub" || rep.status !== "pass") {
        issues.push({
          code: "PDF_EVIDENCE_INVALID",
          item: label,
          role: "pdfImportReport",
          path: item.pdfImportReport,
        });
      }
      if (expectedSourceSha && rep.sourceSha256 !== expectedSourceSha) {
        issues.push({
          code: "PDF_REPORT_SOURCE_MISMATCH",
          item: label,
          role: "pdfImportReport",
        });
      }
      if (expectedFinalSha && rep.outputSha256 !== expectedFinalSha) {
        issues.push({
          code: "PDF_REPORT_OUTPUT_MISMATCH",
          item: label,
          role: "pdfImportReport",
        });
      }
      const outDisk = await verifyDiskFileSha256(rep.output, rep.outputSha256);
      if (outDisk !== "ok") {
        issues.push({
          code: "PDF_REPORT_OUTPUT_MISMATCH",
          item: label,
          role: "pdfImportReport",
          reason: outDisk,
        });
      }
      const valObj = object(rep.validation) ? rep.validation : null;
      if (valObj?.status !== "pass") {
        issues.push({ code: "PDF_EPUB_VALIDATION_FAILED", item: label });
      }
      issues.push(
        ...auditFrontmatterSpineOrder(rep.frontmatterSpine, pdfRules, label),
      );
      const tocHrefs = Array.isArray(rep.tocHrefs) ? rep.tocHrefs : [];
      if (
        rep.colophonExcludedFromToc !== true ||
        tocHrefs.some(
          (href) => typeof href === "string" && href.includes("colophon.xhtml"),
        )
      ) {
        issues.push({ code: "COLOPHON_IN_TOC", item: label });
      }
      if (Array.isArray(rep.figureProvenance)) {
        for (const prov of rep.figureProvenance) {
          if (object(prov) && prov.generativeRedraw !== false) {
            issues.push({ code: "GENERATIVE_REDRAW_FORBIDDEN", item: label });
          }
        }
      }
      const verObj = object(rep.verification) ? rep.verification : null;
      if (verObj && Array.isArray(verObj.pagesRequiringVerification)) {
        requiredVerificationPages = [
          ...new Set([
            ...requiredVerificationPages,
            ...verObj.pagesRequiringVerification.filter(
              (p): p is number => typeof p === "number",
            ),
          ]),
        ];
      }
      if (verObj && typeof verObj.verificationFileSha256 === "string") {
        expectedVerificationFileSha = verObj.verificationFileSha256;
      }
    }
  }

  if (typeof item.pdfRepairReport === "string") {
    const loaded = await readEvidenceJson(item.pdfRepairReport);
    if (!loaded.ok) {
      issues.push({
        code: "PDF_EVIDENCE_INVALID",
        item: label,
        role: "pdfRepairReport",
        path: item.pdfRepairReport,
      });
    } else {
      const rep = loaded.value;
      if (rep.operation !== "pdf-repair-ocr" || rep.status !== "pass") {
        issues.push({
          code: "PDF_EVIDENCE_INVALID",
          item: label,
          role: "pdfRepairReport",
          path: item.pdfRepairReport,
        });
      }
      const repSrc = object(rep.source) ? rep.source : null;
      const repOut = object(rep.output) ? rep.output : null;
      if (expectedSourceSha && repSrc?.sha256 !== expectedSourceSha) {
        issues.push({
          code: "PDF_REPORT_SOURCE_MISMATCH",
          item: label,
          role: "pdfRepairReport",
        });
      }
      if (expectedFinalSha && repOut?.sha256 !== expectedFinalSha) {
        issues.push({
          code: "PDF_REPORT_OUTPUT_MISMATCH",
          item: label,
          role: "pdfRepairReport",
        });
      }
      const outDisk = await verifyDiskFileSha256(repOut?.path, repOut?.sha256);
      if (outDisk !== "ok") {
        issues.push({
          code: "PDF_REPORT_OUTPUT_MISMATCH",
          item: label,
          role: "pdfRepairReport",
          reason: outDisk,
        });
      }
      if (rep.incrementalUpdate !== true) {
        issues.push({ code: "PDF_REPAIR_NOT_INCREMENTAL", item: label });
      }
      if (rep.ocrLayerVerified !== true) {
        issues.push({ code: "PDF_OCR_LAYER_UNVERIFIED", item: label });
      }
      const imgs = object(rep.preservedImageStreams)
        ? rep.preservedImageStreams
        : null;
      if (imgs?.verifiedBitIdentical !== true) {
        issues.push({ code: "PDF_IMAGE_STREAM_MUTATED", item: label });
      }
      const verObj = object(rep.verification) ? rep.verification : null;
      if (verObj && Array.isArray(verObj.pagesRequiringVerification)) {
        requiredVerificationPages = [
          ...new Set([
            ...requiredVerificationPages,
            ...verObj.pagesRequiringVerification.filter(
              (p): p is number => typeof p === "number",
            ),
          ]),
        ];
      }
      if (
        !expectedVerificationFileSha &&
        verObj &&
        typeof verObj.verificationFileSha256 === "string"
      ) {
        expectedVerificationFileSha = verObj.verificationFileSha256;
      }
    }
  }

  if (
    item.verificationReport !== undefined ||
    requiredVerificationPages.length > 0
  ) {
    issues.push(
      ...(await auditPdfVerificationEvidence(
        item.verificationReport,
        label,
        expectedSourceSha,
        requiredVerificationPages,
        expectedVerificationFileSha,
      )),
    );
  }
  issues.push(
    ...(await auditPdfEnhanceEvidence(item.enhanceReports, label, pdfRules)),
  );
  return issues;
}

async function auditDeliveryItem(
  rawItem: unknown,
  index: number,
  reportStatus: string,
  statusRule: DeliveryStatusRule | undefined,
  bibRules: BibliographyRules,
  pdfRules: PdfRules,
): Promise<AuditIssue[]> {
  const sourceObj =
    object(rawItem) && object(rawItem.source) ? rawItem.source : null;
  const label =
    typeof sourceObj?.path === "string" ? sourceObj.path : `item[${index}]`;
  if (!object(rawItem) || !sourceObj || typeof sourceObj.path !== "string") {
    return [{ code: "INVALID_ITEM", item: label }];
  }
  const sourcePath = sourceObj.path;
  const format = path.extname(sourcePath).toLowerCase().slice(1);
  const issues = await auditItemFileChain(
    rawItem,
    sourceObj,
    sourcePath,
    label,
    reportStatus,
    statusRule,
  );
  issues.push(
    ...auditItemIsbn(rawItem.isbn, format, label, bibRules),
    ...auditItemEditionClass(rawItem, label, bibRules),
    ...auditItemSynopsis(rawItem, label),
    ...(await auditItemPdfEvidence(rawItem, sourceObj, label, pdfRules)),
  );
  return issues;
}

async function auditDelivery(reportPath: string, beforePath?: string) {
  const [bibRules, deliveryRules, pdfRules, reportInput] = await Promise.all([
    readBibliographyRules(),
    readDeliveryRules(),
    readPdfRules(),
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
  const reportStatus = report.status;
  const issues: AuditIssue[] = [];
  const statusRule = Object.hasOwn(deliveryRules.statuses, reportStatus)
    ? deliveryRules.statuses[reportStatus]
    : undefined;
  if (!statusRule) {
    issues.push({
      code: "UNKNOWN_DELIVERY_STATUS",
      status: reportStatus,
    });
  }
  if (beforePath) {
    issues.push(...(await auditCalibreSidecars(beforePath)));
  }
  const itemIssueGroups = await Promise.all(
    report.items.map((rawItem, index) =>
      auditDeliveryItem(
        rawItem,
        index,
        reportStatus,
        statusRule,
        bibRules,
        pdfRules,
      ),
    ),
  );
  issues.push(...itemIssueGroups.flat());

  return {
    schemaVersion: 1,
    operation: "delivery-audit",
    ok: issues.length === 0,
    status: reportStatus,
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
