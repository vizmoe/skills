import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  auditCover,
  applyCover,
  adoptCover,
} from "../packages/core/src/covers.js";
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
import { repoRoot } from "../packages/core/src/runtime.js";
import { checkEpubConformance } from "../packages/core/src/validate.js";
import { encodePage, jxlTools } from "../packages/core/src/manga-jxl.js";
import { run } from "../packages/core/src/process.js";
import { coverQa } from "../packages/core/src/cover-qa.js";
import { coverImage } from "../packages/core/src/cover-image.js";
import { deliverMetadata } from "../packages/core/src/metadata-file.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function image(width = 120, height = 180) {
  const samples = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      samples[at] = x === 0 || x === width - 1 ? 255 : 40;
      samples[at + 1] = y === 0 || y === height - 1 ? 255 : 80;
      samples[at + 2] = 140;
    }
  return sharp(samples, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}
async function fixture(existing = true, legacy = false) {
  const root = await copyBook();
  temporary.push(root);
  const info = inspectBytes(
    legacy
      ? await fs.readFile(path.join(repoRoot, "examples/repair/legacy.epub"))
      : await candidate(root),
  );
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  if (existing) {
    const folder = path.posix.dirname(info.packagePath),
      manifest = elements(info.packageDocument, "manifest", NS.opf)[0],
      spine = elements(info.packageDocument, "spine", NS.opf)[0],
      metadata = elements(info.packageDocument, "metadata", NS.opf)[0];
    for (const [id, href, type] of [
      ["cover-image", "cover.png", "image/png"],
      ["cover-page", "cover.xhtml", "application/xhtml+xml"],
    ]) {
      const item = info.packageDocument.createElementNS(NS.opf, "item");
      item.setAttribute("id", id);
      item.setAttribute("href", href);
      item.setAttribute("media-type", type);
      if (!legacy && id === "cover-image")
        item.setAttribute("properties", "cover-image");
      manifest.appendChild(item);
    }
    const itemref = info.packageDocument.createElementNS(NS.opf, "itemref");
    itemref.setAttribute("idref", "cover-page");
    spine.insertBefore(itemref, spine.firstChild);
    const meta = info.packageDocument.createElementNS(NS.opf, "meta");
    meta.setAttribute("name", "cover");
    meta.setAttribute("content", "cover-image");
    metadata.appendChild(meta);
    const guide = info.packageDocument.createElementNS(NS.opf, "guide"),
      reference = info.packageDocument.createElementNS(NS.opf, "reference");
    reference.setAttribute("type", "cover");
    reference.setAttribute("title", "Cover");
    reference.setAttribute("href", "cover.xhtml");
    guide.appendChild(reference);
    info.packageDocument.documentElement!.appendChild(guide);
    entries.set(`${folder}/cover.png`, await image(80, 120));
    entries.set(
      `${folder}/cover.xhtml`,
      Buffer.from(
        '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title><style>html,body{margin:0}div{width:100px;height:80px;overflow:hidden}img{width:100px;height:80px;object-fit:cover}</style></head><body><div><img src="cover.png" alt="Cover"/></div></body></html>',
      ),
    );
  }
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  return { root, bytes: pack(entries, 946684800) };
}
async function planFor(bytes: Buffer, format: "epub" | "cbz", cover: Buffer) {
  const plan = await auditCover(bytes, format, {
    image: cover,
    modified: "2026-10-08T00:00:00Z",
  });
  plan.evidence = {
    source: "https://publisher.example/matched-edition",
    edition:
      "Synthetic fixture: title, credited author, language and volume match.",
    visual:
      "Inspected the full image, edge markers, text area, geometry and resolution; no added borders or cropping.",
    reason: "Complete edition-matched source image",
    pageOrder:
      format === "cbz"
        ? "Confirmed displayed page order against ComicInfo and archive inventory"
        : null,
  };
  return plan;
}
it.each([
  [120, 180],
  [240, 100],
])(
  "preserves %sx%s image bytes and geometry while fixing the selected EPUB cover page",
  async (width, height) => {
    const { bytes } = await fixture(),
      cover = await image(width, height),
      plan = await planFor(bytes, "epub", cover),
      before = inspectBytes(bytes);
    const result = await applyCover(bytes, cover, plan),
      after = inspectBytes(result.bytes, true);
    expect(result.report.image.sha256).toBe(sha256(cover));
    expect(result.report.image.width).toBe(width);
    expect(result.report.image.height).toBe(height);
    expect(after.entries.get(result.report.imagePath)?.bytes).toEqual(cover);
    expect(result.report.changedMembers).toContain(before.packagePath);
    for (const [name, entry] of before.entries)
      if (!result.report.changedMembers.includes(name))
        expect(after.entries.get(name)?.bytes).toEqual(entry.bytes);
    for (const field of [
      "title",
      "identifier",
      "description",
      "creator",
      "subject",
    ])
      expect(
        elements(after.packageDocument, field, NS.dc).map(serialize),
      ).toEqual(elements(before.packageDocument, field, NS.dc).map(serialize));
    expect(
      after.entries.get(result.report.documentPath!)!.bytes.toString(),
    ).toContain("object-fit: contain");
    expect(
      after.entries.get(result.report.documentPath!)!.bytes.toString(),
    ).not.toContain("overflow:hidden");
  },
);
it("requires actual candidate/edition review, protects image/source bindings and rejects body text as a replaceable cover page", async () => {
  const { bytes } = await fixture(),
    cover = await image(),
    plan = await auditCover(bytes, "epub", { image: cover });
  await expect(applyCover(bytes, cover, plan)).rejects.toThrow(
    /review|evidence/i,
  );
  const approved = await planFor(bytes, "epub", cover);
  await expect(
    applyCover(bytes, await image(30, 30), approved),
  ).rejects.toThrow(/image|hash/i);
  await expect(
    applyCover(bytes, cover, { ...approved, sourceSha256: "0".repeat(64) }),
  ).rejects.toThrow(/source|hash/i);
  const info = inspectBytes(bytes);
  approved.target.document = info.manifest.find((item) =>
    item.path.includes("0001"),
  )!.path;
  await expect(applyCover(bytes, cover, approved)).rejects.toThrow(
    /content|text|cover/i,
  );
});
it.each([false, true])(
  "adds a missing declared EPUB cover without changing existing reading order (legacy=%s)",
  async (legacy) => {
    const { bytes } = await fixture(false, legacy),
      cover = await image(160, 100),
      plan = await planFor(bytes, "epub", cover);
    const before = inspectBytes(bytes),
      result = await applyCover(bytes, cover, plan),
      after = inspectBytes(result.bytes, true);
    expect(after.spine.slice(1)).toEqual(before.spine);
    expect(after.version).toBe(before.version);
    expect(after.entries.get(result.report.imagePath)?.bytes).toEqual(cover);
    const declared = elements(after.packageDocument, "meta", NS.opf).find(
      (node) => attr(node, "name") === "cover",
    );
    expect(
      after.manifest.some(
        (item) =>
          item.id === declared?.getAttribute("content") &&
          item.path === result.report.imagePath,
      ),
    ).toBe(true);
  },
);
it.each([
  [120, 180],
  [240, 100],
])(
  "publishes only after real EPUB format and rendered whole-cover checks (%sx%s)",
  async (width, height) => {
    const { root, bytes } = await fixture(),
      cover = await image(width, height),
      plan = await planFor(bytes, "epub", cover),
      source = path.join(root, "source.epub"),
      imageFile = path.join(root, "official.png"),
      output = path.join(root, "covered.epub");
    await fs.writeFile(source, bytes);
    await fs.writeFile(imageFile, cover);
    const result = await adoptCover(source, { image: imageFile, plan, output });
    expect(result.validation.status).toBe("pass");
    expect(result.verification.status).toBe("pass");
    expect(result.verification.cases).toHaveLength(3);
    expect(await fs.readFile(source)).toEqual(bytes);
    await fs.cp(
      result.reports,
      path.join(repoRoot, "dist/cover-tests", `${width}x${height}`),
      { recursive: true, force: true },
    );
    await expect(
      adoptCover(source, { image: imageFile, plan, output }),
    ).rejects.toThrow(/exist/i);
  },
);
it("replaces only an explicitly selected CBZ page and updates its cover mapping and dimensions", async () => {
  const page = await image(80, 120),
    cover = await image(200, 120),
    bytes = packArchive(
      new Map([
        ["01.png", page],
        ["02.png", page],
        [
          "ComicInfo.xml",
          Buffer.from(
            '<ComicInfo><Title>Fixture</Title><PageCount>2</PageCount><AgeRating>Teen</AgeRating><Pages><Page Image="0" Type="Story" Bookmark="keep"/><Page Image="1" Type="FrontCover"/></Pages></ComicInfo>',
          ),
        ],
      ]),
      946684800,
    );
  const plan = await planFor(bytes, "cbz", cover);
  await expect(applyCover(bytes, cover, plan)).rejects.toThrow(/select|page/i);
  plan.target.image = "01.png";
  plan.pageOrder = ["01.png", "02.png"];
  const result = await applyCover(bytes, cover, plan),
    after = unpack(result.bytes),
    before = unpack(bytes);
  expect([...after.keys()]).toEqual([...before.keys()]);
  expect(after.get("01.png")!.bytes).toEqual(cover);
  expect(after.get("02.png")!.bytes).toEqual(page);
  const document = xml(after.get("ComicInfo.xml")!.bytes.toString()),
    pages = elements(document, "Page");
  expect(attr(pages[0], "Type")).toContain("FrontCover");
  expect(attr(pages[0], "Bookmark")).toBe("keep");
  expect(attr(pages[0], "ImageWidth")).toBe("200");
  expect(attr(pages[1], "Type")).not.toContain("FrontCover");
  expect(elements(document, "AgeRating")[0].textContent).toBe("Teen");
});

it("updates the existing cover landmark without leaving an untyped or duplicate landmark", async () => {
  const { root, bytes } = await fixture(),
    info = inspectBytes(bytes),
    navItem = info.manifest.find((item) => item.properties.includes("nav"))!,
    nav = info.documents.get(navItem.path)!;
  const landmark = elements(nav, "nav", NS.xhtml).find(
      (node) => node.getAttributeNS(NS.epub, "type") === "landmarks",
    )!,
    ol = elements(landmark, "ol", NS.xhtml)[0],
    li = nav.createElementNS(NS.xhtml, "li"),
    a = nav.createElementNS(NS.xhtml, "a");
  a.setAttributeNS(NS.epub, "epub:type", "cover");
  a.setAttribute("href", "cover.xhtml");
  a.textContent = "Original cover";
  li.appendChild(a);
  ol.appendChild(li);
  const expectedLinks = elements(landmark, "a", NS.xhtml).length;
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(navItem.path, Buffer.from(serialize(nav)));
  const source = pack(entries, 946684800),
    imageBytes = await image(),
    plan = await planFor(source, "epub", imageBytes),
    result = await applyCover(source, imageBytes, plan);
  const after = inspectBytes(result.bytes),
    landmarks = elements(
      after.documents.get(navItem.path)!,
      "nav",
      NS.xhtml,
    ).filter((node) => node.getAttributeNS(NS.epub, "type") === "landmarks");
  expect(elements(landmarks[0], "a", NS.xhtml)).toHaveLength(expectedLinks);
  const file = path.join(root, "landmark.epub");
  await fs.writeFile(file, result.bytes);
  await fs.mkdir(path.join(root, "landmark-reports"));
  expect(
    (
      await checkEpubConformance(file, {
        reports: path.join(root, "landmark-reports"),
      })
    ).status,
  ).toBe("pass");
});
it.each([false, true])(
  "validates newly added cover resources and missing association repairs in EPUB legacy=%s",
  async (legacy) => {
    const { root, bytes } = await fixture(false, legacy),
      cover = await image(160, 100),
      plan = await planFor(bytes, "epub", cover),
      result = await applyCover(bytes, cover, plan),
      file = path.join(root, "new.epub");
    await fs.writeFile(file, result.bytes);
    await fs.mkdir(path.join(root, "new-reports"));
    expect(
      (
        await checkEpubConformance(file, {
          reports: path.join(root, "new-reports"),
        })
      ).status,
    ).toBe("pass");
  },
);
it.each(["png", "jxl"])(
  "delivers a CBZ %s cover through real codec/schema/render gates and CLI audit",
  async (extension) => {
    const root = await copyBook();
    temporary.push(root);
    const old = await image(80, 120),
      cover = await image(160, 100);
    let page = old;
    if (extension === "jxl") {
      const folder = path.join(root, "codec");
      await fs.mkdir(folder);
      page = (
        await encodePage(
          { name: "original.png", bytes: old },
          folder,
          await jxlTools(),
        )
      ).bytes;
    }
    const name = `01.${extension}`,
      bytes = packArchive(
        new Map([
          [name, page],
          [`02.${extension}`, page],
          [
            "ComicInfo.xml",
            Buffer.from(
              '<ComicInfo><Title>Fixture</Title><PageCount>2</PageCount><Pages><Page Image="0" Type="FrontCover"/></Pages></ComicInfo>',
            ),
          ],
        ]),
        946684800,
      );
    const source = path.join(root, "source.cbz"),
      candidate = path.join(root, "official.png"),
      planFile = path.join(root, "plan.json"),
      output = path.join(root, "new.cbz");
    await fs.writeFile(source, bytes);
    await fs.writeFile(candidate, cover);
    const audit = await run(process.execPath, [
      "--import",
      "tsx",
      path.join(repoRoot, "packages/cli/src/index.ts"),
      "metadata",
      "cover-audit",
      source,
      "--image",
      candidate,
      "--output",
      planFile,
      "--json",
    ]);
    expect(audit.exitCode, audit.stderr).toBe(0);
    const plan = await planFor(bytes, "cbz", cover);
    plan.target.image = name;
    plan.pageOrder = [name, `02.${extension}`];
    await fs.writeFile(planFile, JSON.stringify(plan));
    const delivery = await run(process.execPath, [
      "--import",
      "tsx",
      path.join(repoRoot, "packages/cli/src/index.ts"),
      "metadata",
      "cover-adopt",
      source,
      "--image",
      candidate,
      "--plan",
      planFile,
      "--output",
      output,
      "--json",
    ]);
    expect(delivery.exitCode, delivery.stdout + delivery.stderr).toBe(0);
    const report = JSON.parse(delivery.stdout);
    expect(report.validation.status).toBe("pass");
    expect(report.verification.status).toBe("pass");
    expect(
      unpack(await fs.readFile(output)).get(`02.${extension}`)!.bytes,
    ).toEqual(page);
    expect(await fs.readFile(source)).toEqual(bytes);
    expect(report.metadata.conversion?.verification ?? "original").toBe(
      extension === "jxl" ? "decoded-samples-and-metadata" : "original",
    );
  },
);

it("blocks publication of a format-valid cover whose actual display stretches or clips the image", async () => {
  const { root, bytes } = await fixture(),
    info = inspectBytes(bytes),
    imagePath = info.manifest.find((item) => item.id === "cover-image")!.path,
    documentPath = info.manifest.find((item) => item.id === "cover-page")!.path,
    report = {
      format: "epub" as const,
      image: await coverImage(info.entries.get(imagePath)!.bytes),
      imagePath,
      documentPath,
    };
  const source = path.join(root, "source.epub"),
    output = path.join(root, "bad.epub");
  await fs.writeFile(source, bytes);
  await expect(
    deliverMetadata(source, {
      output,
      bytes,
      format: "epub",
      sourceSha256: sha256(bytes),
      report,
      verify: (candidate, reports) =>
        coverQa(candidate, report, path.join(reports, "cover")),
    }),
  ).rejects.toThrow(/rendered cover/i);
  await expect(fs.stat(output)).rejects.toThrow(/ENOENT/);
  expect(await fs.readFile(source)).toEqual(bytes);
});
it("repairs a wrong cover association by adding a cover while retaining the wrongly referenced body chapter", async () => {
  const { bytes } = await fixture(),
    info = inspectBytes(bytes),
    body = info.manifest.find((item) => item.path.includes("0001"))!,
    reference = elements(info.packageDocument, "reference", NS.opf).find(
      (node) => attr(node, "type") === "cover",
    )!;
  reference.setAttribute("href", body.href);
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  const source = pack(entries, 946684800),
    cover = await image(),
    plan = await planFor(source, "epub", cover);
  expect(plan.target.document).toBe(body.path);
  plan.target.document = null;
  plan.target.image = null;
  const result = await applyCover(source, cover, plan);
  expect(inspectBytes(result.bytes).entries.get(body.path)!.bytes).toEqual(
    info.entries.get(body.path)!.bytes,
  );
});

it("protects a cover image also used by a chapter stylesheet", async () => {
  const { bytes } = await fixture(),
    info = inspectBytes(bytes),
    style = info.manifest.find((item) => item.mediaType === "text/css")!,
    picture = info.manifest.find((item) => item.id === "cover-image")!;
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(
    style.path,
    Buffer.concat([
      entries.get(style.path)!,
      Buffer.from(
        `\n.chapter { background-image: url('${path.posix.relative(path.posix.dirname(style.path), picture.path)}'); }`,
      ),
    ]),
  );
  const source = pack(entries, 946684800),
    cover = await image(),
    plan = await planFor(source, "epub", cover);
  await expect(applyCover(source, cover, plan)).rejects.toThrow(
    /outside|shared/i,
  );
  plan.target.image = null;
  const result = await applyCover(source, cover, plan);
  expect(inspectBytes(result.bytes).entries.get(picture.path)!.bytes).toEqual(
    info.entries.get(picture.path)!.bytes,
  );
});
