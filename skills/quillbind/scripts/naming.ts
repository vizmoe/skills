#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { object, readInput, requireValue, strings } from "./tag-vocabulary.ts";
import { readNamingRules, type NamingRules } from "./skill-rules.ts";

interface DeclaredSource {
  path: string;
  sha256: string;
}

interface UnifiedNumbering {
  number: string;
  evidence: string[];
}

interface SubseriesNumbering {
  name: string;
  number: string;
  evidence: string[];
}

interface OfficialNumbering {
  unified: UnifiedNumbering | null;
  subseries: SubseriesNumbering | null;
  unavailableEvidence: string[];
}

interface NamingBookRecord {
  id: string;
  edition: string;
  kind: string;
  originalTitle: string;
  volumeTitle: string | null;
  firstPublished: string | null;
  source: DeclaredSource | null;
  evidence: string[];
  official: OfficialNumbering;
}

interface NamingRow {
  book: NamingBookRecord;
  date: [string, string] | null;
  basis: string;
  prefix: string;
  position: string | null;
  anchor: string | null;
  sequence: number;
  label: string | null;
  filenameStem?: string;
}

interface CodedError extends Error {
  code?: string;
}

function check(condition: unknown, message: string): asserts condition {
  requireValue(condition, "NAMING_INPUT", message);
}

function shape(
  value: unknown,
  keys: string[],
  labelName: string,
): asserts value is Record<string, unknown> {
  check(
    object(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((item) => Object.hasOwn(value, item)),
    `Invalid ${labelName} fields`,
  );
}

function evidence(
  value: unknown,
  labelName: string,
  empty = false,
): asserts value is string[] {
  check(
    Array.isArray(value) &&
      value.every((item) => typeof item === "string" && Boolean(item.trim())) &&
      (empty || value.length > 0),
    `Evidence required for ${labelName}`,
  );
}

function text(value: unknown, labelName: string): string {
  check(
    typeof value === "string" &&
      value.length > 0 &&
      value === value.trim() &&
      ![...value].some((ch) => {
        const code = ch.codePointAt(0);
        return code !== undefined && (code <= 0x1f || code === 0x7f);
      }),
    `Invalid ${labelName} text or component whitespace`,
  );
  return value;
}

function trimTrailingZeros(digits: string): string {
  let end = digits.length;
  while (end > 0 && digits[end - 1] === "0") {
    end -= 1;
  }
  return digits.slice(0, end);
}

function normalizeNumber(value: unknown): string {
  check(
    typeof value === "string" &&
      value.length <= 30 &&
      /^\d+(?:\.\d+)?$/.test(value),
    "Official numbers must be evidenced Arabic values, not Roman numerals or local labels",
  );
  const [whole = "", fraction = ""] = value.split(".");
  const integer = whole.replace(/^0+(?=\d)/, "");
  const decimal = trimTrailingZeros(fraction);
  return integer + (decimal ? `.${decimal}` : "");
}

function formatLabel(value: string): string {
  const [whole = "", fraction] = value.split(".");
  return whole.padStart(2, "0") + (fraction ? `.${fraction}` : "");
}

function expandDateStart(value: string): string {
  if (value.length === 4) return `${value}-01-01`;
  if (value.length === 7) return `${value}-01`;
  return value;
}

function dateInterval(value: unknown): [string, string] | null {
  if (value === null) return null;
  check(
    typeof value === "string" &&
      /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value) &&
      !value.startsWith("0000"),
    "firstPublished must preserve a valid YYYY, YYYY-MM or YYYY-MM-DD date, or be null",
  );
  const start = expandDateStart(value);
  const date = new Date(`${start}T00:00:00Z`);
  check(
    Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === start,
    "Invalid firstPublished calendar date",
  );
  const end = new Date(date);
  if (value.length === 4) end.setUTCFullYear(end.getUTCFullYear() + 1);
  else if (value.length === 7) end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCDate(end.getUTCDate() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return [start, end.toISOString().slice(0, 10)];
}

function compare(a: string | number, b: string | number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const nameKey = (value: string): string => value.normalize("NFC").toLowerCase();

function numericCompare(a: string, b: string): number {
  const [ai = "", af = ""] = a.split(".");
  const [bi = "", bf = ""] = b.split(".");
  return (
    compare(ai.length, bi.length) ||
    compare(ai, bi) ||
    compare(
      af.padEnd(Math.max(af.length, bf.length), "0"),
      bf.padEnd(Math.max(af.length, bf.length), "0"),
    )
  );
}

function parseDeclaredSource(
  rawSource: unknown,
  sourcePaths: Set<string>,
): DeclaredSource | null {
  if (rawSource === null) return null;
  shape(rawSource, ["path", "sha256"], "declared source");
  const sourcePath = text(rawSource.path, "source path");
  check(path.isAbsolute(sourcePath), "Declared source path must be absolute");
  check(
    typeof rawSource.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(rawSource.sha256),
    "Declared source requires a SHA-256",
  );
  const sourceKey = nameKey(path.normalize(sourcePath));
  check(
    !sourcePaths.has(sourceKey),
    "Source path collision: one file cannot represent several books",
  );
  sourcePaths.add(sourceKey);
  return { path: sourcePath, sha256: rawSource.sha256 };
}

function parseOfficialNumbering(
  rawOfficial: unknown,
  bookId: string,
): OfficialNumbering {
  shape(
    rawOfficial,
    ["unified", "subseries", "unavailableEvidence"],
    "official numbering",
  );
  let parsedUnified: UnifiedNumbering | null = null;
  if (rawOfficial.unified !== null) {
    shape(
      rawOfficial.unified,
      ["number", "evidence"],
      "official unified numbering",
    );
    normalizeNumber(rawOfficial.unified.number);
    evidence(rawOfficial.unified.evidence, `unified numbering of ${bookId}`);
    parsedUnified = {
      number: rawOfficial.unified.number as string,
      evidence: rawOfficial.unified.evidence,
    };
  }
  let parsedSubseries: SubseriesNumbering | null = null;
  if (rawOfficial.subseries !== null) {
    shape(
      rawOfficial.subseries,
      ["name", "number", "evidence"],
      "official subseries",
    );
    const subName = text(rawOfficial.subseries.name, "official subseries name");
    normalizeNumber(rawOfficial.subseries.number);
    evidence(
      rawOfficial.subseries.evidence,
      `independent subseries name and numbering of ${bookId}`,
    );
    parsedSubseries = {
      name: subName,
      number: rawOfficial.subseries.number as string,
      evidence: rawOfficial.subseries.evidence,
    };
  }
  evidence(
    rawOfficial.unavailableEvidence,
    `absence of applicable official numbering for ${bookId}`,
    parsedUnified !== null || parsedSubseries !== null,
  );
  return {
    unified: parsedUnified,
    subseries: parsedSubseries,
    unavailableEvidence: rawOfficial.unavailableEvidence,
  };
}

function resolveNamingBasis(
  official: OfficialNumbering,
  bases: string[],
): string {
  const [
    unifiedBasis = "official-unified",
    subseriesBasis = "official-subseries",
    localBasis = "local-insertion",
  ] = bases;
  if (official.unified) return unifiedBasis;
  if (official.subseries) return subseriesBasis;
  return localBasis;
}

function parseBookRow(
  rawBook: unknown,
  seriesEdition: string,
  seriesName: string,
  namingRules: NamingRules,
  ids: Set<string>,
  sourcePaths: Set<string>,
): NamingRow {
  shape(
    rawBook,
    [
      "id",
      "edition",
      "kind",
      "originalTitle",
      "volumeTitle",
      "firstPublished",
      "source",
      "evidence",
      "official",
    ],
    "book",
  );
  check(
    typeof rawBook.id === "string" &&
      /^[A-Za-z0-9_-]+$/.test(rawBook.id) &&
      !ids.has(rawBook.id),
    "Book IDs must be unique stable identifiers",
  );
  ids.add(rawBook.id);
  check(
    rawBook.edition === seriesEdition,
    `Mixed or missing target edition for ${rawBook.id}`,
  );
  check(
    typeof rawBook.kind === "string" &&
      namingRules.kinds.includes(rawBook.kind),
    `Unknown work kind: ${rawBook.id}`,
  );
  const originalTitle = text(rawBook.originalTitle, "original title");
  check(
    rawBook.volumeTitle === null || typeof rawBook.volumeTitle === "string",
    `Invalid volume title for ${rawBook.id}`,
  );
  const volumeTitle =
    rawBook.volumeTitle !== null
      ? text(rawBook.volumeTitle, "volume title")
      : null;
  evidence(
    rawBook.evidence,
    `work identity/title/first publication of ${rawBook.id}`,
  );
  const parsedSource = parseDeclaredSource(rawBook.source, sourcePaths);
  const parsedOfficial = parseOfficialNumbering(rawBook.official, rawBook.id);
  check(
    rawBook.kind !== "main" || parsedOfficial.unified !== null,
    `Main volume ${rawBook.id} needs its official main-series number`,
  );
  const parsedDate = dateInterval(rawBook.firstPublished);
  const bookRecord: NamingBookRecord = {
    id: rawBook.id,
    edition: seriesEdition,
    kind: rawBook.kind,
    originalTitle,
    volumeTitle,
    firstPublished: rawBook.firstPublished as string | null,
    source: parsedSource,
    evidence: rawBook.evidence,
    official: parsedOfficial,
  };
  const selected = parsedOfficial.unified ?? parsedOfficial.subseries;
  const normalizedPos = selected ? normalizeNumber(selected.number) : null;
  const subseriesSuffix =
    !parsedOfficial.unified && parsedOfficial.subseries
      ? ` ${parsedOfficial.subseries.name}`
      : "";
  return {
    book: bookRecord,
    date: parsedDate,
    basis: resolveNamingBasis(parsedOfficial, namingRules.bases),
    prefix: seriesName + subseriesSuffix,
    position: normalizedPos,
    anchor: null,
    sequence: 0,
    label: normalizedPos ? formatLabel(normalizedPos) : null,
  };
}

function validateSubseriesNames(rows: NamingRow[]): void {
  const subseriesNames = new Map<string, string>();
  for (const row of rows) {
    if (row.basis !== "official-subseries") continue;
    const name = row.book.official.subseries!.name;
    const subKey = name.normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
    check(
      !subseriesNames.has(subKey) || subseriesNames.get(subKey) === name,
      "Use one consistent subseries name; resolve spelling variants from the official evidence",
    );
    subseriesNames.set(subKey, name);
  }
}

function parseChronologyRanks(
  chronologyInput: unknown,
  ids: Set<string>,
  relevant: NamingRow[],
): Map<string, number> | undefined {
  if (chronologyInput === null) return undefined;
  shape(chronologyInput, ["order", "evidence"], "chronology");
  evidence(chronologyInput.evidence, "first-publication chronology");
  const order = chronologyInput.order;
  check(
    strings(order) &&
      new Set(order).size === order.length &&
      order.every((id) => ids.has(id)) &&
      relevant.every((row) => order.includes(row.book.id)),
    "chronology.order must contain every main/local-extra ID exactly once, with no unknown or duplicated IDs",
  );
  return new Map(order.map((id, index) => [id, index]));
}

function compareDateIntervals(
  a: [string, string] | null,
  b: [string, string] | null,
): number {
  if (!a || !b) return 0;
  if (a[1] < b[0]) return -1;
  if (b[1] < a[0]) return 1;
  return 0;
}

function compareChronology(
  a: NamingRow,
  b: NamingRow,
  ranks: Map<string, number> | undefined,
): number {
  const known = compareDateIntervals(a.date, b.date);
  const ranked =
    ranks?.has(a.book.id) && ranks.has(b.book.id)
      ? compare(ranks.get(a.book.id)!, ranks.get(b.book.id)!)
      : 0;
  check(
    !known || !ranked || known === ranked,
    `Explicit chronology contradicts first-publication dates: ${a.book.id}, ${b.book.id}`,
  );
  check(
    Boolean(known || ranked),
    `Ambiguous first-publication chronology for ${a.book.id}, ${b.book.id}; supply evidenced chronology.order`,
  );
  return known || ranked;
}

function validateChronologyPairs(
  targetRows: NamingRow[],
  ranks: Map<string, number> | undefined,
): void {
  // Validate every pair, not only whichever pairs an engine's sort happens to compare.
  for (let i = 0; i < targetRows.length; i++) {
    for (let j = i + 1; j < targetRows.length; j++) {
      compareChronology(targetRows[i]!, targetRows[j]!, ranks);
    }
  }
}

function labelInsertionGroup(group: NamingRow[]): void {
  for (const [index, row] of group.entries()) {
    row.sequence = index + 1;
    const suffix =
      group.length > 1 ? `-${String(index + 1).padStart(2, "0")}` : "";
    row.label = formatLabel(row.position!) + suffix;
  }
}

function assignLocalInsertions(
  rows: NamingRow[],
  relevant: NamingRow[],
  coverage: {
    mainComplete: boolean;
    extrasComplete: boolean;
    evidence: string[];
  },
  ranks: Map<string, number> | undefined,
): void {
  const local = rows.filter((row) => row.basis === "local-insertion");
  if (local.length === 0) return;
  check(
    coverage.mainComplete &&
      coverage.extrasComplete &&
      coverage.evidence.length > 0,
    "Local insertions need complete main-volume and unnumbered-extra inventories with evidence",
  );
  const ordered = [...relevant];
  validateChronologyPairs(ordered, ranks);
  ordered.sort((a, b) => compareChronology(a, b, ranks));
  const groups = new Map<string, NamingRow[]>();
  let anchor: NamingRow | undefined;
  for (const row of ordered) {
    if (row.book.kind === "main") {
      check(
        row.position !== null && !row.position.includes("."),
        "Local insertion anchors require an evidenced integer main-volume number",
      );
      anchor = row;
      continue;
    }
    check(
      anchor !== undefined,
      `No preceding main volume for ${row.book.id}; do not invent a 00.5 anchor`,
    );
    row.anchor = anchor.book.id;
    row.position = `${anchor.position}.5`;
    const group = groups.get(anchor.book.id) ?? [];
    group.push(row);
    groups.set(anchor.book.id, group);
  }
  for (const group of groups.values()) {
    labelInsertionGroup(group);
  }
}

function assignAndValidateFilenames(rows: NamingRow[]): void {
  const official = new Set<string>();
  for (const row of rows) {
    if (row.basis === "local-insertion") continue;
    const offKey = `${nameKey(row.prefix)}\0${row.position}`;
    check(
      !official.has(offKey),
      `Official number collision in ${row.prefix}: ${row.position}`,
    );
    official.add(offKey);
  }
  const filenames = new Set<string>();
  for (const row of rows) {
    if (row.basis === "local-insertion") {
      check(
        !official.has(`${nameKey(row.prefix)}\0${row.position}`),
        `Local/official number collision at ${row.label}; resolve the numbering evidence`,
      );
    }
    row.filenameStem =
      `${row.prefix} (${row.label})` +
      (row.book.volumeTitle !== null ? ` ${row.book.volumeTitle}` : "");
    check(
      !/[/\\]/u.test(row.filenameStem) && !row.filenameStem.includes("\0"),
      `Filename cannot preserve a path separator for ${row.book.id}; resolve the naming constraint explicitly`,
    );
    const fnKey = nameKey(row.filenameStem);
    check(!filenames.has(fnKey), `Filename collision: ${row.filenameStem}`);
    filenames.add(fnKey);
  }
}

function formatPlanBook(row: NamingRow) {
  const [whole = "", fraction = ""] = row.position!.split(".");
  return {
    id: row.book.id,
    source: row.book.source,
    originalTitle: row.book.originalTitle,
    filenameStem: row.filenameStem!,
    label: row.label!,
    basis: row.basis,
    anchor: row.anchor,
    sortKey: [row.prefix, whole, fraction, row.sequence],
    officialMetadata:
      row.basis === "local-insertion"
        ? null
        : {
            title: row.filenameStem!,
            series: row.prefix,
            position: row.position!,
          },
    firstPublished: row.book.firstPublished,
    evidence: row.book.evidence,
    official: row.book.official,
  };
}

function buildPlan(data: unknown, namingRules: NamingRules) {
  shape(
    data,
    ["schemaVersion", "series", "coverage", "chronology", "books"],
    "inventory",
  );
  check(data.schemaVersion === 1, "Unsupported inventory schemaVersion");
  shape(data.series, ["name", "edition", "evidence"], "series");
  const seriesName = text(data.series.name, "standard series name");
  const seriesEdition = text(data.series.edition, "target edition");
  evidence(data.series.evidence, "standard series and target edition");
  shape(
    data.coverage,
    ["mainComplete", "extrasComplete", "evidence"],
    "coverage",
  );
  check(
    typeof data.coverage.mainComplete === "boolean" &&
      typeof data.coverage.extrasComplete === "boolean",
    "Invalid coverage flags",
  );
  evidence(data.coverage.evidence, "inventory coverage", true);
  check(
    Array.isArray(data.books) && data.books.length > 0,
    "Expected books inventory",
  );
  const ids = new Set<string>();
  const sourcePaths = new Set<string>();
  const rows: NamingRow[] = data.books.map((rawBook) =>
    parseBookRow(
      rawBook,
      seriesEdition,
      seriesName,
      namingRules,
      ids,
      sourcePaths,
    ),
  );
  const relevant = rows.filter(
    (row) => row.book.kind === "main" || row.basis === "local-insertion",
  );
  validateSubseriesNames(rows);
  const ranks = parseChronologyRanks(data.chronology, ids, relevant);
  if (ranks) {
    validateChronologyPairs(
      rows.filter((row) => ranks.has(row.book.id)),
      ranks,
    );
  }
  assignLocalInsertions(
    rows,
    relevant,
    {
      mainComplete: data.coverage.mainComplete,
      extrasComplete: data.coverage.extrasComplete,
      evidence: data.coverage.evidence,
    },
    ranks,
  );
  assignAndValidateFilenames(rows);
  const selected = rows.filter((row) => row.book.source !== null);
  check(
    selected.length > 0,
    "No source files selected; reference-only inventory has no naming proposals",
  );
  return {
    series: data.series,
    coverage: data.coverage,
    chronology: data.chronology,
    order: [...selected]
      .sort(
        (a, b) =>
          compare(a.prefix, b.prefix) ||
          numericCompare(a.position!, b.position!) ||
          a.sequence - b.sequence,
      )
      .map((row) => row.book.id),
    books: selected.map(formatPlanBook),
    referenceOnly: rows
      .filter((row) => row.book.source === null)
      .map((row) => row.book),
  };
}

async function run(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "naming.ts plan --input INVENTORY.json [--output NEW_PLAN.json]\nRead-only whole-series naming proposals for all book types. Declared ebook sources are not opened or modified.",
    );
    return;
  }
  check(
    positionals.length === 1 && positionals[0] === "plan" && values.input,
    "Use plan --input INVENTORY.json; see --help",
  );
  const [input, namingRules] = await Promise.all([
    readInput(values.input),
    readNamingRules(),
  ]);
  const report = {
    schemaVersion: 1,
    operation: "series-naming-plan",
    status: "reviewable",
    libraryWritten: false,
    sourceVerification: "declared-only",
    inputs: { inventory: input.source },
    ...buildPlan(input.value, namingRules),
  };
  const output = JSON.stringify(report, null, 2) + "\n";
  if (values.output) {
    await fs.writeFile(values.output, output, { flag: "wx" });
  }
  process.stdout.write(output);
}

try {
  await run();
} catch (error) {
  const err = error as CodedError;
  console.log(
    JSON.stringify({
      status: "error",
      code:
        err.code === "EEXIST" ? "OUTPUT_EXISTS" : (err.code ?? "NAMING_INPUT"),
      message: err.message ?? String(error),
    }),
  );
  process.exitCode = 1;
}
