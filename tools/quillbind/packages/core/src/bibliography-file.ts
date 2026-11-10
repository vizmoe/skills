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
  type MetadataFile,
} from "./metadata-file.js";
import {
  cleanDescription,
  cleanText,
  cleanTitle,
  isPlaceholder,
  isWatermark,
  normalizeDate,
  normalizeIsbn,
  normalizeLanguage,
  parseContributors,
} from "./bibliography-normalize.js";
import { attr, elements, NS, serialize } from "./xml.js";
import { sha256 } from "./hash.js";
import { fail } from "./errors.js";
import { readSourceFile } from "./files.js";
import { stable } from "./json.js";

const fields = [
  "title",
  "creator",
  "contributor",
  "publisher",
  "date",
  "description",
  "language",
  "identifier",
] as const;
type Field = (typeof fields)[number];
const roles = ["aut", "trl", "ill", "edt", "ant", "art", "pht"] as const;
const person = z.strictObject({
  name: z.string().trim().min(1),
  role: z.enum(roles),
});
const nodeSchema = z.strictObject({
  key: z.string(),
  field: z.enum(fields),
  value: z.string(),
  role: z.string().nullable(),
  isbn: z.string().nullable(),
  primary: z.boolean(),
  record: z.string(),
});
const proposalSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("replace"), value: z.string().min(1) }),
  z.strictObject({ action: z.literal("remove") }),
  z.strictObject({
    action: z.literal("split"),
    contributors: z.array(person).min(1),
  }),
]);
const findingSchema = z.strictObject({
  key: z.string(),
  target: z.string(),
  rule: z.string(),
  message: z.string(),
  before: z.string(),
  proposed: proposalSchema.nullable(),
  decision: z.enum(["apply", "retain"]).nullable(),
  evidence: z.string().trim().min(1).nullable(),
});
const assignmentSchema = z.discriminatedUnion("field", [
  z.strictObject({
    field: z.enum([
      "title",
      "publisher",
      "date",
      "description",
      "language",
      "isbn",
    ]),
    value: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
    source: z.string().trim().min(1).optional(),
  }),
  z.strictObject({
    field: z.literal("contributors"),
    contributors: z.array(person).min(1),
    evidence: z.string().trim().min(1),
    source: z.string().trim().min(1).optional(),
  }),
]);
const planSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("bibliography"),
  format: z.literal("epub"),
  version: z.enum(["2.0", "3.0"]),
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
  inventory: z.array(nodeSchema),
  findings: z.array(findingSchema),
  assignments: z.array(assignmentSchema),
  reviewed: z.boolean(),
});
export type BibliographyPlan = z.infer<typeof planSchema>;
type Finding = z.infer<typeof findingSchema>;
type Proposal = z.infer<typeof proposalSchema>;
type Person = z.infer<typeof person>;

const refinementsOf = (file: MetadataFile, node: Element) => {
  const id = attr(node, "id");
  return id
    ? children(file.metadata).filter(
        (item) =>
          item.namespaceURI === NS.opf &&
          item.localName === "meta" &&
          attr(item, "refines") === `#${id}`,
      )
    : [];
};
function roleOf(file: MetadataFile, node: Element) {
  const epub2 = node.getAttributeNS(NS.opf, "role") || attr(node, "opf:role");
  if (epub2) return epub2;
  const meta = refinementsOf(file, node).find(
    (item) => attr(item, "property") === "role",
  );
  return meta?.textContent?.trim() || null;
}
function isbnOf(file: MetadataFile, node: Element) {
  const value = (node.textContent ?? "").trim();
  const scheme = (
    node.getAttributeNS(NS.opf, "scheme") || attr(node, "opf:scheme")
  ).toLowerCase();
  const type = refinementsOf(file, node).find(
    (item) =>
      attr(item, "property") === "identifier-type" &&
      attr(item, "scheme") === "onix:codelist5",
  )?.textContent;
  const declared =
    /^urn:isbn:/i.test(value) ||
    scheme === "isbn" ||
    ["15", "02"].includes(type ?? "");
  const normalized = normalizeIsbn(value);
  if (declared) return normalized ?? "invalid";
  return normalized && (type === "03" || !type) && !scheme ? normalized : null;
}
interface Located {
  key: string;
  field: Field;
  node: Element;
}
function locate(file: MetadataFile): Located[] {
  const counts = new Map<Field, number>();
  const found: Located[] = [];
  for (const node of children(file.metadata)) {
    if (node.namespaceURI !== NS.dc) continue;
    const field = node.localName as Field;
    if (!fields.includes(field)) continue;
    const index = counts.get(field) ?? 0;
    counts.set(field, index + 1);
    found.push({ key: `${field}/${index}`, field, node });
  }
  return found;
}
const primaryId = (file: MetadataFile) =>
  attr(file.document.documentElement!, "unique-identifier");

function inventory(file: MetadataFile) {
  const primary = primaryId(file);
  return locate(file).map(({ key, field, node }) => ({
    key,
    field,
    value: node.textContent ?? "",
    role: ["creator", "contributor"].includes(field)
      ? roleOf(file, node)
      : null,
    isbn: field === "identifier" ? isbnOf(file, node) : null,
    primary:
      field === "identifier" && !!primary && attr(node, "id") === primary,
    record: serialize(node),
  }));
}

function detect(nodes: ReturnType<typeof inventory>) {
  const findings: Omit<Finding, "key" | "decision" | "evidence">[] = [];
  const add = (
    target: (typeof nodes)[number],
    rule: string,
    message: string,
    proposed: Proposal | null,
  ) =>
    findings.push({
      target: target.key,
      rule,
      message,
      before: target.value,
      proposed,
    });
  const seenPeople = new Set<string>();
  const seenIsbn = new Set<string>();
  for (const node of nodes) {
    const value = node.value;
    const trimmed = value.trim();
    if (node.field === "title") {
      let cleaned = cleanTitle(value).value;
      cleaned = cleaned
        .replace(/\.(?:epub|txt|mobi|azw3?|pdf|docx?)$/i, "")
        .trim();
      if (cleaned !== value)
        add(
          node,
          "title-residue",
          "Title contains storefront, marketing, format or file-name residue",
          cleaned ? { action: "replace", value: cleaned } : null,
        );
    } else if (node.field === "creator" || node.field === "contributor") {
      const known = roles.find((role) => role === node.role);
      const parsed = parseContributors(value, known ?? "aut").contributors;
      const unchanged =
        parsed.length === 1 &&
        parsed[0].name === trimmed &&
        parsed[0].role === (known ?? "aut");
      if (!parsed.length)
        add(
          node,
          "credit-placeholder",
          "Credit is a placeholder, not a person",
          {
            action: "remove",
          },
        );
      else if (!unchanged)
        add(
          node,
          "credit-combined",
          "Credit combines several people, role markers or nationality prefixes",
          { action: "split", contributors: parsed },
        );
      else {
        const key = `${trimmed}\u0000${node.role ?? ""}`;
        if (seenPeople.has(key))
          add(
            node,
            "credit-duplicate",
            "Credit repeats an earlier person and role",
            {
              action: "remove",
            },
          );
        seenPeople.add(key);
      }
    } else if (node.field === "publisher") {
      if (isPlaceholder(value) || isWatermark(value))
        add(
          node,
          "publisher-residue",
          "Publisher is a placeholder or a download-site watermark",
          { action: "remove" },
        );
      else {
        const cleaned = cleanText(value, /^(?:出版社|publisher)\s*[:：]\s*/i);
        if (cleaned !== value)
          add(
            node,
            "publisher-format",
            "Publisher has a label or irregular spacing",
            {
              action: "replace",
              value: cleaned,
            },
          );
      }
    } else if (node.field === "date") {
      const date = normalizeDate(value);
      const time = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(
        trimmed,
      );
      if (/^0*101-01-01/.test(trimmed))
        add(
          node,
          "date-undefined",
          "Date is Calibre's undefined-date placeholder",
          {
            action: "remove",
          },
        );
      else if (!date)
        add(
          node,
          "date-unrecognized",
          "Date is not a recognizable publication date; replace it from a source",
          null,
        );
      else if (time && time.slice(2).some((part) => part && Number(part) !== 0))
        add(
          node,
          "date-shifted",
          "Date carries a non-midnight time, usually a time-zone shifted day; replace it from a source",
          null,
        );
      else if (date !== value)
        add(
          node,
          "date-format",
          "Date has a non-standard or time-qualified form",
          {
            action: "replace",
            value: date,
          },
        );
    } else if (node.field === "description") {
      const cleaned = cleanDescription(value).value;
      if (cleaned !== value)
        add(
          node,
          "description-residue",
          "Description contains markup, interface text, section labels or watermarks",
          cleaned
            ? { action: "replace", value: cleaned }
            : { action: "remove" },
        );
    } else if (node.field === "language") {
      const language = normalizeLanguage(value);
      if (!language)
        add(
          node,
          "language-undetermined",
          "Language is undetermined; set it from the book's actual text",
          null,
        );
      else if (language !== value)
        add(
          node,
          "language-format",
          "Language tag is not in canonical BCP 47 form",
          {
            action: "replace",
            value: language,
          },
        );
    } else if (node.field === "identifier" && node.isbn) {
      if (node.isbn === "invalid")
        add(
          node,
          "isbn-invalid",
          "Declared ISBN fails syntax or checksum validation; replace it only from a matched source",
          null,
        );
      else if (seenIsbn.has(node.isbn) && !node.primary)
        add(node, "isbn-duplicate", "ISBN repeats an earlier identifier", {
          action: "remove",
        });
      else {
        const prefix = /^urn:isbn:/i.test(trimmed) ? "urn:isbn:" : "";
        const expected = prefix + node.isbn;
        if (trimmed !== expected)
          add(
            node,
            "isbn-format",
            node.primary
              ? "Primary identifier ISBN is not normalized; the package identity is preserved"
              : "ISBN has separators or the ISBN-10 form",
            node.primary ? null : { action: "replace", value: expected },
          );
      }
      seenIsbn.add(node.isbn);
    }
  }
  return findings.map((item, index) => ({
    key: `finding/${index}`,
    ...item,
    decision: null,
    evidence: null,
  }));
}

export function auditBibliography(
  bytes: Buffer,
  options: { modified?: string } = {},
): BibliographyPlan {
  const file = openMetadata(bytes, "epub", { preserveContent: true });
  const nodes = inventory(file);
  return {
    schemaVersion: 1,
    operation: "bibliography",
    format: "epub",
    version: file.version as "2.0" | "3.0",
    sourceSha256: sha256(bytes),
    metadataSha256: sha256(file.entries.get(file.location)!.bytes),
    modified:
      options.modified ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    inventory: nodes,
    findings: detect(nodes),
    assignments: [],
    reviewed: false,
  };
}

const fieldOf = (
  assignment: BibliographyPlan["assignments"][number],
): Field[] =>
  assignment.field === "contributors"
    ? ["creator", "contributor"]
    : assignment.field === "isbn"
      ? ["identifier"]
      : [assignment.field];

function validateAssignment(
  assignment: BibliographyPlan["assignments"][number],
) {
  if (
    assignment.field === "date" &&
    normalizeDate(assignment.value) !== assignment.value
  )
    fail(
      "BIBLIOGRAPHY_VALUE",
      "Assigned dates use YYYY, YYYY-MM or YYYY-MM-DD",
    );
  if (
    assignment.field === "language" &&
    normalizeLanguage(assignment.value) !== assignment.value
  )
    fail("BIBLIOGRAPHY_VALUE", "Assigned languages use canonical BCP 47 tags");
  if (assignment.field === "isbn" && !normalizeIsbn(assignment.value))
    fail(
      "BIBLIOGRAPHY_VALUE",
      "Assigned ISBN fails syntax or checksum validation",
    );
}

export function applyBibliography(bytes: Buffer, value: unknown) {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success)
    fail("BIBLIOGRAPHY_PLAN", "Invalid bibliography plan", parsed.error.issues);
  const plan = parsed.data;
  if (sha256(bytes) !== plan.sourceSha256)
    fail("METADATA_STALE", "Source hash differs from the bibliography plan");
  const actual = auditBibliography(bytes, { modified: plan.modified });
  const frozen = (findings: Finding[]) =>
    findings.map((item) => ({
      key: item.key,
      target: item.target,
      rule: item.rule,
      message: item.message,
      before: item.before,
      proposed: item.proposed,
    }));
  if (
    actual.metadataSha256 !== plan.metadataSha256 ||
    stable(actual.inventory) !== stable(plan.inventory) ||
    stable(frozen(actual.findings)) !== stable(frozen(plan.findings))
  )
    fail(
      "BIBLIOGRAPHY_INVENTORY",
      "Do not edit the original inventory or findings; record decisions and assignments only",
    );
  if (!plan.reviewed)
    fail("BIBLIOGRAPHY_REVIEW", "Review every finding and set reviewed: true");
  for (const finding of plan.findings) {
    if (!finding.decision || !finding.evidence)
      fail(
        "BIBLIOGRAPHY_DECISION",
        `Decide ${finding.key} with apply or retain and explain the evidence`,
      );
    if (finding.decision === "apply" && !finding.proposed)
      fail(
        "BIBLIOGRAPHY_DECISION",
        `${finding.key} has no automatic correction; use an evidenced assignment instead`,
      );
  }
  const assigned = new Set<Field>();
  const names = new Set<string>();
  for (const assignment of plan.assignments) {
    validateAssignment(assignment);
    if (names.has(assignment.field))
      fail(
        "BIBLIOGRAPHY_CONFLICT",
        `Field ${assignment.field} is assigned more than once`,
      );
    names.add(assignment.field);
    for (const field of fieldOf(assignment)) assigned.add(field);
  }
  const applied = plan.findings.filter((item) => item.decision === "apply");
  for (const finding of applied) {
    const field = plan.inventory.find(
      (node) => node.key === finding.target,
    )!.field;
    if (assigned.has(field))
      fail(
        "BIBLIOGRAPHY_CONFLICT",
        `${finding.key} and an assignment both change ${field}`,
      );
  }

  const file = openMetadata(bytes, "epub", { preserveContent: true });
  const original = serialize(file.document);
  const located = new Map(locate(file).map((item) => [item.key, item]));
  const primary = primaryId(file);
  const ids = new Set(
    elements(file.document)
      .map((node) => attr(node, "id"))
      .filter(Boolean),
  );
  const reserveId = (base: string) => {
    let id = base;
    for (let n = 1; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  };
  const touched = new Set<Element>();
  const removeNode = (node: Element) => {
    const id = attr(node, "id");
    if (id && id === primary)
      fail(
        "BIBLIOGRAPHY_PRIMARY",
        "The package unique-identifier is never removed",
      );
    const refinements = refinementsOf(file, node);
    if (
      id &&
      elements(file.document).some(
        (item) =>
          item !== node &&
          !refinements.includes(item) &&
          [attr(item, "refines"), attr(item, "idref")].includes(`#${id}`),
      )
    )
      fail("BIBLIOGRAPHY_REFERENCE", `Metadata ${id} is referenced elsewhere`);
    for (const item of refinements) file.metadata.removeChild(item);
    file.metadata.removeChild(node);
    touched.add(node);
  };
  const createPerson = (entry: Person, before: Element) => {
    const element = file.document.createElementNS(
      NS.dc,
      entry.role === "aut" ? "dc:creator" : "dc:contributor",
    );
    element.textContent = entry.name;
    file.metadata.insertBefore(element, before);
    if (plan.version === "2.0")
      element.setAttributeNS(NS.opf, "opf:role", entry.role);
    else {
      const id = reserveId(entry.role === "aut" ? "creator" : "contributor");
      element.setAttribute("id", id);
      const meta = file.document.createElementNS(NS.opf, "meta");
      meta.setAttribute("refines", `#${id}`);
      meta.setAttribute("property", "role");
      meta.setAttribute("scheme", "marc:relators");
      meta.textContent = entry.role;
      file.metadata.insertBefore(meta, before);
    }
    touched.add(element);
  };
  const changes: {
    target: string;
    rule: string;
    before: string;
    after: unknown;
  }[] = [];
  for (const finding of applied) {
    const { node, field } = located.get(finding.target)!;
    const proposal = finding.proposed!;
    if (proposal.action === "replace") {
      if (field === "identifier" && attr(node, "id") === primary)
        fail(
          "BIBLIOGRAPHY_PRIMARY",
          "The package unique-identifier is never edited",
        );
      node.textContent = proposal.value;
      touched.add(node);
    } else if (proposal.action === "remove") removeNode(node);
    else {
      for (const entry of proposal.contributors) createPerson(entry, node);
      removeNode(node);
    }
    changes.push({
      target: finding.target,
      rule: finding.rule,
      before: finding.before,
      after: proposal.action === "replace" ? proposal.value : proposal,
    });
  }

  for (const assignment of plan.assignments) {
    const current = locate(file);
    if (assignment.field === "contributors") {
      const people = current.filter((item) =>
        ["creator", "contributor"].includes(item.field),
      );
      const anchor =
        people[0]?.node ??
        file.metadata.appendChild(file.document.createTextNode(""));
      for (const entry of assignment.contributors)
        createPerson(entry, anchor as Element);
      if (!people.length) file.metadata.removeChild(anchor);
      for (const item of people) removeNode(item.node);
      changes.push({
        target: "contributors",
        rule: "assignment",
        before: people.map((item) => item.node.textContent ?? "").join(" / "),
        after: assignment.contributors,
      });
      continue;
    }
    if (assignment.field === "isbn") {
      const isbn = normalizeIsbn(assignment.value)!;
      const existing = current
        .filter((item) => item.field === "identifier")
        .map((item) => ({ ...item, isbn: isbnOf(file, item.node) }))
        .filter((item) => item.isbn);
      if (existing.some((item) => item.isbn === isbn)) continue;
      const editable = existing.filter(
        (item) => attr(item.node, "id") !== primary,
      );
      if (editable.length > 1)
        fail(
          "METADATA_AMBIGUOUS",
          "Several ISBN identifiers require an explicit finding",
        );
      if (!editable.length && existing.length)
        fail(
          "BIBLIOGRAPHY_PRIMARY",
          "The only ISBN is the package unique-identifier; report the constraint instead",
        );
      if (editable.length) {
        const node = editable[0].node;
        const before = node.textContent ?? "";
        node.textContent =
          (/^urn:isbn:/i.test(before.trim()) ? "urn:isbn:" : "") + isbn;
        touched.add(node);
        changes.push({
          target: "isbn",
          rule: "assignment",
          before,
          after: isbn,
        });
        continue;
      }
      const node = file.document.createElementNS(NS.dc, "dc:identifier");
      const id = reserveId("isbn");
      node.setAttribute("id", id);
      node.textContent = isbn;
      file.metadata.appendChild(node);
      if (plan.version === "2.0")
        node.setAttributeNS(NS.opf, "opf:scheme", "ISBN");
      else {
        const meta = file.document.createElementNS(NS.opf, "meta");
        meta.setAttribute("refines", `#${id}`);
        meta.setAttribute("property", "identifier-type");
        meta.setAttribute("scheme", "onix:codelist5");
        meta.textContent = "15";
        file.metadata.appendChild(meta);
      }
      touched.add(node);
      changes.push({
        target: "isbn",
        rule: "assignment",
        before: "",
        after: isbn,
      });
      continue;
    }
    const nodes = current.filter((item) => item.field === assignment.field);
    if (nodes.length > 1)
      fail(
        "METADATA_AMBIGUOUS",
        `Several dc:${assignment.field} elements require explicit findings`,
      );
    const node =
      nodes[0]?.node ??
      file.metadata.appendChild(
        file.document.createElementNS(NS.dc, `dc:${assignment.field}`),
      );
    const before = node.textContent ?? "";
    node.textContent = assignment.value;
    touched.add(node);
    changes.push({
      target: assignment.field,
      rule: "assignment",
      before,
      after: assignment.value,
    });
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
  verify(bytes, output.bytes, plan);
  return {
    ...output,
    report: {
      sourceSha256: plan.sourceSha256,
      metadataSha256: plan.metadataSha256,
      changed,
      changes,
      retained: plan.findings
        .filter((item) => item.decision === "retain")
        .map(({ key, rule, before, evidence }) => ({
          key,
          rule,
          before,
          evidence,
        })),
      assignments: plan.assignments,
      preserved: output.preserved,
    },
  };
}

/** Readback: identity, structure and every unselected metadata record must survive. */
function verify(before: Buffer, after: Buffer, plan: BibliographyPlan) {
  const source = openMetadata(before, "epub", { preserveContent: true });
  const result = openMetadata(after, "epub", { preserveContent: true });
  const outside = (file: MetadataFile) => {
    const copy = file.document.cloneNode(true) as typeof file.document;
    for (const node of elements(copy, "metadata", NS.opf))
      node.parentNode!.removeChild(node);
    return serialize(copy);
  };
  if (outside(source) !== outside(result) || result.version !== source.version)
    fail("METADATA_INTEGRITY", "Package structure outside metadata changed");
  const primary = primaryId(source);
  const identity = (file: MetadataFile) =>
    elements(file.metadata, "identifier", NS.dc)
      .filter((node) => attr(node, "id") === primary)
      .map(serialize);
  if (stable(identity(source)) !== stable(identity(result)))
    fail("METADATA_INTEGRITY", "The package unique-identifier changed");
  const targets = new Set(
    plan.findings
      .filter((item) => item.decision === "apply")
      .map((item) => item.target),
  );
  const assignedFields = new Set(plan.assignments.flatMap(fieldOf));
  const protectedRecords = (file: MetadataFile, isSource: boolean) => {
    const skip = new Set<Element>();
    if (isSource)
      for (const { key, field, node } of locate(file))
        if (targets.has(key) || assignedFields.has(field)) {
          skip.add(node);
          for (const item of refinementsOf(file, node)) skip.add(item);
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
  const kept = protectedRecords(source, true);
  const remaining = new Set(protectedRecords(result, false));
  const missing = kept.filter((record) => !remaining.has(record));
  if (missing.length)
    fail(
      "METADATA_INTEGRITY",
      "Unselected metadata changed",
      missing.slice(0, 5),
    );
}

export async function auditFileBibliography(
  file: string,
  options: { output?: string } = {},
) {
  if (metadataFormat(file) !== "epub")
    fail("METADATA_FORMAT", "Bibliography cleanup supports EPUB files");
  const plan = auditBibliography(await readSourceFile(file));
  if (options.output)
    await fs.writeFile(options.output, stable(plan), { flag: "wx" });
  return plan;
}
export async function cleanBibliography(
  file: string,
  options: { plan: unknown; output: string; signal?: AbortSignal },
) {
  if (metadataFormat(file) !== "epub")
    fail("METADATA_FORMAT", "Bibliography cleanup supports EPUB files");
  const bytes = await readSourceFile(file);
  const result = applyBibliography(bytes, options.plan);
  return deliverMetadata(file, {
    ...options,
    ...result,
    format: "epub",
    preserveContent: true,
    sourceSha256: sha256(bytes),
  });
}
