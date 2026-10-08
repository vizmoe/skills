import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const key = (value) =>
  value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/\s*\.\s*/gu, ".")
    .toLowerCase();
export function requireValue(condition, code, message) {
  if (!condition) throw Object.assign(new Error(message), { code });
}
export const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const strings = (value) =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" && item.trim());

export async function readInput(file) {
  const resolved = await fs.realpath(file);
  const bytes = await fs.readFile(resolved);
  return {
    value: JSON.parse(bytes.toString("utf8")),
    source: { path: resolved, sha256: digest(bytes) },
  };
}

export async function loadVocabulary(
  file = process.env.QUILLBIND_VOCABULARY ||
    fileURLToPath(
      new URL("../references/tag-vocabulary.json", import.meta.url),
    ),
) {
  const input = await readInput(path.resolve(file));
  const data = input.value;
  const check = (condition, message) =>
    requireValue(condition, "TAXONOMY_INVALID", message);
  check(
    object(data) &&
      Number.isSafeInteger(data.version) &&
      data.version > 0 &&
      data.structure === "Major.Controlled Subclass",
    "Expected a versioned Major.Controlled Subclass vocabulary",
  );
  check(
    object(data.fixed_major_classes) &&
      object(data.controlled_subclasses) &&
      object(data.flat_to_hierarchical),
    "Missing controlled vocabulary tables",
  );
  const majors = Object.keys(data.fixed_major_classes);
  check(
    majors.length > 0 &&
      Object.keys(data.controlled_subclasses).length === majors.length,
    "Major classes and subclass tables must match",
  );
  const component = (value) =>
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9 &'()/+-]*$/.test(value) &&
    value === value.trim() &&
    !/\s{2}/.test(value);
  const subjects = [];
  const canonical = new Set();
  const aliases = new Map();
  function alias(name, target) {
    const normalized = key(name);
    check(
      !aliases.has(normalized) || aliases.get(normalized) === target,
      `Ambiguous normalized tag: ${name}`,
    );
    aliases.set(normalized, target);
  }
  for (const major of majors) {
    check(
      component(major) && typeof data.fixed_major_classes[major] === "string",
      `Invalid major: ${major}`,
    );
    const subclasses = data.controlled_subclasses[major];
    check(strings(subclasses), `Invalid subclass list: ${major}`);
    for (const child of subclasses) {
      check(component(child), `Invalid subclass: ${child}`);
      const id = `${major}.${child}`;
      check(!canonical.has(id), `Duplicate tag: ${id}`);
      canonical.add(id);
      alias(id, id);
      subjects.push({
        id,
        label: child,
        parent: major,
        basis: {
          scheme: "LCC-inspired",
          classes: [data.fixed_major_classes[major]],
        },
        sources: data.reference ? [data.reference] : [],
        aliases: [],
        deprecated: false,
      });
    }
  }
  for (const [name, target] of Object.entries(data.flat_to_hierarchical)) {
    check(
      component(name) && typeof target === "string" && canonical.has(target),
      `Invalid alias mapping: ${name}`,
    );
    alias(name, target);
    subjects.find((item) => item.id === target).aliases.push(name);
  }
  return {
    schemaVersion: 1,
    version: `calibre-${data.version}-${input.source.sha256}`,
    subjects,
    canonical,
    aliases,
    source: input.source,
  };
}
