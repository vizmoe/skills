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
  type MetadataFormat,
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
import { insertComicElement } from "./tags-file.js";
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
  "imprint",
  "date",
  "description",
  "language",
  "identifier",
] as const;
type Field = (typeof fields)[number];
const roles = ["aut", "trl", "ill", "edt", "ant", "art", "pht"] as const;
type Role = (typeof roles)[number];
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
      "imprint",
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
const planSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    operation: z.literal("bibliography"),
    format: z.enum(["epub", "cbz"]),
    version: z.enum(["2.0", "3.0"]).optional(),
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
  })
  .refine(
    (data) => (data.format === "epub") === (data.version !== undefined),
    "EPUB plans require version; CBZ plans omit version",
  );
export type BibliographyPlan = z.infer<typeof planSchema>;
type Finding = z.infer<typeof findingSchema>;
type Proposal = z.infer<typeof proposalSchema>;
type Person = z.infer<typeof person>;

const comicCreditElements: Record<
  string,
  { field: "creator" | "contributor"; role: Role; acceptedRoles: Role[] }
> = {
  Writer: { field: "creator", role: "aut", acceptedRoles: ["aut", "ant"] },
  Penciller: { field: "contributor", role: "art", acceptedRoles: ["art"] },
  Inker: { field: "contributor", role: "art", acceptedRoles: ["art"] },
  Colorist: { field: "contributor", role: "art", acceptedRoles: ["art"] },
  Letterer: { field: "contributor", role: "art", acceptedRoles: ["art"] },
  CoverArtist: { field: "contributor", role: "ill", acceptedRoles: ["ill"] },
  Editor: { field: "contributor", role: "edt", acceptedRoles: ["edt"] },
};

const comicScalarElements: Record<string, Field> = {
  Title: "title",
  Summary: "description",
  Publisher: "publisher",
  Imprint: "imprint",
  LanguageISO: "language",
};

const comicRoleTarget: Partial<Record<Role, string>> = {
  aut: "Writer",
  ant: "Writer",
  art: "Penciller",
  ill: "CoverArtist",
  edt: "Editor",
};

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
  nodes?: Element[];
  comicName?: string;
}

function locate(file: MetadataFile): Located[] {
  const counts = new Map<Field, number>();
  const found: Located[] = [];
  if (file.format === "epub") {
    for (const node of children(file.metadata)) {
      if (node.namespaceURI !== NS.dc) continue;
      const field = node.localName as Field;
      if (!fields.includes(field) || field === "imprint") continue;
      const index = counts.get(field) ?? 0;
      counts.set(field, index + 1);
      found.push({ key: `${field}/${index}`, field, node });
    }
    return found;
  }

  const metaChildren = children(file.metadata);
  const dateParts = ["Year", "Month", "Day"]
    .map((name) =>
      metaChildren.find((n) => !n.namespaceURI && n.localName === name),
    )
    .filter((n): n is Element => Boolean(n));
  let dateInserted = false;

  for (const node of metaChildren) {
    if (node.namespaceURI) continue;
    const local = node.localName ?? "";
    if (["Year", "Month", "Day"].includes(local)) {
      if (!dateInserted && dateParts.length) {
        dateInserted = true;
        found.push({
          key: "date/0",
          field: "date",
          node: dateParts[0],
          nodes: dateParts,
          comicName: "Date",
        });
      }
      continue;
    }
    const credit = comicCreditElements[local];
    if (credit) {
      const index = counts.get(credit.field) ?? 0;
      counts.set(credit.field, index + 1);
      found.push({
        key: `${credit.field}/${index}`,
        field: credit.field,
        node,
        comicName: local,
      });
      continue;
    }
    const scalarField = comicScalarElements[local];
    if (scalarField) {
      const index = counts.get(scalarField) ?? 0;
      counts.set(scalarField, index + 1);
      found.push({
        key: `${scalarField}/${index}`,
        field: scalarField,
        node,
        comicName: local,
      });
    }
  }
  return found;
}

const primaryId = (file: MetadataFile) =>
  file.format === "epub"
    ? attr(file.document.documentElement!, "unique-identifier")
    : "";

function inspectComicDate(parts: Element[]): {
  value: string;
  state: "clean" | "undefined" | "format" | "unrecognized";
  normalized?: string;
} {
  const byName = new Map(
    parts.map((n) => [n.localName ?? "", n.textContent ?? ""]),
  );
  const rawDisplay = ["Year", "Month", "Day"]
    .filter((k) => byName.has(k))
    .map((k) => `${k}=${byName.get(k)}`)
    .join(", ");
  const parsePart = (raw: string | undefined) => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) return NaN;
    return Number(trimmed);
  };
  const y = parsePart(byName.get("Year"));
  const m = parsePart(byName.get("Month"));
  const d = parsePart(byName.get("Day"));

  if ([y, m, d].some((v) => v !== undefined && Number.isNaN(v)))
    return { value: rawDisplay, state: "unrecognized" };
  const presentValues = [y, m, d].filter((v): v is number => v !== undefined);
  if (
    presentValues.every((v) => v <= 0) ||
    (y === 101 && (m === undefined || m === 1) && (d === undefined || d === 1))
  )
    return { value: rawDisplay, state: "undefined" };
  if (y === undefined || y < 1000 || y > 9999)
    return { value: rawDisplay, state: "unrecognized" };
  if (d !== undefined && d > 0 && (m === undefined || m <= 0))
    return { value: rawDisplay, state: "unrecognized" };

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const candidate =
    d !== undefined && d > 0
      ? `${y}-${pad2(m!)}-${pad2(d)}`
      : m !== undefined && m > 0
        ? `${y}-${pad2(m)}`
        : `${y}`;
  const normalized = normalizeDate(candidate);
  if (!normalized || normalized !== candidate)
    return { value: rawDisplay, state: "unrecognized" };

  const canonicalXml =
    byName.get("Year") === String(y) &&
    (!byName.has("Month") ||
      (m !== undefined && m > 0 && byName.get("Month") === String(m))) &&
    (!byName.has("Day") ||
      (d !== undefined && d > 0 && byName.get("Day") === String(d)));

  return canonicalXml
    ? { value: normalized, state: "clean", normalized }
    : { value: rawDisplay, state: "format", normalized };
}

function inventory(file: MetadataFile) {
  const primary = primaryId(file);
  return locate(file).map(({ key, field, node, nodes, comicName }) => {
    if (file.format === "cbz" && field === "date" && nodes) {
      const dateInfo = inspectComicDate(nodes);
      return {
        key,
        field,
        value: dateInfo.value,
        role: null,
        isbn: null,
        primary: false,
        record: nodes.map(serialize).join(""),
      };
    }
    return {
      key,
      field,
      value: node.textContent ?? "",
      role: ["creator", "contributor"].includes(field)
        ? file.format === "cbz"
          ? (comicCreditElements[comicName ?? ""]?.role ?? null)
          : roleOf(file, node)
        : null,
      isbn:
        file.format === "epub" && field === "identifier"
          ? isbnOf(file, node)
          : null,
      primary:
        file.format === "epub" &&
        field === "identifier" &&
        !!primary &&
        attr(node, "id") === primary,
      record: serialize(node),
    };
  });
}

function detect(file: MetadataFile, nodes: ReturnType<typeof inventory>) {
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
  const locatedByKey = new Map(locate(file).map((item) => [item.key, item]));

  for (const node of nodes) {
    const value = node.value;
    const trimmed = value.trim();
    if (node.field === "title") {
      const withoutExt = value
        .replace(/\.(?:epub|cbz|zip|txt|mobi|azw3?|pdf|docx?)$/i, "")
        .trim();
      const cleaned = cleanTitle(withoutExt).value;
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
      if (file.format === "cbz") {
        const comicName = locatedByKey.get(node.key)?.comicName ?? "Writer";
        const creditMeta = comicCreditElements[comicName];
        if (!parsed.length) {
          add(
            node,
            "credit-placeholder",
            "Credit is a placeholder, not a person",
            { action: "remove" },
          );
        } else if (parsed.some((c) => !comicRoleTarget[c.role])) {
          add(
            node,
            "credit-unsupported-role",
            "Credit includes translator or photographer role unsupported by ComicInfo 2.0; decide explicitly without flattening into Writer",
            null,
          );
        } else {
          const allAcceptedHere = parsed.every((c) =>
            creditMeta.acceptedRoles.includes(c.role),
          );
          const dedupedNames = [...new Set(parsed.map((c) => c.name))];
          const canonicalHere = dedupedNames.join(", ");
          if (allAcceptedHere) {
            if (canonicalHere !== value)
              add(
                node,
                "credit-format",
                "Credit carries role markers, nationality prefixes, duplicates or non-canonical spacing",
                { action: "replace", value: canonicalHere },
              );
          } else {
            add(
              node,
              "credit-combined",
              "Credit combines roles belonging to separate ComicInfo 2.0 elements",
              { action: "split", contributors: parsed },
            );
          }
        }
        continue;
      }

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
    } else if (node.field === "publisher" || node.field === "imprint") {
      if (isPlaceholder(value) || isWatermark(value))
        add(
          node,
          `${node.field}-residue`,
          `${node.field === "imprint" ? "Imprint" : "Publisher"} is a placeholder or a download-site watermark`,
          { action: "remove" },
        );
      else {
        const cleaned = cleanText(
          value,
          node.field === "imprint"
            ? /^(?:レーベル|書系|丛书|叢書|imprint)\s*[:：]\s*/i
            : /^(?:出版社|publisher)\s*[:：]\s*/i,
        );
        if (cleaned !== value)
          add(
            node,
            `${node.field}-format`,
            `${node.field === "imprint" ? "Imprint" : "Publisher"} has a label or irregular spacing`,
            {
              action: "replace",
              value: cleaned,
            },
          );
      }
    } else if (node.field === "date") {
      if (file.format === "cbz") {
        const parts = locatedByKey.get(node.key)?.nodes ?? [];
        const info = inspectComicDate(parts);
        if (info.state === "undefined")
          add(
            node,
            "date-undefined",
            "ComicInfo date uses default -1/0 values or Calibre's undefined-date placeholder",
            { action: "remove" },
          );
        else if (info.state === "unrecognized")
          add(
            node,
            "date-unrecognized",
            "ComicInfo Year/Month/Day is not a valid calendar date; replace it from a source",
            null,
          );
        else if (info.state === "format" && info.normalized)
          add(
            node,
            "date-format",
            "ComicInfo Year/Month/Day carries default -1/0 components or non-canonical integers",
            { action: "replace", value: info.normalized },
          );
        continue;
      }
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
  options: { modified?: string; format?: MetadataFormat } = {},
): BibliographyPlan {
  const format = options.format ?? "epub";
  const file = openMetadata(bytes, format, { preserveContent: true });
  const nodes = inventory(file);
  return {
    schemaVersion: 1,
    operation: "bibliography",
    format,
    ...(format === "epub" ? { version: file.version as "2.0" | "3.0" } : {}),
    sourceSha256: sha256(bytes),
    metadataSha256: sha256(file.entries.get(file.location)!.bytes),
    modified:
      options.modified ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    inventory: nodes,
    findings: detect(file, nodes),
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
  format: MetadataFormat,
) {
  if (format === "cbz" && assignment.field === "isbn")
    fail(
      "COMICINFO_ISBN_UNSUPPORTED",
      "ComicInfo 2.0 has no ISBN field; leave CBZ without a fabricated ISBN element",
    );
  if (format === "epub" && assignment.field === "imprint")
    fail(
      "EPUB_IMPRINT_UNSUPPORTED",
      "EPUB bibliography plans assign publisher via dc:publisher; Imprint is ComicInfo-specific",
    );
  if (format === "cbz" && assignment.field === "contributors") {
    const unsupported = assignment.contributors.find(
      (person) => !comicRoleTarget[person.role],
    );
    if (unsupported)
      fail(
        "COMICINFO_ROLE_UNSUPPORTED",
        `ComicInfo 2.0 has no element for contributor role ${unsupported.role}; never flatten unsupported roles into Writer`,
      );
  }
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

function writeComicDate(file: MetadataFile, isoDate: string | null) {
  for (const node of children(file.metadata))
    if (
      !node.namespaceURI &&
      ["Year", "Month", "Day"].includes(node.localName ?? "")
    )
      file.metadata.removeChild(node);
  if (!isoDate) return;
  const [year, month, day] = isoDate.split("-");
  insertComicElement(file, "Year", String(Number(year)));
  if (month !== undefined)
    insertComicElement(file, "Month", String(Number(month)));
  if (day !== undefined) insertComicElement(file, "Day", String(Number(day)));
}

function writeComicScalar(
  file: MetadataFile,
  elementName: string,
  value: string | null,
) {
  const existing = children(file.metadata).find(
    (node) => !node.namespaceURI && node.localName === elementName,
  );
  if (value === null) {
    if (existing) file.metadata.removeChild(existing);
    return;
  }
  if (existing) existing.textContent = value;
  else insertComicElement(file, elementName, value);
}

function applyBibliographyCbz(
  bytes: Buffer,
  plan: BibliographyPlan,
  applied: Finding[],
) {
  const file = openMetadata(bytes, "cbz", { preserveContent: true });
  const original = serialize(file.document);
  const located = new Map(locate(file).map((item) => [item.key, item]));
  const changes: {
    target: string;
    rule: string;
    before: string;
    after: unknown;
  }[] = [];
  const touchedNames = new Set<string>();

  const splitFindings: Finding[] = [];
  for (const finding of applied) {
    const entry = located.get(finding.target)!;
    const proposal = finding.proposed!;
    if (proposal.action === "split") {
      const unsupported = proposal.contributors.find(
        (c) => !comicRoleTarget[c.role],
      );
      if (unsupported)
        fail(
          "COMICINFO_ROLE_UNSUPPORTED",
          `ComicInfo 2.0 has no element for contributor role ${unsupported.role}`,
        );
      splitFindings.push(finding);
      continue;
    }
    if (entry.field === "date") {
      for (const n of ["Year", "Month", "Day"]) touchedNames.add(n);
      if (proposal.action === "remove") writeComicDate(file, null);
      else if (proposal.action === "replace")
        writeComicDate(file, proposal.value);
    } else if (proposal.action === "remove") {
      touchedNames.add(entry.comicName!);
      if (entry.node.parentNode === file.metadata)
        file.metadata.removeChild(entry.node);
    } else if (proposal.action === "replace") {
      touchedNames.add(entry.comicName!);
      entry.node.textContent = proposal.value;
    }
  }

  if (splitFindings.length) {
    for (const finding of splitFindings) {
      const entry = located.get(finding.target)!;
      touchedNames.add(entry.comicName!);
      if (entry.node.parentNode === file.metadata)
        file.metadata.removeChild(entry.node);
    }
    const grouped = new Map<string, string[]>();
    for (const finding of splitFindings) {
      const proposal = finding.proposed as Extract<
        Proposal,
        { action: "split" }
      >;
      for (const c of proposal.contributors) {
        const targetEl = comicRoleTarget[c.role]!;
        touchedNames.add(targetEl);
        const list = grouped.get(targetEl) ?? [];
        if (!list.includes(c.name)) list.push(c.name);
        grouped.set(targetEl, list);
      }
    }
    for (const [targetEl, names] of grouped) {
      const existingNode = children(file.metadata).find(
        (n) => !n.namespaceURI && n.localName === targetEl,
      );
      const existingNames = existingNode
        ? (existingNode.textContent ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const merged = [...new Set([...existingNames, ...names])];
      writeComicScalar(file, targetEl, merged.join(", "));
    }
  }

  for (const finding of applied) {
    const proposal = finding.proposed!;
    changes.push({
      target: finding.target,
      rule: finding.rule,
      before: finding.before,
      after: proposal.action === "replace" ? proposal.value : proposal,
    });
  }

  const scalarToElement: Record<string, string> = {
    title: "Title",
    description: "Summary",
    publisher: "Publisher",
    imprint: "Imprint",
    language: "LanguageISO",
  };

  for (const assignment of plan.assignments) {
    if (assignment.field === "contributors") {
      const creditNames = Object.keys(comicCreditElements);
      const beforeNodes = children(file.metadata).filter(
        (n) => !n.namespaceURI && creditNames.includes(n.localName ?? ""),
      );
      const beforeSummary = beforeNodes
        .map((n) => `${n.localName}: ${n.textContent ?? ""}`)
        .join(" / ");
      for (const name of creditNames) touchedNames.add(name);
      for (const n of beforeNodes) file.metadata.removeChild(n);

      const grouped = new Map<string, string[]>();
      for (const c of assignment.contributors) {
        const targetEl = comicRoleTarget[c.role]!;
        const list = grouped.get(targetEl) ?? [];
        if (!list.includes(c.name)) list.push(c.name);
        grouped.set(targetEl, list);
      }
      for (const [targetEl, names] of grouped) {
        insertComicElement(file, targetEl, names.join(", "));
      }
      changes.push({
        target: "contributors",
        rule: "assignment",
        before: beforeSummary,
        after: assignment.contributors,
      });
      continue;
    }
    if (assignment.field === "date") {
      const beforeParts = children(file.metadata).filter(
        (n) =>
          !n.namespaceURI &&
          ["Year", "Month", "Day"].includes(n.localName ?? ""),
      );
      const before = beforeParts.length
        ? inspectComicDate(beforeParts).value
        : "";
      for (const n of ["Year", "Month", "Day"]) touchedNames.add(n);
      writeComicDate(file, assignment.value);
      changes.push({
        target: "date",
        rule: "assignment",
        before,
        after: assignment.value,
      });
      continue;
    }
    const elementName = scalarToElement[assignment.field];
    touchedNames.add(elementName);
    const existing = children(file.metadata).find(
      (n) => !n.namespaceURI && n.localName === elementName,
    );
    const before = existing?.textContent ?? "";
    writeComicScalar(file, elementName, assignment.value);
    changes.push({
      target: assignment.field,
      rule: "assignment",
      before,
      after: assignment.value,
    });
  }

  const changed = serialize(file.document) !== original;
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

  // Verify every untouched ComicInfo element survived identically
  const source = openMetadata(bytes, "cbz", { preserveContent: true });
  const result = openMetadata(output.bytes, "cbz", { preserveContent: true });
  const protectedCbz = (doc: MetadataFile) =>
    children(doc.metadata)
      .filter((n) => !(!n.namespaceURI && touchedNames.has(n.localName ?? "")))
      .map(serialize);
  if (stable(protectedCbz(source)) !== stable(protectedCbz(result)))
    fail("METADATA_INTEGRITY", "Unselected ComicInfo metadata fields changed");

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

export function applyBibliography(bytes: Buffer, value: unknown) {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success)
    fail("BIBLIOGRAPHY_PLAN", "Invalid bibliography plan", parsed.error.issues);
  const plan = parsed.data;
  if (sha256(bytes) !== plan.sourceSha256)
    fail("METADATA_STALE", "Source hash differs from the bibliography plan");
  const actual = auditBibliography(bytes, {
    modified: plan.modified,
    format: plan.format,
  });
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
    validateAssignment(assignment, plan.format);
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

  if (plan.format === "cbz") return applyBibliographyCbz(bytes, plan, applied);

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
  const format = metadataFormat(file);
  const plan = auditBibliography(await readSourceFile(file), { format });
  if (options.output)
    await fs.writeFile(options.output, stable(plan), { flag: "wx" });
  return plan;
}

export async function cleanBibliography(
  file: string,
  options: { plan: unknown; output: string; signal?: AbortSignal },
) {
  const format = metadataFormat(file);
  if (
    options.plan &&
    typeof options.plan === "object" &&
    "format" in options.plan &&
    (options.plan as { format?: unknown }).format !== format
  )
    fail("METADATA_FORMAT", "Plan format must match the source file format");
  const bytes = await readSourceFile(file);
  const result = applyBibliography(bytes, options.plan);
  return deliverMetadata(file, {
    output: options.output,
    signal: options.signal,
    ...result,
    format,
    preserveContent: true,
    sourceSha256: sha256(bytes),
  });
}
