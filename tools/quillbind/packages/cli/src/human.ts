import { stable } from "@quillbind/core/json";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Keep source trees and tool payloads in --json, and show actionable evidence here. */
export function formatHuman(command: string, value: unknown): string {
  if (command === "schema") return stable(value);
  if (typeof value === "string") return value + "\n";
  const item = record(value);
  if (item.operation === "check-notes") {
    const notes = record(item.notes),
      coverage = record(item.coverage),
      interactions = record(item.interactions);
    const findings = Array.isArray(interactions.findings)
      ? interactions.findings.map(record)
      : [];
    const issues = Array.isArray(notes.issues) ? notes.issues.map(record) : [];
    return `Popup notes: ${String(item.status).toUpperCase()}\nSHA-256: ${item.inputSha256}\nReferences: ${coverage.identifiedReferences}; cases: ${coverage.selectedCases} (${coverage.selection}, completeness: ${coverage.completeness})\nInteractions: ${interactions.status}${interactions.reason ? ` — ${interactions.reason}` : ""}\n${[...issues, ...findings].map((f) => `[${f.code}] ${f.message}`).join("\n")}\n${record(item.reports).json ? `Report: ${record(item.reports).json}\n` : ""}Original unchanged. EPUB publication and native reader behavior are not verified by this check.\n`;
  }
  if (item.operation === "novel-inspect") {
    const volumes = Array.isArray(item.volumes) ? item.volumes.map(record) : [];
    return `${item.title}\nSource: ${item.url}\n${volumes.map((volume) => `${volume.number}. ${volume.title} (${Array.isArray(volume.chapters) ? volume.chapters.length : 0} chapters)`).join("\n")}\n`;
  }
  if (item.operation === "novel-fetch") {
    const projects = Array.isArray(item.projects)
      ? item.projects.map(record)
      : [];
    return `Novel: ${String(item.status).toUpperCase()}\nDirectory: ${item.root}\n${projects
      .map((project) => {
        const artifact = record(project.artifact);
        return artifact.path
          ? `Released: ${artifact.path}\nSHA-256: ${artifact.sha256}\nSummary: ${record(project.reports).summaryMarkdown}`
          : `Prepared: ${project.root}\nMetadata: ${record(project.readiness).metadata}\nRelease checks: not run. Run quillbind build on this directory to publish.`;
      })
      .join("\n")}\nReport: ${item.report}\n`;
  }
  if (item.operation === "manga-package") {
    const artifact = record(item.artifact),
      pages = Array.isArray(item.pages) ? item.pages : [];
    return `Manga: ${String(item.status).toUpperCase()}\nCBZ: ${artifact.path}\nPages: ${pages.length}\nSHA-256: ${artifact.sha256}\nOriginal release date: ${record(item.metadata).releaseDate}\nReport: ${record(item.reports).json}\n${item.readerCompatibility}\n`;
  }
  const projection = record(item.qaProjection);
  const screenshots = record(projection.screenshots);
  const estimatedBytes = record(screenshots.estimatedPassingBytes);
  const qaProjection =
    typeof projection.cases === "number"
      ? `QA projection (${projection.strategy}): ${projection.cases} cases; full matrix on ${projection.fullMatrixDocuments}/${projection.documents} documents. Passing screenshots: ${screenshots.passing}, approximately ${(Number(estimatedBytes.low) / 1048576).toFixed(1)}–${(Number(estimatedBytes.high) / 1048576).toFixed(1)} MiB; failures add evidence.\n`
      : "";
  const lines: string[] = [];
  if (item.status === "preview") {
    const candidate = record(item.candidate);
    return `Preview: ${candidate.path}\nSHA-256: ${candidate.sha256}\nRelease checks: not run. This candidate is for author review.\n${qaProjection}`;
  }
  if (typeof item.code === "string" && typeof item.message === "string")
    lines.push(`Error [${item.code}]: ${item.message}`);
  else lines.push(`${command}: ${String(item.status ?? "ok").toUpperCase()}`);
  if (Array.isArray(item.documents))
    lines.push(`Chapters: ${item.documents.length}`);
  if (qaProjection) lines.push(qaProjection.trimEnd());
  if (Array.isArray(item.cases))
    lines.push(`Browser cases: ${item.cases.length}`);
  if (typeof item.root === "string") lines.push(`Directory: ${item.root}`);
  if (item.operation === "bookwalker-metadata")
    lines.push(
      `Source lock: ${item.lock}`,
      `Original release date: ${record(item.metadata).releaseDate} (${record(item.metadata).dateBasis})`,
    );
  if (typeof item.metadata === "string") lines.push(item.metadata);
  else if (typeof record(item.metadata).title === "string")
    lines.push(`Title: ${record(item.metadata).title}`);
  for (const [key, label] of [
    ["inputs", "Inputs"],
    ["outputs", "Outputs"],
    ["epubInputModes", "EPUB maintenance"],
  ])
    if (Array.isArray(item[key]))
      lines.push(`${label}: ${item[key].join(", ")}`);
  if (Array.isArray(item.subjects))
    for (const subject of item.subjects) {
      const tag = record(subject);
      lines.push(`${tag.id}: ${tag.label}`);
    }
  else if (command === "taxonomy" && item.id)
    lines.push(
      `${item.id}: ${item.label}`,
      ...(item.description ? [String(item.description)] : []),
    );
  if (Array.isArray(item.checks))
    for (const entry of item.checks) {
      const check = record(entry);
      lines.push(
        `${check.tool}: ${check.status}${check.version ? ` (${check.version})` : ""}${check.detail ? ` — ${check.detail}` : ""}`,
      );
    }
  if (record(item.internal).status)
    lines.push(`Internal validation: ${record(item.internal).status}`);
  if (record(item.epubcheck).version)
    lines.push(
      `EPUBCheck: ${record(item.epubcheck).version} (exit ${record(item.epubcheck).exitCode})`,
    );
  if (record(item.validation).status)
    lines.push(`Validation: ${record(item.validation).status}`);
  const actions = item.actions ?? record(item.plan).actions;
  if (Array.isArray(actions))
    for (const action of actions) {
      const entry = record(action);
      lines.push(
        `[${entry.classification}] ${entry.ruleId} — ${entry.resource}: ${entry.message}`,
      );
    }
  const diagnostics = new Set<string>();
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    const entry = record(value);
    if (entry.severity && entry.message)
      diagnostics.add(
        `[${entry.severity} ${entry.code ?? entry.ID ?? ""}] ${entry.source ? `${entry.source}: ` : ""}${entry.message}`,
      );
    for (const key of [
      "diagnostics",
      "messages",
      "details",
      "internal",
      "validation",
      "epubcheck",
      "metadata",
    ])
      if (entry[key]) collect(entry[key]);
  };
  collect(item);
  lines.push(...diagnostics);
  const reports = record(item.reports);
  if (item.operation === "repair-directory")
    lines.push(
      `Reading copies: ${item.repaired}/${item.total}; failed: ${item.failed}`,
      `Index: ${reports.markdown}`,
      `Report: ${reports.json}`,
      "Publication ready: false",
    );
  if (reports.summaryMarkdown)
    lines.push(`Summary: ${reports.summaryMarkdown}`);
  if (Array.isArray(item.requiredFields))
    lines.push(`Required fields: ${item.requiredFields.join(", ")}`);
  return lines.join("\n") + "\n";
}
