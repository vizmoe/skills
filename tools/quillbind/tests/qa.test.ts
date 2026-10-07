import { expect, it } from "vitest";
import { paginationPreservesContent } from "../packages/core/src/qa.js";
import {
  planQa,
  sourceQaDocuments,
  inspectedQaDocuments,
} from "../packages/core/src/qa-plan.js";
import fs from "node:fs/promises";
import path from "node:path";
import { candidate, copyBook } from "./helpers.js";
import { openBook } from "../packages/core/src/config.js";
import { preflightBook } from "../packages/core/src/preflight.js";
import { inspectBytes } from "../packages/core/src/epub.js";

it.each(["horizontal-tb", "vertical-rl"] as const)(
  "matches source and packaged QA strata, including generated front matter (%s)",
  async (writingMode) => {
    const root = await copyBook("technical");
    try {
      const { config } = await openBook(root);
      config.writingMode = writingMode;
      config.direction = "rtl";
      config.cover = { path: "assets/images/flow.svg" };
      await fs.writeFile(path.join(root, "book.yaml"), JSON.stringify(config));
      const preflight = await preflightBook(root);
      const packaged = inspectBytes(await candidate(root));
      expect(inspectedQaDocuments(packaged)).toEqual(
        sourceQaDocuments(preflight.documents, true),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it("projects exhaustive large-book costs and retains a bounded set of passing screenshots", () => {
  const documents = Array.from({ length: 302 }, (_, index) => ({
    path: `chapter-${index}.xhtml`,
    features: [],
  }));
  const full = planQa(documents);
  expect(full).toMatchObject({
    strategy: "full",
    cases: 5134,
    matrixCases: 4832,
    paginationCases: 302,
    fullMatrixDocuments: 302,
  });
  expect(full.screenshots).toMatchObject({
    policy: "failures-and-samples",
    passing: 12,
  });
  expect(planQa(documents, { screenshots: "all" }).screenshots.passing).toBe(
    4832,
  );
  const sampled = planQa(documents, { coverage: "stratified" });
  expect(sampled).toMatchObject({ cases: 1654, fullMatrixDocuments: 12 });
  expect(
    sampled.assignments.every((document) => document.modes.includes("default")),
  ).toBe(true);
  expect(planQa(documents, { coverage: "stratified" })).toEqual(sampled);
});

it("adds rare layout strata to the reading-order sample and records their selection", () => {
  const documents = Array.from({ length: 300 }, (_, index) => ({
    path: `chapter-${index}.xhtml`,
    features: index === 23 ? ["table", "math", "rtl"] : [],
  }));
  const plan = planQa(documents, { coverage: "stratified" });
  const rare = plan.assignments[23];
  expect(rare.modes).toEqual(["default", "large", "dark", "grayscale"]);
  expect(rare.reasons).toEqual(
    expect.arrayContaining([
      "first/middle/last: table",
      "first/middle/last: math",
      "first/middle/last: rtl",
    ]),
  );
  expect(plan.fullMatrixDocuments).toBe(13);
  expect(
    plan.assignments.filter((document) => document.screenshotSample),
  ).toHaveLength(3);
  expect(() => planQa(documents, { coverage: "unknown" as never })).toThrow(
    expect.objectContaining({ code: "QA_OPTIONS" }),
  );
});

it("accepts a visible image-only cover without requiring duplicate title text", () => {
  expect(
    paginationPreservesContent("", "", {
      hiddenText: 0,
      fragments: 0,
      images: 1,
      hiddenImages: 0,
    }),
  ).toBe(true);
});

it("rejects an empty or invisible cover", () => {
  for (const [images, hiddenImages] of [
    [0, 0],
    [1, 1],
  ])
    expect(
      paginationPreservesContent("", "", {
        hiddenText: 0,
        fragments: 0,
        images,
        hiddenImages,
      }),
    ).toBe(false);
});

it("still requires chapter text and images to survive pagination", () => {
  const visible = { hiddenText: 0, fragments: 1, images: 1, hiddenImages: 0 };
  expect(paginationPreservesContent("Chapter", "Chapter", visible)).toBe(true);
  expect(paginationPreservesContent("Chapter", "", visible)).toBe(false);
  for (const change of [
    { hiddenText: 1 },
    { fragments: 0 },
    { hiddenImages: 1 },
  ])
    expect(
      paginationPreservesContent("Chapter", "Chapter", {
        ...visible,
        ...change,
      }),
    ).toBe(false);
});
