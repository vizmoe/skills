import { it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { bodymatterItems, candidate, copyBook } from "./helpers.js";
import { inspectBytes, inspectEpub } from "../packages/core/src/validate.js";
import {
  describeInspection,
  inspectionSummary,
} from "../packages/core/src/inspection.js";
import { pack } from "../packages/core/src/zip.js";
import { repoRoot } from "../packages/core/src/runtime.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
it("inspects nested NAV, non-linear content, cover and refined bibliography at a relocated OPF path", async () => {
  const root = await copyBook();
  temporary.push(root);
  const info = inspectBytes(await candidate(root));
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [
      name.replace(/^EPUB\//, "Books/Volume/"),
      entry.bytes,
    ]),
  );
  entries.set(
    "META-INF/container.xml",
    Buffer.from(
      entries
        .get("META-INF/container.xml")!
        .toString()
        .replace("EPUB/package.opf", "Books/Volume/package.opf"),
    ),
  );
  const chapter = bodymatterItems(info)[0].path.replace(
    /^EPUB\//,
    "Books/Volume/",
  );
  entries.set(
    chapter,
    Buffer.from(
      entries
        .get(chapter)!
        .toString()
        .replace("</main>", '<h2 id="中文锚点">中文标题</h2></main>'),
    ),
  );
  const href = path.posix.relative("Books/Volume", chapter);
  const opf = "Books/Volume/package.opf";
  entries.set(
    opf,
    Buffer.from(
      entries
        .get(opf)!
        .toString()
        .replace(
          `<itemref idref="${bodymatterItems(info)[1].id}"`,
          `<itemref linear="no" idref="${bodymatterItems(info)[1].id}"`,
        )
        .replace(
          "</metadata>",
          '<dc:contributor id="translator">译者</dc:contributor><meta property="role" refines="#translator" scheme="marc:relators">trl</meta><meta property="custom:edition-note">Preserve this edition</meta></metadata>',
        )
        .replace(
          "</manifest>",
          '<item id="cover-art" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/></manifest>',
        ),
    ),
  );
  entries.set(
    "Books/Volume/cover.svg",
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    ),
  );
  entries.set(
    "Books/Volume/nav.xhtml",
    Buffer.from(
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol><li id="part"><span>第一部</span><ol><li><a href="${href}#%E4%B8%AD%E6%96%87%E9%94%9A%E7%82%B9">中文标题</a></li></ol></li></ol></nav><nav epub:type="landmarks"><ol><li><a epub:type="cover" href="${href}">封面页</a></li></ol></nav></body></html>`,
    ),
  );
  const bytes = pack(entries, 946684800);
  const report = describeInspection(inspectBytes(bytes), bytes.length);
  expect(report.packagePath).toBe(opf);
  expect(
    report.readingOrder.find(
      (item) => item.idref === bodymatterItems(info)[1].id,
    ),
  ).toMatchObject({
    idref: bodymatterItems(info)[1].id,
    linear: "no",
    exists: true,
  });
  expect(report.navigation[0].items[0]).toMatchObject({
    label: "第一部",
    children: [
      {
        label: "中文标题",
        target: { path: chapter, fragment: "中文锚点", resolution: "resolved" },
      },
    ],
  });
  expect(report.metadata.records).toContainEqual(
    expect.objectContaining({
      value: "trl",
      attributes: {
        property: "role",
        refines: "#translator",
        scheme: "marc:relators",
      },
    }),
  );
  expect(
    report.metadata.records.some(
      (record) => record.value === "Preserve this edition",
    ),
  ).toBe(true);
  expect(report.covers.map((cover) => cover.kind)).toEqual([
    "landmark",
    "cover-image",
  ]);
  expect(
    report.resources
      .find((resource) => resource.path === chapter)!
      .referencedBy.some(
        (ref) =>
          ref.source === "Books/Volume/nav.xhtml" &&
          ref.fragment === "中文锚点",
      ),
  ).toBe(true);
  expect(report.summary.nonLinearItems).toBe(1);
  expect(inspectionSummary(report).validation).toBe("not-run");
});
it("reads legacy NCX and retains original EPUB metadata and bytes", async () => {
  const root = await copyBook();
  temporary.push(root);
  const file = path.join(root, "original.epub");
  const bytes = await fs.readFile(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  await fs.writeFile(file, bytes);
  const before = (await fs.stat(file)).mtimeMs;
  const report = await inspectEpub(file);
  expect(report.version).toBe("2.0");
  expect(report.navigation).toContainEqual(
    expect.objectContaining({
      format: "ncx",
      type: "toc",
      items: expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({ resolution: "resolved" }),
        }),
      ]),
    }),
  );
  expect(
    report.metadata.records.some(
      (record) => record.value === "Example Translator",
    ),
  ).toBe(true);
  expect(await fs.readFile(file)).toEqual(bytes);
  expect((await fs.stat(file)).mtimeMs).toBe(before);
  expect(await fs.readdir(root)).not.toContain("reports");
});
it("reads a standard NCX doctype locally and rejects custom DTDs or entity subsets", async () => {
  const original = inspectBytes(
    await fs.readFile(path.join(repoRoot, "examples/repair/legacy.epub")),
  );
  const ncx = original.manifest.find(
    (item) => item.mediaType === "application/x-dtbncx+xml",
  )!.path;
  const declaration =
    '<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">';
  for (const [doctype, accepted] of [
    [declaration, true],
    [declaration.replace("www.daisy.org", "untrusted.example"), false],
    [
      declaration.replace(
        ">",
        ' [<!ENTITY private SYSTEM "file:///private/secret">]>',
      ),
      false,
    ],
  ] as const) {
    const entries = new Map(
      [...original.entries].map(([name, entry]) => [name, entry.bytes]),
    );
    entries.set(
      ncx,
      Buffer.from(
        entries
          .get(ncx)!
          .toString()
          .replace(/(<\?xml[^>]*\?>)?\s*<ncx/, `$1\n${doctype}\n<ncx`),
      ),
    );
    const bytes = pack(entries, 946684800);
    const result = describeInspection(inspectBytes(bytes), bytes.length);
    expect(result.navigation.some((nav) => nav.format === "ncx")).toBe(
      accepted,
    );
    expect(
      result.diagnostics.some((issue) => issue.code === "INSPECT_XML"),
    ).toBe(!accepted);
    expect(result.summary.externalResourcesFetched).toBe(false);
  }
});
it("reports missing, escaping and external links without fetching or following them", async () => {
  const root = await copyBook("technical");
  temporary.push(root);
  const info = inspectBytes(await candidate(root));
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  const chapter = bodymatterItems(info)[0].path;
  entries.set(
    chapter,
    Buffer.from(
      entries
        .get(chapter)!
        .toString()
        .replace(
          "</main>",
          '<p><a href="#absent">missing anchor</a><a href="absent.xhtml">missing resource</a><a href="../../../../secret">escape</a><a href="https://invalid.example/">external</a></p></main>',
        ),
    ),
  );
  const bytes = pack(entries, 946684800);
  const report = describeInspection(inspectBytes(bytes), bytes.length);
  expect(report.brokenReferences.map((ref) => ref.resolution)).toEqual(
    expect.arrayContaining(["missing-fragment", "missing-resource", "unsafe"]),
  );
  expect(report.references).toContainEqual(
    expect.objectContaining({
      href: "https://invalid.example/",
      resolution: "external",
    }),
  );
  expect(report.summary.externalResourcesFetched).toBe(false);
  expect(
    report.resources.some((resource) =>
      resource.referencedBy.some((ref) => ref.kind === "link@href"),
    ),
  ).toBe(true);
});
