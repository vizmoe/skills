# Quillbind maintenance

For changes to invocation or domain rules, read the [behavior cases](../../../tests/skills/quillbind/skill-cases.md). Run the focused TypeScript Vitest suite from the repository root:

```sh
pnpm --dir tools/quillbind test:skill
```

Use the [catalog checks](../../../CONTRIBUTING.md#本地验证) for installed-resource validation and catalog distribution checks. Fixtures must stay separate from real libraries, and no test may open a Calibre database.

This skill has two independent delivery paths. The standalone TypeScript helpers — [tags.ts](../../../skills/quillbind/scripts/tags.ts), [naming.ts](../../../skills/quillbind/scripts/naming.ts), [delivery-audit.ts](../../../skills/quillbind/scripts/delivery-audit.ts), the reference-table parser [skill-rules.ts](../../../skills/quillbind/scripts/skill-rules.ts) and the shared [tag-vocabulary.ts](../../../skills/quillbind/scripts/tag-vocabulary.ts) loader — run natively on Node.js (`package.json` `"type": "module"`), share typechecking and linting with `tools/quillbind`, and are covered by the Vitest suite above. Publishing, repair and manga packaging go through [quillbind.ts](../../../skills/quillbind/scripts/quillbind.ts) into the separate workspace; follow its [maintenance conventions](../../../tools/quillbind/AGENTS.md) and [development guide](../../../tools/quillbind/docs/development.md), and preserve its existing release gates.

Executable workflow regressions for the authoring and publication path live in the runtime's [scenario evaluation](../../../tools/quillbind/docs/skill-evaluation.md) and run with `pnpm skill:eval`. They do not cover the file-only metadata workflows, whose expectations are recorded in the behavior cases instead.

Keep source selection and ISBN handling in [bibliography](../../../skills/quillbind/references/bibliography.md), file-write procedure in [embedded-metadata](../../../skills/quillbind/references/embedded-metadata.md), label authority in [tags](../../../skills/quillbind/references/tags.md), numbering policy in [naming](../../../skills/quillbind/references/naming.md), PDF inspection/tiling/sharding contracts in [pdf](../../../skills/quillbind/references/pdf.md), zero-API-key bilingual EPUB translation contracts in [bilingual-translation](../../../skills/quillbind/references/bilingual-translation.md), agent-agnostic subagent sharding in [parallel-workflow](../../../skills/quillbind/references/parallel-workflow.md), and completion claims in [quality](../../../skills/quillbind/references/quality.md). Update `metadata.version` when rules or helper behavior change. A new write path requires matching backup, validation and independent-readback verification.
