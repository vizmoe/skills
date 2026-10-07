import { it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { copyBook, candidate } from "./helpers.js";
import { prepareBook } from "../packages/core/src/init.js";
import { openBook } from "../packages/core/src/config.js";
import { inspectBytes } from "../packages/core/src/validate.js";
import { sha256 } from "../packages/core/src/hash.js";
const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await copyBook("technical");
  temporary.push(root);
  const source = path.join(root, "raw");
  await fs.mkdir(source);
  await fs.mkdir(path.join(source, "posts"));
  await fs.writeFile(
    path.join(source, "posts/one.md"),
    "---\ntitle: 第一章\nauthor: 原作者\nprivate: PRIVATE-SHOULD-NOT-LEAK\n---\n\n正文[^note]，再次引用[^note]。\n\n![图](image.svg)\n\n[^note]: 注释内容\n",
  );
  await fs.writeFile(
    path.join(source, "posts/image.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>',
  );
  await fs.writeFile(
    path.join(source, "unreferenced-secret.txt"),
    "not copied",
  );
  const config = (await openBook(root)).config;
  config.book.language = "zh-Hans";
  config.book.publication.isbn = null;
  config.markdown.profile = "blog";
  config.chapters = ["posts/one.md"];
  config.cover = undefined;
  config.styles = [];
  config.fonts = [];
  config.references = [];
  const configFile = path.join(root, "plan.yaml");
  await fs.writeFile(configFile, JSON.stringify(config));
  return { root, source, configFile, output: path.join(root, "prepared") };
}
it("prepares a buildable blog book and only copies referenced source bytes", async () => {
  const { source, configFile, output } = await fixture();
  const result = await prepareBook(output, source, configFile);
  expect(result.readiness).toEqual({
    metadata: "pass",
    preflight: "pass",
    release: "not-run",
  });
  expect(result.copiedFiles.map((file) => file.path)).toEqual([
    "posts/image.svg",
    "posts/one.md",
  ]);
  for (const file of result.copiedFiles) {
    const before = await fs.readFile(path.join(source, file.path));
    expect(sha256(before)).toBe(file.sha256);
    expect(await fs.readFile(path.join(output, file.path))).toEqual(before);
  }
  expect(JSON.stringify(result)).not.toContain("PRIVATE-SHOULD-NOT-LEAK");
  expect(await fs.readdir(output)).not.toContain("unreferenced-secret.txt");
  const info = inspectBytes(await candidate(output));
  const text = [...info.documents.values()]
    .map((document) => document.toString())
    .join("\n");
  expect(text).toContain("原作者");
  expect(text).not.toContain("PRIVATE-SHOULD-NOT-LEAK");
});
it("returns and saves a low-resolution cover warning while preparing the original image", async () => {
  const { source, configFile, output } = await fixture();
  const image = await sharp({
    create: { width: 800, height: 1600, channels: 3, background: "#334477" },
  })
    .png()
    .toBuffer();
  await fs.writeFile(path.join(source, "cover.png"), image);
  const config = JSON.parse(await fs.readFile(configFile, "utf8"));
  config.cover = { path: "cover.png" };
  await fs.writeFile(configFile, JSON.stringify(config));
  const prepared = await prepareBook(output, source, configFile);
  expect(prepared.status).toBe("initialized");
  expect(prepared.readiness.preflight).toBe("pass");
  expect(prepared.diagnostics).toEqual([
    expect.objectContaining({
      code: "COVER_RESOLUTION_LOW",
      severity: "warning",
      source: "cover.png",
    }),
  ]);
  expect(prepared.diagnostics[0].message).toContain("800 × 1600");
  expect(prepared.nextCommands).toEqual([
    ["quillbind", "build", await fs.realpath(output), "--json"],
  ]);
  const saved = JSON.parse(
    await fs.readFile(path.join(output, "metadata/preparation.json"), "utf8"),
  );
  expect(saved.diagnostics).toEqual(prepared.diagnostics);
  expect(await fs.readFile(path.join(output, "cover.png"))).toEqual(image);
  expect(await fs.readFile(path.join(source, "cover.png"))).toEqual(image);
});
it("fails missing-resource preparation without leaving a partial book", async () => {
  const { source, configFile, output } = await fixture();
  await fs.unlink(path.join(source, "posts/image.svg"));
  await expect(prepareBook(output, source, configFile)).rejects.toMatchObject({
    code: "RESOURCE_MISSING",
  });
  await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});
it("does not create output directories inside source data or follow an escaping image", async () => {
  const { root, source, configFile, output } = await fixture();
  await expect(
    prepareBook(path.join(source, "new/nested/book"), source, configFile),
  ).rejects.toMatchObject({ code: "PREPARATION_PATH" });
  expect(await fs.readdir(source)).not.toContain("new");
  await fs.unlink(path.join(source, "posts/image.svg"));
  await fs.symlink(
    path.join(root, "book.yaml"),
    path.join(source, "posts/image.svg"),
  );
  await expect(prepareBook(output, source, configFile)).rejects.toMatchObject({
    code: "SYMLINK_ESCAPE",
  });
});
