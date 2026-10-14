import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const retryDelays = [2000, 5000, 10000];

export async function downloadMangaPackage(
  entry: { name: string; url: string; sha256: string },
  options: {
    fetcher?: typeof fetch;
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined, failure: Error;
    try {
      response = await (options.fetcher ?? fetch)(entry.url, {
        signal: AbortSignal.timeout(60000),
      });
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
          throw new Error(`Package checksum mismatch: ${entry.name}`);
        return bytes;
      }
      failure = new Error(
        `Package download failed: ${entry.name} (${response.status})`,
      );
      if (![502, 503, 504].includes(response.status)) throw failure;
    } catch (error) {
      if (
        !(error instanceof TypeError) &&
        !(error instanceof DOMException && error.name === "TimeoutError")
      )
        throw error;
      failure = error;
    } finally {
      await response?.body?.cancel().catch(() => undefined);
    }
    if (attempt === retryDelays.length) throw failure;
    console.error(
      `${failure.message}; retry ${attempt + 1}/${retryDelays.length} after ${retryDelays[attempt]}ms`,
    );
    await (options.wait ?? setTimeout)(retryDelays[attempt]);
  }
}
