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
  type Vocabulary,
} from "./tag-vocabulary.ts";
import { readWorkTypeTagRules, type WorkKindRule } from "./skill-rules.ts";

interface BookInventoryItem {
  id: number;
  title: string;
  tags: string[];
}

interface TagDecision {
  id: number;
  kind?: string;
  add?: string[];
  remove?: string[];
  evidence: string[];
}

interface TagChange {
  from: string | null;
  to: string | null;
  reason: string;
}

interface UnresolvedTagIssue {
  code: string;
  tag?: string;
}

interface AuditedBook {
  id: number;
  title: string;
  before: string[];
  proposed: string[];
  added: string[];
  removed: string[];
  changes: TagChange[];
  unresolved: UnresolvedTagIssue[];
  evidence: string[];
}

interface CodedError extends Error {
  code?: string;
}

function check(condition: unknown, message: string): asserts condition {
  requireValue(condition, "INPUT_INVALID", message);
}

function isStringArrayAllowEmpty(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && Boolean(item.trim()))
  );
}

const DECISION_FIELDS = new Set(["id", "kind", "add", "remove", "evidence"]);

function parseBookInventory(booksInput: unknown): {
  books: BookInventoryItem[];
  byId: Map<number, BookInventoryItem>;
} {
  check(
    Array.isArray(booksInput),
    "Inventory must be a JSON array of book records",
  );
  const byId = new Map<number, BookInventoryItem>();
  const books: BookInventoryItem[] = [];
  for (const book of booksInput) {
    check(
      object(book) &&
        typeof book.id === "number" &&
        Number.isSafeInteger(book.id) &&
        book.id > 0 &&
        !byId.has(book.id),
      "Book IDs must be unique positive integers",
    );
    check(
      typeof book.title === "string" && isStringArrayAllowEmpty(book.tags),
      `Expected title and tags array for ID ${book.id}`,
    );
    const record: BookInventoryItem = {
      id: book.id,
      title: book.title,
      tags: book.tags,
    };
    byId.set(record.id, record);
    books.push(record);
  }
  return { books, byId };
}

function parseDecision(
  decision: unknown,
  byId: Map<number, BookInventoryItem>,
  selected: Map<number, TagDecision>,
  vocabulary: Vocabulary,
  kinds: Record<string, WorkKindRule>,
): TagDecision {
  check(
    object(decision) &&
      typeof decision.id === "number" &&
      byId.has(decision.id) &&
      !selected.has(decision.id),
    "Decision ID must be unique and present in the inventory",
  );
  check(
    Object.keys(decision).every((name) => DECISION_FIELDS.has(name)),
    "Unknown decision field",
  );
  check(
    strings(decision.evidence) && decision.evidence.length > 0,
    `Evidence required for ID ${decision.id}`,
  );
  check(
    decision.kind === undefined ||
      (typeof decision.kind === "string" &&
        Object.hasOwn(kinds, decision.kind)),
    "Unknown work kind",
  );
  const addTags = decision.add ?? [];
  const removeTags = decision.remove ?? [];
  check(
    isStringArrayAllowEmpty(addTags) && isStringArrayAllowEmpty(removeTags),
    "add/remove must be tag arrays",
  );
  const rule =
    typeof decision.kind === "string" ? kinds[decision.kind] : undefined;
  for (const tag of addTags) {
    check(
      vocabulary.canonical.has(tag),
      `Added tag must match the current vocabulary: ${tag}`,
    );
    check(
      !rule?.forbidden.includes(tag),
      `Tag conflicts with declared kind: ${tag}`,
    );
  }
  const matchingBook = byId.get(decision.id);
  check(matchingBook !== undefined, `Book not found for ID ${decision.id}`);
  for (const tag of removeTags) {
    check(
      !addTags.includes(tag) && rule?.required !== tag,
      `Conflicting add/remove decision: ${tag}`,
    );
    check(
      matchingBook.tags.includes(tag),
      `Removal must match an original tag exactly: ${tag}`,
    );
  }
  return {
    id: decision.id,
    ...(typeof decision.kind === "string" ? { kind: decision.kind } : {}),
    add: addTags,
    remove: removeTags,
    evidence: decision.evidence,
  };
}

function parseDecisions(
  decisionsInput: unknown,
  byId: Map<number, BookInventoryItem>,
  vocabulary: Vocabulary,
  kinds: Record<string, WorkKindRule>,
): Map<number, TagDecision> {
  check(Array.isArray(decisionsInput), "Decisions must be an array");
  const selected = new Map<number, TagDecision>();
  for (const decision of decisionsInput) {
    const parsed = parseDecision(decision, byId, selected, vocabulary, kinds);
    selected.set(parsed.id, parsed);
  }
  return selected;
}

function normalizeExistingTags(
  bookTags: string[],
  decision: TagDecision | undefined,
  rule: WorkKindRule | undefined,
  vocabulary: Vocabulary,
): { proposed: string[]; changes: TagChange[] } {
  const proposed: string[] = [];
  const changes: TagChange[] = [];
  for (const original of bookTags) {
    const tag = vocabulary.aliases.get(key(original)) ?? original;
    if (decision?.remove?.includes(original) || rule?.forbidden.includes(tag)) {
      changes.push({
        from: original,
        to: null,
        reason: "evidence-backed removal",
      });
      continue;
    }
    if (proposed.includes(tag)) {
      changes.push({ from: original, to: tag, reason: "duplicate" });
      continue;
    }
    proposed.push(tag);
    if (original !== tag) {
      changes.push({
        from: original,
        to: tag,
        reason: "vocabulary normalization",
      });
    }
  }
  return { proposed, changes };
}

function applyTagAdditions(
  proposed: string[],
  changes: TagChange[],
  unresolved: UnresolvedTagIssue[],
  decision: TagDecision | undefined,
  rule: WorkKindRule | undefined,
  vocabulary: Vocabulary,
): void {
  const additions = [...(decision?.add ?? [])];
  if (rule?.required) {
    if (vocabulary.canonical.has(rule.required)) {
      additions.push(rule.required);
    } else {
      unresolved.push({ code: "VOCABULARY_GAP", tag: rule.required });
    }
  }
  for (const tag of additions) {
    if (!proposed.includes(tag)) {
      proposed.push(tag);
      changes.push({
        from: null,
        to: tag,
        reason: "evidence-backed addition",
      });
    }
  }
}

function collectUnresolvedTagIssues(
  proposed: string[],
  rule: WorkKindRule | undefined,
  vocabulary: Vocabulary,
): UnresolvedTagIssue[] {
  const unresolved: UnresolvedTagIssue[] = [];
  for (const tag of proposed) {
    if (!vocabulary.canonical.has(tag)) {
      unresolved.push({ code: "UNKNOWN_TAG", tag });
    }
  }
  if (
    proposed.includes("Literature.Light Novel") &&
    proposed.includes("Literature.Manga")
  ) {
    unresolved.push({ code: "WORK_TYPE_CONFLICT" });
  }
  if (
    rule?.requiresPrefix &&
    !proposed.some(
      (tag) =>
        vocabulary.canonical.has(tag) && tag.startsWith(rule.requiresPrefix!),
    )
  ) {
    unresolved.push({ code: "ART_SUBJECT_REQUIRED" });
  }
  if (!proposed.length) unresolved.push({ code: "MISSING_TAGS" });
  return unresolved;
}

function auditBook(
  book: BookInventoryItem,
  decision: TagDecision | undefined,
  vocabulary: Vocabulary,
  kinds: Record<string, WorkKindRule>,
): AuditedBook {
  const rule = decision?.kind ? kinds[decision.kind] : undefined;
  const { proposed, changes } = normalizeExistingTags(
    book.tags,
    decision,
    rule,
    vocabulary,
  );
  const unresolved: UnresolvedTagIssue[] = [];
  applyTagAdditions(proposed, changes, unresolved, decision, rule, vocabulary);
  unresolved.push(...collectUnresolvedTagIssues(proposed, rule, vocabulary));
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
}

function audit(
  booksInput: unknown,
  decisionsInput: unknown,
  vocabulary: Vocabulary,
  kinds: Record<string, WorkKindRule>,
): AuditedBook[] {
  const { books, byId } = parseBookInventory(booksInput);
  const selected = parseDecisions(decisionsInput, byId, vocabulary, kinds);
  return books.map((book) =>
    auditBook(book, selected.get(book.id), vocabulary, kinds),
  );
}

async function run(): Promise<void> {
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
      "tags.ts audit --input INVENTORY.json [--vocabulary CURRENT.json] [--decisions DECISIONS.json] [--output NEW.json]\nRead-only inputs; JSON proposals only. Never opens or writes a Calibre library.",
    );
    return;
  }
  check(
    positionals.length === 1 && positionals[0] === "audit" && values.input,
    "Use audit --input INVENTORY.json; see --help",
  );
  const [vocabulary, kinds] = await Promise.all([
    loadVocabulary(values.vocabulary),
    readWorkTypeTagRules(),
  ]);
  const inventory = await readInput(values.input);
  const decisions = values.decisions
    ? await readInput(values.decisions)
    : undefined;
  const books = audit(
    inventory.value,
    decisions?.value ?? [],
    vocabulary,
    kinds,
  );
  const report = {
    schemaVersion: 1,
    operation: "tag-audit",
    status: books.some((book) => book.unresolved.length > 0)
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
      changed: books.filter((book) => book.changes.length > 0).length,
      unresolved: books.filter((book) => book.unresolved.length > 0).length,
    },
    books,
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
        err.code === "EEXIST" ? "OUTPUT_EXISTS" : (err.code ?? "INPUT_INVALID"),
      message: err.message ?? String(error),
    }),
  );
  process.exitCode = 1;
}
