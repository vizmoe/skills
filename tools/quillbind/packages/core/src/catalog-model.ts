import { z } from "zod";
import { fail } from "./errors.js";
import {
  normalizeIsbn,
  normalizeLanguage,
  type ContributorRole,
} from "./bibliography-normalize.js";
import { roleSchema } from "./edition-model.js";

const text = z.string().trim().min(1).max(100000);
export const catalogProviders = [
  "openbd",
  "ndl",
  "cinii",
  "loc",
  "openlibrary",
  "google-books",
] as const;
export type CatalogProvider = (typeof catalogProviders)[number];

export const catalogProviderNames: Record<CatalogProvider, string> = {
  openbd: "openBD",
  ndl: "National Diet Library Search",
  cinii: "CiNii Books",
  loc: "Library of Congress Online Catalog",
  openlibrary: "Open Library",
  "google-books": "Google Books",
};

export const catalogHosts: Record<CatalogProvider, readonly string[]> = {
  openbd: ["api.openbd.jp"],
  ndl: ["ndlsearch.ndl.go.jp"],
  cinii: ["ci.nii.ac.jp"],
  loc: ["lx2.loc.gov"],
  openlibrary: ["openlibrary.org"],
  "google-books": ["www.googleapis.com"],
};

export const catalogQuerySchema = z
  .strictObject({
    isbn: text
      .refine((value) => normalizeIsbn(value) !== undefined, "Invalid ISBN")
      .optional(),
    title: text.optional(),
    author: text.optional(),
    publisher: text.optional(),
    language: text
      .refine(
        (value) => normalizeLanguage(value) !== undefined,
        "Invalid language",
      )
      .optional(),
    providers: z.array(z.enum(catalogProviders)).min(1).max(6).optional(),
    matchEvidence: z.array(text).min(1).max(20),
  })
  .refine(
    (value) => Boolean(value.isbn || value.title),
    "Supply isbn, title, or both",
  );
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;

export const catalogEntrySchema = z.strictObject({
  provider: z.enum(catalogProviders),
  recordId: text,
  recordUrl: text,
  title: text,
  subtitle: text.optional(),
  originalTitle: text.optional(),
  contributors: z
    .array(z.strictObject({ name: text, role: roleSchema }))
    .max(100),
  publisher: text.optional(),
  imprint: text.optional(),
  date: text.optional(),
  printIsbns: z.array(text).max(50),
  electronicIsbns: z.array(text).max(50),
  series: text.optional(),
  position: text.optional(),
  language: text.optional(),
  description: text.optional(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogRequestSchema = z.strictObject({
  provider: z.enum(catalogProviders),
  url: text,
  retrievedAt: z.iso.datetime(),
  status: z.number().int(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CatalogRequestRecord = z.infer<typeof catalogRequestSchema>;

export interface CatalogDiagnostic {
  code: string;
  severity: "warning" | "error";
  provider?: CatalogProvider;
  field?: string;
  message: string;
  values?: string[];
}

export interface CatalogMetadata {
  title?: string;
  subtitle?: string;
  originalTitle?: string;
  contributors: { name: string; role: ContributorRole }[];
  publisher?: string;
  imprint?: string;
  date?: string;
  printIsbn?: string;
  electronicIsbn?: string;
  series?: string;
  position?: string;
  language?: string;
  description?: string;
  sources: {
    provider: CatalogProvider;
    recordId: string;
    recordUrl: string;
  }[];
  provenance: Record<string, CatalogProvider>;
}

export interface CatalogLock {
  schemaVersion: 1;
  query: CatalogQuery;
  providers: CatalogProvider[];
  requests: CatalogRequestRecord[];
  records: CatalogEntry[];
  metadata: CatalogMetadata;
  diagnostics: CatalogDiagnostic[];
  digest: string;
}

const isChineseIsbn = (isbn: string) =>
  /^(?:9787|978957|978986|978626|978962|978988)/.test(isbn);
const isJapaneseIsbn = (isbn: string) => /^9784/.test(isbn);

export function selectCatalogProviders(
  query: CatalogQuery,
  options: { hasGoogleBooksKey?: boolean } = {},
): CatalogProvider[] {
  const isbn = query.isbn ? normalizeIsbn(query.isbn) : undefined;
  const language = query.language
    ? normalizeLanguage(query.language)
    : undefined;
  if (query.providers) {
    return [...new Set(query.providers)].filter(
      (provider) => provider !== "openbd" || Boolean(isbn),
    );
  }
  let selected: CatalogProvider[];
  if (
    (isbn && isJapaneseIsbn(isbn)) ||
    language === "ja" ||
    language?.startsWith("ja-")
  ) {
    selected = isbn
      ? ["openbd", "ndl", "cinii", "openlibrary"]
      : ["ndl", "cinii", "openlibrary"];
  } else if (
    (isbn && isChineseIsbn(isbn)) ||
    language === "zh" ||
    language?.startsWith("zh-")
  ) {
    selected = ["openlibrary", "cinii", "loc", "ndl"];
  } else {
    selected = ["loc", "openlibrary", "cinii"];
  }
  if (options.hasGoogleBooksKey && !selected.includes("google-books"))
    selected.push("google-books");
  return selected;
}

export function catalogAddress(provider: CatalogProvider, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("CATALOG_URL", "Expected an HTTPS catalog API URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname.endsWith(".") ||
    !catalogHosts[provider].includes(url.hostname)
  )
    fail("SSRF_BLOCKED", "Catalog URL is outside the provider allowlist");
  url.hash = "";
  return url;
}

/** Never persist API keys in locks, candidates, or diagnostics. */
export function redactCatalogUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.delete("key");
  return url.href;
}
