import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireValue } from "./tag-vocabulary.ts";

export interface WorkKindRule {
  required?: string;
  forbidden: string[];
  requiresPrefix?: string;
}

export interface NamingRules {
  kinds: string[];
  bases: string[];
}

export interface IsbnDispositionRule {
  requiresIsbn: boolean;
  requiresAttemptedSources: boolean;
}

export interface EditionClassRule {
  requiresIdentification: boolean;
}

export interface BibliographyRules {
  isbnDispositions: Record<string, IsbnDispositionRule>;
  editionClasses: Record<string, EditionClassRule>;
}

export interface DeliveryStatusRule {
  filesWritten: boolean;
}

export interface ProtectedSidecarRule {
  filename: string;
  inspection: string;
}

export interface DeliveryRules {
  statuses: Record<string, DeliveryStatusRule>;
  protectedSidecars: ProtectedSidecarRule[];
}

export interface ParallelRoleRule {
  writeScope: string;
  selfApproval: boolean;
}

export interface ParallelWorkflowRules {
  roles: Record<string, ParallelRoleRule>;
}

const defaultReferencesDir = fileURLToPath(
  new URL("../references", import.meta.url),
);

function checkRule(condition: unknown, message: string): asserts condition {
  requireValue(condition, "RULE_TABLE_INVALID", message);
}

function stripHeadingAnchor(headingText: string): string {
  const trimmed = headingText.trim();
  if (trimmed.length < 4 || !trimmed.endsWith("}")) return trimmed;
  const prevClose = trimmed.lastIndexOf("}", trimmed.length - 2);
  const open = trimmed.indexOf("{#", prevClose + 1);
  if (open === -1 || open + 2 >= trimmed.length - 1) return trimmed;
  return trimmed.slice(0, open).trim();
}

function parseMarkdownSectionTables(
  markdown: string,
  heading: string,
): Record<string, string>[] {
  const lines = markdown.split(/\r?\n/u);
  const rows: Record<string, string>[] = [];
  let inSection = false;
  let header: string[] | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{2,3}\s+/u.test(line)) {
      const title = stripHeadingAnchor(line.replace(/^#{2,3}\s+/u, ""));
      inSection = title === heading;
      header = null;
      continue;
    }
    if (!inSection || !line.startsWith("|")) continue;
    const cells = line
      .replace(/^\|/u, "")
      .replace(/\|$/u, "")
      .split("|")
      .map((cell) => cell.trim());
    if (!header) {
      header = cells;
      continue;
    }
    if (cells.every((cell) => /^:?-+:?$/u.test(cell))) continue;
    checkRule(
      cells.length === header.length,
      `Malformed table row under "${heading}": ${line}`,
    );
    const currentHeader = header;
    rows.push(
      Object.fromEntries(
        currentHeader.map((col, index) => [col, cells[index] ?? ""]),
      ),
    );
  }
  checkRule(rows.length > 0, `Missing or empty rule table under "${heading}"`);
  return rows;
}

function singleCode(cell: string | undefined, label: string): string {
  checkRule(typeof cell === "string", `Missing table cell in ${label}`);
  const match = /^`([^`]+)`$/u.exec(cell);
  checkRule(match !== null, `Expected backtick code in ${label}, got: ${cell}`);
  return match[1]!;
}

function codeList(cell: string | undefined, label: string): string[] {
  checkRule(typeof cell === "string", `Missing table cell in ${label}`);
  if (cell === "-" || cell === "`-`") return [];
  const items = cell.split(",").map((part) => part.trim());
  return items.map((part) => singleCode(part, label));
}

export async function readWorkTypeTagRules(
  referencesDir: string = defaultReferencesDir,
): Promise<Record<string, WorkKindRule>> {
  const content = await fs.readFile(
    path.join(referencesDir, "tags.md"),
    "utf8",
  );
  const rows = parseMarkdownSectionTables(content, "Work-type tag rules");
  const rules: Record<string, WorkKindRule> = {};
  for (const row of rows) {
    const kind = singleCode(row["Work kind"], "Work kind");
    checkRule(!Object.hasOwn(rules, kind), `Duplicate work kind row: ${kind}`);
    const requiredCell = row["Required tag"];
    const required =
      requiredCell === "-" || requiredCell === "`-`"
        ? undefined
        : singleCode(requiredCell, "Required tag");
    const forbidden = codeList(row["Forbidden tags"], "Forbidden tags");
    const prefixCell = row["Required prefix"];
    const requiresPrefix =
      prefixCell === "-" || prefixCell === "`-`"
        ? undefined
        : singleCode(prefixCell, "Required prefix");
    rules[kind] = {
      ...(required ? { required } : {}),
      forbidden,
      ...(requiresPrefix ? { requiresPrefix } : {}),
    };
  }
  for (const expected of ["light-novel", "manga", "art-book"]) {
    checkRule(
      Object.hasOwn(rules, expected),
      `tags.md must declare work kind "${expected}"`,
    );
  }
  return rules;
}

export async function readNamingRules(
  referencesDir: string = defaultReferencesDir,
): Promise<NamingRules> {
  const content = await fs.readFile(
    path.join(referencesDir, "naming.md"),
    "utf8",
  );
  const kindRows = parseMarkdownSectionTables(content, "Supported work kinds");
  const kinds = kindRows.map((row) =>
    singleCode(row["Work kind"], "Work kind"),
  );
  checkRule(
    new Set(kinds).size === kinds.length,
    "Duplicate naming work kind declaration",
  );
  for (const expected of [
    "main",
    "side-story",
    "short-story-collection",
    "extra",
  ]) {
    checkRule(
      kinds.includes(expected),
      `naming.md must declare work kind "${expected}"`,
    );
  }

  const basisRows = parseMarkdownSectionTables(
    content,
    "Choose numbers in this order",
  );
  const bases = basisRows.map((row) => singleCode(row["Basis"], "Basis"));
  checkRule(
    new Set(bases).size === bases.length,
    "Duplicate numbering basis declaration",
  );
  for (const expected of [
    "official-unified",
    "official-subseries",
    "local-insertion",
  ]) {
    checkRule(
      bases.includes(expected),
      `naming.md must declare numbering basis "${expected}"`,
    );
  }
  return { kinds, bases };
}

export async function readBibliographyRules(
  referencesDir: string = defaultReferencesDir,
): Promise<BibliographyRules> {
  const content = await fs.readFile(
    path.join(referencesDir, "bibliography.md"),
    "utf8",
  );
  const isbnRows = parseMarkdownSectionTables(
    content,
    "Complete ISBNs where supported",
  );
  const isbnDispositions: Record<string, IsbnDispositionRule> = {};
  for (const row of isbnRows) {
    const code = singleCode(row["Disposition"], "Disposition");
    checkRule(
      !Object.hasOwn(isbnDispositions, code),
      `Duplicate ISBN disposition: ${code}`,
    );
    isbnDispositions[code] = {
      requiresIsbn: singleCode(row["Requires ISBN"], "Requires ISBN") === "yes",
      requiresAttemptedSources:
        singleCode(
          row["Requires attemptedSources"],
          "Requires attemptedSources",
        ) === "yes",
    };
  }
  for (const expected of [
    "retained",
    "added",
    "corrected",
    "skipped-format",
    "unresolved",
    "out-of-scope",
  ]) {
    checkRule(
      Object.hasOwn(isbnDispositions, expected),
      `bibliography.md must declare ISBN disposition "${expected}"`,
    );
  }

  const editionRows = parseMarkdownSectionTables(
    content,
    "Self-made and non-retail editions",
  );
  const editionClasses: Record<string, EditionClassRule> = {};
  for (const row of editionRows) {
    const code = singleCode(row["Edition class"], "Edition class");
    checkRule(
      !Object.hasOwn(editionClasses, code),
      `Duplicate edition class: ${code}`,
    );
    editionClasses[code] = {
      requiresIdentification:
        singleCode(
          row["Identification evidence"],
          "Identification evidence",
        ) === "required",
    };
  }
  for (const expected of [
    "retail",
    "self-made",
    "compilation",
    "doujin",
    "scan-derived",
  ]) {
    checkRule(
      Object.hasOwn(editionClasses, expected),
      `bibliography.md must declare edition class "${expected}"`,
    );
  }
  return { isbnDispositions, editionClasses };
}

export async function readDeliveryRules(
  referencesDir: string = defaultReferencesDir,
): Promise<DeliveryRules> {
  const content = await fs.readFile(
    path.join(referencesDir, "quality.md"),
    "utf8",
  );
  const statusRows = parseMarkdownSectionTables(
    content,
    "Maintenance delivery statuses",
  );
  const statuses: Record<string, DeliveryStatusRule> = {};
  for (const row of statusRows) {
    const code = singleCode(row["Status"], "Status");
    checkRule(
      !Object.hasOwn(statuses, code),
      `Duplicate maintenance status: ${code}`,
    );
    statuses[code] = {
      filesWritten: singleCode(row["Files written"], "Files written") === "yes",
    };
  }
  for (const expected of [
    "plan-only",
    "staged-only",
    "partial",
    "completed",
    "blocked",
  ]) {
    checkRule(
      Object.hasOwn(statuses, expected),
      `quality.md must declare maintenance status "${expected}"`,
    );
  }

  const sidecarRows = parseMarkdownSectionTables(
    content,
    "Protected Calibre sidecars",
  );
  const protectedSidecars: ProtectedSidecarRule[] = sidecarRows.map((row) => ({
    filename: singleCode(row["File"], "File"),
    inspection: singleCode(row["Inspection"], "Inspection"),
  }));
  for (const expected of ["metadata.db", "metadata.opf", "cover.jpg"]) {
    checkRule(
      protectedSidecars.some((item) => item.filename === expected),
      `quality.md must declare protected Calibre file "${expected}"`,
    );
  }
  return { statuses, protectedSidecars };
}

export async function readParallelWorkflowRules(
  referencesDir: string = defaultReferencesDir,
): Promise<ParallelWorkflowRules> {
  const content = await fs.readFile(
    path.join(referencesDir, "parallel-workflow.md"),
    "utf8",
  );
  const roleRows = parseMarkdownSectionTables(
    content,
    "Subagent role contracts",
  );
  const roles: Record<string, ParallelRoleRule> = {};
  for (const row of roleRows) {
    const role = singleCode(row["Role"], "Role");
    checkRule(!Object.hasOwn(roles, role), `Duplicate subagent role: ${role}`);
    const approvalCode = singleCode(row["Self-approval"], "Self-approval");
    checkRule(
      approvalCode === "allowed" || approvalCode === "forbidden",
      `Self-approval must be allowed or forbidden for ${role}`,
    );
    roles[role] = {
      writeScope: singleCode(row["Write scope"], "Write scope"),
      selfApproval: approvalCode === "allowed",
    };
  }
  for (const expected of ["coordinator", "worker", "verifier"]) {
    checkRule(
      Object.hasOwn(roles, expected),
      `parallel-workflow.md must declare subagent role "${expected}"`,
    );
  }
  checkRule(
    roles.verifier?.writeScope === "read-only-reports" &&
      roles.worker?.selfApproval === false &&
      roles.coordinator?.selfApproval === false,
    "parallel-workflow.md must keep verifier read-only and forbid worker/coordinator self-approval",
  );
  return { roles };
}
