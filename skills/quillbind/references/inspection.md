# Inspect an existing EPUB

`inspect` reads the EPUB without writing reports, rewriting metadata, extracting files, running validators or fetching links. It works for the supported readable EPUB 2 and 3 package structures even when the publication toolchain is unavailable.

```sh
node <skill-directory>/scripts/quillbind.mjs inspect <file.epub> --summary --json
node <skill-directory>/scripts/quillbind.mjs inspect <file.epub> --json
```

The summary gives title, language, package version and path, SHA-256, resource count, linear/non-linear reading order counts, NAV/NCX TOC counts, cover associations and broken-reference counts. Human mode prints a concise summary; JSON is preferable for agent decisions.

Full inspection adds:

- `metadata.records`: original OPF metadata names, namespaces, values and attributes, including contributor roles and refinements. This is existing publication metadata; the Markdown chapter Properties whitelist does not delete it.
- `navigation`: separate NAV and NCX trees, with labels, original hrefs, source document paths, resolved paths and Unicode fragments. Structural labels without links remain in the tree.
- `readingOrder`: each spine `idref`, resolved path, `linear` value (default `yes`) and properties. Reading order and the displayed TOC can differ.
- `covers`: explicit `cover-image`, legacy cover metadata, guide and navigation associations. Multiple associations can identify the same cover; their count is not an image count.
- `references`, `resources[].referencedBy`: links from XML URL attributes and CSS URLs/imports, with local resolution or external/unsafe/missing status. No external link is contacted.
- `diagnostics`, `unsupported`: parsing caveats and limitations of the maintenance engine.

Inspection success means the inventory was produced. `validation: not-run` is explicit; an inventory is not an EPUBCheck or platform result. For suspected formatting bugs, locate the referenced chapter and inspect its packaged XHTML through the CLI/core reader or ZIP tools as data. Keep the original unchanged. Only use `validate`/`qa` when their report-writing operation is in scope, and only repair when the user requested it.

Unreadable ZIP/XML inputs fail with a structured error. Extra XML/CSS resources that cannot be interpreted are reported as inspection warnings. The reference graph covers `href`, `src`, `poster`, `data`, CSS `url()` and imports; it is not execution of scripts, website routing, or a network-link checker.

The standard NCX 2005-1 PUBLIC doctype is recognized locally by the shared inspection and repair parser. Inspection removes it only in memory. No DTD is fetched; custom declarations and internal entity subsets remain rejected.

Recognized XHTML 1.x chapters support all 253 standard named character entities through a bundled local table. `LEGACY_ENTITY_UNSUPPORTED` identifies a name outside that table and its source file; report that compatibility boundary without relabeling it as a general archive failure. Inspection and audit retain original bytes.
