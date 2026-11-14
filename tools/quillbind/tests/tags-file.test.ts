import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyFileTags,
  applyTags,
  auditFileTags,
  auditTags,
  comicSequence,
} from "../packages/core/src/tags-file.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { run } from "../packages/core/src/process.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import {
  attr,
  elements,
  NS,
  serialize,
  xml,
} from "../packages/core/src/xml.js";
import { pack, packArchive, unpack } from "../packages/core/src/zip.js";
import { candidate, copyBook } from "./helpers.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const modified = "2026-11-14T00:00:00Z";

async function epubFixture(
  edit?: (document: Document, metadata: Element) => void,
  legacy = false,
) {
  const root = await copyBook();
  temporary.push(root);
  const info = inspectBytes(
    legacy
      ? await fs.readFile(path.join(repoRoot, "examples/repair/legacy.epub"))
      : await candidate(root),
  );
  const metadata = elements(info.packageDocument, "metadata", NS.opf)[0];
  edit?.(
    info.packageDocument as unknown as Document,
    metadata as unknown as Element,
  );
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  return { root, bytes: pack(entries, 946684800) };
}

function cbzFixture(comicXml: string) {
  return packArchive(
    new Map([
      ["001.jpg", Buffer.from("preserved scan image")],
      ["ComicInfo.xml", Buffer.from(comicXml)],
    ]),
    946684800,
  );
}

describe("controlled file-level tag audit and application", () => {
  it("normalizes EPUB 3 and EPUB 2 subjects, guards refinements/references, and preserves all other members", async () => {
    const { bytes } = await epubFixture((doc, meta) => {
      for (const existing of Array.from(
        meta.getElementsByTagNameNS(NS.dc, "subject"),
      ))
        meta.removeChild(existing);
      const addSub = (val: string, id?: string) => {
        const node = doc.createElementNS(NS.dc, "dc:subject");
        node.textContent = val;
        if (id) node.setAttribute("id", id);
        meta.appendChild(node);
      };
      addSub("Light Novel", "sub-alias");
      const ref = doc.createElementNS(NS.opf, "meta");
      ref.setAttribute("refines", "#sub-alias");
      ref.setAttribute("property", "authority");
      ref.textContent = "LCC";
      meta.appendChild(ref);

      addSub("Literature.Fantasy", "sub-keep");
      const keepRef = doc.createElementNS(NS.opf, "meta");
      keepRef.setAttribute("refines", "#sub-keep");
      keepRef.setAttribute("property", "term");
      keepRef.textContent = "F01";
      meta.appendChild(keepRef);

      addSub("Literature.Manga");
      addSub("未知自由标签");
    });

    const plan = await auditTags(bytes, "epub", {
      modified,
      decision: {
        kind: "light-novel",
        add: ["Literature.Mystery"],
        remove: ["未知自由标签"],
        evidence: ["BookWalker JP confirms light-novel mystery volume."],
      },
    });
    expect(plan.proposed).toEqual([
      "Literature.Light Novel",
      "Literature.Fantasy",
      "Literature.Mystery",
    ]);
    expect(plan.unresolved).toEqual([]);

    // Unreviewed plan rejected
    await expect(applyTags(bytes, plan)).rejects.toMatchObject({
      code: "TAGS_REVIEW",
    });

    // Replaced subject with attached refinement requires explicit refinementDecisions
    plan.reviewed = true;
    await expect(applyTags(bytes, plan)).rejects.toMatchObject({
      code: "TAGS_REFINEMENT",
    });

    plan.refinementDecisions = [
      {
        key: "subject/0",
        action: "drop-refinements",
        evidence:
          "Stale LCC authority on Chinese alias dropped for custom library taxonomy.",
      },
    ];
    const applied = await applyTags(bytes, plan);
    expect(applied.report.changed).toBe(true);
    expect(applied.report.after).toEqual([
      "Literature.Light Novel",
      "Literature.Fantasy",
      "Literature.Mystery",
    ]);

    const after = inspectBytes(applied.bytes, true);
    expect(
      elements(after.packageDocument, "subject", NS.dc).map(
        (n) => n.textContent,
      ),
    ).toEqual([
      "Literature.Light Novel",
      "Literature.Fantasy",
      "Literature.Mystery",
    ]);
    // Kept subject preserved its id and refinement; replaced subject dropped its refinement
    const metas = elements(after.packageDocument, "meta", NS.opf);
    expect(metas.some((m) => attr(m, "refines") === "#sub-keep")).toBe(true);
    expect(metas.some((m) => attr(m, "refines") === "#sub-alias")).toBe(false);

    // Idempotent re-apply produces unchanged bytes
    const secondPlan = await auditTags(applied.bytes, "epub", { modified });
    secondPlan.reviewed = true;
    const secondApplied = await applyTags(applied.bytes, secondPlan);
    expect(secondApplied.report.changed).toBe(false);
    expect(secondApplied.bytes.equals(applied.bytes)).toBe(true);

    // External link reference to removed subject blocks edit
    const extBook = await epubFixture((doc, meta) => {
      const s = doc.createElementNS(NS.dc, "dc:subject");
      s.setAttribute("id", "ext-sub");
      s.textContent = "BadTag";
      meta.appendChild(s);
      const link = doc.createElementNS(NS.opf, "link");
      link.setAttribute("refines", "#ext-sub");
      link.setAttribute("rel", "record");
      link.setAttribute("href", "https://example.com/rec");
      meta.appendChild(link);
    });
    const extPlan = await auditTags(extBook.bytes, "epub", {
      modified,
      decision: {
        add: ["Literature.Fiction"],
        remove: ["BadTag"],
        evidence: ["Replace bad tag."],
      },
    });
    extPlan.reviewed = true;
    await expect(applyTags(extBook.bytes, extPlan)).rejects.toMatchObject({
      code: "TAGS_REFERENCE",
    });

    // EPUB 2 preserves version 2.0 without adding dcterms:modified
    const epub2 = await epubFixture((doc, meta) => {
      for (const existing of Array.from(
        meta.getElementsByTagNameNS(NS.dc, "subject"),
      ))
        meta.removeChild(existing);
      const s = doc.createElementNS(NS.dc, "dc:subject");
      s.textContent = "Mystery";
      meta.appendChild(s);
    }, true);
    const epub2Plan = await auditTags(epub2.bytes, "epub", { modified });
    epub2Plan.reviewed = true;
    const epub2Applied = await applyTags(epub2.bytes, epub2Plan);
    const after2 = inspectBytes(epub2Applied.bytes, true);
    expect(after2.version).toBe("2.0");
    expect(
      elements(after2.packageDocument, "subject", NS.dc).map(
        (n) => n.textContent,
      ),
    ).toEqual(["Literature.Mystery"]);
    expect(
      elements(after2.packageDocument, "meta", NS.opf).some(
        (m) => attr(m, "property") === "dcterms:modified",
      ),
    ).toBe(false);
  });

  it("writes CBZ ComicInfo Genre in XSD sequence order, blocks comma collisions, and validates via CLI", async () => {
    expect(comicSequence).toContain("Genre");
    expect(comicSequence.indexOf("Imprint")).toBeLessThan(
      comicSequence.indexOf("Genre"),
    );
    expect(comicSequence.indexOf("Genre")).toBeLessThan(
      comicSequence.indexOf("Web"),
    );

    const cbzBytes = cbzFixture(
      `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Title>海辺の旅</Title>
  <Imprint>海辺コミックス</Imprint>
  <Web>https://bookwalker.jp/de00000000-0000-4000-8000-000000000001/</Web>
  <PageCount>1</PageCount>
  <Manga>YesAndRightToLeft</Manga>
  <Pages><Page Image="0" ImageSize="20" ImageWidth="800" ImageHeight="1200"/></Pages>
</ComicInfo>`,
    );

    // Art-book without Arts.* tag surfaces ART_SUBJECT_REQUIRED and blocks apply
    const artPlan = await auditTags(cbzBytes, "cbz", {
      modified,
      decision: {
        kind: "art-book",
        evidence: ["Official illustration book."],
      },
    });
    expect(artPlan.unresolved).toEqual([
      { code: "ART_SUBJECT_REQUIRED" },
      { code: "MISSING_TAGS" },
    ]);
    artPlan.reviewed = true;
    await expect(applyTags(cbzBytes, artPlan)).rejects.toMatchObject({
      code: "TAGS_UNRESOLVED",
    });

    // Comma in custom vocabulary subclass is rejected by controlled vocabulary loader (preventing ComicInfo Genre comma collisions)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-tags-"));
    temporary.push(root);
    const commaVocab = path.join(root, "comma-vocab.json");
    await fs.writeFile(
      commaVocab,
      JSON.stringify({
        version: 1,
        structure: "Major.Controlled Subclass",
        fixed_major_classes: {
          Literature: "P literature",
          History: "C-F",
        },
        controlled_subclasses: {
          Literature: ["Manga"],
          History: ["Rome, Ancient"],
        },
        flat_to_hierarchical: {},
      }),
    );
    await expect(
      auditTags(cbzBytes, "cbz", {
        modified,
        vocabulary: commaVocab,
        decision: {
          kind: "manga",
          add: ["History.Rome, Ancient"],
          evidence: ["Historical manga."],
        },
      }),
    ).rejects.toMatchObject({ code: "TAXONOMY_INVALID" });

    // End-to-end file & CLI validation for CBZ and EPUB
    const cbzPath = path.join(root, "manga.cbz");
    const decisionsPath = path.join(root, "decisions.json");
    const planPath = path.join(root, "tags-plan.json");
    const outCbz = path.join(root, "tagged.cbz");
    await fs.writeFile(cbzPath, cbzBytes);
    await fs.writeFile(
      decisionsPath,
      JSON.stringify({
        kind: "manga",
        add: ["Literature.Fantasy"],
        evidence: ["Confirmed manga fantasy edition."],
      }),
    );

    const cli = (...args: string[]) =>
      run(
        process.execPath,
        [
          "--import",
          "tsx",
          "packages/cli/src/index.ts",
          "metadata",
          ...args,
          "--json",
        ],
        { cwd: repoRoot, timeout: 300000 },
      );

    const auditedCli = await cli(
      "tags-audit",
      cbzPath,
      "--decisions",
      decisionsPath,
      "--output",
      planPath,
    );
    expect(auditedCli.exitCode).toBe(0);
    const savedPlan = JSON.parse(await fs.readFile(planPath, "utf8"));
    savedPlan.reviewed = true;
    await fs.writeFile(planPath, JSON.stringify(savedPlan));

    const appliedCli = await cli(
      "tags-apply",
      cbzPath,
      "--plan",
      planPath,
      "--output",
      outCbz,
    );
    expect(appliedCli.exitCode, appliedCli.stdout + appliedCli.stderr).toBe(0);
    expect(JSON.parse(appliedCli.stdout)).toMatchObject({
      status: "pass",
      purpose: "file-maintenance",
      validation: { status: "pass" },
    });

    const outEntries = unpack(await fs.readFile(outCbz));
    expect(outEntries.get("001.jpg")!.bytes.toString()).toBe(
      "preserved scan image",
    );
    const outDoc = xml(
      outEntries.get("ComicInfo.xml")!.bytes.toString("utf8"),
      "ComicInfo.xml",
    );
    expect(elements(outDoc, "Genre")[0]?.textContent).toBe(
      "Literature.Fantasy, Literature.Manga",
    );

    // Direct API auditFileTags / applyFileTags on EPUB passes EPUBCheck
    const epubBook = await epubFixture();
    const epubIn = path.join(root, "in.epub");
    const epubOut = path.join(root, "out.epub");
    await fs.writeFile(epubIn, epubBook.bytes);
    const epubPlan = await auditFileTags(epubIn, {
      decision: {
        add: ["Literature.Fiction"],
        evidence: ["Literary fiction volume."],
      },
    });
    epubPlan.reviewed = true;
    const epubDelivered = await applyFileTags(epubIn, {
      plan: epubPlan,
      output: epubOut,
    });
    expect(epubDelivered.validation.status).toBe("pass");
  });
});
