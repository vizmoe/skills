import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { fail } from "./errors.js";
import { exists, readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { json, readJson, stable } from "./json.js";
import {
  BILINGUAL_SCHEMA_VERSION,
  translationGlossarySchema,
  translationMergedFileSchema,
  translationPlanSchema,
  translationShardFileSchema,
  translationVerificationFileSchema,
  type TranslationDiagnostic,
  type TranslationGlossary,
  type TranslationMergedFile,
  type TranslationMergedShardRecord,
  type TranslationPlan,
  type TranslationShardEntry,
  type TranslationShardFile,
  type TranslationUnit,
  type TranslationUnresolvedItem,
  type TranslationVerificationFile,
} from "./bilingual-model.js";
import { reconcileMarkers } from "./bilingual-markers.js";
import {
  planTranslationShards,
  validateLedgerRowState,
} from "./bilingual-plan.js";

const SHIFT_DIGIT_RUN_RE = /\d{2,}/gu;
const SHIFT_MIN_WITNESSES = 2;

export function computeShardContentSha256(
  shardId: string,
  entries: readonly TranslationShardEntry[],
): string {
  const ordered = [...entries]
    .map((entry) => ({
      unitId: entry.unitId,
      translation: entry.translation,
    }))
    .sort((a, b) => a.unitId.localeCompare(b.unitId, "en"));
  return sha256(stable({ shardId, entries: ordered }));
}

export function activePlanUnits(plan: TranslationPlan): {
  activeUnits: TranslationUnit[];
  skippedUserChars: number;
} {
  const undecided: string[] = [];
  const invalidStates: string[] = [];
  const actionByKey = new Map<string, "translate" | "skip">();

  for (const row of plan.ledger) {
    const stateErr = validateLedgerRowState(row);
    if (stateErr) invalidStates.push(stateErr);
    if (row.action === null) {
      undecided.push(row.key);
    } else {
      actionByKey.set(row.key, row.action);
    }
  }
  if (invalidStates.length > 0) {
    fail(
      "TRANSLATION_PLAN_INVALID",
      `Invalid classification ledger row(s): ${invalidStates.join("; ")}`,
      invalidStates,
    );
  }
  if (undecided.length > 0) {
    fail(
      "TRANSLATION_PLAN_UNDECIDED",
      `${undecided.length} signature(s) still have action=null; classify every signature before sharding: ${undecided.join(", ")}`,
      undecided,
    );
  }

  const activeUnits: TranslationUnit[] = [];
  let skippedUserChars = 0;
  for (const unit of plan.units) {
    const action = actionByKey.get(unit.signature);
    if (action === "skip") {
      skippedUserChars += unit.sourceChars;
      continue;
    }
    activeUnits.push(unit);
  }
  if (activeUnits.length === 0) {
    fail(
      "TRANSLATION_PLAN_EMPTY",
      "No translatable units remain after applying ledger decisions",
    );
  }
  return { activeUnits, skippedUserChars };
}

function chooseFence(text: string): string {
  let maxColons = 2;
  for (const match of text.matchAll(/:{3,}/gu)) {
    if (match[0].length > maxColons) {
      maxColons = match[0].length;
    }
  }
  return ":".repeat(maxColons + 1);
}

export function renderTranslationShardMarkdown(options: {
  shardId: string;
  plan: TranslationPlan;
  planSha256: string;
  units: readonly TranslationUnit[];
  glossarySha256?: string;
}): string {
  const { shardId, plan, planSha256, units, glossarySha256 } = options;
  const fm: Record<string, unknown> = {
    schemaVersion: BILINGUAL_SCHEMA_VERSION,
    kind: "quillbind-translation-shard",
    shardId,
    sourceSha256: plan.source.sha256,
    planSha256,
    sourceLanguage: plan.source.sourceLanguage,
    targetLanguage: plan.targetLanguage,
    mode: plan.mode,
    ...(glossarySha256 ? { glossarySha256 } : {}),
    translatedBy: "",
    unresolved: [],
  };
  const lines: string[] = ["---", stringifyYaml(fm).trimEnd(), "---", ""];
  for (const unit of units) {
    const fence = chooseFence(unit.sourceText);
    const markerNote = unit.markers.length
      ? ` | markers: ${unit.markers.map((m) => m.token).join(" ")}`
      : "";
    lines.push(
      `<!-- unit: ${unit.id} | doc: ${unit.docPath} | sig: ${unit.signature}${markerNote} -->`,
      `${fence}source{id="${unit.id}"}`,
      unit.sourceText,
      fence,
      `${fence}target{id="${unit.id}"}`,
      fence,
      "",
    );
  }
  return lines.join("\n");
}

function parseUnresolvedItems(raw: unknown): TranslationUnresolvedItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TranslationUnresolvedItem[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) {
      items.push({ reason: entry.trim() });
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      if (typeof rec.reason === "string" && rec.reason.trim()) {
        items.push({
          ...(typeof rec.unitId === "string" && rec.unitId.trim()
            ? { unitId: rec.unitId.trim() }
            : {}),
          reason: rec.reason.trim(),
          ...(typeof rec.context === "string" && rec.context.trim()
            ? { context: rec.context.trim() }
            : {}),
        });
      }
    }
  }
  return items;
}

export function compileTranslationShardMarkdown(
  markdown: string,
  fileLabel: string,
): {
  shard?: TranslationShardFile;
  diagnostics: TranslationDiagnostic[];
} {
  const diagnostics: TranslationDiagnostic[] = [];
  const normalized = markdown.replace(/\r\n/gu, "\n");
  const fmMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  if (!fmMatch) {
    diagnostics.push({
      code: "TRANSLATION_MD_FRONTMATTER",
      severity: "error",
      file: fileLabel,
      line: 1,
      message: "Missing YAML frontmatter delimited by ---",
    });
    return { diagnostics };
  }
  let fm: Record<string, unknown>;
  try {
    const parsed = parseYaml(fmMatch[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Frontmatter must be a YAML mapping");
    }
    fm = parsed as Record<string, unknown>;
  } catch (err) {
    diagnostics.push({
      code: "TRANSLATION_MD_FRONTMATTER",
      severity: "error",
      file: fileLabel,
      line: 2,
      message: `Invalid YAML frontmatter: ${String(err)}`,
    });
    return { diagnostics };
  }

  const lineOffset = fmMatch[0].split("\n").length - 1;
  const bodyLines = normalized.slice(fmMatch[0].length).split("\n");
  const sources = new Map<string, string>();
  const targets = new Map<string, { text: string; line: number }>();
  const order: string[] = [];

  let i = 0;
  while (i < bodyLines.length) {
    const rawLine = bodyLines[i];
    const lineNum = i + 1 + lineOffset;
    const openMatch = /^(:{3,})(source|target)\{id="([^"]+)"\}\s*$/u.exec(
      rawLine,
    );
    if (!openMatch) {
      i += 1;
      continue;
    }
    const [, fence, blockKind, unitId] = openMatch;
    const closeLine = fence;
    const contentLines: string[] = [];
    i += 1;
    let closed = false;
    while (i < bodyLines.length) {
      if (bodyLines[i].trimEnd() === closeLine) {
        closed = true;
        i += 1;
        break;
      }
      contentLines.push(bodyLines[i]);
      i += 1;
    }
    if (!closed) {
      diagnostics.push({
        code: "TRANSLATION_MD_BLOCK",
        severity: "error",
        file: fileLabel,
        unitId,
        line: lineNum,
        message: `Unclosed ${fence}${blockKind}{id="${unitId}"} block`,
      });
      continue;
    }
    const blockText = contentLines.join("\n").trim();
    if (blockKind === "source") {
      sources.set(unitId, blockText);
      if (!order.includes(unitId)) order.push(unitId);
    } else {
      if (targets.has(unitId)) {
        diagnostics.push({
          code: "TRANSLATION_UNIT_DUPLICATE",
          severity: "error",
          file: fileLabel,
          unitId,
          line: lineNum,
          message: `Duplicate :::target block for unit "${unitId}"`,
        });
      } else {
        targets.set(unitId, { text: blockText, line: lineNum });
        if (!order.includes(unitId)) order.push(unitId);
      }
    }
  }

  const entries: TranslationShardEntry[] = [];
  for (const unitId of order) {
    const tgt = targets.get(unitId);
    if (!tgt) {
      diagnostics.push({
        code: "TRANSLATION_UNIT_MISSING",
        severity: "error",
        file: fileLabel,
        unitId,
        message: `Missing :::target block for unit "${unitId}"`,
      });
      continue;
    }
    entries.push({
      unitId,
      ...(sources.has(unitId) ? { sourceText: sources.get(unitId) } : {}),
      translation: tgt.text,
    });
  }

  const rawShard = {
    schemaVersion: fm.schemaVersion ?? BILINGUAL_SCHEMA_VERSION,
    kind: fm.kind ?? "quillbind-translation-shard",
    shardId: fm.shardId,
    sourceSha256: fm.sourceSha256,
    planSha256: fm.planSha256,
    sourceLanguage: fm.sourceLanguage ?? "",
    targetLanguage: fm.targetLanguage,
    mode: fm.mode,
    ...(typeof fm.glossarySha256 === "string" && fm.glossarySha256.trim()
      ? { glossarySha256: fm.glossarySha256.trim() }
      : {}),
    translatedBy:
      typeof fm.translatedBy === "string" ? fm.translatedBy.trim() : "",
    entries,
    unresolved: parseUnresolvedItems(fm.unresolved),
  };

  const parsed = translationShardFileSchema.safeParse(rawShard);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push({
        code: "TRANSLATION_SHARD_SCHEMA",
        severity: "error",
        file: fileLabel,
        line: 2,
        message: `${issue.path.join(".")}: ${issue.message}`,
      });
    }
    return { diagnostics };
  }
  return { shard: parsed.data, diagnostics };
}

export async function initTranslationShards(
  planFile: string,
  outputDir: string,
  options: {
    format?: "md" | "json";
    glossary?: string;
    tokenBudget?: number;
  } = {},
): Promise<{
  status: "pass";
  operation: "epub-translate-shard-init";
  outputDir: string;
  format: "md" | "json";
  planSha256: string;
  glossarySha256?: string;
  shards: {
    id: string;
    file: string;
    unitCount: number;
    estimatedTokens: number;
  }[];
  indexPath: string;
}> {
  const format = options.format ?? "md";
  const resolvedOut = path.resolve(outputDir);
  if (await exists(resolvedOut)) {
    fail(
      "OUTPUT_EXISTS",
      `Refusing to overwrite existing translation shards directory: ${resolvedOut}`,
    );
  }
  const resolvedPlan = path.resolve(planFile);
  const planBytes = await readSourceFile(resolvedPlan);
  const planSha256 = sha256(planBytes);
  const parsedPlan = translationPlanSchema.safeParse(
    JSON.parse(planBytes.toString("utf8")),
  );
  if (!parsedPlan.success) {
    fail("TRANSLATION_PLAN_INVALID", parsedPlan.error.message);
  }
  const plan = parsedPlan.data;
  const { activeUnits } = activePlanUnits(plan);

  let glossarySha256: string | undefined;
  if (options.glossary) {
    const gBytes = await readSourceFile(path.resolve(options.glossary));
    const parsedGlossary = translationGlossarySchema.safeParse(
      JSON.parse(gBytes.toString("utf8")),
    );
    if (!parsedGlossary.success) {
      fail("TRANSLATION_GLOSSARY_INVALID", parsedGlossary.error.message);
    }
    glossarySha256 = sha256(gBytes);
  }

  const unitById = new Map(activeUnits.map((u) => [u.id, u]));
  const shardPlans = planTranslationShards(
    activeUnits,
    options.tokenBudget ?? plan.tokenBudget,
  );
  await fs.mkdir(resolvedOut, { recursive: true });

  const outputs: {
    id: string;
    file: string;
    unitCount: number;
    estimatedTokens: number;
  }[] = [];

  for (const shardPlan of shardPlans) {
    const units = shardPlan.unitIds
      .map((id) => unitById.get(id))
      .filter((u): u is TranslationUnit => Boolean(u));
    const filePath = path.join(resolvedOut, `${shardPlan.id}.${format}`);
    if (format === "md") {
      const md = renderTranslationShardMarkdown({
        shardId: shardPlan.id,
        plan,
        planSha256,
        units,
        glossarySha256,
      });
      await fs.writeFile(filePath, md, { flag: "wx" });
    } else {
      const payload: TranslationShardFile = {
        schemaVersion: BILINGUAL_SCHEMA_VERSION,
        kind: "quillbind-translation-shard",
        shardId: shardPlan.id,
        sourceSha256: plan.source.sha256,
        planSha256,
        sourceLanguage: plan.source.sourceLanguage,
        targetLanguage: plan.targetLanguage,
        mode: plan.mode,
        ...(glossarySha256 ? { glossarySha256 } : {}),
        translatedBy: "",
        entries: units.map((u) => ({
          unitId: u.id,
          sourceText: u.sourceText,
          translation: "",
        })),
        unresolved: [],
      };
      await json(filePath, payload);
    }
    outputs.push({
      id: shardPlan.id,
      file: filePath,
      unitCount: units.length,
      estimatedTokens: shardPlan.estimatedTokens,
    });
  }

  const indexPath = path.join(resolvedOut, "shards-index.json");
  await json(indexPath, {
    schemaVersion: BILINGUAL_SCHEMA_VERSION,
    kind: "quillbind-translation-shards-index",
    sourceSha256: plan.source.sha256,
    planPath: resolvedPlan,
    planSha256,
    ...(glossarySha256 ? { glossarySha256 } : {}),
    format,
    shards: outputs,
  });

  return {
    status: "pass",
    operation: "epub-translate-shard-init",
    outputDir: resolvedOut,
    format,
    planSha256,
    ...(glossarySha256 ? { glossarySha256 } : {}),
    shards: outputs,
    indexPath,
  };
}

async function resolveShardFiles(shardInput: string): Promise<string[]> {
  const parts = shardInput
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const files: string[] = [];
  const walk = async (dir: string) => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    );
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (
        entry.isFile() &&
        entry.name !== "shards-index.json" &&
        (entry.name.endsWith(".md") || entry.name.endsWith(".json"))
      ) {
        files.push(full);
      }
    }
  };
  for (const part of parts) {
    const resolved = path.resolve(part);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) {
      fail(
        "SHARD_MISSING",
        `Translation shard path does not exist: ${resolved}`,
      );
    }
    if (stat.isDirectory()) await walk(resolved);
    else files.push(resolved);
  }
  if (!files.length) {
    fail("SHARD_MISSING", "No translation shard .md or .json files found");
  }
  return files;
}

async function loadShardFile(file: string): Promise<{
  shard?: TranslationShardFile;
  diagnostics: TranslationDiagnostic[];
}> {
  const text = await fs.readFile(file, "utf8");
  if (file.endsWith(".md")) {
    return compileTranslationShardMarkdown(text, file);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      diagnostics: [
        {
          code: "TRANSLATION_SHARD_JSON_SYNTAX",
          severity: "error",
          file,
          line: 1,
          message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  const parsed = translationShardFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      diagnostics: parsed.error.issues.map((issue) => ({
        code: "TRANSLATION_SHARD_SCHEMA",
        severity: "error" as const,
        file,
        message: `${issue.path.join(".")}: ${issue.message}`,
      })),
    };
  }
  return { shard: parsed.data, diagnostics: [] };
}

export async function validateTranslationShard(
  shardInput: string,
  options: { plan?: string; allowUntranslated?: boolean } = {},
): Promise<{
  status: "pass" | "fail";
  operation: "epub-translate-validate-shard";
  filesChecked: number;
  shardCount: number;
  unitCount: number;
  diagnostics: TranslationDiagnostic[];
}> {
  const files = await resolveShardFiles(shardInput);
  const diagnostics: TranslationDiagnostic[] = [];
  let plan: TranslationPlan | undefined;
  let expectedPlanSha: string | undefined;
  let activeUnitById: Map<string, TranslationUnit> | undefined;

  if (options.plan) {
    const planBytes = await readSourceFile(path.resolve(options.plan));
    expectedPlanSha = sha256(planBytes);
    const parsed = translationPlanSchema.safeParse(
      JSON.parse(planBytes.toString("utf8")),
    );
    if (!parsed.success) {
      fail("TRANSLATION_PLAN_INVALID", parsed.error.message);
    }
    plan = parsed.data;
    const { activeUnits } = activePlanUnits(plan);
    activeUnitById = new Map(activeUnits.map((u) => [u.id, u]));
  }

  const seenShardIds = new Set<string>();
  const seenUnitIds = new Set<string>();
  let shardCount = 0;
  let unitCount = 0;

  for (const file of files) {
    const loaded = await loadShardFile(file);
    diagnostics.push(...loaded.diagnostics);
    const shard = loaded.shard;
    if (!shard) continue;
    shardCount += 1;

    if (seenShardIds.has(shard.shardId)) {
      diagnostics.push({
        code: "TRANSLATION_SHARD_DUPLICATE",
        severity: "error",
        file,
        shardId: shard.shardId,
        message: `Duplicate shardId "${shard.shardId}"`,
      });
    } else {
      seenShardIds.add(shard.shardId);
    }

    if (!options.allowUntranslated && !shard.translatedBy.trim()) {
      diagnostics.push({
        code: "TRANSLATION_WORKER_MISSING",
        severity: "error",
        file,
        shardId: shard.shardId,
        message: `Shard "${shard.shardId}" must record a non-empty translatedBy worker identity`,
      });
    }

    if (plan && expectedPlanSha) {
      if (shard.sourceSha256 !== plan.source.sha256) {
        diagnostics.push({
          code: "TRANSLATION_SOURCE_MISMATCH",
          severity: "error",
          file,
          shardId: shard.shardId,
          message: `Shard sourceSha256 does not match plan source`,
        });
      }
      if (shard.planSha256 !== expectedPlanSha) {
        diagnostics.push({
          code: "TRANSLATION_PLAN_MISMATCH",
          severity: "error",
          file,
          shardId: shard.shardId,
          message: `Shard planSha256 does not match current plan file`,
        });
      }
    }

    for (const entry of shard.entries) {
      unitCount += 1;
      if (seenUnitIds.has(entry.unitId)) {
        diagnostics.push({
          code: "TRANSLATION_UNIT_DUPLICATE",
          severity: "error",
          file,
          shardId: shard.shardId,
          unitId: entry.unitId,
          message: `Unit "${entry.unitId}" appears in multiple shards`,
        });
      } else {
        seenUnitIds.add(entry.unitId);
      }

      if (!options.allowUntranslated && !entry.translation.trim()) {
        diagnostics.push({
          code: "TRANSLATION_UNIT_EMPTY",
          severity: "error",
          file,
          shardId: shard.shardId,
          unitId: entry.unitId,
          message: `Unit "${entry.unitId}" has an empty translation`,
        });
      }

      if (activeUnitById) {
        const planUnit = activeUnitById.get(entry.unitId);
        if (!planUnit) {
          diagnostics.push({
            code: "TRANSLATION_UNIT_UNKNOWN",
            severity: "error",
            file,
            shardId: shard.shardId,
            unitId: entry.unitId,
            message: `Unit "${entry.unitId}" is not an active translatable unit in the plan`,
          });
        } else if (entry.translation.trim()) {
          const rec = reconcileMarkers(
            planUnit.sourceText,
            entry.translation,
            planUnit.markers.map((m) => m.token),
          );
          if (rec.missing.length > 0) {
            diagnostics.push({
              code: "TRANSLATION_MARKER_MISSING",
              severity: "warning",
              file,
              shardId: shard.shardId,
              unitId: entry.unitId,
              message: `Unit "${entry.unitId}" omitted inline marker(s): ${rec.missing.join(", ")}`,
            });
          }
          if (rec.invented.length > 0) {
            diagnostics.push({
              code: "TRANSLATION_MARKER_INVENTED",
              severity: "warning",
              file,
              shardId: shard.shardId,
              unitId: entry.unitId,
              message: `Unit "${entry.unitId}" contains invented inline marker(s): ${rec.invented.join(", ")}`,
            });
          }
        }
      }
    }
  }

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  return {
    status: hasErrors ? "fail" : "pass",
    operation: "epub-translate-validate-shard",
    filesChecked: files.length,
    shardCount,
    unitCount,
    diagnostics,
  };
}

export async function mergeTranslationShards(
  planFile: string,
  shardsInput: string,
  outputFile: string,
): Promise<{
  status: "pass";
  operation: "epub-translate-merge";
  outputPath: string;
  planSha256: string;
  shardCount: number;
  unitCount: number;
  shards: TranslationMergedShardRecord[];
}> {
  const resolvedOut = path.resolve(outputFile);
  if (await exists(resolvedOut)) {
    fail(
      "OUTPUT_EXISTS",
      `Refusing to overwrite existing merged translations file: ${resolvedOut}`,
    );
  }
  const resolvedPlan = path.resolve(planFile);
  const planBytes = await readSourceFile(resolvedPlan);
  const planSha256 = sha256(planBytes);
  const parsedPlan = translationPlanSchema.safeParse(
    JSON.parse(planBytes.toString("utf8")),
  );
  if (!parsedPlan.success) {
    fail("TRANSLATION_PLAN_INVALID", parsedPlan.error.message);
  }
  const plan = parsedPlan.data;
  const { activeUnits } = activePlanUnits(plan);
  const activeIds = new Set(activeUnits.map((u) => u.id));

  const validation = await validateTranslationShard(shardsInput, {
    plan: resolvedPlan,
  });
  const valErrors = validation.diagnostics.filter(
    (d) => d.severity === "error",
  );
  if (valErrors.length > 0) {
    fail(
      valErrors[0].code,
      valErrors.map((d) => d.message).join("; "),
      valErrors,
    );
  }

  const files = await resolveShardFiles(shardsInput);
  const shardRecords: TranslationMergedShardRecord[] = [];
  const translations: Record<string, string> = {};
  let glossarySha256: string | undefined;

  for (const file of files) {
    const loaded = await loadShardFile(file);
    if (!loaded.shard) continue;
    const shard = loaded.shard;
    if (shard.glossarySha256) {
      if (glossarySha256 && glossarySha256 !== shard.glossarySha256) {
        fail(
          "TRANSLATION_GLOSSARY_MISMATCH",
          `Shard "${shard.shardId}" references a different glossarySha256`,
        );
      }
      glossarySha256 = shard.glossarySha256;
    }
    const unitIds: string[] = [];
    for (const entry of shard.entries) {
      translations[entry.unitId] = entry.translation;
      unitIds.push(entry.unitId);
    }
    shardRecords.push({
      shardId: shard.shardId,
      translatedBy: shard.translatedBy.trim(),
      unitIds,
      contentSha256: computeShardContentSha256(shard.shardId, shard.entries),
      unresolved: shard.unresolved,
    });
  }

  const missingUnits = [...activeIds].filter((id) => !(id in translations));
  if (missingUnits.length > 0) {
    fail(
      "TRANSLATION_SHARDS_INCOMPLETE",
      `Missing translations for ${missingUnits.length} active unit(s): ${missingUnits.slice(0, 10).join(", ")}`,
      missingUnits,
    );
  }

  shardRecords.sort((a, b) => a.shardId.localeCompare(b.shardId, "en"));
  const merged: TranslationMergedFile = {
    schemaVersion: BILINGUAL_SCHEMA_VERSION,
    kind: "quillbind-translation-merged",
    sourceSha256: plan.source.sha256,
    planSha256,
    sourceLanguage: plan.source.sourceLanguage,
    targetLanguage: plan.targetLanguage,
    mode: plan.mode,
    ...(glossarySha256 ? { glossarySha256 } : {}),
    shards: shardRecords,
    translations,
  };
  await json(resolvedOut, merged);

  return {
    status: "pass",
    operation: "epub-translate-merge",
    outputPath: resolvedOut,
    planSha256,
    shardCount: shardRecords.length,
    unitCount: Object.keys(translations).length,
    shards: shardRecords,
  };
}

function baseLanguage(lang: string): string {
  return lang.trim().toLowerCase().split("-")[0] ?? "";
}

function countLetterChars(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

function checkTargetScriptMismatch(
  targetLanguage: string,
  translation: string,
): boolean {
  const plain = translation.replace(/⟦[^⟦⟧\s]{1,32}⟧/gu, "").trim();
  if (plain.length < 20) return false;
  const base = baseLanguage(targetLanguage);
  if (base === "zh") return !/\p{Script=Han}/u.test(plain);
  if (base === "ja")
    return !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(
      plain,
    );
  if (base === "ko") return !/\p{Script=Hangul}/u.test(plain);
  if (base === "ar") return !/\p{Script=Arabic}/u.test(plain);
  return false;
}

function detectShardNumericSlotShift(
  shardUnits: readonly TranslationUnit[],
  translations: Record<string, string>,
): { witnesses: number; examples: string[] } {
  const srcDigits = shardUnits.map(
    (u) => new Set(u.sourceText.match(SHIFT_DIGIT_RUN_RE) ?? []),
  );
  const tgtDigits = shardUnits.map(
    (u) => new Set((translations[u.id] ?? "").match(SHIFT_DIGIT_RUN_RE) ?? []),
  );
  let witnesses = 0;
  const examples: string[] = [];
  for (let i = 0; i < shardUnits.length; i++) {
    for (const num of srcDigits[i]) {
      if (tgtDigits[i].has(num)) continue;
      const shiftedPrev =
        i > 0 && !srcDigits[i - 1].has(num) && tgtDigits[i - 1].has(num);
      const shiftedNext =
        i + 1 < shardUnits.length &&
        !srcDigits[i + 1].has(num) &&
        tgtDigits[i + 1].has(num);
      if (shiftedPrev || shiftedNext) {
        witnesses += 1;
        if (examples.length < 5) {
          examples.push(`${shardUnits[i].id}(${num})`);
        }
      }
    }
  }
  return { witnesses, examples };
}

/** Verify independent read-only verifier records against merged translations. */
export function verifyTranslationRecords(
  merged: TranslationMergedFile,
  verification?: TranslationVerificationFile,
): TranslationDiagnostic[] {
  const diagnostics: TranslationDiagnostic[] = [];
  for (const shard of merged.shards) {
    if (shard.unresolved.length > 0) {
      diagnostics.push({
        code: "TRANSLATION_UNRESOLVED_ITEMS",
        severity: "error",
        shardId: shard.shardId,
        message: `Shard "${shard.shardId}" still has ${shard.unresolved.length} unresolved item(s)`,
      });
    }
  }
  if (!verification) {
    diagnostics.push({
      code: "TRANSLATION_VERIFICATION_REQUIRED",
      severity: "error",
      message:
        "Independent verifier record (quillbind-translation-verification) is required before building",
    });
    return diagnostics;
  }
  if (verification.sourceSha256 !== merged.sourceSha256) {
    diagnostics.push({
      code: "TRANSLATION_SOURCE_MISMATCH",
      severity: "error",
      message: "Verification sourceSha256 does not match merged translations",
    });
  }
  if (verification.planSha256 !== merged.planSha256) {
    diagnostics.push({
      code: "TRANSLATION_PLAN_MISMATCH",
      severity: "error",
      message: "Verification planSha256 does not match merged translations",
    });
  }
  const byShard = new Map(verification.shards.map((s) => [s.shardId, s]));
  for (const shard of merged.shards) {
    const rec = byShard.get(shard.shardId);
    if (!rec) {
      diagnostics.push({
        code: "TRANSLATION_VERIFICATION_REQUIRED",
        severity: "error",
        shardId: shard.shardId,
        message: `Missing verification entry for shard "${shard.shardId}"`,
      });
      continue;
    }
    if (
      rec.verifiedBy === shard.translatedBy ||
      rec.verifiedBy === rec.translatedBy ||
      verification.verifierId === shard.translatedBy
    ) {
      diagnostics.push({
        code: "TRANSLATION_SELF_APPROVAL_FORBIDDEN",
        severity: "error",
        shardId: shard.shardId,
        message: `Shard "${shard.shardId}" cannot be verified by its translator "${shard.translatedBy}"`,
      });
    }
    if (rec.contentSha256 !== shard.contentSha256) {
      diagnostics.push({
        code: "TRANSLATION_VERIFICATION_STALE",
        severity: "error",
        shardId: shard.shardId,
        message: `Shard "${shard.shardId}" contentSha256 changed after verification`,
      });
    }
    if (rec.status !== "verified") {
      diagnostics.push({
        code: "TRANSLATION_SHARD_REJECTED",
        severity: "error",
        shardId: shard.shardId,
        message: `Shard "${shard.shardId}" has verification status "${rec.status}"`,
      });
    }
    if (rec.unresolved.length > 0) {
      diagnostics.push({
        code: "TRANSLATION_UNRESOLVED_ITEMS",
        severity: "error",
        shardId: shard.shardId,
        message: `Verification for shard "${shard.shardId}" still lists ${rec.unresolved.length} unresolved item(s)`,
      });
    }
  }
  return diagnostics;
}

export function assertTranslationVerified(
  merged: TranslationMergedFile,
  verification?: TranslationVerificationFile,
): void {
  const issues = verifyTranslationRecords(merged, verification).filter(
    (d) => d.severity === "error",
  );
  if (issues.length > 0) {
    fail(issues[0].code, issues.map((d) => d.message).join("; "), issues);
  }
}

export async function checkTranslationMerged(
  mergedFile: string,
  options: {
    plan?: string;
    glossary?: string;
    verification?: string;
  } = {},
): Promise<{
  status: "pass" | "fail";
  operation: "epub-translate-check";
  sourceSha256: string;
  planSha256: string;
  shardCount: number;
  unitCount: number;
  signals: {
    missingUnits: number;
    echoSuspects: number;
    markerIssues: number;
    numericShiftShards: number;
    scriptMismatches: number;
    glossaryDrifts: number;
  };
  diagnostics: TranslationDiagnostic[];
}> {
  const merged = translationMergedFileSchema.parse(
    await readJson<unknown>(path.resolve(mergedFile)),
  );
  let plan: TranslationPlan | undefined;
  let planSha256: string | undefined;
  if (options.plan) {
    const planBytes = await readSourceFile(path.resolve(options.plan));
    planSha256 = sha256(planBytes);
    plan = translationPlanSchema.parse(JSON.parse(planBytes.toString("utf8")));
  }
  let glossary: TranslationGlossary | undefined;
  if (options.glossary) {
    const gBytes = await readSourceFile(path.resolve(options.glossary));
    glossary = translationGlossarySchema.parse(
      JSON.parse(gBytes.toString("utf8")),
    );
  }
  let verification: TranslationVerificationFile | undefined;
  if (options.verification) {
    verification = translationVerificationFileSchema.parse(
      await readJson<unknown>(path.resolve(options.verification)),
    );
  }

  const diagnostics: TranslationDiagnostic[] = [];
  const signals = {
    missingUnits: 0,
    echoSuspects: 0,
    markerIssues: 0,
    numericShiftShards: 0,
    scriptMismatches: 0,
    glossaryDrifts: 0,
  };

  if (plan && planSha256) {
    if (merged.planSha256 !== planSha256) {
      diagnostics.push({
        code: "TRANSLATION_PLAN_MISMATCH",
        severity: "error",
        message: "Merged translations planSha256 does not match provided plan",
      });
    }
    const { activeUnits } = activePlanUnits(plan);
    const unitById = new Map(activeUnits.map((u) => [u.id, u]));
    const differentLang =
      baseLanguage(plan.source.sourceLanguage) !==
      baseLanguage(plan.targetLanguage);

    for (const shard of merged.shards) {
      const shardUnits = shard.unitIds
        .map((id) => unitById.get(id))
        .filter((u): u is TranslationUnit => Boolean(u));
      const shift = detectShardNumericSlotShift(
        shardUnits,
        merged.translations,
      );
      if (shift.witnesses >= SHIFT_MIN_WITNESSES) {
        signals.numericShiftShards += 1;
        diagnostics.push({
          code: "TRANSLATION_NUMERIC_SHIFT",
          severity: "warning",
          shardId: shard.shardId,
          message: `Possible slot shift in shard "${shard.shardId}" (${shift.witnesses} shifted numbers: ${shift.examples.join(", ")})`,
        });
      }
    }

    for (const unit of activeUnits) {
      const translated = merged.translations[unit.id];
      if (typeof translated !== "string" || !translated.trim()) {
        signals.missingUnits += 1;
        diagnostics.push({
          code: "TRANSLATION_UNIT_MISSING",
          severity: "error",
          unitId: unit.id,
          message: `Missing or blank translation for unit "${unit.id}"`,
        });
        continue;
      }
      const rec = reconcileMarkers(
        unit.sourceText,
        translated,
        unit.markers.map((m) => m.token),
      );
      if (rec.missing.length > 0 || rec.invented.length > 0) {
        signals.markerIssues += 1;
        diagnostics.push({
          code:
            rec.missing.length > 0
              ? "TRANSLATION_MARKER_MISSING"
              : "TRANSLATION_MARKER_INVENTED",
          severity: "warning",
          unitId: unit.id,
          message: `Unit "${unit.id}" marker drift (missing: ${rec.missing.join(", ") || "none"}; invented: ${rec.invented.join(", ") || "none"})`,
        });
      }
      if (
        differentLang &&
        countLetterChars(unit.sourceText) >= 12 &&
        translated.replace(/\s+/gu, " ").trim() ===
          unit.sourceText.replace(/\s+/gu, " ").trim()
      ) {
        signals.echoSuspects += 1;
        diagnostics.push({
          code: "TRANSLATION_ECHO_SUSPECT",
          severity: "warning",
          unitId: unit.id,
          message: `Unit "${unit.id}" translation is byte-identical to source text`,
        });
      }
      if (checkTargetScriptMismatch(plan.targetLanguage, translated)) {
        signals.scriptMismatches += 1;
        diagnostics.push({
          code: "TRANSLATION_SCRIPT_MISMATCH",
          severity: "warning",
          unitId: unit.id,
          message: `Unit "${unit.id}" translation lacks expected script for target language "${plan.targetLanguage}"`,
        });
      }
      if (glossary) {
        const lowerSource = unit.sourceText.toLowerCase();
        const lowerTarget = translated.toLowerCase();
        for (const term of glossary.terms) {
          if (
            lowerSource.includes(term.source.toLowerCase()) &&
            !lowerTarget.includes(term.target.toLowerCase())
          ) {
            signals.glossaryDrifts += 1;
            diagnostics.push({
              code: "TRANSLATION_GLOSSARY_DRIFT",
              severity: "warning",
              unitId: unit.id,
              message: `Unit "${unit.id}" contains glossary term "${term.source}" without expected target "${term.target}"`,
            });
          }
        }
      }
    }
  } else {
    for (const shard of merged.shards) {
      for (const unitId of shard.unitIds) {
        if (!merged.translations[unitId]?.trim()) {
          signals.missingUnits += 1;
          diagnostics.push({
            code: "TRANSLATION_UNIT_MISSING",
            severity: "error",
            shardId: shard.shardId,
            unitId,
            message: `Missing or blank translation for unit "${unitId}"`,
          });
        }
      }
    }
  }

  if (verification) {
    diagnostics.push(...verifyTranslationRecords(merged, verification));
  } else {
    for (const shard of merged.shards) {
      if (shard.unresolved.length > 0) {
        diagnostics.push({
          code: "TRANSLATION_UNRESOLVED_ITEMS",
          severity: "error",
          shardId: shard.shardId,
          message: `Shard "${shard.shardId}" has ${shard.unresolved.length} unresolved item(s)`,
        });
      }
    }
  }

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  return {
    status: hasErrors ? "fail" : "pass",
    operation: "epub-translate-check",
    sourceSha256: merged.sourceSha256,
    planSha256: merged.planSha256,
    shardCount: merged.shards.length,
    unitCount: Object.keys(merged.translations).length,
    signals,
    diagnostics,
  };
}
