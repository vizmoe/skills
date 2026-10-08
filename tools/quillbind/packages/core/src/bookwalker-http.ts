import { checkAbort, fail } from "./errors.js";
import { bookWalkerAddress } from "./bookwalker-model.js";
import { fetchNovel, type NovelFetcher } from "./novel-http.js";

export interface BookWalkerOptions {
  online?: boolean;
  signal?: AbortSignal;
  fetcher?: NovelFetcher;
}
export async function fetchBookWalker(url: string, options: BookWalkerOptions) {
  if (!options.online)
    fail(
      "BOOKWALKER_OFFLINE",
      "Use a saved BookWalker lock or explicitly request --online",
    );
  if (process.env.CI && !options.fetcher)
    fail("CI_NETWORK_DISABLED", "Live BookWalker requests are disabled in CI");
  const original = bookWalkerAddress(url);
  let current = original.url;
  const maxBytes = 4 * 1024 * 1024;
  for (let redirects = 0; redirects <= 3; redirects++) {
    checkAbort(options.signal);
    const response = await (options.fetcher ?? fetchNovel)({
      url: current,
      method: "GET",
      signal: options.signal,
      timeout: 20000,
      maxBytes,
      headers: {
        "user-agent": "Quillbind/0.1 (public book metadata)",
        accept: "text/html",
        "accept-encoding": "gzip, deflate, br",
      },
    });
    checkAbort(options.signal);
    if (response.bytes.length > maxBytes)
      fail("BOOKWALKER_LIMIT", "BookWalker response exceeds 4 MiB");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location)
        fail("BOOKWALKER_REDIRECT", "Missing redirect location");
      const next = bookWalkerAddress(
        new URL(response.headers.location, current).href,
      );
      if (next.url !== original.url)
        fail(
          "BOOKWALKER_REDIRECT",
          "Redirect points to a different product or provider",
        );
      current = new URL(response.headers.location, current).href;
      continue;
    }
    if (response.status !== 200)
      fail(
        "BOOKWALKER_HTTP",
        `BookWalker returned ${response.status}; check product access`,
      );
    return response.bytes;
  }
  fail("BOOKWALKER_REDIRECT", "Too many BookWalker redirects");
}
