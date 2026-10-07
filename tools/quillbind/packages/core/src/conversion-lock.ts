import { z } from "zod";
import {
  ZhconvertSession,
  conversionTargets,
  type ConversionOptions,
} from "./zhconvert.js";
import { convertChineseContent } from "./chinese-conversion.js";
import { readJson, json } from "./json.js";
import { sha256 } from "./hash.js";
import { fail } from "./errors.js";

// Change recipeVersion when conversion parameters or text-slot selection change.
const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  recipeVersion: z.literal(1),
  target: z.enum(conversionTargets),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.string().min(1).nullable(),
  entries: z.array(
    z.strictObject({
      sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
      text: z.string(),
    }),
  ),
});

/** Offline by default; only an explicit refresh replaces the book-side lock. */
export async function convertWithLock(
  bytes: Uint8Array,
  options: ConversionOptions,
  defaultLockfile: string,
  epoch = 946684800,
) {
  const session = new ZhconvertSession(options);
  const lockfile = defaultLockfile;
  const inputSha256 = sha256(bytes);
  if (!options.online) {
    const raw = await readJson<unknown>(lockfile).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        fail(
          "CONVERSION_LOCK_MISSING",
          "No saved conversion. Run with --online to create the conversion lock",
          { lockfile },
        );
      if (error instanceof SyntaxError)
        fail(
          "CONVERSION_LOCK_INVALID",
          "Conversion lock is not valid JSON; refresh with --online",
          { lockfile },
        );
      throw error;
    });
    const parsed = snapshotSchema.safeParse(raw);
    if (!parsed.success)
      fail(
        "CONVERSION_LOCK_INVALID",
        "Invalid conversion lock; refresh with --online",
        { lockfile },
      );
    const snapshot = parsed.data;
    if (
      snapshot.target !== options.target ||
      snapshot.inputSha256 !== inputSha256
    )
      fail(
        "CONVERSION_LOCK_STALE",
        "The conversion lock does not match this source and target; refresh with --online",
        { lockfile },
      );
    if (
      new Set(snapshot.entries.map((entry) => entry.sourceSha256)).size !==
        snapshot.entries.length ||
      snapshot.entries.some(
        (entry) => sha256(entry.text) !== entry.outputSha256,
      ) ||
      (snapshot.entries.length > 0 && snapshot.revision === null)
    )
      fail(
        "CONVERSION_LOCK_INVALID",
        "Conversion lock hashes or dictionary revision are invalid",
        { lockfile },
      );
    session.restore(snapshot.entries, snapshot.revision);
  }
  const converted = await convertChineseContent(bytes, session, epoch);
  if (options.online)
    await json(lockfile, {
      schemaVersion: 1,
      recipeVersion: 1,
      target: options.target,
      inputSha256,
      revision: session.report().revision,
      entries: session.snapshot(),
    });
  session.freeze();
  return {
    ...converted,
    session,
    report: {
      ...session.report(),
      lockfile,
      inputSha256,
      source: options.online ? "online-refresh" : "saved-lock",
      changes: converted.changes,
    },
  };
}
