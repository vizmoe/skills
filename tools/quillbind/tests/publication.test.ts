import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createMathCompiler, mathml } from "../packages/core/src/math.js";
import { openBook } from "../packages/core/src/config.js";
import { resolveMetadataWithLock } from "../packages/core/src/metadata.js";
import { preflightBook } from "../packages/core/src/preflight.js";
import { publicationFromBook } from "../packages/core/src/publication.js";
import { pack } from "../packages/core/src/zip.js";
import { renderPublication } from "../packages/core/src/render.js";
import type { Inline, Block } from "../packages/core/src/model.js";
import { candidate, copyBook } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

it("requires the fields for each publication node kind", () => {
  // @ts-expect-error An image needs a source and alternative text.
  const image: Inline = { kind: "image" };
  // @ts-expect-error TeX alone is not a serializable publication formula.
  const math: Block = { kind: "math", text: "x" };
  // @ts-expect-error Heading identity and level are required.
  const heading: Block = { kind: "heading", inlines: [] };
  expect([image.kind, math.kind, heading.kind]).toEqual([
    "image",
    "math",
    "heading",
  ]);
});

it.each(["$x$", "**$x$**", "*$x$*"])(
  "preserves the plain title of a heading containing %s",
  async (formula) => {
    const root = await copyBook();
    roots.push(root);
    await fs.writeFile(
      path.join(root, "chapters/01-arrival.md"),
      `---\nid: arrival\ntitle: Equation x\nlang: en\n---\n\n# Equation ${formula}\n`,
    );
    const preflight = await preflightBook(root);
    expect(preflight.status).toBe("pass");
    expect(preflight.documents[0].sections[0].title).toBe("Equation x");
  },
);

it("keeps cached conversions independent of callers and source imports", () => {
  const compile = createMathCompiler();
  const first = compile("x^2", false);
  expect(compile("x^2", false)).toEqual(first);
  expect(compile("y^2", false).mathml).toContain("<math");
  expect(compile("x^2", true).display).toBe(true);
  first.mathml = "changed by a caller";
  expect(compile("x^2", false).mathml).not.toBe(first.mathml);
  expect(createMathCompiler()("x^2", false)).toEqual(compile("x^2", false));
});

it("isolates operator definitions, equation labels and failed conversions", () => {
  const compile = createMathCompiler();
  const expression = String.raw`\DeclareMathOperator{\customop}{custom}\customop x`;
  expect(compile(expression, false).mathml).toBe(mathml(expression, false));
  expect(() => compile(String.raw`\customop x`, false)).toThrow();
  const shadow = String.raw`\DeclareMathOperator{\sin}{custom}\sin x`;
  expect(compile(shadow, false).mathml).toBe(mathml(shadow, false));
  expect(compile(String.raw`\sin y`, false).mathml).toBe(
    mathml(String.raw`\sin y`, false),
  );
  for (const tex of [
    String.raw`x\tag{1}\label{same}`,
    String.raw`y\tag{2}\label{same}`,
  ])
    expect(compile(tex, true).mathml).toBe(mathml(tex, true));
  expect(() =>
    compile(
      String.raw`\DeclareMathOperator{\failedop}{failed}\notARealMacro`,
      false,
    ),
  ).toThrow();
  expect(() => compile(String.raw`\failedop x`, false)).toThrow();
  expect(compile("z", false).mathml).toBe(mathml("z", false));
});

it.each([String.raw`$\notARealMacro{x}$`, "$$\n\\notARealMacro{x}\n$$"])(
  "reports invalid math in preflight: %s",
  async (source) => {
    const root = await copyBook();
    roots.push(root);
    await fs.appendFile(
      path.join(root, "chapters/01-arrival.md"),
      `\n${source}\n`,
    );
    const preflight = await preflightBook(root);
    expect(preflight.status).toBe("fail");
    expect(preflight.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "MATH_CONVERSION",
        source: "chapters/01-arrival.md",
      }),
    );
  },
);

it("assembles prepared documents once and renders them without MathJax or source access", async () => {
  const root = await copyBook("technical");
  roots.push(root);
  const book = await openBook(root);
  const { lock } = await resolveMetadataWithLock(book);
  const preflight = await preflightBook(book);
  expect(preflight.status).toBe("pass");
  await fs.appendFile(
    path.join(root, book.config.chapters[0]),
    "\n$\\notARealMacro$\n",
  );
  const publication = await publicationFromBook(book, {
    lock,
    documents: preflight.documents,
  });
  expect(publication.documents).toBe(preflight.documents);
  expect(
    publication.documents
      .flatMap((doc) => doc.blocks)
      .find((block) => block.kind === "math"),
  ).toMatchObject({ expression: { mathml: expect.stringContaining("<math") } });
  publication.cover = publication.resources.find((resource) =>
    resource.mediaType.startsWith("image/"),
  )?.href;
  publication.resources.forEach(Object.freeze);
  const before = JSON.stringify(publication);
  const first = await renderPublication(publication);
  expect(await renderPublication(publication)).toEqual(first);
  expect(JSON.stringify(publication)).toBe(before);
  const detached = structuredClone(publication);
  const math = detached.documents
    .flatMap((doc) => doc.blocks)
    .find((block) => block.kind === "math");
  if (!math) throw new Error("Technical fixture must contain math");
  math.expression.tex = String.raw`\notARealMacro`;
  expect(
    pack(await renderPublication(detached), book.config.build.epoch),
  ).toEqual(pack(first, book.config.build.epoch));
  await expect(candidate(root)).rejects.toMatchObject({
    code: "PREFLIGHT_FAILED",
  });
});
