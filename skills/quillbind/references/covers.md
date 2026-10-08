# Official covers in existing ebook files

Use this operation when cover supplementation or correction is in scope. Tags-only and metadata-only tasks never change image pages. Follow [bibliography](bibliography.md) for sources: BOOK☆WALKER for light novels and manga, the matched publisher/imprint or original book resources for other books. Match work, contributors, language, edition, adaptation and volume. A similar title, accessible image URL or ISBN checksum alone does not establish that match; no routine second-source verification is required.

## Inspect candidates

Record each candidate's source URL/book resource, SHA-256, original pixel dimensions, edition match and selection/rejection reason in the task report. Inspect the actual image with an image viewer: text, all four edges, resolution and any designed white background. Inspect the existing cover page too: a poor container can crop a correct image. If no supported candidate is available, keep the current cover and report attempted sources; one failed URL does not prove that none exists.

Preserve the complete official/original image, its native aspect ratio and original JPEG/PNG bytes. A 2:3 preference never authorizes cropping, stretching, adding borders/padding, upscaling, redrawing or generative reconstruction. White areas integral to the design stay intact. Empty reader viewport space is different from adding white pixels to the image.

## Audit and apply

```sh
node <skill-directory>/scripts/quillbind.mjs metadata cover-audit source.epub --image official.png --output cover-plan.json --json
node <skill-directory>/scripts/quillbind.mjs metadata cover-adopt source.epub --image official.png --plan cover-plan.json --output covered.epub --json
```

The commands also accept CBZ. Audit is read-only; omit `--image` to inspect current associations, then rerun with the candidate before adoption. Preserve the plan's source/metadata hashes, `inventory`, `image`, operation and format. Fill `evidence.source`, `edition`, `visual` and `reason` with actual findings. This review is evidence gathering by the agent, not an extra user confirmation. If source or candidate changes, audit again rather than editing hashes.

- **EPUB:** inspect `target.image` and `target.document`; unique declarations may be preselected but are not proof of a correct cover. Choose an image manifest path and a cover-only XHTML page, or set either to `null` to add a resource. Incompatible image media types cause a new resource to be added. Correct missing/conflicting/wrong associations explicitly; never replace a body chapter as a cover. Preserve images used outside the cover. The writer displays the entire raster and synchronizes image, legacy, guide and landmark declarations. New cover pages precede the existing spine without reordering it. Complex cover content or ambiguous navigation requires explicit repair instead of flattening.
- **CBZ:** explicitly set `target.image` after inspecting the displayed book; leave `target.document` null. Supply every image member exactly once in `pageOrder`, and explain the mapping between reader order and zero-based ComicInfo `Page Image` values in `evidence.pageOrder`. Never guess the cover from the first ZIP entry. Selected JPEG/PNG pages require matching source format and retain candidate bytes; an existing JXL page uses lossless encoding with JPEG reconstruction or decoded-sample/metadata verification. Only the selected page changes. Other page bytes/order and unrelated ComicInfo fields/attributes are preserved. Cover role, dimensions and size are maintained; unsupported ComicInfo ISBN remains skipped.

Supported inputs are bounded, passive EPUB 2/3 or CBZ with root ComicInfo 2.0. Protected/multiple-rendition/interactive EPUBs, mixed cover-page content, ambiguous page maps, unsupported source images and collisions stop with evidence. The command does not replace PDF pages or fetch arbitrary image URLs.

## Verify delivery

Adoption writes a new output after independent ZIP/XML/resource readback, actual EPUBCheck or ComicInfo XSD validation, and browser checks at portrait, tablet and landscape sizes. Review the generated screenshots for the whole design, legible original text, and no crop/stretch. Reports bind source, candidate and output hashes, changed/preserved members, conversion evidence and render results. JXL previews decode the actual final page. Native EPUB/CBZ reader behavior and full publication QA are not claimed by this maintenance result.

Keep originals and reports. For an authorized replacement, follow [embedded metadata installation](embedded-metadata.md) and read back the installed file. Do not write Calibre's database, sidecar OPF or `cover.jpg`, import the output, or delete the original.
