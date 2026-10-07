import fs from "node:fs/promises";
import path from "node:path";
import { openBook, type BookProject } from "./config.js";
import { resolveMetadataWithLock } from "./metadata.js";
import { preflightBook } from "./preflight.js";
import { publicationFromBook } from "./publication.js";
import { renderPublication } from "./render.js";
import { pack, compressionPolicy } from "./zip.js";
import { convertWithLock } from "./conversion-lock.js";
import type { ConversionOptions } from "./zhconvert.js";
import { atomicWrite, bookOutput } from "./files.js";
import { checkAbort, fail } from "./errors.js";
import { sha256 } from "./hash.js";
import { inspectBytes } from "./epub.js";
import { planQa, inspectedQaDocuments, type QaOptions } from "./qa-plan.js";

/** One render for author feedback. This path cannot write a released book or release report. */
export async function previewBook(
  input: string | BookProject,
  options: {
    signal?: AbortSignal;
    online?: boolean;
    conversion?: Omit<ConversionOptions, "signal">;
    qa?: QaOptions;
  } = {},
) {
  const project = typeof input === "string" ? await openBook(input) : input;
  checkAbort(options.signal);
  const dist = await bookOutput(project.root, "dist");
  const lockfile = path.join(dist, ".build.lock");
  const lock = await fs
    .open(lockfile, "wx")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        fail("BUILD_BUSY", "A build or preview owns dist/.build.lock");
      throw error;
    });
  try {
    const metadata = await resolveMetadataWithLock(project, {
      signal: options.signal,
    });
    if (metadata.resolution.status === "fail" || !metadata.lock)
      fail(
        "METADATA_UNRESOLVED",
        "Required metadata needs resolution",
        metadata.resolution.diagnostics,
      );
    const preflight = await preflightBook(project, options);
    if (preflight.status === "fail")
      fail("PREFLIGHT_FAILED", "Preflight failed", preflight.diagnostics);
    const publication = await publicationFromBook(project, {
      lock: metadata.lock,
      documents: preflight.documents,
    });
    let bytes = pack(
      await renderPublication(publication),
      project.config.build.epoch,
    );
    const conversion = options.conversion ?? project.config.conversion;
    let conversionReport;
    if (conversion) {
      const converted = await convertWithLock(
        bytes,
        {
          ...conversion,
          online: options.online ?? options.conversion?.online,
          signal: options.signal,
        },
        path.join(
          await bookOutput(project.root, "metadata"),
          `conversion.${conversion.target}.lock.json`,
        ),
        project.config.build.epoch,
      );
      bytes = converted.bytes;
      conversionReport = converted.report;
    }
    checkAbort(options.signal);
    const destination = path.join(
      await bookOutput(project.root, "dist/preview"),
      "candidate.epub",
    );
    await atomicWrite(destination, bytes);
    return {
      status: "preview" as const,
      publicationReady: false,
      releaseGates: "not-run" as const,
      candidate: {
        path: destination,
        sha256: sha256(bytes),
        size: bytes.length,
        mediaType: "application/epub+zip",
      },
      diagnostics: preflight.diagnostics,
      qaProjection: {
        ...planQa(inspectedQaDocuments(inspectBytes(bytes)), {
          ...project.config.qa,
          ...options.qa,
        }),
        basis: "packaged-preview",
        complete: true,
      },
      compression: compressionPolicy,
      ...(conversionReport ? { conversion: conversionReport } : {}),
    };
  } finally {
    await lock.close();
    await fs.unlink(lockfile);
  }
}
