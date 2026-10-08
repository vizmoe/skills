import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { openBook, taxonomy } from "../packages/core/src/config.js";
import {
  lockedMetadata,
  resolveMetadata,
} from "../packages/core/src/metadata.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { inspectBytes } from "../packages/core/src/validate.js";
import { candidate, copyBook } from "./helpers.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function book(tags: string[]) {
  const root = await copyBook();
  temporary.push(root);
  const file = path.join(root, "book.yaml");
  await fs.writeFile(
    file,
    (await fs.readFile(file, "utf8")).replace(
      "[Literature.Essays]",
      JSON.stringify(tags),
    ),
  );
  return root;
}
describe("library-authoritative taxonomy", () => {
  it("accepts library labels and serializes their exact hierarchy to EPUB subjects", async () => {
    const tags = [
      "Literature.Light Novel",
      "Literature.Fantasy",
      "Science.Software Engineering",
    ];
    const root = await book(tags);
    expect((await resolveMetadata(root)).status).toBe("pass");
    const info = inspectBytes(await candidate(root));
    const opf = info.entries.get(info.packagePath)!.bytes.toString();
    for (const tag of tags)
      expect(opf).toContain(`<dc:subject>${tag}</dc:subject>`);
  });
  it("rejects old IDs and uncontrolled tags without silently replacing them", async () => {
    const root = await book(["Technology.SoftwareEngineering", "简体中文"]);
    const result = await resolveMetadata(root);
    expect(result.status).toBe("fail");
    expect(
      result.diagnostics.filter((item) => item.code === "UNKNOWN_TAG"),
    ).toHaveLength(2);
    expect(result.metadata.tags.map((item) => item.id)).toEqual([
      "Technology.SoftwareEngineering",
      "简体中文",
    ]);
  });
  it("uses the selected current vocabulary and invalidates locks on content changes", async () => {
    const root = await book(["Literature.Essays"]);
    const file = path.join(root, "vocabulary.json");
    const source = path.resolve(
      repoRoot,
      "../../skills/quillbind/references/tag-vocabulary.json",
    );
    await fs.copyFile(source, file);
    vi.stubEnv("QUILLBIND_VOCABULARY", file);
    await resolveMetadata(root);
    const before = await taxonomy();
    await fs.appendFile(file, "\n");
    expect((await taxonomy()).version).not.toBe(before.version);
    await expect(lockedMetadata(await openBook(root))).rejects.toMatchObject({
      code: "METADATA_LOCK_STALE",
    });
    const current = JSON.parse(await fs.readFile(file, "utf8"));
    current.controlled_subclasses.Literature = ["Fiction"];
    current.flat_to_hierarchical = {};
    await fs.writeFile(file, JSON.stringify(current));
    expect((await resolveMetadata(root)).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_TAG" }),
      ]),
    );
    await fs.writeFile(file, "{}");
    await expect(taxonomy()).rejects.toMatchObject({
      code: "TAXONOMY_INVALID",
    });
  });
});
