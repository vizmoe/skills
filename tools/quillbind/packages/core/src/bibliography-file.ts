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
import { attr, elements, NS, removeNode, serialize } from "./xml.js";
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

function nextFieldKey(counts: Map<Field, number>, field: Field): string {
  const index = counts.get(field) ?? 0;
  counts.set(field, index + 1);
  return `${field}/${index}`;
}

function locateEpub(file: MetadataFile): Located[] {
  const counts = new Map<Field, number>();
  const found: Located[] = [];
  for (const node of children(file.metadata)) {
    if (node.namespaceURI !== NS.dc) continue;
    const field = node.localName as Field;
    if (!fields.includes(field) || field === "imprint") continue;
    found.push({ key: nextFieldKey(counts, field), field, node });
  }
  return found;
}

function locateCbz(file: MetadataFile): Located[] {
  const counts = new Map<Field, number>();
  const found: Located[] = [];
  const metaChildren = children(file.metadata).filter((n) => !n.namespaceURI);
  const dateParts = ["Year", "Month", "Day"]
    .map((name) => metaChildren.find((n) => n.localName === name))
    .filter((n): n is Element => Boolean(n));
  let dateInserted = false;

  for (const node of metaChildren) {
    const local = node.localName ?? "";
    if (local === "Year" || local === "Month" || local === "Day") {
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
    const field =
      comicCreditElements[local]?.field ?? comicScalarElements[local];
    if (field)
      found.push({
        key: nextFieldKey(counts, field),
        field,
        node,
        comicName: local,
      });
  }
  return found;
}

function locate(file: MetadataFile): Located[] {
  return file.format === "epub" ? locateEpub(file) : locateCbz(file);
}

const primaryId = (file: MetadataFile) =>
  file.format === "epub"
    ? attr(file.document.documentElement!, "unique-identifier")
    : "";

function parseComicIntPart(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}

function formatComicDateCandidate(
  y: number,
  m: number | undefined,
  d: number | undefined,
): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  if (d !== undefined && d > 0) return `${y}-${pad2(m!)}-${pad2(d)}`;
  if (m !== undefined && m > 0) return `${y}-${pad2(m)}`;
  return `${y}`;
}

function isCanonicalComicDateXml(
  byName: Map<string, string>,
  y: number,
  m: number | undefined,
  d: number | undefined,
): boolean {
  const monthOk =
    !byName.has("Month") ||
    (m !== undefined && m > 0 && byName.get("Month") === String(m));
  const dayOk =
    !byName.has("Day") ||
    (d !== undefined && d > 0 && byName.get("Day") === String(d));
  return byName.get("Year") === String(y) && monthOk && dayOk;
}

function isUndefinedComicDate(
  y: number | undefined,
  m: number | undefined,
  d: number | undefined,
): boolean {
  const present = [y, m, d].filter((v): v is number => v !== undefined);
  if (present.every((v) => v <= 0)) return true;
  return (
    y === 101 && (m === undefined || m === 1) && (d === undefined || d === 1)
  );
}

function hasInvalidComicDateParts(
  y: number | undefined,
  m: number | undefined,
  d: number | undefined,
): boolean {
  if (y === undefined || y < 1000 || y > 9999) return true;
  return d !== undefined && d > 0 && (m === undefined || m <= 0);
}

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
  const y = parseComicIntPart(byName.get("Year"));
  const m = parseComicIntPart(byName.get("Month"));
  const d = parseComicIntPart(byName.get("Day"));

  if ([y, m, d].some((v) => v !== undefined && Number.isNaN(v)))
    return { value: rawDisplay, state: "unrecognized" };
  if (isUndefinedComicDate(y, m, d))
    return { value: rawDisplay, state: "undefined" };
  if (hasInvalidComicDateParts(y, m, d))
    return { value: rawDisplay, state: "unrecognized" };

  const candidate = formatComicDateCandidate(y!, m, d);
  const normalized = normalizeDate(candidate);
  if (!normalized || normalized !== candidate)
    return { value: rawDisplay, state: "unrecognized" };
  return isCanonicalComicDateXml(byName, y!, m, d)
    ? { value: normalized, state: "clean", normalized }
    : { value: rawDisplay, state: "format", normalized };
}

function inventoryRole(
  file: MetadataFile,
  field: Field,
  node: Element,
  comicName: string | undefined,
): string | null {
  if (field !== "creator" && field !== "contributor") return null;
  if (file.format === "cbz")
    return comicCreditElements[comicName ?? ""]?.role ?? null;
  return roleOf(file, node);
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
      role: inventoryRole(file, field, node, comicName),
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

type InventoryNode = ReturnType<typeof inventory>[number];
type AddFinding = (
  target: InventoryNode,
  rule: string,
  message: string,
  proposed: Proposal | null,
) => void;

function detectTitleFinding(node: InventoryNode, add: AddFinding) {
  const withoutExt = node.value
    .replace(/\.(?:epub|cbz|zip|txt|mobi|azw3?|pdf|docx?)$/i, "")
    .trim();
  const cleaned = cleanTitle(withoutExt).value;
  if (cleaned !== node.value)
    add(
      node,
      "title-residue",
      "Title contains storefront, marketing, format or file-name residue",
      cleaned ? { action: "replace", value: cleaned } : null,
    );
}

function detectCbzCreditFinding(
  node: InventoryNode,
  parsed: Person[],
  locatedByKey: Map<string, Located>,
  add: AddFinding,
) {
  const comicName = locatedByKey.get(node.key)?.comicName ?? "Writer";
  const creditMeta = comicCreditElements[comicName];
  if (!parsed.length) {
    add(node, "credit-placeholder", "Credit is a placeholder, not a person", {
      action: "remove",
    });
    return;
  }
  if (parsed.some((c) => !comicRoleTarget[c.role])) {
    add(
      node,
      "credit-unsupported-role",
      "Credit includes translator or photographer role unsupported by ComicInfo 2.0; decide explicitly without flattening into Writer",
      null,
    );
    return;
  }
  const allAcceptedHere = parsed.every((c) =>
    creditMeta.acceptedRoles.includes(c.role),
  );
  if (!allAcceptedHere) {
    add(
      node,
      "credit-combined",
      "Credit combines roles belonging to separate ComicInfo 2.0 elements",
      { action: "split", contributors: parsed },
    );
    return;
  }
  const canonicalHere = [...new Set(parsed.map((c) => c.name))].join(", ");
  if (canonicalHere !== node.value)
    add(
      node,
      "credit-format",
      "Credit carries role markers, nationality prefixes, duplicates or non-canonical spacing",
      { action: "replace", value: canonicalHere },
    );
}

function detectEpubCreditFinding(
  node: InventoryNode,
  parsed: Person[],
  known: Role | undefined,
  seenPeople: Set<string>,
  add: AddFinding,
) {
  const trimmed = node.value.trim();
  if (!parsed.length) {
    add(node, "credit-placeholder", "Credit is a placeholder, not a person", {
      action: "remove",
    });
    return;
  }
  const unchanged =
    parsed.length === 1 &&
    parsed[0].name === trimmed &&
    parsed[0].role === (known ?? "aut");
  if (!unchanged) {
    add(
      node,
      "credit-combined",
      "Credit combines several people, role markers or nationality prefixes",
      { action: "split", contributors: parsed },
    );
    return;
  }
  const key = `${trimmed}\u0000${node.role ?? ""}`;
  if (seenPeople.has(key))
    add(node, "credit-duplicate", "Credit repeats an earlier person and role", {
      action: "remove",
    });
  seenPeople.add(key);
}

function detectPublisherOrImprintFinding(node: InventoryNode, add: AddFinding) {
  const label = node.field === "imprint" ? "Imprint" : "Publisher";
  if (isPlaceholder(node.value) || isWatermark(node.value)) {
    add(
      node,
      `${node.field}-residue`,
      `${label} is a placeholder or a download-site watermark`,
      { action: "remove" },
    );
    return;
  }
  const cleaned = cleanText(
    node.value,
    node.field === "imprint"
      ? /^(?:レーベル|書系|丛书|叢書|imprint)\s*[:：]\s*/i
      : /^(?:出版社|publisher)\s*[:：]\s*/i,
  );
  if (cleaned !== node.value)
    add(
      node,
      `${node.field}-format`,
      `${label} has a label or irregular spacing`,
      { action: "replace", value: cleaned },
    );
}

function detectCbzDateFinding(
  node: InventoryNode,
  locatedByKey: Map<string, Located>,
  add: AddFinding,
) {
  const info = inspectComicDate(locatedByKey.get(node.key)?.nodes ?? []);
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
}

function detectEpubDateFinding(node: InventoryNode, add: AddFinding) {
  const trimmed = node.value.trim();
  const date = normalizeDate(node.value);
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
  else if (time?.slice(2).some((part) => part && Number(part) !== 0))
    add(
      node,
      "date-shifted",
      "Date carries a non-midnight time, usually a time-zone shifted day; replace it from a source",
      null,
    );
  else if (date !== node.value)
    add(node, "date-format", "Date has a non-standard or time-qualified form", {
      action: "replace",
      value: date,
    });
}

function detectLanguageFinding(node: InventoryNode, add: AddFinding) {
  const language = normalizeLanguage(node.value);
  if (!language)
    add(
      node,
      "language-undetermined",
      "Language is undetermined; set it from the book's actual text",
      null,
    );
  else if (language !== node.value)
    add(
      node,
      "language-format",
      "Language tag is not in canonical BCP 47 form",
      {
        action: "replace",
        value: language,
      },
    );
}

function detectIsbnFormatFinding(node: InventoryNode, add: AddFinding) {
  const trimmed = node.value.trim();
  const prefix = /^urn:isbn:/i.test(trimmed) ? "urn:isbn:" : "";
  const expected = prefix + node.isbn;
  if (trimmed === expected) return;
  add(
    node,
    "isbn-format",
    node.primary
      ? "Primary identifier ISBN is not normalized; the package identity is preserved"
      : "ISBN has separators or the ISBN-10 form",
    node.primary ? null : { action: "replace", value: expected },
  );
}

function detectIsbnFinding(
  node: InventoryNode,
  seenIsbn: Set<string>,
  add: AddFinding,
) {
  if (!node.isbn) return;
  if (node.isbn === "invalid") {
    add(
      node,
      "isbn-invalid",
      "Declared ISBN fails syntax or checksum validation; replace it only from a matched source",
      null,
    );
  } else if (seenIsbn.has(node.isbn) && !node.primary) {
    add(node, "isbn-duplicate", "ISBN repeats an earlier identifier", {
      action: "remove",
    });
  } else {
    detectIsbnFormatFinding(node, add);
  }
  seenIsbn.add(node.isbn);
}

function detectNodeFinding(
  file: MetadataFile,
  node: InventoryNode,
  locatedByKey: Map<string, Located>,
  seenPeople: Set<string>,
  seenIsbn: Set<string>,
  add: AddFinding,
) {
  switch (node.field) {
    case "title":
      detectTitleFinding(node, add);
      return;
    case "creator":
    case "contributor": {
      const known = roles.find((role) => role === node.role);
      const parsed = parseContributors(node.value, known ?? "aut").contributors;
      if (file.format === "cbz")
        detectCbzCreditFinding(node, parsed, locatedByKey, add);
      else detectEpubCreditFinding(node, parsed, known, seenPeople, add);
      return;
    }
    case "publisher":
    case "imprint":
      detectPublisherOrImprintFinding(node, add);
      return;
    case "date":
      if (file.format === "cbz") detectCbzDateFinding(node, locatedByKey, add);
      else detectEpubDateFinding(node, add);
      return;
    case "description": {
      const cleaned = cleanDescription(node.value).value;
      if (cleaned !== node.value)
        add(
          node,
          "description-residue",
          "Description contains markup, interface text, section labels or watermarks",
          cleaned
            ? { action: "replace", value: cleaned }
            : { action: "remove" },
        );
      return;
    }
    case "language":
      detectLanguageFinding(node, add);
      return;
    case "identifier":
      detectIsbnFinding(node, seenIsbn, add);
      return;
  }
}

function detect(file: MetadataFile, nodes: ReturnType<typeof inventory>) {
  const findings: Omit<Finding, "key" | "decision" | "evidence">[] = [];
  const add: AddFinding = (target, rule, message, proposed) => {
    findings.push({
      target: target.key,
      rule,
      message,
      before: target.value,
      proposed,
    });
  };
  const seenPeople = new Set<string>();
  const seenIsbn = new Set<string>();
  const locatedByKey = new Map(locate(file).map((item) => [item.key, item]));
  for (const node of nodes)
    detectNodeFinding(file, node, locatedByKey, seenPeople, seenIsbn, add);
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

function fieldOf(assignment: BibliographyPlan["assignments"][number]): Field[] {
  if (assignment.field === "contributors") return ["creator", "contributor"];
  if (assignment.field === "isbn") return ["identifier"];
  return [assignment.field];
}

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

type BibliographyChange = {
  target: string;
  rule: string;
  before: string;
  after: unknown;
};

const comicScalarToElement: Record<string, string> = {
  title: "Title",
  description: "Summary",
  publisher: "Publisher",
  imprint: "Imprint",
  language: "LanguageISO",
};

function writeComicDate(file: MetadataFile, isoDate: string | null) {
  for (const node of children(file.metadata)) {
    if (
      !node.namespaceURI &&
      ["Year", "Month", "Day"].includes(node.localName ?? "")
    )
      removeNode(node);
  }
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
    removeNode(existing);
    return;
  }
  if (existing) existing.textContent = value;
  else insertComicElement(file, elementName, value);
}

function groupComicContributors(contributors: Person[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const c of contributors) {
    const targetEl = comicRoleTarget[c.role]!;
    const list = grouped.get(targetEl) ?? [];
    if (!list.includes(c.name)) list.push(c.name);
    grouped.set(targetEl, list);
  }
  return grouped;
}

function applyCbzScalarOrDateFinding(
  file: MetadataFile,
  entry: Located,
  proposal: Extract<Proposal, { action: "remove" | "replace" }>,
  touchedNames: Set<string>,
) {
  if (entry.field === "date") {
    for (const n of ["Year", "Month", "Day"]) touchedNames.add(n);
    writeComicDate(file, proposal.action === "replace" ? proposal.value : null);
    return;
  }
  touchedNames.add(entry.comicName!);
  if (proposal.action === "remove") {
    if (entry.node.parentNode === file.metadata) removeNode(entry.node);
  } else {
    entry.node.textContent = proposal.value;
  }
}

function applyCbzSplitFindings(
  file: MetadataFile,
  splitFindings: Finding[],
  located: Map<string, Located>,
  touchedNames: Set<string>,
) {
  if (!splitFindings.length) return;
  const splitContributors: Person[] = [];
  for (const finding of splitFindings) {
    const entry = located.get(finding.target)!;
    touchedNames.add(entry.comicName!);
    if (entry.node.parentNode === file.metadata) removeNode(entry.node);
    const proposal = finding.proposed as Extract<Proposal, { action: "split" }>;
    splitContributors.push(...proposal.contributors);
  }
  for (const [targetEl, names] of groupComicContributors(splitContributors)) {
    touchedNames.add(targetEl);
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

function applyCbzFindings(
  file: MetadataFile,
  applied: Finding[],
  located: Map<string, Located>,
  touchedNames: Set<string>,
  changes: BibliographyChange[],
) {
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
    } else {
      applyCbzScalarOrDateFinding(file, entry, proposal, touchedNames);
    }
  }
  applyCbzSplitFindings(file, splitFindings, located, touchedNames);
  for (const finding of applied) {
    const proposal = finding.proposed!;
    changes.push({
      target: finding.target,
      rule: finding.rule,
      before: finding.before,
      after: proposal.action === "replace" ? proposal.value : proposal,
    });
  }
}

function applyCbzContributorsAssignment(
  file: MetadataFile,
  contributors: Person[],
  touchedNames: Set<string>,
  changes: BibliographyChange[],
) {
  const creditNames = Object.keys(comicCreditElements);
  const beforeNodes = children(file.metadata).filter(
    (n) => !n.namespaceURI && creditNames.includes(n.localName ?? ""),
  );
  const beforeSummary = beforeNodes
    .map((n) => `${n.localName}: ${n.textContent ?? ""}`)
    .join(" / ");
  for (const name of creditNames) touchedNames.add(name);
  for (const n of beforeNodes) removeNode(n);
  for (const [targetEl, names] of groupComicContributors(contributors))
    insertComicElement(file, targetEl, names.join(", "));
  changes.push({
    target: "contributors",
    rule: "assignment",
    before: beforeSummary,
    after: contributors,
  });
}

function applyCbzDateAssignment(
  file: MetadataFile,
  value: string,
  touchedNames: Set<string>,
  changes: BibliographyChange[],
) {
  const beforeParts = children(file.metadata).filter(
    (n) =>
      !n.namespaceURI && ["Year", "Month", "Day"].includes(n.localName ?? ""),
  );
  const before = beforeParts.length ? inspectComicDate(beforeParts).value : "";
  for (const n of ["Year", "Month", "Day"]) touchedNames.add(n);
  writeComicDate(file, value);
  changes.push({ target: "date", rule: "assignment", before, after: value });
}

function applyCbzAssignment(
  file: MetadataFile,
  assignment: BibliographyPlan["assignments"][number],
  touchedNames: Set<string>,
  changes: BibliographyChange[],
) {
  if (assignment.field === "contributors") {
    applyCbzContributorsAssignment(
      file,
      assignment.contributors,
      touchedNames,
      changes,
    );
    return;
  }
  if (assignment.field === "date") {
    applyCbzDateAssignment(file, assignment.value, touchedNames, changes);
    return;
  }
  const elementName = comicScalarToElement[assignment.field];
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

function applyBibliographyCbz(
  bytes: Buffer,
  plan: BibliographyPlan,
  applied: Finding[],
) {
  const file = openMetadata(bytes, "cbz", { preserveContent: true });
  const original = serialize(file.document);
  const located = new Map(locate(file).map((item) => [item.key, item]));
  const changes: BibliographyChange[] = [];
  const touchedNames = new Set<string>();

  applyCbzFindings(file, applied, located, touchedNames, changes);
  for (const assignment of plan.assignments)
    applyCbzAssignment(file, assignment, touchedNames, changes);

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
    report: buildBibliographyReport(plan, changed, changes, output.preserved),
  };
}

function buildBibliographyReport(
  plan: BibliographyPlan,
  changed: boolean,
  changes: BibliographyChange[],
  preserved: { name: string; sha256: string; method: number }[],
) {
  return {
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
    preserved,
  };
}

function validatePlanDecisions(plan: BibliographyPlan) {
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
}

function validatePlanAssignmentsAndConflicts(plan: BibliographyPlan) {
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
  return applied;
}

function validateBibliographyPlan(bytes: Buffer, value: unknown) {
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
    findings.map(({ key, target, rule, message, before, proposed }) => ({
      key,
      target,
      rule,
      message,
      before,
      proposed,
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
  validatePlanDecisions(plan);
  const applied = validatePlanAssignmentsAndConflicts(plan);
  return { plan, applied };
}

function createEpubIdReserver(file: MetadataFile) {
  const ids = new Set(
    elements(file.document)
      .map((node) => attr(node, "id"))
      .filter(Boolean),
  );
  return (base: string) => {
    let id = base;
    let n = 1;
    while (ids.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    ids.add(id);
    return id;
  };
}

function removeEpubMetadataNode(
  file: MetadataFile,
  node: Element,
  primary: string,
) {
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
  for (const item of refinements) removeNode(item);
  removeNode(node);
}

type EpubVersion = "2.0" | "3.0" | undefined;

function createEpubPerson(
  file: MetadataFile,
  entry: Person,
  before: Element,
  version: EpubVersion,
  reserveId: (base: string) => string,
) {
  const element = file.document.createElementNS(
    NS.dc,
    entry.role === "aut" ? "dc:creator" : "dc:contributor",
  );
  element.textContent = entry.name;
  file.metadata.insertBefore(element, before);
  if (version === "2.0") {
    element.setAttributeNS(NS.opf, "opf:role", entry.role);
    return;
  }
  const id = reserveId(entry.role === "aut" ? "creator" : "contributor");
  element.setAttribute("id", id);
  const meta = file.document.createElementNS(NS.opf, "meta");
  meta.setAttribute("refines", `#${id}`);
  meta.setAttribute("property", "role");
  meta.setAttribute("scheme", "marc:relators");
  meta.textContent = entry.role;
  file.metadata.insertBefore(meta, before);
}

function applySingleEpubFinding(
  file: MetadataFile,
  finding: Finding,
  entry: Located,
  primary: string,
  version: EpubVersion,
  reserveId: (base: string) => string,
) {
  const { node, field } = entry;
  const proposal = finding.proposed!;
  if (proposal.action === "replace") {
    if (field === "identifier" && attr(node, "id") === primary)
      fail(
        "BIBLIOGRAPHY_PRIMARY",
        "The package unique-identifier is never edited",
      );
    node.textContent = proposal.value;
    return;
  }
  if (proposal.action === "remove") {
    removeEpubMetadataNode(file, node, primary);
    return;
  }
  for (const personEntry of proposal.contributors)
    createEpubPerson(file, personEntry, node, version, reserveId);
  removeEpubMetadataNode(file, node, primary);
}

function applyEpubFindings(
  file: MetadataFile,
  applied: Finding[],
  located: Map<string, Located>,
  primary: string,
  version: EpubVersion,
  reserveId: (base: string) => string,
  changes: BibliographyChange[],
) {
  for (const finding of applied) {
    applySingleEpubFinding(
      file,
      finding,
      located.get(finding.target)!,
      primary,
      version,
      reserveId,
    );
    const proposal = finding.proposed!;
    changes.push({
      target: finding.target,
      rule: finding.rule,
      before: finding.before,
      after: proposal.action === "replace" ? proposal.value : proposal,
    });
  }
}

function applyEpubIsbnAssignment(
  file: MetadataFile,
  current: Located[],
  value: string,
  primary: string,
  version: EpubVersion,
  reserveId: (base: string) => string,
  changes: BibliographyChange[],
) {
  const isbn = normalizeIsbn(value)!;
  const existing = current
    .filter((item) => item.field === "identifier")
    .map((item) => ({ ...item, isbn: isbnOf(file, item.node) }))
    .filter((item) => item.isbn);
  if (existing.some((item) => item.isbn === isbn)) return;
  const editable = existing.filter((item) => attr(item.node, "id") !== primary);
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
    changes.push({ target: "isbn", rule: "assignment", before, after: isbn });
    return;
  }
  const node = file.document.createElementNS(NS.dc, "dc:identifier");
  const id = reserveId("isbn");
  node.setAttribute("id", id);
  node.textContent = isbn;
  file.metadata.appendChild(node);
  if (version === "2.0") {
    node.setAttributeNS(NS.opf, "opf:scheme", "ISBN");
  } else {
    const meta = file.document.createElementNS(NS.opf, "meta");
    meta.setAttribute("refines", `#${id}`);
    meta.setAttribute("property", "identifier-type");
    meta.setAttribute("scheme", "onix:codelist5");
    meta.textContent = "15";
    file.metadata.appendChild(meta);
  }
  changes.push({ target: "isbn", rule: "assignment", before: "", after: isbn });
}

function applyEpubAssignment(
  file: MetadataFile,
  assignment: BibliographyPlan["assignments"][number],
  primary: string,
  version: EpubVersion,
  reserveId: (base: string) => string,
  changes: BibliographyChange[],
) {
  const current = locate(file);
  if (assignment.field === "contributors") {
    const people = current.filter((item) =>
      ["creator", "contributor"].includes(item.field),
    );
    const anchor =
      people[0]?.node ??
      file.metadata.appendChild(file.document.createTextNode(""));
    for (const entry of assignment.contributors)
      createEpubPerson(file, entry, anchor as Element, version, reserveId);
    if (!people.length) removeNode(anchor);
    for (const item of people) removeEpubMetadataNode(file, item.node, primary);
    changes.push({
      target: "contributors",
      rule: "assignment",
      before: people.map((item) => item.node.textContent ?? "").join(" / "),
      after: assignment.contributors,
    });
    return;
  }
  if (assignment.field === "isbn") {
    applyEpubIsbnAssignment(
      file,
      current,
      assignment.value,
      primary,
      version,
      reserveId,
      changes,
    );
    return;
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
  changes.push({
    target: assignment.field,
    rule: "assignment",
    before,
    after: assignment.value,
  });
}

export function applyBibliography(bytes: Buffer, value: unknown) {
  const { plan, applied } = validateBibliographyPlan(bytes, value);
  if (plan.format === "cbz") return applyBibliographyCbz(bytes, plan, applied);

  const file = openMetadata(bytes, "epub", { preserveContent: true });
  const original = serialize(file.document);
  const located = new Map(locate(file).map((item) => [item.key, item]));
  const primary = primaryId(file);
  const reserveId = createEpubIdReserver(file);
  const changes: BibliographyChange[] = [];

  applyEpubFindings(
    file,
    applied,
    located,
    primary,
    plan.version,
    reserveId,
    changes,
  );
  for (const assignment of plan.assignments)
    applyEpubAssignment(
      file,
      assignment,
      primary,
      plan.version,
      reserveId,
      changes,
    );

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
    report: buildBibliographyReport(plan, changed, changes, output.preserved),
  };
}

function outsideMetadata(file: MetadataFile) {
  const copy = file.document.cloneNode(true) as typeof file.document;
  for (const node of elements(copy, "metadata", NS.opf)) removeNode(node);
  return serialize(copy);
}

function protectedEpubRecords(
  file: MetadataFile,
  targets: Set<string>,
  assignedFields: Set<Field>,
  isSource: boolean,
) {
  const skip = new Set<Element>();
  if (isSource) {
    for (const { key, field, node } of locate(file)) {
      if (!targets.has(key) && !assignedFields.has(field)) continue;
      skip.add(node);
      for (const item of refinementsOf(file, node)) skip.add(item);
    }
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
}

/** Readback: identity, structure and every unselected metadata record must survive. */
function verify(before: Buffer, after: Buffer, plan: BibliographyPlan) {
  const source = openMetadata(before, "epub", { preserveContent: true });
  const result = openMetadata(after, "epub", { preserveContent: true });
  if (
    outsideMetadata(source) !== outsideMetadata(result) ||
    result.version !== source.version
  )
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
  const kept = protectedEpubRecords(source, targets, assignedFields, true);
  const remaining = new Set(
    protectedEpubRecords(result, targets, assignedFields, false),
  );
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
