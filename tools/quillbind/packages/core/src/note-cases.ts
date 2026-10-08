import { z } from "zod";
import { fail } from "./errors.js";
import type { inspectNotes } from "./epub-notes.js";

const selector = z.string().trim().min(1).max(4096);
export const noteCaseSchema = z.strictObject({
  id: z.string().trim().min(1),
  document: z.string().min(1),
  trigger: selector,
  popup: selector,
  expectedText: z.string().trim().min(1),
  activations: z
    .array(z.enum(["click", "keyboard", "hover", "touch"]))
    .min(1)
    .max(4)
    .default(["click", "keyboard"]),
  dismiss: z.union([
    z.strictObject({ selector }),
    z.strictObject({ key: z.literal("Escape") }),
    z.strictObject({ gesture: z.literal("release") }),
  ]),
  returnFocus: selector.optional(),
});
export const noteCasesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cases: z.array(noteCaseSchema).min(1),
});
export type NoteCase = z.infer<typeof noteCaseSchema>;
export function noteCases(
  notes: ReturnType<typeof inspectNotes>,
  hash: string,
  supplied?: unknown,
) {
  if (supplied !== undefined) {
    const plan = noteCasesSchema.parse(supplied);
    if (plan.inputSha256 !== hash)
      fail(
        "NOTE_CASES_STALE",
        "Note cases belong to a different EPUB; review selectors against this input",
      );
    if (new Set(plan.cases.map((c) => c.id)).size !== plan.cases.length)
      fail("NOTE_CASES_DUPLICATE", "Note case IDs must be unique");
    for (const test of plan.cases) {
      if (new Set(test.activations).size !== test.activations.length)
        fail("NOTE_CASE_ACTIVATION", "Note activations must be unique");
      if (
        (test.activations.some((a) => a === "touch") &&
          !("gesture" in test.dismiss)) ||
        ("gesture" in test.dismiss &&
          test.activations.some((a) => a !== "hover" && a !== "touch"))
      )
        fail(
          "NOTE_CASE_ACTIVATION",
          "Release dismissal is for hover/touch; touch checks require release dismissal",
        );
    }
    return {
      cases: plan.cases,
      coverage: "explicit-cases" as const,
      unassigned: [] as string[],
    };
  }
  const cases: NoteCase[] = [],
    unassigned: string[] = [];
  for (const [index, ref] of notes.references.entries()) {
    if (
      ref.resolution !== "resolved" ||
      ref.target.path !== ref.source ||
      !ref.backlinks.length ||
      !ref.id ||
      !ref.text
    ) {
      unassigned.push(`${ref.source}#${ref.id || ref.href}`);
      continue;
    }
    cases.push({
      id: `note-${index + 1}`,
      document: ref.source,
      trigger: ref.trigger,
      popup: ref.popup,
      expectedText: ref.text,
      activations: ["click", "keyboard"],
      dismiss: { selector: ref.backlinks[0].selector },
      returnFocus: ref.trigger,
    });
  }
  return { cases, coverage: "semantic-note-candidates" as const, unassigned };
}
