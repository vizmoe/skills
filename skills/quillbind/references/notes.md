# Existing EPUB popup notes

Preserve the source EPUB. Begin with static inspection, which does not execute book scripts:

```sh
quillbind epub check-notes original.epub --json
```

The report inventories manifest `scripted` declarations, actual XHTML scripts and event handlers, local script hashes, note references, targets and backlinks. `scripted-note-candidate` describes markup eligible for preservation; it does not establish the script's purpose, safety or working interactions. Undeclared scripts are still protected. Missing targets, duplicate IDs and unavailable script resources remain findings.

When the user requests interaction verification, run the explicit script check in the configured Chromium environment:

```sh
quillbind epub check-notes original.epub --execute-scripts --reports /absolute/path/to/reports --json
```

This creates a separate report directory per run. Each selected activation gets a fresh browser context. Only packaged local resources are served; the opaque-origin CSP sandbox and request interception block network connections, workers, frames, unexpected navigation, popups, downloads and dialogs. Regular layout/publication QA still disables book scripts. For untrusted books, the pinned QA container with `--network none` also isolates the process network. Browser restrictions do not prove arbitrary JavaScript safe.

Automatic cases use semantic same-document note targets with return links, and test click and keyboard activation. The expected popup must start hidden, become visible with the expected text inside the viewport, close, and return focus to the invoking reference. Opacity-based hiding is supported. Cases record passed steps, failures, screenshots and browser/environment evidence. A missing selector, script error, blocked resource or side effect fails the check; a working popup with a missing font is still a run with findings.

## Describe nonstandard interactions

Inspect the XHTML, CSS and script as data before selecting a different interaction. Some books use hover on desktop and press/release on touch, dynamically remove `href`, or clone note content into another element. Do not assume these behave like clickable backlinks. Save and edit the static report's `casePlan`, or create a source-bound case file:

```json
{
  "schemaVersion": 1,
  "inputSha256": "<SHA-256 from inspection>",
  "cases": [
    {
      "id": "reviewed-note-1",
      "document": "OEBPS/Text/chapter.xhtml",
      "trigger": "a[id=note_ref001]",
      "popup": "aside[id=note001]",
      "expectedText": "Expected note text from this source",
      "activations": ["hover", "touch"],
      "dismiss": { "gesture": "release" }
    }
  ]
}
```

```sh
quillbind epub check-notes original.epub --execute-scripts --cases cases.json --reports /absolute/path/to/reports --json
```

Use unique CSS selectors. `click` and `keyboard` cases dismiss via `{"selector":"#close"}` or `{"key":"Escape"}`; add `returnFocus` to check the exact return target. `hover` and `touch` can use `{"gesture":"release"}` for pointer leave or touch end. Touch uses Chromium mobile emulation, not a physical reading device. A hover/touch-only result says nothing about keyboard accessibility. Regenerate the source hash and review cases after any EPUB change; stale plans are rejected.

Explicit selectors can disambiguate a duplicated ID for an interaction test, while the original duplicate-ID findings remain errors. The top-level status can therefore be `fail` with `interactions.status: pass`. This does not repair the ambiguity. Explicit cases have completeness `not-assessed`; do not describe a few selected examples as all-book coverage. Missing automatic cases require an explicit plan rather than a partial automatic pass.

## Repair and handoff

For eligible local scripted-note candidates, a [reading repair](repair.md) preserves every content resource byte-for-byte and defers DOM/CSS/layout changes. Its integrity report records protected hashes and `interactions: not-run`. Ambiguous or complex interactions remain unsupported for repair. Publication repair, conversion and enrichment keep their existing release restrictions.

Report static findings and interaction outcomes separately. Link the JSON report and relevant screenshots, identify the source hash, selected cases, activation modes and untested scope, and confirm the original is unchanged. An `inspected` result means scripts did not run. Chromium success does not prove Apple Books/Kindle native popup support or EPUB publication conformance; all [release gates](quality.md) remain required.
