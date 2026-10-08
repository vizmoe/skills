import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { checkAbort, fail } from "./errors.js";
import { readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stable } from "./json.js";
import { fetchBookWalker, type BookWalkerOptions } from "./bookwalker-http.js";
import { parseBookWalker } from "./bookwalker-parse.js";
import {
  bookWalkerAddress,
  bookWalkerDate,
  bookWalkerSelectionSchema,
  recordSchema,
  type BookWalkerLock,
  type BookWalkerMetadata,
  type BookWalkerSelection,
} from "./bookwalker-model.js";

export { parseBookWalker } from "./bookwalker-parse.js";
export type {
  BookWalkerLock,
  BookWalkerMetadata,
  BookWalkerSelection,
} from "./bookwalker-model.js";

function selectionFrom(value: unknown): BookWalkerSelection {
  const parsed = bookWalkerSelectionSchema.safeParse(value);
  if (!parsed.success)
    fail(
      "BOOKWALKER_SELECTION",
      "Supply kind, language, edition URLs, number (or null), and matching evidence",
      parsed.error.issues,
    );
  const selection = parsed.data;
  if (bookWalkerAddress(selection.japaneseUrl).site !== "jp")
    fail(
      "BOOKWALKER_SELECTION",
      "japaneseUrl must identify the Japanese original",
    );
  selection.japaneseUrl = bookWalkerAddress(selection.japaneseUrl).url;
  if (selection.language === "ja" && selection.translatedUrl)
    fail(
      "BOOKWALKER_SELECTION",
      "Japanese editions use the Japanese record only",
    );
  if (selection.language !== "ja" && !selection.translatedUrl)
    fail(
      "BOOKWALKER_SELECTION",
      "Chinese editions require the Taiwan product URL",
    );
  if (selection.translatedUrl) {
    if (bookWalkerAddress(selection.translatedUrl).site !== "tw")
      fail(
        "BOOKWALKER_SELECTION",
        "translatedUrl must identify the Taiwan edition",
      );
    selection.translatedUrl = bookWalkerAddress(selection.translatedUrl).url;
  }
  if (selection.number !== null)
    selection.number = String(Number(selection.number));
  return selection;
}

function combine(
  selection: BookWalkerSelection,
  records: BookWalkerLock["records"],
): BookWalkerMetadata {
  const urls = [
    selection.japaneseUrl,
    ...(selection.translatedUrl ? [selection.translatedUrl] : []),
  ];
  if (records.length !== urls.length)
    fail(
      "BOOKWALKER_LOCK",
      "Edition record count does not match the selection",
    );
  for (const [index, record] of records.entries()) {
    const address = bookWalkerAddress(record.url),
      edition = record.edition;
    if (
      record.url !== urls[index] ||
      edition.url !== record.url ||
      edition.site !== address.site
    )
      fail(
        "BOOKWALKER_IDENTITY",
        "Edition record identity differs from its selected source",
      );
    if (edition.kind !== selection.kind || edition.number !== selection.number)
      fail(
        "BOOKWALKER_MATCH",
        "Selected editions must have the requested work type and volume number",
      );
    bookWalkerDate(edition.printDate);
    bookWalkerDate(edition.electronicDate);
  }
  const original = records[0].edition;
  const edition = records.at(-1)!.edition;
  const releaseDate = original.printDate ?? original.electronicDate;
  if (!releaseDate)
    fail(
      "BOOKWALKER_DATE",
      "The Japanese original has no confirmed publication date; a translated release date cannot substitute",
    );
  return {
    ...edition,
    language: selection.language,
    originalTitle: original.title,
    releaseDate,
    dateBasis: original.printDate ? "japanese-print" : "japanese-electronic",
    sourceUrls: urls,
  };
}

export async function collectBookWalker(
  input: unknown,
  options: BookWalkerOptions = {},
): Promise<BookWalkerLock> {
  const selection = selectionFrom(input);
  const records: BookWalkerLock["records"] = [];
  for (const url of [
    selection.japaneseUrl,
    ...(selection.translatedUrl ? [selection.translatedUrl] : []),
  ]) {
    const bytes = await fetchBookWalker(url, options);
    records.push({
      url,
      sha256: sha256(bytes),
      retrievedAt: new Date().toISOString(),
      edition: parseBookWalker(bytes.toString("utf8"), url),
    });
  }
  const content = {
    schemaVersion: 1 as const,
    selection,
    records,
    metadata: combine(selection, records),
  };
  return { ...content, digest: sha256(stable(content)) };
}

export function readBookWalkerLock(source: string): BookWalkerLock {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail("BOOKWALKER_LOCK", "Invalid BookWalker JSON lock");
  }
  const parsed = z
    .strictObject({
      schemaVersion: z.literal(1),
      selection: bookWalkerSelectionSchema,
      records: z.array(recordSchema).min(1).max(2),
      metadata: z.unknown(),
      digest: z.string(),
    })
    .safeParse(value);
  if (!parsed.success)
    fail(
      "BOOKWALKER_LOCK",
      "Invalid BookWalker lock structure",
      parsed.error.issues,
    );
  const { digest, ...content } = parsed.data;
  const selection = selectionFrom(content.selection);
  const metadata = combine(selection, content.records);
  if (
    digest !== sha256(stable(content)) ||
    stable(content.metadata) !== stable(metadata) ||
    stable(selection) !== stable(content.selection)
  )
    fail(
      "BOOKWALKER_LOCK",
      "BookWalker lock content or derived metadata changed; resolve the selected editions again",
    );
  return { ...content, selection, metadata, digest };
}

export async function resolveBookWalker(
  file: string,
  options: BookWalkerOptions & { output: string },
) {
  const selection = selectionFrom(
    JSON.parse((await readSourceFile(file)).toString()),
  );
  const output = path.resolve(options.output);
  if (!options.online) {
    const lock = readBookWalkerLock((await readSourceFile(output)).toString());
    if (stable(lock.selection) !== stable(selection))
      fail(
        "BOOKWALKER_LOCK_STALE",
        "Selection changed; create a new online source lock",
      );
    return {
      status: "pass" as const,
      operation: "bookwalker-metadata",
      metadata: lock.metadata,
      lock: output,
      digest: lock.digest,
      mode: "offline",
    };
  }
  const lock = await collectBookWalker(selection, options);
  checkAbort(options.signal);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, stable(lock) + "\n", { flag: "wx" });
    checkAbort(options.signal);
    await fs.link(temporary, output).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        fail(
          "OUTPUT_EXISTS",
          "Source locks are immutable; select a new output path for a refreshed lock",
        );
      throw error;
    });
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return {
    status: "pass" as const,
    operation: "bookwalker-metadata",
    metadata: lock.metadata,
    lock: output,
    digest: lock.digest,
    mode: "online",
  };
}
