import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  auditSeries,
  applySeries,
  normalizeSeries,
} from "../packages/core/src/series-file.js";
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
const decision = {
  relation: "story-continuity" as const,
  series: "銀河三部曲（全3册）",
  position: "1.5",
  sources: ["book:copyright-page and contents"],
  evidence: [
    "This volume is a real narrative subseries within the marketing omnibus.",
  ],
  positionEvidence: "Contents place this interlude between volumes 1 and 2.",
};
async function fixture(legacy = false) {
  const root = await copyBook();
  temporary.push(root);
  const info = inspectBytes(
    legacy
      ? await fs.readFile(path.join(repoRoot, "examples/repair/legacy.epub"))
      : await candidate(root),
  );
  const meta = elements(info.packageDocument, "metadata", NS.opf)[0];
  const add = (attributes: Record<string, string>, value = "") => {
    const node = info.packageDocument.createElementNS(NS.opf, "meta");
    for (const [key, item] of Object.entries(attributes))
      node.setAttribute(key, item);
    node.textContent = value;
    meta.appendChild(node);
  };
  add({ name: "calibre:series", content: "作者全集（全8册）" });
  add({ name: "calibre:series_index", content: "4" });
  add({ name: "calibre:rating", content: "0" });
  if (!legacy) {
    add(
      { property: "belongs-to-collection", id: "story-series" },
      "銀河三部曲 全3册",
    );
    add({ property: "collection-type", refines: "#story-series" }, "series");
    add({ property: "group-position", refines: "#story-series" }, "1.5");
    add({ property: "belongs-to-collection", id: "publisher-set" }, "出版文庫");
    add({ property: "collection-type", refines: "#publisher-set" }, "set");
  }
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  return { root, bytes: pack(entries, 946684800) };
}
function planned(bytes: Buffer, format: "epub" | "cbz") {
  const plan = auditSeries(bytes, format, { modified: "2026-10-08T00:00:00Z" });
  plan.decision = decision;
  plan.conflictResolution =
    "The publisher identifies the narrative subseries; author omnibus and its numbering are marketing metadata.";
  return plan;
}
function comic() {
  return packArchive(
    new Map([
      ["page.jpg", Buffer.from("preserved image")],
      [
        "ComicInfo.xml",
        Buffer.from(
          "<ComicInfo><Title>Book title</Title><Series>作者全集（全10册）</Series><Number>3</Number><Count>10</Count><Volume>2020</Volume><Summary>Keep description.</Summary><AgeRating>Teen</AgeRating><CommunityRating>0</CommunityRating></ComicInfo>",
        ),
      ],
    ]),
    946684800,
  );
}
it("synchronizes selected EPUB collection and Calibre compatibility fields without touching publisher sets, scores or book content", async () => {
  const { bytes } = await fixture(),
    plan = planned(bytes, "epub"),
    before = inspectBytes(bytes);
  const result = applySeries(bytes, plan),
    after = inspectBytes(result.bytes, true),
    meta = elements(after.packageDocument, "meta", NS.opf);
  expect(
    meta.find((node) => attr(node, "id") === "story-series")?.textContent,
  ).toBe("銀河三部曲");
  expect(
    meta
      .find((node) => attr(node, "name") === "calibre:series")
      ?.getAttribute("content"),
  ).toBe("銀河三部曲");
  expect(
    meta
      .find((node) => attr(node, "name") === "calibre:series_index")
      ?.getAttribute("content"),
  ).toBe("1.5");
  expect(
    meta
      .find((node) => attr(node, "name") === "calibre:rating")
      ?.getAttribute("content"),
  ).toBe("0");
  expect(
    meta.find((node) => attr(node, "id") === "publisher-set")?.textContent,
  ).toBe("出版文庫");
  for (const field of [
    "title",
    "identifier",
    "description",
    "subject",
    "creator",
  ])
    expect(
      elements(after.packageDocument, field, NS.dc).map(serialize),
    ).toEqual(elements(before.packageDocument, field, NS.dc).map(serialize));
  for (const [name, entry] of before.entries)
    if (name !== before.packagePath)
      expect(after.entries.get(name)?.bytes).toEqual(entry.bytes);
  expect(result.report.after).toEqual({
    series: "銀河三部曲",
    position: "1.5",
  });
  expect(
    applySeries(result.bytes, planned(result.bytes, "epub")).bytes,
  ).toEqual(result.bytes);
});
it("requires decisions for conflicting or unclassified representations and refuses stale plans", async () => {
  const { bytes } = await fixture();
  const plan = planned(bytes, "epub");
  plan.conflictResolution = null;
  expect(() => applySeries(bytes, plan)).toThrow(/conflict/i);
  expect(() => applySeries(bytes, { ...plan, decision: null })).toThrow(
    /decision/i,
  );
  expect(() =>
    applySeries(bytes, {
      ...planned(bytes, "epub"),
      sourceSha256: "0".repeat(64),
    }),
  ).toThrow(/hash|source/i);
  const info = inspectBytes(bytes);
  elements(info.packageDocument, "meta", NS.opf).find(
    (node) =>
      attr(node, "refines") === "#story-series" &&
      attr(node, "property") === "collection-type",
  )!.textContent = "";
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  const ambiguous = pack(entries, 946684800),
    ambiguousPlan = planned(ambiguous, "epub");
  expect(() => applySeries(ambiguous, ambiguousPlan)).toThrow(
    /classif|collection/i,
  );
  ambiguousPlan.collectionDecisions.push({
    key: ambiguousPlan.collections.find((item) => item.id === "story-series")!
      .key,
    action: "normalize",
    evidence: "Inspected source confirms this collection is the story series.",
  });
  expect(applySeries(ambiguous, ambiguousPlan).report.after.series).toBe(
    "銀河三部曲",
  );
});

it("requires an explanation before clearing a present position on a retained story series", async () => {
  const { bytes } = await fixture(),
    plan = planned(bytes, "epub");
  plan.decision = { ...decision, position: null, positionEvidence: null };
  expect(() => applySeries(bytes, plan)).toThrow(/position/i);
  plan.decision.positionEvidence =
    "The old indexes refer to the unrelated omnibus; the source explicitly identifies this story as unnumbered.";
  expect(applySeries(bytes, plan).report.after.position).toBeNull();
});
it("clears CBZ non-story series and order while preserving Count, Volume, AgeRating, ratings and pages", () => {
  const bytes = comic(),
    plan = planned(bytes, "cbz");
  plan.decision = {
    ...decision,
    relation: "nonfiction-multivolume",
    series: null,
    position: null,
    positionEvidence: null,
  };
  const output = applySeries(bytes, plan),
    entries = unpack(output.bytes),
    document = xml(entries.get("ComicInfo.xml")!.bytes.toString());
  expect(elements(document, "Series")).toHaveLength(0);
  expect(elements(document, "Number")).toHaveLength(0);
  expect(elements(document, "Count")[0].textContent).toBe("10");
  expect(elements(document, "Volume")[0].textContent).toBe("2020");
  expect(elements(document, "AgeRating")[0].textContent).toBe("Teen");
  expect(elements(document, "CommunityRating")[0].textContent).toBe("0");
  expect(entries.get("page.jpg")!.bytes).toEqual(
    unpack(bytes).get("page.jpg")!.bytes,
  );
});

it("clears EPUB story representations while retaining an unrelated set and adds a new unnumbered series without inventing a position", async () => {
  const { bytes } = await fixture(),
    plan = planned(bytes, "epub");
  plan.decision = {
    ...decision,
    relation: "author-collection",
    series: null,
    position: null,
    positionEvidence: null,
  };
  const cleared = applySeries(bytes, plan),
    info = inspectBytes(cleared.bytes);
  const meta = elements(info.packageDocument, "meta", NS.opf);
  expect(
    meta.some((node) => attr(node, "name").startsWith("calibre:series")),
  ).toBe(false);
  expect(meta.some((node) => attr(node, "id") === "story-series")).toBe(false);
  expect(
    meta.find((node) => attr(node, "id") === "publisher-set")?.textContent,
  ).toBe("出版文庫");
  const addition = planned(cleared.bytes, "epub");
  addition.decision = { ...decision, position: null, positionEvidence: null };
  const added = inspectBytes(applySeries(cleared.bytes, addition).bytes);
  expect(
    elements(added.packageDocument, "meta", NS.opf).filter(
      (node) => attr(node, "property") === "group-position",
    ),
  ).toHaveLength(0);
  expect(
    elements(added.packageDocument, "meta", NS.opf)
      .filter((node) => attr(node, "property") === "belongs-to-collection")
      .map((node) => node.textContent),
  ).toEqual(["出版文庫", "銀河三部曲"]);
});
it.each([false, true])(
  "delivers actual format-validated EPUB series edits with legacy=%s and retains source files",
  async (legacy) => {
    const { root, bytes } = await fixture(legacy),
      source = path.join(root, "source.epub"),
      output = path.join(root, "series.epub");
    await fs.writeFile(source, bytes);
    const result = await normalizeSeries(source, {
      plan: planned(bytes, "epub"),
      output,
    });
    expect(result.validation.status).toBe("pass");
    expect(await fs.readFile(source)).toEqual(bytes);
    expect(inspectBytes(await fs.readFile(output)).version).toBe(
      legacy ? "2.0" : "3.0",
    );
    await expect(
      normalizeSeries(source, { plan: planned(bytes, "epub"), output }),
    ).rejects.toThrow(/exist/i);
  },
);
it("runs actual CBZ audit/apply CLI and validates the corrected ComicInfo", async () => {
  const { root } = await fixture(),
    source = path.join(root, "source.cbz"),
    output = path.join(root, "series.cbz"),
    planFile = path.join(root, "series.json");
  await fs.writeFile(source, comic());
  const cli = path.join(repoRoot, "packages/cli/src/index.ts");
  const audit = await run(process.execPath, [
    "--import",
    "tsx",
    cli,
    "metadata",
    "series-audit",
    source,
    "--output",
    planFile,
    "--json",
  ]);
  expect(audit.exitCode, audit.stdout + audit.stderr).toBe(0);
  const plan = JSON.parse(await fs.readFile(planFile, "utf8"));
  plan.decision = {
    ...decision,
    relation: "shared-protagonist-world",
    evidence: [
      "The same recurring detective and story world link these independent cases.",
    ],
  };
  await fs.writeFile(planFile, JSON.stringify(plan));
  const result = await run(process.execPath, [
    "--import",
    "tsx",
    cli,
    "metadata",
    "series-normalize",
    source,
    "--plan",
    planFile,
    "--output",
    output,
    "--json",
  ]);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  const document = xml(
    unpack(await fs.readFile(output))
      .get("ComicInfo.xml")!
      .bytes.toString(),
  );
  expect(elements(document, "Series")[0].textContent).toBe("銀河三部曲");
  expect(elements(document, "Number")[0].textContent).toBe("1.5");
});

it.each(["epub2", "epub3", "cbz"] as const)(
  "normalizes evidenced Roman positions to Arabic digits in %s without changing title numerals",
  async (kind) => {
    const { root, bytes: initial } = await fixture(kind === "epub2");
    const format = kind === "cbz" ? "cbz" : "epub";
    const title = "銀河三部曲 II — 終章";
    let bytes: Buffer;
    if (kind === "cbz") {
      const entries = new Map(
        [...unpack(comic())].map(([name, entry]) => [name, entry.bytes]),
      );
      entries.set(
        "ComicInfo.xml",
        Buffer.from(
          entries
            .get("ComicInfo.xml")!
            .toString()
            .replace("Book title", title)
            .replace("<Number>3</Number>", "<Number>II</Number>"),
        ),
      );
      bytes = packArchive(entries, 946684800);
    } else {
      const info = inspectBytes(initial);
      elements(info.packageDocument, "title", NS.dc)[0].textContent = title;
      for (const node of elements(info.packageDocument, "meta", NS.opf)) {
        if (attr(node, "name") === "calibre:series_index")
          node.setAttribute("content", "II");
        if (attr(node, "property") === "group-position") node.textContent = "Ⅱ";
      }
      const entries = new Map(
        [...info.entries].map(([name, entry]) => [name, entry.bytes]),
      );
      entries.set(
        info.packagePath,
        Buffer.from(serialize(info.packageDocument)),
      );
      bytes = pack(entries, 946684800);
    }
    const plan = planned(bytes, format);
    plan.decision = {
      ...decision,
      position: "2",
      positionEvidence:
        "The selected edition identifies this as volume II (2); only the series position is normalized.",
    };
    const source = path.join(root, `roman.${format}`);
    const output = path.join(root, `arabic.${format}`);
    await fs.writeFile(source, bytes);
    const result = await normalizeSeries(source, { plan, output });
    expect(result.validation.status).toBe("pass");
    expect(await fs.readFile(source)).toEqual(bytes);
    const delivered = await fs.readFile(output);
    const readback = auditSeries(delivered, format);
    expect(readback.before.positions).toEqual(["2"]);
    if (kind === "epub3")
      expect(
        readback.collections.find((c) => c.types.includes("series"))?.positions,
      ).toEqual(["2"]);
    const document =
      kind === "cbz"
        ? xml(unpack(delivered).get("ComicInfo.xml")!.bytes.toString())
        : inspectBytes(delivered).packageDocument;
    expect(
      elements(document, kind === "cbz" ? "Title" : "title")[0].textContent,
    ).toBe(title);
    const before = unpack(bytes),
      after = unpack(delivered);
    const target =
      kind === "cbz" ? "ComicInfo.xml" : inspectBytes(bytes).packagePath;
    for (const [name, entry] of before)
      if (name !== target) expect(after.get(name)?.bytes).toEqual(entry.bytes);
  },
);
