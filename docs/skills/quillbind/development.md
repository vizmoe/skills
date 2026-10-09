# Quillbind maintenance

For changes to invocation or domain rules, read the [behavior cases](../../../tests/skills/quillbind/skill-cases.md). Run the focused suite from the repository root:

```sh
python3 -B -m unittest discover -s tests/skills/quillbind -v
```

Use the [catalog checks](../../../CONTRIBUTING.md#本地验证) for installed-resource validation and all Python regression suites. Fixtures must stay separate from real libraries, and no test may open a Calibre database.

This skill has two independent delivery paths. The standalone helpers — [tags.mjs](../../../skills/quillbind/scripts/tags.mjs), [naming.mjs](../../../skills/quillbind/scripts/naming.mjs) and the shared [tag-vocabulary.mjs](../../../skills/quillbind/scripts/tag-vocabulary.mjs) loader — need only Node.js and are covered by the Python suite above. Publishing, repair and manga packaging go through [quillbind.mjs](../../../skills/quillbind/scripts/quillbind.mjs) into the separate workspace; follow its [maintenance conventions](../../../tools/quillbind/AGENTS.md) and [development guide](../../../tools/quillbind/docs/development.md), and preserve its existing release gates.

Executable workflow regressions for the authoring and publication path live in the runtime's [scenario evaluation](../../../tools/quillbind/docs/skill-evaluation.md) and run with `pnpm skill:eval`. They do not cover the file-only metadata workflows, whose expectations are recorded in the behavior cases instead.

Keep source selection and ISBN handling in [bibliography](../../../skills/quillbind/references/bibliography.md), file-write procedure in [embedded-metadata](../../../skills/quillbind/references/embedded-metadata.md), label authority in [tags](../../../skills/quillbind/references/tags.md), numbering policy in [naming](../../../skills/quillbind/references/naming.md), and completion claims in [quality](../../../skills/quillbind/references/quality.md). Update `metadata.version` when rules or helper behavior change. A new write path requires matching backup, validation and independent-readback verification.
