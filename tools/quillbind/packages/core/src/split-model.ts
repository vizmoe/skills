import { z } from "zod";
import { validIsbn, validLanguage } from "./config.js";
import { seriesDecisionSchema } from "./series-policy.js";
const text = z.string().trim().min(1);
export const splitMetadataSchema = z
  .object({
    identifier: z
      .string()
      .regex(
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    title: text,
    language: text.refine(validLanguage),
    creators: z.array(
      z
        .object({ name: text, role: z.enum(["aut", "trl", "ill", "edt"]) })
        .strict(),
    ),
    description: text.nullable(),
    publisher: text.nullable(),
    date: z
      .string()
      .regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/)
      .refine((value) => {
        const full =
          value.length === 4
            ? `${value}-01-01`
            : value.length === 7
              ? `${value}-01`
              : value;
        return (
          !Number.isNaN(Date.parse(full)) &&
          new Date(full).toISOString().slice(0, 10) === full
        );
      })
      .nullable(),
    isbn: z
      .string()
      .regex(/^\d{13}$/)
      .refine(validIsbn)
      .nullable(),
    isbnEvidence: text,
    tags: z.array(text),
    series: seriesDecisionSchema.nullable(),
    cover: z
      .object({ image: text, document: text, evidence: text })
      .strict()
      .nullable(),
    evidence: z.array(text).min(1),
  })
  .strict();
export const splitPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("split"),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    vocabularyVersion: text,
    modified: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .refine(
        (value) =>
          !Number.isNaN(Date.parse(value)) &&
          new Date(value).toISOString().replace(".000Z", "Z") === value,
      ),
    inventory: z.unknown(),
    volumes: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
            from: text,
            through: text,
            boundaryEvidence: text,
            navigation: z
              .array(z.object({ unit: text, label: text }).strict())
              .min(1),
            metadata: splitMetadataSchema,
          })
          .strict(),
      )
      .min(1),
    omit: z.array(z.object({ unit: text, reason: text }).strict()),
    omitNotes: z.array(z.object({ key: text, reason: text }).strict()),
    crossLinks: z.array(
      z
        .object({
          source: text,
          id: text,
          href: z.string(),
          action: z.literal("unlink"),
          evidence: text,
        })
        .strict(),
    ),
  })
  .strict();
export type SplitMetadata = z.infer<typeof splitMetadataSchema>;
export type SplitVolume = z.infer<typeof splitPlanSchema>["volumes"][number];
