export * from "./model.js";
export {
  openBook,
  bookSchema,
  schemaJson,
  taxonomy,
  validIsbn,
  validLanguage,
} from "./config.js";
export type { BookProject, BookConfig } from "./config.js";
export { resolveMetadata, lockedMetadata } from "./metadata.js";
export { preflightBook } from "./preflight.js";
export { buildBook, doctor } from "./pipeline.js";
export { previewBook } from "./preview.js";
export {
  validateEpub,
  inspectEpub,
  validateInternal,
  compatibilityLint,
} from "./validate.js";
export { runQa } from "./qa.js";
export type { RepairPlan, RepairAction } from "./repair-plan.js";
export { auditEpub, createRepairPlan, repairEpub } from "./repair.js";
export { repairReadingCopy } from "./reading-copy.js";
export { repairDirectory } from "./repair-directory.js";
export type { DirectoryRepairEntry } from "./repair-directory.js";
export { convertEpub } from "./convert-epub.js";
export {
  conversionTarget,
  conversionTargets,
  zhconvertNotice,
} from "./zhconvert.js";
export type { ConversionTarget, ConversionOptions } from "./zhconvert.js";
export { initBook, prepareBook } from "./init.js";
export { inspectNovel, fetchNovelBook, selectNovelVolumes } from "./novel.js";
export type { NovelOptions, FetchNovelOptions } from "./novel.js";
export type {
  NovelCatalog,
  NovelVolume,
  NovelChapter,
  NovelSite,
} from "./novel-model.js";
export { inspectionSummary, formatInspection } from "./inspection.js";
export type { InspectionReport } from "./inspection.js";
export { VERSION } from "./runtime.js";

/** Supported workflows; EPUB publication retains every EPUB release gate. */
export const formats = {
  inputs: ["markdown-book", "epub", "novel-url", "manga-scans"],
  outputs: ["epub", "cbz"],
  mangaInputFormats: ["image-directory", "zip", "cbz"],
  epubInputModes: [
    "audit",
    "check-notes",
    "repair",
    "repair-copy",
    "convert",
    "enrich",
    "split-plan",
    "split",
  ],
} as const;

export {
  collectBookWalker,
  resolveBookWalker,
  readBookWalkerLock,
  parseBookWalker,
} from "./bookwalker.js";
export type {
  BookWalkerLock,
  BookWalkerMetadata,
  BookWalkerSelection,
} from "./bookwalker.js";

export { enrichEpub, applyBookWalkerMetadata } from "./enrich-epub.js";

export { packageManga } from "./manga.js";
export { checkNotes } from "./check-notes.js";
export {
  auditFileRatings,
  cleanRatings,
  auditRatings,
  applyRatings,
} from "./ratings.js";
export {
  auditFileSeries,
  normalizeSeries,
  auditSeries,
  applySeries,
} from "./series-file.js";
export {
  auditFileCover,
  adoptCover,
  auditCover,
  applyCover,
} from "./covers.js";
export { auditFileSplit, auditSplit, applySplit, splitEpub } from "./split.js";
export type { SplitPlan } from "./split.js";
