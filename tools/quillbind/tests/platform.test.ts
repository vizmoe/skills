import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { bodymatterItems, copyBook, candidate } from "./helpers.js";
import { openBook } from "../packages/core/src/config.js";
import {
  inspectBytes,
  compatibilityLint,
} from "../packages/core/src/validate.js";
import { pack } from "../packages/core/src/zip.js";
import { json } from "../packages/core/src/json.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await copyBook("technical");
  roots.push(root);
  const bytes = await candidate(root);
  const info = inspectBytes(bytes);
  return {
    root,
    bytes,
    info,
    entries: new Map(
      [...info.entries].map(([name, entry]) => [name, entry.bytes]),
    ),
  };
}
it("accepts in-book HTML covers and Chinese languages without Kindle distribution diagnostics", async () => {
  const { root } = await fixture();
  const { config } = await openBook(root);
  await json(path.join(root, "book.yaml"), {
    ...config,
    cover: { path: "assets/images/flow.svg" },
  });
  const covered = await candidate(root);
  const info = inspectBytes(covered);
  expect(info.documents.has("EPUB/cover.xhtml")).toBe(true);
  expect(
    info.manifest.some((item) => item.properties.includes("cover-image")),
  ).toBe(true);
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  const originalPackage = entries.get(info.packagePath)!.toString();
  for (const language of ["en", "zh", "zh-Hans", "zh-CN", "zh-SG", "zh-Hant"]) {
    entries.set(
      info.packagePath,
      Buffer.from(
        originalPackage.replace(
          "<dc:language>en</dc:language>",
          `<dc:language>${language}</dc:language>`,
        ),
      ),
    );
    const kindle = await compatibilityLint(pack(entries, 946684800), "kindle");
    expect(kindle, language).toMatchObject({
      status: "pass",
      distribution: "compatible",
      diagnostics: [],
    });
  }
});
it("accepts supported MathML and diagnoses unsupported Kindle elements and nested tables", async () => {
  const { bytes, info, entries } = await fixture();
  const good = await compatibilityLint(bytes, "kindle");
  expect(good.diagnostics.some((d) => /MATHML/.test(d.code))).toBe(false);
  const chapter = bodymatterItems(info)[0].path;
  entries.set(
    chapter,
    Buffer.from(
      entries
        .get(chapter)!
        .toString()
        .replace(
          "</main>",
          '<math xmlns="http://www.w3.org/1998/Math/MathML"><maction><mi>x</mi></maction></math><table><tr><td><table><tr><td>Nested</td></tr></table></td></tr></table></main>',
        ),
    ),
  );
  const report = await compatibilityLint(pack(entries, 946684800), "kindle");
  expect(report.diagnostics.map((d) => d.code)).toEqual(
    expect.arrayContaining(["KINDLE_MATHML_ELEMENT", "KINDLE_NESTED_TABLE"]),
  );
});
it("separates top-to-bottom vertical text from right-to-left page progression", async () => {
  const { root } = await fixture();
  const book = await openBook(root);
  await json(path.join(root, "book.yaml"), {
    ...book.config,
    writingMode: "vertical-rl",
    direction: "ltr",
  });
  const info = inspectBytes(await candidate(root));
  expect(info.packageDocument.documentElement!.getAttribute("dir")).toBe("ltr");
  expect(
    info.packageDocument
      .getElementsByTagName("spine")[0]
      .getAttribute("page-progression-direction"),
  ).toBe("rtl");
  for (const document of info.documents.values()) {
    expect(document.documentElement!.getAttribute("class")).toBe("vertical");
    expect(document.documentElement!.getAttribute("dir")).toBe("ltr");
  }
});
it("requires explicit Chinese script metadata for Apple without inferring it", async () => {
  const { entries, info } = await fixture();
  entries.set(
    info.packagePath,
    Buffer.from(
      entries
        .get(info.packagePath)!
        .toString()
        .replace(
          "<dc:language>en</dc:language>",
          "<dc:language>zh-CN</dc:language>",
        ),
    ),
  );
  const report = await compatibilityLint(
    pack(entries, 946684800),
    "apple-books",
  );
  expect(report.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "APPLE_LANGUAGE_SCRIPT",
      severity: "error",
    }),
  );
});
it("diagnoses CMYK without converting or overwriting the supplied JPEG", async () => {
  const { root } = await fixture();
  const book = await openBook(root);
  const bytes = await sharp({
    create: { width: 24, height: 24, channels: 3, background: "red" },
  })
    .toColourspace("cmyk")
    .jpeg()
    .toBuffer();
  const source = "assets/images/cmyk.jpg";
  await fs.writeFile(path.join(root, source), bytes);
  await fs.appendFile(
    path.join(root, book.config.chapters[0]),
    `\n\n![Red swatch](${source})\n`,
  );
  const output = await candidate(root);
  const info = inspectBytes(output);
  const resource = info.manifest.find((m) => m.mediaType === "image/jpeg")!;
  expect(info.entries.get(resource.path)!.bytes.equals(bytes)).toBe(true);
  for (const platform of ["apple-books", "kindle"] as const)
    expect(
      (await compatibilityLint(output, platform)).diagnostics,
    ).toContainEqual(
      expect.objectContaining({ code: "IMAGE_COLORSPACE", severity: "error" }),
    );
});
