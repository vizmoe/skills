import fs from "node:fs/promises";
import path from "node:path";
import { splitSource, type SplitSource } from "./split-source.js";
import { splitPlanSchema } from "./split-model.js";
import { splitPackage } from "./split-package.js";
import { taxonomy } from "./config.js";
import { attr, elements, NS } from "./xml.js";
import { sha256 } from "./hash.js";
import { stable, json } from "./json.js";
import { checkAbort, fail } from "./errors.js";
import { readSourceFile } from "./files.js";
import { inspectBytes } from "./epub.js";
import { checkEpubConformance } from "./validate.js";
import { readingQa } from "./reading-qa.js";
import { coverQa } from "./cover-qa.js";
import { coverImage } from "./cover-image.js";
import type { z } from "zod";

export type SplitPlan = Omit<z.infer<typeof splitPlanSchema>, "inventory"> & {
  inventory: SplitSource["inventory"];
};
export async function auditSplit(
  bytes: Buffer,
  options: { modified?: string } = {},
): Promise<SplitPlan> {
  const source = splitSource(bytes),
    vocabulary = await taxonomy();
  return {
    schemaVersion: 1,
    operation: "split",
    sourceSha256: sha256(bytes),
    vocabularyVersion: vocabulary.version,
    modified:
      options.modified ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    inventory: source.inventory,
    volumes: [],
    omit: [],
    omitNotes: [],
    crossLinks: [],
  };
}
export async function applySplit(bytes: Buffer, value: unknown) {
  const parsed = splitPlanSchema.safeParse(value);
  if (!parsed.success)
    fail("SPLIT_PLAN", "Invalid split plan", parsed.error.issues);
  const plan = parsed.data;
  if (plan.sourceSha256 !== sha256(bytes))
    fail("SPLIT_STALE", "Source hash differs from the split plan");
  const source = splitSource(bytes),
    vocabulary = await taxonomy();
  if (plan.vocabularyVersion !== vocabulary.version)
    fail(
      "SPLIT_VOCABULARY",
      "Selected library vocabulary changed; audit and review tags again",
    );
  if (stable(plan.inventory) !== stable(source.inventory))
    fail("SPLIT_INVENTORY", "Source inventory must not be edited");
  const labels = new Set(
    vocabulary.subjects
      .filter((subject) => !subject.deprecated)
      .map((subject) => subject.id),
  );
  const identities = new Set<string>(),
    keys = new Set<string>(),
    assigned = new Map<string, string>();
  const sourceId = attr(
      source.info.packageDocument.documentElement!,
      "unique-identifier",
    ),
    primary = elements(source.info.packageDocument, "identifier", NS.dc)
      .find((node) => attr(node, "id") === sourceId)
      ?.textContent?.toLowerCase();
  const decisions = new Set<string>();
  for (const item of plan.crossLinks) {
    const key = stable([item.source, item.id, item.href]);
    if (decisions.has(key))
      fail("SPLIT_LINK", "Duplicate cross-volume link decision");
    decisions.add(key);
  }
  let previous = -1;
  const selections = plan.volumes.map((volume) => {
    const identity = volume.metadata.identifier.toLowerCase();
    if (identities.has(identity) || identity === primary)
      fail(
        "SPLIT_IDENTITY",
        "Each volume requires its own stable identifier, distinct from the bundle",
      );
    identities.add(identity);
    if (keys.has(volume.key)) fail("SPLIT_KEY", "Duplicate volume output key");
    keys.add(volume.key);
    if (
      new Set(volume.metadata.tags).size !== volume.metadata.tags.length ||
      volume.metadata.tags.some((tag) => !labels.has(tag))
    )
      fail(
        "SPLIT_TAGS",
        "Use exact, distinct labels from the current library vocabulary",
      );
    const from = source.units.findIndex((unit) => unit.key === volume.from),
      through = source.units.findIndex((unit) => unit.key === volume.through);
    if (from < 0 || through < from)
      fail("SPLIT_BOUNDARY", "Missing or reversed volume boundaries");
    if (from <= previous)
      fail(
        "SPLIT_OVERLAP",
        "Volume boundaries overlap or reverse source reading order",
      );
    previous = through;
    if (
      !source.units[from].boundary ||
      (source.units[through + 1]?.path === source.units[through].path &&
        !source.units[through + 1].boundary)
    )
      fail(
        "SPLIT_BOUNDARY",
        "A shared-document cut requires a reliable block/container anchor; inspect and prepare the source boundary",
      );
    const selected = source.units.slice(from, through + 1);
    for (const unit of selected) {
      if (assigned.has(unit.key))
        fail("SPLIT_OVERLAP", `Duplicate content unit ${unit.key}`);
      assigned.set(unit.key, volume.key);
    }
    for (const cover of source.inspection.covers)
      if (
        cover.target.path &&
        source.info.documents.has(cover.target.path) &&
        selected.some((unit) => unit.path === cover.target.path) &&
        volume.metadata.cover?.document !== cover.target.path
      )
        fail(
          "SPLIT_COVER",
          "Selected bundle cover needs per-volume evidence or an explicit unit exclusion",
        );
    return selected;
  });
  const omitted = new Set<string>();
  for (const item of plan.omit) {
    if (
      !source.units.some((unit) => unit.key === item.unit) ||
      assigned.has(item.unit) ||
      omitted.has(item.unit)
    )
      fail(
        "SPLIT_OMISSION",
        "Omissions must identify unique, unassigned source units",
      );
    omitted.add(item.unit);
  }
  const unassigned = source.units
    .filter((unit) => !assigned.has(unit.key) && !omitted.has(unit.key))
    .map((unit) => unit.key);
  if (unassigned.length)
    fail(
      "SPLIT_COVERAGE",
      "Unassigned content requires a volume or an explicit exclusion reason",
      unassigned,
    );
  const volumes = plan.volumes.map((volume, index) =>
    splitPackage(
      source,
      selections[index],
      volume,
      plan.crossLinks,
      plan.modified,
    ),
  );
  const usedNotes = new Set(volumes.flatMap((volume) => volume.report.notes)),
    omittedNotes = new Set<string>();
  for (const item of plan.omitNotes) {
    if (
      !source.notes.has(item.key) ||
      usedNotes.has(item.key) ||
      omittedNotes.has(item.key)
    )
      fail(
        "SPLIT_NOTE",
        "Note exclusions must identify unused source notes once",
      );
    omittedNotes.add(item.key);
  }
  for (const key of source.notes.keys())
    if (!usedNotes.has(key) && !omittedNotes.has(key))
      fail(
        "SPLIT_NOTE",
        `Unassigned source note requires an explicit exclusion: ${key}`,
      );
  const usedLinks = new Set(
    volumes
      .flatMap((volume) => volume.report.crossLinks)
      .map((item) => stable([item.source, item.id, item.href])),
  );
  if ([...decisions].some((key) => !usedLinks.has(key)))
    fail(
      "SPLIT_LINK",
      "Unused cross-volume link decision does not match a removed target",
    );
  const actual = volumes.flatMap((volume) => volume.report.units),
    duplicates = actual.filter((key, index) => actual.indexOf(key) !== index);
  if (
    duplicates.length ||
    actual.join("\n") !==
      source.units
        .filter((unit) => assigned.has(unit.key))
        .map((unit) => unit.key)
        .join("\n")
  )
    fail(
      "SPLIT_COVERAGE",
      "Independent output coverage/order differs from the source plan",
    );
  return {
    volumes,
    report: {
      sourceSha256: plan.sourceSha256,
      planSha256: sha256(stable(plan)),
      vocabularyVersion: plan.vocabularyVersion,
      sourceOrder: source.units.map((unit) => unit.key),
      coverage: volumes.map((volume) => ({
        key: volume.key,
        units: volume.report.units,
        notes: volume.report.notes,
      })),
      omitted: plan.omit,
      omittedNotes: plan.omitNotes,
      unassigned,
      duplicates,
    },
  };
}
export async function auditFileSplit(
  file: string,
  options: { output?: string } = {},
) {
  if (path.extname(file).toLowerCase() !== ".epub")
    fail("SPLIT_FORMAT", "Choose an existing EPUB");
  const plan = await auditSplit(await readSourceFile(file));
  if (options.output)
    await fs.writeFile(options.output, stable(plan), { flag: "wx" });
  return plan;
}
export async function splitEpub(
  file: string,
  options: { plan: unknown; output: string; signal?: AbortSignal },
) {
  checkAbort(options.signal);
  if (path.extname(file).toLowerCase() !== ".epub")
    fail("SPLIT_FORMAT", "Choose an existing EPUB");
  const bytes = await readSourceFile(file),
    result = await applySplit(bytes, options.plan),
    output = path.resolve(options.output);
  if (
    await fs.lstat(output).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    )
  )
    fail(
      "OUTPUT_EXISTS",
      "Split output already exists; choose a new directory",
    );
  await fs.mkdir(path.dirname(output), { recursive: true });
  const reports = output + ".reports";
  await fs.mkdir(reports);
  const staging = await fs.mkdtemp(
      path.join(path.dirname(output), ".quillbind-split-"),
    ),
    published: string[] = [];
  let claimed = false;
  try {
    await json(path.join(reports, "plan.json"), options.plan);
    await json(path.join(reports, "coverage.json"), result.report);
    const volumes = [];
    for (const volume of result.volumes) {
      checkAbort(options.signal);
      const candidate = path.join(staging, `${volume.key}.epub`),
        volumeReports = path.join(reports, volume.key);
      await fs.mkdir(volumeReports);
      await fs.writeFile(candidate, volume.bytes, { flag: "wx" });
      const validation = await checkEpubConformance(candidate, {
        reports: volumeReports,
        signal: options.signal,
      });
      if (validation.status !== "pass")
        fail(
          "SPLIT_VALIDATION",
          `Volume failed EPUBCheck: ${volume.key}`,
          validation,
        );
      const reading = await readingQa(
        inspectBytes(await readSourceFile(candidate), true),
        path.join(volumeReports, "reading"),
        options.signal,
      );
      if (reading.status !== "pass")
        fail(
          "SPLIT_READING",
          `Volume failed actual reading checks: ${volume.key}`,
          reading,
        );
      const actual = await readSourceFile(candidate);
      if (sha256(actual) !== sha256(volume.bytes))
        fail("SPLIT_STALE", "Candidate changed during verification");
      const selectedCover = volume.report.metadata.cover;
      const cover = selectedCover
        ? await coverQa(
            candidate,
            {
              format: "epub",
              image: await coverImage(
                inspectBytes(actual).entries.get(selectedCover.image)!.bytes,
              ),
              imagePath: selectedCover.image,
              documentPath: selectedCover.document,
            },
            path.join(volumeReports, "cover"),
            options.signal,
          )
        : null;
      volumes.push({
        key: volume.key,
        output: path.join(output, `${volume.key}.epub`),
        sha256: sha256(actual),
        validation,
        reading,
        cover,
        metadata: volume.report,
      });
    }
    if (sha256(await readSourceFile(file)) !== sha256(bytes))
      fail("SPLIT_STALE", "Source changed during verification");
    for (const volume of volumes)
      if (
        sha256(
          await readSourceFile(path.join(staging, `${volume.key}.epub`)),
        ) !== volume.sha256
      )
        fail(
          "SPLIT_STALE",
          `Candidate changed before batch delivery: ${volume.key}`,
        );
    checkAbort(options.signal);
    await fs.mkdir(output);
    claimed = true;
    for (const volume of volumes) {
      checkAbort(options.signal);
      await fs.link(path.join(staging, `${volume.key}.epub`), volume.output);
      published.push(volume.output);
    }
    const delivered = {
      status: "pass" as const,
      purpose: "split-reading-copies",
      source: path.resolve(file),
      sourceSha256: sha256(bytes),
      output,
      reports,
      volumes,
      coverage: result.report,
      fullPublicationQa: "not-run",
      nativeReaderVerification: "not-run",
    };
    await json(path.join(reports, "split.json"), delivered);
    return delivered;
  } catch (error) {
    for (const name of published) await fs.unlink(name);
    if (claimed) await fs.rmdir(output).catch(() => {});
    await json(path.join(reports, "failure.json"), {
      status: "fail",
      message: (error as Error).message,
    });
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
