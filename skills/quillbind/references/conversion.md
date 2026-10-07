# Chinese conversion

Use `build <book-directory> --to simplified|traditional|china|taiwan|hongkong --json` for Markdown. Optional `conversion.target` in `book.yaml` persists the choice; `--to` wins. `preview` accepts the same options for a single-render author candidate. Existing EPUB 3 uses `epub convert <source.epub> --to <target> --output <new.epub> --json`. Run through the skill helper; check `doctor` before release work. EPUB 2 needs a publication repair upgrade first.

Follow the requested script and regional vocabulary; a repair request alone does not authorize text conversion. The first conversion needs `--online` to fetch responses from [繁化姬](https://zhconvert.org/). 本程式使用了繁化姬的 API 服務；繁化姬商用必須付費。This sends eligible text and display metadata over HTTPS. Set `ZHCONVERT_API_KEY` in the environment only if required; keep credentials out of book files and reports.

Later runs are offline by default. Book locks live at `metadata/conversion.<target>.lock.json`; existing EPUB locks at `<source.epub>.<target>.conversion.lock.json`. Preserve the lock with the sources: it contains converted text, dictionary revision and input/output hashes. Missing or stale locks fail with an instruction to refresh explicitly using `--online`. A failed refresh preserves the saved lock. Fixed source, lock and toolchain support byte equality across runs; refreshing a changed dictionary can change text.

The primary language must be `zh` or `zh-*`. Conversion updates text, navigation, display metadata and Chinese language tags. Identifiers, dates, links, structure, images, fonts, styles, code, MathML, SVG, `translate="no"` and explicitly non-Chinese text are preserved. Artwork text stays in its original script. Existing EPUB output requires a new path.

Read [quality.md](quality.md) before handoff. Release checks remain mandatory. Report the target, dictionary revision, lock source and current operation outcome from `conversion.json` and its summary; preview returns its conversion evidence directly in CLI JSON.
