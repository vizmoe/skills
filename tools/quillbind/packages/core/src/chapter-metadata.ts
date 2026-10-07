import type { BookConfig } from "./config.js";
import type { Document, Inline } from "./model.js";
import { fail } from "./errors.js";

type ChapterMetadata = NonNullable<Document["chapterMetadata"]>;

/** Only canonical fields selected in book.yaml may cross the frontmatter boundary. */
export function chapterMetadata(
  properties: Record<string, unknown>,
  settings: BookConfig["markdown"]["chapterMetadata"],
  source: string,
): ChapterMetadata | undefined {
  const value: ChapterMetadata = { display: settings.display };
  const get = (name: string) =>
    Object.hasOwn(properties, name) ? properties[name] : undefined;
  const invalid = (field: string, expected: string): never =>
    fail("CHAPTER_PROPERTY", `${source}: ${field} ${expected}`);
  const string = (input: unknown, field: string): string => {
    if (typeof input !== "string" || !input.trim())
      return invalid(field, "must be a non-empty string");
    return input.trim();
  };
  const aliases = <T>(
    names: string[],
    parse: (input: unknown, field: string) => T,
  ): T | undefined => {
    const values = names
      .filter((name) => get(name) !== undefined)
      .map((name) => parse(get(name), name));
    if (
      values.some((item) => JSON.stringify(item) !== JSON.stringify(values[0]))
    )
      return invalid(names.join("/"), "contain conflicting values");
    return values[0];
  };
  if (settings.fields.includes("author"))
    value.authors = aliases(["author", "authors"], (input, field) => {
      const values = Array.isArray(input) ? input : [input];
      if (!values.length) return invalid(field, "must include an author");
      return values.map((item) => string(item, field));
    });
  if (settings.fields.includes("date"))
    value.date = aliases(["date", "pubDate"], string);
  if (settings.fields.includes("source") && get("source") !== undefined) {
    const raw = string(get("source"), "source");
    const target = /^\[[^\]\n]*\]\((https:\/\/[^\s]+)\)$/.exec(raw)?.[1] ?? raw;
    try {
      const url = new URL(target);
      if (
        url.protocol !== "https:" ||
        !url.hostname ||
        url.username ||
        url.password ||
        /[\s\\]/.test(target)
      )
        return invalid(
          "source",
          "must be an absolute HTTPS URL without credentials",
        );
      value.source = url.href;
    } catch {
      return invalid(
        "source",
        "must be an absolute HTTPS URL; quote a Markdown link in YAML",
      );
    }
  }
  return value.authors || value.date || value.source ? value : undefined;
}

export function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

/** Format an unambiguous calendar date without changing the source timezone. */
export function chapterDisplayDate(value: string): string | undefined {
  const numeric =
    /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value) ??
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(value) ??
    /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/.exec(value);
  let date = numeric
    ? `${numeric[1]}-${numeric[2].padStart(2, "0")}-${numeric[3].padStart(2, "0")}`
    : undefined;
  const timestamp =
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.exec(
      value,
    );
  if (timestamp) date = timestamp[1];
  const named = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(value);
  if (named) {
    const months = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ];
    const month = months.findIndex(
      (name) =>
        name === named[1].toLowerCase() ||
        name.slice(0, 3) === named[1].toLowerCase(),
    );
    if (month >= 0)
      date = `${named[3]}-${String(month + 1).padStart(2, "0")}-${named[2].padStart(2, "0")}`;
  }
  return date && isIsoDate(date) ? date : undefined;
}

/** Replace title hyperlinks while keeping formatting and note links independent. */
export function linkChapterTitle(values: Inline[], source: string): Inline[] {
  const unwrap = (items: Inline[]): Inline[] =>
    items.flatMap((item) =>
      item.kind === "link"
        ? unwrap(item.children)
        : [
            "children" in item
              ? { ...item, children: unwrap(item.children) }
              : item,
          ],
    );
  const hasReference = (item: Inline): boolean =>
    item.kind === "footnoteRef" ||
    item.kind === "citation" ||
    ("children" in item && item.children.some(hasReference));
  const result: Inline[] = [];
  const pending: Inline[] = [];
  const flush = () => {
    if (pending.length)
      result.push({
        kind: "link",
        target: source,
        children: pending.splice(0),
      });
  };
  for (const item of unwrap(values)) {
    if (hasReference(item)) {
      flush();
      result.push(
        "children" in item
          ? { ...item, children: linkChapterTitle(item.children, source) }
          : item,
      );
    } else pending.push(item);
  }
  flush();
  return result;
}
