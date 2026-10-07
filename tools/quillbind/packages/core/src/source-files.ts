import type { Block, Document, Inline } from "./model.js";

export function imageSources(documents: Document[]) {
  const sources = new Set<string>();
  const inline = (value: Inline) => {
    if (value.kind === "image" && value.target) sources.add(value.target);
    if ("children" in value) value.children.forEach(inline);
  };
  const block = (value: Block) => {
    if (value.kind === "figure" && value.target) sources.add(value.target);
    if ("inlines" in value) value.inlines.forEach(inline);
    if (value.kind === "table") value.rows.flat(2).forEach(inline);
    if ("children" in value) value.children.forEach(block);
  };
  for (const document of documents) {
    document.blocks.forEach(block);
    document.footnotes.forEach((note) => note.blocks.forEach(block));
  }
  return sources;
}
