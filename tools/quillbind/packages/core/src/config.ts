import { z } from "zod";
import { parseDocument } from "yaml";
import path from "node:path";
import { safeRead } from "./files.js";
import { fail } from "./errors.js";
import { repoRoot } from "./runtime.js";
import { readJson } from "./json.js";
import fs from "node:fs/promises";
import { conversionTargets } from "./zhconvert.js";

const text = z.string();
export type NavigationEntry =
  string | { title: string; children: NavigationEntry[] };
const navigationEntrySchema: z.ZodType<NavigationEntry> = z.lazy(() =>
  z.union([
    z.string().min(1),
    z.strictObject({
      title: z.string().trim().min(1),
      children: z.array(navigationEntrySchema).min(1),
    }),
  ]),
);
const chapterMetadataSchema = z.strictObject({
  fields: z
    .array(z.enum(["author", "date", "source"]))
    .default(["author", "date", "source"]),
  display: z.enum(["byline", "hidden"]).default("byline"),
});
const markdownSchema = z.strictObject({
  cjkEmphasis: z.enum(["auto", "on", "off"]).default("auto"),
  profile: z.enum(["quillbind", "blog"]).default("quillbind"),
  chapterMetadata: chapterMetadataSchema.default(
    chapterMetadataSchema.parse({}),
  ),
});
export const bookSchema = z.strictObject({
  schemaVersion: z.literal(1),
  bookwalker: z.string().trim().min(1).optional(),
  book: z.strictObject({
    title: text,
    authors: z.array(z.string().trim().min(1)),
    description: text,
    language: z.string(),
    publication: z.strictObject({
      isbn: z.string().nullable(),
    }),
    tags: z.array(z.string()),
  }),
  theme: z.enum(["literature", "technical"]),
  markdown: markdownSchema.default(markdownSchema.parse({})),
  conversion: z.strictObject({ target: z.enum(conversionTargets) }).optional(),
  qa: z
    .strictObject({
      coverage: z.enum(["full", "stratified"]).default("full"),
      screenshots: z
        .enum(["failures-and-samples", "all"])
        .default("failures-and-samples"),
    })
    .optional(),
  chapters: z.array(z.string().min(1)).min(1),
  navigation: z.array(navigationEntrySchema).min(1).optional(),
  direction: z.enum(["ltr", "rtl"]).default("ltr"),
  pageProgression: z.enum(["ltr", "rtl", "default"]).optional(),
  writingMode: z
    .enum(["horizontal-tb", "vertical-rl"])
    .default("horizontal-tb"),
  cover: z.strictObject({ path: z.string() }).optional(),
  styles: z.array(z.string()).default([]),
  fonts: z
    .array(
      z.strictObject({
        path: z.string(),
        family: z.string().regex(/^[a-zA-Z][a-zA-Z0-9 -]*$/),
        license: z.string().min(1),
      }),
    )
    .default([]),
  references: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-zA-Z][\w-]*$/),
        text: z.string().min(1),
        url: z.string().url().optional(),
      }),
    )
    .default([]),
  build: z.strictObject({
    epoch: z.number().int().min(315532800).max(4354819198),
    stripImageMetadata: z.literal(false).default(false),
    optimizeImages: z.boolean().default(true),
  }),
});
export type BookConfig = z.infer<typeof bookSchema>;
export interface BookProject {
  root: string;
  config: BookConfig;
  configText: string;
}
export function parseYaml(source: string): unknown {
  const document = parseDocument(source, { uniqueKeys: true, version: "1.2" });
  if (document.errors.length)
    fail("YAML_INVALID", document.errors.map((e) => e.message).join("; "));
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch {
    fail("YAML_ALIAS", "YAML aliases are not accepted");
  }
}
export async function openBook(root: string): Promise<BookProject> {
  const resolved = await fs.realpath(root);
  const configText = (await safeRead(resolved, "book.yaml")).toString("utf8");
  const parsed = bookSchema.safeParse(parseYaml(configText));
  if (!parsed.success)
    fail(
      "CONFIG_INVALID",
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n"),
    );
  if (new Set(parsed.data.chapters).size !== parsed.data.chapters.length)
    fail("DUPLICATE_CHAPTER", "A chapter occurs more than once in book.yaml");
  if (parsed.data.navigation) {
    const leaves = (entries: NavigationEntry[]): string[] =>
      entries.flatMap((entry) =>
        typeof entry === "string" ? [entry] : leaves(entry.children),
      );
    const sources = leaves(parsed.data.navigation);
    if (
      sources.length !== parsed.data.chapters.length ||
      sources.some((source, index) => source !== parsed.data.chapters[index])
    )
      fail(
        "NAVIGATION_CHAPTERS",
        "Navigation must include every chapter exactly once, in book.yaml chapter order",
      );
  }
  return { root: resolved, config: parsed.data, configText };
}
export interface Taxon {
  id: string;
  label: string;
  parent: string;
  basis: { scheme: "LCC-inspired"; classes: string[] };
  sources: string[];
  aliases: string[];
  deprecated: boolean;
  migration?: string;
}
export async function taxonomy() {
  const value = parseYaml(
    await fs.readFile(path.join(repoRoot, "taxonomy/subjects.v1.yaml"), "utf8"),
  ) as { schemaVersion: number; version: string; subjects: Taxon[] };
  if (value.schemaVersion !== 1)
    fail("TAXONOMY_VERSION", "Unsupported taxonomy");
  return value;
}
export async function standards() {
  return readJson(path.join(repoRoot, "standards/registry.json"));
}
export const schemaJson = () =>
  z.toJSONSchema(bookSchema, { target: "draft-2020-12" });
export function validLanguage(value: string) {
  try {
    return (
      !!value &&
      Intl.getCanonicalLocales(value).length === 1 &&
      !value.includes("_")
    );
  } catch {
    return false;
  }
}
export function validIsbn(value: string) {
  const digits = value.replace(/[- ]/g, "");
  return (
    /^97[89]\d{10}$/.test(digits) &&
    [...digits].reduce((sum, d, i) => sum + Number(d) * (i % 2 ? 3 : 1), 0) %
      10 ===
      0
  );
}
