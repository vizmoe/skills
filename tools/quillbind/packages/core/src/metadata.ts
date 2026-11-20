import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isPublicAddress } from "./http-address.js";
export { isPublicAddress } from "./http-address.js";
import { readBookWalkerLock, type BookWalkerLock } from "./bookwalker.js";
import { catalogProviderNames, collectCatalog } from "./catalog.js";
import { catalogHosts } from "./catalog-model.js";
import type { NovelFetcher } from "./novel-http.js";
import { request } from "node:https";
import {
  openBook,
  taxonomy,
  validIsbn,
  validLanguage,
  type BookProject,
} from "./config.js";
import { json, readJson, stable } from "./json.js";
import { exists, safeRead, bookOutput } from "./files.js";
import { sha256 } from "./hash.js";
import { diagnostic, result, checkAbort, fail } from "./errors.js";
import type { Diagnostic, PublicationMetadata } from "./model.js";

export type FieldState =
  | "supplied"
  | "resolved"
  | "inferred"
  | "needs-confirmation"
  | "missing"
  | "conflict";
export interface Candidate {
  field: string;
  candidateValue: unknown;
  sourceName: string;
  sourceUrl: string;
  recordId: string;
  retrievedAt: string;
  matchEvidence: string[];
  confidence: number;
  conflicts: string[];
  approved: boolean;
}
export interface Decisions {
  isbn?: { value: string; edition: "epub"; approved: boolean };
  fields?: Record<
    string,
    { value: unknown; approved: boolean; candidateId?: string }
  >;
}
export interface MetadataLock {
  schemaVersion: 1;
  configHash: string;
  taxonomyVersion: string;
  metadata: PublicationMetadata;
  fields: Record<string, FieldState>;
  sources: Candidate[];
  bookwalkerHash?: string;
}
const bibliographyHosts = new Set<string>([
  "www.loc.gov",
  ...Object.values(catalogHosts).flat(),
]);

export async function fetchBibliography(
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !bibliographyHosts.has(parsed.hostname)
  )
    fail("SSRF_BLOCKED", "Metadata URL is outside the provider allowlist");
  const addresses = await lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    fail("SSRF_BLOCKED", "Metadata host resolves to a non-public address");
  const timeout = AbortSignal.timeout(15000);
  // Connect to the checked address while retaining TLS identity verification.
  // A second DNS lookup would permit rebinding between validation and connect.
  const address = addresses.find((a) => a.family === 4) ?? addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: address.address,
        servername: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method: "GET",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { host: parsed.hostname, accept: "application/json" },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            Object.assign(
              new Error(
                `Metadata provider returned ${response.statusCode}; redirects are disabled`,
              ),
              { code: "METADATA_HTTP" },
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            response.destroy();
            reject(
              Object.assign(new Error("Bibliography response exceeds 2 MiB"), {
                code: "METADATA_LIMIT",
              }),
            );
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
export async function resolveMetadata(
  input: string | BookProject,
  options: {
    online?: boolean;
    signal?: AbortSignal;
    fetcher?: typeof fetchBibliography;
    catalogFetcher?: NovelFetcher;
  } = {},
) {
  return (await resolveMetadataWithLock(input, options)).resolution;
}
interface ResolveMetadataOptions {
  online?: boolean;
  signal?: AbortSignal;
  fetcher?: typeof fetchBibliography;
  catalogFetcher?: NovelFetcher;
}

type BookMetadataFields = BookProject["config"]["book"];
type SubjectList = Awaited<ReturnType<typeof taxonomy>>;

const hasFieldValue = (value: string | string[]) =>
  Array.isArray(value) ? value.length > 0 : Boolean(value.trim());

function firstMarkdownHeading(source: string): string | undefined {
  for (const rawLine of source.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("#")) continue;
    const rest = line.slice(1);
    if (rest.length === 0 || (rest[0] !== " " && rest[0] !== "\t")) continue;
    const heading = rest.trimStart();
    if (heading) return heading;
  }
  return undefined;
}

function pickEntryAuthors(
  contributors: { name: string; role: string }[],
): string[] | undefined {
  const authors = contributors
    .filter((item) => item.role === "aut")
    .map((item) => item.name);
  if (authors.length) return authors;
  const all = contributors.map((item) => item.name);
  return all.length ? all : undefined;
}

async function applyBookWalkerFields(
  root: string,
  bookwalkerPath: string | undefined,
  book: BookMetadataFields,
  fields: Record<string, FieldState>,
  candidates: Candidate[],
  diagnostics: Diagnostic[],
): Promise<{ bibliography?: BookWalkerLock; bookwalkerHash?: string }> {
  if (!bookwalkerPath) return {};
  const bytes = await safeRead(root, bookwalkerPath);
  const bookwalkerHash = sha256(bytes);
  const bibliography = readBookWalkerLock(bytes.toString("utf8"));
  const selected = bibliography.records.at(-1)!;
  const offered = {
    title: bibliography.metadata.title,
    authors: bibliography.metadata.contributors
      .filter((item) => item.role === "aut")
      .map((item) => item.name),
    description: bibliography.metadata.description,
    language: bibliography.metadata.language,
  };
  for (const field of [
    "title",
    "authors",
    "description",
    "language",
  ] as const) {
    const current = book[field];
    const value = offered[field];
    const present = hasFieldValue(current);
    const conflict = present && stable(current) !== stable(value);
    if (!present) {
      if (field === "authors") book.authors = offered.authors;
      else book[field] = offered[field];
      fields[field] = "resolved";
    }
    if (conflict)
      diagnostics.push(
        diagnostic(
          "BOOKWALKER_CONFLICT",
          `Preserved supplied book.${field}; BookWalker differs`,
          bookwalkerPath,
          selected.url,
          "warning",
        ),
      );
    candidates.push({
      field,
      candidateValue: value,
      sourceName: "BookWalker",
      sourceUrl: selected.url,
      recordId: bibliography.digest,
      retrievedAt: selected.retrievedAt,
      matchEvidence: bibliography.selection.matchEvidence,
      confidence: 1,
      conflicts: conflict ? [`book.${field} differs`] : [],
      approved: !conflict,
    });
  }
  return { bibliography, bookwalkerHash };
}

function validateBookFields(
  book: BookMetadataFields,
  subjectList: SubjectList,
  decisions: Decisions,
  fields: Record<string, FieldState>,
  diagnostics: Diagnostic[],
) {
  for (const field of [
    "title",
    "authors",
    "description",
    "language",
    "tags",
  ] as const) {
    fields[field] = hasFieldValue(book[field])
      ? (fields[field] ?? "supplied")
      : "missing";
    if (fields[field] === "missing")
      diagnostics.push(
        diagnostic(
          "METADATA_MISSING",
          `Fill book.${field} in book.yaml`,
          "book.yaml",
        ),
      );
  }
  if (book.language && !validLanguage(book.language))
    diagnostics.push(
      diagnostic(
        "LANGUAGE_INVALID",
        `Invalid BCP 47 language: ${book.language}`,
        "book.yaml",
        "https://www.rfc-editor.org/rfc/rfc5646",
      ),
    );
  for (const tag of book.tags) {
    if (!subjectList.subjects.some((t) => t.id === tag && !t.deprecated))
      diagnostics.push(
        diagnostic(
          "UNKNOWN_TAG",
          `Unknown or deprecated subject: ${tag}. Use taxonomy list and the tag-management migration guidance; library labels are authoritative.`,
          "book.yaml",
        ),
      );
  }
  validateBookIsbn(book, decisions, fields, diagnostics);
}

function validateBookIsbn(
  book: BookMetadataFields,
  decisions: Decisions,
  fields: Record<string, FieldState>,
  diagnostics: Diagnostic[],
) {
  if (book.publication.isbn === null) {
    fields.isbn = "supplied";
    return;
  }
  if (!validIsbn(book.publication.isbn))
    diagnostics.push(
      diagnostic(
        "ISBN_CHECKSUM",
        "ISBN must be a valid ISBN-13",
        "book.yaml",
        "https://www.isbn-international.org/",
      ),
    );
  book.publication.isbn = book.publication.isbn.replace(/[- ]/g, "");
  const decision = decisions.isbn;
  if (
    !decision?.approved ||
    decision.value !== book.publication.isbn ||
    decision.edition !== "epub"
  ) {
    fields.isbn = "needs-confirmation";
    diagnostics.push(
      diagnostic(
        "ISBN_EDITION_CONFIRMATION",
        'Confirm metadata/decisions.json isbn {value, edition: "epub", approved: true}; print ISBN is not evidence of an EPUB ISBN',
        "metadata/decisions.json",
      ),
    );
  } else {
    fields.isbn = "resolved";
  }
}

function appendOnlineFieldCandidates(
  book: BookMetadataFields,
  candidates: Candidate[],
  query: string,
  values: Partial<Record<"title" | "authors" | "description", unknown>>,
  source: {
    sourceName: string;
    sourceUrl: string;
    recordId: string;
    retrievedAt: string;
  },
) {
  for (const [field, value] of Object.entries(values)) {
    if (!value) continue;
    const current = book[field as "title" | "authors" | "description"];
    const exact =
      stable(current).trim().toLowerCase() ===
      stable(value).trim().toLowerCase();
    candidates.push({
      field,
      candidateValue: value,
      ...source,
      matchEvidence: [
        `Query: ${query}`,
        "Discovery record; electronic edition identity is not established",
      ],
      confidence: exact ? 0.95 : 0.5,
      conflicts: exact ? [] : [`book.${field} differs`],
      approved: exact,
    });
  }
}

async function fetchLocCandidates(
  query: string,
  book: BookMetadataFields,
  fetcher: typeof fetchBibliography,
  signal: AbortSignal | undefined,
  candidates: Candidate[],
) {
  const response = (await fetcher(
    `https://www.loc.gov/books/?fo=json&c=20&q=${encodeURIComponent(query)}`,
    signal,
  )) as {
    results?: {
      id?: string;
      title?: string;
      contributor?: string[];
      language?: string[];
      description?: string[];
    }[];
  };
  for (const record of response.results ?? []) {
    appendOnlineFieldCandidates(
      book,
      candidates,
      query,
      {
        title: record.title,
        authors: record.contributor,
        description: record.description?.join(" "),
      },
      {
        sourceName: "Library of Congress digital collections",
        sourceUrl: record.id ?? "https://www.loc.gov/books/",
        recordId: record.id ?? sha256(stable(record)),
        retrievedAt: new Date().toISOString(),
      },
    );
  }
}

async function fetchCatalogCandidates(
  query: string,
  book: BookMetadataFields,
  options: ResolveMetadataOptions,
  candidates: Candidate[],
) {
  const catalogLock = await collectCatalog(
    {
      isbn: query,
      ...(book.language && validLanguage(book.language)
        ? { language: book.language }
        : {}),
      matchEvidence: [`ISBN lookup: ${query}`],
    },
    {
      online: true,
      signal: options.signal,
      fetcher: options.catalogFetcher,
    },
  );
  const retrievedByProvider = new Map(
    catalogLock.requests.map((req) => [req.provider, req.retrievedAt]),
  );
  for (const entry of catalogLock.records) {
    appendOnlineFieldCandidates(
      book,
      candidates,
      query,
      {
        title: entry.title,
        authors: pickEntryAuthors(entry.contributors),
        description: entry.description,
      },
      {
        sourceName: catalogProviderNames[entry.provider],
        sourceUrl: entry.recordUrl,
        recordId: entry.recordId,
        retrievedAt:
          retrievedByProvider.get(entry.provider) ?? new Date().toISOString(),
      },
    );
  }
}

async function collectOnlineCandidates(
  book: BookMetadataFields,
  options: ResolveMetadataOptions,
  candidates: Candidate[],
  diagnostics: Diagnostic[],
) {
  if (
    !options.online ||
    book.publication.isbn === null ||
    !validIsbn(book.publication.isbn)
  )
    return;
  const query = book.publication.isbn;
  const beforeOnline = candidates.length;
  try {
    if (options.fetcher)
      await fetchLocCandidates(
        query,
        book,
        options.fetcher,
        options.signal,
        candidates,
      );
    else await fetchCatalogCandidates(query, book, options, candidates);
    if (candidates.length === beforeOnline)
      diagnostics.push(
        diagnostic(
          "METADATA_NO_MATCH",
          "No matching catalog record found across the selected online providers",
          undefined,
          undefined,
          "warning",
        ),
      );
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "METADATA_NETWORK",
        String(error),
        undefined,
        undefined,
        "warning",
      ),
    );
  }
}

async function inferContentCandidates(
  root: string,
  firstChapter: string,
  book: BookMetadataFields,
  subjectList: SubjectList,
  candidates: Candidate[],
) {
  if (book.tags.length && book.title) return;
  const source = (await safeRead(root, firstChapter)).toString("utf8");
  const heading = firstMarkdownHeading(source);
  const inferredTag =
    subjectList.subjects.some(
      (tag) => tag.id === "Science.Software Engineering",
    ) &&
    /\b(code|typescript|software|api|programming)\b/i.test(
      [book.title, book.description, source].join(" "),
    )
      ? "Science.Software Engineering"
      : undefined;
  for (const [field, value] of [
    ["title", !book.title ? heading : undefined],
    ["tags", !book.tags.length && inferredTag ? [inferredTag] : undefined],
  ] as const) {
    if (!value) continue;
    candidates.push({
      field,
      candidateValue: value,
      sourceName: "Content inference",
      sourceUrl: firstChapter,
      recordId: sha256(source),
      retrievedAt: new Date().toISOString(),
      matchEvidence: ["First chapter and supplied metadata"],
      confidence: 0.6,
      conflicts: [],
      approved: false,
    });
  }
}

async function ensurePersistentUuid(directory: string) {
  const identityFile = path.join(directory, "identity.json");
  if (await exists(identityFile)) {
    const uuid = (await readJson<{ uuid: string }>(identityFile)).uuid;
    if (
      !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        uuid,
      )
    )
      fail("IDENTIFIER_INVALID", "Invalid persistent UUID");
    return uuid;
  }
  const uuid = `urn:uuid:${randomUUID()}`;
  await fs.writeFile(identityFile, stable({ uuid }), { flag: "wx" });
  return uuid;
}

async function persistMetadataLock(
  directory: string,
  lock: MetadataLock,
  diagnostics: Diagnostic[],
  online: boolean | undefined,
) {
  if (diagnostics.some((d) => d.severity === "error")) return;
  const lockFile = path.join(directory, "sources.lock.json");
  if (!online && (await exists(lockFile))) {
    const previous = await readJson<MetadataLock>(lockFile);
    if (
      previous.configHash === lock.configHash &&
      previous.bookwalkerHash === lock.bookwalkerHash
    )
      lock.sources = previous.sources;
  }
  await json(lockFile, lock);
}

export async function resolveMetadataWithLock(
  input: string | BookProject,
  options: ResolveMetadataOptions = {},
) {
  const project = typeof input === "string" ? await openBook(input) : input;
  const { root, config } = project;
  checkAbort(options.signal);
  if (
    options.online &&
    process.env.CI &&
    !options.fetcher &&
    !options.catalogFetcher
  )
    fail("CI_NETWORK_DISABLED", "CI metadata resolution is offline");
  const directory = await bookOutput(root, "metadata");
  const decisionsFile = path.join(directory, "decisions.json");
  if (!(await exists(decisionsFile))) await json(decisionsFile, { fields: {} });
  const decisions = await readJson<Decisions>(decisionsFile);
  const diagnostics: Diagnostic[] = [];
  const fields: Record<string, FieldState> = {};
  const candidates: Candidate[] = [];
  const subjectList = await taxonomy();
  const book = structuredClone(config.book);
  const { bibliography, bookwalkerHash } = await applyBookWalkerFields(
    root,
    config.bookwalker,
    book,
    fields,
    candidates,
    diagnostics,
  );
  validateBookFields(book, subjectList, decisions, fields, diagnostics);
  await collectOnlineCandidates(book, options, candidates, diagnostics);
  await inferContentCandidates(
    root,
    config.chapters[0],
    book,
    subjectList,
    candidates,
  );
  await json(path.join(directory, "candidates.json"), {
    schemaVersion: 1,
    candidates,
  });
  const uuid = await ensurePersistentUuid(directory);
  const metadata: PublicationMetadata = {
    title: book.title.normalize("NFC").trim(),
    authors: book.authors.map((name) => ({ name: name.normalize("NFC") })),
    description: book.description.normalize("NFC").trim(),
    language: book.language,
    identifier:
      book.publication.isbn !== null
        ? { scheme: "isbn", value: `urn:isbn:${book.publication.isbn}` }
        : { scheme: "uuid", value: uuid },
    tags: book.tags.map((id) => ({
      id,
      label: subjectList.subjects.find((t) => t.id === id)?.label ?? id,
    })),
    publication: book.publication,
    modified: new Date(config.build.epoch * 1000)
      .toISOString()
      .replace(".000Z", "Z"),
    ...(bibliography ? { bibliography: bibliography.metadata } : {}),
  };
  const lock: MetadataLock = {
    schemaVersion: 1,
    configHash: sha256(project.configText + stable(decisions)),
    taxonomyVersion: subjectList.version,
    metadata,
    fields,
    sources: candidates.filter((c) => c.approved),
    ...(bookwalkerHash ? { bookwalkerHash } : {}),
  };
  await persistMetadataLock(directory, lock, diagnostics, options.online);
  return {
    resolution: { ...result(diagnostics), metadata, fields, candidates },
    lock,
  };
}
export async function lockedMetadata(
  project: BookProject,
): Promise<MetadataLock> {
  const file = path.join(project.root, "metadata/sources.lock.json");
  if (!(await exists(file)))
    fail("METADATA_UNRESOLVED", "Run quillbind metadata resolve before build");
  const lock = await readJson<MetadataLock>(file);
  const decisions = await readJson<Decisions>(
    path.join(project.root, "metadata/decisions.json"),
  );
  if (
    lock.configHash !== sha256(project.configText + stable(decisions)) ||
    lock.bookwalkerHash !==
      (project.config.bookwalker
        ? sha256(await safeRead(project.root, project.config.bookwalker))
        : undefined) ||
    lock.taxonomyVersion !== (await taxonomy()).version
  )
    fail(
      "METADATA_LOCK_STALE",
      "Metadata inputs changed; run metadata resolve again",
    );
  return lock;
}
