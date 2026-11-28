import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installSkillCopy, runNode, sha256, SKILL_DIR } from "./support.ts";

const SCRIPT = path.join(SKILL_DIR, "scripts/naming.ts");

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

interface SubseriesSpec {
  name: string;
  number: string;
  evidence: string[];
}

function book(
  key: string,
  options: {
    number?: string | null;
    kind?: string;
    date?: string | null;
    title?: string | null;
    subseries?: SubseriesSpec | null;
  } = {},
) {
  const number = options.number ?? null;
  const subseries = options.subseries ?? null;
  return {
    id: key,
    edition: "台灣選定版",
    kind: options.kind ?? "main",
    originalTitle: `原書名 ${key}`,
    volumeTitle: options.title ?? null,
    firstPublished: options.date ?? null,
    source: {
      path: `/synthetic/${key}.epub`,
      sha256: "a".repeat(64),
    } as { path: string; sha256: unknown } | null,
    evidence: ["Matched title and credits in the selected edition."],
    official: {
      unified:
        number === null
          ? null
          : { number, evidence: ["Official selected-edition volume."] },
      subseries,
      unavailableEvidence:
        number === null && subseries === null
          ? ["Publisher and book explicitly identify this extra as unnumbered."]
          : [],
    },
  };
}

function inventory(books: Record<string, any>[], name = "某系列") {
  return {
    schemaVersion: 1,
    series: {
      name,
      edition: "台灣選定版",
      evidence: ["Publisher series catalog."],
    },
    coverage: {
      mainComplete: true,
      extrasComplete: true,
      evidence: [
        "All known main volumes and unnumbered extras included, including reference-only records.",
      ],
    },
    chronology: null as { order: string[]; evidence: string[] } | null,
    books,
  };
}

async function plan(data: unknown, script = SCRIPT) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-naming-"));
  tempDirs.push(root);
  const source = path.join(root, "inventory.json");
  await fs.writeFile(source, JSON.stringify(data), "utf8");
  const original = await fs.readFile(source);
  const result = await runNode([script, "plan", "--input", source], {
    cwd: root,
  });
  expect((await fs.readFile(source)).equals(original)).toBe(true);
  expect(await fs.readdir(root)).toEqual(["inventory.json"]);
  expect(result.stdout.length, result.stderr).toBeGreaterThan(0);
  return {
    code: result.exitCode,
    report: JSON.parse(result.stdout) as Record<string, any>,
    digest: sha256(original),
  };
}

async function success(data: unknown) {
  const { code, report, digest } = await plan(data);
  expect(code, JSON.stringify(report)).toBe(0);
  expect(report.inputs.inventory.sha256).toBe(digest);
  expect(report.libraryWritten).toBe(false);
  expect(report.sourceVerification).toBe("declared-only");
  expect(report.schemaVersion).toBe(1);
  expect(report.operation).toBe("series-naming-plan");
  expect(report.status).toBe("reviewable");
  return Object.fromEntries(
    (report.books as Array<Record<string, any>>).map((b) => [b.id, b]),
  ) as Record<string, Record<string, any>>;
}

async function failure(data: unknown, messageFragment: string) {
  const { code, report } = await plan(data);
  expect(code).not.toBe(0);
  expect(report.code).toBe("NAMING_INPUT");
  expect(report.message).toContain(messageFragment);
}

describe("edition-aware whole-series naming helper", () => {
  it("applies series naming consistently across non-light-novel book types and formats", async () => {
    const fiction = inventory(
      [
        {
          ...book("v1", { number: "1", title: "地球往事" }),
          source: {
            path: "/synthetic/three-body-1.epub",
            sha256: "b".repeat(64),
          },
        },
        {
          ...book("v2", { number: "2", title: "黑暗森林" }),
          source: {
            path: "/synthetic/three-body-2.epub",
            sha256: "c".repeat(64),
          },
        },
      ],
      "三體",
    );
    const fictionOut = await success(fiction);
    expect(Object.values(fictionOut).map((b) => b.filenameStem)).toEqual([
      "三體 (01) 地球往事",
      "三體 (02) 黑暗森林",
    ]);

    const manga = inventory(
      [
        {
          ...book("m1", { number: "1" }),
          source: { path: "/synthetic/manga-1.cbz", sha256: "d".repeat(64) },
        },
        {
          ...book("m2", { number: "2", title: "特別篇" }),
          source: { path: "/synthetic/manga-2.cbz", sha256: "e".repeat(64) },
        },
      ],
      "某漫畫",
    );
    const mangaOut = await success(manga);
    expect(Object.values(mangaOut).map((b) => b.filenameStem)).toEqual([
      "某漫畫 (01)",
      "某漫畫 (02) 特別篇",
    ]);

    const technical = inventory(
      [
        {
          ...book("t1", { number: "1", title: "Fundamental Algorithms" }),
          source: { path: "/synthetic/taocp-1.pdf", sha256: "f".repeat(64) },
        },
        {
          ...book("t2", { number: "2", title: "Seminumerical Algorithms" }),
          source: { path: "/synthetic/taocp-2.pdf", sha256: "1".repeat(64) },
        },
      ],
      "The Art of Computer Programming",
    );
    const technicalOut = await success(technical);
    expect(Object.values(technicalOut).map((b) => b.filenameStem)).toEqual([
      "The Art of Computer Programming (01) Fundamental Algorithms",
      "The Art of Computer Programming (02) Seminumerical Algorithms",
    ]);
  });

  it("preserves official main and subseries title text", async () => {
    const data = inventory(
      [
        book("m1", { number: "1" }),
        book("m2", { number: "2" }),
        book("s1", {
          kind: "side-story",
          title: "幸福的櫻色龍捲風",
          subseries: {
            name: "SPIN OFF",
            number: "1",
            evidence: ["Official independent subseries."],
          },
        }),
        book("s2", {
          kind: "short-story-collection",
          title: "秋高虎肥",
          subseries: {
            name: "SPIN OFF",
            number: "2",
            evidence: ["Official independent subseries."],
          },
        }),
      ],
      "TIGER×DRAGON",
    );
    const out = await success(data);
    expect(Object.values(out).map((b) => b.filenameStem)).toEqual([
      "TIGER×DRAGON (01)",
      "TIGER×DRAGON (02)",
      "TIGER×DRAGON SPIN OFF (01) 幸福的櫻色龍捲風",
      "TIGER×DRAGON SPIN OFF (02) 秋高虎肥",
    ]);
    expect(out.s1?.officialMetadata).toEqual({
      title: out.s1?.filenameStem,
      series: "TIGER×DRAGON SPIN OFF",
      position: "1",
    });
  });

  it("matches the documented naming-example.json contract", async () => {
    const example = JSON.parse(
      await fs.readFile(
        path.join(SKILL_DIR, "references/naming-example.json"),
        "utf8",
      ),
    );
    const out = await success(example);
    expect(out["extra-1"]?.filenameStem).toBe("某系列 (06.5-01) 外傳第一卷");
    expect(out["extra-2"]?.filenameStem).toBe("某系列 (06.5-02) 外傳第二卷");
  });

  it("requires one consistent official subseries name", async () => {
    const data = inventory([
      book("s1", {
        kind: "side-story",
        subseries: {
          name: "SPIN OFF",
          number: "1",
          evidence: ["Official subseries."],
        },
      }),
      book("s2", {
        kind: "side-story",
        subseries: {
          name: "Spin Off",
          number: "2",
          evidence: ["Same official subseries."],
        },
      }),
    ]);
    await failure(data, "consistent subseries");
  });

  it("prefers unified number and never adds work type to main series", async () => {
    const b = book("extra", {
      number: "11",
      kind: "side-story",
      title: "SIDE ARMS：原書名  II！",
      subseries: {
        name: "SIDE ARMS",
        number: "1",
        evidence: ["Older alternate classification."],
      },
    });
    const out = (await success(inventory([b]))).extra!;
    expect(out.filenameStem).toBe("某系列 (11) SIDE ARMS：原書名  II！");
    expect(out.basis).toBe("official-unified");
    expect(out.officialMetadata.position).toBe("11");
  });

  it("keeps single insertion and post-final extra local-only", async () => {
    const out = await success(
      inventory([
        book("m6", { number: "6", date: "2006" }),
        book("extra", { kind: "extra", date: "2007", title: "番外篇" }),
      ]),
    );
    expect(out.extra?.filenameStem).toBe("某系列 (06.5) 番外篇");
    expect(out.extra?.officialMetadata).toBeNull();
    expect(out.extra?.anchor).toBe("m6");
    expect(out.extra?.originalTitle).toBe("原書名 extra");
  });

  it("orders multiple insertions by first publication rather than input order", async () => {
    const data = inventory([
      book("m7", { number: "7", date: "2010" }),
      book("e2", { kind: "extra", date: "2009", title: "外傳第二卷" }),
      book("m6", { number: "6", date: "2006" }),
      book("e1", { kind: "side-story", date: "2008", title: "外傳第一卷" }),
    ]);
    const out = await success(data);
    expect(out.e1?.filenameStem).toBe("某系列 (06.5-01) 外傳第一卷");
    expect(out.e2?.filenameStem).toBe("某系列 (06.5-02) 外傳第二卷");
    expect(out.e1?.sortKey).toEqual(["某系列", "6", "5", 1]);
    expect(out.e1?.officialMetadata).toBeNull();
    expect(out.e2?.officialMetadata).toBeNull();

    data.books.reverse();
    const again = await success(data);
    expect(
      Object.fromEntries(
        Object.entries(again).map(([k, v]) => [k, v.filenameStem]),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(out).map(([k, v]) => [k, v.filenameStem]),
      ),
    );
  });

  it("requires complete inventory and evidenced chronology", async () => {
    const data = inventory([
      book("m6", { number: "6", date: "2006" }),
      book("e", { kind: "extra", date: "2007" }),
    ]);
    data.coverage.extrasComplete = false;
    await failure(data, "complete");

    data.coverage.extrasComplete = true;
    data.books[1]!.firstPublished = "2006";
    await failure(data, "chronology");

    data.chronology = {
      order: ["m6", "e"],
      evidence: [
        "Publisher confirms the main volume preceded the same-year extra.",
      ],
    };
    expect((await success(data)).e?.label).toBe("06.5");

    data.books[1]!.firstPublished = "2005";
    await failure(data, "contradicts");
  });

  it("refuses mixed editions, duplicate positions, and unsupported numbers", async () => {
    const data = inventory([
      book("m1", { number: "1" }),
      book("m2", { number: "2" }),
    ]);
    data.books[1]!.edition = "另一版";
    await failure(data, "edition");

    data.books[1]!.edition = "台灣選定版";
    data.books[1]!.official.unified!.number = "1";
    await failure(data, "collision");

    for (const value of ["II", "二", "２", "06.5-01", "1.2.3", "1-2"]) {
      data.books[1]!.official.unified!.number = value;
      await failure(data, "Arabic");
    }
  });

  it("uses reference-only extras to determine whole-series suffixes", async () => {
    const main = book("m6", { number: "6", date: "2006" });
    const other = book("e1", { kind: "extra", date: "2007" });
    main.source = null;
    other.source = null;
    const out = await success(
      inventory([main, other, book("e2", { kind: "extra", date: "2008" })]),
    );
    expect(Object.keys(out)).toEqual(["e2"]);
    expect(out.e2?.label).toBe("06.5-02");
  });

  it("does not require irrelevant subseries dates for local chronology", async () => {
    const data = inventory([
      book("m6", { number: "6", date: "2006" }),
      book("e", { kind: "extra", date: "2006" }),
      book("sub", {
        kind: "side-story",
        subseries: {
          name: "SPIN OFF",
          number: "1",
          evidence: ["Official independent numbering."],
        },
      }),
    ]);
    data.chronology = {
      order: ["m6", "e"],
      evidence: [
        "Bibliography orders the main volume before the unnumbered extra.",
      ],
    };
    const out = await success(data);
    expect(out.e?.label).toBe("06.5");
    expect(out.sub?.label).toBe("01");
  });

  it("handles multiple anchor groups and natural numeric order", async () => {
    const data = inventory([
      book("m100", { number: "100", date: "2012" }),
      book("m9", { number: "9", date: "2009-01" }),
      book("e10", { kind: "extra", date: "2011" }),
      book("m10", { number: "10", date: "2010" }),
      book("e9", { kind: "short-story-collection", date: "2009-06" }),
    ]);
    const { code, report } = await plan(data);
    expect(code).toBe(0);
    expect(report.order).toEqual(["m9", "e9", "m10", "e10", "m100"]);
    const out = Object.fromEntries(
      (report.books as Array<Record<string, any>>).map((b) => [b.id, b]),
    );
    expect(out.m100?.filenameStem).toBe("某系列 (100)");
    expect(out.e9?.label).toBe("09.5");
    expect(out.e10?.label).toBe("10.5");
  });

  it("keeps official fraction distinct from a local insertion", async () => {
    const out = (
      await success(
        inventory([book("official", { number: "06.50", kind: "extra" })]),
      )
    ).official!;
    expect(out.label).toBe("06.5");
    expect(out.officialMetadata.position).toBe("6.5");

    const collision = inventory([
      book("m6", { number: "6", date: "2006" }),
      book("e", { kind: "extra", date: "2007" }),
      book("official", { number: "6.5", kind: "extra" }),
    ]);
    await failure(collision, "collision");
  });

  it("refuses unanchored, unknown, or invalid publication order", async () => {
    const data = inventory([
      book("m6", { number: "6", date: "2006" }),
      book("e", { kind: "extra", date: "2005" }),
    ]);
    await failure(data, "preceding");

    data.books[1]!.firstPublished = null;
    await failure(data, "chronology");

    data.chronology = {
      order: ["m6", "e"],
      evidence: [
        "Bibliography explicitly orders these first publications, dates are unavailable.",
      ],
    };
    expect((await success(data)).e?.label).toBe("06.5");

    data.chronology.order = ["m6", "m6"];
    await failure(data, "exactly once");

    data.chronology = null;
    for (const value of ["2007-02-29", "2007-13", "0000", "07", "2007-1-1"]) {
      data.books[1]!.firstPublished = value;
      await failure(data, "date");
    }
  });

  it("preserves Unicode and enforces supported filename components", async () => {
    const original = "Cafe\u0301：『外傳』 II  +  III！";
    const out = (
      await success(inventory([book("m", { number: "01", title: original })]))
    ).m!;
    expect(out.filenameStem).toBe(`某系列 (01) ${original}`);
    expect(out.officialMetadata.position).toBe("1");

    const badSep = inventory([book("m", { number: "1", title: "甲/乙" })]);
    await failure(badSep, "separator");

    badSep.books[0]!.volumeTitle = " 尾部空白 ";
    await failure(badSep, "whitespace");
  });

  it("requires official evidence and rejects unknown or unsafe input shapes", async () => {
    const base = inventory([book("m", { number: "1" })]);
    const cases: Array<[(d: Record<string, any>) => void, string]> = [
      [
        (d) => {
          d.books[0].official.unified.evidence = [];
        },
        "Evidence",
      ],
      [
        (d) => {
          d.books[0].edition = "";
        },
        "edition",
      ],
      [
        (d) => {
          d.books[0].source.sha256 = ["a".repeat(64)];
        },
        "SHA-256",
      ],
      [
        (d) => {
          d.books[0].source.path = "relative.epub";
        },
        "absolute",
      ],
      [
        (d) => {
          d.books[0].renamingOverride = "invented";
        },
        "fields",
      ],
    ];
    for (const [mutate, msg] of cases) {
      const copy = structuredClone(base);
      mutate(copy);
      await failure(copy, msg);
    }

    const extra = inventory([
      book("m", { number: "1", date: "2000" }),
      book("e", { kind: "extra", date: "2001" }),
    ]);
    extra.books[1]!.official.unavailableEvidence = [];
    await failure(extra, "Evidence");
  });
});

describe("installed standalone naming helper", () => {
  it("remains read-only and refuses report overwrites and symlink outputs", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "quillbind-installed-naming-"),
    );
    tempDirs.push(root);
    const installed = await installSkillCopy(root);
    const dataPath = path.join(root, "input.json");
    await fs.writeFile(
      dataPath,
      JSON.stringify(inventory([book("m1", { number: "1" })])),
      "utf8",
    );
    const output = path.join(root, "plan.json");
    const args = [
      path.join(installed, "scripts/naming.ts"),
      "plan",
      "--input",
      dataPath,
      "--output",
      output,
    ];

    const first = await runNode(args, { cwd: root });
    expect(first.exitCode).toBe(0);

    const before = await fs.readFile(output);
    const second = await runNode(args, { cwd: root });
    expect(second.exitCode).not.toBe(0);
    expect((JSON.parse(second.stdout) as { code: string }).code).toBe(
      "OUTPUT_EXISTS",
    );
    expect((await fs.readFile(output)).equals(before)).toBe(true);

    const alias = path.join(root, "alias.json");
    await fs.symlink(dataPath, alias);
    const original = await fs.readFile(dataPath);
    const third = await runNode([...args.slice(0, -1), alias], { cwd: root });
    expect(third.exitCode).not.toBe(0);
    expect((await fs.readFile(dataPath)).equals(original)).toBe(true);
  });
});
