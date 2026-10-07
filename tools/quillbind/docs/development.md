# Development and CLI

Use the Node version in [.node-version](../.node-version) and pnpm version in [package.json](../package.json). [tools.lock.json](../standards/tools.lock.json) pins Java, EPUBCheck, Chromium and the Python used solely for development skill validation, including SHA-256 for external archives. `pnpm tools:install` installs the release tools on Linux and macOS x64/arm64. The reference browser environment is Linux arm64 in `Dockerfile.qa`; other environments support functional QA.

The `linux-arm64-noble-v2` reference environment adds Noto Sans CJK SC 2.004 and Noto Serif CJK SC 2.003, in regular and bold weights. `standards/qa-fonts.lock.json` pins the official font files and OFL licenses by SHA-256. These fonts belong to the container, not the EPUB. The base image's WenQuanYi Zen Hei returned zero vertical advances for Chinese text; the typography regression checks actual glyph advances as well as computed styles. Reference reviews record the font lock hash.

```sh
pnpm install --frozen-lockfile
pnpm tools:install
pnpm quillbind doctor --json
pnpm typecheck
pnpm lint
pnpm test:coverage
pnpm build
pnpm verify
pnpm qa:fixtures
```

The repository launcher is `./bin/quillbind.mjs`; it locates the CLI from any working directory and prefers its project-local Node binary when installed, using the version in `standards/tools.lock.json` and the current OS/architecture. The launcher and skill helper default to a 1,800-second execution timeout; set `QUILLBIND_TIMEOUT_SECONDS` to a positive integer for larger books. This changes the outer command timeout, not individual publication-gate limits. The built entry is `dist/packages/cli/src/index.js`, with core declarations in `dist/packages/core/src/`. Core declares its Playwright, axe and Ace runtime dependencies and resolves Ace from its own package. The CLI imports core through package exports; the compiled CLI resolves the compiled core, whose runtime dependencies link to the same local frozen installation. Keep the workspace, repository assets and dependencies together. Packages are private workspace packages; no npm publication or global installation is assumed.

## Commands

| Command                                                         | Result                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `init DIRECTORY [--theme literature\|technical]`                | New book skeleton with required metadata left to the author               |
| `init NEW_DIRECTORY --from SOURCE_DIRECTORY --config PLAN.yaml` | Prepare a project from declared chapters and referenced local assets      |
| `doctor`                                                        | Required runtime and validator availability                               |
| `metadata resolve DIRECTORY [--online]`                         | Metadata status, candidates and provenance locks                          |
| `preflight DIRECTORY`                                           | Standalone chapter validation                                             |
| `build DIRECTORY`                                               | All release gates and one canonical EPUB                                  |
| `validate FILE.epub`                                            | Internal validation and EPUBCheck                                         |
| `qa FILE.epub`                                                  | Browser/axe reports after internal safety validation                      |
| `inspect FILE.epub [--summary]`                                 | Read-only NAV/NCX, reading order, metadata, cover and reference inventory |
| `epub audit FILE.epub`                                          | Read-only audit and suggested repair classifications                      |
| `epub repair-plan FILE.epub --output PLAN.json`                 | Input-bound plan                                                          |
| `epub repair FILE.epub --plan PLAN.json --output NEW.epub`      | Controlled repair and all release gates                                   |
| `taxonomy list`, `taxonomy explain TAG`                         | Controlled English subject definitions                                    |
| `schema`, `formats`, `version`                                  | Machine-readable contracts                                                |

Every command accepts `--json`. JSON occupies stdout without progress logs; human output uses stderr. Failed commands exit nonzero with stable error codes. Ctrl-C cancels long-running subprocesses. Inspection and audit do not modify source artifacts. `build` and `preview` acquire a shared per-book `dist/.build.lock`; inspect the running process before removing a lock left by a killed process.

`novel inspect BOOK_URL` returns source metadata and numbered volumes. `novel fetch BOOK_URL [--output NEW_DIRECTORY] [--volumes 1-3,5] [--split-volumes] [--prepare-only]` collects a supported website into local books and, by default, builds each through every release gate. See [novel sources](novel-sources.md) for metadata overrides, rate limits, authentication and provenance. `--prepare-only` returns an explicit non-release result. Source tests inject recorded responses; CI rejects live source requests.

`build DIRECTORY --to simplified|traditional|china|taiwan|hongkong` converts rendered Chinese text before packaging checks. `epub convert FILE.epub --to TARGET --output NEW.epub` converts an existing EPUB 3 and runs every release gate. The latter writes `<output>.reports/` and uses an exclusive `<output>.conversion.lock`; inspect a running conversion before removing a stale lock. See [Chinese conversion](chinese-conversion.md) for online behavior, response snapshots and configuration.

`epub repair-copy` consumes a reading plan (`epub repair-plan --purpose reading`) and returns a checked personal reading copy with remaining source findings, rather than a release artifact. The [repair workflow](repair.md) describes its preservation guarantees, sampled QA and directory command. Publication plans continue to use `epub repair` and all release gates.

On macOS, the known Codex Seatbelt execution environment blocks the system application registration used by Chromium's headless startup. `doctor`, Ace and browser QA return `ENVIRONMENT_ERROR` before launching Chrome in that environment, preventing repeated crash dialogs. Run browser-dependent validation in an explicitly authorized host environment or the pinned QA container; file presence alone does not mean that this environment can run a browser. This guard is Quillbind environment policy. Chromium's [macOS headless initialization](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/headless/headless_mode_platform_mac.mm) was checked on 2026-09-06. No release gate is skipped.

QA closes acquired resources after initialization failures and cancellation, and attempts browser and server cleanup independently. A cleanup failure does not replace the original operation error. On supported macOS/Linux hosts, external tools run in owned [process groups](https://nodejs.org/api/child_process.html#optionsdetached). Timeout, cancellation and output overflow first send `SIGTERM`, allow up to five seconds for cleanup, then stop remaining group members with `SIGKILL`. Tool exit also cleans remaining group members, including descendants retaining output pipes. Cancellation preserves its original reason and waits for cleanup. Tools remain responsible for gracefully closing any descendants that create their own sessions.

Human output summarizes metadata, preflight, validators, QA and repair actions with readable diagnostics; `schema` retains its structured JSON representation. Human `inspect` output is concise; full JSON preserves the existing manifest/spine/entry fields and adds the structures described in [inspection](../../../skills/quillbind/references/inspection.md). `--summary --json` reduces the payload. Build/repair return paths to `reports/summary.md` and `summary.json` on success and on failures after a run starts. Initialization reports readiness and source preparation evidence; it does not claim a release.

## Tests and container

Vitest covers unit contracts, metadata decisions, parser extensions, static format declarations, publication-node invariants, isolated MathML conversion, shared EPUB inspection, actual serialization, repair, JSON CLI behavior and security properties. Property tests exercise ZIP round trips. Blog import tests cover whitelisted chapter Properties, Astro heading slugs, chapter-relative images and repeated named footnotes. `pnpm verify` rebuilds literature and technical examples twice and repairs the EPUB 2 fixture through EPUBCheck, Ace and browser QA. `pnpm qa:fixtures` exercises RTL, vertical writing, long code/tables, blog publication and expected failures. Browser regressions also click repeated note references and their exact return destinations and inspect bylines under reader overrides. These scripts fail on a missing gate or unexpected acceptance.

Run these container commands from the catalog repository root:

```sh
docker build --platform linux/arm64 -f tools/quillbind/Dockerfile.qa -t quillbind-qa:local .
docker run --rm --platform linux/arm64 --network none --shm-size=1g quillbind-qa:local \
  sh -c 'pnpm typecheck && pnpm lint && pnpm test:coverage && pnpm build && pnpm verify && pnpm qa:fixtures && pnpm test:visual && pnpm skill:eval'
```

The workflow builds the digest-pinned image, uses frozen dependency installs and runs offline publication checks. GitHub Actions themselves are pinned to the official stable-release commit hashes. Failed reports and screenshots are uploaded as CI artifacts. There is no automatic snapshot update or deployment.

## Skill validation

Install the official validator from the catalog root as described in the [repository README](../../../README.md#维护), then run:

```sh
# From tools/quillbind:
pnpm skill:validate
node ../../skills/quillbind/scripts/quillbind.mjs version --json
```

The root `requirements-skill.txt` pins the official [Agent Skills reference tooling](https://github.com/agentskills/agentskills/tree/main/skills-ref). The shared root validator checks every skill's format and self-contained resources. `skills/quillbind/SKILL.md` progressively loads references and executes the helper, which uses `QUILLBIND_ROOT`, this workspace or an installed `quillbind` on PATH. Install through `npx skills add vizmoe/skills --skill quillbind`; configure the workspace location with `QUILLBIND_ROOT` as described in the [environment reference](../../../skills/quillbind/references/environment.md).

`pnpm skill:eval` runs the real helper through isolated workflows and writes command traces and assertions under `dist/skill-evals/`. See [scenario evaluation](skill-evaluation.md) for the distinction between executable workflow checks and independent agent evaluation. Skill schema validation alone does not test invocation decisions.

## Maintaining the locks

Check authoritative stable releases, update exact manifests and integrity records, regenerate the pnpm lock, then execute all functional and container checks. The browser image, browser revision, font environment and reviewed reference screenshots must change together. Keep the source taxonomy version and metadata lock consistent. Format with `pnpm format`; binary fixtures, generated metadata and lock records are intentionally excluded from Prettier. Document rules in this directory and link standards/platform diagnostics to their official source. Quillbind-only authoring and environment rules are project policy.

## Author iteration and maintenance

`preview DIRECTORY [--to TARGET] [--online]` creates `dist/preview/candidate.epub` after one render. Its JSON result is explicitly a preview with release gates `not-run`; it shares the build lock and preserves existing release artifacts/reports. `build` remains the complete release path. Chinese conversion uses a book-side response lock by default; `--online` refreshes it. See [conversion](chinese-conversion.md) for lock locations and invalidation.

`preflight` and `preview` expose `qaProjection` with browser case counts and heuristic screenshot storage before QA starts. `build`, `preview`, `preflight` and standalone `qa` accept `--qa-coverage full|stratified`, overriding `qa.coverage` in book configuration. Full coverage stays the default; `coverage.json` and the release summary identify an explicit stratified run. Screenshot retention is separately configured with `qa.screenshots`. See [coverage policy](quality.md).

`epub repair-directory SOURCE --output DESTINATION [--jobs 2]` snapshots source EPUBs, preserves subdirectories, isolates reading-copy reports and resumes hash-verified results. Concurrency is bounded to one through four books. The aggregate JSON and Markdown index record per-book failures. This typed CLI replaces the earlier Python directory helper.

`pnpm lint` checks formatting, JavaScript rules, type-aware Promise/error/exhaustiveness rules and consistency of machine-readable pins. TypeScript's [documented side-by-side setup](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0) is a temporary compatibility arrangement: `@typescript/native` aliases the native TypeScript 7 package, whose `tsc` runs typecheck and build; `typescript` aliases the TypeScript 6 compatibility package so typescript-eslint's `projectService` can import the supported JavaScript compiler API. The compatibility package re-exports a separate TypeScript 6 dependency, so its package version and API version differ. Its bundled `tsc6` command is unused. Exact aliases live in `package.json`, and `pnpm-lock.yaml` freezes the re-exported API. `scripts/check-locks.mjs` checks both aliases, installed versions, the actual lint API and project-service resolution, and the `tsc` command version. Lint therefore evaluates types using TS 6 while TS 7 remains the build authority; passing lint alone does not establish TS 7 type correctness.

Exit condition: when typescript-eslint supports the TypeScript 7 API, replace both aliases with one exact `typescript` dependency in the same upgrade, remove TypeScript 6 and this temporary split check, regenerate the lock and integrity ledger, and run lint, typecheck, build and the full functional/container checks. Keep unsupported-TypeScript errors enabled during the transition.

`pnpm test:coverage` collects V8 coverage across core and CLI source, including unexecuted files, and enforces the thresholds in `vitest.config.ts`. Coverage evidence lives in `dist/coverage/`; child-process CLI workflows are checked separately by `skill:eval`.
