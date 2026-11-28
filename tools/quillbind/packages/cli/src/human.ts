import { stable } from "@quillbind/core/json";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const optionalText = (value: unknown): string =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"
    ? String(value)
    : "";

function formatCheckNotes(item: Record<string, unknown>): string {
  const notes = record(item.notes);
  const coverage = record(item.coverage);
  const interactions = record(item.interactions);
  const findings = Array.isArray(interactions.findings)
    ? interactions.findings.map(record)
    : [];
  const issues = Array.isArray(notes.issues) ? notes.issues.map(record) : [];
  const reasonText = optionalText(interactions.reason);
  const reasonSuffix = reasonText ? ` — ${reasonText}` : "";
  const issueLines = [...issues, ...findings]
    .map((f) => `[${optionalText(f.code)}] ${optionalText(f.message)}`)
    .join("\n");
  const reportJson = optionalText(record(item.reports).json);
  const reportLine = reportJson ? `Report: ${reportJson}\n` : "";
  return `Popup notes: ${optionalText(item.status).toUpperCase()}\nSHA-256: ${optionalText(item.inputSha256)}\nReferences: ${optionalText(coverage.identifiedReferences)}; cases: ${optionalText(coverage.selectedCases)} (${optionalText(coverage.selection)}, completeness: ${optionalText(coverage.completeness)})\nInteractions: ${optionalText(interactions.status)}${reasonSuffix}\n${issueLines}\n${reportLine}Original unchanged. EPUB publication and native reader behavior are not verified by this check.\n`;
}

function formatNovelInspect(item: Record<string, unknown>): string {
  const volumes = Array.isArray(item.volumes) ? item.volumes.map(record) : [];
  const volumeLines = volumes
    .map((volume) => {
      const count = Array.isArray(volume.chapters) ? volume.chapters.length : 0;
      return `${optionalText(volume.number)}. ${optionalText(volume.title)} (${count} chapters)`;
    })
    .join("\n");
  return `${optionalText(item.title)}\nSource: ${optionalText(item.url)}\n${volumeLines}\n`;
}

function formatNovelFetch(item: Record<string, unknown>): string {
  const projects = Array.isArray(item.projects)
    ? item.projects.map(record)
    : [];
  const projectLines = projects
    .map((project) => {
      const artifact = record(project.artifact);
      const artifactPath = optionalText(artifact.path);
      if (artifactPath) {
        return `Released: ${artifactPath}\nSHA-256: ${optionalText(artifact.sha256)}\nSummary: ${optionalText(record(project.reports).summaryMarkdown)}`;
      }
      return `Prepared: ${optionalText(project.root)}\nMetadata: ${optionalText(record(project.readiness).metadata)}\nRelease checks: not run. Run quillbind build on this directory to publish.`;
    })
    .join("\n");
  return `Novel: ${optionalText(item.status).toUpperCase()}\nDirectory: ${optionalText(item.root)}\n${projectLines}\nReport: ${optionalText(item.report)}\n`;
}

function formatMangaPackage(item: Record<string, unknown>): string {
  const artifact = record(item.artifact);
  const pages = Array.isArray(item.pages) ? item.pages : [];
  return `Manga: ${optionalText(item.status).toUpperCase()}\nCBZ: ${optionalText(artifact.path)}\nPages: ${pages.length}\nSHA-256: ${optionalText(artifact.sha256)}\nOriginal release date: ${optionalText(record(item.metadata).releaseDate)}\nReport: ${optionalText(record(item.reports).json)}\n${optionalText(item.readerCompatibility)}\n`;
}

function formatQaProjection(item: Record<string, unknown>): string {
  const projection = record(item.qaProjection);
  if (typeof projection.cases !== "number") return "";
  const screenshots = record(projection.screenshots);
  const estimatedBytes = record(screenshots.estimatedPassingBytes);
  const low = (Number(estimatedBytes.low) / 1048576).toFixed(1);
  const high = (Number(estimatedBytes.high) / 1048576).toFixed(1);
  return `QA projection (${optionalText(projection.strategy)}): ${projection.cases} cases; full matrix on ${optionalText(projection.fullMatrixDocuments)}/${optionalText(projection.documents)} documents. Passing screenshots: ${optionalText(screenshots.passing)}, approximately ${low}–${high} MiB; failures add evidence.\n`;
}

function appendOperationDetails(
  item: Record<string, unknown>,
  lines: string[],
): void {
  if (item.operation === "bookwalker-metadata") {
    const meta = record(item.metadata);
    lines.push(
      `Source lock: ${optionalText(item.lock)}`,
      `Original release date: ${optionalText(meta.releaseDate)} (${optionalText(meta.dateBasis)})`,
    );
  } else if (item.operation === "bookwalker-search") {
    const count = Array.isArray(item.candidates) ? item.candidates.length : 0;
    lines.push(
      `Search lock: ${optionalText(item.lock)}`,
      `Candidates: ${count}`,
    );
  } else if (item.operation === "cover-fetch") {
    lines.push(
      `Cover: ${optionalText(item.output)}`,
      `Source lock: ${optionalText(item.lock)}`,
    );
  } else if (
    item.operation === "catalog-metadata" ||
    item.operation === "edition-metadata"
  ) {
    lines.push(`Source lock: ${optionalText(item.lock)}`);
  }
}

function appendSubjectAndFormatLists(
  command: string,
  item: Record<string, unknown>,
  lines: string[],
): void {
  for (const [key, label] of [
    ["inputs", "Inputs"],
    ["outputs", "Outputs"],
    ["epubInputModes", "EPUB maintenance"],
    ["pdfInputModes", "PDF tools"],
  ]) {
    if (Array.isArray(item[key])) {
      lines.push(`${label}: ${item[key].join(", ")}`);
    }
  }
  if (
    typeof item.classification === "string" &&
    typeof item.pageCount === "number"
  ) {
    lines.push(
      `PDF classification: ${item.classification} (${item.pageCount} pages)`,
    );
  }
  if (typeof item.renderManifestPath === "string") {
    lines.push(`Render manifest: ${item.renderManifestPath}`);
  }
  if (Array.isArray(item.shards)) {
    lines.push(`Shards: ${item.shards.length}`);
  }
  if (typeof item.targetLanguage === "string") {
    lines.push(`Target language: ${item.targetLanguage}`);
  }
  if (
    typeof item.undecidedSignatures === "number" &&
    item.undecidedSignatures > 0
  ) {
    lines.push(`Undecided signatures: ${item.undecidedSignatures}`);
  }
  if (Array.isArray(item.unverifiedPages) && item.unverifiedPages.length > 0) {
    lines.push(
      `Pages requiring verification: ${item.unverifiedPages.join(", ")}`,
    );
  }
  if (Array.isArray(item.subjects)) {
    for (const subject of item.subjects) {
      const tag = record(subject);
      lines.push(`${optionalText(tag.id)}: ${optionalText(tag.label)}`);
    }
    return;
  }
  if (command === "taxonomy" && item.id) {
    const description = optionalText(item.description);
    lines.push(
      `${optionalText(item.id)}: ${optionalText(item.label)}`,
      ...(description ? [description] : []),
    );
  }
}

function appendChecksAndActions(
  item: Record<string, unknown>,
  lines: string[],
): void {
  if (Array.isArray(item.checks)) {
    for (const entry of item.checks) {
      const check = record(entry);
      const version = optionalText(check.version);
      const detail = optionalText(check.detail);
      const versionPart = version ? ` (${version})` : "";
      const detailPart = detail ? ` — ${detail}` : "";
      lines.push(
        `${optionalText(check.tool)}: ${optionalText(check.status)}${versionPart}${detailPart}`,
      );
    }
  }
  const internalStatus = optionalText(record(item.internal).status);
  if (internalStatus) lines.push(`Internal validation: ${internalStatus}`);
  const epubcheck = record(item.epubcheck);
  if (epubcheck.version) {
    lines.push(
      `EPUBCheck: ${optionalText(epubcheck.version)} (exit ${optionalText(epubcheck.exitCode)})`,
    );
  }
  const validationStatus = optionalText(record(item.validation).status);
  if (validationStatus) lines.push(`Validation: ${validationStatus}`);
  const actions = item.actions ?? record(item.plan).actions;
  if (Array.isArray(actions)) {
    for (const action of actions) {
      const entry = record(action);
      lines.push(
        `[${optionalText(entry.classification)}] ${optionalText(entry.ruleId)} — ${optionalText(entry.resource)}: ${optionalText(entry.message)}`,
      );
    }
  }
}

function collectDiagnostics(value: unknown, diagnostics: Set<string>): void {
  if (Array.isArray(value)) {
    for (const element of value) collectDiagnostics(element, diagnostics);
    return;
  }
  const entry = record(value);
  const severity = optionalText(entry.severity);
  const message = optionalText(entry.message);
  if (severity && message) {
    const code = optionalText(entry.code ?? entry.ID);
    const source = optionalText(entry.source);
    const sourcePrefix = source ? `${source}: ` : "";
    diagnostics.add(`[${severity} ${code}] ${sourcePrefix}${message}`);
  }
  for (const key of [
    "diagnostics",
    "messages",
    "details",
    "internal",
    "validation",
    "epubcheck",
    "metadata",
  ]) {
    if (entry[key]) collectDiagnostics(entry[key], diagnostics);
  }
}

function appendReportsAndFooter(
  item: Record<string, unknown>,
  lines: string[],
): void {
  const reports = record(item.reports);
  if (item.operation === "repair-directory") {
    lines.push(
      `Reading copies: ${optionalText(item.repaired)}/${optionalText(item.total)}; failed: ${optionalText(item.failed)}`,
      `Index: ${optionalText(reports.markdown)}`,
      `Report: ${optionalText(reports.json)}`,
      "Publication ready: false",
    );
  }
  const summaryMarkdown = optionalText(reports.summaryMarkdown);
  if (summaryMarkdown) lines.push(`Summary: ${summaryMarkdown}`);
  if (Array.isArray(item.requiredFields)) {
    lines.push(`Required fields: ${item.requiredFields.join(", ")}`);
  }
}

function formatSpecialOperation(item: Record<string, unknown>): string | null {
  if (item.operation === "check-notes") return formatCheckNotes(item);
  if (item.operation === "novel-inspect") return formatNovelInspect(item);
  if (item.operation === "novel-fetch") return formatNovelFetch(item);
  if (item.operation === "manga-package") return formatMangaPackage(item);
  return null;
}

function appendHeaderLines(
  command: string,
  item: Record<string, unknown>,
  qaProjection: string,
  lines: string[],
): void {
  if (typeof item.code === "string" && typeof item.message === "string") {
    lines.push(`Error [${item.code}]: ${item.message}`);
  } else {
    const statusText = optionalText(item.status) || "ok";
    lines.push(`${command}: ${statusText.toUpperCase()}`);
  }
  if (Array.isArray(item.documents))
    lines.push(`Chapters: ${item.documents.length}`);
  if (qaProjection) lines.push(qaProjection.trimEnd());
  if (Array.isArray(item.cases))
    lines.push(`Browser cases: ${item.cases.length}`);
  if (typeof item.root === "string") lines.push(`Directory: ${item.root}`);
}

function appendMetadataHeadline(
  item: Record<string, unknown>,
  lines: string[],
): void {
  if (typeof item.metadata === "string") {
    lines.push(item.metadata);
    return;
  }
  const title = record(item.metadata).title;
  if (typeof title === "string") lines.push(`Title: ${title}`);
}

/** Keep source trees and tool payloads in --json, and show actionable evidence here. */
export function formatHuman(command: string, value: unknown): string {
  if (command === "schema") return stable(value);
  if (typeof value === "string") return value + "\n";
  const item = record(value);
  const special = formatSpecialOperation(item);
  if (special !== null) return special;
  const qaProjection = formatQaProjection(item);
  if (item.status === "preview") {
    const candidate = record(item.candidate);
    return `Preview: ${optionalText(candidate.path)}\nSHA-256: ${optionalText(candidate.sha256)}\nRelease checks: not run. This candidate is for author review.\n${qaProjection}`;
  }
  const lines: string[] = [];
  appendHeaderLines(command, item, qaProjection, lines);
  appendOperationDetails(item, lines);
  appendMetadataHeadline(item, lines);
  appendSubjectAndFormatLists(command, item, lines);
  appendChecksAndActions(item, lines);
  const diagnostics = new Set<string>();
  collectDiagnostics(item, diagnostics);
  lines.push(...diagnostics);
  appendReportsAndFooter(item, lines);
  return lines.join("\n") + "\n";
}
