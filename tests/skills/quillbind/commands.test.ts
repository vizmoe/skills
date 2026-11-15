import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT, SKILL_DIR } from "./support.ts";

// An installed skill exposes the runtime only through this launcher; `quillbind` is not on PATH.
const BARE =
  /(?:^|[`\s])quillbind\s+(?:epub|metadata|manga|novel|init|doctor|inspect|build|preview|preflight|validate|qa|schema|formats|taxonomy|version)\b/u;

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files.sort();
}

describe("documented runtime commands", () => {
  it("uses the installed launcher rather than bare quillbind commands", async () => {
    const offenders: string[] = [];
    for (const filePath of await collectMarkdownFiles(SKILL_DIR)) {
      const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/u);
      lines.forEach((line, index) => {
        // Setup inside the runtime checkout legitimately runs `pnpm quillbind`.
        if (BARE.test(line.replaceAll("pnpm quillbind", ""))) {
          offenders.push(
            `${path.relative(REPO_ROOT, filePath)}:${index + 1}: ${line.trim()}`,
          );
        }
      });
    }
    expect(
      offenders,
      `Use node <skill-directory>/scripts/quillbind.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
