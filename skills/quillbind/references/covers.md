# Official covers in existing ebook files

Run cover retrieval or adoption only when cover work is explicitly in scope (never during tags-only or bibliography-only tasks). Match exact work, creators, language, edition, adaptation and volume using [bibliography](bibliography.md).

## Fetch and inspect candidates

```json
{
  "lock": "edition.lock.json",
  "matchEvidence": ["Matched publisher edition cover for Volume 1."]
}
```

```sh
node <skill-directory>/scripts/quillbind.mjs metadata cover-fetch cover-selection.json --output official.jpg --lock cover.lock.json --online --json
node <skill-directory>/scripts/quillbind.mjs metadata cover-fetch cover-selection.json --output official.jpg --lock cover.lock.json --json
```

| Step | Requirement |
| --- | --- |
| Upstream retrieval (`metadata cover-fetch`) | Accepts `"lock"` (`bookwalker.lock.json`, `edition.lock.json` or `catalog.lock.json` carrying `coverUrl`) or direct `"url"` (`https://...`); enforces public-IP SSRF guards, rejects HTML/WebP/placeholder responses, verifies JPEG/PNG magic bytes and pixel dimensions, and replays offline without `--online`. |
| Visual & geometry check | View candidate and current cover in an image viewer: verify legible text, all four edges, integral white design margins and resolution; record URL/resource, SHA-256, dimensions and selection/rejection reason. |
| Byte & aspect preservation | Keep native aspect ratio and original JPEG/PNG bytes; never crop, stretch, pad/border to 2:3, upscale, redraw or generatively reconstruct. Retain current cover and report attempted sources when no valid candidate exists. |

## Audit and apply

```sh
node <skill-directory>/scripts/quillbind.mjs metadata cover-audit source.epub --image official.png --output cover-plan.json --json
node <skill-directory>/scripts/quillbind.mjs metadata cover-adopt source.epub --image official.png --plan cover-plan.json --output covered.epub --json
```

| Format | Plan fields & archive behavior |
| --- | --- |
| Shared plan rules | Keep `inventory`, `image`, hashes, operation and format unchanged; populate `evidence.source`, `edition`, `visual` and `reason` (re-audit if source or image changes). Rejects encrypted/signed/multi-rendition/interactive EPUBs, mixed-content cover pages, ambiguous page maps and PDFs. |
| `.epub` (EPUB 2 / 3) | Select `target.image` manifest path and cover-only `target.document` XHTML (or `null` to add a new pre-spine cover resource without replacing body chapters or shared content images); synchronizes cover-image, meta, guide and landmark declarations. |
| `.cbz` (ComicInfo 2.0) | Set `target.image` explicitly (`target.document: null`), list every image entry once in `pageOrder`, and record reader-to-`Page Image` mapping in `evidence.pageOrder` (never guess from first ZIP entry). Preserves JPEG/PNG candidate bytes or losslessly encodes existing JXL cover pages while keeping all other page bytes/order and unrelated ComicInfo fields intact. |

## Verify delivery

`cover-adopt` requires independent ZIP/XML/resource readback, EPUBCheck or `xmllint --nonet` ComicInfo 2.0 XSD pass, and portrait/tablet/landscape browser renders (decoding final JXL pages where applicable) reviewed for uncropped, unstretched legibility, writing `<output>.reports/`. Keep originals and backups, and verify Calibre sidecars remain untouched via `scripts/delivery-audit.mjs` ([quality](quality.md)).
