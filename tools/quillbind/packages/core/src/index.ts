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
  convertKindleToEpub,
  unpackKindle,
  isKindlePath,
  isKindleBytes,
} from "./kindle.js";
export type { KindleFormat } from "./kindle.js";
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
  kindleInputFormats: ["mobi", "azw3"],
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
  auditBibliography,
  applyBibliography,
  auditFileBibliography,
  cleanBibliography,
} from "./bibliography-file.js";
export type { BibliographyPlan } from "./bibliography-file.js";
export {
  auditTags,
  applyTags,
  auditFileTags,
  applyFileTags,
  comicSequence,
  insertComicElement,
  loadTagVocabulary,
} from "./tags-file.js";
export type { TagsDecision, TagsPlan } from "./tags-file.js";
export {
  collectCatalog,
  deriveCatalog,
  readCatalogLock,
  resolveCatalog,
  selectCatalogProviders,
  catalogProviders,
  catalogProviderNames,
} from "./catalog.js";
export type {
  CatalogEntry,
  CatalogLock,
  CatalogMetadata,
  CatalogProvider,
  CatalogQuery,
} from "./catalog.js";
export {
  collectEdition,
  deriveEdition,
  extractEdition,
  readEditionLock,
  resolveEdition,
} from "./edition.js";
export type {
  EditionLock,
  EditionMetadata,
  EditionSelection,
} from "./edition.js";
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
export {
  bookWalkerSearchQuerySchema,
  collectBookWalkerSearch,
  parseBookWalkerSearch,
  readBookWalkerSearchLock,
  resolveBookWalkerSearch,
} from "./bookwalker-search.js";
export type {
  BookWalkerSearchCandidate,
  BookWalkerSearchDiagnostic,
  BookWalkerSearchLock,
  BookWalkerSearchQuery,
  BookWalkerSearchSite,
} from "./bookwalker-search.js";
export {
  coverAddress,
  coverFetchSelectionSchema,
  readCoverLock,
  resolveCoverFetch,
} from "./cover-fetch.js";
export type {
  CoverFetchOptions,
  CoverFetchSelection,
  CoverLock,
} from "./cover-fetch.js";

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
