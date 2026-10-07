import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { candidate, copyBook } from "./helpers.js";
import { openBook } from "../packages/core/src/config.js";
import {
  inspectBytes,
  validateInternal,
} from "../packages/core/src/validate.js";
import { attr, elements } from "../packages/core/src/xml.js";
import { json } from "../packages/core/src/json.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { schemaJson } from "../packages/core/src/index.js";

it("keeps the published book schema aligned with the executable navigation contract", async () => {
  const published = JSON.parse(
    await fs.readFile(path.join(repoRoot, "docs/book.schema.json"), "utf8"),
  );
  expect(published).toEqual(schemaJson());
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await copyBook("technical");
  roots.push(root);
  const { config } = await openBook(root);
  const chapters = ["first.md", "second.md", "third.md"];
  for (const [index, chapter] of chapters.entries())
    await fs.writeFile(
      path.join(root, chapter),
      `---\nid: article-${index}\ntitle: Article ${index}\nlang: en\n---\n\n# Article ${index}\n\n## Detail\n\nArticle text.\n`,
    );
  const navigation = [
    {
      title: "2020",
      children: [
        { title: "January", children: [chapters[0]] },
        { title: "February", children: [chapters[1]] },
      ],
    },
    { title: "2021", children: [chapters[2]] },
  ];
  await json(path.join(root, "book.yaml"), { ...config, chapters, navigation });
  return { root, config: { ...config, chapters, navigation } };
}
it("serializes nested groups, article headings and resolvable targets while preserving spine order", async () => {
  const { root } = await fixture();
  const bytes = await candidate(root);
  expect(validateInternal(bytes).diagnostics).toEqual([]);
  const info = inspectBytes(bytes, true);
  const navPath = info.manifest.find((item) =>
    item.properties.includes("nav"),
  )!.path;
  const document = info.documents.get(navPath)!;
  const toc = elements(document, "nav").find(
    (node) => attr(node, "epub:type") === "toc",
  )!;
  expect(elements(toc, "a").map((node) => node.textContent)).toEqual([
    "Contents",
    "2020",
    "January",
    "Article 0",
    "Detail",
    "February",
    "Article 1",
    "Detail",
    "2021",
    "Article 2",
    "Detail",
  ]);
  const firstLinks = elements(toc, "a")
    .slice(1, 4)
    .map((node) => attr(node, "href"));
  expect(new Set(firstLinks).size).toBe(1);
  expect(info.spine.filter((id) => id.startsWith("article-"))).toEqual([
    "article-0",
    "article-1",
    "article-2",
  ]);
  expect(info.entries.has("EPUB/cover.xhtml")).toBe(false);
  expect(
    elements(document, "a").some((node) => attr(node, "epub:type") === "cover"),
  ).toBe(false);
  expect((await candidate(root)).equals(bytes)).toBe(true);
});
it.each([
  ["en", "Contents"],
  ["en-US", "Contents"],
  ["zh", "目录"],
  ["zh-Hans", "目录"],
  ["ZH-cn", "目录"],
  ["zh-SG", "目录"],
  ["zh-Hant", "目錄"],
  ["zh-Hant-TW", "目錄"],
  ["zh-TW", "目錄"],
  ["zh-HK", "目錄"],
  ["zh-MO", "目錄"],
  ["zh-Hans-TW", "目录"],
  ["zh-Hant-CN", "目錄"],
  ["ja", "Contents"],
])(
  "adds a clickable %s contents page after an accessible cover with matching navigation labels",
  async (language, label) => {
    const { root, config } = await fixture();
    const book = {
      ...config.book,
      language,
      title: 'A "Book" & <notes>',
      authors: ["First & Author", 'Second "Author"'],
    };
    await json(path.join(root, "book.yaml"), {
      ...config,
      book,
      cover: { path: "assets/images/flow.svg" },
    });
    const bytes = await candidate(root);
    expect(validateInternal(bytes).diagnostics).toEqual([]);
    const info = inspectBytes(bytes, true);
    const coverLabel = /^zh(?:-|$)/i.test(language) ? "封面" : "Cover";
    const cover = info.manifest.find((item) => item.id === info.spine[0])!;
    expect(cover.path).toBe("EPUB/cover.xhtml");
    const contents = info.manifest.find((item) => item.id === info.spine[1])!;
    expect(contents.path).toBe("EPUB/contents.xhtml");
    expect(info.spine.slice(2)).toEqual([
      "article-0",
      "article-1",
      "article-2",
    ]);
    const document = info.documents.get(contents.path)!;
    expect(elements(document, "h1").map((node) => node.textContent)).toEqual([
      label,
    ]);
    expect(elements(document, "title")[0].textContent).toBe(label);
    expect(attr(document.documentElement!, "lang")).toBe(language);
    expect(elements(document, "nav").map((node) => attr(node, "role"))).toEqual(
      ["doc-toc"],
    );
    const coverDocument = info.documents.get(cover.path)!;
    expect(elements(coverDocument, "title")[0].textContent).toBe(book.title);
    expect(elements(coverDocument, "h1")).toHaveLength(0);
    expect(elements(coverDocument, "body")[0].textContent?.trim()).toBe("");
    expect(attr(elements(coverDocument, "main")[0], "epub:type")).toBe("cover");
    expect(elements(coverDocument, "img")).toHaveLength(1);
    expect(attr(elements(coverDocument, "img")[0], "alt")).toBe(
      'A "Book" & <notes> — First & Author, Second "Author"',
    );
    const coverImages = info.manifest.filter((item) =>
      item.properties.includes("cover-image"),
    );
    expect(coverImages).toHaveLength(1);
    expect(info.entries.get(coverImages[0].path)!.bytes).toEqual(
      await fs.readFile(path.join(root, "assets/images/flow.svg")),
    );
    expect(attr(elements(coverDocument, "img")[0], "src")).toBe(
      path.posix.relative("EPUB", coverImages[0].path),
    );

    const navDocument = info.documents.get("EPUB/nav.xhtml")!;
    const toc = elements(navDocument, "nav").find(
      (node) => attr(node, "epub:type") === "toc",
    )!;
    const list = elements(toc, "ol")[0];
    const items = elements(list, "li").filter(
      (node) => node.parentNode === list,
    );
    expect(items.map((item) => elements(item, "a")[0].textContent)).toEqual([
      coverLabel,
      label,
      "2020",
      "2021",
    ]);
    expect(elements(items[0], "ol")).toHaveLength(0);
    expect(attr(elements(items[0], "a")[0], "href")).toBe("cover.xhtml");
    expect(elements(items[1], "ol")).toHaveLength(0);
    expect(attr(elements(items[1], "a")[0], "href")).toBe("contents.xhtml");
    const links = (node: Parameters<typeof elements>[0]) =>
      elements(node, "a").map((link) => ({
        title: link.textContent,
        href: attr(link, "href"),
      }));
    expect(links(document)).toEqual(
      links(toc).filter((link) => link.href !== "contents.xhtml"),
    );
    expect(links(document).some((link) => link.href === "contents.xhtml")).toBe(
      false,
    );
    const landmarks = elements(navDocument, "nav").find(
      (node) => attr(node, "epub:type") === "landmarks",
    )!;
    expect(
      elements(landmarks, "a").map((node) => ({
        type: attr(node, "epub:type"),
        title: node.textContent,
        href: attr(node, "href"),
      })),
    ).toEqual([
      { type: "cover", title: coverLabel, href: "cover.xhtml" },
      { type: "toc", title: label, href: "contents.xhtml" },
      {
        type: "bodymatter",
        title: "Start of text",
        href: path.posix.relative(
          "EPUB",
          info.manifest.find((item) => item.id === "article-0")!.path,
        ),
      },
    ]);
  },
);
it("keeps the generated cover identifier distinct from a chapter identifier", async () => {
  const { root, config } = await fixture();
  const chapter = path.join(root, "first.md");
  await fs.writeFile(
    chapter,
    (await fs.readFile(chapter, "utf8")).replace(
      "id: article-0",
      "id: cover-page",
    ),
  );
  await json(path.join(root, "book.yaml"), {
    ...config,
    cover: { path: "assets/images/flow.svg" },
  });
  const bytes = await candidate(root);
  expect(validateInternal(bytes).diagnostics).toEqual([]);
  const info = inspectBytes(bytes);
  expect(info.spine[0]).not.toBe("cover-page");
  expect(info.spine[2]).toBe("cover-page");
  expect((await candidate(root)).equals(bytes)).toBe(true);
});
it("keeps generated contents identifiers distinct from author chapter identifiers", async () => {
  const { root } = await fixture();
  const chapter = path.join(root, "first.md");
  await fs.writeFile(
    chapter,
    (await fs.readFile(chapter, "utf8")).replace(
      "id: article-0",
      "id: contents",
    ),
  );
  const bytes = await candidate(root);
  expect(validateInternal(bytes).diagnostics).toEqual([]);
  const info = inspectBytes(bytes);
  expect(info.spine[0]).not.toBe("contents");
  expect(info.spine[1]).toBe("contents");
  expect((await candidate(root)).equals(bytes)).toBe(true);
});
it.each([
  ["omitted", ["first.md", "second.md"]],
  ["duplicate", ["first.md", "second.md", "second.md"]],
  ["unknown", ["first.md", "second.md", "absent.md"]],
  ["reordered", ["second.md", "first.md", "third.md"]],
])("rejects %s navigation leaves before building", async (_label, children) => {
  const { root, config } = await fixture();
  await json(path.join(root, "book.yaml"), {
    ...config,
    navigation: [{ title: "Group", children }],
  });
  await expect(openBook(root)).rejects.toMatchObject({
    code: "NAVIGATION_CHAPTERS",
  });
});
it("rejects empty navigation groups", async () => {
  const { root, config } = await fixture();
  await json(path.join(root, "book.yaml"), {
    ...config,
    navigation: [{ title: "Group", children: [] }],
  });
  await expect(openBook(root)).rejects.toMatchObject({
    code: "CONFIG_INVALID",
  });
});
