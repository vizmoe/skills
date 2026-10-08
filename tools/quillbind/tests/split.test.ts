import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import {
  auditSplit,
  applySplit,
  splitEpub,
  type SplitPlan,
} from "../packages/core/src/split.js";
import { pack } from "../packages/core/src/zip.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { describeInspection } from "../packages/core/src/inspection.js";
import { elements, attr, NS } from "../packages/core/src/xml.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { sha256 } from "../packages/core/src/hash.js";
import { run } from "../packages/core/src/process.js";
import { serialize } from "../packages/core/src/xml.js";

function edit(bytes: Buffer, name: string, change: (value: string) => string) {
  const info = inspectBytes(bytes),
    entries = new Map(
      [...info.entries].map(([key, entry]) => [key, entry.bytes]),
    );
  entries.set(name, Buffer.from(change(entries.get(name)!.toString())));
  return pack(entries, 946684800);
}

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function root() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "quillbind-split-test-"),
  );
  temporary.push(directory);
  return directory;
}
async function anthology(cross = false) {
  const image = await sharp({
    create: { width: 8, height: 12, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const entries = new Map<string, Buffer>();
  const put = (name: string, text: string) =>
    entries.set(name, Buffer.from(text));
  put("mimetype", "application/epub+zip");
  put(
    "META-INF/container.xml",
    `<container xmlns="${NS.container}" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  put(
    "OEBPS/book.opf",
    `<package xmlns="${NS.opf}" xmlns:dc="${NS.dc}" version="3.0" unique-identifier="uid"><metadata><dc:identifier id="uid">urn:uuid:ffffffff-ffff-4fff-8fff-ffffffffffff</dc:identifier><dc:identifier>9780201633610</dc:identifier><dc:title>Bundle (全2冊)</dc:title><dc:creator>Bundle editor</dc:creator><dc:language>zh-Hant</dc:language><dc:description>Bundle description</dc:description><dc:subject>Bundle tag</dc:subject><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta><meta name="calibre:series" content="Marketing bundle"/><meta name="cover" content="bundle-cover"/></metadata><manifest><item id="shared" href="text/shared.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="styles/book.css" media-type="text/css"/><item id="one" href="images/one.png" media-type="image/png"/><item id="two" href="images/two.png" media-type="image/png"/><item id="bundle-cover" href="images/bundle.png" media-type="image/png" properties="cover-image"/><item id="unused" href="unused.css" media-type="text/css"/></manifest><spine><itemref idref="shared"/></spine></package>`,
  );
  const xhtml = (title: string, body: string) =>
    `<html xmlns="${NS.xhtml}" xmlns:epub="${NS.epub}" xml:lang="zh-Hant"><head><title>${title}</title><link rel="stylesheet" type="text/css" href="../styles/book.css"/></head><body>${body}</body></html>`;
  put(
    "OEBPS/text/shared.xhtml",
    xhtml(
      "Bundle",
      `<section><h1 id="v1">第一卷</h1><p id="c1">甲卷正文。<a epub:type="noteref" id="r1" href="notes.xhtml#n1">1</a><img src="../images/one.png" alt="one"/>${cross ? '<a id="cross" href="#v2">下一卷</a>' : ""}</p><h1 id="v2">第二卷</h1><p id="c2">乙卷正文。<a epub:type="noteref" id="r2" href="notes.xhtml#n2">2</a><img src="../images/two.png" alt="two"/></p></section>`,
    ),
  );
  put(
    "OEBPS/text/notes.xhtml",
    xhtml(
      "Notes",
      '<aside epub:type="footnote" id="n1"><p>甲卷注释。<a href="shared.xhtml#r1">返回一</a></p></aside><aside epub:type="footnote" id="n2"><p>乙卷注释。<a href="shared.xhtml#r2">返回二</a></p></aside>',
    ),
  );
  put(
    "OEBPS/nav.xhtml",
    `<html xmlns="${NS.xhtml}" xmlns:epub="${NS.epub}"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="text/shared.xhtml#v1">第一卷</a></li><li><a href="text/shared.xhtml#v2">第二卷</a></li></ol></nav></body></html>`,
  );
  put("OEBPS/styles/book.css", "img { max-width:100%; height:auto; }\n");
  put("OEBPS/unused.css", ".unused { color:red; }");
  for (const name of ["one", "two", "bundle"])
    entries.set(`OEBPS/images/${name}.png`, image);
  return pack(entries, 946684800);
}
async function reviewed(bytes: Buffer): Promise<SplitPlan> {
  const plan = await auditSplit(bytes, { modified: "2026-10-08T00:00:00Z" });
  const unit = (anchor: string) =>
    plan.inventory.units.find((item) => item.anchors.includes(anchor))!.key;
  plan.volumes = [1, 2].map((number) => ({
    key: `volume-${number}`,
    from: unit(`v${number}`),
    through: unit(`c${number}`),
    boundaryEvidence: `Inspected source TOC and heading v${number}; separate complete volume.`,
    navigation: [{ unit: unit(`v${number}`), label: `第${number}卷` }],
    metadata: {
      identifier: `urn:uuid:00000000-0000-4000-8000-00000000000${number}`,
      title: `第${number}卷`,
      language: "zh-Hant",
      creators: [{ name: `Author ${number}`, role: "aut" as const }],
      description: `Volume ${number} description.\n\nSecond paragraph.`,
      publisher: "Fixture Publisher",
      date: "2001-02-03",
      isbn: number === 1 ? "9780131103627" : "9780306406157",
      isbnEvidence: "Matched synthetic per-volume copyright page",
      tags: ["Literature.Light Novel"],
      series: null,
      cover: null,
      evidence: [
        "Synthetic per-volume title/copyright pages inspected; bundle fields excluded.",
      ],
    },
  }));
  return plan;
}
it("splits anchored volumes sharing one XHTML while preserving text, order, resource closure and note returns", async () => {
  const bytes = await anthology(),
    plan = await reviewed(bytes),
    result = await applySplit(bytes, plan);
  expect(result.volumes).toHaveLength(2);
  expect(result.report.unassigned).toEqual([]);
  expect(result.report.duplicates).toEqual([]);
  for (const [index, volume] of result.volumes.entries()) {
    const info = inspectBytes(volume.bytes, true),
      inspection = describeInspection(info, volume.bytes.length),
      own = index === 0 ? "甲" : "乙",
      other = index === 0 ? "乙" : "甲";
    expect(info.title).toBe(plan.volumes[index].metadata.title);
    expect(
      elements(info.packageDocument, "identifier", NS.dc).map(
        (node) => node.textContent,
      ),
    ).toEqual([
      plan.volumes[index].metadata.identifier,
      plan.volumes[index].metadata.isbn,
    ]);
    expect(
      elements(info.packageDocument, "description", NS.dc)[0].textContent,
    ).toBe(plan.volumes[index].metadata.description);
    expect(
      elements(info.packageDocument, "subject", NS.dc).map(
        (node) => node.textContent,
      ),
    ).toEqual(["Literature.Light Novel"]);
    expect(
      elements(info.packageDocument, "meta", NS.opf).some(
        (node) =>
          attr(node, "name") === "calibre:series" ||
          attr(node, "name") === "cover",
      ),
    ).toBe(false);
    const body = info.entries.get("OEBPS/text/shared.xhtml")!.bytes.toString();
    expect(body).toContain(`${own}卷正文。`);
    expect(body).not.toContain(`${other}卷正文。`);
    expect(
      info.entries.has(`OEBPS/images/${index === 0 ? "one" : "two"}.png`),
    ).toBe(true);
    expect(
      info.entries.has(`OEBPS/images/${index === 0 ? "two" : "one"}.png`),
    ).toBe(false);
    expect(info.entries.has("OEBPS/unused.css")).toBe(false);
    expect(info.entries.has("OEBPS/images/bundle.png")).toBe(false);
    const notes = info.entries.get("OEBPS/text/notes.xhtml")!.bytes.toString();
    expect(notes).toContain(`${own}卷注释。`);
    expect(notes).not.toContain(`${other}卷注释。`);
    expect(inspection.notes.references).toHaveLength(1);
    expect(inspection.notes.issues).toEqual([]);
    expect(inspection.brokenReferences).toEqual([]);
    expect(volume.report.units).toEqual(
      plan.inventory.units
        .filter(
          (unit) =>
            unit.key === plan.volumes[index].from ||
            unit.key === plan.volumes[index].through,
        )
        .map((unit) => unit.key),
    );
  }
});
it("requires complete source coverage, independent identities, reliable boundaries and unchanged source/vocabulary inventories", async () => {
  const bytes = await anthology(),
    plan = await reviewed(bytes);
  await expect(
    applySplit(bytes, { ...plan, sourceSha256: "0".repeat(64) }),
  ).rejects.toThrow(/hash|source/i);
  await expect(
    applySplit(bytes, { ...plan, volumes: [plan.volumes[0]] }),
  ).rejects.toThrow(/unassigned|coverage/i);
  await expect(
    applySplit(bytes, {
      ...plan,
      volumes: [
        plan.volumes[0],
        { ...plan.volumes[1], from: plan.volumes[0].from },
      ],
    }),
  ).rejects.toThrow(/duplicate|overlap/i);
  const identities = structuredClone(plan);
  identities.volumes[1].metadata.identifier =
    identities.volumes[0].metadata.identifier;
  await expect(applySplit(bytes, identities)).rejects.toThrow(
    /identity|identifier/i,
  );
  await expect(
    applySplit(bytes, { ...plan, vocabularyVersion: "stale" }),
  ).rejects.toThrow(/vocabulary/i);
  const changed = structuredClone(plan);
  changed.inventory.units[0].sha256 = "0".repeat(64);
  await expect(applySplit(bytes, changed)).rejects.toThrow(/inventory/i);
});
it("requires an explicit disposition for an ordinary cross-volume link and retains its visible text", async () => {
  const bytes = await anthology(true),
    plan = await reviewed(bytes);
  await expect(applySplit(bytes, plan)).rejects.toThrow(/cross.volume/i);
  plan.crossLinks = [
    {
      source: "OEBPS/text/shared.xhtml",
      id: "cross",
      href: "#v2",
      action: "unlink",
      evidence:
        "Target is in the other independently delivered volume; retain its visible wording.",
    },
  ];
  const result = await applySplit(bytes, plan);
  const document = inspectBytes(result.volumes[0].bytes).documents.get(
    "OEBPS/text/shared.xhtml",
  )!;
  expect(document.documentElement!.textContent).toContain("下一卷");
  expect(
    elements(document, "a").some((node) => attr(node, "id") === "cross"),
  ).toBe(false);
  expect(result.volumes[0].report.crossLinks).toHaveLength(1);
});
it("delivers all volumes only after actual EPUBCheck, reading and reference verification, keeping the source and refusing collisions", async () => {
  const directory = await root(),
    bytes = await anthology(),
    plan = await reviewed(bytes),
    source = path.join(directory, "bundle.epub"),
    output = path.join(directory, "volumes");
  await fs.writeFile(source, bytes);
  const planFile = path.join(directory, "plan.json"),
    cli = path.join(repoRoot, "packages/cli/src/index.ts");
  const audit = await run(process.execPath, [
    "--import",
    "tsx",
    cli,
    "epub",
    "split-plan",
    source,
    "--output",
    planFile,
    "--json",
  ]);
  expect(audit.exitCode, audit.stdout + audit.stderr).toBe(0);
  expect(JSON.parse(await fs.readFile(planFile, "utf8")).sourceSha256).toBe(
    sha256(bytes),
  );
  await fs.writeFile(planFile, JSON.stringify(plan));
  const delivery = await run(process.execPath, [
    "--import",
    "tsx",
    cli,
    "epub",
    "split",
    source,
    "--plan",
    planFile,
    "--output",
    output,
    "--json",
  ]);
  expect(delivery.exitCode, delivery.stdout + delivery.stderr).toBe(0);
  const result = JSON.parse(delivery.stdout) as Awaited<
    ReturnType<typeof splitEpub>
  >;
  expect(result.status).toBe("pass");
  expect(result.volumes).toHaveLength(2);
  for (const item of result.volumes) {
    expect(item.validation.status).toBe("pass");
    expect(item.reading.status).toBe("pass");
    expect(sha256(await fs.readFile(item.output))).toBe(item.sha256);
  }
  expect(await fs.readFile(source)).toEqual(bytes);
  await fs.cp(result.reports, path.join(repoRoot, "dist/split-tests"), {
    recursive: true,
    force: true,
  });
  await expect(splitEpub(source, { plan, output })).rejects.toThrow(/exist/i);
});

it("requires independent cover evidence and validates the retained volume cover through the real display gate", async () => {
  const info = inspectBytes(await anthology()),
    entries = new Map(
      [...info.entries].map(([name, entry]) => [name, entry.bytes]),
    ),
    manifest = elements(info.packageDocument, "manifest", NS.opf)[0],
    spine = elements(info.packageDocument, "spine", NS.opf)[0];
  const item = info.packageDocument.createElementNS(NS.opf, "item");
  item.setAttribute("id", "cover-page");
  item.setAttribute("href", "cover.xhtml");
  item.setAttribute("media-type", "application/xhtml+xml");
  manifest.appendChild(item);
  const itemref = info.packageDocument.createElementNS(NS.opf, "itemref");
  itemref.setAttribute("idref", "cover-page");
  spine.insertBefore(itemref, spine.firstChild);
  const guide = info.packageDocument.createElementNS(NS.opf, "guide"),
    reference = info.packageDocument.createElementNS(NS.opf, "reference");
  reference.setAttribute("type", "cover");
  reference.setAttribute("title", "Cover");
  reference.setAttribute("href", "cover.xhtml");
  guide.appendChild(reference);
  info.packageDocument.documentElement!.appendChild(guide);
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  entries.set(
    "OEBPS/cover.xhtml",
    Buffer.from(
      `<html xmlns="${NS.xhtml}"><head><title>Cover</title><style>html,body{margin:0;padding:0}img{width:auto;height:auto;max-width:100%;max-height:100vh}</style></head><body><div><img id="cover-raster" src="images/one.png" alt="Cover"/></div></body></html>`,
    ),
  );
  const bytes = pack(entries, 946684800),
    plan = await reviewed(bytes);
  plan.volumes[0].from = plan.inventory.units[0].key;
  plan.volumes[0].navigation.unshift({
    unit: plan.volumes[0].from,
    label: "Volume one cover",
  });
  await expect(applySplit(bytes, plan).then(() => null)).rejects.toThrow(
    /bundle cover/i,
  );
  plan.volumes[0].metadata.cover = {
    image: "OEBPS/images/one.png",
    document: "OEBPS/cover.xhtml",
    evidence:
      "Inspected synthetic volume-one cover; the separate bundle cover is not adopted.",
  };
  const directory = await root(),
    source = path.join(directory, "bundle.epub");
  await fs.writeFile(source, bytes);
  const result = await splitEpub(source, {
    plan,
    output: path.join(directory, "volumes"),
  });
  expect(result.volumes[0].cover?.status).toBe("pass");
  expect(result.volumes[1].cover).toBeNull();
});

it("keeps a linked image as a resource instead of treating it as a missing chapter or note", async () => {
  const bytes = edit(await anthology(), "OEBPS/text/shared.xhtml", (text) =>
      text.replace(
        "甲卷正文。",
        '甲卷正文。<a href="../images/one.png">打开插图</a>',
      ),
    ),
    plan = await reviewed(bytes);
  const result = await applySplit(bytes, plan);
  expect(
    inspectBytes(result.volumes[0].bytes).entries.has("OEBPS/images/one.png"),
  ).toBe(true);
});
it("does not silently retarget a shared ancestor anchor to the other volume", async () => {
  const bytes = edit(await anthology(), "OEBPS/text/shared.xhtml", (text) =>
      text
        .replace("<section>", '<section id="bundle-start">')
        .replace(
          "乙卷正文。",
          '乙卷正文。<a id="parent-link" href="#bundle-start">返回套书开头</a>',
        ),
    ),
    plan = await reviewed(bytes);
  await expect(applySplit(bytes, plan).then(() => null)).rejects.toThrow(
    /cross.volume/i,
  );
  plan.crossLinks = [
    {
      source: "OEBPS/text/shared.xhtml",
      id: "parent-link",
      href: "#bundle-start",
      action: "unlink",
      evidence:
        "The ancestor anchor starts in volume one; preserve only visible wording in volume two.",
    },
  ];
  const result = await applySplit(bytes, plan);
  expect(
    elements(
      inspectBytes(result.volumes[0].bytes).documents.get(
        "OEBPS/text/shared.xhtml",
      )!,
    ).some((node) => attr(node, "id") === "bundle-start"),
  ).toBe(true);
  expect(
    elements(
      inspectBytes(result.volumes[1].bytes).documents.get(
        "OEBPS/text/shared.xhtml",
      )!,
    ).some((node) => attr(node, "id") === "bundle-start"),
  ).toBe(false);
});

it("copies a shared note only where referenced and retains each volume's valid return link", async () => {
  let bytes = edit(await anthology(), "OEBPS/text/shared.xhtml", (text) =>
    text.replace('href="notes.xhtml#n2"', 'href="notes.xhtml#n1"'),
  );
  bytes = edit(bytes, "OEBPS/text/notes.xhtml", (text) =>
    text.replace(
      "返回一</a>",
      '返回一</a><a href="shared.xhtml#r2">返回二</a>',
    ),
  );
  const plan = await reviewed(bytes);
  plan.omitNotes = [
    {
      key: "OEBPS/text/notes.xhtml#n2",
      reason:
        "Unreferenced redundant source note; both chapters explicitly refer to n1.",
    },
  ];
  const result = await applySplit(bytes, plan);
  for (const [index, volume] of result.volumes.entries()) {
    const info = inspectBytes(volume.bytes),
      notes = info.documents.get("OEBPS/text/notes.xhtml")!,
      links = elements(notes, "a").map((node) => attr(node, "href"));
    expect(links).toEqual([`shared.xhtml#r${index + 1}`]);
    expect(notes.documentElement!.textContent).toContain("甲卷注释。");
    expect(volume.report.noteReturns).toHaveLength(1);
    expect(describeInspection(info, volume.bytes.length).notes.issues).toEqual(
      [],
    );
  }
});
it("keeps imported styles and font bytes through resource closure without claiming font rendering coverage", async () => {
  const info = inspectBytes(await anthology()),
    entries = new Map(
      [...info.entries].map(([name, entry]) => [name, entry.bytes]),
    );
  const manifest = elements(info.packageDocument, "manifest", NS.opf)[0];
  for (const [id, href, type] of [
    ["import", "styles/import.css", "text/css"],
    ["font", "fonts/fixture.woff2", "font/woff2"],
  ]) {
    const item = info.packageDocument.createElementNS(NS.opf, "item");
    item.setAttribute("id", id);
    item.setAttribute("href", href);
    item.setAttribute("media-type", type);
    manifest.appendChild(item);
  }
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  entries.set("OEBPS/styles/book.css", Buffer.from('@import "import.css";'));
  entries.set(
    "OEBPS/styles/import.css",
    Buffer.from(
      "@font-face {font-family: Fixture; src:url(../fonts/fixture.woff2)}",
    ),
  );
  const font = Buffer.from(
    "opaque font payload for graph/byte-preservation testing only",
  );
  entries.set("OEBPS/fonts/fixture.woff2", font);
  const bytes = pack(entries, 946684800),
    result = await applySplit(bytes, await reviewed(bytes));
  for (const volume of result.volumes) {
    const output = inspectBytes(volume.bytes);
    expect(output.entries.get("OEBPS/fonts/fixture.woff2")!.bytes).toEqual(
      font,
    );
    expect(output.entries.has("OEBPS/styles/import.css")).toBe(true);
  }
});
it("extracts a selected volume only with explicit content and unused-note exclusions", async () => {
  const bytes = await anthology(),
    plan = await reviewed(bytes);
  plan.volumes = plan.volumes.slice(0, 1);
  plan.omit = plan.inventory.units.slice(2).map((unit) => ({
    unit: unit.key,
    reason: "Only volume one selected; original anthology is retained.",
  }));
  await expect(applySplit(bytes, plan).then(() => null)).rejects.toThrow(
    /unassigned source note/i,
  );
  plan.omitNotes = [
    {
      key: "OEBPS/text/notes.xhtml#n2",
      reason: "Belongs to excluded volume two, preserved in original.",
    },
  ];
  const result = await applySplit(bytes, plan);
  expect(result.volumes).toHaveLength(1);
  expect(result.report.omitted).toHaveLength(2);
});
it("rejects ambiguous shared-document cuts and protected or malformed sources", async () => {
  let bytes = edit(await anthology(), "OEBPS/text/shared.xhtml", (text) =>
    text.replace('id="v2"', ""),
  );
  bytes = edit(bytes, "OEBPS/nav.xhtml", (text) => text.replace("#v2", "#c2"));
  const prior = await reviewed(await anthology()),
    plan = { ...(await auditSplit(bytes)), volumes: prior.volumes };
  await expect(applySplit(bytes, plan).then(() => null)).rejects.toThrow(
    /reliable|boundary|anchor/i,
  );
  const mixed = edit(await anthology(), "OEBPS/text/shared.xhtml", (text) =>
    text.replace("<section>", "<section>unwrapped text"),
  );
  await expect(auditSplit(mixed)).rejects.toThrow(/mixed container/i);
  const info = inspectBytes(await anthology()),
    entries = new Map(
      [...info.entries].map(([name, entry]) => [name, entry.bytes]),
    );
  entries.set("META-INF/signatures.xml", Buffer.from("<signature/>"));
  await expect(auditSplit(pack(entries, 946684800))).rejects.toThrow(
    /protected|unsupported/i,
  );
});
it("requires per-volume ISBN evidence, valid dates, exact library tags and navigation in reading order", async () => {
  const bytes = await anthology(),
    plan = await reviewed(bytes);
  for (const change of [
    (p: SplitPlan) => {
      p.volumes[0].metadata.isbn = "9780000000000";
    },
    (p: SplitPlan) => {
      p.volumes[0].metadata.isbnEvidence = "";
    },
    (p: SplitPlan) => {
      p.volumes[0].metadata.date = "2026-02-31";
    },
    (p: SplitPlan) => {
      p.volumes[0].metadata.tags = ["Invented.New Tag"];
    },
    (p: SplitPlan) => {
      p.volumes[0].navigation = [
        { unit: p.volumes[1].from, label: "Wrong volume" },
      ];
    },
  ]) {
    const changed = structuredClone(plan);
    change(changed);
    await expect(applySplit(bytes, changed).then(() => null)).rejects.toThrow();
  }
  plan.volumes[0].metadata.isbn = null;
  plan.volumes[0].metadata.isbnEvidence =
    "Inspected matched synthetic bibliography; no reliable volume ISBN is supplied.";
  plan.volumes[0].metadata.date = "2001";
  const result = await applySplit(bytes, plan);
  expect(
    elements(
      inspectBytes(result.volumes[0].bytes).packageDocument,
      "date",
      NS.dc,
    )[0].textContent,
  ).toBe("2001");
});
it("preserves EPUB 2 while delivering an independently identified reading copy with real checks", async () => {
  const bytes = await fs.readFile(
      path.join(repoRoot, "examples/repair/legacy.epub"),
    ),
    plan = await auditSplit(bytes),
    template = (await reviewed(await anthology())).volumes[0];
  template.from = plan.inventory.units[0].key;
  template.through = plan.inventory.units.at(-1)!.key;
  template.navigation = [
    ...new Set(plan.inventory.units.map((unit) => unit.path)),
  ].map((name, index) => ({
    unit: plan.inventory.units.find((unit) => unit.path === name)!.key,
    label: `Source section ${index + 1}`,
  }));
  plan.volumes = [template];
  const directory = await root(),
    source = path.join(directory, "legacy.epub");
  await fs.writeFile(source, bytes);
  const result = await splitEpub(source, {
    plan,
    output: path.join(directory, "volumes"),
  });
  expect(
    inspectBytes(await fs.readFile(result.volumes[0].output)).version,
  ).toBe("2.0");
  expect(result.volumes[0].validation.status).toBe("pass");
  expect(result.volumes[0].reading.status).toBe("pass");
});
it("publishes no volumes if a later volume fails the real EPUB format gate", async () => {
  const bytes = edit(await anthology(), "OEBPS/text/shared.xhtml", (text) =>
      text.replace(
        "乙卷正文。",
        "乙卷正文。<div>Invalid paragraph child</div>",
      ),
    ),
    plan = await reviewed(bytes),
    directory = await root(),
    source = path.join(directory, "source.epub"),
    output = path.join(directory, "volumes");
  await fs.writeFile(source, bytes);
  await expect(splitEpub(source, { plan, output })).rejects.toThrow(
    /EPUBCheck/i,
  );
  await expect(fs.stat(output)).rejects.toThrow(/ENOENT/);
  expect(await fs.readFile(source)).toEqual(bytes);
});

it("retains non-linear spine semantics and writes evidenced fractional story order without inheriting the bundle series", async () => {
  const bytes = edit(await anthology(), "OEBPS/book.opf", (text) =>
      text.replace('idref="shared"', 'idref="shared" linear="no"'),
    ),
    plan = await reviewed(bytes);
  plan.volumes[0].metadata.series = {
    relation: "shared-protagonist-world",
    series: "Example 三部曲（全3冊）",
    position: "0.5",
    sources: ["Synthetic original title and chronology"],
    evidence: ["The volume shares the established protagonist and world."],
    positionEvidence:
      "Explicit prequel position in the synthetic reading-order list",
  };
  const result = await applySplit(bytes, plan),
    document = inspectBytes(result.volumes[0].bytes).packageDocument;
  expect(attr(elements(document, "itemref", NS.opf)[0], "linear")).toBe("no");
  expect(
    elements(document, "meta", NS.opf).find(
      (node) => attr(node, "property") === "belongs-to-collection",
    )!.textContent,
  ).toBe("Example 三部曲");
  expect(
    elements(document, "meta", NS.opf).find(
      (node) => attr(node, "property") === "group-position",
    )!.textContent,
  ).toBe("0.5");
});
it("can retain an unknown contributor as absent with recorded evidence instead of inventing a name", async () => {
  const bytes = await anthology(),
    plan = await reviewed(bytes);
  plan.volumes[0].metadata.creators = [];
  plan.volumes[0].metadata.evidence.push(
    "The synthetic matched title/copyright pages do not credit any contributor; no name has been invented.",
  );
  const result = await applySplit(bytes, plan);
  expect(
    elements(
      inspectBytes(result.volumes[0].bytes).packageDocument,
      "creator",
      NS.dc,
    ),
  ).toEqual([]);
});

it.each(["shared.xhtml", ""])(
  "treats fragmentless href=%s as a link to the original document beginning",
  async (destination) => {
    const bytes = edit(await anthology(), "OEBPS/text/shared.xhtml", (text) =>
        text.replace(
          "乙卷正文。",
          `乙卷正文。<a id="document-start" href="${destination}">套书开头</a>`,
        ),
      ),
      plan = await reviewed(bytes);
    await expect(applySplit(bytes, plan).then(() => null)).rejects.toThrow(
      /cross.volume/i,
    );
    plan.crossLinks = [
      {
        source: "OEBPS/text/shared.xhtml",
        id: "document-start",
        href: destination,
        action: "unlink",
        evidence:
          "Original document begins in volume one; this wording in volume two must not point to a new beginning.",
      },
    ];
    expect(
      (await applySplit(bytes, plan)).volumes[1].report.crossLinks,
    ).toHaveLength(1);
  },
);

it.each(["uid", "person0", "isbn", "series"])(
  "keeps package IDs unique when a retained resource already uses %s",
  async (collision) => {
    const info = inspectBytes(await anthology()),
      document = info.packageDocument;
    elements(document, "identifier", NS.dc)
      .find((node) => attr(node, "id") === "uid")!
      .setAttribute("id", "bundle-identity");
    document.documentElement!.setAttribute(
      "unique-identifier",
      "bundle-identity",
    );
    elements(document, "item", NS.opf)
      .find((node) => attr(node, "id") === "one")!
      .setAttribute("id", collision);
    const bytes = edit(await anthology(), info.packagePath, () =>
        serialize(document),
      ),
      plan = await reviewed(bytes);
    plan.volumes[0].metadata.series = {
      relation: "story-continuity",
      series: "Fixture Story",
      position: "1",
      positionEvidence: "Explicit first volume",
      sources: ["Synthetic contents"],
      evidence: ["Continuous narrative in fixture."],
    };
    const result = await applySplit(bytes, plan),
      opf = inspectBytes(result.volumes[0].bytes).packageDocument,
      ids = elements(opf)
        .map((node) => attr(node, "id"))
        .filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    const primary = attr(opf.documentElement!, "unique-identifier");
    expect(
      elements(opf, "identifier", NS.dc).find(
        (node) => attr(node, "id") === primary,
      )!.textContent,
    ).toBe(plan.volumes[0].metadata.identifier);
  },
);
it.each([
  '<style>p { background-image:image-set("../images/one.png" 1x); }</style>',
  "<p style=\"background-image:image-set('../images/one.png' 1x)\">Inline CSS</p>",
])("refuses uninspectable inline CSS resource forms", async (markup) => {
  const bytes = edit(await anthology(), "OEBPS/text/shared.xhtml", (text) =>
    text
      .replace(
        "</head>",
        `${markup.startsWith("<style>") ? markup : ""}</head>`,
      )
      .replace(
        '<p id="c1">',
        `${markup.startsWith("<p") ? markup : ""}<p id="c1">`,
      ),
  );
  await expect(auditSplit(bytes).then(() => null)).rejects.toThrow(
    /CSS|resource/i,
  );
});
