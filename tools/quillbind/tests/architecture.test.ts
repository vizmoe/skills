import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  auditArchitecture,
  DEFAULT_ARCHITECTURE_POLICY,
  type ArchitecturePolicy,
} from "../scripts/check-architecture.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeFixtureRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-arch-"));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
  return root;
}

const cleanPolicy: ArchitecturePolicy = {
  maxFileLines: 20,
  foundationCoreModules: new Set(["errors.ts", "xml.ts"]),
  legacyLargeFileCeilings: {},
  legacyEslintDisableBaseline: {},
};

describe("Keel architecture guard (check-architecture.ts)", () => {
  it("passes cleanly on the real repository with zero import cycles and zero findings", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const result = await auditArchitecture(
      repoRoot,
      DEFAULT_ARCHITECTURE_POLICY,
    );
    expect(result.cycles).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.coreModules).toBeGreaterThan(100);
  });

  it("detects planted circular imports and foundation-layer upward dependencies", async () => {
    const root = await makeFixtureRepo({
      "tools/quillbind/packages/core/src/errors.ts":
        'import { helper } from "./domain.js";\nexport const fail = helper;\n',
      "tools/quillbind/packages/core/src/xml.ts":
        'import { helper } from "./domain.js";\nexport const xml = helper;\n',
      "tools/quillbind/packages/core/src/domain.ts":
        'import { fail } from "./errors.js";\nexport const helper = () => fail;\n',
    });
    const result = await auditArchitecture(root, cleanPolicy);
    expect(result.ok).toBe(false);
    const codes = new Set(result.findings.map((f) => f.code));
    expect(codes.has("ARCH_IMPORT_CYCLE")).toBe(true);
    expect(codes.has("ARCH_LAYER_VIOLATION")).toBe(true);
  });

  it("rejects production any casts, TS suppressions, eslint-disable accretion, and skipped tests", async () => {
    const root = await makeFixtureRepo({
      "tools/quillbind/packages/core/src/bad.ts": [
        "// eslint-disable-next-line no-console",
        "// @ts-ignore",
        "export const x: any = 1;",
      ].join("\n"),
      "tools/quillbind/tests/sample.test.ts": 'it.skip("skipped", () => {});\n',
    });
    const result = await auditArchitecture(root, cleanPolicy);
    expect(result.ok).toBe(false);
    expect(new Set(result.findings.map((f) => f.code))).toEqual(
      new Set([
        "ARCH_SUPPRESSION_GROWTH",
        "ARCH_PROD_TS_SUPPRESSION",
        "ARCH_PROD_ANY",
        "ARCH_SKIPPED_TEST",
      ]),
    );
  });

  it("enforces shrink-only file-size ceilings, stale baselines, and CLI-formats parity", async () => {
    const oversize = Array.from(
      { length: 25 },
      (_, i) => `export const v${i} = ${i};`,
    ).join("\n");
    const root = await makeFixtureRepo({
      "tools/quillbind/packages/core/src/index.ts":
        'export const formats = { epubInputModes: ["audit", "ghost-mode"], pdfInputModes: ["inspect"] } as const;\n',
      "tools/quillbind/packages/core/src/giant.ts": oversize,
      "tools/quillbind/packages/cli/src/index.ts":
        'export const handlers = ["audit", "inspect"];\n',
    });
    const result = await auditArchitecture(root, {
      ...cleanPolicy,
      legacyLargeFileCeilings: {
        "tools/quillbind/packages/core/src/retired.ts": 1000,
      },
    });
    expect(result.ok).toBe(false);
    expect(new Set(result.findings.map((f) => f.code))).toEqual(
      new Set([
        "ARCH_FILE_TOO_LARGE",
        "ARCH_STALE_FILE_BASELINE",
        "ARCH_CLI_FORMATS_DRIFT",
      ]),
    );
  });
});
