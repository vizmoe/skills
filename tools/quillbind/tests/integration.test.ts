import { it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { candidate, copyBook } from "./helpers.js";
import {
  inspectBytes,
  validateInternal,
  compatibilityLint,
} from "../packages/core/src/validate.js";
import { applyRepair, planFromBytes } from "../packages/core/src/repair.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { sha256 } from "../packages/core/src/hash.js";
import { run } from "../packages/core/src/process.js";
const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
it.each(["literature", "technical"])(
  "renders %s to standards-valid OCF and preserves byte reproducibility",
  async (theme) => {
    const root = await copyBook(theme);
    temporary.push(root);
    const first = await candidate(root);
    const second = await candidate(root);
    expect(validateInternal(first)).toEqual({
      status: "pass",
      diagnostics: [],
    });
    expect(sha256(first)).toBe(sha256(second));
    const info = inspectBytes(first, true);
    expect(info.version).toBe("3.0");
    expect(info.spine.length).toBe(3);
    expect(info.manifest.find((item) => item.id === info.spine[0])!.path).toBe(
      "EPUB/contents.xhtml",
    );
    expect(info.manifest.some((m) => m.properties.includes("nav"))).toBe(true);
    if (theme === "technical")
      expect(info.manifest.some((m) => m.properties.includes("mathml"))).toBe(
        true,
      );
  },
);
it("keeps unrelated cover warnings for Chinese books without a Kindle language restriction", async () => {
  const root = await copyBook();
  temporary.push(root);
  const report = await compatibilityLint(await candidate(root), "kindle");
  expect(report.status).toBe("pass");
  expect(report.distribution).toBe("warning");
  expect(report.diagnostics.map((item) => item.code)).toEqual([
    "COVER_MISSING",
  ]);
});
it("upgrades real EPUB 2 structure while preserving protected content and remains idempotent", async () => {
  const bytes = await fs.readFile(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  const plan = planFromBytes(bytes);
  expect(plan.actions.some((a) => a.ruleId === "navigation")).toBe(true);
  const fixed = applyRepair(bytes, plan);
  expect(validateInternal(fixed.bytes)).toEqual({
    status: "pass",
    diagnostics: [],
  });
  const info = inspectBytes(fixed.bytes);
  expect(info.version).toBe("3.0");
  expect(info.packageDocument.toString()).toContain("Example Translator");
  expect(info.packageDocument.toString()).toContain("custom:edition-note");
  expect(
    applyRepair(fixed.bytes, planFromBytes(fixed.bytes)).bytes.equals(
      fixed.bytes,
    ),
  ).toBe(true);
});
it("rejects stale and tampered repair plans", async () => {
  const bytes = await fs.readFile(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  const plan = planFromBytes(bytes);
  expect(() =>
    applyRepair(bytes, { ...plan, inputSha256: "0".repeat(64) }),
  ).toThrow();
  expect(() => applyRepair(bytes, { ...plan, actions: [] })).toThrow();
});
it("keeps CLI JSON stdout parseable on success and failure", async () => {
  const cli = path.join(repoRoot, "packages/cli/src/index.ts");
  const good = await run(
    process.execPath,
    ["--import", "tsx", cli, "formats", "--json"],
    { cwd: repoRoot },
  );
  expect(JSON.parse(good.stdout).inputs).toEqual([
    "markdown-book",
    "epub",
    "novel-url",
  ]);
  const bad = await run(
    process.execPath,
    ["--import", "tsx", cli, "nonsense", "--json"],
    { cwd: repoRoot },
  );
  expect(bad.exitCode).toBe(1);
  expect(JSON.parse(bad.stdout).code).toBe("COMMAND_UNKNOWN");
});
it("documents the novel CLI and rejects invalid inputs without network access", async () => {
  const cli = path.join(repoRoot, "packages/cli/src/index.ts");
  const invoke = (args: string[]) =>
    run(process.execPath, ["--import", "tsx", cli, ...args, "--json"], {
      cwd: repoRoot,
    });
  const help = await invoke(["--help"]);
  expect(JSON.parse(help.stdout).help).toContain("novel fetch <book-url>");
  for (const [args, code] of [
    [["novel", "fetch"], "ARGUMENT_REQUIRED"],
    [["novel", "fetch", "https://www.lightnovel.app/home"], "NOVEL_BOOK_URL"],
    [
      [
        "novel",
        "inspect",
        "https://www.bilinovel.com/novel/42.html",
        "--split-volumes",
      ],
      "ARGUMENT_CONFLICT",
    ],
    [
      [
        "novel",
        "fetch",
        "https://www.bilinovel.com/novel/42.html",
        "--delay",
        "oops",
      ],
      "NOVEL_OPTIONS",
    ],
  ] as const) {
    const result = await invoke([...args]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe(code);
    expect(result.stderr).toBe("");
  }
});

it("normalizes a recognized XHTML DTD without losing text or fetching entities", async () => {
  const { pack } = await import("../packages/core/src/zip.js");
  const source = await fs.readFile(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  const entries = new Map(
    [...inspectBytes(source).entries].map(([name, entry]) => [
      name,
      entry.bytes,
    ]),
  );
  const chapter = "OEBPS/chapter.xhtml";
  entries.set(
    chapter,
    Buffer.from(
      entries
        .get(chapter)!
        .toString()
        .replace(
          "<html",
          '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html',
        )
        .replace("A repair", "A&nbsp;repair"),
    ),
  );
  const bytes = pack(entries, 946684800);
  const plan = planFromBytes(bytes);
  expect(plan.actions.some((a) => a.ruleId === "legacy-xhtml")).toBe(true);
  const repaired = applyRepair(bytes, plan);
  expect(repaired.integrity).toMatchObject({ status: "pass" });
  expect(validateInternal(repaired.bytes).status).toBe("pass");
  expect(
    inspectBytes(repaired.bytes).entries.get(chapter)!.bytes.toString(),
  ).not.toContain("<!DOCTYPE");
});

it("repairs unique filename case mismatches and preserves the link destination", async () => {
  const { pack } = await import("../packages/core/src/zip.js");
  const source = await fs.readFile(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  const entries = new Map(
    [...inspectBytes(source).entries].map(([name, entry]) => [
      name,
      entry.bytes,
    ]),
  );
  const chapter = "OEBPS/chapter.xhtml";
  entries.set(
    chapter,
    Buffer.from(
      entries
        .get(chapter)!
        .toString()
        .replace('href="#chapter"', 'href="CHAPTER.xhtml#chapter"'),
    ),
  );
  const bytes = pack(entries, 946684800);
  const fixed = applyRepair(bytes, planFromBytes(bytes));
  expect(fixed.integrity).toMatchObject({ status: "pass" });
  expect(validateInternal(fixed.bytes).status).toBe("pass");
});

it("classifies referenced duplicate IDs as ambiguous", async () => {
  const { pack } = await import("../packages/core/src/zip.js");
  const source = await fs.readFile(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  const entries = new Map(
    [...inspectBytes(source).entries].map(([name, entry]) => [
      name,
      entry.bytes,
    ]),
  );
  const chapter = "OEBPS/chapter.xhtml";
  entries.set(
    chapter,
    Buffer.from(
      entries.get(chapter)!.toString().replace('id="details"', 'id="chapter"'),
    ),
  );
  const plan = planFromBytes(pack(entries, 946684800));
  expect(
    plan.actions.find((a) => a.ruleId === "duplicate-id")?.classification,
  ).toBe("review-required");
});
