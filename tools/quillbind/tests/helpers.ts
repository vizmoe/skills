import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "../packages/core/src/runtime.js";
import { openBook } from "../packages/core/src/config.js";
import { resolveMetadata } from "../packages/core/src/metadata.js";
import { publicationFromBook } from "../packages/core/src/publication.js";
import { renderPublication } from "../packages/core/src/render.js";
import { pack } from "../packages/core/src/zip.js";
import type { EpubInspection } from "../packages/core/src/validate.js";
import { attr, elements, xml } from "../packages/core/src/xml.js";

// Generated front matter can precede chapters in the spine.
export function bodymatterItems(info: EpubInspection) {
  return info.spine
    .map((id) => info.manifest.find((item) => item.id === id)!)
    .filter((item) => {
      const document =
        info.documents.get(item.path) ??
        xml(info.entries.get(item.path)!.bytes.toString());
      return elements(document, "main").some((node) =>
        attr(node, "epub:type").split(" ").includes("bodymatter"),
      );
    });
}
export async function copyBook(theme = "literature") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-test-"));
  await fs.cp(path.join(repoRoot, "examples", theme), root, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}dist`),
  });
  return fs.realpath(root);
}
export async function candidate(root: string) {
  const book = await openBook(root);
  const resolved = await resolveMetadata(book);
  if (resolved.status === "fail") throw new Error(JSON.stringify(resolved));
  return pack(
    await renderPublication(await publicationFromBook(book)),
    book.config.build.epoch,
  );
}
