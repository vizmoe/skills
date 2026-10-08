#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { object, readInput, requireValue, strings } from "./tag-vocabulary.mjs";

const check = (condition, message) =>
  requireValue(condition, "NAMING_INPUT", message);
function shape(value, keys, label) {
  check(
    object(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    `Invalid ${label} fields`,
  );
}
function evidence(value, label, empty = false) {
  check(
    strings(value) && (empty || value.length),
    `Evidence required for ${label}`,
  );
}
function text(value, label) {
  check(
    typeof value === "string" &&
      value.length > 0 &&
      value === value.trim() &&
      !/[\u0000-\u001f\u007f]/u.test(value),
    `Invalid ${label} text or component whitespace`,
  );
  return value;
}
function number(value) {
  check(
    typeof value === "string" &&
      value.length <= 30 &&
      /^\d+(?:\.\d+)?$/.test(value),
    "Official numbers must be evidenced Arabic values, not Roman numerals or local labels",
  );
  const [whole, fraction = ""] = value.split(".");
  const integer = whole.replace(/^0+(?=\d)/, "");
  const decimal = fraction.replace(/0+$/, "");
  return integer + (decimal ? `.${decimal}` : "");
}
function label(value) {
  const [whole, fraction] = value.split(".");
  return whole.padStart(2, "0") + (fraction ? `.${fraction}` : "");
}
function dateInterval(value) {
  if (value === null) return null;
  check(
    typeof value === "string" &&
      /^[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?$/.test(value) &&
      !value.startsWith("0000"),
    "firstPublished must preserve a valid YYYY, YYYY-MM or YYYY-MM-DD date, or be null",
  );
  const start =
    value.length === 4
      ? `${value}-01-01`
      : value.length === 7
        ? `${value}-01`
        : value;
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
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const nameKey = (value) => value.normalize("NFC").toLowerCase();
function numericCompare(a, b) {
  const [ai, af = ""] = a.split("."),
    [bi, bf = ""] = b.split(".");
  return (
    compare(ai.length, bi.length) ||
    compare(ai, bi) ||
    compare(
      af.padEnd(Math.max(af.length, bf.length), "0"),
      bf.padEnd(Math.max(af.length, bf.length), "0"),
    )
  );
}

function plan(data) {
  shape(
    data,
    ["schemaVersion", "series", "coverage", "chronology", "books"],
    "inventory",
  );
  check(data.schemaVersion === 1, "Unsupported inventory schemaVersion");
  shape(data.series, ["name", "edition", "evidence"], "series");
  text(data.series.name, "standard series name");
  text(data.series.edition, "target edition");
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
  const ids = new Set(),
    sourcePaths = new Set();
  const rows = data.books.map((book) => {
    shape(
      book,
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
      typeof book.id === "string" &&
        /^[A-Za-z0-9_-]+$/.test(book.id) &&
        !ids.has(book.id),
      "Book IDs must be unique stable identifiers",
    );
    ids.add(book.id);
    check(
      book.edition === data.series.edition,
      `Mixed or missing target edition for ${book.id}`,
    );
    check(
      ["main", "side-story", "short-story-collection", "extra"].includes(
        book.kind,
      ),
      `Unknown work kind: ${book.id}`,
    );
    text(book.originalTitle, "original title");
    if (book.volumeTitle !== null) text(book.volumeTitle, "volume title");
    evidence(
      book.evidence,
      `work identity/title/first publication of ${book.id}`,
    );
    if (book.source !== null) {
      shape(book.source, ["path", "sha256"], "declared source");
      text(book.source.path, "source path");
      check(
        path.isAbsolute(book.source.path),
        "Declared source path must be absolute",
      );
      check(
        typeof book.source.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(book.source.sha256),
        "Declared source requires a SHA-256",
      );
      const key = nameKey(path.normalize(book.source.path));
      check(
        !sourcePaths.has(key),
        "Source path collision: one file cannot represent several books",
      );
      sourcePaths.add(key);
    }
    shape(
      book.official,
      ["unified", "subseries", "unavailableEvidence"],
      "official numbering",
    );
    const { unified, subseries } = book.official;
    if (unified !== null) {
      shape(unified, ["number", "evidence"], "official unified numbering");
      number(unified.number);
      evidence(unified.evidence, `unified numbering of ${book.id}`);
    }
    if (subseries !== null) {
      shape(subseries, ["name", "number", "evidence"], "official subseries");
      text(subseries.name, "official subseries name");
      number(subseries.number);
      evidence(
        subseries.evidence,
        `independent subseries name and numbering of ${book.id}`,
      );
    }
    evidence(
      book.official.unavailableEvidence,
      `absence of applicable official numbering for ${book.id}`,
      unified !== null || subseries !== null,
    );
    check(
      book.kind !== "main" || unified !== null,
      `Main volume ${book.id} needs its official main-series number`,
    );
    const selected = unified ?? subseries;
    return {
      book,
      date: dateInterval(book.firstPublished),
      basis: unified
        ? "official-unified"
        : subseries
          ? "official-subseries"
          : "local-insertion",
      prefix:
        data.series.name + (!unified && subseries ? ` ${subseries.name}` : ""),
      position: selected ? number(selected.number) : null,
      anchor: null,
      sequence: 0,
      label: selected ? label(number(selected.number)) : null,
    };
  });
  const relevant = rows.filter(
    (row) => row.book.kind === "main" || row.basis === "local-insertion",
  );
  const subseriesNames = new Map();
  for (const row of rows.filter(
    (item) => item.basis === "official-subseries",
  )) {
    const name = row.book.official.subseries.name;
    const key = name.normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
    check(
      !subseriesNames.has(key) || subseriesNames.get(key) === name,
      "Use one consistent subseries name; resolve spelling variants from the official evidence",
    );
    subseriesNames.set(key, name);
  }
  let ranks;
  if (data.chronology !== null) {
    shape(data.chronology, ["order", "evidence"], "chronology");
    evidence(data.chronology.evidence, "first-publication chronology");
    const order = data.chronology.order;
    check(
      Array.isArray(order) &&
        new Set(order).size === order.length &&
        order.every((id) => ids.has(id)) &&
        relevant.every((row) => order.includes(row.book.id)),
      "chronology.order must contain every main/local-extra ID exactly once, with no unknown or duplicated IDs",
    );
    ranks = new Map(order.map((id, index) => [id, index]));
  }
  function chronology(a, b) {
    const known =
      a.date && b.date
        ? a.date[1] < b.date[0]
          ? -1
          : b.date[1] < a.date[0]
            ? 1
            : 0
        : 0;
    const ranked =
      ranks?.has(a.book.id) && ranks.has(b.book.id)
        ? compare(ranks.get(a.book.id), ranks.get(b.book.id))
        : 0;
    check(
      !known || !ranked || known === ranked,
      `Explicit chronology contradicts first-publication dates: ${a.book.id}, ${b.book.id}`,
    );
    check(
      known || ranked,
      `Ambiguous first-publication chronology for ${a.book.id}, ${b.book.id}; supply evidenced chronology.order`,
    );
    return known || ranked;
  }
  if (ranks) {
    // Validate every pair, not only whichever pairs an engine's sort happens to compare.
    const rankedRows = rows.filter((row) => ranks.has(row.book.id));
    for (let i = 0; i < rankedRows.length; i++)
      for (let j = i + 1; j < rankedRows.length; j++)
        chronology(rankedRows[i], rankedRows[j]);
  }
  const local = rows.filter((row) => row.basis === "local-insertion");
  if (local.length) {
    check(
      data.coverage.mainComplete &&
        data.coverage.extrasComplete &&
        data.coverage.evidence.length > 0,
      "Local insertions need complete main-volume and unnumbered-extra inventories with evidence",
    );
    const ordered = [...relevant];
    for (let i = 0; i < ordered.length; i++)
      for (let j = i + 1; j < ordered.length; j++)
        chronology(ordered[i], ordered[j]);
    ordered.sort(chronology);
    const groups = new Map();
    let anchor;
    for (const row of ordered) {
      if (row.book.kind === "main") {
        check(
          !row.position.includes("."),
          "Local insertion anchors require an evidenced integer main-volume number",
        );
        anchor = row;
      } else {
        check(
          anchor,
          `No preceding main volume for ${row.book.id}; do not invent a 00.5 anchor`,
        );
        row.anchor = anchor.book.id;
        row.position = `${anchor.position}.5`;
        const group = groups.get(anchor.book.id) ?? [];
        group.push(row);
        groups.set(anchor.book.id, group);
      }
    }
    for (const group of groups.values())
      group.forEach((row, index) => {
        row.sequence = index + 1;
        row.label =
          label(row.position) +
          (group.length > 1 ? `-${String(index + 1).padStart(2, "0")}` : "");
      });
  }
  const official = new Set();
  for (const row of rows.filter((item) => item.basis !== "local-insertion")) {
    const key = `${nameKey(row.prefix)}\0${row.position}`;
    check(
      !official.has(key),
      `Official number collision in ${row.prefix}: ${row.position}`,
    );
    official.add(key);
  }
  const filenames = new Set();
  for (const row of rows) {
    if (row.basis === "local-insertion")
      check(
        !official.has(`${nameKey(row.prefix)}\0${row.position}`),
        `Local/official number collision at ${row.label}; resolve the numbering evidence`,
      );
    row.filenameStem =
      `${row.prefix} (${row.label})` +
      (row.book.volumeTitle !== null ? ` ${row.book.volumeTitle}` : "");
    check(
      !/[\/\\\u0000]/u.test(row.filenameStem),
      `Filename cannot preserve a path separator for ${row.book.id}; resolve the naming constraint explicitly`,
    );
    const key = nameKey(row.filenameStem);
    check(!filenames.has(key), `Filename collision: ${row.filenameStem}`);
    filenames.add(key);
  }
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
          numericCompare(a.position, b.position) ||
          a.sequence - b.sequence,
      )
      .map((row) => row.book.id),
    books: selected.map((row) => {
      const [whole, fraction = ""] = row.position.split(".");
      return {
        id: row.book.id,
        source: row.book.source,
        originalTitle: row.book.originalTitle,
        filenameStem: row.filenameStem,
        label: row.label,
        basis: row.basis,
        anchor: row.anchor,
        sortKey: [row.prefix, whole, fraction, row.sequence],
        officialMetadata:
          row.basis === "local-insertion"
            ? null
            : {
                title: row.filenameStem,
                series: row.prefix,
                position: row.position,
              },
        firstPublished: row.book.firstPublished,
        evidence: row.book.evidence,
        official: row.book.official,
      };
    }),
    referenceOnly: rows
      .filter((row) => row.book.source === null)
      .map((row) => row.book),
  };
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    console.log(
      "naming.mjs plan --input INVENTORY.json [--output NEW_PLAN.json]\nRead-only light-novel naming proposals. Declared ebook sources are not opened or modified.",
    );
  else {
    check(
      positionals.length === 1 && positionals[0] === "plan" && values.input,
      "Use plan --input INVENTORY.json; see --help",
    );
    const input = await readInput(values.input);
    const report = {
      schemaVersion: 1,
      operation: "light-novel-naming-plan",
      status: "reviewable",
      libraryWritten: false,
      sourceVerification: "declared-only",
      inputs: { inventory: input.source },
      ...plan(input.value),
    };
    const output = JSON.stringify(report, null, 2) + "\n";
    if (values.output)
      await fs.writeFile(values.output, output, { flag: "wx" });
    process.stdout.write(output);
  }
} catch (error) {
  console.log(
    JSON.stringify({
      status: "error",
      code:
        error.code === "EEXIST"
          ? "OUTPUT_EXISTS"
          : (error.code ?? "NAMING_INPUT"),
      message: error.message,
    }),
  );
  process.exitCode = 1;
}
