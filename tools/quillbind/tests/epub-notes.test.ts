import { expect, it } from "vitest";
import { inspectBytes } from "../packages/core/src/epub.js";
import { describeInspection } from "../packages/core/src/inspection.js";
import { applyRepair, planFromBytes } from "../packages/core/src/repair.js";
import { validateInternal } from "../packages/core/src/validate.js";
import { noteFixture } from "./note-fixture.js";
import { inspectNotes } from "../packages/core/src/epub-notes.js";

it("inventories local popup notes without claiming their scripts have run", () => {
  const bytes = noteFixture();
  const report = describeInspection(inspectBytes(bytes), bytes.length);
  expect(report).toMatchObject({
    notes: {
      kind: "scripted-note-candidate",
      execution: "not-run",
      scriptedDocuments: ["OEBPS/chapter.xhtml"],
      references: [
        {
          source: "OEBPS/chapter.xhtml",
          id: "ref",
          target: { path: "OEBPS/chapter.xhtml", fragment: "note" },
          resolution: "resolved",
          text: "A popup note.",
        },
      ],
    },
  });
});

it("recognizes EPUB namespace aliases and retains text wrapped by a return link", () => {
  const bytes = noteFixture((entries) =>
    entries.set(
      "OEBPS/chapter.xhtml",
      Buffer.from(
        entries
          .get("OEBPS/chapter.xhtml")!
          .toString()
          .replaceAll("epub:", "ops:")
          .replace("xmlns:epub=", "xmlns:ops=")
          .replaceAll(' role="doc-noteref"', "")
          .replace(
            '<p>A popup note. <a id="back" href="#ref" role="doc-backlink">Back</a></p>',
            '<a id="back" href="#ref"><p>A popup note.</p></a>',
          ),
      ),
    ),
  );
  expect(inspectNotes(inspectBytes(bytes)).references[0]).toMatchObject({
    resolution: "resolved",
    text: "A popup note.",
  });
});

it("preserves every content dependency during scripted-note reading repair", () => {
  const source = noteFixture((entries) =>
    entries.set(
      "OEBPS/package.opf",
      Buffer.from(
        entries
          .get("OEBPS/package.opf")!
          .toString()
          .replace('unique-identifier="id"', 'unique-identifier="missing"'),
      ),
    ),
  );
  const before = inspectBytes(source);
  const plan = planFromBytes(source, "reading");
  expect(
    plan.actions.filter((a) => a.classification === "unsupported"),
  ).toEqual([]);
  expect(
    plan.actions.find((a) => a.ruleId === "body-defaults")?.classification,
  ).toBe("review-required");
  const repaired = applyRepair(source, plan);
  expect(
    repaired.changes.some((a) => a.ruleId === "identifier-reference"),
  ).toBe(true);
  const after = inspectBytes(repaired.bytes);
  for (const [name, entry] of before.entries)
    if (![before.packagePath, "mimetype"].includes(name))
      expect(after.entries.get(name)?.bytes, name).toEqual(entry.bytes);
  expect(
    after.manifest.find((item) => item.id === "chapter")?.properties,
  ).toContain("scripted");
  expect(repaired.integrity).toMatchObject({
    scriptedContent: { status: "preserved", interactions: "not-run" },
  });
  expect(
    applyRepair(repaired.bytes, planFromBytes(repaired.bytes, "reading")).bytes,
  ).toEqual(repaired.bytes);
  expect(() => applyRepair(source, planFromBytes(source))).toThrow(
    /Unsupported/,
  );
  expect(
    validateInternal(repaired.bytes).diagnostics.some(
      (d) => d.code === "ACTIVE_CONTENT",
    ),
  ).toBe(true);
});

it("detects undeclared scripting and keeps unresolved or complex interactions protected", () => {
  const undeclared = noteFixture((entries) =>
    entries.set(
      "OEBPS/package.opf",
      Buffer.from(
        entries
          .get("OEBPS/package.opf")!
          .toString()
          .replace(' properties="scripted"', ""),
      ),
    ),
  );
  expect(inspectBytes(undeclared).unsupported).toContain("interactive-content");
  const repaired = applyRepair(
    undeclared,
    planFromBytes(undeclared, "reading"),
  );
  expect(
    inspectBytes(repaired.bytes).entries.get("OEBPS/chapter.xhtml")?.bytes,
  ).toEqual(inspectBytes(undeclared).entries.get("OEBPS/chapter.xhtml")?.bytes);
  for (const mutation of [
    (html: string) => html.replace('href="#note"', 'href="#missing"'),
    (html: string) =>
      html.replace("</body>", '<iframe src="chapter.xhtml"/></body>'),
    (html: string) =>
      html
        .replace('id="note"', 'id="duplicate"')
        .replace('id="back"', 'id="duplicate"'),
  ]) {
    const bytes = noteFixture((entries) =>
      entries.set(
        "OEBPS/chapter.xhtml",
        Buffer.from(mutation(entries.get("OEBPS/chapter.xhtml")!.toString())),
      ),
    );
    expect(() => applyRepair(bytes, planFromBytes(bytes, "reading"))).toThrow(
      /Unsupported/,
    );
  }
});
