import type { BookWalkerMetadata } from "./bookwalker-model.js";
import { escapeXml as e } from "./xml.js";

export function bookWalkerOpf(
  metadata: BookWalkerMetadata,
  reserveId: (base: string) => string,
) {
  const parts = [`<dc:date>${e(metadata.releaseDate)}</dc:date>`];
  if (metadata.publisher)
    parts.push(`<dc:publisher>${e(metadata.publisher)}</dc:publisher>`);
  for (const url of metadata.sourceUrls)
    parts.push(`<dc:source>${e(url)}</dc:source>`);
  for (const contributor of metadata.contributors.filter(
    (item) => item.role !== "aut",
  )) {
    const id = reserveId("contributor");
    parts.push(
      `<dc:contributor id="${e(id)}">${e(contributor.name)}</dc:contributor><meta refines="#${e(id)}" property="role" scheme="marc:relators">${contributor.role}</meta>`,
    );
  }
  if (metadata.series) {
    const id = reserveId("series");
    parts.push(
      `<meta id="${e(id)}" property="belongs-to-collection">${e(metadata.series)}</meta><meta refines="#${e(id)}" property="collection-type">series</meta>`,
    );
    if (metadata.number !== null)
      parts.push(
        `<meta refines="#${e(id)}" property="group-position">${e(metadata.number)}</meta>`,
      );
  }
  return parts.join("");
}
