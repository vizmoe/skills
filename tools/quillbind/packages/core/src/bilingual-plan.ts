import path from "node:path";
import type { Document as XmlDocument, Element, Node } from "@xmldom/xmldom";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import { inspectBytes, type EpubInspection } from "./epub.js";
import { validLanguage } from "./config.js";
import { fail } from "./errors.js";
import { readSourceFile, exists } from "./files.js";
import { json } from "./json.js";
import { attr, elements, NS } from "./xml.js";
import {
  BILINGUAL_SCHEMA_VERSION,
  DEFAULT_TRANSLATION_EXCLUDE_TAGS,
  TRANSLATION_SKIP_REASONS,
  type TranslationCoverage,
  type TranslationLedgerRow,
  type TranslationMarker,
  type TranslationMode,
  type TranslationPlan,
  type TranslationShardPlan,
  type TranslationSkipReason,
  type TranslationUnit,
} from "./bilingual-model.js";
import { canBeInlineMarker, MarkerOrdinalSupply } from "./bilingual-markers.js";

const DEFAULT_BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "html",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const BLOCKISH_DISPLAY = new Set([
  "block",
  "flex",
  "grid",
  "table",
  "table-row",
  "table-cell",
  "list-item",
  "flow-root",
]);

const NON_CONTENT_TAGS = new Set([
  "script",
  "style",
  "head",
  "title",
  "template",
  "svg",
  "math",
]);

const RUBY_ANNOTATION_TAGS = new Set(["rt", "rp", "rtc"]);

const RENDERED_VOID_TAGS = new Set([
  "img",
  "svg",
  "math",
  "video",
  "audio",
  "canvas",
  "object",
  "iframe",
  "embed",
  "picture",
  "hr",
  "input",
  "br",
]);

const RESTRICTED_SIBLING_TAGS = new Set([
  "figcaption",
  "caption",
  "legend",
  "summary",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

const NOTE_EPUB_TYPES = new Set([
  "footnote",
  "endnote",
  "rearnote",
  "note",
  "footnotes",
  "endnotes",
]);
const NOTE_ROLES = new Set(["doc-footnote", "doc-endnote"]);

const INVISIBLE_CHARS_RE = /[\u00ad\u200b\ufeff]/gu;
const CSS_IDENT_RE =
  /^(?:--[-A-Za-z0-9_\u0080-\uFFFF]*|-?[A-Za-z_\u0080-\uFFFF][-A-Za-z0-9_\u0080-\uFFFF]*)$/u;
const PURE_URL_RE = /^(?:https?:\/\/|mailto:|ftp:\/\/|www\.)\S+$/iu;
const NUMERAL_DECORATION_RE =
  /^[\s.,:;()[\]{}\-–—·•/\\#*†‡§]+|[\s.,:;()[\]{}\-–—·•/\\#*†‡§]+$/gu;
const NUMERAL_SPLIT_RE = /[\s.,:;()[\]{}\-–—·•/\\]+/u;
const SIGNATURE_SAMPLE_CAP = 5;
const SAMPLE_MAX_CHARS = 100;

export const DEFAULT_TRANSLATION_TOKEN_BUDGET = 6000;

interface SimpleDisplayRule {
  tag?: string;
  classes: string[];
  display: string;
}

export interface BookDisplayProfile {
  rules: SimpleDisplayRule[];
}

function isScreenUnconditionalMedia(params: string): boolean {
  const lowered = params.trim().toLowerCase();
  if (!lowered) return true;
  return lowered.split(",").some((alt) => {
    const trimmed = alt.trim();
    if (!trimmed) return false;
    const negated = trimmed.startsWith("not ");
    const core = negated ? trimmed.slice(4).trim() : trimmed;
    if (/^(?:only\s+)?(?:screen|all)$/u.test(core)) return !negated;
    if (/\b(?:print|speech|aural)\b/u.test(core)) return negated;
    return false;
  });
}

export function extractBookDisplayProfile(
  info: EpubInspection,
): BookDisplayProfile {
  const rules: SimpleDisplayRule[] = [];
  for (const item of info.manifest) {
    if (item.mediaType !== "text/css") continue;
    const entry = info.entries.get(item.path);
    if (!entry) continue;
    let tree;
    try {
      tree = postcss.parse(entry.bytes.toString("utf8"), { from: item.path });
    } catch {
      continue;
    }
    tree.walkRules((rule) => {
      if (
        rule.parent?.type === "atrule" &&
        rule.parent.name.toLowerCase() === "media" &&
        !isScreenUnconditionalMedia(rule.parent.params)
      ) {
        return;
      }
      let display: string | undefined;
      rule.walkDecls("display", (decl) => {
        display = decl.value.trim().toLowerCase();
      });
      if (!display) return;
      try {
        selectorParser((selectors) => {
          selectors.each((sel) => {
            if (sel.nodes.some((n) => n.type === "combinator")) return;
            let tag: string | undefined;
            const classes: string[] = [];
            for (const node of sel.nodes) {
              if (node.type === "tag") tag = node.value.toLowerCase();
              else if (node.type === "class") classes.push(node.value);
              else return;
            }
            if (tag || classes.length) {
              rules.push({ tag, classes, display: display! });
            }
          });
        }).processSync(rule.selector);
      } catch {
        // Ignore unparseable selector syntax in source EPUB CSS.
      }
    });
  }
  return { rules };
}

function inlineStyleDisplay(el: Element): string | undefined {
  const style = attr(el, "style");
  if (!style) return undefined;
  const match = /(?:^|;)\s*display\s*:\s*([\w-]+)/iu.exec(style);
  return match ? match[1].toLowerCase() : undefined;
}

function resolvedDisplay(
  el: Element,
  profile: BookDisplayProfile,
): string | undefined {
  const inline = inlineStyleDisplay(el);
  if (inline) return inline;
  const tag = (el.localName ?? "").toLowerCase();
  const classSet = new Set(attr(el, "class").split(/\s+/u).filter(Boolean));
  let matched: string | undefined;
  for (const rule of profile.rules) {
    if (rule.tag && rule.tag !== tag) continue;
    if (rule.classes.some((c) => !classSet.has(c))) continue;
    matched = rule.display;
  }
  return matched;
}

export function isBlockElement(
  el: Element,
  profile: BookDisplayProfile,
): boolean {
  const display = resolvedDisplay(el, profile);
  if (display === "none") return false;
  if (display) return BLOCKISH_DISPLAY.has(display);
  return DEFAULT_BLOCK_TAGS.has((el.localName ?? "").toLowerCase());
}

function isHiddenElement(el: Element, profile: BookDisplayProfile): boolean {
  if (el.hasAttribute("hidden")) return true;
  return resolvedDisplay(el, profile) === "none";
}

function hasNoteSemantics(el: Element): boolean {
  const epubTypes = attr(el, "epub:type").toLowerCase().split(/\s+/u);
  if (epubTypes.some((t) => NOTE_EPUB_TYPES.has(t))) return true;
  return NOTE_ROLES.has(attr(el, "role").toLowerCase().trim());
}

function isPagebreakElement(el: Element): boolean {
  const epubTypes = attr(el, "epub:type").toLowerCase().split(/\s+/u);
  if (epubTypes.some((t) => t.includes("pagebreak") || t.includes("page-list")))
    return true;
  return attr(el, "role").toLowerCase().trim() === "doc-pagebreak";
}

function isNoterefOrBacklinkElement(el: Element): boolean {
  const epubTypes = attr(el, "epub:type").toLowerCase().split(/\s+/u);
  if (epubTypes.includes("noteref") || epubTypes.includes("backlink"))
    return true;
  const role = attr(el, "role").toLowerCase().trim();
  return role === "doc-noteref" || role === "doc-backlink";
}

function countAllTextChars(node: Node): number {
  if (node.nodeType === 3 || node.nodeType === 4) {
    return (node.nodeValue ?? "").length;
  }
  if (node.nodeType !== 1) return 0;
  let total = 0;
  for (const child of Array.from(node.childNodes)) {
    total += countAllTextChars(child);
  }
  return total;
}

function normalizeUnitText(raw: string): string {
  return raw.replace(INVISIBLE_CHARS_RE, "").replace(/\s+/gu, " ").trim();
}

export function estimateTranslationTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x3000 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.max(1, Math.ceil(cjk * 1.5 + other / 3.8));
}

function isAsciiNumeralOnly(text: string): boolean {
  const core = text.replace(NUMERAL_DECORATION_RE, "");
  if (!core) return false;
  const tokens = core.split(NUMERAL_SPLIT_RE).filter(Boolean);
  return tokens.length > 0 && tokens.every((tok) => /^[0-9]+$/u.test(tok));
}

export function computeBlockSignature(el: Element, text: string): string {
  const tag = (el.localName ?? "div").toLowerCase();
  const classes = [
    ...new Set(
      attr(el, "class")
        .split(/\s+/u)
        .filter((c) => c && CSS_IDENT_RE.test(c)),
    ),
  ].sort((a, b) => a.localeCompare(b, "en"));
  const base = classes.length
    ? `block:${tag}.${classes.join(".")}`
    : `block:${tag}`;
  return isAsciiNumeralOnly(text) ? `${base} #num` : base;
}

function segmentSkipReason(text: string): TranslationSkipReason | null {
  const trimmed = text.trim();
  if (!trimmed) return "whitespace";
  if (PURE_URL_RE.test(trimmed)) return "link";
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return "symbol";
  return null;
}

function elementDirectSkipReason(
  el: Element,
  excludeTags: ReadonlySet<string>,
  profile: BookDisplayProfile,
  inNoteContext: boolean,
): TranslationSkipReason | null {
  const tag = (el.localName ?? "").toLowerCase();
  if (
    NON_CONTENT_TAGS.has(tag) ||
    el.namespaceURI === NS.math ||
    el.namespaceURI === "http://www.w3.org/2000/svg"
  ) {
    return "non-content";
  }
  if (RUBY_ANNOTATION_TAGS.has(tag)) return "ruby";
  if (isPagebreakElement(el)) return "pagebreak";
  if (attr(el, "translate").toLowerCase().trim() === "no")
    return "translate-no";
  if (excludeTags.has(tag)) return "excluded-tag";
  if (!inNoteContext && isHiddenElement(el, profile)) return "hidden";
  return null;
}

function isProtectedInlineAtomic(
  el: Element,
  excludeTags: ReadonlySet<string>,
  profile: BookDisplayProfile,
  inNoteContext: boolean,
): { reason: TranslationSkipReason | null; rendered: boolean } {
  const tag = (el.localName ?? "").toLowerCase();
  const reason = elementDirectSkipReason(
    el,
    excludeTags,
    profile,
    inNoteContext,
  );
  if (reason) {
    const visibleSkip =
      reason === "excluded-tag" ||
      reason === "translate-no" ||
      (reason === "non-content" && (tag === "svg" || tag === "math"));
    return { reason, rendered: visibleSkip };
  }
  if (isNoterefOrBacklinkElement(el)) {
    return { reason: "excluded-tag", rendered: true };
  }
  if (RENDERED_VOID_TAGS.has(tag)) {
    return { reason: "non-content", rendered: true };
  }
  return { reason: null, rendered: false };
}

function childElementIndex(parent: Element, target: Element): number {
  let idx = 0;
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 1) {
      if (child === target) return idx;
      idx += 1;
    }
  }
  return -1;
}

function hasNavAncestor(el: Element): boolean {
  let cur: Node | null = el.parentNode;
  while (cur && cur.nodeType === 1) {
    if (((cur as Element).localName ?? "").toLowerCase() === "nav") return true;
    cur = cur.parentNode;
  }
  return false;
}

interface PartitionAccumulator {
  docPath: string;
  docIndex: number;
  profile: BookDisplayProfile;
  excludeTags: ReadonlySet<string>;
  ordinals: MarkerOrdinalSupply;
  nextUnitNumber: () => number;
  units: TranslationUnit[];
  totalChars: number;
  translatableChars: number;
  skippedChars: Record<string, number>;
}

function addSkipped(
  acc: PartitionAccumulator,
  reason: TranslationSkipReason,
  chars: number,
) {
  if (chars <= 0) return;
  acc.totalChars += chars;
  acc.skippedChars[reason] = (acc.skippedChars[reason] ?? 0) + chars;
}

interface PendingMarker {
  placeholder: string;
  tag: string;
  ownerChildPath: string;
  textChars: number;
}

interface ActiveRun {
  parts: string[];
  rawChars: number;
  markers: PendingMarker[];
}

function createRun(): ActiveRun {
  return { parts: [], rawChars: 0, markers: [] };
}

function flushRun(
  owner: Element,
  ownerPath: string,
  runIndex: number,
  run: ActiveRun,
  acc: PartitionAccumulator,
): number {
  if (run.rawChars === 0 && run.markers.length === 0) return runIndex;
  const rawCombined = run.parts.join("");
  const textWithoutPlaceholders = run.markers.reduce(
    (cur, m) => cur.replaceAll(m.placeholder, " "),
    rawCombined,
  );
  const skip = segmentSkipReason(textWithoutPlaceholders);
  if (skip) {
    addSkipped(acc, skip, run.rawChars);
    return runIndex;
  }
  // Allocate collision-free final marker tokens against the whole run text.
  const taken = new Set<string>();
  let finalText = rawCombined;
  const finalMarkers: TranslationMarker[] = [];
  for (const m of run.markers) {
    const token = acc.ordinals.allocate(m.tag, finalText, taken);
    taken.add(token);
    finalText = finalText.replace(m.placeholder, token);
    finalMarkers.push({
      token,
      tag: m.tag,
      ownerChildPath: m.ownerChildPath,
      textChars: m.textChars,
    });
  }
  const normalized = normalizeUnitText(finalText);
  if (!normalized) {
    addSkipped(acc, "whitespace", run.rawChars);
    return runIndex;
  }
  const tag = (owner.localName ?? "div").toLowerCase();
  const unitNum = acc.nextUnitNumber();
  const id = `u-${String(unitNum).padStart(4, "0")}`;
  const restricted = RESTRICTED_SIBLING_TAGS.has(tag) || hasNavAncestor(owner);
  acc.totalChars += run.rawChars;
  acc.translatableChars += run.rawChars;
  acc.units.push({
    id,
    docPath: acc.docPath,
    docIndex: acc.docIndex,
    ownerPath,
    runIndex,
    tag,
    signature: computeBlockSignature(owner, normalized),
    restrictedContentModel: restricted,
    sourceText: normalized,
    sourceChars: run.rawChars,
    markers: finalMarkers,
    estimatedTokens: estimateTranslationTokens(normalized),
  });
  return runIndex + 1;
}

function walkBlockElement(
  owner: Element,
  ownerPath: string,
  inNoteContext: boolean,
  acc: PartitionAccumulator,
) {
  const ownerNote = inNoteContext || hasNoteSemantics(owner);
  const directSkip = elementDirectSkipReason(
    owner,
    acc.excludeTags,
    acc.profile,
    ownerNote,
  );
  if (directSkip) {
    addSkipped(acc, directSkip, countAllTextChars(owner));
    return;
  }

  let run = createRun();
  let runIndex = 0;
  let placeholderSeq = 0;

  const visitInlineChildren = (
    container: Element,
    relPrefix: string,
    noteCtx: boolean,
  ) => {
    let elemIdx = 0;
    for (const child of Array.from(container.childNodes)) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        const text = child.nodeValue ?? "";
        if (text.length > 0) {
          run.parts.push(text);
          run.rawChars += text.length;
        }
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const myIdx = elemIdx++;
      const childRelPath = relPrefix ? `${relPrefix}/${myIdx}` : String(myIdx);
      const childAbsPath = `${ownerPath}/${myIdx}`;
      const childNote = noteCtx || hasNoteSemantics(el);

      if (container === owner && isBlockElement(el, acc.profile)) {
        runIndex = flushRun(owner, ownerPath, runIndex, run, acc);
        run = createRun();
        walkBlockElement(el, childAbsPath, childNote, acc);
        continue;
      }

      const atomic = isProtectedInlineAtomic(
        el,
        acc.excludeTags,
        acc.profile,
        childNote,
      );
      if (atomic.reason) {
        const chars = countAllTextChars(el);
        addSkipped(acc, atomic.reason, chars);
        if (atomic.rendered) {
          const renderedText = el.textContent ?? "";
          if (canBeInlineMarker(renderedText)) {
            const placeholder = `\uE000QBM_${++placeholderSeq}\uE001`;
            run.parts.push(placeholder);
            run.markers.push({
              placeholder,
              tag: (el.localName ?? "x").toLowerCase(),
              ownerChildPath: childRelPath,
              textChars: chars,
            });
          } else {
            runIndex = flushRun(owner, ownerPath, runIndex, run, acc);
            run = createRun();
          }
        }
        continue;
      }

      if (isBlockElement(el, acc.profile)) {
        // Nested block inside an inline wrapper: flush and walk as nested block.
        runIndex = flushRun(owner, ownerPath, runIndex, run, acc);
        run = createRun();
        const absNested = `${ownerPath}/${childRelPath}`;
        walkBlockElement(el, absNested, childNote, acc);
        continue;
      }

      visitInlineChildren(el, childRelPath, childNote);
    }
  };

  visitInlineChildren(owner, "", ownerNote);
  flushRun(owner, ownerPath, runIndex, run, acc);
}

/** Assert an EPUB can be safely partitioned and rewritten without DRM/layout corruption. */
export function assertTranslatableEpub(info: EpubInspection): void {
  if (info.unsupported.includes("encrypted-content")) {
    fail(
      "TRANSLATE_ENCRYPTED",
      "Encrypted or DRM-protected EPUB files cannot be translated",
    );
  }
  if (info.unsupported.includes("fixed-layout")) {
    fail(
      "TRANSLATE_FIXED_LAYOUT",
      "Fixed-layout (pre-paginated) EPUB files are unsupported for bilingual reflow translation",
    );
  }
  if (info.entries.has("META-INF/encryption.xml")) {
    fail(
      "TRANSLATE_FONT_OBFUSCATION",
      "Font-obfuscated EPUBs tied to the source identifier cannot derive a distinct bilingual identity safely",
    );
  }
  if (
    info.unsupported.length > 0 ||
    info.entries.has("META-INF/signatures.xml")
  ) {
    fail(
      "TRANSLATE_UNSUPPORTED",
      `Cannot translate this EPUB structure: ${info.unsupported.join(", ") || "signed-package"}`,
      info.unsupported,
    );
  }
}

function selectTargetDocuments(
  info: EpubInspection,
  onlyDocs: string[],
  excludeDocs: string[],
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const byId = new Map(info.manifest.map((m) => [m.id, m]));
  for (const idref of info.spine) {
    const item = byId.get(idref);
    if (item && info.documents.has(item.path) && !seen.has(item.path)) {
      ordered.push(item.path);
      seen.add(item.path);
    }
  }
  for (const item of info.manifest) {
    if (
      item.properties.includes("nav") &&
      info.documents.has(item.path) &&
      !seen.has(item.path)
    ) {
      ordered.push(item.path);
      seen.add(item.path);
    }
  }
  const known = new Set(ordered);
  const validateDocList = (flag: string, list: string[]) => {
    const unknown = list.filter((p) => !known.has(p));
    if (unknown.length > 0) {
      fail(
        "TRANSLATE_DOC_FILTER_INVALID",
        `${flag} names document(s) not present in EPUB: ${unknown.join(", ")}`,
        { flag, unknown, available: ordered },
      );
    }
  };
  validateDocList("--only-docs", onlyDocs);
  validateDocList("--exclude-docs", excludeDocs);

  let selected = ordered;
  if (onlyDocs.length > 0) {
    const allow = new Set(onlyDocs);
    selected = selected.filter((p) => allow.has(p));
  }
  if (excludeDocs.length > 0) {
    const deny = new Set(excludeDocs);
    selected = selected.filter((p) => !deny.has(p));
  }
  return selected;
}

function stridedSamples(texts: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    const snippet =
      text.length > SAMPLE_MAX_CHARS
        ? `${text.slice(0, SAMPLE_MAX_CHARS - 1)}…`
        : text;
    if (!seen.has(snippet)) {
      seen.add(snippet);
      deduped.push(snippet);
    }
  }
  if (deduped.length <= SIGNATURE_SAMPLE_CAP) return deduped;
  const result: string[] = [];
  for (let i = 0; i < SIGNATURE_SAMPLE_CAP; i++) {
    const idx = Math.floor(
      (i * (deduped.length - 1)) / (SIGNATURE_SAMPLE_CAP - 1),
    );
    result.push(deduped[idx]);
  }
  return result;
}

export function buildTranslationLedger(
  units: readonly TranslationUnit[],
  totalChars: number,
  autoClassify = false,
): TranslationLedgerRow[] {
  const grouped = new Map<string, TranslationUnit[]>();
  for (const unit of units) {
    const list = grouped.get(unit.signature) ?? [];
    list.push(unit);
    grouped.set(unit.signature, list);
  }
  const denom = Math.max(1, totalChars);
  const rows: TranslationLedgerRow[] = [];
  for (const [key, list] of grouped.entries()) {
    const chars = list.reduce((sum, u) => sum + u.sourceChars, 0);
    const pct = Math.round((chars / denom) * 10000) / 100;
    const meanChars = Math.round((chars / list.length) * 10) / 10;
    const isNum = key.endsWith(" #num");
    rows.push({
      key,
      scope: "block",
      units: list.length,
      chars,
      pct,
      meanChars,
      samples: stridedSamples(list.map((u) => u.sourceText)),
      action: autoClassify ? (isNum ? "skip" : "translate") : null,
      decidedBy: autoClassify ? "rule" : null,
      contentType: autoClassify
        ? isNum
          ? "numeric-apparatus"
          : "book-prose"
        : null,
    });
  }
  return rows.sort(
    (a, b) => b.chars - a.chars || a.key.localeCompare(b.key, "en"),
  );
}

/** Validate row state invariants (decided rows must carry decidedBy and contentType). */
export function validateLedgerRowState(
  row: TranslationLedgerRow,
): string | null {
  if (row.action === null) {
    if (row.decidedBy !== null) {
      return `${row.key}: decidedBy is "${row.decidedBy}" while action is null`;
    }
    return null;
  }
  if (row.decidedBy === null) {
    return `${row.key}: action is "${row.action}" but decidedBy is null`;
  }
  if (!row.contentType || !row.contentType.trim()) {
    return `${row.key}: action is "${row.action}" without a contentType label`;
  }
  return null;
}

/** Group translatable units into chapter-aware token-budgeted shards. */
export function planTranslationShards(
  units: readonly TranslationUnit[],
  tokenBudget = DEFAULT_TRANSLATION_TOKEN_BUDGET,
): TranslationShardPlan[] {
  if (units.length === 0) return [];
  const budget = Math.max(200, Math.floor(tokenBudget));
  const shards: TranslationShardPlan[] = [];
  let curUnits: TranslationUnit[] = [];
  let curTokens = 0;
  let curChars = 0;
  let curDocs: string[] = [];

  const flush = () => {
    if (!curUnits.length) return;
    shards.push({
      id: `shard-${String(shards.length + 1).padStart(3, "0")}`,
      docPaths: curDocs,
      unitIds: curUnits.map((u) => u.id),
      estimatedTokens: curTokens,
      sourceChars: curChars,
    });
    curUnits = [];
    curTokens = 0;
    curChars = 0;
    curDocs = [];
  };

  for (const unit of units) {
    const nextDoc = !curDocs.includes(unit.docPath);
    const exceedsBudget =
      curUnits.length > 0 && curTokens + unit.estimatedTokens > budget;
    const chapterBoundaryReady =
      nextDoc && curUnits.length > 0 && curTokens >= budget * 0.65;
    if (exceedsBudget || chapterBoundaryReady) {
      flush();
    }
    curUnits.push(unit);
    curTokens += unit.estimatedTokens;
    curChars += unit.sourceChars;
    if (!curDocs.includes(unit.docPath)) curDocs.push(unit.docPath);
  }
  flush();
  return shards;
}

/** Resolve a DOM element inside a document's `<body>` from an `ownerPath` string. */
export function resolveBodyElementPath(
  doc: XmlDocument,
  ownerPath: string,
): Element | null {
  const body = elements(doc, "body", NS.xhtml)[0] ?? elements(doc, "body")[0];
  if (!body) return null;
  if (ownerPath === "body") return body;
  const parts = ownerPath.split("/");
  if (parts[0] !== "body") return null;
  let cur: Element = body;
  for (let i = 1; i < parts.length; i++) {
    const targetIdx = Number(parts[i]);
    if (!Number.isInteger(targetIdx) || targetIdx < 0) return null;
    let elemIdx = 0;
    let found: Element | null = null;
    for (const child of Array.from(cur.childNodes)) {
      if (child.nodeType === 1) {
        if (elemIdx === targetIdx) {
          found = child as Element;
          break;
        }
        elemIdx += 1;
      }
    }
    if (!found) return null;
    cur = found;
  }
  return cur;
}

/** Resolve a relative child-element path from an owner element. */
export function resolveRelativeElementPath(
  owner: Element,
  relPath: string,
): Element | null {
  const parts = relPath.split("/");
  let cur: Element = owner;
  for (const part of parts) {
    const targetIdx = Number(part);
    if (!Number.isInteger(targetIdx) || targetIdx < 0) return null;
    let elemIdx = 0;
    let found: Element | null = null;
    for (const child of Array.from(cur.childNodes)) {
      if (child.nodeType === 1) {
        if (elemIdx === targetIdx) {
          found = child as Element;
          break;
        }
        elemIdx += 1;
      }
    }
    if (!found) return null;
    cur = found;
  }
  return cur;
}

export function partitionEpubForTranslation(
  bytes: Uint8Array,
  options: {
    sourcePath: string;
    targetLanguage: string;
    mode?: TranslationMode;
    excludeTags?: string[];
    onlyDocs?: string[];
    excludeDocs?: string[];
    tokenBudget?: number;
    autoClassify?: boolean;
  },
): TranslationPlan {
  if (!validLanguage(options.targetLanguage)) {
    fail(
      "TRANSLATE_LANGUAGE_INVALID",
      `Invalid target BCP 47 language tag: ${options.targetLanguage}`,
    );
  }
  const info = inspectBytes(bytes);
  assertTranslatableEpub(info);
  const mode: TranslationMode = options.mode ?? "bilingual";
  const excludeTags = [
    ...new Set(
      (options.excludeTags?.length
        ? options.excludeTags
        : [...DEFAULT_TRANSLATION_EXCLUDE_TAGS]
      )
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const excludeSet = new Set(excludeTags);
  const onlyDocs = (options.onlyDocs ?? [])
    .map((p) => p.trim())
    .filter(Boolean);
  const excludeDocs = (options.excludeDocs ?? [])
    .map((p) => p.trim())
    .filter(Boolean);
  const selectedDocs = selectTargetDocuments(info, onlyDocs, excludeDocs);
  const profile = extractBookDisplayProfile(info);
  const tokenBudget = options.tokenBudget ?? DEFAULT_TRANSLATION_TOKEN_BUDGET;

  let unitCounter = 0;
  const units: TranslationUnit[] = [];
  let totalChars = 0;
  let translatableChars = 0;
  const skippedChars: Record<string, number> = Object.fromEntries(
    TRANSLATION_SKIP_REASONS.map((r) => [r, 0]),
  );

  for (const [docIndex, docPath] of selectedDocs.entries()) {
    const doc = info.documents.get(docPath);
    if (!doc) continue;
    const body = elements(doc, "body", NS.xhtml)[0] ?? elements(doc, "body")[0];
    if (!body) continue;
    const acc: PartitionAccumulator = {
      docPath,
      docIndex,
      profile,
      excludeTags: excludeSet,
      ordinals: new MarkerOrdinalSupply(1),
      nextUnitNumber: () => ++unitCounter,
      units,
      totalChars: 0,
      translatableChars: 0,
      skippedChars,
    };
    walkBlockElement(body, "body", false, acc);
    totalChars += acc.totalChars;
    translatableChars += acc.translatableChars;
  }

  const prunedSkipped: Record<string, number> = {};
  for (const [reason, count] of Object.entries(skippedChars)) {
    if (count > 0) prunedSkipped[reason] = count;
  }

  const coverage: TranslationCoverage = {
    totalChars,
    translatableChars,
    skippedChars: prunedSkipped,
    unitCount: units.length,
  };
  const ledger = buildTranslationLedger(
    units,
    totalChars,
    Boolean(options.autoClassify),
  );
  const activeKeys = new Set(
    ledger.filter((row) => row.action !== "skip").map((row) => row.key),
  );
  const shardUnits = units.filter((u) => activeKeys.has(u.signature));
  const shards = planTranslationShards(shardUnits, tokenBudget);

  return {
    schemaVersion: BILINGUAL_SCHEMA_VERSION,
    kind: "quillbind-translation-plan",
    source: {
      path: path.resolve(options.sourcePath),
      sha256: info.sha256,
      epubVersion: info.version,
      title: info.title,
      sourceLanguage: info.language,
      documentCount: selectedDocs.length,
    },
    targetLanguage: options.targetLanguage,
    mode,
    excludeTags,
    onlyDocs,
    excludeDocs,
    tokenBudget,
    coverage,
    ledger,
    units,
    shards,
  };
}

export async function createTranslationPlan(
  epubFile: string,
  outputFile: string,
  options: {
    targetLanguage: string;
    mode?: TranslationMode;
    excludeTags?: string[];
    onlyDocs?: string[];
    excludeDocs?: string[];
    tokenBudget?: number;
    autoClassify?: boolean;
  },
): Promise<{
  status: "pass";
  operation: "epub-translate-plan";
  planPath: string;
  sourceSha256: string;
  sourceLanguage: string;
  targetLanguage: string;
  mode: TranslationMode;
  undecidedSignatures: number;
  coverage: TranslationCoverage;
  shardCount: number;
  ledger: TranslationLedgerRow[];
}> {
  const resolvedInput = path.resolve(epubFile);
  const resolvedOutput = path.resolve(outputFile);
  if (await exists(resolvedOutput)) {
    fail(
      "OUTPUT_EXISTS",
      `Refusing to overwrite existing translation plan: ${resolvedOutput}`,
    );
  }
  const bytes = await readSourceFile(resolvedInput);
  const plan = partitionEpubForTranslation(bytes, {
    ...options,
    sourcePath: resolvedInput,
  });
  await json(resolvedOutput, plan);
  const undecidedSignatures = plan.ledger.filter(
    (row) => row.action === null,
  ).length;
  return {
    status: "pass",
    operation: "epub-translate-plan",
    planPath: resolvedOutput,
    sourceSha256: plan.source.sha256,
    sourceLanguage: plan.source.sourceLanguage,
    targetLanguage: plan.targetLanguage,
    mode: plan.mode,
    undecidedSignatures,
    coverage: plan.coverage,
    shardCount: plan.shards.length,
    ledger: plan.ledger,
  };
}

export { childElementIndex };
