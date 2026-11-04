import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import {
  convertKindleToEpub,
  unpackKindle,
} from "../packages/core/src/kindle.js";
import { auditFileSplit, splitEpub } from "../packages/core/src/split.js";
import {
  inspectBytes,
  validateInternal,
} from "../packages/core/src/validate.js";
import { elements, attr, NS } from "../packages/core/src/xml.js";
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
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-kindle-"));
  temporary.push(dir);
  return dir;
}

function u32(value: number) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
}
function palmDocCompress(input: Buffer): Buffer {
  // Valid PalmDOC LZ77 stream using literal runs (0x01..0x08) and direct ASCII (0x09..0x7f).
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const b = input[i];
    if (b >= 0x09 && b <= 0x7f) {
      out.push(b);
      i++;
    } else {
      const end = Math.min(input.length, i + 8);
      let run = 1;
      while (i + run < end && (input[i + run] < 0x09 || input[i + run] > 0x7f))
        run++;
      out.push(run);
      for (let j = 0; j < run; j++) out.push(input[i + j]);
      i += run;
    }
  }
  return Buffer.from(out);
}
function buildExth(records: [number, Buffer | string][]): Buffer {
  const items = records.map(([type, val]) => {
    const data = typeof val === "string" ? Buffer.from(val, "utf8") : val;
    return Buffer.concat([u32(type), u32(data.length + 8), data]);
  });
  const body = Buffer.concat(items);
  const total = 12 + body.length;
  const pad = Buffer.alloc((4 - (total % 4)) % 4);
  return Buffer.concat([
    Buffer.from("EXTH", "ascii"),
    u32(total),
    u32(records.length),
    body,
    pad,
  ]);
}
function buildPdb(records: Buffer[], name = "SampleBook"): Buffer {
  const header = Buffer.alloc(78);
  header.write(name.slice(0, 31), 0, "ascii");
  header.writeUInt32BE(946684800, 36);
  header.writeUInt32BE(946684800, 40);
  header.write("BOOKMOBI", 60, "ascii");
  header.writeUInt16BE(records.length, 76);
  const list = Buffer.alloc(records.length * 8);
  let offset = 78 + list.length + 2;
  for (let i = 0; i < records.length; i++) {
    list.writeUInt32BE(offset, i * 8);
    list.writeUInt32BE(i * 2, i * 8 + 4);
    offset += records[i].length;
  }
  return Buffer.concat([header, list, Buffer.alloc(2), ...records]);
}
function buildRecord0(options: {
  version: number;
  compression?: number;
  encryption?: number;
  textLength: number;
  textRecordCount: number;
  firstImageIndex?: number;
  firstNonBookIndex?: number;
  fdstIndex?: number;
  fdstFlowCount?: number;
  ncxIndex?: number;
  fragIndex?: number;
  skelIndex?: number;
  huffIndex?: number;
  huffCount?: number;
  extraFlags?: number;
  title: string;
  exth: [number, Buffer | string][];
}): Buffer {
  const palm = Buffer.alloc(16);
  palm.writeUInt16BE(options.compression ?? 2, 0);
  palm.writeUInt32BE(options.textLength, 4);
  palm.writeUInt16BE(options.textRecordCount, 8);
  palm.writeUInt16BE(4096, 10);
  palm.writeUInt16BE(options.encryption ?? 0, 12);
  const hdrLen = 264;
  const mobi = Buffer.alloc(hdrLen, 0xff);
  mobi.fill(0, 0, 160);
  mobi.write("MOBI", 0, "ascii");
  mobi.writeUInt32BE(hdrLen, 4);
  mobi.writeUInt32BE(2, 8); // book type
  mobi.writeUInt32BE(65001, 12); // UTF-8
  mobi.writeUInt32BE(0x12345678, 16);
  mobi.writeUInt32BE(options.version, 20);
  mobi.writeUInt32BE(options.firstNonBookIndex ?? 0xffffffff, 64);
  mobi.writeUInt32BE(9, 76); // English locale fallback
  mobi.writeUInt32BE(options.firstImageIndex ?? 0xffffffff, 92);
  mobi.writeUInt32BE(options.huffIndex ?? 0xffffffff, 96);
  mobi.writeUInt32BE(options.huffCount ?? 0, 100);
  mobi.writeUInt32BE(0x40, 112); // EXTH present
  if (options.version >= 8) {
    mobi.writeUInt32BE(options.fdstIndex ?? 0xffffffff, 176);
    mobi.writeUInt32BE(options.fdstFlowCount ?? 1, 180);
  }
  mobi.writeUInt16BE(options.extraFlags ?? 0, 226); // rec0[242]
  mobi.writeUInt32BE(options.ncxIndex ?? 0xffffffff, 228); // rec0[244]
  if (options.version >= 8) {
    mobi.writeUInt32BE(options.fragIndex ?? 0xffffffff, 232); // rec0[248]
    mobi.writeUInt32BE(options.skelIndex ?? 0xffffffff, 236); // rec0[252]
  }
  const exth = buildExth(options.exth);
  const fullName = Buffer.from(options.title, "utf8");
  const fullNameOffset = 16 + hdrLen + exth.length;
  mobi.writeUInt32BE(fullNameOffset, 68);
  mobi.writeUInt32BE(fullName.length, 72);
  return Buffer.concat([palm, mobi, exth, fullName, Buffer.alloc(16)]);
}

async function mobiAnthologyFixture(encryption = 0) {
  const image = await sharp({
    create: { width: 8, height: 12, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const part1 =
    '<html><head><guide><reference type="toc" title="目录" filepos=0000000400 /></guide></head><body>';
  const v1 =
    '<p height="1em" width="0pt"><font size="7"><b>第一卷 起始之章</b></font></p><p>甲卷第一段正文。<img recindex="00001" alt="插图一"/></p><p>甲卷第二段，带内部跳转 <a filepos=0000000093>回到第一卷开头</a>。</p><mbp:pagebreak/>';
  const pos1 = Buffer.byteLength(part1, "utf8");
  const v1Fixed = v1.replace("0000000093", String(pos1).padStart(10, "0"));
  const pos2 = pos1 + Buffer.byteLength(v1Fixed, "utf8");
  const v2 = `<p height="1em" width="0pt"><font size="7"><b>第二卷 远征之章</b></font></p><p>乙卷第一段正文。<a filepos=${String(pos1).padStart(10, "0")}>回顾第一卷</a></p><mbp:pagebreak/>`;
  const tocPos = pos2 + Buffer.byteLength(v2, "utf8");
  const headFixed = part1.replace(
    "0000000400",
    String(tocPos).padStart(10, "0"),
  );
  const toc = `<p align="center"><font size="5"><b>目录</b></font></p><p><a filepos=${String(pos1).padStart(10, "0")}>第一卷 起始之章</a></p><p><a filepos=${String(pos2).padStart(10, "0")}>第二卷 远征之章</a></p></body></html>`;
  const rawHtml = Buffer.from(headFixed + v1Fixed + v2 + toc, "utf8");
  const compressed = palmDocCompress(rawHtml);
  const rec0 = buildRecord0({
    version: 6,
    encryption,
    textLength: rawHtml.length,
    textRecordCount: 1,
    firstNonBookIndex: 2,
    firstImageIndex: 2,
    title: "幻想合订本 (全2册)",
    exth: [
      [503, "幻想合订本 (全2册)"],
      [100, "测试作者"],
      [101, "测试出版社"],
      [103, "第一卷与第二卷合订本简介。"],
      [104, "9780306406157"],
      [106, "2024-05-20"],
      [524, "zh-Hans"],
      [201, u32(0)],
    ],
  });
  return {
    bytes: buildPdb([rec0, compressed, image], "FantasyOmnibus"),
    image,
  };
}

async function azw3AnthologyFixture() {
  const image = await sharp({
    create: { width: 10, height: 14, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  const skel0 =
    '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-Hant"><head><title>第一卷</title><link rel="stylesheet" type="text/css" href="kindle:flow:0001?mime=text/css"/></head><body class="calibre" aid="0"></body></html>\n';
  const frag0 =
    '<h1 id="v1" class="calibre1" aid="1">第一卷 黎明篇</h1><p class="calibre2" aid="2">甲卷內容。<img src="kindle:embed:0001?mime=image/png" alt="卷一圖"/></p><h2 id="v1s2" aid="3">第一卷第二節</h2><p aid="4">甲卷第二節內容。</p>';
  const skel1 =
    '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-Hant"><head><title>第二卷</title><link rel="stylesheet" type="text/css" href="kindle:flow:0001?mime=text/css"/></head><body class="calibre" aid="B0"></body></html>\n';
  const sec2Offset = Buffer.byteLength(
    '<h1 id="v1" class="calibre1" aid="1">第一卷 黎明篇</h1><p class="calibre2" aid="2">甲卷內容。<img src="kindle:embed:0001?mime=image/png" alt="卷一圖"/></p>',
    "utf8",
  );
  const offBase32 = sec2Offset.toString(32).toUpperCase().padStart(10, "0");
  const frag1 = `<h1 id="v2" class="calibre1" aid="B1">第二卷 黃昏篇</h1><p class="calibre2" aid="B2">乙卷內容。<a href="kindle:pos:fid:0000:off:${offBase32}" aid="B3">回第一卷第二節</a></p>`;
  const flow0 = Buffer.from(skel0 + frag0 + skel1 + frag1, "utf8");
  const flow1 = Buffer.from(
    ".calibre { margin: 0; } .calibre1 { font-weight: bold; }\n",
    "utf8",
  );
  const rawText = Buffer.concat([flow0, flow1]);
  const compressed = palmDocCompress(rawText);
  const fdst = Buffer.concat([
    Buffer.from("FDST", "ascii"),
    u32(12),
    u32(2),
    u32(0),
    u32(flow0.length),
    u32(flow0.length),
    u32(rawText.length),
  ]);
  const rec0 = buildRecord0({
    version: 8,
    textLength: rawText.length,
    textRecordCount: 1,
    firstNonBookIndex: 2,
    firstImageIndex: 2,
    fdstIndex: 3,
    fdstFlowCount: 2,
    title: "蒼穹物語 合訂本",
    exth: [
      [503, "蒼穹物語 合訂本"],
      [100, "山田太郎"],
      [101, "青空文庫出版"],
      [103, "KF8 合訂本測試簡介。"],
      [106, "2023-11-01"],
      [524, "zh-Hant"],
    ],
  });
  return {
    bytes: buildPdb([rec0, compressed, image, fdst], "SkyOmnibus"),
    image,
  };
}

it("converts MOBI 6 and AZW3 (KF8) to valid EPUB 3.3 and passes EPUBCheck and reading QA", async () => {
  const dir = await tempDir();
  const mobi = await mobiAnthologyFixture();
  const azw3 = await azw3AnthologyFixture();
  const mobiPath = path.join(dir, "book.mobi"),
    mobiOut = path.join(dir, "from-mobi.epub"),
    azw3Path = path.join(dir, "book.azw3"),
    azw3Out = path.join(dir, "from-azw3.epub");
  await fs.writeFile(mobiPath, mobi.bytes);
  await fs.writeFile(azw3Path, azw3.bytes);

  const mobiResult = await convertKindleToEpub(mobiPath, { output: mobiOut });
  expect(mobiResult.status).toBe("pass");
  expect(mobiResult.format).toBe("mobi6");
  expect(mobiResult.validation.status).toBe("pass");
  expect(mobiResult.reading.status).toBe("pass");
  expect(await fs.readFile(mobiPath)).toEqual(mobi.bytes);
  const mobiEpub = await fs.readFile(mobiOut);
  expect(validateInternal(mobiEpub).status).toBe("pass");
  const mobiInfo = inspectBytes(mobiEpub, true);
  expect(mobiInfo.title).toBe("幻想合订本 (全2册)");
  expect(mobiInfo.language).toBe("zh-Hans");
  expect(
    elements(mobiInfo.packageDocument, "identifier", NS.dc).map(
      (n) => n.textContent,
    ),
  ).toContain("9780306406157");

  const azw3Result = await convertKindleToEpub(azw3Path, { output: azw3Out });
  expect(azw3Result.status).toBe("pass");
  expect(azw3Result.format).toBe("kf8");
  expect(azw3Result.validation.status).toBe("pass");
  expect(azw3Result.reading.status).toBe("pass");
  expect(await fs.readFile(azw3Path)).toEqual(azw3.bytes);
  const azw3Epub = await fs.readFile(azw3Out);
  expect(validateInternal(azw3Epub).status).toBe("pass");
  const azw3Info = inspectBytes(azw3Epub, true);
  expect(azw3Info.title).toBe("蒼穹物語 合訂本");
  expect(azw3Info.language).toBe("zh-Hant");
  // Verify the kindle:pos:fid:0000:off:... link resolved to chapter 1 #v1s2
  const ch2 = azw3Info.documents.get("OEBPS/text/c0002.xhtml")!;
  const links = elements(ch2, "a", NS.xhtml).map((a) => attr(a, "href"));
  expect(links.some((href) => href.endsWith("#v1s2"))).toBe(true);
  // Deterministic repeated unpack
  expect(sha256(unpackKindle(azw3.bytes).bytes)).toBe(sha256(azw3Epub));
});

it("splits MOBI and AZW3 anthologies into independent verified single-volume EPUBs", async () => {
  const dir = await tempDir();
  for (const [ext, fixture] of [
    ["mobi", await mobiAnthologyFixture()],
    ["azw3", await azw3AnthologyFixture()],
  ] as const) {
    const src = path.join(dir, `omnibus.${ext}`),
      planPath = path.join(dir, `plan-${ext}.json`),
      outDir = path.join(dir, `volumes-${ext}`);
    await fs.writeFile(src, fixture.bytes);
    const plan = await auditFileSplit(src, { output: planPath });
    expect(plan.sourceSha256).toBe(sha256(fixture.bytes));
    expect(plan.inventory.units.length).toBeGreaterThanOrEqual(4);
    const v2Start = plan.inventory.units.findIndex((u) =>
      u.text.includes("第二卷"),
    );
    expect(v2Start).toBeGreaterThan(0);
    const firstUnits = plan.inventory.units.slice(0, v2Start);
    const secondUnits = plan.inventory.units.slice(v2Start);
    // Omit cover unit if present before first chapter
    const v1Start = firstUnits.findIndex((u) => u.text.includes("第一卷"));
    const omitted = firstUnits.slice(0, v1Start).map((u) => ({
      unit: u.key,
      reason: "Bundle front matter / cover excluded from single volume.",
    }));
    const v1Units = firstUnits.slice(v1Start);
    plan.omit = omitted;
    plan.crossLinks = [
      ...plan.inventory.units.flatMap((u) =>
        u.path.endsWith("c0002.xhtml") || u.path.endsWith("c0003.xhtml")
          ? []
          : [],
      ),
    ];
    // Collect any cross-volume links from volume 2 back to volume 1
    const unpacked = inspectBytes(unpackKindle(fixture.bytes).bytes);
    const crossLinks: {
      source: string;
      id: string;
      href: string;
      action: "unlink";
      evidence: string;
    }[] = [];
    for (const [docPath, doc] of unpacked.documents) {
      if (!secondUnits.some((u) => u.path === docPath)) continue;
      for (const a of elements(doc, "a", NS.xhtml)) {
        const href = attr(a, "href");
        if (href && !href.startsWith("#"))
          crossLinks.push({
            source: docPath,
            id: attr(a, "id"),
            href,
            action: "unlink",
            evidence:
              "Cross-volume reference to volume 1 unlinked in volume 2.",
          });
      }
    }
    plan.crossLinks = crossLinks;
    plan.volumes = [
      {
        key: "volume-01",
        from: v1Units[0].key,
        through: v1Units.at(-1)!.key,
        boundaryEvidence: "Inspected volume 1 heading and chapter boundary.",
        navigation: [...new Set(v1Units.map((u) => u.path))].map((p, idx) => ({
          unit: v1Units.find((u) => u.path === p)!.key,
          label: `第一卷 第${idx + 1}章`,
        })),
        metadata: {
          identifier: "urn:uuid:10000000-0000-4000-8000-000000000101",
          title: "第一卷",
          language: ext === "mobi" ? "zh-Hans" : "zh-Hant",
          creators: [{ name: "作者", role: "aut" }],
          description: "第一卷简介。",
          publisher: "出版社",
          date: "2024-01-01",
          isbn: null,
          isbnEvidence: "No separate volume ISBN in synthetic fixture.",
          tags: ["Literature.Light Novel", "Literature.Fantasy"],
          series: {
            relation: "story-continuity",
            series: "测试系列",
            position: "1",
            sources: ["book:title-page"],
            evidence: ["Continuing story volume 1."],
            positionEvidence: "Volume 1 heading.",
          },
          cover: null,
          evidence: ["Per-volume metadata verified against source."],
        },
      },
      {
        key: "volume-02",
        from: secondUnits[0].key,
        through: secondUnits.at(-1)!.key,
        boundaryEvidence: "Inspected volume 2 heading and chapter boundary.",
        navigation: [...new Set(secondUnits.map((u) => u.path))].map(
          (p, idx) => ({
            unit: secondUnits.find((u) => u.path === p)!.key,
            label: `第二卷 第${idx + 1}章`,
          }),
        ),
        metadata: {
          identifier: "urn:uuid:10000000-0000-4000-8000-000000000102",
          title: "第二卷",
          language: ext === "mobi" ? "zh-Hans" : "zh-Hant",
          creators: [{ name: "作者", role: "aut" }],
          description: "第二卷简介。",
          publisher: "出版社",
          date: "2024-02-01",
          isbn: null,
          isbnEvidence: "No separate volume ISBN in synthetic fixture.",
          tags: ["Literature.Light Novel", "Literature.Fantasy"],
          series: {
            relation: "story-continuity",
            series: "测试系列",
            position: "2",
            sources: ["book:title-page"],
            evidence: ["Continuing story volume 2."],
            positionEvidence: "Volume 2 heading.",
          },
          cover: null,
          evidence: ["Per-volume metadata verified against source."],
        },
      },
    ];
    const splitResult = await splitEpub(src, { plan, output: outDir });
    expect(splitResult.status).toBe("pass");
    expect(splitResult.volumes).toHaveLength(2);
    for (const vol of splitResult.volumes) {
      expect(vol.validation.status).toBe("pass");
      expect(vol.reading.status).toBe("pass");
    }
    expect(await fs.readFile(src)).toEqual(fixture.bytes);
  }
});

it("refuses DRM-encrypted and malformed Kindle files and CLI collisions", async () => {
  const dir = await tempDir();
  const encrypted = await mobiAnthologyFixture(2);
  const encPath = path.join(dir, "drm.mobi"),
    outPath = path.join(dir, "out.epub");
  await fs.writeFile(encPath, encrypted.bytes);
  await expect(
    convertKindleToEpub(encPath, { output: outPath }),
  ).rejects.toMatchObject({ code: "MOBI_ENCRYPTED" });
  expect(() => unpackKindle(Buffer.from("not a mobi"))).toThrow();

  const cli = path.join(repoRoot, "packages/cli/src/index.ts");
  const good = await mobiAnthologyFixture();
  const srcPath = path.join(dir, "cli.mobi"),
    cliOut = path.join(dir, "cli-out.epub");
  await fs.writeFile(srcPath, good.bytes);
  const res = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      cli,
      "epub",
      "convert",
      srcPath,
      "--output",
      cliOut,
      "--json",
    ],
    { cwd: repoRoot },
  );
  expect(res.exitCode, res.stdout + res.stderr).toBe(0);
  expect(JSON.parse(res.stdout)).toMatchObject({
    status: "pass",
    format: "mobi6",
  });
  // Existing output collision is refused
  const collision = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      cli,
      "epub",
      "convert",
      srcPath,
      "--output",
      cliOut,
      "--json",
    ],
    { cwd: repoRoot },
  );
  expect(collision.exitCode).toBe(1);
  expect(JSON.parse(collision.stdout).code).toBe("OUTPUT_EXISTS");

  // Combo MOBI 6 + KF8 container (EXTH 121 BOUNDARY) prefers KF8 stream
  const mobi = await mobiAnthologyFixture();
  const azw3 = await azw3AnthologyFixture();
  const mobiRecs = (function splitPdb(buf: Buffer) {
    const n = buf.readUInt16BE(76);
    const offs: number[] = [];
    for (let i = 0; i < n; i++) offs.push(buf.readUInt32BE(78 + i * 8));
    offs.push(buf.length);
    return offs.slice(0, n).map((s, i) => buf.subarray(s, offs[i + 1]));
  })(mobi.bytes);
  const azw3Recs = (function splitPdb(buf: Buffer) {
    const n = buf.readUInt16BE(76);
    const offs: number[] = [];
    for (let i = 0; i < n; i++) offs.push(buf.readUInt32BE(78 + i * 8));
    offs.push(buf.length);
    return offs.slice(0, n).map((s, i) => buf.subarray(s, offs[i + 1]));
  })(azw3.bytes);
  const boundaryIdx = mobiRecs.length;
  const comboRec0 = buildRecord0({
    version: 6,
    textLength: 10,
    textRecordCount: 1,
    firstImageIndex: 2,
    title: "Combo MOBI6 fallback",
    exth: [
      [503, "Combo MOBI6 fallback"],
      [121, u32(boundaryIdx)],
    ],
  });
  const comboBytes = buildPdb(
    [
      comboRec0,
      ...mobiRecs.slice(1),
      Buffer.from("BOUNDARY", "ascii"),
      ...azw3Recs,
    ],
    "ComboBook",
  );
  const unpackedCombo = unpackKindle(comboBytes);
  expect(unpackedCombo.format).toBe("combo-kf8");
  expect(unpackedCombo.metadata.title).toBe("蒼穹物語 合訂本");
});
