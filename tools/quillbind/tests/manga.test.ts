import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { packageManga } from "../packages/core/src/manga.js";
import { mangaFixture } from "./manga-fixture.js";
import { unpack } from "../packages/core/src/zip.js";
import { elements, xml } from "../packages/core/src/xml.js";
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

it("packages actual lossless JXL pages and original-date ComicInfo in deterministic reading order", async () => {
  const input = await mangaFixture();
  temporary.push(input.root);
  const original = await fs.readFile(path.join(input.scans, "10.jpg"));
  const result = await packageManga(input.scans, {
    ...input,
    direction: "rtl",
  });
  const bytes = await fs.readFile(input.output),
    entries = unpack(bytes);
  expect(result.status).toBe("pass");
  expect(result.pages.map((item) => item.source)).toEqual([
    "1.png",
    "2.png",
    "10.jpg",
  ]);
  expect(result.pages.map((item) => item.verification)).toEqual([
    "decoded-samples-and-metadata",
    "decoded-samples-and-metadata",
    "jpeg-byte-reconstruction",
  ]);
  expect([...entries.keys()].filter((name) => name.endsWith(".jxl"))).toEqual([
    "00001.jxl",
    "00002.jxl",
    "00003.jxl",
  ]);
  const comic = xml(entries.get("ComicInfo.xml")!.bytes.toString());
  const field = (name: string) => elements(comic, name)[0]?.textContent;
  expect(field("Title")).toBe("虛構物語 (1)");
  expect([field("Year"), field("Month"), field("Day")]).toEqual([
    "2020",
    "4",
    "20",
  ]);
  expect(field("PageCount")).toBe("3");
  expect(field("Manga")).toBe("YesAndRightToLeft");
  expect(field("Translator")).toBeUndefined();
  expect(field("Notes")).toContain("譯者丙");
  const comicFile = path.join(input.root, "ComicInfo.xml");
  await fs.writeFile(comicFile, entries.get("ComicInfo.xml")!.bytes);
  const schema = await run("xmllint", [
    "--nonet",
    "--noout",
    "--schema",
    path.join(repoRoot, "standards/comicinfo/ComicInfo-2.0.xsd"),
    comicFile,
  ]);
  expect(schema.exitCode, schema.stderr).toBe(0);
  expect(await fs.readFile(path.join(input.scans, "10.jpg"))).toEqual(original);
  const second = path.join(input.root, "second.cbz");
  await packageManga(input.scans, {
    ...input,
    output: second,
    direction: "rtl",
  });
  expect(await fs.readFile(second)).toEqual(bytes);
});
it("keeps originals and does not publish incomplete or colliding output", async () => {
  const input = await mangaFixture();
  temporary.push(input.root);
  await fs.writeFile(input.output, "existing");
  await expect(packageManga(input.scans, input)).rejects.toMatchObject({
    code: "OUTPUT_EXISTS",
  });
  expect(await fs.readFile(input.output, "utf8")).toBe("existing");
  await fs.unlink(input.output);
  await fs.writeFile(path.join(input.scans, "4.png"), "corrupt");
  await expect(packageManga(input.scans, input)).rejects.toThrow();
  await expect(fs.lstat(input.output)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (await fs.readdir(input.root)).some(
      (name) => name.endsWith(".manga.lock") || name.includes(".candidate"),
    ),
  ).toBe(false);
});

it("runs the real CLI from ZIP input with explicit page order and schema-conformant ComicInfo", async () => {
  const input = await mangaFixture();
  temporary.push(input.root);
  const { readScans } = await import("../packages/core/src/manga-sources.js");
  const { packArchive } = await import("../packages/core/src/zip.js");
  const scans = await readScans(input.scans),
    archive = path.join(input.root, "scans.zip"),
    order = path.join(input.root, "order.json");
  await fs.writeFile(
    archive,
    packArchive(
      new Map(scans.pages.map((page) => [page.name, page.bytes])),
      946684800,
    ),
  );
  await fs.writeFile(order, JSON.stringify(["10.jpg", "2.png", "1.png"]));
  const result = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "packages/cli/src/index.ts",
      "manga",
      "package",
      archive,
      "--bookwalker",
      input.bookwalker,
      "--output",
      input.output,
      "--page-order",
      order,
      "--reading-direction",
      "rtl",
      "--json",
    ],
    { cwd: repoRoot },
  );
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.pages.map((page: { source: string }) => page.source)).toEqual([
    "10.jpg",
    "2.png",
    "1.png",
  ]);
  expect(report.codec.distance).toBe(0);
  expect(report.checks.sourceUnchanged).toBe("pass");
  expect(unpack(await fs.readFile(input.output)).has("ComicInfo.xml")).toBe(
    true,
  );
});
