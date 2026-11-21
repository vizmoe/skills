import { z } from "zod";

export const PDF_SPEC_SCHEMA_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const pdfClassificationSchema = z.enum([
  "digital",
  "scanned",
  "hybrid",
  "empty",
]);
export type PdfClassification = z.infer<typeof pdfClassificationSchema>;

export const ocrTrustSchema = z.enum([
  "digital-native",
  "verified",
  "unverified-embedded",
  "none",
]);
export type OcrTrust = z.infer<typeof ocrTrustSchema>;

/** Gate OCR proofreading by ocrTrust rather than page classification. */
export function pageRequiresOcrVerification(page: {
  classification: PdfClassification;
  ocrTrust: OcrTrust;
}): boolean {
  if (page.classification === "empty") return false;
  return page.ocrTrust === "unverified-embedded" || page.ocrTrust === "none";
}

export const pdfRotateSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);
export type PdfRotate = z.infer<typeof pdfRotateSchema>;

export const pdfShardRangeSchema = z.strictObject({
  id: z.string().min(1),
  pageStart: z.number().int().min(1),
  pageEnd: z.number().int().min(1),
  estimatedImageTokens: z.number().int().nonnegative().optional(),
});
export type PdfShardRange = z.infer<typeof pdfShardRangeSchema>;

export const pdfImageInventoryItemSchema = z.strictObject({
  id: z.string().min(1),
  page: z.number().int().min(1),
  name: z.string().min(1),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  bitsPerComponent: z.number().int().nonnegative(),
  colorSpace: z.string().min(1),
  filter: z.string(),
  streamSha256: sha256Schema,
  estimatedDpi: z.number().positive().optional(),
});
export type PdfImageInventoryItem = z.infer<typeof pdfImageInventoryItemSchema>;

export interface PdfOutlineNode {
  title: string;
  page: number;
  children: PdfOutlineNode[];
}
export const pdfOutlineNodeSchema: z.ZodType<PdfOutlineNode> = z.lazy(() =>
  z.strictObject({
    title: z.string().min(1),
    page: z.number().int().min(1),
    children: z.array(pdfOutlineNodeSchema),
  }),
);

export const pdfPageSummarySchema = z.strictObject({
  page: z.number().int().min(1),
  widthPt: z.number().positive(),
  heightPt: z.number().positive(),
  rotate: pdfRotateSchema,
  classification: pdfClassificationSchema,
  textCharCount: z.number().int().nonnegative(),
  imageCount: z.number().int().nonnegative(),
  hasReaddleOcr: z.boolean(),
  hasInvisibleTextLayer: z.boolean(),
  ocrTrust: ocrTrustSchema,
  anomalies: z.array(z.string()),
});
export type PdfPageSummary = z.infer<typeof pdfPageSummarySchema>;

export const pdfNormalizedBoxSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export type PdfNormalizedBox = z.infer<typeof pdfNormalizedBoxSchema>;

export const pdfRenderTileSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["band", "header", "footer", "footnote-zone"]),
  path: z.string().min(1),
  sha256: sha256Schema,
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  normalizedBox: pdfNormalizedBoxSchema,
});
export type PdfRenderTile = z.infer<typeof pdfRenderTileSchema>;

export const pdfRenderedPageSchema = z.strictObject({
  page: z.number().int().min(1),
  path: z.string().min(1),
  sha256: sha256Schema,
  dpi: z.number().positive(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  estimatedImageTokens: z.number().int().nonnegative(),
  tiles: z.array(pdfRenderTileSchema).optional(),
});
export type PdfRenderedPage = z.infer<typeof pdfRenderedPageSchema>;

export const pdfRenderManifestSchema = z.strictObject({
  schemaVersion: z.literal(PDF_SPEC_SCHEMA_VERSION),
  kind: z.literal("quillbind-pdf-render-manifest"),
  sourcePath: z.string().min(1),
  sourceSha256: sha256Schema,
  dpi: z.number().positive(),
  tiled: z.boolean(),
  pages: z.array(pdfRenderedPageSchema),
});
export type PdfRenderManifest = z.infer<typeof pdfRenderManifestSchema>;

export const pdfInspectionReportSchema = z.strictObject({
  schemaVersion: z.literal(PDF_SPEC_SCHEMA_VERSION),
  path: z.string().min(1),
  sha256: sha256Schema,
  pdfVersion: z.string().min(1),
  pageCount: z.number().int().nonnegative(),
  classification: pdfClassificationSchema,
  info: z.record(z.string(), z.string()),
  pages: z.array(pdfPageSummarySchema),
  images: z.array(pdfImageInventoryItemSchema),
  outline: z.array(pdfOutlineNodeSchema),
  shards: z.array(pdfShardRangeSchema),
  renderedPages: z.array(pdfRenderedPageSchema).optional(),
  renderManifestPath: z.string().min(1).optional(),
  renderManifestSha256: sha256Schema.optional(),
});
export type PdfInspectionReport = z.infer<typeof pdfInspectionReportSchema>;

export const pdfInlineRunSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    text: z.string(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    code: z.boolean().optional(),
    sup: z.boolean().optional(),
    sub: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("ruby"),
    base: z.string().min(1),
    rt: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("math-inline"),
    tex: z.string().optional(),
    mathml: z.string().optional(),
    alt: z.string(),
  }),
  z.strictObject({
    kind: z.literal("noteref"),
    id: z.string().min(1),
    label: z.string().min(1),
  }),
]);
export type PdfInlineRun = z.infer<typeof pdfInlineRunSchema>;

export const pdfTableCellSchema = z.strictObject({
  header: z.boolean().optional(),
  scope: z.enum(["col", "row", "colgroup", "rowgroup"]).optional(),
  rowspan: z.number().int().min(1).optional(),
  colspan: z.number().int().min(1).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  text: z.string().optional(),
  inlines: z.array(pdfInlineRunSchema).optional(),
});
export type PdfTableCell = z.infer<typeof pdfTableCellSchema>;

export const pdfFigureProvenanceSchema = z.strictObject({
  sourceSha256: sha256Schema,
  outputSha256: sha256Schema,
  mode: z.enum(["extracted", "cropped", "non-destructive-restoration"]),
  generativeRedraw: z.literal(false),
});
export type PdfFigureProvenance = z.infer<typeof pdfFigureProvenanceSchema>;

export const pdfListItemSchema = z.union([
  z.string(),
  z.strictObject({
    text: z.string(),
    inlines: z.array(pdfInlineRunSchema).optional(),
  }),
]);
export type PdfListItem = z.infer<typeof pdfListItemSchema>;

export const pdfBlockSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("heading"),
    level: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
    ]),
    id: z.string().min(1).optional(),
    text: z.string(),
    inlines: z.array(pdfInlineRunSchema).optional(),
    subtitle: z.string().optional(),
    byline: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("paragraph"),
    voice: z
      .enum(["body", "epigraph", "quote", "verse", "dialogue", "signature"])
      .optional(),
    align: z.enum(["left", "center", "right", "justify"]).optional(),
    gapBefore: z.union([z.boolean(), z.number().nonnegative()]).optional(),
    continueFromPrevPage: z.boolean().optional(),
    stitchWithNextPage: z.boolean().optional(),
    text: z.string(),
    inlines: z.array(pdfInlineRunSchema).optional(),
  }),
  z.strictObject({
    kind: z.literal("math-block"),
    id: z.string().min(1).optional(),
    tex: z.string().optional(),
    mathml: z.string().optional(),
    alt: z.string(),
  }),
  z.strictObject({
    kind: z.literal("table"),
    id: z.string().min(1).optional(),
    caption: z.string(),
    continueFromPrevPage: z.boolean().optional(),
    stitchWithNextPage: z.boolean().optional(),
    head: z.array(z.array(pdfTableCellSchema)).optional(),
    body: z.array(z.array(pdfTableCellSchema)),
    foot: z.array(z.array(pdfTableCellSchema)).optional(),
  }),
  z.strictObject({
    kind: z.literal("figure"),
    id: z.string().min(1).optional(),
    src: z.string().min(1),
    alt: z.string(),
    decorative: z.boolean().optional(),
    caption: z.string().optional(),
    provenance: pdfFigureProvenanceSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("list"),
    ordered: z.boolean().optional(),
    items: z.array(pdfListItemSchema),
  }),
  z.strictObject({
    kind: z.literal("hr"),
  }),
]);
export type PdfBlock = z.infer<typeof pdfBlockSchema>;

export const pdfFootnoteItemSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  text: z.string(),
  inlines: z.array(pdfInlineRunSchema).optional(),
  continueFromPrevPage: z.boolean().optional(),
  stitchWithNextPage: z.boolean().optional(),
});
export type PdfFootnoteItem = z.infer<typeof pdfFootnoteItemSchema>;

/** Deterministic line bounding boxes only; text is sourced exclusively from proofread blocks. */
export const pdfLineGeometrySchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  vertical: z.boolean().optional(),
  source: z
    .enum(["ocr-layer", "bbox-layout", "horizontal-projection"])
    .optional(),
});
export type PdfLineGeometry = z.infer<typeof pdfLineGeometrySchema>;

export const pdfUnresolvedItemSchema = z.strictObject({
  id: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  reason: z.string().min(1),
  context: z.string().optional(),
});
export type PdfUnresolvedItem = z.infer<typeof pdfUnresolvedItemSchema>;

export const pdfPageRenderRefSchema = z.strictObject({
  path: z.string().min(1).optional(),
  sha256: sha256Schema,
  dpi: z.number().positive(),
  widthPx: z.number().int().positive().optional(),
  heightPx: z.number().int().positive().optional(),
  tilesReviewed: z.array(z.string().min(1)).optional(),
});
export type PdfPageRenderRef = z.infer<typeof pdfPageRenderRefSchema>;

export const pdfPageTranscriptionSchema = z.strictObject({
  transcribedBy: z.string().min(1),
  unresolved: z.array(pdfUnresolvedItemSchema),
});
export type PdfPageTranscription = z.infer<typeof pdfPageTranscriptionSchema>;

export const pdfPageVerificationRecordSchema = z.strictObject({
  page: z.number().int().min(1),
  renderSha256: sha256Schema,
  dpi: z.number().positive(),
  tilesReviewed: z.array(z.string().min(1)),
  transcribedBy: z.string().min(1),
  verifiedBy: z.string().min(1),
  contentSha256: sha256Schema,
  status: z.enum(["verified", "rejected"]),
  unresolved: z.array(pdfUnresolvedItemSchema),
  verifiedAt: z.string().min(1).optional(),
  notes: z.string().optional(),
});
export type PdfPageVerificationRecord = z.infer<
  typeof pdfPageVerificationRecordSchema
>;

export const pdfVerificationFileSchema = z.strictObject({
  schemaVersion: z.literal(PDF_SPEC_SCHEMA_VERSION),
  kind: z.literal("quillbind-pdf-verification"),
  sourceSha256: sha256Schema,
  renderManifestSha256: sha256Schema.optional(),
  verifierId: z.string().min(1),
  verifiedAt: z.string().min(1),
  pages: z.array(pdfPageVerificationRecordSchema),
});
export type PdfVerificationFile = z.infer<typeof pdfVerificationFileSchema>;

export const pdfSpecPageSchema = z.strictObject({
  page: z.number().int().min(1),
  widthPt: z.number().positive(),
  heightPt: z.number().positive(),
  rotate: pdfRotateSchema,
  classification: pdfClassificationSchema,
  ocrTrust: ocrTrustSchema,
  sectionId: z.string().min(1).optional(),
  blocks: z.array(pdfBlockSchema),
  footnotes: z.array(pdfFootnoteItemSchema),
  geometry: z.array(pdfLineGeometrySchema).optional(),
  rawOcrDraft: z.string().optional(),
  render: pdfPageRenderRefSchema.optional(),
  transcription: pdfPageTranscriptionSchema.optional(),
  verification: pdfPageVerificationRecordSchema.optional(),
});
export type PdfSpecPage = z.infer<typeof pdfSpecPageSchema>;

export const pdfFrontmatterSpecSchema = z.strictObject({
  coverImage: z.string().min(1).optional(),
  coverAlt: z.string().optional(),
  titlepage: z
    .strictObject({
      title: z.string().min(1),
      subtitle: z.string().optional(),
      authors: z.array(z.string()),
      translators: z.array(z.string()).optional(),
      publisher: z.string().optional(),
      imprint: z.string().optional(),
      extraLines: z.array(z.string()).optional(),
    })
    .optional(),
  colophon: z
    .strictObject({
      lines: z.array(z.string()),
      copyright: z.string().optional(),
      publisher: z.string().optional(),
      edition: z.string().optional(),
      isbn: z.string().optional(),
    })
    .optional(),
  includeTitlepage: z.boolean().optional(),
  includeColophon: z.boolean().optional(),
});
export type PdfFrontmatterSpec = z.infer<typeof pdfFrontmatterSpecSchema>;

export const pdfSpecSourceSchema = z.strictObject({
  path: z.string().min(1),
  sha256: sha256Schema,
  pdfVersion: z.string().min(1),
  pageCount: z.number().int().nonnegative(),
  classification: pdfClassificationSchema,
});
export type PdfSpecSource = z.infer<typeof pdfSpecSourceSchema>;

export const pdfSpecMetadataSchema = z.strictObject({
  title: z.string().min(1),
  authors: z.array(z.string()),
  translators: z.array(z.string()).optional(),
  language: z.string().min(1),
  description: z.string(),
  publisher: z.string().optional(),
  isbn: z.string().nullable().optional(),
  tags: z.array(z.string()),
  modified: z.string().optional(),
});
export type PdfSpecMetadata = z.infer<typeof pdfSpecMetadataSchema>;

export const pdfSpecSchema = z.strictObject({
  schemaVersion: z.literal(PDF_SPEC_SCHEMA_VERSION),
  kind: z.literal("quillbind-pdf-spec"),
  source: pdfSpecSourceSchema,
  metadata: pdfSpecMetadataSchema,
  frontmatter: pdfFrontmatterSpecSchema,
  outline: z.array(pdfOutlineNodeSchema),
  shards: z.array(pdfShardRangeSchema),
  renderManifestPath: z.string().min(1).optional(),
  renderManifestSha256: sha256Schema.optional(),
  pages: z.array(pdfSpecPageSchema),
});
export type PdfSpec = z.infer<typeof pdfSpecSchema>;

export const pdfShardFileSchema = z.strictObject({
  schemaVersion: z.literal(PDF_SPEC_SCHEMA_VERSION),
  kind: z.literal("quillbind-pdf-shard"),
  sourceSha256: sha256Schema,
  shard: pdfShardRangeSchema,
  pages: z.array(pdfSpecPageSchema),
});
export type PdfShardFile = z.infer<typeof pdfShardFileSchema>;

export const pdfPageFileSchema = z.strictObject({
  schemaVersion: z.literal(PDF_SPEC_SCHEMA_VERSION),
  kind: z.literal("quillbind-pdf-page"),
  sourceSha256: sha256Schema,
  page: pdfSpecPageSchema,
});
export type PdfPageFile = z.infer<typeof pdfPageFileSchema>;

export const pdfDiagnosticSchema = z.strictObject({
  code: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  page: z.number().int().min(1).optional(),
  file: z.string().optional(),
  line: z.number().int().min(1).optional(),
  path: z.string().optional(),
  message: z.string().min(1),
});
export type PdfDiagnostic = z.infer<typeof pdfDiagnosticSchema>;

export const pdfPageQaSignalSchema = z.strictObject({
  page: z.number().int().min(1),
  classification: pdfClassificationSchema,
  ocrTrust: ocrTrustSchema,
  requiresVerification: z.boolean(),
  transcribedLineCount: z.number().int().nonnegative(),
  transcribedCharCount: z.number().int().nonnegative(),
  projectionLineCount: z.number().int().nonnegative().optional(),
  estimatedCharsFromInk: z.number().int().nonnegative().optional(),
  rawOcrEditDistanceRatio: z.number().min(0).max(1).optional(),
  unresolvedCount: z.number().int().nonnegative(),
  charsetAnomalies: z.array(z.string()),
  warnings: z.array(pdfDiagnosticSchema),
  errors: z.array(pdfDiagnosticSchema),
});
export type PdfPageQaSignal = z.infer<typeof pdfPageQaSignalSchema>;

export const pdfCheckReportSchema = z.strictObject({
  schemaVersion: z.literal(PDF_SPEC_SCHEMA_VERSION),
  operation: z.literal("pdf-check-spec"),
  status: z.enum(["pass", "fail"]),
  pageCount: z.number().int().nonnegative(),
  pages: z.array(pdfPageQaSignalSchema),
  errors: z.array(pdfDiagnosticSchema),
  warnings: z.array(pdfDiagnosticSchema),
});
export type PdfCheckReport = z.infer<typeof pdfCheckReportSchema>;

export const pdfImageEnhanceReportSchema = z.strictObject({
  schemaVersion: z.literal(PDF_SPEC_SCHEMA_VERSION),
  source: z.strictObject({
    path: z.string().min(1),
    sha256: sha256Schema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: z.string().min(1),
  }),
  output: z.strictObject({
    path: z.string().min(1),
    sha256: sha256Schema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: z.string().min(1),
  }),
  comparisonImage: z.string().min(1),
  comparisonImageSha256: sha256Schema,
  operations: z.array(z.string()),
  multiScaleSsim: z.number().min(-1).max(1),
  edgeCorrelation: z.number().min(-1).max(1),
  aspectRatioDelta: z.number().nonnegative(),
  mode: z.literal("non-destructive-restoration"),
  generativeRedraw: z.literal(false),
});
export type PdfImageEnhanceReport = z.infer<typeof pdfImageEnhanceReportSchema>;

export const pdfRepairPageAlignmentSchema = z.strictObject({
  page: z.number().int().min(1),
  mode: z.enum(["line-matched", "block-fallback", "skipped-empty"]),
  geometryLines: z.number().int().nonnegative(),
  textLines: z.number().int().nonnegative(),
  geometrySource: z.string().optional(),
});
export type PdfRepairPageAlignment = z.infer<
  typeof pdfRepairPageAlignmentSchema
>;

export const pdfRepairReportSchema = z.strictObject({
  schemaVersion: z.literal(PDF_SPEC_SCHEMA_VERSION),
  operation: z.literal("pdf-repair-ocr"),
  status: z.literal("pass"),
  source: z.strictObject({
    path: z.string().min(1),
    sha256: sha256Schema,
  }),
  output: z.strictObject({
    path: z.string().min(1),
    sha256: sha256Schema,
  }),
  backup: z
    .strictObject({
      path: z.string().min(1),
      sha256: sha256Schema,
    })
    .optional(),
  incrementalUpdate: z.literal(true),
  xrefFormat: z.enum(["classic", "xref-stream"]),
  pagesRepaired: z.array(z.number().int().min(1)),
  pageAlignments: z.array(pdfRepairPageAlignmentSchema),
  strippedOcrArtifacts: z.number().int().nonnegative(),
  outlineEntries: z.number().int().nonnegative(),
  ocrLayerVerified: z.literal(true),
  readbackTool: z.enum(["pdftotext", "internal-parser"]),
  preservedImageStreams: z.strictObject({
    count: z.number().int().nonnegative(),
    verifiedBitIdentical: z.literal(true),
  }),
  verification: z.strictObject({
    pagesRequiringVerification: z.array(z.number().int().min(1)),
    verifierId: z.string().min(1).optional(),
    verifiedAt: z.string().min(1).optional(),
    verificationFileSha256: sha256Schema.optional(),
  }),
  reports: z.string().min(1),
});
export type PdfRepairReport = z.infer<typeof pdfRepairReportSchema>;
