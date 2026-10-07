import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import * as zip from "../packages/core/src/zip.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { describeInspection } from "../packages/core/src/inspection.js";
import { validateInternal } from "../packages/core/src/validate.js";
import { compatibilityLint } from "../packages/core/src/compatibility.js";
import { planFromBytes, auditEpub } from "../packages/core/src/repair.js";
import { repoRoot } from "../packages/core/src/runtime.js";

afterEach(() => vi.restoreAllMocks());

it("shares a read-only inspection across validation, lint, reporting and repair planning", async () => {
  const bytes = await fs.readFile(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  const unpack = vi.spyOn(zip, "unpack");
  const info = inspectBytes(bytes);
  const original = info.packageDocument.toString();
  validateInternal(info);
  await compatibilityLint(info, "apple-books");
  await compatibilityLint(info, "kindle");
  planFromBytes(info);
  describeInspection(info, bytes.length);
  expect(unpack).toHaveBeenCalledTimes(1);
  expect(info.packageDocument.toString()).toBe(original);
});

it("audits an EPUB with one unpack and retains a strictly checked repair plan", async () => {
  const unpack = vi.spyOn(zip, "unpack");
  const audit = await auditEpub(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  expect(audit.status).toBe("audited");
  expect(
    audit.plan.actions.some((action) => action.ruleId === "navigation"),
  ).toBe(true);
  expect(unpack).toHaveBeenCalledTimes(1);
});

it("does not let a permissive inspection bypass strict OCF validation", async () => {
  const source = await fs.readFile(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  const entries = new Map(
    [...inspectBytes(source).entries].map(([name, entry]) => [
      name,
      entry.bytes,
    ]),
  );
  entries.set("mimetype", Buffer.from("application/epub+ziP"));
  const bytes = zip.pack(entries, 946684800);
  const unpack = vi.spyOn(zip, "unpack");
  const info = inspectBytes(bytes);
  expect(validateInternal(info).diagnostics[0].code).toBe("OCF_MIMETYPE");
  expect(planFromBytes(info).actions).toContainEqual(
    expect.objectContaining({
      ruleId: "ocf-packaging",
      classification: "safe",
    }),
  );
  expect(unpack).toHaveBeenCalledTimes(1);
  expect(() => inspectBytes(bytes, true)).toThrow();
});
