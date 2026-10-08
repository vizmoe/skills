import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectBookWalker } from "../packages/core/src/bookwalker.js";
import { openBook } from "../packages/core/src/config.js";
import {
  resolveMetadata,
  lockedMetadata,
} from "../packages/core/src/metadata.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { elements, NS, attr } from "../packages/core/src/xml.js";
import { copyBook, candidate } from "./helpers.js";
import { bookwalkerFetcher, selection } from "./bookwalker-fixture.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function book(empty = true) {
  const root = await copyBook();
  temporary.push(root);
  const config = {
    ...(await openBook(root)).config,
    bookwalker: "metadata/bookwalker.lock.json",
  };
  if (empty)
    Object.assign(config.book, {
      title: "",
      description: "",
      language: "",
      authors: [],
    });
  await fs.writeFile(path.join(root, "book.yaml"), JSON.stringify(config));
  await fs.mkdir(path.join(root, "metadata"), { recursive: true });
  const lock = await collectBookWalker(selection, {
    online: true,
    fetcher: bookwalkerFetcher,
  });
  await fs.writeFile(
    path.join(root, "metadata/bookwalker.lock.json"),
    JSON.stringify(lock),
  );
  return root;
}
it("supplements missing fields offline and writes original-date bibliographic metadata to OPF", async () => {
  const root = await book();
  const before = await fs.readFile(path.join(root, "book.yaml"));
  const resolved = await resolveMetadata(root);
  expect(resolved.status).toBe("pass");
  expect(resolved.metadata).toMatchObject({
    title: "虛構物語 (1)",
    authors: [{ name: "作者甲" }],
    language: "zh-Hant",
    publication: { isbn: null },
    bibliography: { releaseDate: "2020-04-20", publisher: "台灣出版社" },
  });
  expect(resolved.metadata.identifier.scheme).toBe("uuid");
  expect(await fs.readFile(path.join(root, "book.yaml"))).toEqual(before);
  const info = inspectBytes(await candidate(root));
  expect(
    elements(info.packageDocument, "date", NS.dc).map(
      (node) => node.textContent,
    ),
  ).toEqual(["2020-04-20"]);
  expect(
    elements(info.packageDocument, "publisher", NS.dc).map(
      (node) => node.textContent,
    ),
  ).toEqual(["台灣出版社"]);
  expect(
    elements(info.packageDocument, "contributor", NS.dc).map(
      (node) => node.textContent,
    ),
  ).toEqual(["画家乙", "譯者丙"]);
  expect(
    elements(info.packageDocument, "meta", NS.opf).some(
      (node) =>
        attr(node, "property") === "belongs-to-collection" &&
        node.textContent === "虛構物語",
    ),
  ).toBe(true);
});
it("preserves supplied fields, exposes conflicts and invalidates a lock when its source changes", async () => {
  const root = await book(false);
  const resolved = await resolveMetadata(root);
  expect(resolved.metadata.title).toBe(
    (await openBook(root)).config.book.title,
  );
  expect(resolved.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "BOOKWALKER_CONFLICT",
      severity: "warning",
    }),
  );
  await fs.appendFile(path.join(root, "metadata/bookwalker.lock.json"), "\n");
  await expect(lockedMetadata(await openBook(root))).rejects.toMatchObject({
    code: "METADATA_LOCK_STALE",
  });
});
