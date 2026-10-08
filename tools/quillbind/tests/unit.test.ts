import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";
import {
  openBook,
  validIsbn,
  validLanguage,
  schemaJson,
  taxonomy,
} from "../packages/core/src/config.js";
import {
  resolveMetadata,
  lockedMetadata,
} from "../packages/core/src/metadata.js";
import { initBook } from "../packages/core/src/init.js";
import { preflightBook } from "../packages/core/src/markdown.js";
import { mathml } from "../packages/core/src/math.js";
import { json } from "../packages/core/src/json.js";
import { xml, elements, NS } from "../packages/core/src/xml.js";
import { copyBook } from "./helpers.js";
const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function book(theme?: string) {
  const root = await copyBook(theme);
  temporary.push(root);
  return root;
}
describe("metadata", () => {
  it.each(["9780306406157", "978-0-306-40615-7"])(
    "validates ISBN-13 %s",
    (isbn) => expect(validIsbn(isbn)).toBe(true),
  );
  it.each(["9780306406158", "123", "1234567890128", "978030640615X"])(
    "rejects invalid ISBN %s",
    (isbn) => expect(validIsbn(isbn)).toBe(false),
  );
  it("checks the ISBN checksum property", () =>
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9 }), {
          minLength: 9,
          maxLength: 9,
        }),
        (digits) => {
          const head = "978" + digits.join("");
          const sum = [...head].reduce(
            (s, d, i) => s + Number(d) * (i % 2 ? 3 : 1),
            0,
          );
          const value = head + ((10 - (sum % 10)) % 10);
          expect(validIsbn(value)).toBe(true);
          expect(
            validIsbn(value.slice(0, -1) + ((Number(value.at(-1)) + 1) % 10)),
          ).toBe(false);
        },
      ),
    ));
  it.each(["en", "zh-Hans", "ar", "en-US", "ja"])(
    "accepts BCP47 %s",
    (language) => expect(validLanguage(language)).toBe(true),
  );
  it.each(["", "en_US", "123", "English language"])(
    "rejects invalid language %s",
    (language) => expect(validLanguage(language)).toBe(false),
  );
  it("locks offline metadata without changing publication identity", async () => {
    const root = await book();
    const first = await resolveMetadata(root);
    const second = await resolveMetadata(root);
    expect(first.status).toBe("pass");
    expect(second.metadata.identifier).toEqual(first.metadata.identifier);
    expect(await lockedMetadata(await openBook(root))).toHaveProperty(
      "schemaVersion",
      1,
    );
  });
  it("blocks missing required fields and unknown controlled tags", async () => {
    const root = await book();
    const file = path.join(root, "book.yaml");
    const input = await fs.readFile(file, "utf8");
    await fs.writeFile(
      file,
      input
        .replace("title: 山间来信", 'title: ""')
        .replace("Literature.Essays", "随笔"),
    );
    const resolved = await resolveMetadata(root);
    expect(resolved.status).toBe("fail");
    expect(resolved.diagnostics.map((d) => d.code)).toContain(
      "METADATA_MISSING",
    );
    expect(resolved.diagnostics.map((d) => d.code)).toContain("UNKNOWN_TAG");
  });
  it.each(["9780306406157", "978-0-306-40615-7"])(
    "requires an explicit EPUB edition decision for ISBN %s alone",
    async (isbn) => {
      const root = await book();
      const file = path.join(root, "book.yaml");
      await fs.writeFile(
        file,
        (await fs.readFile(file, "utf8")).replace(
          "isbn: null",
          `isbn: "${isbn}"`,
        ),
      );
      expect(
        (await resolveMetadata(root)).diagnostics.map((d) => d.code),
      ).toContain("ISBN_EDITION_CONFIRMATION");
      await json(path.join(root, "metadata/decisions.json"), {
        isbn: { value: "9780306406157", edition: "epub", approved: true },
      });
      const resolved = await resolveMetadata(root);
      expect(resolved.status).toBe("pass");
      expect(resolved.fields.isbn).toBe("resolved");
      expect(resolved.metadata.publication).toEqual({ isbn: "9780306406157" });
      expect(resolved.metadata.identifier).toEqual({
        scheme: "isbn",
        value: "urn:isbn:9780306406157",
      });
      expect((await lockedMetadata(await openBook(root))).metadata).toEqual(
        resolved.metadata,
      );
    },
  );
  it("uses a persistent UUID and skips discovery for null ISBN without confirmation", async () => {
    const root = await book();
    const fetcher = vi.fn(async () => ({ results: [] }));
    const first = await resolveMetadata(root, { online: true, fetcher });
    expect(first.status).toBe("pass");
    expect(first.fields.isbn).toBe("supplied");
    expect(first.metadata.publication).toEqual({ isbn: null });
    expect(first.metadata.identifier.scheme).toBe("uuid");
    // An earlier edition decision must not override the current ISBN field.
    await json(path.join(root, "metadata/decisions.json"), {
      isbn: { value: "9780306406157", edition: "epub", approved: true },
    });
    const second = await resolveMetadata(root, { online: true, fetcher });
    expect(second.status).toBe("pass");
    expect(second.metadata.identifier).toEqual(first.metadata.identifier);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["", " ", "9780306406158"])(
    "blocks invalid ISBN %j instead of treating it as null or querying a provider",
    async (isbn) => {
      const root = await book();
      const file = path.join(root, "book.yaml");
      await fs.writeFile(
        file,
        (await fs.readFile(file, "utf8")).replace(
          "isbn: null",
          `isbn: "${isbn}"`,
        ),
      );
      const previous = await fs.readFile(
        path.join(root, "metadata/sources.lock.json"),
      );
      const fetcher = vi.fn(async () => ({ results: [] }));
      const resolved = await resolveMetadata(root, { online: true, fetcher });
      expect(resolved.status).toBe("fail");
      expect(resolved.diagnostics.map((d) => d.code)).toContain(
        "ISBN_CHECKSUM",
      );
      expect(resolved.metadata.publication.isbn).not.toBeNull();
      expect(resolved.metadata.identifier.scheme).not.toBe("uuid");
      expect(fetcher).not.toHaveBeenCalled();
      expect(
        await fs.readFile(path.join(root, "metadata/sources.lock.json")),
      ).toEqual(previous);
    },
  );
  it("initializes ISBN-only configuration and rejects a redundant status", async () => {
    const root = await book();
    const initialized = path.join(root, "new-book");
    await initBook(initialized);
    expect((await openBook(initialized)).config.book.publication).toEqual({
      isbn: null,
    });
    const file = path.join(initialized, "book.yaml");
    await fs.writeFile(
      file,
      (await fs.readFile(file, "utf8")).replace(
        "isbn: null",
        "isbn: null\n    status: unpublished",
      ),
    );
    await expect(openBook(initialized)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining('Unrecognized key: "status"'),
    });
  });
  it("requires an explicit ISBN value or null", async () => {
    const root = await book();
    const file = path.join(root, "book.yaml");
    await fs.writeFile(
      file,
      (await fs.readFile(file, "utf8")).replace(
        "publication:\n    isbn: null",
        "publication: {}",
      ),
    );
    await expect(openBook(root)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("book.publication.isbn"),
    });
  });
  it("invalidates metadata locks after config changes", async () => {
    const root = await book();
    await resolveMetadata(root);
    await fs.appendFile(path.join(root, "book.yaml"), "\n# source changed\n");
    await expect(lockedMetadata(await openBook(root))).rejects.toHaveProperty(
      "code",
      "METADATA_LOCK_STALE",
    );
  });
  it("keeps online discovery candidates separate from confirmed data", async () => {
    const root = await book();
    const file = path.join(root, "book.yaml");
    await fs.writeFile(
      file,
      (await fs.readFile(file, "utf8")).replace(
        "isbn: null",
        'isbn: "978-0-306-40615-7"',
      ),
    );
    await json(path.join(root, "metadata/decisions.json"), {
      isbn: { value: "9780306406157", edition: "epub", approved: true },
    });
    const fetcher = vi.fn(async () => ({
      results: [
        {
          id: "https://www.loc.gov/item/example/",
          title: "A different edition",
          contributor: ["Different Author"],
        },
      ],
    }));
    const resolution = await resolveMetadata(root, {
      online: true,
      fetcher,
    });
    expect(resolution.status).toBe("pass");
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://www.loc.gov/books/?fo=json&c=20&q=9780306406157",
      undefined,
    );
    expect(resolution.metadata.authors[0].name).toBe("Quillbind 示例作者");
    expect(
      resolution.candidates.some((c) => c.conflicts.length > 0 && !c.approved),
    ).toBe(true);
  });
});
describe("chapters and rendering", () => {
  it("parses all documented technical structures independently", async () => {
    const result = await preflightBook(await book("technical"));
    expect(result.status).toBe("pass");
    const kinds = result.documents.flatMap((d) => d.blocks.map((b) => b.kind));
    for (const kind of [
      "code",
      "math",
      "table",
      "admonition",
      "definition",
      "figure",
      "bibliography",
    ])
      expect(kinds).toContain(kind);
    expect(result.documents[0].footnotes.length).toBe(1);
  });
  it.each([
    ["\n# Another title\n", "CHAPTER_H1"],
    ["\n```ts\nconst x = 1;\n", "UNCLOSED_FENCE"],
    ["\n<script>alert(1)</script>\n", "RAW_HTML_FORBIDDEN"],
    ["\n#### Skipped level\n", "HEADING_SEQUENCE"],
    ["\n::unknown[content]\n", "UNSUPPORTED_MARKDOWN"],
  ])("rejects invalid chapter %s", async (content, code) => {
    const root = await book();
    await fs.appendFile(path.join(root, "chapters/01-arrival.md"), content);
    expect(
      (await preflightBook(root)).diagnostics.map((d) => d.code),
    ).toContain(code);
  });
  it("does not execute HTML or command examples inside fenced code", async () => {
    const root = await book();
    await fs.appendFile(
      path.join(root, "chapters/01-arrival.md"),
      "\n```sh\n<script>not executed</script>\n$(touch /tmp/quillbind-injection)\n```\n",
    );
    expect((await preflightBook(root)).status).toBe("pass");
  });
  it("keeps TeX semantic MathML and fails invalid macros", () => {
    const output = mathml("x^2", false);
    expect(elements(xml(output), "math", NS.math).length).toBe(1);
    expect(() => mathml("\\notARealMacro{x}", false)).toThrow();
  });
  it("exports JSON Schema 2020-12 and separates taxonomy from themes", async () => {
    expect(schemaJson().$schema).toContain("2020-12");
    expect(
      (await taxonomy()).subjects.find(
        (t) => t.id === "Science.Software Engineering",
      )?.basis.scheme,
    ).toBe("LCC-inspired");
  });
});
