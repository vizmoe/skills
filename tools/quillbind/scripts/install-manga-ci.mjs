import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// Container-only tools: the pinned base supplies the remaining shared libraries.
const lock = JSON.parse(
  await fs.readFile(
    new URL("../standards/manga-tools.lock.json", import.meta.url),
    "utf8",
  ),
);
if (
  `${process.platform}-${process.arch}` !== lock.platform ||
  process.getuid?.() !== 0
)
  throw new Error(
    "Run this installer only in the Linux arm64 QA container as root",
  );
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-codecs-"));
try {
  const files = [];
  for (const entry of lock.packages) {
    const response = await fetch(entry.url, {
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new Error(
        `Package download failed: ${entry.name} (${response.status})`,
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error(`Package checksum mismatch: ${entry.name}`);
    const file = path.join(temporary, `${entry.name}.deb`);
    await fs.writeFile(file, bytes, { flag: "wx" });
    files.push(file);
  }
  execFileSync("dpkg", ["-i", ...files], { stdio: "inherit", timeout: 120000 });
  for (const entry of lock.packages) {
    const installed = execFileSync(
      "dpkg-query",
      ["-W", "-f=${Version}", entry.name],
      { encoding: "utf8" },
    ).trim();
    if (installed !== entry.version)
      throw new Error(`Installed package version differs: ${entry.name}`);
  }
  execFileSync("cjxl", ["--version"], { stdio: "inherit" });
  execFileSync("djxl", ["--version"], { stdio: "inherit" });
  execFileSync("xmllint", ["--version"], { stdio: "inherit" });
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
