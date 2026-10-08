import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  children,
  openMetadata,
  writeMetadata,
  setModified,
  metadataFormat,
  deliverMetadata,
  type MetadataFormat,
} from "./metadata-file.js";
import { attr, elements, NS, serialize, xml } from "./xml.js";
import { sha256 } from "./hash.js";
import { fail } from "./errors.js";
import { readSourceFile } from "./files.js";
import { stable } from "./json.js";
import { repoRoot } from "./runtime.js";

const comicFields = new Set(
  elements(
    xml(
      readFileSync(
        path.join(repoRoot, "standards/comicinfo/ComicInfo-2.0.xsd"),
        "utf8",
      ),
    ),
    "element",
    "http://www.w3.org/2001/XMLSchema",
  ).map((node) => attr(node, "name")),
);
const decision = z
  .object({ key: z.string(), evidence: z.string().trim().min(1) })
  .strict();
const inventorySchema = z
  .object({
    key: z.string(),
    label: z.string(),
    xml: z.string(),
    knownScore: z.boolean(),
    suspectedScore: z.boolean(),
    protected: z.boolean(),
  })
  .strict();
const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("ratings"),
    format: z.enum(["epub", "cbz"]),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    metadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
    modified: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .refine(
        (value) =>
          !Number.isNaN(Date.parse(value)) &&
          new Date(value).toISOString().replace(".000Z", "Z") === value,
      ),
    reviewed: z.boolean(),
    customScores: z.array(decision),
    retain: z.array(decision),
    inventory: z.array(inventorySchema),
  })
  .strict();
export type RatingsPlan = z.infer<typeof planSchema>;

export function auditRatings(
  bytes: Buffer,
  format: MetadataFormat,
  options: { modified?: string } = {},
): RatingsPlan {
  const file = openMetadata(bytes, format);
  const inventory = children(file.metadata).map((node, index) => {
    const opfMeta = node.namespaceURI === NS.opf && node.localName === "meta";
    const label =
      format === "epub"
        ? attr(node, "name") || attr(node, "property") || node.nodeName
        : node.nodeName;
    let typedRating = false,
      invalidCustom = false;
    if (opfMeta && label.startsWith("calibre:user_metadata:#")) {
      try {
        typedRating = JSON.parse(attr(node, "content"))?.datatype === "rating";
      } catch {
        invalidCustom = true;
      }
    }
    const knownScore =
      format === "epub"
        ? opfMeta && (label === "calibre:rating" || typedRating)
        : !node.namespaceURI && label === "CommunityRating";
    const protectedField =
      format === "cbz"
        ? /age.?rating/i.test(label) ||
          (!node.namespaceURI &&
            comicFields.has(label) &&
            label !== "CommunityRating")
        : !opfMeta ||
          /age.?rating/i.test(label) ||
          [
            "cover",
            "calibre:series",
            "calibre:series_index",
            "calibre:timestamp",
            "dcterms:modified",
            "belongs-to-collection",
            "collection-type",
            "group-position",
            "role",
            "file-as",
            "identifier-type",
            "title-type",
            "display-seq",
            "alternate-script",
          ].includes(label) ||
          /^(rendition|media|a11y):/.test(label);
    return {
      key: `metadata/${index}`,
      label,
      xml: serialize(node),
      knownScore: knownScore && !protectedField,
      suspectedScore:
        !protectedField &&
        !knownScore &&
        (invalidCustom || /rating|score|評分|评分|星級|星级/i.test(label)),
      protected: protectedField,
    };
  });
  return {
    schemaVersion: 1,
    operation: "ratings",
    format,
    sourceSha256: sha256(bytes),
    metadataSha256: sha256(file.entries.get(file.location)!.bytes),
    modified:
      options.modified ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    reviewed: false,
    customScores: [],
    retain: [],
    inventory,
  };
}

export function applyRatings(bytes: Buffer, value: unknown) {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success)
    fail("RATINGS_PLAN", "Invalid rating cleanup plan", parsed.error.issues);
  const plan = parsed.data;
  if (sha256(bytes) !== plan.sourceSha256)
    fail("METADATA_STALE", "Source hash differs from the rating plan");
  if (!plan.reviewed)
    fail(
      "RATINGS_REVIEW",
      "Review the complete metadata inventory before cleanup",
    );
  const actual = auditRatings(bytes, plan.format, { modified: plan.modified });
  if (
    actual.metadataSha256 !== plan.metadataSha256 ||
    stable(actual.inventory) !== stable(plan.inventory)
  )
    fail("RATINGS_INVENTORY", "The source inventory must not be edited");
  const selected = new Set(
    actual.inventory.filter((row) => row.knownScore).map((row) => row.key),
  );
  const disposed = new Set<string>();
  for (const [kind, decisions] of [
    ["remove", plan.customScores],
    ["retain", plan.retain],
  ] as const)
    for (const item of decisions) {
      const row = actual.inventory.find((row) => row.key === item.key);
      if (!row || disposed.has(item.key))
        fail("RATINGS_DECISION", "Missing or duplicate field decision");
      disposed.add(item.key);
      if (row.protected || (kind === "retain" && row.knownScore))
        fail(
          "RATINGS_PROTECTED",
          `Protected field or known score cannot receive this decision: ${row.label}`,
        );
      if (kind === "remove") selected.add(item.key);
    }
  const unresolved = actual.inventory.filter(
    (row) =>
      row.suspectedScore && !selected.has(row.key) && !disposed.has(row.key),
  );
  if (unresolved.length)
    fail(
      "RATINGS_UNRESOLVED",
      "Unresolved custom score candidates require a score or non-score decision",
      unresolved,
    );
  const file = openMetadata(bytes, plan.format),
    nodes = children(file.metadata);
  const removed = actual.inventory.filter((row) => selected.has(row.key));
  const removals = new Set(
    nodes.filter((_, index) => selected.has(`metadata/${index}`)),
  );
  // Refinements belong to their removed score; never leave dangling references.
  let previous = -1;
  while (previous !== removals.size) {
    previous = removals.size;
    const ids = new Set(
      [...removals].map((node) => attr(node, "id")).filter(Boolean),
    );
    for (const node of elements(file.document))
      if (
        ids.has(attr(node, "refines").slice(1)) &&
        attr(node, "refines").startsWith("#")
      ) {
        if (/age.?rating/i.test(attr(node, "name") || attr(node, "property")))
          fail(
            "RATINGS_PROTECTED",
            "Score has an age-classification refinement; explicit repair is required",
          );
        if (node.parentNode !== file.metadata)
          fail(
            "RATINGS_REFERENCE",
            "Score is referenced outside the metadata block",
          );
        removals.add(node);
      }
  }
  const refinements = [...removals]
    .filter((node) => !selected.has(`metadata/${nodes.indexOf(node)}`))
    .map(serialize);
  for (const node of removals) file.metadata.removeChild(node);
  if (removals.size) setModified(file, plan.modified);
  const output = removals.size
    ? writeMetadata(bytes, file)
    : {
        bytes,
        preserved: [...file.entries].map(([name, entry]) => ({
          name,
          sha256: sha256(entry.bytes),
          method: entry.method,
        })),
      };
  const report = {
    sourceSha256: plan.sourceSha256,
    metadataSha256: plan.metadataSha256,
    format: plan.format,
    location: file.location,
    changed: removals.size > 0,
    removed,
    refinements,
    retained: plan.retain,
    unresolved: [],
    modified: removals.size && file.version === "3.0" ? plan.modified : null,
    preserved: output.preserved,
  };
  const remaining = auditRatings(output.bytes, plan.format, {
    modified: plan.modified,
  });
  if (remaining.inventory.some((row) => row.knownScore))
    fail("RATINGS_READBACK", "Recognized scores remain after cleanup");
  return { bytes: output.bytes, report };
}

export async function auditFileRatings(
  file: string,
  options: { output?: string } = {},
) {
  const plan = auditRatings(await readSourceFile(file), metadataFormat(file));
  if (options.output)
    await fs.writeFile(options.output, stable(plan), { flag: "wx" });
  return plan;
}
export async function cleanRatings(
  file: string,
  options: { plan: unknown; output: string; signal?: AbortSignal },
) {
  const bytes = await readSourceFile(file),
    result = applyRatings(bytes, options.plan);
  const format = metadataFormat(file);
  if (format !== result.report.format)
    fail("METADATA_FORMAT", "Source extension and plan format differ");
  return deliverMetadata(file, {
    ...options,
    ...result,
    format,
    sourceSha256: sha256(bytes),
  });
}
