import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Element, Node } from "@xmldom/xmldom";
import {
  children,
  deliverMetadata,
  metadataFormat,
  openMetadata,
  setModified,
  writeMetadata,
  type MetadataFile,
  type MetadataFormat,
} from "./metadata-file.js";
import { fail } from "./errors.js";
import { readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stable } from "./json.js";
import { repoRoot } from "./runtime.js";
import { attr, elements, NS, serialize, xml } from "./xml.js";

export const comicSequence: readonly string[] = (() => {
  const schemaDoc = xml(
    readFileSync(
      path.join(repoRoot, "standards/comicinfo/ComicInfo-2.0.xsd"),
      "utf8",
    ),
    "ComicInfo-2.0.xsd",
  );
  const rootComplex = elements(
    schemaDoc,
    "complexType",
    "http://www.w3.org/2001/XMLSchema",
  ).find((node) => attr(node, "name") === "ComicInfo");
  if (!rootComplex)
    fail("COMICINFO_SCHEMA", "ComicInfo complexType missing from XSD");
  return elements(
    rootComplex,
    "element",
    "http://www.w3.org/2001/XMLSchema",
  ).map((node) => attr(node, "name"));
})();

export function insertComicElement(
  file: MetadataFile,
  name: string,
  textValue: string,
) {
  const order = comicSequence.indexOf(name);
  if (order === -1)
    fail("COMICINFO_PROFILE", `Unsupported ComicInfo 2.0 element: ${name}`);
  const node = file.document.createElement(name);
  node.textContent = textValue;
  const anchor =
    children(file.metadata).find((child) => {
      if (child.namespaceURI) return false;
      const idx = comicSequence.indexOf(child.localName ?? "");
      return idx > order;
    }) ?? null;
  file.metadata.insertBefore(node, anchor);
  return node;
}

interface LoadedVocabulary {
  schemaVersion: number;
  version: string;
  canonical: Set<string>;
  aliases: Map<string, string>;
  source: { path: string; sha256: string };
  key: (value: string) => string;
  workKinds: Record<
    "light-novel" | "manga" | "art-book",
    { required?: string; forbidden: string[]; requiresPrefix?: string }
  >;
}

export async function loadTagVocabulary(
  vocabularyFile?: string,
): Promise<LoadedVocabulary> {
  const [loader, rulesLoader] = await Promise.all([
    import(
      pathToFileURL(
        path.resolve(
          repoRoot,
          "../../skills/quillbind/scripts/tag-vocabulary.mjs",
        ),
      ).href
    ) as Promise<{
      key: (value: string) => string;
      loadVocabulary: (file?: string) => Promise<{
        schemaVersion: number;
        version: string;
        canonical: Set<string>;
        aliases: Map<string, string>;
        source: { path: string; sha256: string };
      }>;
    }>,
    import(
      pathToFileURL(
        path.resolve(
          repoRoot,
          "../../skills/quillbind/scripts/skill-rules.mjs",
        ),
      ).href
    ) as Promise<{
      readWorkTypeTagRules: () => Promise<LoadedVocabulary["workKinds"]>;
    }>,
  ]);
  const [loaded, workKinds] = await Promise.all([
    loader.loadVocabulary(vocabularyFile),
    rulesLoader.readWorkTypeTagRules(),
  ]);
  return {
    ...loaded,
    key: loader.key,
    workKinds,
  };
}

const review = z.string().trim().min(1);
const nodeSchema = z.strictObject({
  key: z.string(),
  id: z.string().nullable(),
  value: z.string(),
  refinements: z.array(z.string()),
  externalReferences: z.boolean(),
  xml: z.string(),
});
const decisionSchema = z.strictObject({
  kind: z.enum(["light-novel", "manga", "art-book"]).optional(),
  add: z.array(review),
  remove: z.array(review),
  clearEvidence: review.nullable(),
  evidence: z.array(review),
});
const refinementDecisionSchema = z.strictObject({
  key: z.string(),
  action: z.literal("drop-refinements"),
  evidence: review,
});
const changeSchema = z.strictObject({
  from: z.string().nullable(),
  to: z.string().nullable(),
  reason: z.string(),
});
const unresolvedSchema = z.strictObject({
  code: z.string(),
  tag: z.string().optional(),
});

const planSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("tags"),
  format: z.enum(["epub", "cbz"]),
  version: z.enum(["2.0", "3.0"]).optional(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
  vocabularyVersion: z.string(),
  vocabularySha256: z.string().regex(/^[a-f0-9]{64}$/),
  modified: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    .refine(
      (value) =>
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString().replace(".000Z", "Z") === value,
    ),
  before: z.strictObject({
    tags: z.array(z.string()),
    nodes: z.array(nodeSchema),
  }),
  decision: decisionSchema,
  refinementDecisions: z.array(refinementDecisionSchema),
  proposed: z.array(z.string()),
  changes: z.array(changeSchema),
  unresolved: z.array(unresolvedSchema),
  reviewed: z.boolean(),
});
export type TagsPlan = z.infer<typeof planSchema>;
export type TagsDecision = z.infer<typeof decisionSchema>;

function subjectRefinements(file: MetadataFile, node: Element) {
  const id = attr(node, "id");
  if (!id) return [];
  return children(file.metadata).filter(
    (item) =>
      item.namespaceURI === NS.opf &&
      item.localName === "meta" &&
      attr(item, "refines") === `#${id}`,
  );
}

function hasExternalReference(
  file: MetadataFile,
  node: Element,
  refinements: Element[],
) {
  const id = attr(node, "id");
  if (!id) return false;
  return elements(file.document).some(
    (item) =>
      item !== node &&
      !refinements.includes(item) &&
      [attr(item, "refines"), attr(item, "idref")].includes(`#${id}`),
  );
}

function extractSubjects(file: MetadataFile) {
  if (file.format === "epub") {
    const subjects = children(file.metadata).filter(
      (node) => node.namespaceURI === NS.dc && node.localName === "subject",
    );
    const nodes = subjects.map((node, index) => {
      const refinements = subjectRefinements(file, node);
      return {
        key: `subject/${index}`,
        id: attr(node, "id") || null,
        value: (node.textContent ?? "").trim(),
        refinements: refinements.map(serialize),
        externalReferences: hasExternalReference(file, node, refinements),
        xml: serialize(node),
      };
    });
    return {
      tags: nodes.map((item) => item.value).filter(Boolean),
      nodes,
      elements: subjects,
    };
  }
  const genreNodes = children(file.metadata).filter(
    (node) => !node.namespaceURI && node.localName === "Genre",
  );
  const raw = genreNodes[0]?.textContent ?? "";
  const tags = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    tags,
    nodes: genreNodes.map((node, index) => ({
      key: `genre/${index}`,
      id: null,
      value: (node.textContent ?? "").trim(),
      refinements: [],
      externalReferences: false,
      xml: serialize(node),
    })),
    elements: genreNodes,
  };
}

function evaluateDecision(
  originalTags: string[],
  decision: TagsDecision,
  vocabulary: LoadedVocabulary,
) {
  const hasExplicitEdit =
    decision.kind !== undefined ||
    decision.add.length > 0 ||
    decision.remove.length > 0;
  if (hasExplicitEdit && !decision.evidence.length)
    fail(
      "TAGS_EVIDENCE",
      "Explicit tag or work-kind decisions require evidence",
    );

  const rule = decision.kind ? vocabulary.workKinds[decision.kind] : undefined;
  for (const tag of decision.add) {
    if (!vocabulary.canonical.has(tag))
      fail(
        "TAGS_DECISION",
        `Added tag must match the controlled vocabulary: ${tag}`,
      );
    if (rule?.forbidden.includes(tag))
      fail("TAGS_DECISION", `Tag conflicts with declared kind: ${tag}`);
  }
  for (const tag of decision.remove) {
    if (decision.add.includes(tag) || rule?.required === tag)
      fail("TAGS_DECISION", `Conflicting add/remove tag decision: ${tag}`);
    if (!originalTags.includes(tag))
      fail(
        "TAGS_DECISION",
        `Removal must match an original tag exactly: ${tag}`,
      );
  }

  const proposed: string[] = [];
  const changes: z.infer<typeof changeSchema>[] = [];
  const unresolved: z.infer<typeof unresolvedSchema>[] = [];

  for (const original of originalTags) {
    const normalized =
      vocabulary.aliases.get(vocabulary.key(original)) ?? original;
    if (
      decision.remove.includes(original) ||
      rule?.forbidden.includes(normalized)
    ) {
      changes.push({
        from: original,
        to: null,
        reason: "evidence-backed removal",
      });
      continue;
    }
    if (proposed.includes(normalized)) {
      changes.push({ from: original, to: normalized, reason: "duplicate" });
    } else {
      proposed.push(normalized);
      if (original !== normalized)
        changes.push({
          from: original,
          to: normalized,
          reason: "vocabulary normalization",
        });
    }
  }

  const additions = [...decision.add];
  if (rule?.required) {
    if (vocabulary.canonical.has(rule.required)) additions.push(rule.required);
    else unresolved.push({ code: "VOCABULARY_GAP", tag: rule.required });
  }
  for (const tag of additions) {
    if (!proposed.includes(tag)) {
      proposed.push(tag);
      changes.push({ from: null, to: tag, reason: "evidence-backed addition" });
    }
  }
  for (const tag of proposed) {
    if (!vocabulary.canonical.has(tag))
      unresolved.push({ code: "UNKNOWN_TAG", tag });
  }
  if (
    proposed.includes("Literature.Light Novel") &&
    proposed.includes("Literature.Manga")
  )
    unresolved.push({ code: "WORK_TYPE_CONFLICT" });
  if (
    rule?.requiresPrefix &&
    !proposed.some(
      (tag) =>
        vocabulary.canonical.has(tag) && tag.startsWith(rule.requiresPrefix!),
    )
  )
    unresolved.push({ code: "ART_SUBJECT_REQUIRED" });
  if (!proposed.length && !decision.clearEvidence)
    unresolved.push({ code: "MISSING_TAGS" });

  return { proposed, changes, unresolved };
}

export async function auditTags(
  bytes: Buffer,
  format: MetadataFormat,
  options: {
    vocabulary?: string;
    decision?: Partial<TagsDecision>;
    modified?: string;
  } = {},
): Promise<TagsPlan> {
  const vocabulary = await loadTagVocabulary(options.vocabulary);
  const file = openMetadata(bytes, format, { preserveContent: true });
  const before = extractSubjects(file);
  const decision: TagsDecision = {
    ...(options.decision?.kind ? { kind: options.decision.kind } : {}),
    add: options.decision?.add ?? [],
    remove: options.decision?.remove ?? [],
    clearEvidence: options.decision?.clearEvidence ?? null,
    evidence: options.decision?.evidence ?? [],
  };
  const evaluated = evaluateDecision(before.tags, decision, vocabulary);
  return {
    schemaVersion: 1,
    operation: "tags",
    format,
    ...(format === "epub" ? { version: file.version as "2.0" | "3.0" } : {}),
    sourceSha256: sha256(bytes),
    metadataSha256: sha256(file.entries.get(file.location)!.bytes),
    vocabularyVersion: vocabulary.version,
    vocabularySha256: vocabulary.source.sha256,
    modified:
      options.modified ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    before: {
      tags: before.tags,
      nodes: before.nodes,
    },
    decision,
    refinementDecisions: [],
    ...evaluated,
    reviewed: false,
  };
}

function verifyTagIntegrity(
  beforeBytes: Buffer,
  afterBytes: Buffer,
  format: MetadataFormat,
  expectedTags: string[],
) {
  const source = openMetadata(beforeBytes, format, { preserveContent: true });
  const result = openMetadata(afterBytes, format, { preserveContent: true });
  const readback = extractSubjects(result);
  if (stable(readback.tags) !== stable(expectedTags))
    fail(
      "METADATA_READBACK",
      "Readback canonical tag set differs from planned tags",
      { expected: expectedTags, actual: readback.tags },
    );

  if (format === "epub") {
    const stripMetadata = (file: MetadataFile) => {
      const copy = file.document.cloneNode(true) as typeof file.document;
      for (const node of elements(copy, "metadata", NS.opf))
        node.parentNode!.removeChild(node);
      return serialize(copy);
    };
    if (
      stripMetadata(source) !== stripMetadata(result) ||
      result.version !== source.version
    )
      fail("METADATA_INTEGRITY", "Package structure outside metadata changed");

    const nonSubjectRecords = (file: MetadataFile, isSource: boolean) => {
      const subjectNodes = children(file.metadata).filter(
        (node) => node.namespaceURI === NS.dc && node.localName === "subject",
      );
      const skip = new Set<Element>(subjectNodes);
      if (isSource) {
        for (const subject of subjectNodes)
          for (const ref of subjectRefinements(file, subject)) skip.add(ref);
      } else {
        for (const subject of subjectNodes)
          for (const ref of subjectRefinements(file, subject)) skip.add(ref);
      }
      return children(file.metadata)
        .filter((node) => !skip.has(node))
        .filter(
          (node) =>
            !(
              node.namespaceURI === NS.opf &&
              node.localName === "meta" &&
              attr(node, "property") === "dcterms:modified"
            ),
        )
        .map(serialize);
    };
    if (
      stable(nonSubjectRecords(source, true)) !==
      stable(nonSubjectRecords(result, false))
    )
      fail("METADATA_INTEGRITY", "Unselected EPUB metadata records changed");
    return;
  }

  const nonGenreRecords = (file: MetadataFile) =>
    children(file.metadata)
      .filter((node) => !(!node.namespaceURI && node.localName === "Genre"))
      .map(serialize);
  if (stable(nonGenreRecords(source)) !== stable(nonGenreRecords(result)))
    fail("METADATA_INTEGRITY", "Unselected ComicInfo metadata fields changed");
}

export async function applyTags(
  bytes: Buffer,
  value: unknown,
  options: { vocabulary?: string } = {},
) {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success)
    fail("TAGS_PLAN", "Invalid tag maintenance plan", parsed.error.issues);
  const plan = parsed.data;
  if (!plan.reviewed)
    fail(
      "TAGS_REVIEW",
      "Review the tag inventory, unresolved findings and decisions before applying",
    );
  if (sha256(bytes) !== plan.sourceSha256)
    fail("METADATA_STALE", "Source hash differs from the tag plan");

  const vocabulary = await loadTagVocabulary(options.vocabulary);
  if (
    vocabulary.source.sha256 !== plan.vocabularySha256 ||
    vocabulary.version !== plan.vocabularyVersion
  )
    fail(
      "TAGS_VOCABULARY_STALE",
      "Controlled vocabulary changed since audit; re-audit before applying",
    );

  const actual = await auditTags(bytes, plan.format, {
    vocabulary: options.vocabulary,
    modified: plan.modified,
  });
  if (
    actual.metadataSha256 !== plan.metadataSha256 ||
    stable(actual.before) !== stable(plan.before) ||
    actual.version !== plan.version
  )
    fail("TAGS_INVENTORY", "Do not edit the original tag inventory");

  const evaluated = evaluateDecision(
    plan.before.tags,
    plan.decision,
    vocabulary,
  );
  if (evaluated.unresolved.length)
    fail(
      "TAGS_UNRESOLVED",
      "Resolve all unknown or conflicting tags before applying",
      evaluated.unresolved,
    );

  const file = openMetadata(bytes, plan.format, { preserveContent: true });
  const originalXml = serialize(file.document);

  if (plan.format === "cbz") {
    const commaTag = evaluated.proposed.find((tag) => tag.includes(","));
    if (commaTag)
      fail(
        "TAGS_REPRESENTATION_CONFLICT",
        `ComicInfo Genre comma list cannot unambiguously represent tag containing a comma: ${commaTag}`,
      );
    for (const node of children(file.metadata))
      if (!node.namespaceURI && node.localName === "Genre")
        file.metadata.removeChild(node);
    if (evaluated.proposed.length)
      insertComicElement(file, "Genre", evaluated.proposed.join(", "));
  } else if (
    evaluated.changes.length > 0 ||
    stable(plan.before.tags) !== stable(evaluated.proposed)
  ) {
    const subjects = children(file.metadata).filter(
      (node) => node.namespaceURI === NS.dc && node.localName === "subject",
    );
    const dropDecisions = new Map<string, string>();
    for (const item of plan.refinementDecisions) {
      if (
        dropDecisions.has(item.key) ||
        !plan.before.nodes.some((row) => row.key === item.key)
      )
        fail(
          "TAGS_REFINEMENT",
          `Invalid or duplicate refinement decision: ${item.key}`,
        );
      dropDecisions.set(item.key, item.evidence);
    }

    const remainingPool = subjects.map((node, index) => ({
      key: `subject/${index}`,
      node,
      value: (node.textContent ?? "").trim(),
      refinements: subjectRefinements(file, node),
      external: plan.before.nodes[index].externalReferences,
      used: false,
    }));

    const subjectAndRefNodes = new Set<Node>();
    for (const entry of remainingPool) {
      subjectAndRefNodes.add(entry.node);
      for (const ref of entry.refinements) subjectAndRefNodes.add(ref);
    }
    let insertionAnchor: Node | null = subjects.at(-1)?.nextSibling ?? null;
    while (insertionAnchor && subjectAndRefNodes.has(insertionAnchor)) {
      insertionAnchor = insertionAnchor.nextSibling;
    }

    const retainedByLabel = new Map<string, (typeof remainingPool)[number]>();
    for (const label of evaluated.proposed) {
      const match = remainingPool.find(
        (entry) => !entry.used && entry.value === label,
      );
      if (match) {
        match.used = true;
        retainedByLabel.set(label, match);
      }
    }

    for (const entry of remainingPool) {
      if (entry.used) continue;
      if (entry.external)
        fail(
          "TAGS_REFERENCE",
          `dc:subject ${entry.key} is referenced outside metadata refinements`,
        );
      if (entry.refinements.length && !dropDecisions.has(entry.key))
        fail(
          "TAGS_REFINEMENT",
          `Account for attached refinements on removed/replaced ${entry.key} in refinementDecisions`,
        );
      for (const ref of entry.refinements) file.metadata.removeChild(ref);
      file.metadata.removeChild(entry.node);
    }

    for (const label of evaluated.proposed) {
      const kept = retainedByLabel.get(label);
      if (kept) {
        file.metadata.insertBefore(kept.node, insertionAnchor);
        for (const ref of kept.refinements)
          file.metadata.insertBefore(ref, insertionAnchor);
      } else {
        const created = file.document.createElementNS(NS.dc, "dc:subject");
        created.textContent = label;
        file.metadata.insertBefore(created, insertionAnchor);
      }
    }
  }

  const changed = serialize(file.document) !== originalXml;
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
  verifyTagIntegrity(bytes, output.bytes, plan.format, evaluated.proposed);

  return {
    ...output,
    report: {
      sourceSha256: plan.sourceSha256,
      metadataSha256: plan.metadataSha256,
      vocabularyVersion: plan.vocabularyVersion,
      vocabularySha256: plan.vocabularySha256,
      changed,
      before: plan.before.tags,
      after: evaluated.proposed,
      changes: evaluated.changes,
      decision: plan.decision,
      refinementDecisions: plan.refinementDecisions,
      preserved: output.preserved,
    },
  };
}

export async function auditFileTags(
  file: string,
  options: {
    output?: string;
    vocabulary?: string;
    decision?: Partial<TagsDecision>;
  } = {},
) {
  const format = metadataFormat(file);
  const plan = await auditTags(await readSourceFile(file), format, options);
  if (options.output)
    await fs.writeFile(options.output, stable(plan) + "\n", { flag: "wx" });
  return plan;
}

export async function applyFileTags(
  file: string,
  options: {
    plan: unknown;
    output: string;
    vocabulary?: string;
    signal?: AbortSignal;
  },
) {
  const format = metadataFormat(file);
  const bytes = await readSourceFile(file);
  const result = await applyTags(bytes, options.plan, {
    vocabulary: options.vocabulary,
  });
  return deliverMetadata(file, {
    output: options.output,
    signal: options.signal,
    ...result,
    format,
    preserveContent: true,
    sourceSha256: sha256(bytes),
  });
}
