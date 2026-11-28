import { z } from "zod";

export const BILINGUAL_SCHEMA_VERSION = 1 as const;

export const TRANSLATION_MODES = ["bilingual", "target-only"] as const;
export type TranslationMode = (typeof TRANSLATION_MODES)[number];

export function isTranslationMode(value: string): value is TranslationMode {
  return value === "bilingual" || value === "target-only";
}

export const TRANSLATION_STYLES = ["paired", "plain"] as const;
export type TranslationStyle = (typeof TRANSLATION_STYLES)[number];

export function isTranslationStyle(value: string): value is TranslationStyle {
  return value === "paired" || value === "plain";
}

export const TRANSLATION_SKIP_REASONS = [
  "whitespace",
  "link",
  "symbol",
  "non-content",
  "ruby",
  "pagebreak",
  "excluded-tag",
  "translate-no",
  "hidden",
  "user-excluded",
] as const;
export type TranslationSkipReason = (typeof TRANSLATION_SKIP_REASONS)[number];

export const DEFAULT_TRANSLATION_EXCLUDE_TAGS = [
  "sup",
  "code",
  "pre",
  "kbd",
  "samp",
] as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);

export const translationMarkerSchema = z.strictObject({
  token: z.string().min(3),
  tag: z.string().min(1),
  ownerChildPath: z.string().min(1),
  textChars: z.number().int().nonnegative(),
});
export type TranslationMarker = z.infer<typeof translationMarkerSchema>;

export const translationUnitSchema = z.strictObject({
  id: z.string().min(1),
  docPath: z.string().min(1),
  docIndex: z.number().int().nonnegative(),
  ownerPath: z.string().min(1),
  runIndex: z.number().int().nonnegative(),
  tag: z.string().min(1),
  signature: z.string().min(1),
  restrictedContentModel: z.boolean(),
  sourceText: z.string().min(1),
  sourceChars: z.number().int().positive(),
  markers: z.array(translationMarkerSchema),
  estimatedTokens: z.number().int().positive(),
});
export type TranslationUnit = z.infer<typeof translationUnitSchema>;

export const translationLedgerActionSchema = z.enum(["translate", "skip"]);
export type TranslationLedgerAction = z.infer<
  typeof translationLedgerActionSchema
>;

export const translationLedgerDecidedBySchema = z.enum([
  "agent",
  "user",
  "rule",
]);
export type TranslationLedgerDecidedBy = z.infer<
  typeof translationLedgerDecidedBySchema
>;

export const translationLedgerRowSchema = z.strictObject({
  key: z.string().min(1),
  scope: z.literal("block"),
  units: z.number().int().positive(),
  chars: z.number().int().positive(),
  pct: z.number().nonnegative(),
  meanChars: z.number().nonnegative(),
  samples: z.array(z.string()),
  action: translationLedgerActionSchema.nullable(),
  decidedBy: translationLedgerDecidedBySchema.nullable(),
  contentType: z.string().min(1).nullable(),
});
export type TranslationLedgerRow = z.infer<typeof translationLedgerRowSchema>;

export const translationShardPlanSchema = z.strictObject({
  id: z.string().min(1),
  docPaths: z.array(z.string().min(1)).min(1),
  unitIds: z.array(z.string().min(1)).min(1),
  estimatedTokens: z.number().int().positive(),
  sourceChars: z.number().int().positive(),
});
export type TranslationShardPlan = z.infer<typeof translationShardPlanSchema>;

export const translationCoverageSchema = z.strictObject({
  totalChars: z.number().int().nonnegative(),
  translatableChars: z.number().int().nonnegative(),
  skippedChars: z.record(z.string(), z.number().int().nonnegative()),
  unitCount: z.number().int().nonnegative(),
});
export type TranslationCoverage = z.infer<typeof translationCoverageSchema>;

export const translationPlanSchema = z.strictObject({
  schemaVersion: z.literal(BILINGUAL_SCHEMA_VERSION),
  kind: z.literal("quillbind-translation-plan"),
  source: z.strictObject({
    path: z.string().min(1),
    sha256: sha256Schema,
    epubVersion: z.string().min(1),
    title: z.string(),
    sourceLanguage: z.string(),
    documentCount: z.number().int().nonnegative(),
  }),
  targetLanguage: z.string().min(2),
  mode: z.enum(TRANSLATION_MODES),
  excludeTags: z.array(z.string().min(1)),
  onlyDocs: z.array(z.string().min(1)),
  excludeDocs: z.array(z.string().min(1)),
  tokenBudget: z.number().int().positive(),
  coverage: translationCoverageSchema,
  ledger: z.array(translationLedgerRowSchema),
  units: z.array(translationUnitSchema),
  shards: z.array(translationShardPlanSchema),
});
export type TranslationPlan = z.infer<typeof translationPlanSchema>;

export const translationGlossaryTermSchema = z.strictObject({
  source: z.string().min(1),
  target: z.string().min(1),
  notes: z.string().optional(),
});
export type TranslationGlossaryTerm = z.infer<
  typeof translationGlossaryTermSchema
>;

export const translationGlossarySchema = z.strictObject({
  schemaVersion: z.literal(BILINGUAL_SCHEMA_VERSION),
  kind: z.literal("quillbind-translation-glossary"),
  sourceLanguage: z.string().min(2).optional(),
  targetLanguage: z.string().min(2),
  styleGuide: z.string().optional(),
  terms: z.array(translationGlossaryTermSchema),
});
export type TranslationGlossary = z.infer<typeof translationGlossarySchema>;

export const translationUnresolvedItemSchema = z.strictObject({
  unitId: z.string().min(1).optional(),
  reason: z.string().min(1),
  context: z.string().optional(),
});
export type TranslationUnresolvedItem = z.infer<
  typeof translationUnresolvedItemSchema
>;

export const translationShardEntrySchema = z.strictObject({
  unitId: z.string().min(1),
  sourceText: z.string().optional(),
  translation: z.string(),
});
export type TranslationShardEntry = z.infer<typeof translationShardEntrySchema>;

export const translationShardFileSchema = z.strictObject({
  schemaVersion: z.literal(BILINGUAL_SCHEMA_VERSION),
  kind: z.literal("quillbind-translation-shard"),
  shardId: z.string().min(1),
  sourceSha256: sha256Schema,
  planSha256: sha256Schema,
  sourceLanguage: z.string(),
  targetLanguage: z.string().min(2),
  mode: z.enum(TRANSLATION_MODES),
  glossarySha256: sha256Schema.optional(),
  translatedBy: z.string(),
  entries: z.array(translationShardEntrySchema),
  unresolved: z.array(translationUnresolvedItemSchema),
});
export type TranslationShardFile = z.infer<typeof translationShardFileSchema>;

export const translationMergedShardRecordSchema = z.strictObject({
  shardId: z.string().min(1),
  translatedBy: z.string().min(1),
  unitIds: z.array(z.string().min(1)).min(1),
  contentSha256: sha256Schema,
  unresolved: z.array(translationUnresolvedItemSchema),
});
export type TranslationMergedShardRecord = z.infer<
  typeof translationMergedShardRecordSchema
>;

export const translationMergedFileSchema = z.strictObject({
  schemaVersion: z.literal(BILINGUAL_SCHEMA_VERSION),
  kind: z.literal("quillbind-translation-merged"),
  sourceSha256: sha256Schema,
  planSha256: sha256Schema,
  sourceLanguage: z.string(),
  targetLanguage: z.string().min(2),
  mode: z.enum(TRANSLATION_MODES),
  glossarySha256: sha256Schema.optional(),
  shards: z.array(translationMergedShardRecordSchema).min(1),
  translations: z.record(z.string(), z.string()),
});
export type TranslationMergedFile = z.infer<typeof translationMergedFileSchema>;

export const translationVerificationShardSchema = z.strictObject({
  shardId: z.string().min(1),
  translatedBy: z.string().min(1),
  verifiedBy: z.string().min(1),
  contentSha256: sha256Schema,
  status: z.enum(["verified", "rejected"]),
  unresolved: z.array(translationUnresolvedItemSchema),
  notes: z.string().optional(),
});
export type TranslationVerificationShard = z.infer<
  typeof translationVerificationShardSchema
>;

export const translationVerificationFileSchema = z.strictObject({
  schemaVersion: z.literal(BILINGUAL_SCHEMA_VERSION),
  kind: z.literal("quillbind-translation-verification"),
  sourceSha256: sha256Schema,
  planSha256: sha256Schema,
  verifierId: z.string().min(1),
  verifiedAt: z.string().min(1),
  shards: z.array(translationVerificationShardSchema).min(1),
});
export type TranslationVerificationFile = z.infer<
  typeof translationVerificationFileSchema
>;

export interface TranslationDiagnostic {
  code: string;
  severity: "error" | "warning";
  file?: string;
  shardId?: string;
  unitId?: string;
  line?: number;
  message: string;
}
