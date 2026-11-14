import fs from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readBookWalkerLock } from "./bookwalker.js";
import { readCatalogLock } from "./catalog.js";
import { coverImage, type CoverImage } from "./cover-image.js";
import { readEditionLock } from "./edition.js";
import { checkAbort, fail } from "./errors.js";
import { readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { isPublicAddress } from "./http-address.js";
import { stable } from "./json.js";
import { fetchNovel, type NovelFetcher } from "./novel-http.js";

const text = z.string().trim().min(1).max(10000);

export const coverFetchSelectionSchema = z
  .strictObject({
    url: text.optional(),
    lock: text.optional(),
    matchEvidence: z.array(text).min(1).max(20),
  })
  .refine(
    (item) => Boolean(item.url) !== Boolean(item.lock),
    "Supply exactly one of url or lock",
  );
export type CoverFetchSelection = z.infer<typeof coverFetchSelectionSchema>;

export interface CoverFetchOptions {
  online?: boolean;
  signal?: AbortSignal;
  fetcher?: NovelFetcher;
  now?: () => Date;
}

export interface CoverLock {
  schemaVersion: 1;
  selection: {
    url: string;
    lockDigest?: string;
    lockKind?: "bookwalker" | "edition" | "catalog";
    matchEvidence: string[];
  };
  record: {
    url: string;
    finalUrl: string;
    retrievedAt: string;
    image: CoverImage;
  };
  digest: string;
}

const maxCoverBytes = 20 * 1024 * 1024;

export function coverAddress(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("COVER_URL", "Expected an HTTPS cover image URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hostname.endsWith(".")
  )
    fail(
      "COVER_URL",
      "Cover image URLs require HTTPS without credentials or custom port",
    );
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (isIP(host) !== 0 && !isPublicAddress(host))
  )
    fail("COVER_URL", `Disallowed cover image host: ${parsed.hostname}`);
  parsed.hash = "";
  return parsed;
}

async function resolveSelectionSource(
  rawSelection: CoverFetchSelection,
  baseDir: string,
): Promise<CoverLock["selection"]> {
  if (rawSelection.url) {
    return {
      url: coverAddress(rawSelection.url).href,
      matchEvidence: rawSelection.matchEvidence,
    };
  }
  const lockPath = path.resolve(baseDir, rawSelection.lock!);
  const rawLock = (await readSourceFile(lockPath)).toString("utf8");
  let parsedJson: Record<string, unknown>;
  try {
    parsedJson = JSON.parse(rawLock) as Record<string, unknown>;
  } catch {
    fail("COVER_SOURCE_LOCK", "Invalid JSON in cover source lock");
  }
  if (Array.isArray(parsedJson.records) && parsedJson.selection) {
    const bw = readBookWalkerLock(rawLock);
    const url =
      bw.metadata.coverUrl ??
      bw.records.at(-1)?.edition.coverUrl ??
      bw.records[0]?.edition.coverUrl;
    if (!url)
      fail(
        "COVER_SOURCE_MISSING",
        "Selected BookWalker lock does not contain a coverUrl",
      );
    return {
      url: coverAddress(url).href,
      lockDigest: bw.digest,
      lockKind: "bookwalker",
      matchEvidence: rawSelection.matchEvidence,
    };
  }
  if (parsedJson.record && parsedJson.selection) {
    const ed = readEditionLock(rawLock);
    if (!ed.metadata.coverUrl)
      fail(
        "COVER_SOURCE_MISSING",
        "Selected edition lock does not contain a coverUrl",
      );
    return {
      url: coverAddress(ed.metadata.coverUrl).href,
      lockDigest: ed.digest,
      lockKind: "edition",
      matchEvidence: rawSelection.matchEvidence,
    };
  }
  if (parsedJson.query && parsedJson.providers) {
    const cat = readCatalogLock(rawLock);
    if (!cat.metadata?.coverUrl)
      fail(
        "COVER_SOURCE_MISSING",
        "Selected catalog lock does not contain a coverUrl",
      );
    return {
      url: coverAddress(cat.metadata.coverUrl).href,
      lockDigest: cat.digest,
      lockKind: "catalog",
      matchEvidence: rawSelection.matchEvidence,
    };
  }
  fail(
    "COVER_SOURCE_LOCK",
    "Expected a valid BookWalker, edition, or catalog lock file",
  );
}

async function fetchCoverBytes(url: string, options: CoverFetchOptions) {
  if (process.env.CI && !options.fetcher)
    fail("CI_NETWORK_DISABLED", "Live cover image requests are disabled in CI");
  let current = coverAddress(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    checkAbort(options.signal);
    const response = await (options.fetcher ?? fetchNovel)({
      url: current.href,
      method: "GET",
      signal: options.signal,
      timeout: 20000,
      maxBytes: maxCoverBytes,
      headers: {
        "user-agent": "Quillbind/0.1 (public book metadata)",
        accept: "image/jpeg,image/png,image/*;q=0.8",
      },
    });
    checkAbort(options.signal);
    if (response.bytes.length > maxCoverBytes)
      fail("COVER_LIMIT", "Cover image exceeds 20 MiB");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location)
        fail("COVER_REDIRECT", "Missing cover redirect location");
      current = coverAddress(new URL(response.headers.location, current).href);
      continue;
    }
    if (response.status !== 200)
      fail(
        "COVER_HTTP",
        `Cover image request returned HTTP ${response.status}`,
      );
    return { bytes: response.bytes, finalUrl: current.href };
  }
  fail("COVER_REDIRECT", "Too many cover image redirects");
}

function checkExtension(outputPath: string, image: CoverImage) {
  const ext = path.extname(outputPath).toLowerCase();
  const valid =
    image.mediaType === "image/jpeg"
      ? [".jpg", ".jpeg"].includes(ext)
      : ext === ".png";
  if (!valid)
    fail(
      "COVER_EXTENSION",
      `Output extension ${ext || "(none)"} does not match ${image.mediaType}; expected ${image.extension}`,
    );
}

export function readCoverLock(source: string): CoverLock {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail("COVER_LOCK", "Invalid cover JSON lock");
  }
  const imageSchema = z.strictObject({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.enum(["image/jpeg", "image/png"]),
    extension: z.enum([".jpg", ".png"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    storedWidth: z.number().int().positive(),
    storedHeight: z.number().int().positive(),
    orientation: z.number().int().min(1).max(8),
    bytes: z.number().int().positive(),
  });
  const parsed = z
    .strictObject({
      schemaVersion: z.literal(1),
      selection: z.strictObject({
        url: text,
        lockDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        lockKind: z.enum(["bookwalker", "edition", "catalog"]).optional(),
        matchEvidence: z.array(text).min(1).max(20),
      }),
      record: z.strictObject({
        url: text,
        finalUrl: text,
        retrievedAt: z.iso.datetime(),
        image: imageSchema,
      }),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .safeParse(value);
  if (!parsed.success)
    fail("COVER_LOCK", "Invalid cover lock structure", parsed.error.issues);
  const { digest, ...content } = parsed.data;
  coverAddress(content.selection.url);
  coverAddress(content.record.url);
  coverAddress(content.record.finalUrl);
  if (digest !== sha256(stable(content)))
    fail("COVER_LOCK", "Cover lock digest mismatch");
  return { ...content, digest };
}

async function writeImmutable(target: string, bytes: Buffer | string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    await fs.link(temporary, target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        fail(
          "OUTPUT_EXISTS",
          `Destination already exists: ${target}; select a new output path`,
        );
      throw error;
    });
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function resolveCoverFetch(
  file: string,
  options: CoverFetchOptions & { output: string; lock?: string },
) {
  let raw: unknown;
  try {
    raw = JSON.parse((await readSourceFile(file)).toString("utf8"));
  } catch {
    fail("COVER_SELECTION", "Invalid cover selection JSON");
  }
  const parsedSelection = coverFetchSelectionSchema.safeParse(raw);
  if (!parsedSelection.success)
    fail(
      "COVER_SELECTION",
      "Supply url or lock and matchEvidence",
      parsedSelection.error.issues,
    );
  const selection = await resolveSelectionSource(
    parsedSelection.data,
    path.dirname(path.resolve(file)),
  );
  const output = path.resolve(options.output);
  const lockPath = path.resolve(options.lock ?? `${output}.lock.json`);

  if (!options.online) {
    const lock = readCoverLock(
      (await readSourceFile(lockPath)).toString("utf8"),
    );
    if (stable(lock.selection) !== stable(selection))
      fail(
        "COVER_LOCK_STALE",
        "Cover selection changed; fetch a new cover online",
      );
    const existingBytes = await readSourceFile(output);
    const inspected = await coverImage(existingBytes);
    checkExtension(output, inspected);
    if (stable(inspected) !== stable(lock.record.image))
      fail(
        "COVER_MISMATCH",
        "Saved cover image bytes or dimensions differ from the cover lock",
      );
    return {
      status: "pass" as const,
      operation: "cover-fetch",
      output,
      lock: lockPath,
      image: lock.record.image,
      sourceUrl: lock.record.finalUrl,
      digest: lock.digest,
      mode: "offline" as const,
    };
  }

  const exists = async (target: string) =>
    fs.lstat(target).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    );
  if ((await exists(output)) || (await exists(lockPath)))
    fail(
      "OUTPUT_EXISTS",
      "Cover outputs and locks are immutable; select new output/lock paths",
    );

  const fetched = await fetchCoverBytes(selection.url, options);
  const image = await coverImage(fetched.bytes);
  checkExtension(output, image);
  const content = {
    schemaVersion: 1 as const,
    selection,
    record: {
      url: selection.url,
      finalUrl: fetched.finalUrl,
      retrievedAt: (options.now?.() ?? new Date()).toISOString(),
      image,
    },
  };
  const lock: CoverLock = { ...content, digest: sha256(stable(content)) };
  checkAbort(options.signal);
  await writeImmutable(output, fetched.bytes);
  await writeImmutable(lockPath, stable(lock) + "\n");
  return {
    status: "pass" as const,
    operation: "cover-fetch",
    output,
    lock: lockPath,
    image,
    sourceUrl: fetched.finalUrl,
    digest: lock.digest,
    mode: "online" as const,
  };
}
