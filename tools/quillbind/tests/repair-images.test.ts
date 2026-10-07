import { expect, it } from "vitest";
import { applyRepair, planFromBytes } from "../packages/core/src/repair.js";
import {
  inspectBytes,
  validateInternal,
} from "../packages/core/src/validate.js";
import { attr, elements, serialize } from "../packages/core/src/xml.js";
import {
  repairImageChapter,
  repairImageFixture,
  repairImagePath,
} from "./repair-image-fixture.js";

it("repairs standalone images while preserving mixed content, links, captions and image bytes", async () => {
  const source = await repairImageFixture();
  const originalBytes = Buffer.from(source);
  const before = inspectBytes(source);
  const plan = planFromBytes(source);
  expect(
    plan.actions.find(
      (action) => action.ruleId === "standalone-image-centering",
    ),
  ).toMatchObject({
    classification: "safe",
    resource: repairImageChapter,
  });
  const repaired = applyRepair(source, plan);
  expect(repaired.integrity).toMatchObject({ status: "pass" });
  expect(validateInternal(repaired.bytes)).toEqual({
    status: "pass",
    diagnostics: [],
  });
  const after = inspectBytes(repaired.bytes);
  const original = before.documents.get(repairImageChapter)!;
  const document = after.documents.get(repairImageChapter)!;
  for (const id of ["inline", "gallery", "table", "caption"])
    expect(
      serialize(elements(document).find((el) => attr(el, "id") === id)!),
    ).toBe(serialize(elements(original).find((el) => attr(el, "id") === id)!));
  const image = elements(document, "img").find(
    (el) => attr(el, "id") === "plain",
  )!;
  expect(attr(image, "width")).toBe("120");
  expect(attr(image, "height")).toBe("60");
  expect(after.entries.get(repairImagePath)!.bytes).toEqual(
    before.entries.get(repairImagePath)!.bytes,
  );
  expect(after.entries.get("OEBPS/toc.ncx")!.bytes).toEqual(
    before.entries.get("OEBPS/toc.ncx")!.bytes,
  );
  expect(source).toEqual(originalBytes);
  expect(planFromBytes(repaired.bytes).actions).toEqual([]);
  expect(
    applyRepair(repaired.bytes, planFromBytes(repaired.bytes)).bytes,
  ).toEqual(repaired.bytes);
});

it.each([
  '<p>Text <span><img src="swatch.svg" alt="Inline"/></span></p>',
  '<p><img src="swatch.svg" alt="Inline"/><br/>Text</p>',
  '<div><img src="swatch.svg" alt="One"/><img src="swatch.svg" alt="Two"/></div>',
  '<p><img src="swatch.svg" alt="Spaced"/>&#160;</p>',
  '<pre><span><img src="swatch.svg" alt="Code"/></span></pre>',
  '<p hidden="hidden"><img src="swatch.svg" alt="Hidden"/></p>',
  '<p><img src="swatch.svg" alt="Hidden" style="display: none"/></p>',
  '<p><a href="#details" style="position: absolute"><img src="swatch.svg" alt="Positioned"/></a></p>',
])("leaves non-standalone or hidden structures unchanged: %s", async (body) => {
  const source = await repairImageFixture({ body });
  expect(
    planFromBytes(source).actions.some((action) =>
      action.ruleId.startsWith("standalone-image"),
    ),
  ).toBe(false);
  const before = inspectBytes(source).documents.get(repairImageChapter)!;
  const after = inspectBytes(
    applyRepair(source, planFromBytes(source)).bytes,
  ).documents.get(repairImageChapter)!;
  expect(serialize(elements(after, "body")[0])).toBe(
    serialize(elements(before, "body")[0]),
  );
});

it("reports unparseable image styles for review without editing them", async () => {
  const source = await repairImageFixture({
    body: '<p><img src="swatch.svg" alt="Swatch" style="margin: 0; broken"/></p>',
  });
  const plan = planFromBytes(source);
  expect(
    plan.actions.find((action) => action.ruleId === "standalone-image-style")
      ?.classification,
  ).toBe("review-required");
  expect(
    plan.actions.some(
      (action) => action.ruleId === "standalone-image-centering",
    ),
  ).toBe(false);
});

it("rejects plans from the previous repair rule version", async () => {
  const source = await repairImageFixture();
  const oldPlan = { ...planFromBytes(source), ruleVersion: "1.0.0" };
  expect(() =>
    applyRepair(source, oldPlan as ReturnType<typeof planFromBytes>),
  ).toThrow("Repair plan differs");
});
