import fs from "node:fs/promises";
import { z } from "zod";
import type { Element } from "@xmldom/xmldom";
import {
  openMetadata,
  children,
  setModified,
  writeMetadata,
  deliverMetadata,
  metadataFormat,
  type MetadataFormat,
} from "./metadata-file.js";
import {
  seriesDecisionSchema,
  resolveSeriesDecision,
} from "./series-policy.js";
import { attr, elements, NS, serialize } from "./xml.js";
import { sha256 } from "./hash.js";
import { fail } from "./errors.js";
import { readSourceFile } from "./files.js";
import { stable } from "./json.js";

const collectionSchema = z
  .object({
    key: z.string(),
    id: z.string(),
    name: z.string(),
    types: z.array(z.string()),
    positions: z.array(z.string()),
    records: z.array(z.string()),
  })
  .strict();
const inventorySchema = z
  .object({
    series: z.array(z.string()),
    positions: z.array(z.string()),
    records: z.array(z.string()),
  })
  .strict();
const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("series"),
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
    before: inventorySchema,
    collections: z.array(collectionSchema),
    collectionDecisions: z.array(
      z
        .object({
          key: z.string(),
          action: z.enum(["normalize", "preserve"]),
          evidence: z.string().trim().min(1),
        })
        .strict(),
    ),
    conflictResolution: z.string().trim().min(1).nullable(),
    decision: seriesDecisionSchema.nullable(),
  })
  .strict();
export type SeriesPlan = z.infer<typeof planSchema>;
const opfMeta = (node: Element) =>
  node.namespaceURI === NS.opf && node.localName === "meta";
function collectionRecords(metadata: Element, collection: Element) {
  const records = new Set([collection]);
  let size = -1;
  while (size !== records.size) {
    size = records.size;
    const ids = new Set(
      [...records].map((node) => attr(node, "id")).filter(Boolean),
    );
    for (const node of children(metadata))
      if (
        opfMeta(node) &&
        attr(node, "refines").startsWith("#") &&
        ids.has(attr(node, "refines").slice(1))
      )
        records.add(node);
  }
  return [...records];
}
export function auditSeries(
  bytes: Buffer,
  format: MetadataFormat,
  options: { modified?: string } = {},
): SeriesPlan {
  const file = openMetadata(bytes, format),
    nodes = children(file.metadata);
  const names = nodes.filter((node) =>
    format === "cbz"
      ? !node.namespaceURI && node.localName === "Series"
      : opfMeta(node) && attr(node, "name") === "calibre:series",
  );
  const positions = nodes.filter((node) =>
    format === "cbz"
      ? !node.namespaceURI && node.localName === "Number"
      : opfMeta(node) && attr(node, "name") === "calibre:series_index",
  );
  const value = (node: Element) =>
    format === "cbz" ? (node.textContent ?? "") : attr(node, "content");
  const collections =
    format === "epub"
      ? nodes
          .filter(
            (node) =>
              opfMeta(node) &&
              attr(node, "property") === "belongs-to-collection" &&
              !attr(node, "refines"),
          )
          .map((node, index) => {
            const records = collectionRecords(file.metadata, node);
            return {
              key: `collection/${index}`,
              id: attr(node, "id"),
              name: node.textContent ?? "",
              types: records
                .filter((item) => attr(item, "property") === "collection-type")
                .map((item) => item.textContent ?? ""),
              positions: records
                .filter((item) => attr(item, "property") === "group-position")
                .map((item) => item.textContent ?? ""),
              records: records.map(serialize),
            };
          })
      : [];
  return {
    schemaVersion: 1,
    operation: "series",
    format,
    sourceSha256: sha256(bytes),
    metadataSha256: sha256(file.entries.get(file.location)!.bytes),
    modified:
      options.modified ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    before: {
      series: names.map(value),
      positions: positions.map(value),
      records: [...names, ...positions].map(serialize),
    },
    collections,
    collectionDecisions: collections
      .filter(
        (item) =>
          item.types.length === 1 && ["series", "set"].includes(item.types[0]),
      )
      .map((item) => ({
        key: item.key,
        action: item.types[0] === "series" ? "normalize" : "preserve",
        evidence:
          item.types[0] === "series"
            ? "Existing series representation selected for the evidenced Series decision"
            : "Explicit non-series collection preserved",
      })),
    conflictResolution: null,
    decision: null,
  };
}

export function applySeries(bytes: Buffer, value: unknown) {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success)
    fail("SERIES_PLAN", "Invalid Series plan", parsed.error.issues);
  const plan = parsed.data;
  if (!plan.decision)
    fail("SERIES_DECISION", "An evidenced Series decision is required");
  if (sha256(bytes) !== plan.sourceSha256)
    fail("METADATA_STALE", "Source hash differs from the Series plan");
  const actual = auditSeries(bytes, plan.format, { modified: plan.modified });
  if (
    actual.metadataSha256 !== plan.metadataSha256 ||
    stable(actual.before) !== stable(plan.before) ||
    stable(actual.collections) !== stable(plan.collections)
  )
    fail("SERIES_INVENTORY", "Do not edit the original Series inventory");
  const decision = resolveSeriesDecision(plan.decision),
    selected = new Set<string>(),
    dispositions = new Set<string>();
  for (const item of plan.collectionDecisions) {
    if (
      dispositions.has(item.key) ||
      !plan.collections.some((row) => row.key === item.key)
    )
      fail("SERIES_COLLECTION", "Missing or duplicate collection decision");
    dispositions.add(item.key);
    if (item.action === "normalize") selected.add(item.key);
  }
  if (dispositions.size !== plan.collections.length)
    fail(
      "SERIES_COLLECTION",
      "Classify every unclassified EPUB collection before editing",
    );
  const chosen = plan.collections.filter((item) => selected.has(item.key));
  const before = {
    series: [...plan.before.series, ...chosen.map((item) => item.name)],
    positions: [
      ...plan.before.positions,
      ...chosen.flatMap((item) => item.positions),
    ],
  };
  if (
    decision.series !== null &&
    decision.position === null &&
    before.positions.some((position) => position.trim()) &&
    !decision.positionEvidence
  )
    fail(
      "SERIES_POSITION",
      "Explain the removal of a present series position; missing lookup is not a clearing decision",
    );
  if (
    Object.values(before).some(
      (values) =>
        new Set(values.map((text) => text.trim()).filter(Boolean)).size > 1,
    ) &&
    !plan.conflictResolution
  )
    fail(
      "SERIES_CONFLICT",
      "Conflicting Series representations require an explicit conflict resolution",
    );
  const file = openMetadata(bytes, plan.format),
    original = serialize(file.document),
    nodes = children(file.metadata);
  let outputCollectionId: string | undefined;
  let compatibilityExpected = plan.format === "cbz";
  if (plan.format === "cbz") {
    for (const node of nodes)
      if (
        !node.namespaceURI &&
        ["Series", "Number"].includes(node.localName ?? "")
      )
        file.metadata.removeChild(node);
    const next =
      children(file.metadata).find((node) => node.localName !== "Title") ??
      null;
    for (const [field, text] of [
      ["Series", decision.series],
      ["Number", decision.position],
    ])
      if (text !== null) {
        const node = file.document.createElement(field!);
        node.textContent = text;
        file.metadata.insertBefore(node, next);
      }
  } else {
    const compatibility = nodes.filter(
      (node) =>
        opfMeta(node) &&
        ["calibre:series", "calibre:series_index"].includes(attr(node, "name")),
    );
    compatibilityExpected = compatibility.length > 0 || file.version === "2.0";
    const collections = nodes.filter(
      (node) =>
        opfMeta(node) &&
        attr(node, "property") === "belongs-to-collection" &&
        !attr(node, "refines"),
    );
    const removals = new Set(compatibility);
    for (const [index, node] of collections.entries())
      if (selected.has(`collection/${index}`)) {
        for (const item of collectionRecords(file.metadata, node)) {
          if (
            item !== node &&
            attr(item, "property") === "belongs-to-collection"
          )
            fail(
              "SERIES_COLLECTION",
              "Nested collections require an explicit hierarchy-preserving repair",
            );
          removals.add(item);
        }
      }
    const ids = new Set(
      elements(file.document)
        .map((node) => attr(node, "id"))
        .filter(Boolean),
    );
    const removedIds = new Set(
      [...removals].map((node) => attr(node, "id")).filter(Boolean),
    );
    for (const id of removedIds)
      if (
        elements(file.document).filter((node) => attr(node, "id") === id)
          .length !== 1
      )
        fail("SERIES_REFERENCE", "Ambiguous Series metadata ID");
    for (const node of elements(file.document))
      if (
        !removals.has(node) &&
        attr(node, "refines").startsWith("#") &&
        removedIds.has(attr(node, "refines").slice(1))
      )
        fail(
          "SERIES_REFERENCE",
          "Series metadata is referenced outside the selected records",
        );
    for (const node of removals) file.metadata.removeChild(node);
    const add = (attributes: Record<string, string>, text = "") => {
      const node = file.document.createElementNS(NS.opf, "meta");
      for (const [name, value] of Object.entries(attributes))
        node.setAttribute(name, value);
      node.textContent = text;
      file.metadata.appendChild(node);
    };
    if (
      decision.series !== null &&
      (compatibility.length || file.version === "2.0")
    ) {
      add({ name: "calibre:series", content: decision.series });
      if (decision.position !== null)
        add({ name: "calibre:series_index", content: decision.position });
    }
    if (decision.series !== null && file.version === "3.0") {
      let id = chosen[0]?.id ?? "";
      if (!id) {
        id = "series";
        for (let index = 1; ids.has(id); index++) id = `series-${index}`;
      }
      outputCollectionId = id;
      add({ property: "belongs-to-collection", id }, decision.series);
      add({ property: "collection-type", refines: `#${id}` }, "series");
      if (decision.position !== null)
        add(
          { property: "group-position", refines: `#${id}` },
          decision.position,
        );
    }
  }
  const changed = serialize(file.document) !== original;
  if (changed) setModified(file, plan.modified);
  const output = changed
    ? writeMetadata(bytes, file)
    : {
        bytes,
        preserved: [...file.entries].map(([name, entry]) => ({
          name,
          sha256: sha256(entry.bytes),
          method: entry.method,
        })),
      };
  const readback = auditSeries(output.bytes, plan.format, {
    modified: plan.modified,
  });
  const expectedFields = {
    series:
      compatibilityExpected && decision.series !== null
        ? [decision.series]
        : [],
    positions:
      compatibilityExpected &&
      decision.series !== null &&
      decision.position !== null
        ? [decision.position]
        : [],
  };
  if (
    stable(readback.before.series) !== stable(expectedFields.series) ||
    stable(readback.before.positions) !== stable(expectedFields.positions)
  )
    fail(
      "SERIES_READBACK",
      "Series compatibility fields differ from the decision",
    );
  if (outputCollectionId) {
    const collection = readback.collections.find(
      (item) => item.id === outputCollectionId,
    );
    if (
      !collection ||
      collection.name !== decision.series ||
      stable(collection.types) !== stable(["series"]) ||
      stable(collection.positions) !==
        stable(decision.position === null ? [] : [decision.position])
    )
      fail(
        "SERIES_READBACK",
        "EPUB series collection differs from the decision",
      );
  }
  const report = {
    sourceSha256: plan.sourceSha256,
    metadataSha256: plan.metadataSha256,
    changed,
    before,
    after: { series: decision.series, position: decision.position },
    decision,
    collectionDecisions: plan.collectionDecisions,
    conflictResolution: plan.conflictResolution,
    preserved: output.preserved,
  };
  return { ...output, report };
}
export async function auditFileSeries(
  file: string,
  options: { output?: string } = {},
) {
  const plan = auditSeries(await readSourceFile(file), metadataFormat(file));
  if (options.output)
    await fs.writeFile(options.output, stable(plan), { flag: "wx" });
  return plan;
}
export async function normalizeSeries(
  file: string,
  options: { plan: unknown; output: string; signal?: AbortSignal },
) {
  const bytes = await readSourceFile(file),
    result = applySeries(bytes, options.plan),
    format = metadataFormat(file);
  if (planSchema.parse(options.plan).format !== format)
    fail("METADATA_FORMAT", "Source extension and plan format differ");
  return deliverMetadata(file, {
    ...options,
    ...result,
    format,
    sourceSha256: sha256(bytes),
  });
}
