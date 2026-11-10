import { z } from "zod";
import { fail } from "./errors.js";
import { normalizeIsbn } from "./bibliography-normalize.js";

const text = z.string().trim().min(1).max(100000);
export const editionFields = [
  "title",
  "subtitle",
  "originalTitle",
  "contributor",
  "publisher",
  "imprint",
  "date",
  "isbn",
  "series",
  "position",
  "language",
  "description",
] as const;
export const editionSources = [
  "json-ld",
  "microdata",
  "section",
  "label",
  "meta",
  "open-graph",
  "document-title",
] as const;
export const roleSchema = z.enum([
  "aut",
  "trl",
  "ill",
  "edt",
  "ant",
  "art",
  "pht",
]);
export const candidateSchema = z.strictObject({
  field: z.enum(editionFields),
  source: z.enum(editionSources),
  value: text,
  label: text.optional(),
  role: roleSchema.optional(),
  format: z.enum(["print", "electronic"]).optional(),
});
export type EditionCandidate = z.infer<typeof candidateSchema>;
export const editionSelectionSchema = z.strictObject({
  url: text,
  isbn: text
    .refine((value) => normalizeIsbn(value) !== undefined, "Invalid ISBN")
    .optional(),
  matchEvidence: z.array(text).min(1).max(20),
});
export type EditionSelection = z.infer<typeof editionSelectionSchema>;
export const editionRecordSchema = z.strictObject({
  url: text,
  finalUrl: text,
  canonicalUrl: text.optional(),
  retrieval: z.enum(["online", "saved-page"]),
  retrievedAt: z.iso.datetime(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  charset: text,
  siteName: text.optional(),
  candidates: z.array(candidateSchema).max(2000),
});
export type EditionRecord = z.infer<typeof editionRecordSchema>;
export interface EditionDiagnostic {
  code: string;
  severity: "warning" | "error";
  field?: string;
  message: string;
  values?: string[];
}
export interface EditionMetadata {
  url: string;
  title: string;
  subtitle?: string;
  originalTitle?: string;
  contributors: { name: string; role: z.infer<typeof roleSchema> }[];
  publisher?: string;
  imprint?: string;
  date?: string;
  printIsbn?: string;
  electronicIsbn?: string;
  series?: string;
  position?: string;
  language?: string;
  description?: string;
  /** Source kind of each adopted field, for the run report. */
  provenance: Record<string, string>;
}
export interface EditionLock {
  schemaVersion: 1;
  selection: EditionSelection;
  record: EditionRecord;
  metadata: EditionMetadata;
  diagnostics: EditionDiagnostic[];
  digest: string;
}

export function editionAddress(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("EDITION_URL", "Expected an HTTPS edition page URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname.endsWith(".")
  )
    fail(
      "EDITION_URL",
      "Edition pages require HTTPS without credentials or a custom port",
    );
  url.hash = "";
  return url;
}
