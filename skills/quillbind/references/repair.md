# Audit and repair

## Select the intended outcome

For ordinary repairs intended for personal reading, preserve the source EPUB version, metadata and reading order. Use a reading plan and `repair-copy`. The copy applies only structurally safe changes, verifies protected content and byte idempotence, runs EPUBCheck and platform lints, and performs a bounded browser smoke test. Existing conformance or semantic findings remain explicit in the report. This operation produces a reading copy, not a publication release; full publication QA and Ace are recorded as not run.

```sh
quillbind epub repair-plan original.epub --purpose reading --output plan.json --json
quillbind epub repair-copy original.epub --plan plan.json --output repaired.epub --json
```

For a directory request, recursively process all original EPUBs with the typed CLI command:

```sh
quillbind epub repair-directory fix --output fix/repaired --jobs 2 --json
```

The command snapshots inputs before processing, excludes its output tree, preserves subdirectories, isolates reports per relative source path and continues after individual failures. `README.md` links every result; `repair-summary.json` records each input/output hash, status, checks and remaining findings. Reruns reuse only copies whose source hash, output hash and saved success summary match; unrelated existing files remain protected. Read the aggregate and individual summaries before reporting completion.

For an EPUB 3.3 publication upgrade, use the default publication plan and the complete release workflow:

```sh
quillbind epub inspect original.epub --json
quillbind epub audit original.epub --json
quillbind epub repair-plan original.epub --output plan.json --json
quillbind epub repair original.epub --plan plan.json --output repaired.epub --json
```

Use a new output path. Plans bind the source SHA-256, purpose and rule version; regenerate after any of these change. The engine validates the plan again and applies only `safe` actions. It preserves the original bytes for untouched resources and checks protected text, order, headings, code, tables, mathematics, images, page markers, identifiers, rights and unknown metadata.

Recognized XHTML 1.0/1.1 public doctypes and a small explicit set of named entities are handled locally. Other DTDs/entities are rejected; DTDs are never fetched.

Safe operations include EPUB 2 package migration, NCX-derived navigation, spine-derived navigation when reliable headings exist, media type corrections, declaration of recognizable unmanifested resources, unambiguous filename-case link fixes, unreferenced duplicate ID remapping, language attributes, MathML properties, reader-friendly body metrics and conservative accessibility discovery metadata.

Reading copies retain existing EPUB 2 packages and NCX navigation. They add a reading stylesheet that bounds block widths, wraps oversized headings and scales standalone images within the reading area without resampling. Inline icons and image bytes retain their source data. Both purposes support missing document-language inheritance from a valid publication language, repair of a dangling unique-identifier pointer when there is one existing identified value, filling an empty NCX identifier from that value, and removal of unavailable font sources. Usable `local()` and URL alternatives remain intact. A full-width CSS declaration semicolon can be normalized outside strings/comments only when the corrected stylesheet parses successfully. Other CSS syntax still needs review.

Standard NCX public doctypes are recognized locally in both inspection and repair. HTTP(S), mailto and tel hyperlinks remain unchanged and are not fetched. Anchors without `href` are destinations rather than unnamed links. Remote embedded resources and active links remain subject to safety checks.

Independent-image alignment is also repaired automatically. A single `img` in its own `p`, `div` or `figure` is centered along the writing direction, including `a`/`span` wrappers and a separate figure caption. Original structure, links, captions, dimensions and image bytes are preserved. Mixed text, sibling images, table/code/navigation/heading/caption images, embedded SVG markup and explicitly hidden or inline positioned image branches retain their layout. Check `standalone-image-centering` in the plan and changes report; malformed inline styles require review. The CLI reports the current rule version; regenerate a plan when it changes.

`review-required` means the engine lacks evidence to change semantics. It blocks publication release; a reading copy retains the affected content and reports it. Obtain a content or edition decision when resolving that issue is necessary for the user's requested outcome. Preserve the plan's classifications. DRM, unsupported encryption, fixed layout, multiple renditions and complex or unresolved interactive books remain protected and are reported as unsupported. Standard font obfuscation is distinguished from DRM.

Locally resolved scripted-note candidates have a preservation-only reading path. The plan defers content/layout changes and freezes all resources except the OPF and ZIP mimetype entry byte-for-byte, including XHTML, CSS, JavaScript, images, fonts and navigation. Only the packaging, package-language and identifier-pointer rules remain eligible; protected metadata and script declarations stay intact. Integrity evidence records resource hashes and unexecuted interactions. Duplicate note IDs, unresolved targets, remote/missing scripts and complex active content keep the unsupported guard. See [note checks](notes.md) for separate, explicit popup verification. Keeping script bytes or passing regular layout QA does not establish working popups.

Repair the original package structure directly to retain its semantics. Publication upgrades run complete release gates and byte idempotence before release; read `reports/repair/content-integrity.json`. Reading copies use `content-integrity.json` and `remaining-findings.json` in their own reports directory. Return the actual outcome and checks from the selected workflow.
