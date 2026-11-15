import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export interface SourceInfo {
  path: string;
  sha256: string;
}

export interface InputRecord<T = unknown> {
  value: T;
  source: SourceInfo;
}

export interface Taxon {
  id: string;
  label: string;
  parent: string;
  basis: {
    scheme: string;
    classes: string[];
  };
  sources: string[];
  aliases: string[];
  deprecated: boolean;
  migration?: string;
}

export interface Vocabulary {
  schemaVersion: number;
  version: string;
  subjects: Taxon[];
  canonical: Set<string>;
  aliases: Map<string, string>;
  source: SourceInfo;
}

interface RawVocabulary {
  version: number;
  structure: string;
  reference?: string;
  fixed_major_classes: Record<string, string>;
  controlled_subclasses: Record<string, string[]>;
  flat_to_hierarchical: Record<string, string>;
}

export const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const key = (value: string): string =>
  value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/\s*\.\s*/gu, ".")
    .toLowerCase();

export function requireValue(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw Object.assign(new Error(message), { code });
}

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const strings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" && Boolean(item.trim()));

export async function readInput<T = unknown>(
  file: string,
): Promise<InputRecord<T>> {
  const resolved = await fs.realpath(file);
  const bytes = await fs.readFile(resolved);
  return {
    value: JSON.parse(bytes.toString("utf8")) as T,
    source: { path: resolved, sha256: digest(bytes) },
  };
}

function checkTaxonomy(condition: unknown, message: string): asserts condition {
  requireValue(condition, "TAXONOMY_INVALID", message);
}

export async function loadVocabulary(
  file: string = process.env.QUILLBIND_VOCABULARY ||
    fileURLToPath(
      new URL("../references/tag-vocabulary.json", import.meta.url),
    ),
): Promise<Vocabulary> {
  const input = await readInput<unknown>(path.resolve(file));
  const data = input.value;
  checkTaxonomy(
    object(data) &&
      Number.isSafeInteger(data.version) &&
      typeof data.version === "number" &&
      data.version > 0 &&
      data.structure === "Major.Controlled Subclass",
    "Expected a versioned Major.Controlled Subclass vocabulary",
  );
  checkTaxonomy(
    object(data.fixed_major_classes) &&
      object(data.controlled_subclasses) &&
      object(data.flat_to_hierarchical),
    "Missing controlled vocabulary tables",
  );
  const raw = data as unknown as RawVocabulary;
  const majors = Object.keys(raw.fixed_major_classes);
  checkTaxonomy(
    majors.length > 0 &&
      Object.keys(raw.controlled_subclasses).length === majors.length,
    "Major classes and subclass tables must match",
  );
  const component = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9 &'()/+-]*$/.test(value) &&
    value === value.trim() &&
    !/\s{2}/.test(value);
  const subjects: Taxon[] = [];
  const canonical = new Set<string>();
  const aliases = new Map<string, string>();
  function alias(name: string, target: string): void {
    const normalized = key(name);
    checkTaxonomy(
      !aliases.has(normalized) || aliases.get(normalized) === target,
      `Ambiguous normalized tag: ${name}`,
    );
    aliases.set(normalized, target);
  }
  for (const major of majors) {
    checkTaxonomy(
      component(major) && typeof raw.fixed_major_classes[major] === "string",
      `Invalid major: ${major}`,
    );
    const subclasses = raw.controlled_subclasses[major];
    checkTaxonomy(strings(subclasses), `Invalid subclass list: ${major}`);
    for (const child of subclasses) {
      checkTaxonomy(component(child), `Invalid subclass: ${child}`);
      const id = `${major}.${child}`;
      checkTaxonomy(!canonical.has(id), `Duplicate tag: ${id}`);
      canonical.add(id);
      alias(id, id);
      subjects.push({
        id,
        label: child,
        parent: major,
        basis: {
          scheme: "LCC-inspired",
          classes: [raw.fixed_major_classes[major]],
        },
        sources: typeof raw.reference === "string" ? [raw.reference] : [],
        aliases: [],
        deprecated: false,
      });
    }
  }
  for (const [name, target] of Object.entries(raw.flat_to_hierarchical)) {
    checkTaxonomy(
      component(name) && typeof target === "string" && canonical.has(target),
      `Invalid alias mapping: ${name}`,
    );
    alias(name, target);
    const subject = subjects.find((item) => item.id === target);
    checkTaxonomy(subject !== undefined, `Missing target subject: ${target}`);
    subject.aliases.push(name);
  }
  return {
    schemaVersion: 1,
    version: `calibre-${raw.version}-${input.source.sha256}`,
    subjects,
    canonical,
    aliases,
    source: input.source,
  };
}
