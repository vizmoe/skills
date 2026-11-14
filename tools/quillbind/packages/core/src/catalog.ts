import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  comparable,
  normalizeIsbn,
  normalizeLanguage,
  type Contributor,
} from "./bibliography-normalize.js";
import {
  catalogAddress,
  catalogEntrySchema,
  catalogProviders,
  catalogQuerySchema,
  catalogRequestSchema,
  redactCatalogUrl,
  selectCatalogProviders,
  type CatalogDiagnostic,
  type CatalogEntry,
  type CatalogLock,
  type CatalogMetadata,
  type CatalogProvider,
  type CatalogQuery,
  type CatalogRequestRecord,
} from "./catalog-model.js";
import {
  parseCiniiJson,
  parseGoogleBooks,
  parseLocSruMods,
  parseNdlOpenSearch,
  parseOpenBd,
  parseOpenLibraryBooks,
  parseOpenLibrarySearch,
} from "./catalog-parse.js";
import { checkAbort, fail } from "./errors.js";
import { readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stable } from "./json.js";
import { fetchNovel, type NovelFetcher } from "./novel-http.js";

export {
  catalogAddress,
  catalogProviderNames,
  catalogProviders,
  redactCatalogUrl,
  selectCatalogProviders,
  type CatalogDiagnostic,
  type CatalogEntry,
  type CatalogLock,
  type CatalogMetadata,
  type CatalogProvider,
  type CatalogQuery,
} from "./catalog-model.js";
export {
  cleanCatalogPerson,
  parseCiniiJson,
  parseGoogleBooks,
  parseLocSruMods,
  parseNdlOpenSearch,
  parseOpenBd,
  parseOpenLibraryBooks,
  parseOpenLibrarySearch,
} from "./catalog-parse.js";

export interface CatalogOptions {
  online?: boolean;
  signal?: AbortSignal;
  fetcher?: NovelFetcher;
  now?: () => Date;
  googleBooksApiKey?: string;
}

const maxBytes = 2 * 1024 * 1024;

function queryFrom(value: unknown): CatalogQuery {
  const parsed = catalogQuerySchema.safeParse(value);
  if (!parsed.success)
    fail(
      "CATALOG_QUERY",
      "Supply isbn and/or title, matchEvidence, and optional author, publisher, language or providers",
      parsed.error.issues,
    );
  const query = { ...parsed.data };
  if (query.isbn) query.isbn = normalizeIsbn(query.isbn)!;
  if (query.language) query.language = normalizeLanguage(query.language)!;
  return query;
}

async function requestCatalog(
  provider: CatalogProvider,
  rawUrl: string,
  accept: string,
  options: CatalogOptions,
  requests: CatalogRequestRecord[],
) {
  let current = catalogAddress(provider, rawUrl);
  for (let redirects = 0; redirects <= 3; redirects++) {
    checkAbort(options.signal);
    const response = await (options.fetcher ?? fetchNovel)({
      url: current.href,
      method: "GET",
      signal: options.signal,
      timeout: 15000,
      maxBytes,
      headers: {
        "user-agent": "Quillbind/0.1 (public book metadata)",
        accept,
        "accept-encoding": "gzip, deflate, br",
      },
    });
    checkAbort(options.signal);
    if (response.bytes.length > maxBytes)
      fail("CATALOG_LIMIT", `Catalog response from ${provider} exceeds 2 MiB`);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location)
        fail("CATALOG_REDIRECT", `Missing redirect location from ${provider}`);
      current = catalogAddress(
        provider,
        new URL(response.headers.location, current).href,
      );
      continue;
    }
    requests.push({
      provider,
      url: redactCatalogUrl(current.href),
      retrievedAt: (options.now?.() ?? new Date()).toISOString(),
      status: response.status,
      sha256: sha256(response.bytes),
    });
    return response;
  }
  fail("CATALOG_REDIRECT", `Too many redirects from ${provider}`);
}

const parseJsonBody = (provider: CatalogProvider, bytes: Buffer): unknown => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("CATALOG_PARSE", `Invalid JSON response from ${provider}`);
  }
};

const cqlQuote = (value: string) =>
  `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;

async function queryProvider(
  provider: CatalogProvider,
  query: CatalogQuery,
  options: CatalogOptions,
  requests: CatalogRequestRecord[],
): Promise<CatalogEntry[]> {
  if (provider === "openbd") {
    if (!query.isbn) return [];
    const url = new URL("https://api.openbd.jp/v1/get");
    url.searchParams.set("isbn", query.isbn);
    const res = await requestCatalog(
      provider,
      url.href,
      "application/json",
      options,
      requests,
    );
    if (res.status !== 200)
      fail("CATALOG_HTTP", `openBD returned HTTP ${res.status}`);
    return parseOpenBd(parseJsonBody(provider, res.bytes));
  }

  if (provider === "ndl") {
    const url = new URL("https://ndlsearch.ndl.go.jp/api/opensearch");
    if (query.isbn) url.searchParams.set("isbn", query.isbn);
    else {
      if (query.title) url.searchParams.set("title", query.title);
      if (query.author) url.searchParams.set("creator", query.author);
      if (query.publisher) url.searchParams.set("publisher", query.publisher);
      url.searchParams.set("mediatype", "books");
    }
    url.searchParams.set("cnt", "10");
    const res = await requestCatalog(
      provider,
      url.href,
      "application/xml,text/xml",
      options,
      requests,
    );
    if (res.status !== 200)
      fail("CATALOG_HTTP", `NDL Search returned HTTP ${res.status}`);
    return parseNdlOpenSearch(res.bytes.toString("utf8"));
  }

  if (provider === "cinii") {
    const url = new URL("https://ci.nii.ac.jp/books/opensearch/search");
    if (query.isbn) url.searchParams.set("isbn", query.isbn);
    else {
      if (query.title) url.searchParams.set("title", query.title);
      if (query.author) url.searchParams.set("author", query.author);
      if (query.publisher) url.searchParams.set("publisher", query.publisher);
    }
    url.searchParams.set("format", "json");
    url.searchParams.set("count", "10");
    const res = await requestCatalog(
      provider,
      url.href,
      "application/json",
      options,
      requests,
    );
    if (res.status !== 200)
      fail("CATALOG_HTTP", `CiNii Books returned HTTP ${res.status}`);
    return parseCiniiJson(parseJsonBody(provider, res.bytes));
  }

  if (provider === "loc") {
    const url = new URL("https://lx2.loc.gov/sru/lcdb");
    url.searchParams.set("version", "1.1");
    url.searchParams.set("operation", "searchRetrieve");
    url.searchParams.set("recordSchema", "mods");
    url.searchParams.set("maximumRecords", query.isbn ? "5" : "10");
    const clauses: string[] = [];
    if (query.isbn) clauses.push(`bath.isbn=${query.isbn}`);
    else {
      if (query.title) clauses.push(`dc.title=${cqlQuote(query.title)}`);
      if (query.author)
        clauses.push(`bath.personalName=${cqlQuote(query.author)}`);
    }
    url.searchParams.set("query", clauses.join(" and "));
    const res = await requestCatalog(
      provider,
      url.href,
      "application/xml,text/xml",
      options,
      requests,
    );
    if (res.status !== 200)
      fail("CATALOG_HTTP", `LoC SRU returned HTTP ${res.status}`);
    return parseLocSruMods(res.bytes.toString("utf8"));
  }

  if (provider === "openlibrary") {
    if (query.isbn) {
      const booksUrl = new URL("https://openlibrary.org/api/books");
      booksUrl.searchParams.set("bibkeys", `ISBN:${query.isbn}`);
      booksUrl.searchParams.set("jscmd", "data");
      booksUrl.searchParams.set("format", "json");
      const booksRes = await requestCatalog(
        provider,
        booksUrl.href,
        "application/json",
        options,
        requests,
      );
      if (booksRes.status !== 200)
        fail("CATALOG_HTTP", `Open Library returned HTTP ${booksRes.status}`);
      const booksJson = parseJsonBody(provider, booksRes.bytes);

      let editionJson: unknown;
      let workJson: unknown;
      const editionRes = await requestCatalog(
        provider,
        `https://openlibrary.org/isbn/${query.isbn}.json`,
        "application/json",
        options,
        requests,
      );
      if (editionRes.status === 200) {
        editionJson = parseJsonBody(provider, editionRes.bytes);
        const workKey =
          editionJson &&
          typeof editionJson === "object" &&
          Array.isArray((editionJson as { works?: unknown[] }).works)
            ? ((editionJson as { works: { key?: unknown }[] }).works[0]?.key as
                string | undefined)
            : undefined;
        if (workKey && /^\/works\/OL\w+W$/.test(workKey)) {
          const workRes = await requestCatalog(
            provider,
            `https://openlibrary.org${workKey}.json`,
            "application/json",
            options,
            requests,
          );
          if (workRes.status === 200)
            workJson = parseJsonBody(provider, workRes.bytes);
        }
      } else if (editionRes.status !== 404) {
        fail("CATALOG_HTTP", `Open Library returned HTTP ${editionRes.status}`);
      }
      return parseOpenLibraryBooks(
        query.isbn,
        booksJson,
        editionJson,
        workJson,
      );
    }

    const searchUrl = new URL("https://openlibrary.org/search.json");
    if (query.title) searchUrl.searchParams.set("title", query.title);
    if (query.author) searchUrl.searchParams.set("author", query.author);
    searchUrl.searchParams.set("limit", "10");
    const searchRes = await requestCatalog(
      provider,
      searchUrl.href,
      "application/json",
      options,
      requests,
    );
    if (searchRes.status !== 200)
      fail("CATALOG_HTTP", `Open Library returned HTTP ${searchRes.status}`);
    return parseOpenLibrarySearch(parseJsonBody(provider, searchRes.bytes));
  }

  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  const terms: string[] = [];
  if (query.isbn) terms.push(`isbn:${query.isbn}`);
  else {
    if (query.title) terms.push(`intitle:${query.title}`);
    if (query.author) terms.push(`inauthor:${query.author}`);
    if (query.publisher) terms.push(`inpublisher:${query.publisher}`);
  }
  url.searchParams.set("q", terms.join(" "));
  url.searchParams.set("maxResults", "10");
  const apiKey =
    options.googleBooksApiKey ?? process.env.GOOGLE_BOOKS_API_KEY?.trim();
  if (apiKey) url.searchParams.set("key", apiKey);
  const res = await requestCatalog(
    provider,
    url.href,
    "application/json",
    options,
    requests,
  );
  if (res.status !== 200)
    fail("CATALOG_HTTP", `Google Books returned HTTP ${res.status}`);
  return parseGoogleBooks(parseJsonBody(provider, res.bytes));
}

function matchesQuery(entry: CatalogEntry, query: CatalogQuery): boolean {
  if (query.isbn) {
    return (
      entry.printIsbns.includes(query.isbn) ||
      entry.electronicIsbns.includes(query.isbn)
    );
  }
  const wantedTitle = comparable(query.title ?? "");
  const entryTitle = comparable(entry.title);
  const fullTitle = comparable(
    entry.subtitle ? `${entry.title} ${entry.subtitle}` : entry.title,
  );
  if (
    !wantedTitle ||
    (entryTitle !== wantedTitle &&
      fullTitle !== wantedTitle &&
      !entryTitle.startsWith(wantedTitle) &&
      !fullTitle.startsWith(wantedTitle))
  )
    return false;
  if (query.author && entry.contributors.length) {
    const wantedAuthor = comparable(query.author);
    const authorMatch = entry.contributors.some((c) => {
      const candidate = comparable(c.name);
      return (
        candidate.includes(wantedAuthor) || wantedAuthor.includes(candidate)
      );
    });
    if (!authorMatch) return false;
  }
  if (query.publisher && entry.publisher) {
    const wantedPublisher = comparable(query.publisher);
    const entryPublisher = comparable(entry.publisher);
    if (
      !entryPublisher.includes(wantedPublisher) &&
      !wantedPublisher.includes(entryPublisher)
    )
      return false;
  }
  return true;
}

export function deriveCatalog(
  query: CatalogQuery,
  providers: CatalogProvider[],
  records: CatalogEntry[],
  seedDiagnostics: CatalogDiagnostic[] = [],
): { metadata: CatalogMetadata; diagnostics: CatalogDiagnostic[] } {
  const diagnostics: CatalogDiagnostic[] = [...seedDiagnostics];
  const rank = (provider: CatalogProvider) => {
    const index = providers.indexOf(provider);
    return index === -1 ? catalogProviders.indexOf(provider) + 100 : index;
  };
  const ordered = [...records].sort(
    (a, b) => rank(a.provider) - rank(b.provider),
  );
  if (!ordered.length) {
    diagnostics.push({
      code: "CATALOG_NO_MATCH",
      severity: "warning",
      message: "No matching book record was found across the selected catalogs",
    });
    return {
      metadata: { contributors: [], sources: [], provenance: {} },
      diagnostics,
    };
  }

  const provenance: Record<string, CatalogProvider> = {};
  const addConflict = (field: string, values: string[]) => {
    const distinct = [
      ...new Map(values.map((v) => [comparable(v), v])).values(),
    ];
    if (distinct.length > 1)
      diagnostics.push({
        code: "CATALOG_CONFLICT",
        severity: "warning",
        field,
        message: `Catalog providers disagree on ${field}; the highest-priority value was adopted`,
        values: distinct,
      });
  };
  const pick = (
    field:
      | "title"
      | "subtitle"
      | "originalTitle"
      | "publisher"
      | "imprint"
      | "series"
      | "position"
      | "language"
      | "description",
  ) => {
    const entries = ordered
      .map((record) => ({ provider: record.provider, value: record[field] }))
      .filter((item): item is { provider: CatalogProvider; value: string } =>
        Boolean(item.value),
      );
    if (!entries.length) return undefined;
    if (field !== "description")
      addConflict(
        field,
        entries.map((item) => item.value),
      );
    provenance[field] = entries[0].provider;
    return entries[0].value;
  };

  const contributors: Contributor[] = [];
  const roleOwners = new Map<string, CatalogProvider>();
  for (const record of ordered) {
    for (const person of record.contributors) {
      const owner = roleOwners.get(person.role);
      if (owner !== undefined && owner !== record.provider) continue;
      roleOwners.set(person.role, record.provider);
      if (
        !contributors.some(
          (item) => item.name === person.name && item.role === person.role,
        )
      )
        contributors.push(person);
    }
  }
  for (const [role, provider] of roleOwners)
    provenance[`contributor:${role}`] = provider;

  const dateEntries = ordered
    .filter((record): record is CatalogEntry & { date: string } =>
      Boolean(record.date),
    )
    .map((record) => ({ provider: record.provider, value: record.date }));
  let chosenDate = dateEntries[0];
  for (const entry of dateEntries.slice(1))
    if (
      chosenDate &&
      entry.value.length > chosenDate.value.length &&
      entry.value.startsWith(chosenDate.value)
    )
      chosenDate = entry;
  if (chosenDate) {
    provenance.date = chosenDate.provider;
    const incompatible = dateEntries.filter(
      (entry) =>
        !chosenDate.value.startsWith(entry.value) &&
        !entry.value.startsWith(chosenDate.value),
    );
    if (incompatible.length)
      diagnostics.push({
        code: "CATALOG_CONFLICT",
        severity: "warning",
        field: "date",
        message:
          "Catalog providers disagree on date; the highest-priority value was adopted",
        values: [
          chosenDate.value,
          ...new Set(incompatible.map((item) => item.value)),
        ],
      });
  }

  const allPrint = new Set(ordered.flatMap((record) => record.printIsbns));
  const allElectronic = new Set(
    ordered.flatMap((record) => record.electronicIsbns),
  );
  for (const e of allElectronic) allPrint.delete(e);
  const chooseIsbn = (
    set: Set<string>,
    field: "printIsbn" | "electronicIsbn",
  ) => {
    if (query.isbn && set.has(query.isbn)) return query.isbn;
    if (set.size === 1) return [...set][0];
    if (set.size > 1)
      diagnostics.push({
        code: "CATALOG_ISBN_AMBIGUOUS",
        severity: "warning",
        field,
        message:
          "Matched catalog records list multiple ISBNs; supply an expected isbn or edition publisher to disambiguate",
        values: [...set],
      });
    return undefined;
  };
  const printIsbn = chooseIsbn(allPrint, "printIsbn");
  const electronicIsbn = chooseIsbn(allElectronic, "electronicIsbn");
  if (printIsbn)
    provenance.printIsbn = ordered.find(
      (r) =>
        r.printIsbns.includes(printIsbn) ||
        r.electronicIsbns.includes(printIsbn),
    )!.provider;
  if (electronicIsbn)
    provenance.electronicIsbn = ordered.find((r) =>
      r.electronicIsbns.includes(electronicIsbn),
    )!.provider;

  const sources = ordered.map((record) => ({
    provider: record.provider,
    recordId: record.recordId,
    recordUrl: record.recordUrl,
  }));

  const metadata: CatalogMetadata = {
    contributors,
    sources,
    provenance,
  };
  const optional = {
    title: pick("title"),
    subtitle: pick("subtitle"),
    originalTitle: pick("originalTitle"),
    publisher: pick("publisher"),
    imprint: pick("imprint"),
    date: chosenDate?.value,
    printIsbn,
    electronicIsbn,
    series: pick("series"),
    position: pick("position"),
    language: pick("language"),
    description: pick("description"),
  };
  for (const [key, value] of Object.entries(optional))
    if (value !== undefined) Object.assign(metadata, { [key]: value });

  return { metadata, diagnostics };
}

function lockFrom(
  query: CatalogQuery,
  providers: CatalogProvider[],
  requests: CatalogRequestRecord[],
  records: CatalogEntry[],
  seedDiagnostics: CatalogDiagnostic[] = [],
): CatalogLock {
  const { metadata, diagnostics } = deriveCatalog(
    query,
    providers,
    records,
    seedDiagnostics,
  );
  const content = {
    schemaVersion: 1 as const,
    query,
    providers,
    requests,
    records,
    metadata,
    diagnostics,
  };
  return { ...content, digest: sha256(stable(content)) };
}

export async function collectCatalog(
  input: unknown,
  options: CatalogOptions = {},
): Promise<CatalogLock> {
  const query = queryFrom(input);
  if (!options.online)
    fail(
      "CATALOG_OFFLINE",
      "Use a saved catalog lock or explicitly request --online",
    );
  if (process.env.CI && !options.fetcher)
    fail("CI_NETWORK_DISABLED", "Live catalog requests are disabled in CI");

  const hasGoogleBooksKey = Boolean(
    options.googleBooksApiKey ?? process.env.GOOGLE_BOOKS_API_KEY?.trim(),
  );
  const providers = selectCatalogProviders(query, { hasGoogleBooksKey });
  if (!providers.length)
    fail(
      "CATALOG_PROVIDERS_EMPTY",
      "No selected catalog provider supports the supplied query",
    );

  const requests: CatalogRequestRecord[] = [];
  const records: CatalogEntry[] = [];
  const providerDiagnostics: CatalogDiagnostic[] = [];
  let succeeded = 0;

  for (const provider of providers) {
    checkAbort(options.signal);
    try {
      const fetched = await queryProvider(provider, query, options, requests);
      succeeded++;
      for (const entry of fetched)
        if (matchesQuery(entry, query)) records.push(entry);
    } catch (error) {
      checkAbort(options.signal);
      const code = (error as { code?: string }).code;
      if (code === "SSRF_BLOCKED" || code === "CANCELLED") throw error;
      const rawMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = rawMessage.replace(
        /([?&]key=)[^&\s]+/gi,
        "$1REDACTED",
      );
      providerDiagnostics.push({
        code: "CATALOG_PROVIDER_FAILED",
        severity: "warning",
        provider,
        message: safeMessage,
      });
    }
  }

  if (succeeded === 0)
    fail(
      "CATALOG_UNAVAILABLE",
      "Every selected catalog provider failed",
      providerDiagnostics,
    );

  return lockFrom(query, providers, requests, records, providerDiagnostics);
}

const providerFailureSchema = z.strictObject({
  code: z.literal("CATALOG_PROVIDER_FAILED"),
  severity: z.enum(["warning", "error"]),
  provider: z.enum(catalogProviders).optional(),
  field: z.string().optional(),
  message: z.string(),
  values: z.array(z.string()).optional(),
});

export function readCatalogLock(source: string): CatalogLock {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail("CATALOG_LOCK", "Invalid catalog JSON lock");
  }
  const parsed = z
    .strictObject({
      schemaVersion: z.literal(1),
      query: catalogQuerySchema,
      providers: z.array(z.enum(catalogProviders)).min(1).max(6),
      requests: z.array(catalogRequestSchema).max(100),
      records: z.array(catalogEntrySchema).max(200),
      metadata: z.unknown(),
      diagnostics: z.array(z.unknown()),
      digest: z.string(),
    })
    .safeParse(value);
  if (!parsed.success)
    fail("CATALOG_LOCK", "Invalid catalog lock structure", parsed.error.issues);

  const { digest, ...content } = parsed.data;
  const query = queryFrom(content.query);
  const preservedFailures = content.diagnostics
    .map((item) => providerFailureSchema.safeParse(item))
    .filter((res) => res.success)
    .map((res) => res.data);
  const derived = deriveCatalog(
    query,
    content.providers,
    content.records,
    preservedFailures,
  );
  if (
    digest !== sha256(stable(content)) ||
    stable(query) !== stable(content.query) ||
    stable(content.metadata) !== stable(derived.metadata) ||
    stable(content.diagnostics) !== stable(derived.diagnostics)
  )
    fail(
      "CATALOG_LOCK",
      "Catalog lock content or derived metadata changed; query the catalogs again",
    );
  return { ...content, ...derived, query, digest } as CatalogLock;
}

export async function resolveCatalog(
  file: string,
  options: CatalogOptions & { output: string },
) {
  const query = queryFrom(
    JSON.parse((await readSourceFile(file)).toString("utf8")),
  );
  const output = path.resolve(options.output);
  const formatResult = (lock: CatalogLock, mode: "online" | "offline") => ({
    status: "pass" as const,
    operation: "catalog-metadata" as const,
    metadata: lock.metadata,
    records: lock.records,
    diagnostics: lock.diagnostics,
    lock: output,
    digest: lock.digest,
    mode,
  });
  if (!options.online) {
    const lock = readCatalogLock(
      (await readSourceFile(output)).toString("utf8"),
    );
    if (stable(lock.query) !== stable(query))
      fail(
        "CATALOG_LOCK_STALE",
        "Catalog query changed; create a new catalog lock",
      );
    return formatResult(lock, "offline");
  }
  const lock = await collectCatalog(query, options);
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
          "Catalog locks are immutable; select a new output path for a refreshed lock",
        );
      throw error;
    });
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return formatResult(lock, "online");
}
