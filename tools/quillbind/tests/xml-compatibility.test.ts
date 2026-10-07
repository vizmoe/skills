import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contentXml, passiveSvg, serialize } from "../packages/core/src/xml.js";
import { xhtmlEntities } from "../packages/core/src/xhtml-entities.js";
import { inspectEpub, auditEpub } from "../packages/core/src/index.js";
import { inspectBytes } from "../packages/core/src/epub.js";
import { applyRepair, planFromBytes } from "../packages/core/src/repair.js";
import { pack } from "../packages/core/src/zip.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { copyBook, candidate } from "./helpers.js";
import { openBook } from "../packages/core/src/config.js";
import { validateInternal } from "../packages/core/src/validate.js";

const doctype =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">';
const wrap = (text: string) =>
  `${doctype}<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${text}</p></body></html>`;

it("decodes all 253 XHTML entities in text and quoted attributes", () => {
  expect(Object.keys(xhtmlEntities)).toHaveLength(253);
  for (const [name, point] of Object.entries(xhtmlEntities)) {
    const document = contentXml(
      `${doctype}<html title="&${name};">&${name};</html>`,
      "chapter.xhtml",
    );
    expect(document.documentElement!.textContent).toBe(
      String.fromCodePoint(point),
    );
    expect(document.documentElement!.getAttribute("title")).toBe(
      String.fromCodePoint(point),
    );
  }
  expect(
    contentXml(
      wrap(
        "&eacute;&ocirc;&egrave;&uuml;&ntilde;&trade;&bull;&laquo;&Alpha;&OElig;",
      ),
      "fr.xhtml",
    ).documentElement!.textContent,
  ).toBe("éôèüñ™•«ΑŒ");
});

it("leaves literal entity-looking text intact and never recursively expands it", () => {
  const document = contentXml(
    wrap("<!-- &unknown; --><![CDATA[&unknown; &eacute;]]>&amp;eacute;"),
    "literal.xhtml",
  );
  expect(document.documentElement!.textContent).toBe(
    "&unknown; &eacute;&eacute;",
  );
  expect(serialize(document)).toContain("<!-- &unknown; -->");
  expect(
    contentXml(wrap("&eacute;").replaceAll('"', "'"), "quoted.xhtml")
      .documentElement!.textContent,
  ).toBe("é");
});

it("identifies an unsupported legacy entity and keeps arbitrary DTDs blocked", () => {
  expect(() => contentXml(wrap("&NotEqualTilde;"), "OEBPS/fr.xhtml")).toThrow(
    expect.objectContaining({
      code: "LEGACY_ENTITY_UNSUPPORTED",
      message: expect.stringContaining(
        "OEBPS/fr.xhtml: unsupported XHTML 1.x entity &NotEqualTilde;",
      ),
      details: { source: "OEBPS/fr.xhtml", entity: "NotEqualTilde" },
    }),
  );
  for (const source of [
    '<!DOCTYPE html SYSTEM "https://evil.example/book.dtd"><html/>',
    doctype.replace(">", ' [<!ENTITY custom SYSTEM "file:///etc/passwd">]>') +
      "<html>&custom;</html>",
  ])
    expect(() => contentXml(source, "hostile.xhtml")).toThrow(
      expect.objectContaining({ code: "XXE_BLOCKED" }),
    );
  expect(() => contentXml("<html>&eacute;</html>", "modern.xhtml")).toThrow(
    expect.objectContaining({ code: "XML_INVALID" }),
  );
});

it("inspects, audits and repairs a legacy multilingual chapter while preserving its source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-entities-"));
  try {
    const original = await fs.readFile(
      path.join(repoRoot, "examples/repair/legacy.epub"),
    );
    const entries = new Map(
      [...inspectBytes(original).entries].map(([name, entry]) => [
        name,
        entry.bytes,
      ]),
    );
    const chapter = "OEBPS/chapter.xhtml";
    entries.set(
      chapter,
      Buffer.from(
        entries
          .get(chapter)!
          .toString()
          .replace("<html", doctype + "<html")
          .replace("A repair", "&eacute;&uuml;&ntilde;&trade; A repair"),
      ),
    );
    const bytes = pack(entries, 946684800);
    const file = path.join(root, "legacy.epub");
    await fs.writeFile(file, bytes);
    await inspectEpub(file);
    await auditEpub(file);
    expect(await fs.readFile(file)).toEqual(bytes);
    const repaired = applyRepair(bytes, planFromBytes(bytes));
    expect(repaired.integrity).toMatchObject({ status: "pass" });
    expect(
      inspectBytes(repaired.bytes).documents.get(chapter)!.documentElement!
        .textContent,
    ).toContain("éüñ™ A repair");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each([
  '<rect style="fill:#f5f0e6;stroke:rgb(1, 2, 3);stroke-width:2"/>',
  '<style>.bg{fill:#f5f0e6} @media (min-width:1px){.bg{opacity:.9}}</style><rect class="bg"/>',
  '<style><![CDATA[.title {font-family:Arial; font-size:30px; fill:red !important}]]></style><text class="title">Cover</text>',
])("accepts static SVG styling: %s", (content) => {
  expect(() =>
    passiveSvg(
      `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`,
      "cover.svg",
    ),
  ).not.toThrow();
});

it("packages a styled SVG cover without changing its bytes", async () => {
  const root = await copyBook();
  try {
    const { config } = await openBook(root);
    const bytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800"><style>.bg{fill:#f5f0e6}</style><rect class="bg" width="600" height="800"/><text x="40" y="80" style="fill:#222;font-size:32px">Cover</text></svg>',
    );
    await fs.writeFile(path.join(root, "cover.svg"), bytes);
    await fs.writeFile(
      path.join(root, "book.yaml"),
      JSON.stringify({ ...config, cover: { path: "cover.svg" } }),
    );
    const publication = inspectBytes(await candidate(root));
    expect(validateInternal(publication).status).toBe("pass");
    const cover = publication.manifest.find((item) =>
      item.properties.includes("cover-image"),
    )!;
    expect(publication.entries.get(cover.path)!.bytes).toEqual(bytes);
    expect(await fs.readFile(path.join(root, "cover.svg"))).toEqual(bytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each([
  '<rect style="fill:url(https://evil.example/a)"/>',
  '<rect style="fill:u/**/rl(https://evil.example/a)"/>',
  '<rect style="fill:u\\72l(https://evil.example/a)"/>',
  '<rect style="background:image-set(&quot;https://evil.example/a&quot; 1x)"/>',
  '<style>@import "https://evil.example/a";</style>',
  "<style>@font-face{font-family:x;src:url(x.woff)}</style>",
  "<style>rect{fill:expression(alert(1))}</style>",
  "<style>rect{animation:pulse 1s}</style>",
  '<rect style="-moz-binding:url(x)"/>',
  "<style>@keyframes pulse{to{opacity:0}}</style>",
  "<script>alert(1)</script>",
  '<rect onload="alert(1)"/>',
  "<foreignObject/>",
  '<animate attributeName="fill"/>',
  '<image href="https://evil.example/a"/>',
  '<?xml-stylesheet href="https://evil.example/a"?>',
])("rejects SVG execution and resource loading: %s", (content) => {
  expect(() =>
    passiveSvg(
      `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`,
      "cover.svg",
    ),
  ).toThrow();
});
