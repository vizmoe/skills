import type { BookWalkerMetadata } from "./bookwalker.js";
import { escapeXml as e, xml } from "./xml.js";
import { fail } from "./errors.js";
export interface ComicPage {
  width: number;
  height: number;
  size: number;
}
export function comicInfo(
  metadata: BookWalkerMetadata,
  pages: ComicPage[],
  direction?: "rtl" | "ltr",
) {
  if (metadata.kind !== "manga" || !pages.length)
    fail("COMICINFO_INPUT", "ComicInfo requires a manga volume with pages");
  const field = (name: string, value: string | number | null | undefined) =>
    value === undefined || value === null || value === ""
      ? ""
      : `<${name}>${e(String(value))}</${name}>`;
  const names = (roles: string[]) =>
    [
      ...new Set(
        metadata.contributors
          .filter((person) => roles.includes(person.role))
          .map((person) => person.name),
      ),
    ].join(", ");
  const [year, month, day] = metadata.releaseDate.split("-").map(Number);
  const notes = [
    `Original date: ${metadata.releaseDate} (${metadata.dateBasis}).`,
    `Original title: ${metadata.originalTitle}.`,
    ...metadata.contributors.map((person) => `${person.role}: ${person.name}.`),
    `Sources: ${metadata.sourceUrls.join(" ")}`,
  ].join("\n");
  const content = `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>${field("Title", metadata.title)}${field("Series", metadata.series)}${field("Number", metadata.number)}${field("Summary", metadata.description)}${field("Notes", notes)}${field("Year", year)}${field("Month", month)}${field("Day", day)}${field("Writer", names(["aut", "ant", "adp"]))}${field("Penciller", names(["art"]))}${field("Publisher", metadata.publisher)}${field("Imprint", metadata.imprint)}${field("Web", metadata.url)}${field("PageCount", pages.length)}${field("LanguageISO", metadata.language.split("-")[0])}${field("Manga", direction === "rtl" ? "YesAndRightToLeft" : "Yes")}<Pages>${pages.map((page, index) => `<Page Image="${index}" ImageSize="${page.size}" ImageWidth="${page.width}" ImageHeight="${page.height}"/>`).join("")}</Pages></ComicInfo>\n`;
  xml(content, "ComicInfo.xml");
  return content;
}
