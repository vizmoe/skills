import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { checkAbort, fail } from "./errors.js";
import { readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stable } from "./json.js";
import { fetchNovel, type NovelFetcher } from "./novel-http.js";
import {
  cleanDescription,
  cleanText,
  cleanTitle,
  comparable,
  findIsbns,
  normalizeDate,
  normalizeIsbn,
  normalizeLanguage,
  parseContributors,
  seriesPosition,
  type Contributor,
} from "./bibliography-normalize.js";
import { extractEdition } from "./edition-parse.js";
import {
  editionAddress,
  editionRecordSchema,
  editionSelectionSchema,
  editionSources,
  type EditionCandidate,
  type EditionDiagnostic,
  type EditionLock,
  type EditionMetadata,
  type EditionRecord,
  type EditionSelection,
} from "./edition-model.js";

export type {
  EditionLock,
  EditionMetadata,
  EditionSelection,
} from "./edition-model.js";
export { extractEdition } from "./edition-parse.js";

export interface EditionOptions {
  online?: boolean;
  /** A page the caller saved from the selected URL, parsed instead of fetching. */
  page?: string;
  signal?: AbortSignal;
  fetcher?: NovelFetcher;
  now?: () => Date;
}

const rank = (source: EditionCandidate["source"]) =>
  editionSources.indexOf(source);
const maxBytes = 4 * 1024 * 1024;

function selectionFrom(value: unknown): EditionSelection {
  const parsed = editionSelectionSchema.safeParse(value);
  if (!parsed.success)
    fail(
      "EDITION_SELECTION",
      "Supply the edition page url, matchEvidence and an optional expected isbn",
      parsed.error.issues,
    );
  const selection = parsed.data;
  selection.url = editionAddress(selection.url).href;
  if (selection.isbn) selection.isbn = normalizeIsbn(selection.isbn)!;
  return selection;
}

/** Decode with the declared charset: HTTP header, BOM, then `<meta>`; UTF-8 otherwise. */
export function decodePage(bytes: Buffer, contentType = "") {
  const declared =
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ??
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? "utf-8"
      : undefined) ??
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(
      bytes.subarray(0, 4096).toString("latin1"),
    )?.[1] ??
    "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(declared.toLowerCase(), { fatal: false });
  } catch {
    fail("EDITION_CHARSET", `Unsupported page charset: ${declared}`);
  }
  return { html: decoder.decode(bytes), charset: decoder.encoding };
}

async function fetchPage(url: string, options: EditionOptions) {
  if (process.env.CI && !options.fetcher)
    fail(
      "CI_NETWORK_DISABLED",
      "Live edition page requests are disabled in CI",
    );
  let current = editionAddress(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    checkAbort(options.signal);
    const response = await (options.fetcher ?? fetchNovel)({
      url: current.href,
      method: "GET",
      signal: options.signal,
      timeout: 20000,
      maxBytes,
      headers: {
        "user-agent": "Quillbind/0.1 (public book metadata)",
        accept: "text/html,application/xhtml+xml",
        "accept-encoding": "gzip, deflate, br",
      },
    });
    checkAbort(options.signal);
    if (response.bytes.length > maxBytes)
      fail("EDITION_LIMIT", "Edition page exceeds 4 MiB");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location)
        fail("EDITION_REDIRECT", "Missing redirect location");
      current = editionAddress(
        new URL(response.headers.location, current).href,
      );
      continue;
    }
    if (response.status !== 200)
      fail(
        "EDITION_HTTP",
        `Edition page returned ${response.status}; save the page from a browser and use --page if access requires it`,
      );
    const type = response.headers["content-type"] ?? "";
    if (type && !/html|xml/i.test(type))
      fail("EDITION_CONTENT_TYPE", `Expected an HTML page, received ${type}`);
    return { bytes: response.bytes, contentType: type, finalUrl: current.href };
  }
  fail("EDITION_REDIRECT", "Too many edition page redirects");
}

const conflict = (
  diagnostics: EditionDiagnostic[],
  field: string,
  values: string[],
) => {
  const distinct = [...new Map(values.map((v) => [comparable(v), v])).values()];
  if (distinct.length > 1)
    diagnostics.push({
      code: "EDITION_CONFLICT",
      severity: "warning",
      field,
      message: `Sources disagree on ${field}; the highest-priority value was adopted`,
      values: distinct,
    });
};

/** Clean and merge candidates by source priority; the result is evidence for review, not a write. */
export function deriveEdition(
  selection: EditionSelection,
  record: EditionRecord,
): { metadata: EditionMetadata; diagnostics: EditionDiagnostic[] } {
  const diagnostics: EditionDiagnostic[] = [];
  const provenance: Record<string, string> = {};
  const ordered = [...record.candidates].sort(
    (a, b) => rank(a.source) - rank(b.source),
  );
  const of = (field: EditionCandidate["field"]) =>
    ordered.filter((item) => item.field === field);
  const pick = (
    field: EditionCandidate["field"],
    clean: (value: string) => string | undefined,
  ) => {
    const values = of(field)
      .map((item) => ({ item, value: clean(item.value) }))
      .filter((entry): entry is { item: EditionCandidate; value: string } =>
        Boolean(entry.value),
      );
    if (!values.length) return undefined;
    conflict(
      diagnostics,
      field,
      values.map((entry) => entry.value),
    );
    provenance[field] = values[0].item.source;
    return values[0].value;
  };
  const host = new URL(record.finalUrl).hostname.replace(/^www\./, "");
  const publishers = of("publisher").map((item) => cleanText(item.value));
  const suffixes = [
    record.siteName ?? "",
    ...publishers,
    host,
    host.split(".")[0],
  ];
  const removedTitle: string[] = [];
  const title = pick("title", (value) => {
    const cleaned = cleanTitle(value, { suffixes });
    removedTitle.push(...cleaned.removed);
    return cleaned.value || undefined;
  });
  if (!title)
    fail("EDITION_PARSE", "No book title found on the selected edition page");
  if (removedTitle.length)
    diagnostics.push({
      code: "EDITION_CLEANED",
      severity: "warning",
      field: "title",
      message: "Removed storefront or marketing text from title candidates",
      values: [...new Set(removedTitle)],
    });

  const contributors: Contributor[] = [];
  const removedPeople: string[] = [];
  const roles = new Map<string, EditionCandidate["source"]>();
  for (const item of of("contributor")) {
    const parsed = parseContributors(item.value, item.role ?? "aut");
    removedPeople.push(...parsed.removed);
    for (const person of parsed.contributors) {
      const source = roles.get(person.role);
      if (source !== undefined && source !== item.source) continue;
      roles.set(person.role, item.source);
      if (
        !contributors.some(
          (entry) => entry.name === person.name && entry.role === person.role,
        )
      )
        contributors.push(person);
    }
  }
  for (const [role, source] of roles)
    provenance[`contributor:${role}`] = source;
  if (removedPeople.length)
    diagnostics.push({
      code: "EDITION_CLEANED",
      severity: "warning",
      field: "contributor",
      message: "Removed prefixes, et al. markers or placeholders from credits",
      values: [...new Set(removedPeople)],
    });

  const dates = of("date")
    .map((item) => ({ item, value: normalizeDate(item.value) }))
    .filter((entry): entry is { item: EditionCandidate; value: string } =>
      Boolean(entry.value),
    );
  for (const item of of("date"))
    if (!normalizeDate(item.value))
      diagnostics.push({
        code: "EDITION_DATE_INVALID",
        severity: "warning",
        field: "date",
        message: "Ignored an unrecognized or impossible publication date",
        values: [item.value],
      });
  let date = dates[0];
  for (const entry of dates.slice(1))
    if (
      date &&
      entry.value.length > date.value.length &&
      entry.value.startsWith(date.value)
    )
      date = entry;
  if (date) {
    provenance.date = date.item.source;
    const incompatible = dates.filter(
      (entry) =>
        !date.value.startsWith(entry.value) &&
        !entry.value.startsWith(date.value),
    );
    if (incompatible.length)
      diagnostics.push({
        code: "EDITION_CONFLICT",
        severity: "warning",
        field: "date",
        message:
          "Sources disagree on date; the highest-priority value was adopted",
        values: [date.value, ...new Set(incompatible.map((e) => e.value))],
      });
  }

  const print: string[] = [];
  const electronic: string[] = [];
  const invalid: string[] = [];
  for (const item of of("isbn")) {
    const found = findIsbns(item.value);
    invalid.push(...found.invalid);
    for (const isbn of found.valid)
      (item.format === "electronic" ? electronic : print).push(isbn);
  }
  const electronicSet = new Set(electronic);
  const printSet = new Set(print.filter((isbn) => !electronicSet.has(isbn)));
  if (invalid.length)
    diagnostics.push({
      code: "EDITION_ISBN_INVALID",
      severity: "warning",
      field: "isbn",
      message:
        "Ignored ISBN-like values that fail syntax or checksum validation",
      values: [...new Set(invalid)],
    });
  if (
    selection.isbn &&
    !printSet.has(selection.isbn) &&
    !electronicSet.has(selection.isbn)
  )
    fail(
      "EDITION_MATCH",
      "The selected page does not list the expected ISBN; select the matching edition page",
      { expected: selection.isbn, found: [...printSet, ...electronicSet] },
    );
  const choose = (set: Set<string>, field: string) => {
    if (selection.isbn && set.has(selection.isbn)) return selection.isbn;
    if (set.size === 1) return [...set][0];
    if (set.size > 1)
      diagnostics.push({
        code: "EDITION_ISBN_AMBIGUOUS",
        severity: "warning",
        field,
        message:
          "Several ISBNs appear on the page; none was adopted without an expected ISBN",
        values: [...set],
      });
    return undefined;
  };
  const printIsbn = choose(printSet, "printIsbn");
  const electronicIsbn = choose(electronicSet, "electronicIsbn");
  for (const [key, isbn] of [
    ["printIsbn", printIsbn],
    ["electronicIsbn", electronicIsbn],
  ] as const)
    if (isbn)
      provenance[key] = of("isbn").find((item) =>
        findIsbns(item.value).valid.includes(isbn),
      )!.source;

  const removedDescription: string[] = [];
  const descriptions = of("description")
    .map((item) => {
      const cleaned = cleanDescription(item.value);
      removedDescription.push(...cleaned.removed);
      return { item, value: cleaned.value };
    })
    .filter((entry) => entry.value);
  const truncated = (entry: (typeof descriptions)[number]) =>
    ["meta", "open-graph"].includes(entry.item.source) &&
    /(?:\.\.\.|…)$/u.test(entry.value) &&
    !/……$/u.test(entry.value);
  const complete = descriptions.filter((entry) => !truncated(entry));
  const description = complete[0];
  if (description) provenance.description = description.item.source;
  else if (descriptions.length)
    diagnostics.push({
      code: "EDITION_DESCRIPTION_TRUNCATED",
      severity: "warning",
      field: "description",
      message:
        "Only truncated meta descriptions were found; no synopsis was adopted",
    });
  if (removedDescription.length)
    diagnostics.push({
      code: "EDITION_CLEANED",
      severity: "warning",
      field: "description",
      message:
        "Removed reader interface text, section labels or watermarks from the synopsis",
      values: [...new Set(removedDescription)],
    });

  const line = (pattern?: RegExp) => (value: string) =>
    cleanText(value, pattern) || undefined;
  const metadata: EditionMetadata = {
    url: record.finalUrl,
    title,
    contributors,
    provenance,
  };
  const optional = {
    subtitle: pick("subtitle", line()),
    originalTitle: pick("originalTitle", line()),
    publisher: pick("publisher", line(/^(?:出版社|publisher)\s*[:：]\s*/i)),
    imprint: pick("imprint", line()),
    date: date?.value,
    printIsbn,
    electronicIsbn,
    series: pick(
      "series",
      (value) => cleanTitle(value, { suffixes: [] }).value || undefined,
    ),
    position: pick("position", seriesPosition),
    language: pick("language", normalizeLanguage),
    description: description?.value,
  };
  for (const [key, value] of Object.entries(optional))
    if (value !== undefined) Object.assign(metadata, { [key]: value });
  return { metadata, diagnostics };
}

function lockFrom(selection: EditionSelection, record: EditionRecord) {
  const { metadata, diagnostics } = deriveEdition(selection, record);
  const content = {
    schemaVersion: 1 as const,
    selection,
    record,
    metadata,
    diagnostics,
  };
  return { ...content, digest: sha256(stable(content)) } as EditionLock;
}

export async function collectEdition(
  input: unknown,
  options: EditionOptions = {},
): Promise<EditionLock> {
  const selection = selectionFrom(input);
  let page;
  if (options.page) {
    const bytes = await readSourceFile(options.page);
    if (bytes.length > maxBytes)
      fail("EDITION_LIMIT", "Saved edition page exceeds 4 MiB");
    page = { bytes, contentType: "", finalUrl: selection.url };
  } else if (options.online) page = await fetchPage(selection.url, options);
  else
    fail(
      "EDITION_OFFLINE",
      "Use a saved edition lock, --page with a saved copy, or explicitly request --online",
    );
  const { html, charset } = decodePage(page.bytes, page.contentType);
  const extracted = extractEdition(html);
  const record: EditionRecord = {
    url: selection.url,
    finalUrl: page.finalUrl,
    ...(extracted.canonicalUrl &&
    URL.canParse(extracted.canonicalUrl, page.finalUrl)
      ? {
          canonicalUrl: new URL(extracted.canonicalUrl, page.finalUrl).href,
        }
      : {}),
    retrieval: options.page ? "saved-page" : "online",
    retrievedAt: (options.now?.() ?? new Date()).toISOString(),
    sha256: sha256(page.bytes),
    charset,
    ...(extracted.siteName ? { siteName: extracted.siteName } : {}),
    candidates: extracted.candidates,
  };
  return lockFrom(selection, record);
}

export function readEditionLock(source: string): EditionLock {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail("EDITION_LOCK", "Invalid edition JSON lock");
  }
  const parsed = z
    .strictObject({
      schemaVersion: z.literal(1),
      selection: editionSelectionSchema,
      record: editionRecordSchema,
      metadata: z.unknown(),
      diagnostics: z.unknown(),
      digest: z.string(),
    })
    .safeParse(value);
  if (!parsed.success)
    fail("EDITION_LOCK", "Invalid edition lock structure", parsed.error.issues);
  const { digest, ...content } = parsed.data;
  const selection = selectionFrom(content.selection);
  const derived = deriveEdition(selection, content.record);
  if (
    digest !== sha256(stable(content)) ||
    stable(selection) !== stable(content.selection) ||
    stable(content.metadata) !== stable(derived.metadata) ||
    stable(content.diagnostics) !== stable(derived.diagnostics)
  )
    fail(
      "EDITION_LOCK",
      "Edition lock content or derived metadata changed; collect the edition page again",
    );
  return { ...content, ...derived, selection, digest } as EditionLock;
}

export async function resolveEdition(
  file: string,
  options: EditionOptions & { output: string },
) {
  if (options.online && options.page)
    fail("ARGUMENT_CONFLICT", "Choose --online or --page, not both");
  const selection = selectionFrom(
    JSON.parse((await readSourceFile(file)).toString()),
  );
  const output = path.resolve(options.output);
  const result = (lock: EditionLock, mode: string) => ({
    status: "pass" as const,
    operation: "edition-metadata",
    metadata: lock.metadata,
    diagnostics: lock.diagnostics,
    lock: output,
    digest: lock.digest,
    mode,
  });
  if (!options.online && !options.page) {
    const lock = readEditionLock((await readSourceFile(output)).toString());
    if (stable(lock.selection) !== stable(selection))
      fail(
        "EDITION_LOCK_STALE",
        "Selection changed; create a new edition lock",
      );
    return result(lock, "offline");
  }
  const lock = await collectEdition(selection, options);
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
          "Edition locks are immutable; select a new output path for a refreshed lock",
        );
      throw error;
    });
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return result(lock, options.page ? "saved-page" : "online");
}
