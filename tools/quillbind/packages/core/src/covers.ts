import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  openMetadata,
  metadataFormat,
  deliverMetadata,
  children,
  type MetadataFormat,
} from "./metadata-file.js";
import { patchZip } from "./zip-patch.js";
import { coverImage } from "./cover-image.js";
import { coverClaims, epubCover } from "./cover-epub.js";
import { coverQa } from "./cover-qa.js";
import { encodePage, jxlTools } from "./manga-jxl.js";
import { boundedRead, mangaLimits } from "./manga-sources.js";
import { attr, elements, serialize } from "./xml.js";
import { readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stable } from "./json.js";
import { fail } from "./errors.js";

const review = z.string().trim().min(1);
const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("cover"),
    format: z.enum(["epub", "cbz"]),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    metadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
    modified: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .refine(
        (value) =>
          !Number.isNaN(Date.parse(value)) &&
          new Date(value).toISOString().replace(".000Z", "Z") === value,
      ),
    inventory: z.unknown(),
    image: z.unknown(),
    target: z
      .object({ image: z.string().nullable(), document: z.string().nullable() })
      .strict(),
    pageOrder: z.array(z.string()),
    evidence: z
      .object({
        source: review,
        edition: review,
        visual: review,
        reason: review,
        pageOrder: review.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CoverPlan = z.infer<typeof planSchema>;
export async function auditCover(
  bytes: Buffer,
  format: MetadataFormat,
  options: { image?: Buffer; modified?: string } = {},
): Promise<CoverPlan> {
  const file = openMetadata(bytes, format),
    claims =
      format === "epub" ? coverClaims(bytes) : { images: [], documents: [] };
  return {
    schemaVersion: 1,
    operation: "cover",
    format,
    sourceSha256: sha256(bytes),
    metadataSha256: sha256(file.entries.get(file.location)!.bytes),
    modified:
      options.modified ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    inventory: {
      claims,
      members: [...file.entries].map(([name, entry]) => ({
        name,
        sha256: sha256(entry.bytes),
        bytes: entry.bytes.length,
      })),
    },
    image: options.image ? await coverImage(options.image) : null,
    target: {
      image:
        claims.images.length === 1 &&
        !claims.images[0].startsWith("missing-id:")
          ? claims.images[0]
          : null,
      document: claims.documents.length === 1 ? claims.documents[0] : null,
    },
    pageOrder: [],
    evidence: null,
  };
}
export async function applyCover(
  bytes: Buffer,
  image: Buffer,
  value: unknown,
  signal?: AbortSignal,
) {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success)
    fail("COVER_PLAN", "Invalid cover plan", parsed.error.issues);
  const plan = parsed.data;
  if (sha256(bytes) !== plan.sourceSha256)
    fail("COVER_STALE", "Source hash differs from the cover plan");
  if (!plan.evidence)
    fail(
      "COVER_REVIEW",
      "Cover source, edition and visual review evidence are required",
    );
  const actual = await auditCover(bytes, plan.format, {
      image,
      modified: plan.modified,
    }),
    details = await coverImage(image);
  if (stable(actual.image) !== stable(plan.image))
    fail(
      "COVER_STALE",
      "Candidate image hash or dimensions differ from the plan",
    );
  if (
    actual.metadataSha256 !== plan.metadataSha256 ||
    stable(actual.inventory) !== stable(plan.inventory)
  )
    fail("COVER_STALE", "Cover inventory must not be edited");
  const file = openMetadata(bytes, plan.format);
  let edits: {
    replacements: Map<string, Buffer>;
    additions: Map<string, Buffer>;
    imagePath: string;
    documentPath: string | null;
  };
  let conversion: Awaited<ReturnType<typeof encodePage>>["evidence"] | null =
    null;
  if (plan.format === "epub") {
    if (plan.pageOrder.length) fail("COVER_PLAN", "pageOrder is only for CBZ");
    edits = epubCover(bytes, image, details, plan.target, plan.modified);
  } else {
    const pages = [...file.entries.keys()].filter((name) =>
      /\.(?:jpe?g|png|gif|webp|tiff?|avif|jxl)$/i.test(name),
    );
    if (
      plan.target.document !== null ||
      !plan.target.image ||
      !pages.includes(plan.target.image) ||
      !plan.evidence.pageOrder
    )
      fail(
        "COVER_PAGE",
        "Select an explicit CBZ cover page and record reviewed display order",
      );
    if (
      new Set(plan.pageOrder).size !== pages.length ||
      plan.pageOrder.length !== pages.length ||
      pages.some((name) => !plan.pageOrder.includes(name))
    )
      fail(
        "COVER_ORDER",
        "Reviewed page order must contain every image exactly once",
      );
    const selected = plan.pageOrder.indexOf(plan.target.image),
      extension = path.extname(plan.target.image).toLowerCase();
    let payload = image;
    if (extension === ".jxl") {
      const temporary = await fs.mkdtemp(
        path.join(os.tmpdir(), "quillbind-cover-"),
      );
      try {
        const encoded = await encodePage(
          { name: `cover${details.extension}`, bytes: image },
          temporary,
          await jxlTools(signal),
          signal,
        );
        payload = encoded.bytes;
        conversion = encoded.evidence;
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });
      }
    } else if (!(
      (details.mediaType === "image/jpeg" &&
        [".jpg", ".jpeg"].includes(extension)) ||
      (details.mediaType === "image/png" && extension === ".png")
    ))
      fail(
        "COVER_FORMAT",
        "Selected page format differs from the original cover; supply matching JPEG/PNG or select an existing JXL page",
      );
    const pageCount = elements(file.document, "PageCount")[0]?.textContent;
    if (pageCount && Number(pageCount) !== pages.length)
      fail(
        "COVER_ORDER",
        "ComicInfo PageCount conflicts with the image inventory",
      );
    let mapping = elements(file.document, "Pages")[0];
    if (!mapping) {
      mapping = file.document.createElement("Pages");
      const after = children(file.metadata).find((node) =>
        ["CommunityRating", "MainCharacterOrTeam", "Review"].includes(
          node.localName ?? "",
        ),
      );
      file.metadata.insertBefore(mapping, after ?? null);
    }
    const seen = new Set<number>();
    for (const node of elements(mapping, "Page")) {
      const raw = attr(node, "Image"),
        index = Number(raw);
      if (!/^\d+$/.test(raw) || index >= pages.length || seen.has(index))
        fail("COVER_ORDER", "ComicInfo page mapping is invalid or duplicated");
      seen.add(index);
      const types = attr(node, "Type")
        .split(/\s+/)
        .filter((type) => type && type !== "FrontCover");
      if (types.length) node.setAttribute("Type", types.join(" "));
      else node.removeAttribute("Type");
    }
    let node = elements(mapping, "Page").find(
      (node) => Number(attr(node, "Image")) === selected,
    );
    if (!node) {
      node = file.document.createElement("Page");
      node.setAttribute("Image", String(selected));
      mapping.appendChild(node);
    }
    node.setAttribute(
      "Type",
      [...attr(node, "Type").split(/\s+/).filter(Boolean), "FrontCover"].join(
        " ",
      ),
    );
    node.setAttribute("ImageWidth", String(details.width));
    node.setAttribute("ImageHeight", String(details.height));
    node.setAttribute("ImageSize", String(payload.length));
    edits = {
      imagePath: plan.target.image,
      documentPath: null,
      replacements: new Map([
        [plan.target.image, payload],
        [file.location, Buffer.from(serialize(file.document))],
      ]),
      additions: new Map(),
    };
  }
  const output = patchZip(bytes, edits.replacements, edits.additions),
    readback = openMetadata(output, plan.format);
  const changedMembers = [
    ...edits.replacements.keys(),
    ...edits.additions.keys(),
  ];
  for (const [name, content] of [...edits.replacements, ...edits.additions])
    if (!readback.entries.get(name)?.bytes.equals(content))
      fail("COVER_READBACK", `Cover readback failed: ${name}`);
  if (plan.format === "epub") {
    const claims = coverClaims(output);
    if (
      stable(claims.images) !== stable([edits.imagePath]) ||
      stable(claims.documents) !== stable([edits.documentPath])
    )
      fail(
        "COVER_READBACK",
        "Cover declarations do not select the adopted image and page",
      );
  }
  const preserved = [...file.entries]
    .filter(([name]) => !changedMembers.includes(name))
    .map(([name, entry]) => ({ name, sha256: sha256(entry.bytes) }));
  return {
    bytes: output,
    report: {
      format: plan.format,
      sourceSha256: plan.sourceSha256,
      image: details,
      imagePath: edits.imagePath,
      documentPath: edits.documentPath,
      changedMembers,
      preserved,
      evidence: plan.evidence,
      pageOrder: plan.pageOrder,
      conversion,
    },
  };
}
export async function auditFileCover(
  file: string,
  options: { image?: string; output?: string } = {},
) {
  const plan = await auditCover(
    await readSourceFile(file),
    metadataFormat(file),
    {
      image: options.image
        ? await boundedRead(options.image, mangaLimits.pageBytes)
        : undefined,
    },
  );
  if (options.output)
    await fs.writeFile(options.output, stable(plan), { flag: "wx" });
  return plan;
}
export async function adoptCover(
  file: string,
  options: {
    image: string;
    plan: unknown;
    output: string;
    signal?: AbortSignal;
  },
) {
  const bytes = await readSourceFile(file),
    image = await boundedRead(options.image, mangaLimits.pageBytes),
    result = await applyCover(bytes, image, options.plan, options.signal),
    format = metadataFormat(file);
  if (format !== result.report.format)
    fail("COVER_FORMAT", "Source extension and cover plan format differ");
  const delivered = await deliverMetadata(file, {
    ...options,
    ...result,
    format,
    sourceSha256: sha256(bytes),
    verify: async (candidate, reports) =>
      coverQa(
        candidate,
        result.report,
        path.join(reports, "cover"),
        options.signal,
      ),
  });
  return { ...delivered, verification: delivered.verification! };
}
