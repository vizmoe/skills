import { it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  inspectBytes,
  validateInternal,
} from "../packages/core/src/validate.js";
import { applyRepair, planFromBytes } from "../packages/core/src/repair.js";
import { pack } from "../packages/core/src/zip.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { attr, elements } from "../packages/core/src/xml.js";
import { repairableCss } from "../packages/core/src/repair-css.js";

async function fixture(edit: (entries: Map<string, Buffer>) => void) {
  const source = await fs.readFile(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  const entries = new Map(
    [...inspectBytes(source).entries].map(([name, entry]) => [
      name,
      entry.bytes,
    ]),
  );
  edit(entries);
  return pack(entries, 946684800);
}

it("preserves HTTP hyperlinks and destination-only anchors without false review findings", async () => {
  const bytes = await fixture((entries) => {
    const file = "OEBPS/chapter.xhtml";
    entries.set(
      file,
      Buffer.from(
        entries
          .get(file)!
          .toString()
          .replace(
            "</body>",
            '<p><a id="destination"/><a href="http://example.org/book">Publisher</a><a href="mailto:editor@example.org">Editor</a></p></body>',
          ),
      ),
    );
  });
  const plan = planFromBytes(bytes);
  expect(
    plan.actions.filter((action) => action.ruleId === "link-target"),
  ).toEqual([]);
  const repaired = applyRepair(bytes, plan);
  expect(
    validateInternal(repaired.bytes).diagnostics.filter((d) =>
      ["LINK_NAME", "UNSAFE_URI"].includes(d.code),
    ),
  ).toEqual([]);
  expect(
    inspectBytes(repaired.bytes)
      .entries.get("OEBPS/chapter.xhtml")!
      .bytes.toString(),
  ).toContain('href="http://example.org/book"');
});

it("keeps active hyperlinks and remote embedded resources blocked", async () => {
  const bytes = await fixture((entries) => {
    const file = "OEBPS/chapter.xhtml";
    entries.set(
      file,
      Buffer.from(
        entries
          .get(file)!
          .toString()
          .replace(
            "</body>",
            '<p><a href="javascript:alert(1)">Run</a><img alt="Remote" src="https://example.org/image.png"/></p></body>',
          ),
      ),
    );
  });
  expect(
    planFromBytes(bytes).actions.some(
      (action) =>
        action.ruleId === "link-target" &&
        action.classification === "review-required",
    ),
  ).toBe(true);
  expect(
    validateInternal(bytes).diagnostics.filter((d) => d.code === "UNSAFE_URI"),
  ).toHaveLength(2);
});

it("uses the recognized NCX doctype during repair without changing NCX bytes", async () => {
  const bytes = await fixture((entries) => {
    const file = "OEBPS/toc.ncx";
    entries.set(
      file,
      Buffer.from(
        entries
          .get(file)!
          .toString()
          .replace(
            "<ncx",
            '<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd"><ncx',
          ),
      ),
    );
  });
  const repaired = applyRepair(bytes, planFromBytes(bytes));
  expect(repaired.integrity).toMatchObject({ status: "pass" });
  expect(
    inspectBytes(repaired.bytes).entries.get("OEBPS/toc.ncx")!.bytes,
  ).toEqual(inspectBytes(bytes).entries.get("OEBPS/toc.ncx")!.bytes);
  expect(
    applyRepair(repaired.bytes, planFromBytes(repaired.bytes)).bytes,
  ).toEqual(repaired.bytes);
});

it("inherits a missing document language from the publication and preserves explicit languages", async () => {
  const bytes = await fixture((entries) => {
    const file = "OEBPS/chapter.xhtml";
    entries.set(
      file,
      Buffer.from(
        entries
          .get(file)!
          .toString()
          .replace(/\s(?:xml:)?lang="[^"]*"/g, ""),
      ),
    );
  });
  const repaired = applyRepair(bytes, planFromBytes(bytes));
  const info = inspectBytes(repaired.bytes);
  const root = info.documents.get("OEBPS/chapter.xhtml")!.documentElement!;
  expect(attr(root, "lang")).toBe(info.language);
  expect(attr(root, "xml:lang")).toBe(info.language);
  expect(
    validateInternal(repaired.bytes).diagnostics.some(
      (d) => d.code === "DOCUMENT_LANGUAGE",
    ),
  ).toBe(false);
});

it("removes only font-face rules with exclusively absent local font files", async () => {
  const bytes = await fixture((entries) => {
    const file = "OEBPS/style.css";
    entries.set(
      file,
      Buffer.from(
        entries.get(file)!.toString() +
          '\n@font-face {font-family: absent; src: url(missing.ttf)}\n@font-face {font-family: installed; src: local("serif"), url(missing-too.ttf)}\n',
      ),
    );
  });
  const plan = planFromBytes(bytes);
  expect(
    plan.actions.some(
      (a) => a.ruleId === "missing-font-face" && a.classification === "safe",
    ),
  ).toBe(true);
  const repaired = applyRepair(bytes, plan);
  const css = inspectBytes(repaired.bytes)
    .entries.get("OEBPS/style.css")!
    .bytes.toString();
  expect(css).not.toContain("font-family: absent");
  expect(css).toContain('local("serif")');
  expect(css).not.toContain("missing-too.ttf");
  expect(
    elements(inspectBytes(repaired.bytes).packageDocument, "identifier")[0]
      .textContent,
  ).toBe(
    elements(inspectBytes(bytes).packageDocument, "identifier")[0].textContent,
  );
});

it("keeps reading copies at the original EPUB version and binds purpose into the plan", async () => {
  const bytes = await fixture(() => {});
  const plan = planFromBytes(bytes, "reading");
  const repaired = applyRepair(bytes, plan);
  const info = inspectBytes(repaired.bytes);
  expect(info.version).toBe("2.0");
  expect(attr(info.packageDocument.documentElement!, "xml:lang")).toBe(
    attr(inspectBytes(bytes).packageDocument.documentElement!, "xml:lang"),
  );
  expect(info.spine).toEqual(inspectBytes(bytes).spine);
  expect(info.manifest.some((m) => m.properties.includes("nav"))).toBe(false);
  expect(repaired.integrity).toMatchObject({ status: "pass" });
  expect(
    applyRepair(repaired.bytes, planFromBytes(repaired.bytes, "reading")).bytes,
  ).toEqual(repaired.bytes);
  expect(() =>
    applyRepair(bytes, { ...plan, purpose: "publication" }),
  ).toThrow();
});

it("repairs CSS punctuation only outside literal strings and comments", () => {
  const source =
    '/* keep； */ .art { margin:10% 5% 5% 10%；\nwidth:50%; content:"literal；"; }';
  expect(repairableCss(source)).toEqual({
    changed: true,
    source: source.replace("10%；", "10%;"),
  });
  expect(repairableCss('p::before { content:"；"; }').changed).toBe(false);
  expect(repairableCss("p { color: red；\nwidth:50%; broken }").changed).toBe(
    false,
  );
});

it("repairs a dangling unique-identifier reference without replacing the identifier", async () => {
  const bytes = await fixture((entries) => {
    const file = "OEBPS/content.opf";
    entries.set(
      file,
      Buffer.from(
        entries
          .get(file)!
          .toString()
          .replace(/unique-identifier="[^"]+"/, 'unique-identifier="missing"'),
      ),
    );
  });
  const repaired = applyRepair(bytes, planFromBytes(bytes, "reading"));
  expect(repaired.integrity).toMatchObject({ status: "pass" });
  expect(
    validateInternal(repaired.bytes).diagnostics.some(
      (d) => d.code === "METADATA_IDENTIFIER",
    ),
  ).toBe(false);
});

it("synchronizes an empty NCX identifier without changing navigation targets", async () => {
  const bytes = await fixture((entries) => {
    const file = "OEBPS/toc.ncx";
    entries.set(
      file,
      Buffer.from(
        entries
          .get(file)!
          .toString()
          .replace(
            /name="dtb:uid" content="[^"]*"/,
            'name="dtb:uid" content=""',
          ),
      ),
    );
  });
  const repaired = applyRepair(bytes, planFromBytes(bytes, "reading"));
  const info = inspectBytes(repaired.bytes);
  expect(info.entries.get("OEBPS/toc.ncx")!.bytes.toString()).toContain(
    elements(info.packageDocument, "identifier")[0].textContent!,
  );
  expect(repaired.integrity).toMatchObject({ status: "pass" });
  expect(
    applyRepair(repaired.bytes, planFromBytes(repaired.bytes, "reading")).bytes,
  ).toEqual(repaired.bytes);
});
