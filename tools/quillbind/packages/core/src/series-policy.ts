import { z } from "zod";
import { fail } from "./errors.js";
import { escapeXml } from "./xml.js";

const text = z.string().trim().min(1).max(10000);
export const seriesDecisionSchema = z
  .object({
    relation: z.enum([
      "story-continuity",
      "shared-protagonist-world",
      "marketing-bundle",
      "publisher-collection",
      "author-collection",
      "topic-collection",
      "nonfiction-multivolume",
      "standalone",
    ]),
    series: text.nullable(),
    position: z
      .string()
      .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
      .max(20)
      .nullable(),
    evidence: z.array(text).min(1),
    sources: z.array(text).min(1),
    positionEvidence: text.nullable(),
  })
  .strict();
export type SeriesDecision = z.infer<typeof seriesDecisionSchema>;

export function resolveSeriesDecision(value: unknown) {
  const parsed = seriesDecisionSchema.safeParse(value);
  if (!parsed.success)
    fail(
      "SERIES_DECISION",
      "Invalid series decision or position",
      parsed.error.issues,
    );
  const decision = parsed.data;
  const isStory = ["story-continuity", "shared-protagonist-world"].includes(
    decision.relation,
  );
  if (!isStory && (decision.series !== null || decision.position !== null))
    fail(
      "SERIES_NON_STORY",
      "A non-series grouping must clear both series and position",
    );
  if (isStory && decision.series === null)
    fail("SERIES_NAME", "A verified story series requires its actual name");
  if (decision.position !== null && !decision.positionEvidence)
    fail(
      "SERIES_POSITION",
      "A series position requires independent position evidence",
    );
  if (decision.series === null) return decision;
  // This strips only explicit trailing quantity marketing, never intrinsic trilogy names.
  const quantity =
    "(?:套[装裝]\\s*)?(?:全|共)\\s*[0-9０-９一二三四五六七八九十百零〇两兩]+\\s*[册冊卷巻]";
  const suffix = new RegExp(
    `(?:\\s*[（(【]\\s*${quantity}\\s*[）)】]|\\s*${quantity})$`,
  );
  let series = decision.series.normalize("NFC").trim();
  while (suffix.test(series)) series = series.replace(suffix, "").trim();
  if (!series || new RegExp(`^${quantity}$`).test(series))
    fail("SERIES_NAME", "Quantity marketing is not a series name");
  if (new RegExp(quantity).test(series))
    fail(
      "SERIES_NAME",
      "Unresolved quantity marketing: provide the evidenced actual series name",
    );
  escapeXml(series);
  return { ...decision, series };
}
