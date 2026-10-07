import type { Document, Block, Inline } from "./model.js";
import type { EpubInspection } from "./epub.js";
import { attr, elements, NS } from "./xml.js";
import { fail } from "./errors.js";

export interface QaOptions {
  coverage?: "full" | "stratified";
  screenshots?: "failures-and-samples" | "all";
}
export const widths = [320, 390, 768, 1280];
export const modes = [
  {
    id: "default",
    scale: 1,
    dark: false,
    font: false,
    spacing: false,
    grayscale: false,
  },
  {
    id: "large",
    scale: 2,
    dark: false,
    font: true,
    spacing: true,
    grayscale: false,
  },
  {
    id: "dark",
    scale: 1,
    dark: true,
    font: false,
    spacing: false,
    grayscale: false,
  },
  {
    id: "grayscale",
    scale: 1,
    dark: false,
    font: false,
    spacing: false,
    grayscale: true,
  },
];
export interface QaDocument {
  path: string;
  features: string[];
}
const evenly = <T>(items: T[], count: number): T[] =>
  items.length <= count
    ? items
    : Array.from(
        { length: count },
        (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))],
      );

/** Deterministic coverage policy shared by estimates and browser execution. */
export function planQa(documents: QaDocument[], options: QaOptions = {}) {
  const strategy = options.coverage ?? "full";
  const screenshots = options.screenshots ?? "failures-and-samples";
  if (
    !["full", "stratified"].includes(strategy) ||
    !["failures-and-samples", "all"].includes(screenshots)
  )
    fail("QA_OPTIONS", "Unknown browser coverage or screenshot policy");
  const selected = new Map<string, string[]>();
  const select = (document: QaDocument, reason: string) =>
    selected.set(document.path, [
      ...(selected.get(document.path) ?? []),
      reason,
    ]);
  if (strategy === "full")
    documents.forEach((document) => select(document, "full coverage"));
  else {
    evenly(documents, 12).forEach((document) =>
      select(document, "evenly spaced reading order"),
    );
    for (const feature of [
      ...new Set(documents.flatMap((document) => document.features)),
    ].sort())
      evenly(
        documents.filter((document) => document.features.includes(feature)),
        3,
      ).forEach((document) =>
        select(document, `first/middle/last: ${feature}`),
      );
  }
  const samples = new Set(
    evenly(
      documents.filter((document) => selected.has(document.path)),
      3,
    ).map((document) => document.path),
  );
  const assignments = documents.map((document) => ({
    ...document,
    modes: selected.has(document.path)
      ? modes.map((mode) => mode.id)
      : ["default"],
    reasons: selected.get(document.path) ?? ["default mode on every document"],
    screenshotSample: samples.has(document.path),
  }));
  const matrixCases = assignments.reduce(
    (total, document) => total + widths.length * document.modes.length,
    0,
  );
  const passingScreenshots =
    screenshots === "all" ? matrixCases : samples.size * modes.length;
  const estimateBytes = (count: number) => ({
    low: count * 32 * 1024,
    high: count * 256 * 1024,
  });
  return {
    strategy,
    policyVersion: 1,
    documents: documents.length,
    fullMatrixDocuments: selected.size,
    viewports: widths,
    scales: [100, 200],
    modes: modes.map((mode) => mode.id),
    cases: matrixCases + documents.length,
    matrixCases,
    paginationCases: documents.length,
    baselineChecks:
      "axe, code integrity and link round trips on every document",
    assignments,
    screenshots: {
      policy: screenshots,
      passing: passingScreenshots,
      estimatedPassingBytes: estimateBytes(passingScreenshots),
      estimatedAllMatrixBytes: estimateBytes(matrixCases),
      estimateBasis:
        "32–256 KiB per full-page PNG; heuristic, not a size limit. Long/image-heavy pages can exceed this range. Failures add screenshots.",
    },
  };
}
export type QaPlan = ReturnType<typeof planQa>;

export function sourceQaDocuments(
  documents: Document[],
  cover: boolean,
): QaDocument[] {
  const chapters = documents.map((document) => {
    const features = new Set<string>();
    if (document.direction === "rtl") features.add("rtl");
    if (document.writingMode === "vertical-rl") features.add("vertical");
    if (document.footnotes.length) features.add("footnotes");
    const inline = (value: Inline) => {
      if (value.kind === "math" || value.kind === "image")
        features.add(value.kind);
      if ("children" in value) value.children.forEach(inline);
    };
    const block = (value: Block) => {
      if (["code", "table", "math"].includes(value.kind))
        features.add(value.kind);
      if (value.kind === "figure") features.add("image");
      if ("inlines" in value) value.inlines.forEach(inline);
      if (value.kind === "table") value.rows.flat(2).forEach(inline);
      if ("children" in value) value.children.forEach(block);
    };
    document.blocks.forEach(block);
    document.footnotes.forEach((note) => note.blocks.forEach(block));
    return { path: document.href, features: [...features].sort() };
  });
  const direction = documents[0]?.direction === "rtl" ? ["rtl"] : [];
  const navigationFeatures = [
    "navigation",
    ...direction,
    ...(documents[0]?.writingMode === "vertical-rl" ? ["vertical"] : []),
  ].sort();
  return [
    ...(cover
      ? [
          {
            path: "EPUB/cover.xhtml",
            features: ["cover", "image", ...direction].sort(),
          },
        ]
      : []),
    { path: "EPUB/contents.xhtml", features: navigationFeatures },
    ...chapters,
    { path: "EPUB/nav.xhtml", features: navigationFeatures },
  ];
}
export function inspectedQaDocuments(info: EpubInspection): QaDocument[] {
  const paths = [
    ...new Set([
      ...info.spine.map(
        (id) => info.manifest.find((item) => item.id === id)!.path,
      ),
      ...info.manifest
        .filter((item) => item.properties.includes("nav"))
        .map((item) => item.path),
    ]),
  ];
  return paths.map((path) => {
    const document = info.documents.get(path)!;
    const features = new Set<string>();
    for (const [tag, feature] of [
      ["pre", "code"],
      ["table", "table"],
      ["math", "math"],
      ["img", "image"],
      ["nav", "navigation"],
    ])
      if (elements(document, tag).length) features.add(feature);
    for (const element of elements(document)) {
      const semantics = attr(element, "epub:type").split(/\s+/);
      if (semantics.includes("cover") && element.localName !== "a")
        features.add("cover");
      if (
        semantics.some((type) =>
          ["footnote", "endnote", "noteref"].includes(type),
        )
      )
        features.add("footnotes");
      if (attr(element, "dir") === "rtl") features.add("rtl");
    }
    if (
      elements(document, "html", NS.xhtml).some(
        (element) =>
          attr(element, "class").split(/\s+/).includes("vertical") ||
          /vertical-rl/.test(attr(element, "style")),
      )
    )
      features.add("vertical");
    return { path, features: [...features].sort() };
  });
}
