# Skill usability and scenario evaluation

The executable scenarios live in [the Skill catalog](../tests/skill-evals/scenarios.json). They cover inspection alone, a prohibition on rebuilding, Astro source preparation, the Properties whitelist, null ISBN, author preview, missing validators, unsupported input and final delivery. Fixtures contain original synthetic Markdown and SVG; no user book participates.

```sh
pnpm skill:eval
```

The runner invokes the actual Node Skill helper, captures CLI arguments, exit codes and JSON results, compares protected file trees and SHA-256 values, and checks previews, inspection JSON and release summaries. The delivery scenario runs all publication gates. The author-preview scenario uses an isolated CLI checkout with no pinned validation tools and verifies `status: preview`, `publicationReady: false`, `releaseGates: not-run`, the candidate hash, and preservation of the entire prior release/report tree. The missing-validator scenario proves that inspection still works in that environment and a build reports an environment failure without replacing an earlier artifact. The runner imports no core internals or test helpers; assertions use the public CLI JSON contract and filesystem evidence.

Read `dist/skill-evals/report.md` or `report.json`; each scenario also has a JSON command trace. Failure returns a nonzero process exit. A successful delivery fixture and its working directory are retained under `dist/skill-evals/` so artifact and summary paths remain usable. Other temporary fixtures are removed after their protected inputs are compared.

## What these results establish

These are scripted Skill workflow regressions, separate from the core unit tests and Skill-format validation. They verify that the documented invocation path works and that observable outputs and side effects meet the scenario constraints. Passing them does not prove that an independent agent selects the right workflow or gives a good final answer. The generated report explicitly marks independent agent selection `not-run`.

For an independent evaluation, give another agent the actual Skill and a catalog prompt with only the required fixture paths and user-supplied facts. Keep implementation expectations and suspected failure modes out of its prompt. Record its actual calls and outputs, compare the protected inputs, and check its final artifact/report against the expected outcomes. Store that evidence separately and state which scenarios actually ran; do not count absent runs as passes. Run evaluators only in isolated directories within the authorized scope.

## Invocation and handoff criteria

| Stage               | Executable behavior to check                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose an operation | Inspection does not trigger a rebuild, repair or validator installation. Unsupported inputs stay explicit.                                                                             |
| Prepare sources     | A complete `book.yaml` plan plus local Markdown/assets is enough for one `init --from --config` call. Chapter order is explicit; copied source bytes and paths are recorded.           |
| Resolve facts       | Supplied book metadata remains authoritative. Missing facts and edition decisions are reported together. `isbn: null` needs no extra ISBN confirmation.                                |
| Author preview      | The candidate hash matches CLI JSON, publication readiness is false and release gates are `not-run`. Existing release artifacts and reports remain unchanged.                          |
| Diagnose failure    | CLI errors are nonzero and structured. Current-run summaries identify blockers and checks that did not run.                                                                            |
| Deliver             | The artifact SHA-256 matches the current run. A Markdown summary and JSON summary distinguish conformance, automated accessibility, browser QA, platform lint and distribution policy. |

The new preparation command does not discover a site's editorial order, infer book authorship from chapter Properties, scrape/download sources or convert PDF/HTML/MDX. An agent must first obtain those facts and create supported local Markdown working copies when needed. An empty `init` skeleton explicitly reports placeholder content instead of appearing ready to publish.
