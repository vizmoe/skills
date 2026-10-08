# Quillbind

Read [docs/development.md](docs/development.md) when changing the pipeline or running full verification. Read [docs/standards.md](docs/standards.md) before changing a standards or platform rule; preserve its official source URL and checked date.

The EPUB pipeline emits one canonical EPUB 3.3 with `literature` or `technical` styling. The separate manga scan pipeline emits lossless JXL CBZ; follow its source, codec and archive verification contracts in the manga reference. Build success requires every release gate to run. Missing tooling is an environment error. Reports distinguish EPUB conformance, browser QA, platform guideline lint, and distribution policy.

During repair, preserve source books and existing EPUB metadata. Keep generated book caches out of version control.
