import { z } from "zod";
import { fail } from "./errors.js";

const text = z.string().trim().min(1).max(100000);
const number = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .nullable();
export const bookWalkerSelectionSchema = z.strictObject({
  kind: z.enum(["light-novel", "manga"]),
  language: z.enum(["ja", "zh-Hant", "zh-Hans"]),
  japaneseUrl: text,
  translatedUrl: text.optional(),
  number,
  matchEvidence: z.array(text).min(1).max(20),
});
export type BookWalkerSelection = z.infer<typeof bookWalkerSelectionSchema>;
export const contributorSchema = z.strictObject({
  name: text,
  role: z.enum(["aut", "ill", "art", "trl", "ant", "adp"]),
});
export const editionSchema = z.strictObject({
  url: text,
  site: z.enum(["jp", "tw"]),
  kind: z.enum(["light-novel", "manga"]),
  title: text,
  series: text.optional(),
  number,
  description: z.string().max(100000),
  contributors: z.array(contributorSchema).max(100),
  publisher: text.optional(),
  imprint: text.optional(),
  printIsbn: text.optional(),
  electronicIsbn: text.optional(),
  printDate: text.optional(),
  electronicDate: text.optional(),
});
export type BookWalkerEdition = z.infer<typeof editionSchema>;
export interface BookWalkerMetadata extends BookWalkerEdition {
  language: BookWalkerSelection["language"];
  originalTitle: string;
  releaseDate: string;
  dateBasis: "japanese-print" | "japanese-electronic";
  sourceUrls: string[];
}
export const recordSchema = z.strictObject({
  url: text,
  retrievedAt: z.iso.datetime(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  edition: editionSchema,
});
export interface BookWalkerLock {
  schemaVersion: 1;
  selection: BookWalkerSelection;
  records: z.infer<typeof recordSchema>[];
  metadata: BookWalkerMetadata;
  digest: string;
}

export function bookWalkerAddress(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("BOOKWALKER_URL", "Expected a BookWalker product URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    fail(
      "BOOKWALKER_URL",
      "BookWalker requires HTTPS without credentials or a custom port",
    );
  const site = ["www.bookwalker.com.tw", "bookwalker.com.tw"].includes(
    url.hostname,
  )
    ? "tw"
    : ["bookwalker.jp", "www.bookwalker.jp"].includes(url.hostname)
      ? "jp"
      : undefined;
  const match =
    site === "tw"
      ? /^\/product\/([1-9]\d*)\/?$/.exec(url.pathname)
      : /^\/de([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i.exec(
          url.pathname,
        );
  if (!site || !match)
    fail(
      "BOOKWALKER_URL",
      "Select a Taiwan /product/ID or Japanese /deUUID/ product page",
    );
  url.hostname = site === "tw" ? "www.bookwalker.com.tw" : "bookwalker.jp";
  url.pathname =
    site === "tw" ? `/product/${match[1]}` : `/de${match[1].toLowerCase()}/`;
  url.search = "";
  url.hash = "";
  return { site, id: match[1], url: url.href } as const;
}

export function bookWalkerDate(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const match = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?$/.exec(
    value.trim(),
  );
  if (!match)
    fail("BOOKWALKER_DATE", `Unrecognized publication date: ${value}`);
  const iso = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== iso
  )
    fail("BOOKWALKER_DATE", `Invalid publication date: ${value}`);
  return iso;
}
