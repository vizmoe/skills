# EPUB repair implementation

The [audit and repair reference](../../../skills/quillbind/references/repair.md) is authoritative for selecting reading copies or publication upgrades, supported rules, preservation guarantees and report paths. [Evidence and delivery](../../../skills/quillbind/references/quality.md) defines completion claims.

The engine reads the ZIP directly, verifies its integrity, then locates the package, spine, documents, styles and encryption declarations. It regenerates the complete plan before applying any action; a changed source, omitted rule or changed classification is rejected. The active plan version is `REPAIR_RULE_VERSION` in [repair-plan.ts](../packages/core/src/repair-plan.ts), and is returned by `epub repair-plan --json`. Documentation does not pin a second copy of that version.

Before/after fingerprints compare normalized body text, spine order, headings, exact code, tables, serialized MathML, captions, links, footnotes, image references and alt text, page markers, image/font bytes and protected metadata. Explicitly generated navigation is an allowed new resource. A second application verifies byte idempotence.

[repair-directory.ts](../packages/core/src/repair-directory.ts) owns recursive input snapshots, bounded concurrency, isolated reports, aggregate progress and hash-verified resumption. It invokes the same reading-copy operation as the single-file CLI. Contract tests cover failure isolation, source changes, output preservation and cancellation.
