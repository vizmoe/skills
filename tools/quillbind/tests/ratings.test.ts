import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  auditRatings,
  applyRatings,
  cleanRatings,
} from "../packages/core/src/ratings.js";
import { candidate, copyBook } from "./helpers.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { pack, packArchive, unpack } from "../packages/core/src/zip.js";
import {
  attr,
  elements,
  NS,
  serialize,
  xml,
} from "../packages/core/src/xml.js";
import { sha256 } from "../packages/core/src/hash.js";
import { run } from "../packages/core/src/process.js";
import { repoRoot } from "../packages/core/src/runtime.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
const modified = "2026-10-08T00:00:00Z";
async function epub() {
  const root = await copyBook();
  temporary.push(root);
  const info = inspectBytes(await candidate(root));
  const metadata = elements(info.packageDocument, "metadata", NS.opf)[0];
  for (const [name, content] of [
    ["calibre:rating", "0"],
    [
      "calibre:user_metadata:#stars",
      JSON.stringify({ datatype: "rating", "#value#": 0 }),
    ],
    [
      "calibre:user_metadata:#shelf",
      JSON.stringify({ datatype: "text", "#value#": "five-star reviews" }),
    ],
    ["review:score", "9.5"],
    ["audience:AgeRating", "Teen"],
  ]) {
    const node = info.packageDocument.createElementNS(NS.opf, "meta");
    node.setAttribute("name", name);
    node.setAttribute("content", content);
    metadata.appendChild(node);
  }
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  return { root, bytes: pack(entries, 946684800) };
}
function cbz(extra = "") {
  return packArchive(
    new Map([
      ["01.jpg", Buffer.from("original page bytes")],
      [
        "ComicInfo.xml",
        Buffer.from(
          `<ComicInfo><!--keep--><Title>評分的故事</Title><Summary>評論：五星佳作。</Summary><PageCount>1</PageCount><Manga>YesAndRightToLeft</Manga><AgeRating>Teen</AgeRating><Pages><Page Image="0" Bookmark="keep"/></Pages><CommunityRating>0</CommunityRating><Review>My opinion</Review>${extra}</ComicInfo>`,
        ),
      ],
      ["other.xml", Buffer.from("<scores>5</scores>")],
    ]),
    946684800,
  );
}
function reviewed(bytes: Buffer, format: "epub" | "cbz") {
  const plan = auditRatings(bytes, format, { modified });
  plan.reviewed = true;
  return plan;
}

it("removes zero, typed custom and explicitly identified scores without altering other EPUB metadata or resources", async () => {
  const { bytes } = await epub();
  const plan = reviewed(bytes, "epub");
  const score = plan.inventory.find((row) => row.label === "review:score")!;
  plan.customScores.push({
    key: score.key,
    evidence: "Publisher review score field, not age classification",
  });
  const output = applyRatings(bytes, plan);
  expect(output.report.removed).toHaveLength(3);
  const before = inspectBytes(bytes),
    after = inspectBytes(output.bytes, true);
  const fields = elements(after.packageDocument, "meta", NS.opf);
  expect(fields.some((node) => attr(node, "name") === "calibre:rating")).toBe(
    false,
  );
  expect(
    fields
      .find((node) => attr(node, "name") === "audience:AgeRating")
      ?.getAttribute("content"),
  ).toBe("Teen");
  expect(
    fields
      .find((node) => attr(node, "name").endsWith("#shelf"))
      ?.getAttribute("content"),
  ).toContain("five-star reviews");
  expect(
    elements(after.packageDocument, "identifier", NS.dc).map(serialize),
  ).toEqual(
    elements(before.packageDocument, "identifier", NS.dc).map(serialize),
  );
  for (const [name, entry] of before.entries)
    if (name !== before.packagePath) {
      expect(after.entries.get(name)?.bytes).toEqual(entry.bytes);
      expect(after.entries.get(name)?.method).toBe(entry.method);
    }
  expect(
    applyRatings(output.bytes, reviewed(output.bytes, "epub")).bytes,
  ).toEqual(output.bytes);
});

it("requires inventory review and explicit disposition of ambiguous custom scores", async () => {
  const { bytes } = await epub();
  const plan = auditRatings(bytes, "epub", { modified });
  expect(() => applyRatings(bytes, plan)).toThrow(/review/i);
  plan.reviewed = true;
  expect(() => applyRatings(bytes, plan)).toThrow(/unresolved/i);
  const score = plan.inventory.find((row) => row.label === "review:score")!;
  plan.retain.push({
    key: score.key,
    evidence:
      "This field identifies a musical score catalogue entry, not a review rating",
  });
  expect(applyRatings(bytes, plan).report.retained).toHaveLength(1);
  plan.customScores.push({
    key: plan.inventory.find((row) => row.label === "audience:AgeRating")!.key,
    evidence: "wrong selection",
  });
  expect(() => applyRatings(bytes, plan)).toThrow(/protected/i);
});

it("preserves explicitly named age classifications even when a custom column declares the rating datatype", async () => {
  const { bytes } = await epub();
  const info = inspectBytes(bytes);
  const metadata = elements(info.packageDocument, "metadata", NS.opf)[0];
  const node = info.packageDocument.createElementNS(NS.opf, "meta");
  node.setAttribute("name", "calibre:user_metadata:#age_rating");
  node.setAttribute(
    "content",
    JSON.stringify({ datatype: "rating", "#value#": 5 }),
  );
  metadata.appendChild(node);
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  const source = pack(entries, 946684800),
    plan = reviewed(source, "epub");
  plan.customScores.push({
    key: plan.inventory.find((row) => row.label === "review:score")!.key,
    evidence: "Reviewer score",
  });
  expect(
    inspectBytes(applyRatings(source, plan).bytes)
      .entries.get(info.packagePath)!
      .bytes.toString(),
  ).toContain("calibre:user_metadata:#age_rating");
});

it("removes linked score refinements, preserves EPUB 2, and rejects altered plans and signatures", async () => {
  const { bytes } = await epub();
  const info = inspectBytes(bytes),
    metadata = elements(info.packageDocument, "metadata", NS.opf)[0];
  const score = elements(metadata, "meta", NS.opf).find(
    (node) => attr(node, "name") === "calibre:rating",
  )!;
  score.setAttribute("id", "rating-record");
  const refinement = info.packageDocument.createElementNS(NS.opf, "meta");
  refinement.setAttribute("property", "file-as");
  refinement.setAttribute("refines", "#rating-record");
  refinement.textContent = "zero";
  metadata.appendChild(refinement);
  info.packageDocument.documentElement!.setAttribute("version", "2.0");
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  const source = pack(entries, 946684800),
    plan = reviewed(source, "epub");
  plan.customScores.push({
    key: plan.inventory.find((row) => row.label === "review:score")!.key,
    evidence: "Score",
  });
  const result = applyRatings(source, plan),
    after = inspectBytes(result.bytes);
  expect(after.version).toBe("2.0");
  expect(result.report.modified).toBeNull();
  expect(result.report.refinements).toHaveLength(1);
  expect(serialize(after.packageDocument)).not.toContain(
    'refines="#rating-record"',
  );
  expect(() =>
    applyRatings(source, { ...plan, modified: "2026-02-30T00:00:00Z" }),
  ).toThrow(/plan/i);
  expect(() => applyRatings(source, { ...plan, inventory: [] })).toThrow(
    /inventory/i,
  );
  entries.set("META-INF/signatures.xml", Buffer.from("<signatures/>"));
  expect(() => auditRatings(pack(entries, 946684800), "epub")).toThrow(
    /protected/i,
  );
});

it("preserves CBZ age classification, comments, review text, page metadata, archive order and every other member", () => {
  const bytes = cbz("<PersonalScore>4</PersonalScore>");
  const plan = reviewed(bytes, "cbz");
  plan.customScores.push({
    key: plan.inventory.find((row) => row.label === "PersonalScore")!.key,
    evidence: "Reader's custom star score",
  });
  const result = applyRatings(bytes, plan),
    before = unpack(bytes),
    after = unpack(result.bytes);
  expect([...after.keys()]).toEqual([...before.keys()]);
  for (const [name, entry] of before)
    if (name !== "ComicInfo.xml")
      expect(after.get(name)?.bytes).toEqual(entry.bytes);
  const text = after.get("ComicInfo.xml")!.bytes.toString();
  expect(text).not.toContain("CommunityRating");
  expect(text).not.toContain("PersonalScore");
  for (const retained of [
    "<!--keep-->",
    "<AgeRating>Teen</AgeRating>",
    "評論：五星佳作。",
    'Bookmark="keep"',
    "<Review>My opinion</Review>",
  ])
    expect(text).toContain(retained);
  expect(result.report.removed).toHaveLength(2);
  expect(
    applyRatings(result.bytes, reviewed(result.bytes, "cbz")).bytes,
  ).toEqual(result.bytes);
});

it("rejects stale plans, unsafe archives, metadata ambiguity, malformed XML and protected field selections", () => {
  const bytes = cbz(),
    plan = reviewed(bytes, "cbz");
  expect(() => applyRatings(cbz("<Notes>changed</Notes>"), plan)).toThrow(
    /hash|source/i,
  );
  plan.customScores.push({
    key: plan.inventory.find((row) => row.label === "AgeRating")!.key,
    evidence: "wrong",
  });
  expect(() => applyRatings(bytes, plan)).toThrow(/protected/i);
  for (const entries of [
    new Map([["nested/ComicInfo.xml", Buffer.from("<ComicInfo/>")]]),
    new Map([
      [
        "ComicInfo.xml",
        Buffer.from(
          "<ComicInfo><AgeRating>Teen</AgeRating><AgeRating>G</AgeRating></ComicInfo>",
        ),
      ],
    ]),
    new Map([
      [
        "ComicInfo.xml",
        Buffer.from(
          '<!DOCTYPE ComicInfo SYSTEM "file:///etc/passwd"><ComicInfo/>',
        ),
      ],
    ]),
  ])
    expect(() =>
      auditRatings(packArchive(entries, 946684800), "cbz"),
    ).toThrow();
});

it.each(["epub", "cbz"] as const)(
  "validates the actual staged %s with format tools and refuses replacement",
  async (format) => {
    const sample = await epub();
    const bytes = format === "epub" ? sample.bytes : cbz();
    const plan = reviewed(bytes, format);
    if (format === "epub")
      plan.customScores.push({
        key: plan.inventory.find((row) => row.label === "review:score")!.key,
        evidence: "Review score",
      });
    const source = path.join(sample.root, `original.${format}`),
      output = path.join(sample.root, `clean.${format}`);
    await fs.writeFile(source, bytes);
    const result = await cleanRatings(source, { plan, output });
    expect(result.status).toBe("pass");
    expect(result.validation.status).toBe("pass");
    expect(result.sourceSha256).toBe(sha256(bytes));
    expect(await fs.readFile(source)).toEqual(bytes);
    expect(sha256(await fs.readFile(output))).toBe(result.outputSha256);
    await expect(cleanRatings(source, { plan, output })).rejects.toThrow(
      /exist/i,
    );
    await expect(
      cleanRatings(source, { plan, output: source }),
    ).rejects.toThrow(/exist|original/i);
  },
);

it("runs the real audit/apply CLI and leaves no output when ComicInfo validation fails", async () => {
  const { root } = await epub(),
    source = path.join(root, "source.cbz"),
    output = path.join(root, "clean.cbz"),
    planFile = path.join(root, "ratings.json");
  await fs.writeFile(source, cbz());
  const cli = path.join(repoRoot, "packages/cli/src/index.ts");
  const invalidOptions = await run(process.execPath, [
    "--import",
    "tsx",
    cli,
    "metadata",
    "ratings-audit",
    source,
    "--online",
    "--json",
  ]);
  expect(JSON.parse(invalidOptions.stdout).code).toBe("ARGUMENT_CONFLICT");
  const audited = await run(process.execPath, [
    "--import",
    "tsx",
    cli,
    "metadata",
    "ratings-audit",
    source,
    "--output",
    planFile,
    "--json",
  ]);
  expect(audited.exitCode, audited.stdout + audited.stderr).toBe(0);
  const plan = JSON.parse(await fs.readFile(planFile, "utf8"));
  plan.reviewed = true;
  await fs.writeFile(planFile, JSON.stringify(plan));
  const applied = await run(process.execPath, [
    "--import",
    "tsx",
    cli,
    "metadata",
    "ratings-clean",
    source,
    "--plan",
    planFile,
    "--output",
    output,
    "--json",
  ]);
  expect(applied.exitCode, applied.stdout + applied.stderr).toBe(0);
  expect(JSON.parse(applied.stdout).status).toBe("pass");
  const invalid = cbz("<Unsupported>keep</Unsupported>");
  await fs.writeFile(source, invalid);
  const bad = path.join(root, "invalid.cbz");
  await expect(
    cleanRatings(source, { plan: reviewed(invalid, "cbz"), output: bad }),
  ).rejects.toThrow(/valid/i);
  await expect(fs.lstat(bad)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    elements(
      xml(
        unpack(await fs.readFile(output))
          .get("ComicInfo.xml")!
          .bytes.toString(),
      ),
      "AgeRating",
    )[0].textContent,
  ).toBe("Teen");
});

it("validates an actual EPUB 2 cleanup without adding EPUB 3 modification metadata", async () => {
  const { root } = await epub();
  const info = inspectBytes(
    await fs.readFile(path.join(repoRoot, "examples/repair/legacy.epub")),
  );
  const metadata = elements(info.packageDocument, "metadata", NS.opf)[0],
    rating = info.packageDocument.createElementNS(NS.opf, "meta");
  rating.setAttribute("name", "calibre:rating");
  rating.setAttribute("content", "");
  metadata.appendChild(rating);
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  const bytes = pack(entries, 946684800),
    source = path.join(root, "old.epub"),
    output = path.join(root, "old-clean.epub");
  await fs.writeFile(source, bytes);
  const result = await cleanRatings(source, {
    plan: reviewed(bytes, "epub"),
    output,
  });
  expect(result.validation.status).toBe("pass");
  const actual = inspectBytes(await fs.readFile(output));
  expect(actual.version).toBe("2.0");
  expect(serialize(actual.packageDocument)).not.toContain("dcterms:modified");
  expect(serialize(actual.packageDocument)).not.toContain("calibre:rating");
});
