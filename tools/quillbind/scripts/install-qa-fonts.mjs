import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const directory = process.argv[2];
if (process.platform !== "linux" || !directory)
  throw new Error("Run inside the Linux QA container with a font directory");
const lock = JSON.parse(
  await fs.readFile(
    new URL("../standards/qa-fonts.lock.json", import.meta.url),
    "utf8",
  ),
);
await fs.mkdir(directory, { recursive: true });
await Promise.all(
  [...lock.fonts, ...lock.licenses].map(async (asset) => {
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok)
      throw new Error(
        `Font download failed: ${asset.file}: ${response.status}`,
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error(`Font checksum mismatch: ${asset.file}`);
    await fs.writeFile(path.join(directory, asset.file), bytes);
  }),
);
execFileSync("fc-cache", ["-f", directory], { stdio: "inherit" });
console.log("Installed checksum-verified fonts for Linux browser QA");
