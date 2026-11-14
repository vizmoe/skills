import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyBibliography,
  auditBibliography,
  cleanBibliography,
  type BibliographyPlan,
} from "../packages/core/src/bibliography-file.js";
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
const modified = "2026-11-10T00:00:00Z";
type Edit = (document: Document, metadata: Element) => void;
async function book(edit: Edit, legacy = false) {
  const root = await copyBook();
  temporary.push(root);
  const info = inspectBytes(
    legacy
      ? await fs.readFile(path.join(repoRoot, "examples/repair/legacy.epub"))
      : await candidate(root),
  );
  const metadata = elements(info.packageDocument, "metadata", NS.opf)[0];
  edit(
    info.packageDocument as unknown as Document,
    metadata as unknown as Element,
  );
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  return { root, bytes: pack(entries, 946684800) };
}
const dc = (document: Document, name: string, value: string, id?: string) => {
  const node = document.createElementNS(NS.dc, `dc:${name}`);
  node.textContent = value;
  if (id) node.setAttribute("id", id);
  return node;
};
const meta = (
  document: Document,
  attributes: Record<string, string>,
  value = "",
) => {
  const node = document.createElementNS(NS.opf, "meta");
  for (const [key, item] of Object.entries(attributes))
    node.setAttribute(key, item);
  node.textContent = value;
  return node;
};
const dirty: Edit = (document, metadata) => {
  const set = (name: string, value: string) => {
    metadata.getElementsByTagNameNS(NS.dc, name)[0].textContent = value;
  };
  set("title", "【预售】山间来信 - 博客來");
  set("creator", "[日] 东野圭吾 著；李盈春 译");
  set(
    "description",
    "<p>山间的来信。</p><p>(展开全部)</p><p>更多电子书请访问 www.example-books.com</p>",
  );
  set("language", "zho");
  metadata.getElementsByTagNameNS(NS.dc, "creator")[0].setAttribute("id", "c1");
  metadata.appendChild(
    meta(document, { refines: "#c1", property: "file-as" }, "东野圭吾 著"),
  );
  metadata.appendChild(dc(document, "creator", "Unknown"));
  metadata.appendChild(dc(document, "publisher", "www.epubw.com"));
  metadata.appendChild(dc(document, "date", "0101-01-01T00:00:00+00:00"));
  metadata.appendChild(dc(document, "identifier", "0-306-40615-2", "isbn10"));
  metadata.appendChild(
    meta(
      document,
      {
        refines: "#isbn10",
        property: "identifier-type",
        scheme: "onix:codelist5",
      },
      "02",
    ),
  );
  metadata.appendChild(
    meta(document, { name: "calibre:series", content: "山间" }),
  );
  metadata.appendChild(
    meta(document, { name: "custom:note", content: "keep" }),
  );
};
function decide(
  plan: BibliographyPlan,
  decision: "apply" | "retain" = "apply",
) {
  for (const finding of plan.findings) {
    finding.decision = finding.proposed ? decision : "retain";
    finding.evidence = "Reviewed against the file and the edition page.";
  }
  plan.reviewed = true;
  return plan;
}
const values = (bytes: Buffer, name: string) =>
  elements(inspectBytes(bytes, true).packageDocument, name, NS.dc).map(
    (node) => node.textContent,
  );

it("audits dirty bibliography with normalized proposals", async () => {
  const { bytes } = await book(dirty);
  const plan = auditBibliography(bytes, { modified });
  const rules = Object.fromEntries(
    plan.findings.map((item) => [item.target, [item.rule, item.proposed]]),
  );
  expect(rules).toEqual({
    "title/0": ["title-residue", { action: "replace", value: "山间来信" }],
    "creator/0": [
      "credit-combined",
      {
        action: "split",
        contributors: [
          { name: "东野圭吾", role: "aut" },
          { name: "李盈春", role: "trl" },
        ],
      },
    ],
    "creator/1": ["credit-placeholder", { action: "remove" }],
    "description/0": [
      "description-residue",
      { action: "replace", value: "山间的来信。" },
    ],
    "language/0": ["language-format", { action: "replace", value: "zh" }],
    "publisher/0": ["publisher-residue", { action: "remove" }],
    "date/0": ["date-undefined", { action: "remove" }],
    "identifier/1": [
      "isbn-format",
      { action: "replace", value: "9780306406157" },
    ],
  });
  expect(
    plan.inventory.find((node) => node.key === "identifier/0"),
  ).toMatchObject({
    primary: true,
    isbn: null,
  });
  expect(plan.reviewed).toBe(false);
});

it("finds nothing in clean EPUB 3 and EPUB 2 packages", async () => {
  for (const legacy of [false, true]) {
    const { bytes } = await book(() => {}, legacy);
    expect(auditBibliography(bytes, { modified }).findings).toEqual([]);
  }
});

it("applies reviewed findings and keeps identity, unselected metadata and every other member", async () => {
  const { bytes } = await book(dirty);
  const plan = decide(auditBibliography(bytes, { modified }));
  const result = applyBibliography(bytes, plan);
  const after = inspectBytes(result.bytes, true);
  expect(values(result.bytes, "title")).toEqual(["山间来信"]);
  expect(values(result.bytes, "creator")).toEqual(["东野圭吾"]);
  expect(values(result.bytes, "contributor")).toEqual(["李盈春"]);
  expect(values(result.bytes, "publisher")).toEqual([]);
  expect(values(result.bytes, "date")).toEqual([]);
  expect(values(result.bytes, "language")).toEqual(["zh"]);
  expect(values(result.bytes, "description")).toEqual(["山间的来信。"]);
  expect(values(result.bytes, "identifier")).toEqual([
    "urn:uuid:11111111-1111-4111-8111-111111111111",
    "9780306406157",
  ]);
  const metas = elements(after.packageDocument, "meta", NS.opf);
  const roleOf = (name: string) => {
    const node = [
      ...elements(after.packageDocument, "creator", NS.dc),
      ...elements(after.packageDocument, "contributor", NS.dc),
    ].find((item) => item.textContent === name)!;
    return metas.find(
      (item) =>
        attr(item, "refines") === `#${attr(node, "id")}` &&
        attr(item, "property") === "role",
    )?.textContent;
  };
  expect(roleOf("东野圭吾")).toBe("aut");
  expect(roleOf("李盈春")).toBe("trl");
  expect(metas.some((item) => item.textContent === "东野圭吾 著")).toBe(false);
  expect(
    metas
      .find((item) => attr(item, "name") === "custom:note")
      ?.getAttribute("content"),
  ).toBe("keep");
  expect(
    metas.find((item) => attr(item, "name") === "calibre:series"),
  ).toBeDefined();
  expect(
    metas.find((item) => attr(item, "property") === "dcterms:modified")
      ?.textContent,
  ).toBe(modified);
  const before = inspectBytes(bytes, true);
  for (const [name, entry] of before.entries)
    if (name !== before.packagePath)
      expect(after.entries.get(name)!.bytes.equals(entry.bytes)).toBe(true);
  expect(auditBibliography(result.bytes, { modified }).findings).toEqual([]);
  expect(result.report.changes).toHaveLength(8);
});

it("retains rejected findings and leaves an all-retained book byte-identical", async () => {
  const { bytes } = await book(dirty);
  const plan = decide(auditBibliography(bytes, { modified }), "retain");
  const result = applyBibliography(bytes, plan);
  expect(result.report.changed).toBe(false);
  expect(result.bytes.equals(bytes)).toBe(true);
  expect(result.report.retained).toHaveLength(plan.findings.length);
});

it("applies evidenced assignments, including ISBN identifiers in the EPUB 3 form", async () => {
  const { bytes } = await book(() => {});
  const plan = decide(auditBibliography(bytes, { modified }));
  plan.assignments = [
    {
      field: "publisher",
      value: "南海出版公司",
      evidence: "Edition lock",
      source: "edition.lock.json",
    },
    { field: "date", value: "2014-05", evidence: "Edition lock" },
    { field: "isbn", value: "978-0-306-40615-7", evidence: "Copyright page" },
    {
      field: "contributors",
      contributors: [
        { name: "东野圭吾", role: "aut" },
        { name: "李盈春", role: "trl" },
      ],
      evidence: "Edition lock credits",
    },
  ];
  const result = applyBibliography(bytes, plan);
  const after = inspectBytes(result.bytes, true);
  expect(values(result.bytes, "publisher")).toEqual(["南海出版公司"]);
  expect(values(result.bytes, "date")).toEqual(["2014-05"]);
  expect(values(result.bytes, "creator")).toEqual(["东野圭吾"]);
  expect(values(result.bytes, "contributor")).toEqual(["李盈春"]);
  const isbn = elements(after.packageDocument, "identifier", NS.dc).find(
    (node) => node.textContent === "9780306406157",
  )!;
  expect(
    elements(after.packageDocument, "meta", NS.opf).find(
      (node) => attr(node, "refines") === `#${attr(isbn, "id")}`,
    )?.textContent,
  ).toBe("15");
  const again = decide(auditBibliography(result.bytes, { modified }));
  again.assignments = [
    { field: "isbn", value: "9780306406157", evidence: "Same number" },
  ];
  expect(applyBibliography(result.bytes, again).report.changed).toBe(false);
});

it("keeps EPUB 2 conventions when splitting credits and adding ISBNs", async () => {
  const { bytes } = await book((document, metadata) => {
    metadata.getElementsByTagNameNS(NS.dc, "creator")[0].textContent =
      "Haruki Murakami (Author), Jay Rubin (Translator)";
  }, true);
  const plan = decide(auditBibliography(bytes, { modified }));
  plan.assignments = [
    { field: "isbn", value: "0306406152", evidence: "Copyright page" },
  ];
  const result = applyBibliography(bytes, plan);
  const after = inspectBytes(result.bytes, true);
  expect(after.version).toBe("2.0");
  const contributor = elements(
    after.packageDocument,
    "contributor",
    NS.dc,
  ).find((node) => node.textContent === "Jay Rubin")!;
  expect(contributor.getAttributeNS(NS.opf, "role")).toBe("trl");
  const isbn = elements(after.packageDocument, "identifier", NS.dc).find(
    (node) => node.textContent === "9780306406157",
  )!;
  expect(isbn.getAttributeNS(NS.opf, "scheme")).toBe("ISBN");
  expect(
    elements(after.packageDocument, "meta", NS.opf).some(
      (node) => attr(node, "property") === "dcterms:modified",
    ),
  ).toBe(false);
  expect(
    elements(after.packageDocument, "meta", NS.opf).find(
      (node) => attr(node, "name") === "custom:edition-note",
    ),
  ).toBeDefined();
});

it("reports source-dependent problems without automatic corrections", async () => {
  const { bytes } = await book((document, metadata) => {
    metadata.getElementsByTagNameNS(NS.dc, "language")[0].textContent = "und";
    metadata.appendChild(dc(document, "date", "2014-04-30T16:00:00+00:00"));
    metadata.appendChild(dc(document, "date", "someday"));
    metadata.appendChild(dc(document, "identifier", "urn:isbn:9780306406158"));
  });
  const plan = auditBibliography(bytes, { modified });
  expect(plan.findings.map((item) => [item.rule, item.proposed])).toEqual([
    ["language-undetermined", null],
    ["date-shifted", null],
    ["date-unrecognized", null],
    ["isbn-invalid", null],
  ]);
  decide(plan);
  plan.findings[0].decision = "apply";
  expect(() => applyBibliography(bytes, plan)).toThrow(
    /no automatic correction/,
  );
});

it("rejects stale, edited, undecided, conflicting and unsafe plans", async () => {
  const { bytes } = await book(dirty);
  const base = () => decide(auditBibliography(bytes, { modified }));
  const cases: [BibliographyPlan | Record<string, unknown>, string][] = [];
  const stale = base();
  stale.sourceSha256 = "0".repeat(64);
  cases.push([stale, "METADATA_STALE"]);
  const edited = base();
  edited.findings[0].proposed = { action: "replace", value: "Other" };
  cases.push([edited, "BIBLIOGRAPHY_INVENTORY"]);
  const unreviewed = base();
  unreviewed.reviewed = false;
  cases.push([unreviewed, "BIBLIOGRAPHY_REVIEW"]);
  const undecided = base();
  undecided.findings[1].decision = null;
  cases.push([undecided, "BIBLIOGRAPHY_DECISION"]);
  const conflict = base();
  conflict.assignments = [{ field: "title", value: "Another", evidence: "x" }];
  cases.push([conflict, "BIBLIOGRAPHY_CONFLICT"]);
  const twice = decide(base(), "retain");
  twice.assignments = [
    { field: "publisher", value: "A", evidence: "x" },
    { field: "publisher", value: "B", evidence: "y" },
  ];
  cases.push([twice, "BIBLIOGRAPHY_CONFLICT"]);
  for (const [field, value] of [
    ["date", "2014-5"],
    ["language", "zho"],
    ["isbn", "9780306406158"],
  ] as const) {
    const invalid = decide(base(), "retain");
    invalid.assignments = [{ field, value, evidence: "x" }];
    cases.push([invalid, "BIBLIOGRAPHY_VALUE"]);
  }
  cases.push([{ schemaVersion: 2 }, "BIBLIOGRAPHY_PLAN"]);
  for (const [plan, code] of cases)
    expect(() => applyBibliography(bytes, plan)).toThrow(
      expect.objectContaining({ code }),
    );
});

it("refuses to edit or remove the package identity", async () => {
  const { bytes } = await book((document, metadata) => {
    metadata.getElementsByTagNameNS(NS.dc, "identifier")[0].textContent =
      "urn:isbn:0-306-40615-2";
  });
  const plan = decide(auditBibliography(bytes, { modified }));
  expect(plan.findings).toEqual([
    expect.objectContaining({ rule: "isbn-format", proposed: null }),
  ]);
  plan.assignments = [
    { field: "isbn", value: "9780804429573", evidence: "Other edition" },
  ];
  expect(() => applyBibliography(bytes, plan)).toThrow(
    expect.objectContaining({ code: "BIBLIOGRAPHY_PRIMARY" }),
  );
});

it("delivers validated new EPUB and CBZ files through the CLI and refuses unsupported formats", async () => {
  const { root, bytes } = await book(dirty);
  const source = path.join(root, "dirty.epub");
  const planFile = path.join(root, "plan.json");
  const output = path.join(root, "clean.epub");
  await fs.writeFile(source, bytes);
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
  const audited = await cli("bibliography-audit", source, "--output", planFile);
  expect(audited.exitCode).toBe(0);
  const plan = decide(JSON.parse(await fs.readFile(planFile, "utf8")));
  await fs.writeFile(planFile, JSON.stringify(plan));
  const cleaned = await cli(
    "bibliography-clean",
    source,
    "--plan",
    planFile,
    "--output",
    output,
  );
  expect(cleaned.exitCode, cleaned.stdout + cleaned.stderr).toBe(0);
  expect(JSON.parse(cleaned.stdout)).toMatchObject({
    status: "pass",
    purpose: "file-maintenance",
    validation: { status: "pass" },
  });
  expect(values(await fs.readFile(output), "title")).toEqual(["山间来信"]);
  expect(await fs.readFile(source)).toEqual(bytes);
  await expect(
    cleanBibliography(source, { plan, output }),
  ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });

  // CBZ ComicInfo 2.0 bibliography audit, cleanup, XSD validation, and format boundaries
  const cbzBytes = packArchive(
    new Map([
      ["page-001.jpg", Buffer.from("preserved manga page bytes")],
      [
        "ComicInfo.xml",
        Buffer.from(
          `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Title>【预售】海辺の物語 1 - 博客來.cbz</Title>
  <Series>海辺シリーズ</Series>
  <Number>1</Number>
  <Summary>&lt;p&gt;港町の物語。&lt;/p&gt;&lt;p&gt;更多电子书请访问 www.example-books.com&lt;/p&gt;</Summary>
  <Notes>Preserved provenance note.</Notes>
  <Year>2022</Year>
  <Month>-1</Month>
  <Day>-1</Day>
  <Writer>[日] 山田太郎 原作；佐藤花子 作画；高橋次郎 イラスト</Writer>
  <CoverArtist>Unknown</CoverArtist>
  <Publisher>www.epubw.com</Publisher>
  <Imprint>レーベル：海辺コミックス</Imprint>
  <Genre>Literature.Manga</Genre>
  <PageCount>1</PageCount>
  <LanguageISO>jpn</LanguageISO>
  <Manga>YesAndRightToLeft</Manga>
  <AgeRating>Teen</AgeRating>
  <Pages><Page Image="0" ImageSize="26" ImageWidth="800" ImageHeight="1200"/></Pages>
</ComicInfo>`,
        ),
      ],
    ]),
    946684800,
  );
  const cbzSource = path.join(root, "dirty.cbz");
  const cbzPlanFile = path.join(root, "cbz-plan.json");
  const cbzOutput = path.join(root, "clean.cbz");
  await fs.writeFile(cbzSource, cbzBytes);

  const cbzAudited = await cli(
    "bibliography-audit",
    cbzSource,
    "--output",
    cbzPlanFile,
  );
  expect(cbzAudited.exitCode).toBe(0);
  const cbzPlan = decide(JSON.parse(await fs.readFile(cbzPlanFile, "utf8")));
  expect(cbzPlan.format).toBe("cbz");
  expect(cbzPlan.version).toBeUndefined();

  // ComicInfo 2.0 rejects ISBN and translator assignments rather than inventing fields or flattening roles
  expect(() =>
    applyBibliography(cbzBytes, {
      ...cbzPlan,
      assignments: [
        { field: "isbn", value: "9780306406157", evidence: "Print edition" },
      ],
    }),
  ).toThrow(expect.objectContaining({ code: "COMICINFO_ISBN_UNSUPPORTED" }));

  expect(() =>
    applyBibliography(cbzBytes, {
      ...decide(
        auditBibliography(cbzBytes, { modified, format: "cbz" }),
        "retain",
      ),
      assignments: [
        {
          field: "contributors",
          contributors: [
            { name: "山田太郎", role: "aut" },
            { name: "李盈春", role: "trl" },
          ],
          evidence: "Translated credits",
        },
      ],
    }),
  ).toThrow(expect.objectContaining({ code: "COMICINFO_ROLE_UNSUPPORTED" }));

  // Valid CBZ bibliography cleanup + publisher assignment passes xmllint ComicInfo-2.0.xsd
  const retainedPublisher = cbzPlan.findings.find(
    (f) => f.target === "publisher/0",
  )!;
  retainedPublisher.decision = "retain";
  cbzPlan.assignments = [
    {
      field: "publisher",
      value: "海辺出版",
      evidence: "Matched BookWalker edition",
    },
    {
      field: "date",
      value: "2022-05-14",
      evidence: "Matched BookWalker original release date",
    },
  ];
  // Retain date/0 finding since assignment replaces date
  cbzPlan.findings.find((f) => f.target === "date/0")!.decision = "retain";
  await fs.writeFile(cbzPlanFile, JSON.stringify(cbzPlan));

  const cbzCleaned = await cli(
    "bibliography-clean",
    cbzSource,
    "--plan",
    cbzPlanFile,
    "--output",
    cbzOutput,
  );
  expect(cbzCleaned.exitCode, cbzCleaned.stdout + cbzCleaned.stderr).toBe(0);
  expect(JSON.parse(cbzCleaned.stdout)).toMatchObject({
    status: "pass",
    purpose: "file-maintenance",
    validation: { status: "pass" },
  });

  const outEntries = unpack(await fs.readFile(cbzOutput));
  expect(outEntries.get("page-001.jpg")!.bytes.toString()).toBe(
    "preserved manga page bytes",
  );
  const outDoc = xml(
    outEntries.get("ComicInfo.xml")!.bytes.toString("utf8"),
    "ComicInfo.xml",
  );
  const comicVal = (tag: string) =>
    elements(outDoc, tag)[0]?.textContent ?? null;
  expect(comicVal("Title")).toBe("海辺の物語 1");
  expect(comicVal("Summary")).toBe("港町の物語。");
  expect(comicVal("Writer")).toBe("山田太郎");
  expect(comicVal("Penciller")).toBe("佐藤花子");
  expect(comicVal("CoverArtist")).toBe("高橋次郎");
  expect(comicVal("Publisher")).toBe("海辺出版");
  expect(comicVal("Imprint")).toBe("海辺コミックス");
  expect(comicVal("Year")).toBe("2022");
  expect(comicVal("Month")).toBe("5");
  expect(comicVal("Day")).toBe("14");
  expect(comicVal("LanguageISO")).toBe("ja");
  expect(comicVal("Notes")).toBe("Preserved provenance note.");
  expect(comicVal("Manga")).toBe("YesAndRightToLeft");
  expect(comicVal("AgeRating")).toBe("Teen");
  expect(
    auditBibliography(await fs.readFile(cbzOutput), {
      modified,
      format: "cbz",
    }).findings,
  ).toEqual([]);

  // Translator in dirty ComicInfo Writer is flagged without an automatic flatten proposal
  const trlCbz = packArchive(
    new Map([
      ["page.jpg", Buffer.from("img")],
      [
        "ComicInfo.xml",
        Buffer.from(
          "<ComicInfo><Title>Test</Title><Writer>[日] 山田太郎 著；李盈春 译</Writer></ComicInfo>",
        ),
      ],
    ]),
    946684800,
  );
  const trlPlan = auditBibliography(trlCbz, { modified, format: "cbz" });
  expect(trlPlan.findings).toEqual([
    expect.objectContaining({
      rule: "credit-unsupported-role",
      proposed: null,
    }),
  ]);

  const pdfFile = path.join(root, "book.pdf");
  await fs.writeFile(pdfFile, "x");
  const rejected = await cli("bibliography-audit", pdfFile);
  expect(JSON.parse(rejected.stdout)).toMatchObject({
    code: "METADATA_FORMAT",
  });
});

it("refuses to split a credit that other metadata references", async () => {
  const { bytes } = await book((document, metadata) => {
    const creator = metadata.getElementsByTagNameNS(NS.dc, "creator")[0];
    creator.textContent = "张三、李四 编著";
    creator.setAttribute("id", "c1");
    const link = document.createElementNS(NS.opf, "link");
    link.setAttribute("refines", "#c1");
    link.setAttribute("rel", "record");
    link.setAttribute("href", "https://example.com/authority/c1");
    metadata.appendChild(link);
  });
  const plan = decide(auditBibliography(bytes, { modified }));
  expect(plan.findings.map((item) => item.rule)).toEqual(["credit-combined"]);
  expect(() => applyBibliography(bytes, plan)).toThrow(
    expect.objectContaining({ code: "BIBLIOGRAPHY_REFERENCE" }),
  );
});
