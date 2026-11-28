import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Document as XmlDocument, Element, Node } from "@xmldom/xmldom";
import { inspectBytes, type EpubInspection } from "./epub.js";
import { checkAbort, fail } from "./errors.js";
import { exists, readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { json, readJson } from "./json.js";
import { readingQa } from "./reading-qa.js";
import { doctor, releaseGates } from "./pipeline.js";
import { ReleaseReporter } from "./reporting.js";
import { checkEpubConformance, validateInternal } from "./validate.js";
import { lintCss } from "./css.js";
import {
  attr,
  contentXml,
  elements,
  ncxXml,
  NS,
  serialize,
  xml,
} from "./xml.js";
import { pack } from "./zip.js";
import {
  translationMergedFileSchema,
  translationPlanSchema,
  translationVerificationFileSchema,
  type TranslationMergedFile,
  type TranslationMode,
  type TranslationPlan,
  type TranslationStyle,
  type TranslationUnit,
  type TranslationVerificationFile,
} from "./bilingual-model.js";
import { reconcileMarkers, splitOnMarkers } from "./bilingual-markers.js";
import {
  assertTranslatableEpub,
  resolveBodyElementPath,
  resolveRelativeElementPath,
} from "./bilingual-plan.js";
import {
  activePlanUnits,
  assertTranslationVerified,
} from "./bilingual-shard.js";

const BLOCKING_TRANSLATION_INTERNAL_CODES = new Set([
  "DUPLICATE_ID",
  "FOOTNOTE_BACKLINK",
  "MANIFEST_IDS",
  "MANIFEST_DUPLICATE",
  "MANIFEST_MISSING",
  "UNMANIFESTED_RESOURCE",
  "SPINE_INVALID",
  "SPINE_DUPLICATE",
  "XHTML_NAMESPACE",
  "EMPTY_DOCUMENT",
  "NAV_REQUIRED",
  "TOC_REQUIRED",
  "XML_INVALID",
  "OCF_CONTAINER",
  "OCF_ROOTFILE",
  "OPF_MISSING",
]);

const UUID_URL_NAMESPACE = Buffer.from(
  "6ba7b8119dad11d180b400c04fd430c8",
  "hex",
);

export function bilingualStylesheetCss(
  style: TranslationStyle = "paired",
): string {
  if (style === "plain") {
    return `/* Quillbind bilingual translation layout (plain): preserves reading-system typography, line-height and colors. */
.quillbind-source {
  margin-bottom: 0.25em;
  break-after: avoid;
  page-break-after: avoid;
}
.quillbind-translation {
  margin-top: 0.2em;
  margin-bottom: 0.9em;
}
span.quillbind-translation {
  display: inline;
  margin: 0;
}
`;
  }
  return `/* Quillbind bilingual translation layout: preserves reading-system typography, line-height and colors. */
.quillbind-source {
  margin-bottom: 0.25em;
  break-after: avoid;
  page-break-after: avoid;
}
.quillbind-translation {
  margin-top: 0.2em;
  margin-bottom: 0.9em;
  padding-inline-start: 0.7em;
  border-inline-start: 0.14em solid;
  text-indent: 0;
}
span.quillbind-translation {
  display: inline;
  margin: 0;
  padding: 0;
  border: 0;
}
`;
}

/** Derive a deterministic RFC 4122 UUIDv5 distinct from the source book's identifier. */
export function deriveBilingualUuid(
  sourceIdentifier: string,
  targetLanguage: string,
  mode: TranslationMode,
): string {
  const seed = `quillbind-bilingual|${sourceIdentifier.trim()}|${targetLanguage.trim().toLowerCase()}|${mode}`;
  const hash = crypto
    .createHash("sha1")
    .update(UUID_URL_NAMESPACE)
    .update(Buffer.from(seed, "utf8"))
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function appendClass(el: Element, className: string): void {
  const tokens = attr(el, "class").split(/\s+/u).filter(Boolean);
  if (!tokens.includes(className)) tokens.push(className);
  el.setAttribute("class", tokens.join(" "));
}

function setElementLang(el: Element, language: string, isEpub3: boolean): void {
  if (isEpub3) {
    el.setAttribute("lang", language);
  }
  el.setAttribute("xml:lang", language);
}

/** Strip duplicate IDs and bilingual-clone noteref annotations so footnotes keep unique targets. */
function sanitizeClonedNode(node: Node): void {
  if (node.nodeType !== 1) return;
  const el = node as Element;
  el.removeAttribute("id");
  el.removeAttribute("xml:id");
  const tag = (el.localName ?? "").toLowerCase();
  if (tag === "a") el.removeAttribute("name");
  const epubType = attr(el, "epub:type")
    .split(/\s+/u)
    .filter((t) => t && t !== "noteref" && t !== "pagebreak");
  if (el.hasAttribute("epub:type")) {
    if (epubType.length > 0) el.setAttribute("epub:type", epubType.join(" "));
    else el.removeAttribute("epub:type");
  }
  const role = attr(el, "role").trim();
  if (role === "doc-noteref" || role === "doc-pagebreak") {
    el.removeAttribute("role");
  }
  for (const child of Array.from(el.childNodes)) {
    sanitizeClonedNode(child);
  }
}

function cloneSafeMarker(
  doc: XmlDocument,
  markerEl: Element,
  bilingual: boolean,
): Element {
  const cloned = doc.importNode(markerEl, true) as Element;
  if (bilingual) sanitizeClonedNode(cloned);
  return cloned;
}

function populateTranslationElement(
  doc: XmlDocument,
  targetEl: Element,
  text: string,
  markerNodesByToken: Map<string, Element>,
  issuedTokens: readonly string[],
  bilingual: boolean,
): void {
  const segments = splitOnMarkers(text, issuedTokens);
  for (const seg of segments) {
    if (seg.kind === "text") {
      targetEl.appendChild(doc.createTextNode(seg.value));
    } else {
      const orig = markerNodesByToken.get(seg.value);
      if (orig) {
        targetEl.appendChild(cloneSafeMarker(doc, orig, bilingual));
      }
    }
  }
}

function resolveRestrictedHost(owner: Element): Element {
  const tag = (owner.localName ?? "").toLowerCase();
  if (tag === "li") {
    let cur: Node | null = owner.parentNode;
    let inNav = false;
    while (cur && cur.nodeType === 1) {
      if (((cur as Element).localName ?? "").toLowerCase() === "nav") {
        inNav = true;
        break;
      }
      cur = cur.parentNode;
    }
    if (inNav) {
      for (const child of Array.from(owner.childNodes)) {
        if (child.nodeType === 1) {
          const childTag = ((child as Element).localName ?? "").toLowerCase();
          if (childTag === "a" || childTag === "span") {
            return child as Element;
          }
        }
      }
    }
  }
  return owner;
}

function clearElementChildren(el: Element): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function createClonedBlockShell(
  doc: XmlDocument,
  owner: Element,
  targetLanguage: string,
  isEpub3: boolean,
): Element {
  const tag = (owner.localName ?? "p").toLowerCase();
  const clone = doc.createElementNS(owner.namespaceURI || NS.xhtml, tag);
  for (const a of Array.from(owner.attributes)) {
    const lower = a.name.toLowerCase();
    if (
      lower === "id" ||
      lower === "xml:id" ||
      lower === "lang" ||
      lower === "xml:lang" ||
      lower === "name"
    ) {
      continue;
    }
    if (lower === "class") {
      const kept = a.value
        .split(/\s+/u)
        .filter((tok) => tok && tok !== "quillbind-source");
      if (kept.length > 0) clone.setAttribute("class", kept.join(" "));
      continue;
    }
    if (lower === "epub:type") {
      const kept = a.value
        .split(/\s+/u)
        .filter((tok) => tok && tok !== "pagebreak" && tok !== "noteref");
      if (kept.length > 0) clone.setAttribute(a.name, kept.join(" "));
      continue;
    }
    if (
      lower === "role" &&
      (a.value === "doc-pagebreak" || a.value === "doc-noteref")
    ) {
      continue;
    }
    clone.setAttribute(a.name, a.value);
  }
  appendClass(clone, "quillbind-translation");
  setElementLang(clone, targetLanguage, isEpub3);
  return clone;
}

function ensureStylesheetLinked(
  doc: XmlDocument,
  docPath: string,
  cssPath: string,
): void {
  const head = elements(doc, "head", NS.xhtml)[0] ?? elements(doc, "head")[0];
  if (!head) return;
  const relHref = path.posix.relative(path.posix.dirname(docPath), cssPath);
  for (const link of elements(head, "link")) {
    if (attr(link, "rel") === "stylesheet" && attr(link, "href") === relHref) {
      return;
    }
  }
  const link = doc.createElementNS(NS.xhtml, "link");
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("type", "text/css");
  link.setAttribute("href", relHref);
  head.appendChild(link);
}

function allocateResourcePath(
  entries: ReadonlyMap<string, Uint8Array>,
  packageDir: string,
  baseName: string,
): { fullPath: string; relHref: string } {
  const joinPath = (name: string) =>
    packageDir && packageDir !== "." ? `${packageDir}/${name}` : name;
  let candidate = baseName;
  let n = 1;
  while (entries.has(joinPath(candidate))) {
    n += 1;
    const ext = path.posix.extname(baseName);
    const stem = baseName.slice(0, -ext.length);
    candidate = `${stem}-${n}${ext}`;
  }
  return { fullPath: joinPath(candidate), relHref: candidate };
}

function allocateManifestId(
  existingIds: ReadonlySet<string>,
  preferred: string,
): string {
  let id = preferred;
  let n = 1;
  while (existingIds.has(id)) {
    n += 1;
    id = `${preferred}-${n}`;
  }
  return id;
}

function updatePackageOpf(options: {
  info: EpubInspection;
  entries: Map<string, Uint8Array>;
  targetLanguage: string;
  mode: TranslationMode;
  bilingualCssHref?: string;
}): { derivedIdentifier: string } {
  const { info, entries, targetLanguage, mode, bilingualCssHref } = options;
  const opfDoc = xml(
    entries.get(info.packagePath)!.toString(),
    info.packagePath,
  );
  const pkgEl = opfDoc.documentElement!;
  const metadata = elements(opfDoc, "metadata", NS.opf)[0];
  const manifest = elements(opfDoc, "manifest", NS.opf)[0];
  if (!metadata || !manifest) {
    fail("OPF_INVALID", "Package document missing metadata or manifest");
  }

  const uidRef = attr(pkgEl, "unique-identifier");
  const identifiers = elements(metadata, "identifier", NS.dc);
  const primaryIdEl =
    identifiers.find((el) => attr(el, "id") === uidRef) ?? identifiers[0];
  const sourceIdentifier = primaryIdEl?.textContent?.trim() || info.sha256;
  const derivedIdentifier = deriveBilingualUuid(
    sourceIdentifier,
    targetLanguage,
    mode,
  );
  if (primaryIdEl) {
    primaryIdEl.textContent = derivedIdentifier;
    primaryIdEl.removeAttribute("opf:scheme");
    primaryIdEl.removeAttribute("scheme");
    const primaryIdAttr = attr(primaryIdEl, "id");
    if (primaryIdAttr) {
      for (const metaEl of elements(metadata, "meta", NS.opf)) {
        if (
          attr(metaEl, "refines") === `#${primaryIdAttr}` &&
          attr(metaEl, "property") === "identifier-type"
        ) {
          metaEl.parentNode?.removeChild(metaEl);
        }
      }
    }
  } else {
    const idEl = opfDoc.createElementNS(NS.dc, "dc:identifier");
    idEl.setAttribute("id", uidRef || "uid");
    idEl.textContent = derivedIdentifier;
    metadata.appendChild(idEl);
  }

  const existingSources = elements(metadata, "source", NS.dc).map((el) =>
    (el.textContent ?? "").trim(),
  );
  if (!existingSources.includes(sourceIdentifier)) {
    const srcEl = opfDoc.createElementNS(NS.dc, "dc:source");
    srcEl.textContent = sourceIdentifier;
    metadata.appendChild(srcEl);
  }

  const langEls = elements(metadata, "language", NS.dc);
  const lowerTarget = targetLanguage.toLowerCase();
  if (mode === "target-only") {
    if (langEls.length > 0) {
      langEls[0].textContent = targetLanguage;
    } else {
      const lEl = opfDoc.createElementNS(NS.dc, "dc:language");
      lEl.textContent = targetLanguage;
      metadata.appendChild(lEl);
    }
    if (pkgEl.hasAttribute("xml:lang")) {
      pkgEl.setAttribute("xml:lang", targetLanguage);
    }
  } else if (
    !langEls.some(
      (el) => (el.textContent ?? "").trim().toLowerCase() === lowerTarget,
    )
  ) {
    const lEl = opfDoc.createElementNS(NS.dc, "dc:language");
    lEl.textContent = targetLanguage;
    metadata.appendChild(lEl);
  }

  if (bilingualCssHref) {
    const existingIds = new Set(
      elements(manifest, "item", NS.opf).map((el) => attr(el, "id")),
    );
    const cssId = allocateManifestId(existingIds, "quillbind-bilingual-css");
    const item = opfDoc.createElementNS(NS.opf, "item");
    item.setAttribute("id", cssId);
    item.setAttribute("href", bilingualCssHref);
    item.setAttribute("media-type", "text/css");
    manifest.appendChild(item);
  }

  entries.set(info.packagePath, Buffer.from(serialize(opfDoc), "utf8"));
  return { derivedIdentifier };
}

function syncNcxNavigation(
  info: EpubInspection,
  entries: Map<string, Uint8Array>,
  derivedIdentifier: string,
  labelMap: ReadonlyMap<string, string>,
  mode: TranslationMode,
): void {
  for (const item of info.manifest) {
    if (item.mediaType !== "application/x-dtbncx+xml") continue;
    const raw = entries.get(item.path);
    if (!raw) continue;
    const ncxDoc = ncxXml(raw.toString(), item.path);
    let changed = false;
    for (const meta of elements(ncxDoc, "meta", NS.ncx)) {
      if (
        attr(meta, "name") === "dtb:uid" &&
        attr(meta, "content") !== derivedIdentifier
      ) {
        meta.setAttribute("content", derivedIdentifier);
        changed = true;
      }
    }
    if (labelMap.size > 0) {
      for (const label of elements(ncxDoc, "navLabel", NS.ncx)) {
        const textEl = elements(label, "text", NS.ncx)[0];
        if (!textEl) continue;
        const orig = (textEl.textContent ?? "").replace(/\s+/gu, " ").trim();
        const translated = labelMap.get(orig);
        if (!translated || translated === orig) continue;
        textEl.textContent =
          mode === "bilingual" ? `${orig} / ${translated}` : translated;
        changed = true;
      }
    }
    if (changed) {
      entries.set(item.path, Buffer.from(serialize(ncxDoc), "utf8"));
    }
  }
}

export interface BilingualRenderResult {
  bytes: Buffer;
  derivedIdentifier: string;
  translatedUnits: number;
  reconciledMarkers: number;
  bilingualStylesheet?: string;
}

/**
 * Deterministically inject verified translations into an EPUB archive without
 * mutating the source bytes.
 */
export function renderBilingualEpub(
  sourceBytes: Uint8Array,
  plan: TranslationPlan,
  merged: TranslationMergedFile,
  options: {
    planSha256: string;
    verification?: TranslationVerificationFile;
    style?: TranslationStyle;
    epoch?: number;
  },
): BilingualRenderResult {
  const info = inspectBytes(sourceBytes);
  assertTranslatableEpub(info);
  if (
    info.sha256 !== plan.source.sha256 ||
    info.sha256 !== merged.sourceSha256
  ) {
    fail(
      "TRANSLATION_SOURCE_MISMATCH",
      "Source EPUB SHA-256 does not match translation plan or merged translations",
    );
  }
  if (merged.planSha256 !== options.planSha256) {
    fail(
      "TRANSLATION_PLAN_MISMATCH",
      "Merged translations planSha256 does not match translation plan",
    );
  }
  assertTranslationVerified(merged, options.verification);

  const { activeUnits } = activePlanUnits(plan);
  const mode: TranslationMode = plan.mode;
  const style: TranslationStyle = options.style ?? "paired";
  const targetLanguage = plan.targetLanguage;
  const isEpub3 = info.version === "3.0";

  const entries = new Map<string, Uint8Array>(
    [...info.entries].map(([k, v]) => [k, Buffer.from(v.bytes)]),
  );

  let bilingualCssPath: string | undefined;
  let bilingualCssHref: string | undefined;
  if (mode === "bilingual" && activeUnits.length > 0) {
    const packageDir = path.posix.dirname(info.packagePath);
    const allocated = allocateResourcePath(
      entries,
      packageDir,
      "quillbind-bilingual.css",
    );
    bilingualCssPath = allocated.fullPath;
    bilingualCssHref = allocated.relHref;
    entries.set(
      bilingualCssPath,
      Buffer.from(bilingualStylesheetCss(style), "utf8"),
    );
  }

  const unitsByDoc = new Map<string, TranslationUnit[]>();
  for (const unit of activeUnits) {
    const list = unitsByDoc.get(unit.docPath) ?? [];
    list.push(unit);
    unitsByDoc.set(unit.docPath, list);
  }

  let translatedUnits = 0;
  let reconciledMarkers = 0;
  const ncxLabelMap = new Map<string, string>();

  for (const [docPath, docUnits] of unitsByDoc.entries()) {
    const raw = entries.get(docPath);
    if (!raw) continue;
    const doc = contentXml(raw.toString(), docPath);

    // Resolve every owner element and marker node BEFORE mutating the DOM tree.
    const resolved = docUnits.map((unit) => {
      const owner = resolveBodyElementPath(doc, unit.ownerPath);
      if (!owner) {
        fail(
          "TRANSLATION_DOM_ANCHOR_MISSING",
          `Could not resolve unit "${unit.id}" owner path "${unit.ownerPath}" in ${docPath}`,
        );
      }
      const markerMap = new Map<string, Element>();
      for (const m of unit.markers) {
        const el = resolveRelativeElementPath(owner, m.ownerChildPath);
        if (el) markerMap.set(m.token, el);
      }
      return { unit, owner, markerMap };
    });

    const countByOwner = new Map<Element, number>();
    for (const item of resolved) {
      countByOwner.set(item.owner, (countByOwner.get(item.owner) ?? 0) + 1);
    }

    for (const { unit, owner, markerMap } of resolved) {
      const rawTranslation = merged.translations[unit.id];
      if (typeof rawTranslation !== "string" || !rawTranslation.trim()) {
        fail(
          "TRANSLATION_UNIT_MISSING",
          `Missing translation for active unit "${unit.id}"`,
        );
      }
      const issued = unit.markers.map((m) => m.token);
      const rec = reconcileMarkers(unit.sourceText, rawTranslation, issued);
      if (
        rec.missing.length > 0 ||
        rec.invented.length > 0 ||
        rec.duplicates.length > 0
      ) {
        reconciledMarkers += 1;
      }
      const finalText = rec.text.trim();
      if (!finalText) continue;

      if (
        unit.markers.length === 0 &&
        (unit.tag.startsWith("h") || unit.tag === "li")
      ) {
        if (!ncxLabelMap.has(unit.sourceText)) {
          ncxLabelMap.set(unit.sourceText, finalText);
        }
      }

      const ownerHasMultipleRuns = (countByOwner.get(owner) ?? 1) > 1;
      if (ownerHasMultipleRuns) {
        // Safe append for mixed block containers that also hold child blocks.
        const span = doc.createElementNS(NS.xhtml, "span");
        span.setAttribute("class", "quillbind-translation");
        setElementLang(span, targetLanguage, isEpub3);
        populateTranslationElement(
          doc,
          span,
          finalText,
          markerMap,
          issued,
          true,
        );
        owner.appendChild(doc.createTextNode(" "));
        owner.appendChild(span);
        translatedUnits += 1;
        continue;
      }

      if (unit.restrictedContentModel) {
        const host = resolveRestrictedHost(owner);
        if (mode === "bilingual") {
          const br = doc.createElementNS(NS.xhtml, "br");
          const span = doc.createElementNS(NS.xhtml, "span");
          span.setAttribute("class", "quillbind-translation");
          setElementLang(span, targetLanguage, isEpub3);
          populateTranslationElement(
            doc,
            span,
            finalText,
            markerMap,
            issued,
            true,
          );
          host.appendChild(br);
          host.appendChild(span);
        } else {
          clearElementChildren(host);
          setElementLang(host, targetLanguage, isEpub3);
          populateTranslationElement(
            doc,
            host,
            finalText,
            markerMap,
            issued,
            false,
          );
        }
        translatedUnits += 1;
        continue;
      }

      if (mode === "bilingual") {
        appendClass(owner, "quillbind-source");
        const clone = createClonedBlockShell(
          doc,
          owner,
          targetLanguage,
          isEpub3,
        );
        populateTranslationElement(
          doc,
          clone,
          finalText,
          markerMap,
          issued,
          true,
        );
        owner.parentNode?.insertBefore(clone, owner.nextSibling);
      } else {
        clearElementChildren(owner);
        setElementLang(owner, targetLanguage, isEpub3);
        populateTranslationElement(
          doc,
          owner,
          finalText,
          markerMap,
          issued,
          false,
        );
      }
      translatedUnits += 1;
    }

    if (mode === "target-only" && doc.documentElement) {
      setElementLang(doc.documentElement, targetLanguage, isEpub3);
    }
    if (bilingualCssPath) {
      ensureStylesheetLinked(doc, docPath, bilingualCssPath);
    }
    entries.set(docPath, Buffer.from(serialize(doc), "utf8"));
  }

  const { derivedIdentifier } = updatePackageOpf({
    info,
    entries,
    targetLanguage,
    mode,
    bilingualCssHref,
  });

  syncNcxNavigation(info, entries, derivedIdentifier, ncxLabelMap, mode);

  const outBytes = pack(entries, options.epoch ?? 946684800);
  inspectBytes(outBytes, true);

  return {
    bytes: outBytes,
    derivedIdentifier,
    translatedUnits,
    reconciledMarkers,
    ...(bilingualCssPath ? { bilingualStylesheet: bilingualCssPath } : {}),
  };
}

export async function buildBilingualEpub(
  sourceFile: string,
  outputFile: string,
  options: {
    plan: string;
    translations: string;
    verification: string;
    style?: TranslationStyle;
    reports?: string;
    release?: boolean;
    signal?: AbortSignal;
  },
) {
  checkAbort(options.signal);
  const resolvedSource = path.resolve(sourceFile);
  const resolvedOutput = path.resolve(outputFile);
  if (resolvedSource === resolvedOutput || (await exists(resolvedOutput))) {
    fail(
      "OUTPUT_EXISTS",
      "Translation output must be a new path; original EPUB is protected",
    );
  }

  const [sourceBytes, planBytes, mergedRaw, verificationBytes] =
    await Promise.all([
      readSourceFile(resolvedSource),
      readSourceFile(path.resolve(options.plan)),
      readJson<unknown>(path.resolve(options.translations)),
      readSourceFile(path.resolve(options.verification)),
    ]);

  const planSha256 = sha256(planBytes);
  const verificationFileSha256 = sha256(verificationBytes);
  const plan = translationPlanSchema.parse(
    JSON.parse(planBytes.toString("utf8")),
  );
  const merged = translationMergedFileSchema.parse(mergedRaw);
  const verification = translationVerificationFileSchema.parse(
    JSON.parse(verificationBytes.toString("utf8")),
  );

  const style: TranslationStyle = options.style ?? "paired";
  const reportsDir = options.reports
    ? path.resolve(options.reports)
    : `${resolvedOutput}.reports`;
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });

  const candidate = `${resolvedOutput}.${Date.now()}.candidate.epub`;
  try {
    if (options.release) {
      const env = await doctor();
      await json(path.join(reportsDir, "environment.json"), env);
      if (env.status === "fail") {
        fail(
          "ENVIRONMENT_ERROR",
          "Required toolchain is unavailable",
          env.checks,
        );
      }
    }

    const first = renderBilingualEpub(sourceBytes, plan, merged, {
      planSha256,
      verification,
      style,
    });
    const second = renderBilingualEpub(sourceBytes, plan, merged, {
      planSha256,
      verification,
      style,
    });
    const firstSha = sha256(first.bytes);
    const secondSha = sha256(second.bytes);
    if (firstSha !== secondSha) {
      fail(
        "NONDETERMINISTIC_BUILD",
        "Repeated bilingual EPUB renders produced different bytes",
      );
    }

    await fs.writeFile(candidate, first.bytes, { flag: "wx" });
    checkAbort(options.signal);

    const outInfo = inspectBytes(first.bytes, true);
    if (first.bilingualStylesheet) {
      const cssBytes = outInfo.entries.get(first.bilingualStylesheet)?.bytes;
      const cssCheck = lintCss(
        cssBytes?.toString("utf8") ?? "",
        first.bilingualStylesheet,
      );
      if (cssCheck.status !== "pass") {
        fail(
          "BILINGUAL_CSS_INVALID",
          `Generated bilingual stylesheet failed lintCss: ${cssCheck.diagnostics.map((d) => d.message).join("; ")}`,
          cssCheck.diagnostics,
        );
      }
    }
    const internal =
      outInfo.version === "3.0"
        ? validateInternal(outInfo)
        : { status: "pass" as const, diagnostics: [] };
    const blockingInternal = internal.diagnostics.filter((d) =>
      BLOCKING_TRANSLATION_INTERNAL_CODES.has(d.code),
    );
    if (blockingInternal.length > 0) {
      fail(
        "EPUB_VALIDATION_FAILED",
        `Translated EPUB structural validation failed: ${blockingInternal.map((d) => `${d.code}: ${d.message}`).join("; ")}`,
        blockingInternal,
      );
    }

    let validationReport: unknown;
    let readingReport: unknown;
    let releaseReport: unknown;

    if (options.release) {
      const reporter = new ReleaseReporter(
        reportsDir,
        "convert",
        resolvedSource,
      );
      await reporter.save();
      releaseReport = await releaseGates(candidate, reportsDir, {
        signal: options.signal,
        reporter,
      });
      validationReport = { status: "pass", mode: "release-gates" };
      await reporter.finish({
        path: resolvedOutput,
        sha256: firstSha,
        size: first.bytes.length,
        mediaType: "application/epub+zip",
      });
    } else {
      const epubcheck = await checkEpubConformance(candidate, {
        reports: reportsDir,
        signal: options.signal,
      });
      await json(path.join(reportsDir, "epubcheck.json"), epubcheck);
      if (epubcheck.status !== "pass") {
        fail(
          "EPUBCHECK_FAILED",
          "EPUBCheck reported errors or warnings on translated EPUB",
          epubcheck,
        );
      }
      readingReport = await readingQa(
        outInfo,
        path.join(reportsDir, "reading"),
        options.signal,
      );
      const sourceFindings = internal.diagnostics.filter(
        (d) => !BLOCKING_TRANSLATION_INTERNAL_CODES.has(d.code),
      );
      validationReport = {
        status: "pass",
        internal: blockingInternal.length === 0 ? "pass" : "fail",
        epubcheck: epubcheck.status,
        ...(sourceFindings.length > 0 ? { sourceFindings } : {}),
      };
    }

    checkAbort(options.signal);
    await fs.link(candidate, resolvedOutput);

    const report = {
      status: "pass" as const,
      operation: "epub-translate-build" as const,
      source: resolvedSource,
      sourceSha256: plan.source.sha256,
      output: resolvedOutput,
      outputSha256: firstSha,
      planSha256,
      derivedIdentifier: first.derivedIdentifier,
      sourceLanguage: plan.source.sourceLanguage,
      targetLanguage: plan.targetLanguage,
      mode: plan.mode,
      style,
      ...(first.bilingualStylesheet
        ? { bilingualStylesheet: first.bilingualStylesheet }
        : {}),
      translatedUnits: first.translatedUnits,
      reconciledMarkers: first.reconciledMarkers,
      coverage: plan.coverage,
      reproducible: true,
      verification: {
        verifierId: verification.verifierId,
        verificationFileSha256,
        shardCount: verification.shards.length,
      },
      validation: validationReport,
      ...(readingReport ? { reading: readingReport } : {}),
      ...(releaseReport ? { gates: releaseReport } : {}),
      publicationReady: Boolean(options.release),
      releaseGates: options.release ? "pass" : "not-run",
      reports: reportsDir,
    };
    await json(path.join(reportsDir, "translation.json"), report);
    return report;
  } finally {
    await fs.rm(candidate, { force: true });
  }
}
