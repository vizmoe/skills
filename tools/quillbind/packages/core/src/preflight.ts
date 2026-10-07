import { openBook, type BookProject } from "./config.js";
import { parseChapter } from "./markdown.js";
import { createMathCompiler } from "./math.js";
import { inspectImage } from "./images.js";
import { safeRead } from "./files.js";
import { fail, diagnostic, result } from "./errors.js";
import { APPLE } from "./standards.js";
import type { Document, Diagnostic } from "./model.js";
import { planQa, sourceQaDocuments, type QaOptions } from "./qa-plan.js";

export async function preflightBook(
  input: string | BookProject,
  options: { qa?: QaOptions } = {},
) {
  const project = typeof input === "string" ? await openBook(input) : input;
  const diagnostics: Diagnostic[] = [];
  const documents: Document[] = [];
  const compileMath = createMathCompiler();
  for (const [i, chapter] of project.config.chapters.entries())
    try {
      if (!chapter.endsWith(".md"))
        fail("UNSUPPORTED_FORMAT", "Chapters must be Markdown files");
      documents.push(await parseChapter(project, chapter, i, compileMath));
    } catch (error) {
      const e = error as Error & { code?: string };
      diagnostics.push(
        diagnostic(e.code ?? "PREFLIGHT_ERROR", e.message, chapter),
      );
    }
  if (new Set(documents.map((d) => d.id)).size !== documents.length)
    diagnostics.push(
      diagnostic("DUPLICATE_CHAPTER_ID", "Chapter IDs must be unique"),
    );
  const cover = project.config.cover?.path;
  if (cover !== undefined)
    try {
      const image = await inspectImage(
        await safeRead(project.root, cover),
        cover,
      );
      // SVG dimensions describe a viewport, not a fixed raster resolution.
      if (image.width && image.height) {
        const shortEdge = Math.min(image.width, image.height);
        if (shortEdge < 1400)
          diagnostics.push({
            ...diagnostic(
              "COVER_RESOLUTION_LOW",
              `Cover image is ${image.width} × ${image.height} pixels; its short edge of ${shortEdge} pixels is below Apple's 1400-pixel marketing-cover recommendation. The original image is retained and the build can continue.`,
              cover,
              APPLE,
              "warning",
            ),
            suggestion:
              "Use a higher-resolution original when available; do not upscale just to meet this recommendation.",
          });
      }
    } catch (error) {
      const e = error as Error & { code?: string };
      diagnostics.push(
        diagnostic(e.code ?? "PREFLIGHT_ERROR", e.message, cover),
      );
    }
  return {
    ...result(diagnostics),
    documents,
    qaProjection: {
      ...planQa(sourceQaDocuments(documents, !!project.config.cover), {
        ...project.config.qa,
        ...options.qa,
      }),
      basis: "source-preflight",
      complete: documents.length === project.config.chapters.length,
    },
  };
}
