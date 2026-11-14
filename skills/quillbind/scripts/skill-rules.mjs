import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireValue } from "./tag-vocabulary.mjs";

const defaultReferencesDir = fileURLToPath(
  new URL("../references", import.meta.url),
);

const checkRule = (condition, message) =>
  requireValue(condition, "RULE_TABLE_INVALID", message);

function parseMarkdownSectionTables(markdown, heading) {
  const lines = markdown.split(/\r?\n/u);
  const rows = [];
  let inSection = false;
  let header = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{2,3}\s+/u.test(line)) {
      const title = line.replace(/^#{2,3}\s+/u, "").replace(/\s*\{#[^}]+\}\s*$/u, "").trim();
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
    rows.push(
      Object.fromEntries(header.map((col, index) => [col, cells[index]])),
    );
  }
  checkRule(rows.length > 0, `Missing or empty rule table under "${heading}"`);
  return rows;
}

function singleCode(cell, label) {
  const match = /^`([^`]+)`$/u.exec(cell);
  checkRule(Boolean(match), `Expected backtick code in ${label}, got: ${cell}`);
  return match[1];
}

function codeList(cell, label) {
  if (cell === "-" || cell === "`-`") return [];
  const items = cell.split(",").map((part) => part.trim());
  return items.map((part) => singleCode(part, label));
}

export async function readWorkTypeTagRules(referencesDir = defaultReferencesDir) {
  const content = await fs.readFile(
    path.join(referencesDir, "tags.md"),
    "utf8",
  );
  const rows = parseMarkdownSectionTables(content, "Work-type tag rules");
  const rules = {};
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

export async function readNamingRules(referencesDir = defaultReferencesDir) {
  const content = await fs.readFile(
    path.join(referencesDir, "naming.md"),
    "utf8",
  );
  const kindRows = parseMarkdownSectionTables(content, "Supported work kinds");
  const kinds = kindRows.map((row) => singleCode(row["Work kind"], "Work kind"));
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
  referencesDir = defaultReferencesDir,
) {
  const content = await fs.readFile(
    path.join(referencesDir, "bibliography.md"),
    "utf8",
  );
  const isbnRows = parseMarkdownSectionTables(
    content,
    "Complete ISBNs where supported",
  );
  const isbnDispositions = {};
  for (const row of isbnRows) {
    const code = singleCode(row["Disposition"], "Disposition");
    checkRule(
      !Object.hasOwn(isbnDispositions, code),
      `Duplicate ISBN disposition: ${code}`,
    );
    isbnDispositions[code] = {
      requiresIsbn: singleCode(row["Requires ISBN"], "Requires ISBN") === "yes",
      requiresAttemptedSources:
        singleCode(row["Requires attemptedSources"], "Requires attemptedSources") ===
        "yes",
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
  const editionClasses = {};
  for (const row of editionRows) {
    const code = singleCode(row["Edition class"], "Edition class");
    checkRule(
      !Object.hasOwn(editionClasses, code),
      `Duplicate edition class: ${code}`,
    );
    editionClasses[code] = {
      requiresIdentification:
        singleCode(row["Identification evidence"], "Identification evidence") ===
        "required",
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

export async function readDeliveryRules(referencesDir = defaultReferencesDir) {
  const content = await fs.readFile(
    path.join(referencesDir, "quality.md"),
    "utf8",
  );
  const statusRows = parseMarkdownSectionTables(
    content,
    "Maintenance delivery statuses",
  );
  const statuses = {};
  for (const row of statusRows) {
    const code = singleCode(row["Status"], "Status");
    checkRule(
      !Object.hasOwn(statuses, code),
      `Duplicate maintenance status: ${code}`,
    );
    statuses[code] = {
      filesWritten:
        singleCode(row["Files written"], "Files written") === "yes",
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
  const protectedSidecars = sidecarRows.map((row) => ({
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
