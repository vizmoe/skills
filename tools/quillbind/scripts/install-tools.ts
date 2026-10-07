import fs from "node:fs/promises";
import path from "node:path";
import { unpack } from "../packages/core/src/zip.js";
import { readJson, json } from "../packages/core/src/json.js";
import { sha256 } from "../packages/core/src/hash.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { run } from "../packages/core/src/process.js";
import { fail } from "../packages/core/src/errors.js";
import { exists } from "../packages/core/src/files.js";
const lock = await readJson<{
  epubcheck: { version: string; url: string; sha256: string };
  java: {
    targets: Record<
      string,
      { url: string; sha256: string; executable: string }
    >;
  };
}>(path.join(repoRoot, "standards/tools.lock.json"));
const directory = path.join(repoRoot, ".cache/tools");
await fs.mkdir(directory, { recursive: true });
const java = lock.java.targets[`${process.platform}-${process.arch}`];
if (!java)
  fail(
    "TOOL_PLATFORM",
    "Use a supported macOS/Linux x64/arm64 host or the pinned QA container",
  );
const javaArchive = path.join(
  directory,
  path.basename(new URL(java.url).pathname),
);
if (!(await exists(javaArchive))) {
  const response = await fetch(java.url);
  if (!response.ok) fail("TOOL_DOWNLOAD", `Java download: ${response.status}`);
  await fs.writeFile(javaArchive, Buffer.from(await response.arrayBuffer()));
}
if (sha256(await fs.readFile(javaArchive)) !== java.sha256)
  fail("TOOL_INTEGRITY", "Java download hash mismatch");
const extract = await run("tar", ["-xzf", javaArchive, "-C", directory], {
  timeout: 120000,
});
if (extract.exitCode) fail("TOOL_INSTALL", extract.stderr);
const archive = path.join(directory, `epubcheck-${lock.epubcheck.version}.zip`);
if (!(await exists(archive))) {
  const response = await fetch(lock.epubcheck.url);
  if (!response.ok)
    fail("TOOL_DOWNLOAD", `EPUBCheck download: ${response.status}`);
  await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
}
const bytes = await fs.readFile(archive);
if (sha256(bytes) !== lock.epubcheck.sha256)
  fail("TOOL_INTEGRITY", "EPUBCheck download hash mismatch");
for (const [name, entry] of unpack(bytes)) {
  const target = path.join(directory, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, entry.bytes);
}
const browsers =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  path.join(repoRoot, ".cache/ms-playwright");
const browserInstall = await run(
  process.execPath,
  [
    path.join(repoRoot, "node_modules/@playwright/test/cli.js"),
    "install",
    "chromium",
  ],
  { timeout: 600000, env: { PLAYWRIGHT_BROWSERS_PATH: browsers } },
);
process.stdout.write(browserInstall.stdout);
process.stderr.write(browserInstall.stderr);
if (browserInstall.exitCode !== 0)
  fail("BROWSER_INSTALL", "Playwright browser installation failed");
await json(path.join(directory, "installed.json"), {
  epubcheck: lock.epubcheck,
  playwrightBrowsersPath: browsers,
});
const browserInfo = await run(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    'import {chromium} from "@playwright/test"; console.log(JSON.stringify({executablePath:chromium.executablePath()}));',
  ],
  { env: { PLAYWRIGHT_BROWSERS_PATH: browsers } },
);
if (browserInfo.exitCode !== 0) fail("BROWSER_INSTALL", browserInfo.stderr);
await json(
  path.join(directory, "browser.json"),
  JSON.parse(browserInfo.stdout),
);
console.log("EPUBCheck hash verified; pinned Playwright Chromium installed.");
