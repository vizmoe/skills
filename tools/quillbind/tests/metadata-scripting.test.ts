import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditRatings, applyRatings } from "../packages/core/src/ratings.js";
import { auditSeries, applySeries } from "../packages/core/src/series-file.js";
import { auditCover } from "../packages/core/src/covers.js";
import { auditSplit } from "../packages/core/src/split.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { validateInternal } from "../packages/core/src/validate.js";
import { elements, NS, serialize } from "../packages/core/src/xml.js";
import { run } from "../packages/core/src/process.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { sha256 } from "../packages/core/src/hash.js";
import { noteFixture } from "./note-fixture.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
function edit(
  entries: Map<string, Buffer>,
  name: string,
  from: string,
  to: string,
) {
  entries.set(
    name,
    Buffer.from(entries.get(name)!.toString().replace(from, to)),
  );
}
const packagePath = "OEBPS/package.opf";
function fixture(variant = "declared") {
  return noteFixture((entries) => {
    edit(
      entries,
      packagePath,
      "</metadata>",
      '<meta name="calibre:rating" content="0"/></metadata>',
    );
    if (variant === "inline" || variant === "handler") {
      edit(entries, packagePath, ' properties="scripted"', "");
      edit(
        entries,
        "OEBPS/chapter.xhtml",
        '<script src="notes.js"></script>',
        variant === "inline"
          ? '<script>throw new Error("Book script must stay inert");</script>'
          : "",
      );
      if (variant === "handler")
        edit(
          entries,
          "OEBPS/chapter.xhtml",
          "<body>",
          "<body onload=\"throw new Error('Book handler must stay inert')\">",
        );
    }
    if (variant === "unresolved") {
      edit(
        entries,
        "OEBPS/chapter.xhtml",
        'src="notes.js"',
        'src="https://example.invalid/notes.js"',
      );
      edit(entries, "OEBPS/chapter.xhtml", 'href="#note"', 'href="#missing"');
    }
  });
}
const decision = {
  relation: "story-continuity" as const,
  series: "Example story",
  position: "2",
  sources: ["book:series-page"],
  evidence: ["The source identifies this volume as part of the story series."],
  positionEvidence: "The series page explicitly numbers this volume 2.",
};
function expectPreserved(source: Buffer, output: Buffer) {
  const before = inspectBytes(source),
    after = inspectBytes(output, true);
  expect([...after.entries.keys()]).toEqual([...before.entries.keys()]);
  for (const [name, entry] of before.entries)
    if (name !== before.packagePath) {
      expect(after.entries.get(name)?.bytes, name).toEqual(entry.bytes);
      expect(after.entries.get(name)?.method, name).toBe(entry.method);
    }
  for (const name of ["manifest", "spine"])
    expect(
      elements(after.packageDocument, name, NS.opf).map(serialize),
    ).toEqual(elements(before.packageDocument, name, NS.opf).map(serialize));
  for (const name of ["identifier", "title", "language"])
    expect(elements(after.packageDocument, name, NS.dc).map(serialize)).toEqual(
      elements(before.packageDocument, name, NS.dc).map(serialize),
    );
}

it.each(["declared", "inline", "handler", "unresolved"])(
  "edits ratings and series on %s scripting while preserving content and declarations",
  (variant) => {
    const source = fixture(variant),
      original = Buffer.from(source);
    expect(inspectBytes(source).unsupported).toContain("interactive-content");
    const ratings = auditRatings(source, "epub");
    ratings.reviewed = true;
    const cleaned = applyRatings(source, ratings).bytes;
    expect(
      auditRatings(cleaned, "epub").inventory.filter(
        (row) => row.knownScore || row.suspectedScore,
      ),
    ).toHaveLength(0);
    expectPreserved(source, cleaned);
    const series = auditSeries(source, "epub");
    series.decision = decision;
    const normalized = applySeries(source, series).bytes;
    expect(auditSeries(normalized, "epub").collections).toEqual([
      expect.objectContaining({ name: decision.series, positions: ["2"] }),
    ]);
    expectPreserved(source, normalized);
    expect(source).toEqual(original);
  },
);

it.each(["fixed-layout", "multiple-renditions", "encryption", "signature"])(
  "still rejects %s together with scripting for metadata edits",
  (restriction) => {
    const source = noteFixture((entries) => {
      if (restriction === "fixed-layout")
        edit(
          entries,
          packagePath,
          "</metadata>",
          '<meta property="rendition:layout">pre-paginated</meta></metadata>',
        );
      if (restriction === "multiple-renditions")
        edit(
          entries,
          "META-INF/container.xml",
          "</rootfiles>",
          '<rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>',
        );
      if (restriction === "encryption")
        entries.set(
          "META-INF/encryption.xml",
          Buffer.from(
            '<encryption><EncryptionMethod Algorithm="unsupported-encryption"/></encryption>',
          ),
        );
      if (restriction === "signature")
        entries.set("META-INF/signatures.xml", Buffer.from("<signatures/>"));
    });
    expect(() => auditRatings(source, "epub")).toThrow(
      /unsupported|protected/i,
    );
    expect(() => auditSeries(source, "epub")).toThrow(/unsupported|protected/i);
  },
);

it("keeps content-changing cover, split and publication restrictions for scripted books", async () => {
  const source = fixture();
  await expect(auditCover(source, "epub")).rejects.toHaveProperty(
    "code",
    "METADATA_UNSUPPORTED",
  );
  await expect(auditSplit(source)).rejects.toHaveProperty(
    "code",
    "METADATA_UNSUPPORTED",
  );
  expect(validateInternal(source).diagnostics).toContainEqual(
    expect.objectContaining({
      code: "UNSUPPORTED_EPUB",
      message: "interactive-content",
    }),
  );
});

it.each(["ratings", "series", "invalid-script-declaration"])(
  "runs the actual %s maintenance CLI and EPUBCheck without executing book scripts",
  async (operation) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "quillbind-scripted-metadata-"),
    );
    temporary.push(root);
    const source = path.join(root, "source.epub"),
      output = path.join(root, "output.epub"),
      planFile = path.join(root, "plan.json");
    const bytes = fixture(
      operation === "invalid-script-declaration" ? "inline" : "declared",
    );
    await fs.writeFile(source, bytes);
    const cli = async (...args: string[]) =>
      run(process.execPath, [
        "--import",
        "tsx",
        path.join(repoRoot, "packages/cli/src/index.ts"),
        "metadata",
        ...args,
        "--json",
      ]);
    const kind = operation === "series" ? "series" : "ratings";
    const audited = await cli(`${kind}-audit`, source, "--output", planFile);
    expect(audited.exitCode, audited.stdout + audited.stderr).toBe(0);
    const plan = JSON.parse(await fs.readFile(planFile, "utf8"));
    if (kind === "ratings") plan.reviewed = true;
    else plan.decision = decision;
    await fs.writeFile(planFile, JSON.stringify(plan));
    const applied = await cli(
      kind === "ratings" ? "ratings-clean" : "series-normalize",
      source,
      "--plan",
      planFile,
      "--output",
      output,
    );
    expect(await fs.readFile(source)).toEqual(bytes);
    if (operation === "invalid-script-declaration") {
      expect(applied.exitCode).not.toBe(0);
      expect(JSON.parse(applied.stdout).code).toBe("METADATA_VALIDATION");
      await expect(fs.lstat(output)).rejects.toHaveProperty("code", "ENOENT");
      const check = JSON.parse(
        await fs.readFile(
          path.join(output + ".reports", "epubcheck.json"),
          "utf8",
        ),
      );
      expect(check.messages).toContainEqual(
        expect.objectContaining({ ID: "OPF-014" }),
      );
      return;
    }
    expect(applied.exitCode, applied.stdout + applied.stderr).toBe(0);
    const result = JSON.parse(applied.stdout),
      actual = await fs.readFile(output);
    expect(result).toMatchObject({
      status: "pass",
      purpose: "file-maintenance",
      sourceSha256: sha256(bytes),
      outputSha256: sha256(actual),
      validation: { status: "pass", epubcheck: { exitCode: 0 } },
    });
    expectPreserved(bytes, actual);
    if (kind === "ratings")
      expect(
        auditRatings(actual, "epub").inventory.filter(
          (row) => row.knownScore || row.suspectedScore,
        ),
      ).toHaveLength(0);
    else
      expect(auditSeries(actual, "epub").collections).toEqual([
        expect.objectContaining({ name: decision.series, positions: ["2"] }),
      ]);
    const report = JSON.parse(
      await fs.readFile(path.join(result.reports, "metadata.json"), "utf8"),
    );
    expect(report.outputSha256).toBe(sha256(actual));
  },
);
