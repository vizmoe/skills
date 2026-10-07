import path from "node:path";
import { createServer, type Server } from "node:http";
import { fail } from "./errors.js";
import { exists } from "./files.js";
import { readJson } from "./json.js";
import { repoRoot } from "./runtime.js";
import type { EpubInspection } from "./epub.js";

export async function browserPath() {
  if (process.platform === "darwin" && process.env.CODEX_SANDBOX === "seatbelt")
    fail(
      "ENVIRONMENT_ERROR",
      "Chromium cannot register with macOS services in the current Codex Seatbelt sandbox. Use an explicitly authorized host run or the pinned QA container. No browser was launched.",
      { tool: "chromium", reason: "macos-sandbox" },
    );
  const file = path.join(repoRoot, ".cache/tools/browser.json");
  if (!(await exists(file)))
    fail("ENVIRONMENT_ERROR", "Chromium is missing; run pnpm tools:install");
  const { executablePath } = await readJson<{ executablePath: string }>(file);
  if (!(await exists(executablePath)))
    fail("ENVIRONMENT_ERROR", "Pinned Chromium executable is missing");
  return executablePath;
}
export async function serveEpub(
  info: EpubInspection,
): Promise<{ server: Server; origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      ).slice(1);
      const entry = info.entries.get(pathname);
      if (!entry) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      const type =
        info.manifest.find((item) => item.path === pathname)?.mediaType ??
        "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": type,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; img-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'none'",
        "Cache-Control": "no-store",
      });
      response.end(entry.bytes);
    } catch {
      response.writeHead(400);
      response.end("Invalid request");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    fail("QA_SERVER", "Could not bind QA server");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
