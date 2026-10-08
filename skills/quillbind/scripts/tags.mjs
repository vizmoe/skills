#!/usr/bin/env node
import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  key,
  loadVocabulary,
  object,
  readInput,
  requireValue,
  strings,
} from "./tag-vocabulary.mjs";

const check = (condition, message) =>
  requireValue(condition, "INPUT_INVALID", message);
const kinds = {
  "light-novel": {
    required: "Literature.Light Novel",
    forbidden: ["Literature.Manga"],
  },
  manga: {
    required: "Literature.Manga",
    forbidden: ["Literature.Light Novel"],
  },
  "art-book": { forbidden: ["Literature.Light Novel", "Literature.Manga"] },
};

function audit(books, decisions, vocabulary) {
  check(Array.isArray(books), "Inventory must be a calibredb JSON array");
  const ids = new Set();
  for (const book of books) {
    check(
      object(book) &&
        Number.isSafeInteger(book.id) &&
        book.id > 0 &&
        !ids.has(book.id),
      "Book IDs must be unique positive integers",
    );
    check(
      typeof book.title === "string" && strings(book.tags),
      `Expected title and tags array for ID ${book.id}`,
    );
    ids.add(book.id);
  }
  check(Array.isArray(decisions), "Decisions must be an array");
  const selected = new Map();
  for (const decision of decisions) {
    check(
      object(decision) && ids.has(decision.id) && !selected.has(decision.id),
      "Decision ID must be unique and present in the inventory",
    );
    check(
      Object.keys(decision).every((name) =>
        ["id", "kind", "add", "remove", "evidence"].includes(name),
      ),
      "Unknown decision field",
    );
    check(
      strings(decision.evidence) && decision.evidence.length > 0,
      `Evidence required for ID ${decision.id}`,
    );
    check(
      decision.kind === undefined || Object.hasOwn(kinds, decision.kind),
      "Unknown work kind",
    );
    check(
      strings(decision.add ?? []) && strings(decision.remove ?? []),
      "add/remove must be tag arrays",
    );
    const rule = kinds[decision.kind];
    for (const tag of decision.add ?? []) {
      check(
        vocabulary.canonical.has(tag),
        `Added tag must match the current vocabulary: ${tag}`,
      );
      check(
        !rule?.forbidden.includes(tag),
        `Tag conflicts with declared kind: ${tag}`,
      );
    }
    for (const tag of decision.remove ?? []) {
      check(
        !(decision.add ?? []).includes(tag) && rule?.required !== tag,
        `Conflicting add/remove decision: ${tag}`,
      );
      check(
        books.find((book) => book.id === decision.id).tags.includes(tag),
        `Removal must match an original tag exactly: ${tag}`,
      );
    }
    selected.set(decision.id, decision);
  }
  return books.map((book) => {
    const decision = selected.get(book.id);
    const rule = kinds[decision?.kind];
    const proposed = [];
    const changes = [];
    const unresolved = [];
    for (const original of book.tags) {
      const tag = vocabulary.aliases.get(key(original)) ?? original;
      if (
        decision?.remove?.includes(original) ||
        rule?.forbidden.includes(tag)
      ) {
        changes.push({
          from: original,
          to: null,
          reason: "evidence-backed removal",
        });
        continue;
      }
      if (proposed.includes(tag))
        changes.push({ from: original, to: tag, reason: "duplicate" });
      else {
        proposed.push(tag);
        if (original !== tag)
          changes.push({
            from: original,
            to: tag,
            reason: "vocabulary normalization",
          });
      }
    }
    const additions = [...(decision?.add ?? [])];
    if (rule?.required) {
      if (vocabulary.canonical.has(rule.required))
        additions.push(rule.required);
      else unresolved.push({ code: "VOCABULARY_GAP", tag: rule.required });
    }
    for (const tag of additions)
      if (!proposed.includes(tag)) {
        proposed.push(tag);
        changes.push({
          from: null,
          to: tag,
          reason: "evidence-backed addition",
        });
      }
    for (const tag of proposed)
      if (!vocabulary.canonical.has(tag))
        unresolved.push({ code: "UNKNOWN_TAG", tag });
    if (
      proposed.includes("Literature.Light Novel") &&
      proposed.includes("Literature.Manga")
    )
      unresolved.push({ code: "WORK_TYPE_CONFLICT" });
    if (
      decision?.kind === "art-book" &&
      !proposed.some(
        (tag) => vocabulary.canonical.has(tag) && tag.startsWith("Arts."),
      )
    )
      unresolved.push({ code: "ART_SUBJECT_REQUIRED" });
    if (!proposed.length) unresolved.push({ code: "MISSING_TAGS" });
    return {
      id: book.id,
      title: book.title,
      before: book.tags,
      proposed,
      added: proposed.filter((tag) => !book.tags.includes(tag)),
      removed: [...new Set(book.tags.filter((tag) => !proposed.includes(tag)))],
      changes,
      unresolved,
      evidence: decision?.evidence ?? [],
    };
  });
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: "string" },
      vocabulary: { type: "string" },
      decisions: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "tags.mjs audit --input INVENTORY.json [--vocabulary CURRENT.json] [--decisions DECISIONS.json] [--output NEW.json]\nRead-only inputs; JSON proposals only. Never opens or writes a Calibre library.",
    );
  } else {
    check(
      positionals.length === 1 && positionals[0] === "audit" && values.input,
      "Use audit --input INVENTORY.json; see --help",
    );
    const vocabulary = await loadVocabulary(values.vocabulary);
    const inventory = await readInput(values.input);
    const decisions = values.decisions
      ? await readInput(values.decisions)
      : undefined;
    const books = audit(inventory.value, decisions?.value ?? [], vocabulary);
    const report = {
      schemaVersion: 1,
      operation: "tag-audit",
      status: books.some((book) => book.unresolved.length)
        ? "needs-review"
        : "reviewable",
      libraryWritten: false,
      publicationReady: false,
      inputs: {
        inventory: inventory.source,
        vocabulary: vocabulary.source,
        ...(decisions ? { decisions: decisions.source } : {}),
      },
      taxonomyVersion: vocabulary.version,
      summary: {
        books: books.length,
        changed: books.filter((book) => book.changes.length).length,
        unresolved: books.filter((book) => book.unresolved.length).length,
      },
      books,
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
          : (error.code ?? "INPUT_INVALID"),
      message: error.message,
    }),
  );
  process.exitCode = 1;
}
