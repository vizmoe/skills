import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ArchitectureFinding {
  code:
    | "ARCH_IMPORT_CYCLE"
    | "ARCH_LAYER_VIOLATION"
    | "ARCH_PROD_ANY"
    | "ARCH_PROD_TS_SUPPRESSION"
    | "ARCH_SUPPRESSION_GROWTH"
    | "ARCH_STALE_SUPPRESSION_BASELINE"
    | "ARCH_SKIPPED_TEST"
    | "ARCH_FILE_TOO_LARGE"
    | "ARCH_STALE_FILE_BASELINE"
    | "ARCH_CLI_FORMATS_DRIFT";
  file: string;
  message: string;
}

export interface ArchitecturePolicy {
  maxFileLines: number;
  foundationCoreModules: ReadonlySet<string>;
  legacyLargeFileCeilings: Readonly<Record<string, number>>;
  legacyEslintDisableBaseline: Readonly<Record<string, number>>;
}

export interface ArchitectureAuditResult {
  ok: boolean;
  filesScanned: number;
  coreModules: number;
  cycles: string[][];
  findings: ArchitectureFinding[];
}

export const DEFAULT_MAX_FILE_LINES = 750;

export const FOUNDATION_CORE_MODULES: ReadonlySet<string> = new Set([
  "errors.ts",
  "hash.ts",
  "json.ts",
  "paths.ts",
  "hyperlinks.ts",
  "runtime.ts",
  "standards.ts",
  "files.ts",
  "process.ts",
  "xhtml-entities.ts",
  "css.ts",
  "xml.ts",
  "zip.ts",
  "epub-types.ts",
  "shard-common.ts",
]);

/**
 * Shrink-only baseline for legacy files above DEFAULT_MAX_FILE_LINES.
 * Entries must be removed once refactored <= DEFAULT_MAX_FILE_LINES (parent #178).
 */
export const LEGACY_LARGE_FILE_CEILINGS: Readonly<Record<string, number>> = {
  // Tranche 2 (#180): CLI modularization
  "tools/quillbind/packages/cli/src/index.ts": 1178,
  // Tranche 3 (#181): PDF stack decomposition
  "tools/quillbind/packages/core/src/pdf-binary.ts": 3042,
  "tools/quillbind/packages/core/src/pdf-shard.ts": 2333,
  "tools/quillbind/packages/core/src/pdf-epub.ts": 1845,
  "tools/quillbind/packages/core/src/pdf-repair.ts": 1357,
  // Tranche 4 (#182): Kindle, Catalog, Bibliography decomposition
  "tools/quillbind/packages/core/src/bibliography-file.ts": 1556,
  "tools/quillbind/packages/core/src/kindle.ts": 1543,
  "tools/quillbind/packages/core/src/catalog-parse.ts": 1215,
  "tools/quillbind/packages/core/src/bibliography-normalize.ts": 1112,
  "tools/quillbind/packages/core/src/catalog.ts": 886,
  // Tranche 5 (#183): Bilingual, skill-evals, delivery-audit decomposition
  "skills/quillbind/scripts/delivery-audit.ts": 1610,
  "tools/quillbind/packages/core/src/bilingual-shard.ts": 1187,
  "tools/quillbind/scripts/skill-evals.ts": 1070,
  "tools/quillbind/packages/core/src/bilingual-plan.ts": 1060,
  "tools/quillbind/packages/core/src/bilingual-build.ts": 924,
  // Tracked shrink-only moderate legacy files
  "tools/quillbind/packages/core/src/tags-file.ts": 795,
  "tools/quillbind/packages/core/src/markdown.ts": 787,
  "tools/quillbind/packages/core/src/repair.ts": 763,
};

/** Shrink-only baseline for justified eslint-disable directives in production code. */
export const LEGACY_ESLINT_DISABLE_BASELINE: Readonly<Record<string, number>> =
  {
    "tools/quillbind/packages/core/src/css.ts": 2,
    "tools/quillbind/packages/core/src/hyperlinks.ts": 1,
    "tools/quillbind/packages/core/src/paths.ts": 1,
    "tools/quillbind/packages/core/src/process.ts": 1,
    "tools/quillbind/packages/core/src/xml.ts": 1,
  };

export const DEFAULT_ARCHITECTURE_POLICY: ArchitecturePolicy = {
  maxFileLines: DEFAULT_MAX_FILE_LINES,
  foundationCoreModules: FOUNDATION_CORE_MODULES,
  legacyLargeFileCeilings: LEGACY_LARGE_FILE_CEILINGS,
  legacyEslintDisableBaseline: LEGACY_ESLINT_DISABLE_BASELINE,
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
]);

const RELATIVE_IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s+)?["'](\.\.?\/[^"']+)["']/gu;
const ANY_USAGE_RE = /(?:[:<,]|\bas\b)\s*any\b/u;
const TS_SUPPRESSION_RE = /@ts-(?:ignore|expect-error|nocheck)\b/u;
const ESLINT_DISABLE_RE = /eslint-disable/u;
const SKIPPED_TEST_RE = /^\s*(?:it|test|describe)\.skip\s*\(/u;

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.replace(/\r?\n$/u, "").split(/\r?\n/u).length;
}

async function listTsFiles(dirPath: string): Promise<string[]> {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out.sort();
}

function toRepoPosix(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function stripCommentsForScan(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/gu, "$1");
}

function extractRelativeImports(source: string): string[] {
  const cleaned = stripCommentsForScan(source);
  const specifiers: string[] = [];
  for (const match of cleaned.matchAll(RELATIVE_IMPORT_RE)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return [...new Set(specifiers)].sort();
}

function resolveRelativeTsTarget(
  repoRoot: string,
  fromFile: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | null {
  const baseDir = path.dirname(fromFile);
  const rawTarget = path.resolve(baseDir, specifier);
  const candidates = [
    rawTarget,
    rawTarget.replace(/\.js$/u, ".ts"),
    `${rawTarget}.ts`,
    path.join(rawTarget, "index.ts"),
  ];
  for (const candidate of candidates) {
    const rel = toRepoPosix(repoRoot, candidate);
    if (knownFiles.has(rel)) return rel;
  }
  return null;
}

function findImportCycles(graph: ReadonlyMap<string, string[]>): string[][] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const seenKeys = new Set<string>();
  const cycles: string[][] = [];

  const dfs = (node: string): void => {
    visited.add(node);
    active.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (active.has(next)) {
        const start = stack.indexOf(next);
        const loop = stack.slice(start);
        const minNode = [...loop].sort()[0]!;
        const minIdx = loop.indexOf(minNode);
        const canonical = [...loop.slice(minIdx), ...loop.slice(0, minIdx)];
        const key = canonical.join(" -> ");
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          cycles.push([...canonical, canonical[0]!]);
        }
      } else if (!visited.has(next)) {
        dfs(next);
      }
    }
    stack.pop();
    active.delete(node);
  };

  for (const node of [...graph.keys()].sort()) {
    if (!visited.has(node)) dfs(node);
  }
  return cycles;
}

function extractStringArray(source: string, key: string): string[] {
  const re = new RegExp(`${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`, "u");
  const match = re.exec(source);
  if (!match?.[1]) return [];
  return [...match[1].matchAll(/["']([^"']+)["']/gu)].map((m) => m[1]!);
}

function checkCyclesAndLayers(
  repoRoot: string,
  graphFiles: Map<string, string>,
  policy: ArchitecturePolicy,
  findings: ArchitectureFinding[],
): string[][] {
  const knownFiles = new Set(graphFiles.keys());
  const graph = new Map<string, string[]>();
  const corePrefix = "tools/quillbind/packages/core/src/";

  for (const [relFile, content] of graphFiles.entries()) {
    const absFile = path.join(repoRoot, relFile);
    const resolvedTargets: string[] = [];
    for (const spec of extractRelativeImports(content)) {
      const target = resolveRelativeTsTarget(
        repoRoot,
        absFile,
        spec,
        knownFiles,
      );
      if (target) resolvedTargets.push(target);
      if (relFile.startsWith(corePrefix)) {
        const coreRel = relFile.slice(corePrefix.length);
        if (target && !target.startsWith(corePrefix)) {
          findings.push({
            code: "ARCH_LAYER_VIOLATION",
            file: relFile,
            message: `Core module cannot import outside packages/core/src: ${target}`,
          });
        }
        if (coreRel === "errors.ts") {
          findings.push({
            code: "ARCH_LAYER_VIOLATION",
            file: relFile,
            message: `Foundation leaf errors.ts must have zero internal imports (found "${spec}")`,
          });
        } else if (
          policy.foundationCoreModules.has(coreRel) &&
          target?.startsWith(corePrefix)
        ) {
          const targetCoreRel = target.slice(corePrefix.length);
          if (!policy.foundationCoreModules.has(targetCoreRel)) {
            findings.push({
              code: "ARCH_LAYER_VIOLATION",
              file: relFile,
              message: `Foundation module "${coreRel}" cannot import non-foundation module "${targetCoreRel}"`,
            });
          }
        }
      }
    }
    graph.set(relFile, resolvedTargets);
  }

  const cycles = findImportCycles(graph);
  for (const cycle of cycles) {
    findings.push({
      code: "ARCH_IMPORT_CYCLE",
      file: cycle[0]!,
      message: `Circular import detected: ${cycle.join(" -> ")}`,
    });
  }
  return cycles;
}

function checkSuppressionsAndSize(
  prodFiles: Map<string, string>,
  scriptFiles: Map<string, string>,
  testFiles: Map<string, string>,
  policy: ArchitecturePolicy,
  findings: ArchitectureFinding[],
): void {
  const seenDisableCounts = new Map<string, number>();

  for (const [relFile, content] of prodFiles.entries()) {
    const lines = content.split(/\r?\n/u);
    const codeOnly = stripCommentsForScan(content).split(/\r?\n/u);
    let disableCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]!;
      const codeLine = codeOnly[i] ?? "";
      if (ESLINT_DISABLE_RE.test(rawLine)) disableCount += 1;
      if (TS_SUPPRESSION_RE.test(rawLine)) {
        findings.push({
          code: "ARCH_PROD_TS_SUPPRESSION",
          file: relFile,
          message: `Line ${i + 1}: TypeScript suppression directive forbidden in production code`,
        });
      }
      if (ANY_USAGE_RE.test(codeLine)) {
        findings.push({
          code: "ARCH_PROD_ANY",
          file: relFile,
          message: `Line ${i + 1}: explicit "any" type/cast forbidden in production code`,
        });
      }
    }

    if (disableCount > 0) seenDisableCounts.set(relFile, disableCount);
    const allowedDisables = policy.legacyEslintDisableBaseline[relFile] ?? 0;
    if (disableCount > allowedDisables) {
      findings.push({
        code: "ARCH_SUPPRESSION_GROWTH",
        file: relFile,
        message: `eslint-disable count (${disableCount}) exceeds shrink-only baseline (${allowedDisables})`,
      });
    }
  }

  for (const [baselineFile, allowedCount] of Object.entries(
    policy.legacyEslintDisableBaseline,
  )) {
    const actual = seenDisableCounts.get(baselineFile) ?? 0;
    if (actual < allowedCount) {
      findings.push({
        code: "ARCH_STALE_SUPPRESSION_BASELINE",
        file: baselineFile,
        message: `eslint-disable baseline (${allowedCount}) can be ratcheted down to ${actual}`,
      });
    }
  }

  for (const [relFile, content] of testFiles.entries()) {
    const codeLines = stripCommentsForScan(content).split(/\r?\n/u);
    for (let i = 0; i < codeLines.length; i++) {
      if (SKIPPED_TEST_RE.test(codeLines[i]!)) {
        findings.push({
          code: "ARCH_SKIPPED_TEST",
          file: relFile,
          message: `Line ${i + 1}: skipped test is forbidden`,
        });
      }
    }
  }

  const sizeChecked = new Map<string, string>([...prodFiles, ...scriptFiles]);
  for (const [relFile, content] of sizeChecked.entries()) {
    const lineCount = countLines(content);
    const ceiling =
      policy.legacyLargeFileCeilings[relFile] ?? policy.maxFileLines;
    if (lineCount > ceiling) {
      findings.push({
        code: "ARCH_FILE_TOO_LARGE",
        file: relFile,
        message: `File has ${lineCount} lines, exceeding ceiling of ${ceiling} lines`,
      });
    }
  }

  for (const [baselineFile] of Object.entries(policy.legacyLargeFileCeilings)) {
    const content = sizeChecked.get(baselineFile);
    if (content === undefined || countLines(content) <= policy.maxFileLines) {
      findings.push({
        code: "ARCH_STALE_FILE_BASELINE",
        file: baselineFile,
        message: `Legacy large-file baseline entry is now <= ${policy.maxFileLines} lines or removed; delete it from LEGACY_LARGE_FILE_CEILINGS`,
      });
    }
  }
}

function checkCliFormatsParity(
  coreIndexContent: string | undefined,
  cliFiles: Map<string, string>,
  findings: ArchitectureFinding[],
): void {
  if (!coreIndexContent || cliFiles.size === 0) return;
  const cliCombined = [...cliFiles.values()].join("\n");
  for (const key of ["epubInputModes", "pdfInputModes"]) {
    for (const mode of extractStringArray(coreIndexContent, key)) {
      if (
        !cliCombined.includes(`"${mode}"`) &&
        !cliCombined.includes(`'${mode}'`)
      ) {
        findings.push({
          code: "ARCH_CLI_FORMATS_DRIFT",
          file: "tools/quillbind/packages/core/src/index.ts",
          message: `formats.${key} declares "${mode}" without matching CLI handler in packages/cli/src`,
        });
      }
    }
  }
}

export async function auditArchitecture(
  repoRoot: string = path.resolve(import.meta.dirname, "../../.."),
  policy: ArchitecturePolicy = DEFAULT_ARCHITECTURE_POLICY,
): Promise<ArchitectureAuditResult> {
  const [corePaths, cliPaths, skillScriptPaths, toolScriptPaths, testPaths] =
    await Promise.all([
      listTsFiles(path.join(repoRoot, "tools/quillbind/packages/core/src")),
      listTsFiles(path.join(repoRoot, "tools/quillbind/packages/cli/src")),
      listTsFiles(path.join(repoRoot, "skills/quillbind/scripts")),
      listTsFiles(path.join(repoRoot, "tools/quillbind/scripts")),
      Promise.all([
        listTsFiles(path.join(repoRoot, "tools/quillbind/tests")),
        listTsFiles(path.join(repoRoot, "tests/skills/quillbind")),
      ]).then((groups) => groups.flat()),
    ]);

  const loadMap = async (paths: string[]): Promise<Map<string, string>> => {
    const entries = await Promise.all(
      paths.map(async (p) => [
        toRepoPosix(repoRoot, p),
        await fs.readFile(p, "utf8"),
      ]),
    );
    return new Map(entries as [string, string][]);
  };

  const [coreFiles, cliFiles, skillScripts, toolScripts, testFiles] =
    await Promise.all([
      loadMap(corePaths),
      loadMap(cliPaths),
      loadMap(skillScriptPaths),
      loadMap(toolScriptPaths),
      loadMap(testPaths),
    ]);

  const prodFiles = new Map<string, string>([
    ...coreFiles,
    ...cliFiles,
    ...skillScripts,
  ]);
  const findings: ArchitectureFinding[] = [];
  const cycles = checkCyclesAndLayers(repoRoot, prodFiles, policy, findings);
  checkSuppressionsAndSize(prodFiles, toolScripts, testFiles, policy, findings);
  checkCliFormatsParity(
    coreFiles.get("tools/quillbind/packages/core/src/index.ts"),
    cliFiles,
    findings,
  );

  return {
    ok: findings.length === 0,
    filesScanned: prodFiles.size + toolScripts.size + testFiles.size,
    coreModules: coreFiles.size,
    cycles,
    findings,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const audit = await auditArchitecture();
  if (!audit.ok) {
    for (const finding of audit.findings) {
      process.stderr.write(
        `[${finding.code}] ${finding.file}: ${finding.message}\n`,
      );
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Architecture checks passed (${audit.filesScanned} files, ${audit.coreModules} core modules, 0 import cycles).\n`,
    );
  }
}
