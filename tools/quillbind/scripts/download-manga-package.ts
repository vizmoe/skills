import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const retryDelays = [2000, 5000, 10000];
const retryableStatuses = new Set([500, 502, 503, 504]);

interface MangaPackageEntry {
  name: string;
  url: string;
  sha256: string;
}

const isRetryableError = (error: unknown): error is Error =>
  error instanceof TypeError ||
  (error instanceof DOMException && error.name === "TimeoutError");

async function tryDownloadOnce(
  entry: MangaPackageEntry,
  fetcher: typeof fetch,
): Promise<{ bytes: Buffer } | { retryError: Error }> {
  let response: Response | undefined;
  try {
    response = await fetcher(entry.url, {
      signal: AbortSignal.timeout(60000),
    });
    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
        throw new Error(`Package checksum mismatch: ${entry.name}`);
      return { bytes };
    }
    const failure = new Error(
      `Package download failed: ${entry.name} (${response.status})`,
    );
    if (!retryableStatuses.has(response.status)) throw failure;
    return { retryError: failure };
  } catch (error) {
    if (!isRetryableError(error)) throw error;
    return { retryError: error };
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}

async function downloadWithRetries(
  entry: MangaPackageEntry,
  fetcher: typeof fetch,
  wait: (milliseconds: number) => Promise<void>,
  attempt: number,
): Promise<Buffer> {
  const outcome = await tryDownloadOnce(entry, fetcher);
  if ("bytes" in outcome) return outcome.bytes;
  if (attempt === retryDelays.length) throw outcome.retryError;
  console.error(
    `${outcome.retryError.message}; retry ${attempt + 1}/${retryDelays.length} after ${retryDelays[attempt]}ms`,
  );
  await wait(retryDelays[attempt]);
  return downloadWithRetries(entry, fetcher, wait, attempt + 1);
}

export async function downloadMangaPackage(
  entry: MangaPackageEntry,
  options: {
    fetcher?: typeof fetch;
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  return downloadWithRetries(
    entry,
    options.fetcher ?? fetch,
    options.wait ?? setTimeout,
    0,
  );
}
