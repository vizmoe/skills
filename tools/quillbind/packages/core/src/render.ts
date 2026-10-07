import type { Publication } from "./model.js";
import { renderChapters } from "./render-chapters.js";
import { renderPackage } from "./render-package.js";

export async function renderPublication(
  publication: Publication,
): Promise<Map<string, Uint8Array>> {
  const { entries, documentEntries } = await renderChapters(publication);
  for (const [name, bytes] of renderPackage(publication, documentEntries))
    entries.set(name, bytes);
  return entries;
}
