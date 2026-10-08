import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyBookWalkerMetadata,
  enrichEpub,
} from "../packages/core/src/enrich-epub.js";
import { collectBookWalker } from "../packages/core/src/bookwalker.js";
import { candidate, copyBook } from "./helpers.js";
import { bookwalkerFetcher, selection } from "./bookwalker-fixture.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { pack } from "../packages/core/src/zip.js";
import { attr, elements, NS, serialize } from "../packages/core/src/xml.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { validateInternal } from "../packages/core/src/validate.js";
import { run } from "../packages/core/src/process.js";
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await copyBook();
  temporary.push(root);
  return {
    root,
    bytes: await candidate(root),
    lock: await collectBookWalker(selection, {
      online: true,
      fetcher: bookwalkerFetcher,
    }),
  };
}
it("enriches only OPF metadata and preserves identifiers, contributors, spine and resource bytes", async () => {
  const { bytes, lock } = await fixture();
  const before = inspectBytes(bytes);
  const metadata = elements(before.packageDocument, "metadata", NS.opf)[0];
  const existing = before.packageDocument.createElementNS(
    NS.dc,
    "dc:contributor",
  );
  existing.textContent = "Existing editor";
  existing.setAttribute("id", "contributor");
  metadata.appendChild(existing);
  const date = before.packageDocument.createElementNS(NS.dc, "dc:date");
  date.textContent = "2022-06-10";
  metadata.appendChild(date);
  const source = pack(
    new Map(
      [...before.entries].map(([name, entry]) => [
        name,
        name === before.packagePath
          ? Buffer.from(serialize(before.packageDocument))
          : entry.bytes,
      ]),
    ),
    946684800,
  );
  const result = applyBookWalkerMetadata(source, lock);
  const after = inspectBytes(result.bytes, true);
  expect(after.title).toBe(before.title);
  expect(
    elements(after.packageDocument, "identifier", NS.dc).map(serialize),
  ).toEqual(
    elements(before.packageDocument, "identifier", NS.dc).map(serialize),
  );
  expect(
    elements(after.packageDocument, "contributor", NS.dc).map(
      (node) => node.textContent,
    ),
  ).toEqual(["Existing editor", "画家乙", "譯者丙"]);
  expect(elements(after.packageDocument, "date", NS.dc)[0].textContent).toBe(
    "2020-04-20",
  );
  expect(
    elements(after.packageDocument, "publisher", NS.dc)[0].textContent,
  ).toBe("台灣出版社");
  expect(result.report.changes).toContainEqual({
    field: "date",
    before: ["2022-06-10"],
    after: ["2020-04-20"],
  });
  expect(result.report.diagnostics).toContainEqual(
    expect.objectContaining({ code: "BOOKWALKER_CONFLICT" }),
  );
  expect(after.spine).toEqual(before.spine);
  for (const [name, entry] of before.entries)
    if (name !== before.packagePath)
      expect(after.entries.get(name)!.bytes).toEqual(entry.bytes);
  expect(validateInternal(result.bytes).status).toBe("pass");
  expect(applyBookWalkerMetadata(source, lock).bytes).toEqual(result.bytes);
  expect(applyBookWalkerMetadata(result.bytes, lock).bytes).toEqual(
    result.bytes,
  );
  const ids = elements(after.packageDocument)
    .map((node) => attr(node, "id"))
    .filter(Boolean);
  expect(new Set(ids).size).toBe(ids.length);
});
it("fills absent fields without assigning the store's ISBN or upgrading EPUB versions", async () => {
  const { bytes, lock } = await fixture();
  const info = inspectBytes(bytes);
  for (const field of ["title", "creator", "description", "language"])
    for (const node of elements(info.packageDocument, field, NS.dc))
      node.parentNode!.removeChild(node);
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(info.packagePath, Buffer.from(serialize(info.packageDocument)));
  const output = inspectBytes(
    applyBookWalkerMetadata(pack(entries, 946684800), lock).bytes,
  );
  expect(output.title).toBe("虛構物語 (1)");
  expect(output.language).toBe("zh-Hant");
  expect(
    elements(output.packageDocument, "identifier", NS.dc)[0].textContent,
  ).not.toContain("9780306406157");
  const legacy = await fs.readFile(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  expect(() => applyBookWalkerMetadata(legacy, lock)).toThrow(/EPUB 3/);
});
it("never overwrites an original or existing output and rejects signed packages", async () => {
  const { root, bytes, lock } = await fixture();
  const file = path.join(root, "original.epub"),
    sources = path.join(root, "source.json");
  await fs.writeFile(file, bytes);
  await fs.writeFile(sources, JSON.stringify(lock));
  await expect(
    enrichEpub(file, { output: file, bookwalker: sources }),
  ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
  expect(await fs.readFile(file)).toEqual(bytes);
  const info = inspectBytes(bytes),
    entries = new Map(
      [...info.entries].map(([name, entry]) => [name, entry.bytes]),
    );
  entries.set("META-INF/signatures.xml", Buffer.from("<signatures/>"));
  expect(() => applyBookWalkerMetadata(pack(entries, 946684800), lock)).toThrow(
    /unsupported/i,
  );
});

it("exposes EPUB enrichment in the CLI with required source-lock and output arguments", async () => {
  const command = (...args: string[]) =>
    run(
      process.execPath,
      ["--import", "tsx", "packages/cli/src/index.ts", ...args, "--json"],
      { cwd: repoRoot },
    );
  expect(
    JSON.parse((await command("formats")).stdout).epubInputModes,
  ).toContain("enrich");
  for (const args of [
    ["epub", "enrich", "/missing.epub"],
    ["epub", "enrich", "/missing.epub", "--output", "/unused.epub"],
  ])
    expect(JSON.parse((await command(...args)).stdout).code).toBe(
      "ARGUMENT_REQUIRED",
    );
  expect(
    JSON.parse(
      (await command("inspect", "/missing.epub", "--bookwalker", "/lock.json"))
        .stdout,
    ).code,
  ).toBe("ARGUMENT_CONFLICT");
});
