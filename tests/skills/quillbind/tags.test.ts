import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installSkillCopy, runNode, sha256, SKILL_DIR } from "./support.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function snapshotDir(root: string): Promise<Record<string, Buffer>> {
  const entries = await fs.readdir(root);
  const out: Record<string, Buffer> = {};
  for (const name of entries.sort()) {
    out[name] = await fs.readFile(path.join(root, name));
  }
  return out;
}

async function runAudit(
  books: unknown,
  vocabulary?: unknown,
  decisions?: unknown,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-tag-audit-"));
  tempDirs.push(root);
  const inventory = path.join(root, "inventory.json");
  await fs.writeFile(inventory, JSON.stringify(books), "utf8");
  const vocab = path.join(root, "vocabulary.json");
  if (vocabulary === undefined) {
    await fs.copyFile(
      path.join(SKILL_DIR, "references/tag-vocabulary.json"),
      vocab,
    );
  } else {
    await fs.writeFile(vocab, JSON.stringify(vocabulary), "utf8");
  }
  const args = [
    path.join(SKILL_DIR, "scripts/tags.ts"),
    "audit",
    "--input",
    inventory,
    "--vocabulary",
    vocab,
  ];
  if (decisions !== undefined) {
    const plan = path.join(root, "decisions.json");
    await fs.writeFile(plan, JSON.stringify(decisions), "utf8");
    args.push("--decisions", plan);
  }
  const before = await snapshotDir(root);
  const result = await runNode(args, { cwd: root });
  const after = await snapshotDir(root);
  expect(Object.keys(after)).toEqual(Object.keys(before));
  for (const key of Object.keys(before)) {
    expect(after[key]?.equals(before[key]!)).toBe(true);
  }
  return {
    code: result.exitCode,
    report: JSON.parse(result.stdout) as Record<string, any>,
    before,
  };
}

describe("standalone tag audit helper", () => {
  it("normalizes only declared aliases and preserves unknown tags", async () => {
    const { code, report, before } = await runAudit([
      {
        id: 1,
        title: "Synthetic",
        tags: [
          " fantasy ",
          "Literature.Fantasy",
          "science. computer   science",
          "简体中文",
          "Author Name",
        ],
      },
    ]);
    expect(code).toBe(0);
    const book = report.books[0];
    expect(book.proposed).toEqual([
      "Literature.Fantasy",
      "Science.Computer Science",
      "简体中文",
      "Author Name",
    ]);
    expect(book.unresolved.map((f: { tag: string }) => f.tag)).toEqual([
      "简体中文",
      "Author Name",
    ]);
    expect(report.status).toBe("needs-review");
    expect(report.operation).toBe("tag-audit");
    expect(report.libraryWritten).toBe(false);
    expect(report.publicationReady).toBe(false);
    expect(report.inputs.inventory.sha256).toBe(
      sha256(before["inventory.json"]!),
    );
    expect(report.inputs.vocabulary.sha256).toBe(
      sha256(before["vocabulary.json"]!),
    );
  });

  it("classifies using evidence rather than title, author, series, or language", async () => {
    const books = [
      { id: 1, title: "Synthetic prose", tags: ["Literature.Manga"] },
      {
        id: 2,
        title: "Synthetic artwork",
        tags: ["Literature.Light Novel", "Arts.General"],
      },
      {
        id: 3,
        title: "A Light Novel in English",
        languages: ["eng"],
        tags: [],
      },
    ];
    const decisions = [
      {
        id: 1,
        kind: "light-novel",
        evidence: ["Publisher identifies the selected volume as prose."],
      },
      {
        id: 2,
        kind: "art-book",
        evidence: ["Interior pages and publisher identify an art collection."],
      },
    ];
    const { code, report } = await runAudit(books, undefined, decisions);
    expect(code).toBe(0);
    expect(report.books[0].proposed).toEqual(["Literature.Light Novel"]);
    expect(report.books[1].proposed).toEqual(["Arts.General"]);
    expect(report.books[2].proposed).toEqual([]);
    expect(report.books[2].unresolved[0].code).toBe("MISSING_TAGS");
    expect(report.books[0].evidence.length).toBeGreaterThan(0);
  });

  it("requires evidence for explicit field decisions and preserves other tags", async () => {
    const { code, report } = await runAudit(
      [
        {
          id: 1,
          title: "Synthetic",
          tags: ["Literature.Light Novel", "简体中文"],
        },
      ],
      undefined,
      [
        {
          id: 1,
          add: ["Literature.Fantasy"],
          remove: ["简体中文"],
          evidence: [
            "User-supplied genre; script belongs in language metadata.",
          ],
        },
      ],
    );
    expect(code).toBe(0);
    expect(report.books[0].proposed).toEqual([
      "Literature.Light Novel",
      "Literature.Fantasy",
    ]);
    expect(report.books[0].unresolved).toEqual([]);
    expect(report.books[0].removed).toEqual(["简体中文"]);
    expect(report.status).toBe("reviewable");
    expect(report.libraryWritten).toBe(false);
    expect(report.publicationReady).toBe(false);
  });

  it("fails on invalid inputs and unscoped or unsupported decisions", async () => {
    const inventory = [{ id: 1, title: "Synthetic", tags: [] }];
    for (const decisions of [
      [{ id: 1, kind: "manga" }],
      [{ id: 9, kind: "manga", evidence: ["Publisher"] }],
      [{ id: 1, add: ["Uncontrolled.Tag"], evidence: ["Publisher"] }],
      [
        {
          id: 1,
          kind: "manga",
          add: ["Literature.Light Novel"],
          evidence: ["Publisher"],
        },
      ],
    ]) {
      const { code, report } = await runAudit(inventory, undefined, decisions);
      expect(code).not.toBe(0);
      expect(report.code).toBe("INPUT_INVALID");
    }
    for (const bad of [
      [...inventory, ...inventory],
      [{ id: 1, title: "Synthetic", tags: "Fantasy" }],
    ]) {
      const { code, report } = await runAudit(bad);
      expect(code).not.toBe(0);
      expect(report.code).toBe("INPUT_INVALID");
    }
  });

  it("controls mappings and detects vocabulary gaps", async () => {
    const vocabulary = {
      version: 3,
      structure: "Major.Controlled Subclass",
      fixed_major_classes: { Literature: "P", Music: "M" },
      controlled_subclasses: { Literature: ["Fiction"], Music: [] },
      flat_to_hierarchical: { Fiction: "Literature.Fiction" } as Record<
        string,
        string
      >,
    };
    const books = [{ id: 1, title: "Synthetic", tags: ["Literature.Fantasy"] }];
    const first = await runAudit(books, vocabulary);
    expect(first.code).toBe(0);
    expect(first.report.books[0].proposed).toEqual(["Literature.Fantasy"]);
    expect(first.report.books[0].unresolved[0].code).toBe("UNKNOWN_TAG");

    const second = await runAudit(books, vocabulary, [
      { id: 1, kind: "light-novel", evidence: ["Publisher"] },
    ]);
    expect(second.code).toBe(0);
    expect(
      second.report.books[0].unresolved.map((i: { code: string }) => i.code),
    ).toContain("VOCABULARY_GAP");

    vocabulary.flat_to_hierarchical.Invalid = "Literature.Missing";
    const third = await runAudit(books, vocabulary);
    expect(third.code).not.toBe(0);
    expect(third.report.code).toBe("TAXONOMY_INVALID");
  });

  it("rejects ambiguous aliases and keeps normalization idempotent", async () => {
    const vocabulary = JSON.parse(
      await fs.readFile(
        path.join(SKILL_DIR, "references/tag-vocabulary.json"),
        "utf8",
      ),
    ) as { flat_to_hierarchical: Record<string, string> };
    vocabulary.flat_to_hierarchical.fantasy = "Literature.Fiction";
    const bad = await runAudit([], vocabulary);
    expect(bad.code).not.toBe(0);
    expect(bad.report.code).toBe("TAXONOMY_INVALID");

    const original = [
      {
        id: 1,
        title: "Synthetic",
        tags: ["Fantasy", "Literature.Fantasy", "Unknown"],
      },
    ];
    const first = await runAudit(original);
    original[0]!.tags = first.report.books[0].proposed as string[];
    const second = await runAudit(original);
    expect(second.code).toBe(0);
    expect(second.report.books[0].proposed).toEqual(original[0]!.tags);
    expect(second.report.books[0].changes).toEqual([]);
    expect(second.report.status).toBe("needs-review");
  });
});

describe("installed standalone tag audit helper", () => {
  it("runs without runtime and refuses overwrites and symlink outputs", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "quillbind-installed-tags-"),
    );
    tempDirs.push(root);
    const installed = await installSkillCopy(root);
    const source = path.join(root, "inventory.json");
    const rawSource = '[{"id":1,"title":"Synthetic","tags":["Fantasy"]}]';
    await fs.writeFile(source, rawSource, "utf8");
    const output = path.join(root, "report.json");
    const args = [
      path.join(installed, "scripts/tags.ts"),
      "audit",
      "--input",
      source,
      "--output",
      output,
    ];

    const first = await runNode(args, { cwd: root });
    expect(first.exitCode).toBe(0);
    const parsed = JSON.parse(await fs.readFile(output, "utf8")) as {
      books: Array<{ proposed: string[] }>;
    };
    expect(parsed.books[0]?.proposed).toEqual(["Literature.Fantasy"]);

    const before = await fs.readFile(output);
    const second = await runNode(args, { cwd: root });
    expect(second.exitCode).not.toBe(0);
    expect((JSON.parse(second.stdout) as { code: string }).code).toBe(
      "OUTPUT_EXISTS",
    );
    expect((await fs.readFile(output)).equals(before)).toBe(true);

    const alias = path.join(root, "alias.json");
    await fs.symlink(source, alias);
    const third = await runNode([...args.slice(0, -1), alias], { cwd: root });
    expect(third.exitCode).not.toBe(0);
    expect(await fs.readFile(source, "utf8")).toBe(rawSource);
  });
});
