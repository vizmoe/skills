import { expect, it } from "vitest";
import { resolveSeriesDecision } from "../packages/core/src/series-policy.js";

const story = {
  relation: "story-continuity",
  series: "銀河三部曲",
  position: "1.5",
  evidence: [
    "The publisher identifies the same continuing narrative and the interlude's reading position.",
  ],
  sources: ["https://publisher.example/books/interlude"],
  positionEvidence:
    "Publisher reading order lists this interlude between volumes 1 and 2.",
};

it.each([
  ["銀河三部曲（全3册）", "銀河三部曲"],
  ["銀河三部曲（套装共三册）", "銀河三部曲"],
  ["銀河三部曲 全 ３ 冊", "銀河三部曲"],
  ["銀河三部曲全3册", "銀河三部曲"],
  ["銀河三部曲【全３巻】", "銀河三部曲"],
  ["銀河三部曲", "銀河三部曲"],
  ["The Three-Body Trilogy", "The Three-Body Trilogy"],
])(
  "removes quantity marketing from %s without removing intrinsic names",
  (series, expected) => {
    const result = resolveSeriesDecision({ ...story, series });
    expect(result.series).toBe(expected);
    expect(result.position).toBe("1.5");
  },
);

it("requires real story membership independently from a marketing bundle or shared author", () => {
  expect(
    resolveSeriesDecision({
      ...story,
      series: "偵探甲案件集",
      relation: "shared-protagonist-world",
      evidence: [
        "Inspected content confirms the same detective and story world, despite independent cases.",
      ],
    }).series,
  ).toBe("偵探甲案件集");
  expect(
    resolveSeriesDecision({
      ...story,
      series: "真正的子系列",
      evidence: [
        "The publisher's omnibus contains this verified narrative subseries; the omnibus marketing name is not the series.",
      ],
    }).series,
  ).toBe("真正的子系列");
  for (const relation of [
    "marketing-bundle",
    "publisher-collection",
    "author-collection",
    "topic-collection",
    "nonfiction-multivolume",
    "standalone",
  ])
    expect(() => resolveSeriesDecision({ ...story, relation })).toThrow(
      /non-series/i,
    );
});

it("clears non-story groupings only with an explicit decision and evidence", () => {
  const result = resolveSeriesDecision({
    ...story,
    relation: "nonfiction-multivolume",
    series: null,
    position: null,
    positionEvidence: null,
  });
  expect(result.series).toBeNull();
  expect(result.position).toBeNull();
  expect(() => resolveSeriesDecision({ ...story, series: null })).toThrow();
  expect(() => resolveSeriesDecision({ ...story, evidence: [] })).toThrow();
  expect(() => resolveSeriesDecision({ ...story, sources: [] })).toThrow();
});

it("never guesses reading positions and refuses unsupported or unexplained numbering", () => {
  expect(
    resolveSeriesDecision({ ...story, position: null, positionEvidence: null })
      .position,
  ).toBeNull();
  expect(() =>
    resolveSeriesDecision({ ...story, positionEvidence: null }),
  ).toThrow(/position/i);
  for (const position of [
    "II",
    "Ⅵ",
    "二",
    "２",
    "第3卷",
    "06.5-01",
    "-1",
    "1.2.3",
    "NaN",
    "",
  ])
    expect(() => resolveSeriesDecision({ ...story, position })).toThrow(
      /position|decision/i,
    );
  expect(() =>
    resolveSeriesDecision({ ...story, series: "（全3册）" }),
  ).toThrow(/name/i);
  expect(() =>
    resolveSeriesDecision({ ...story, series: "銀河（全3册，珍藏版）" }),
  ).toThrow(/name|marketing/i);
});
