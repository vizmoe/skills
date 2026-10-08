# Environment and commands

For publishing operations, invoke `node <skill-directory>/scripts/quillbind.mjs ...`. The helper uses Node built-ins and searches `QUILLBIND_ROOT/bin/quillbind.mjs`, the source checkout's `tools/quillbind/bin/quillbind.mjs`, then `quillbind` on `PATH`. skills.sh installs the skill resources; the Node workspace is a separate runtime prerequisite. Retain the checkout's `skills/quillbind` alongside the workspace for its shared tag vocabulary and loader. Python is used solely for repository development validation of the skill, not for book operations. The standalone [tag audit](tags.md) needs only Node.js, with no publishing workspace or validators.

Use the exact Node version in `tools/quillbind/.node-version` and pnpm version in that workspace's `package.json`. Its `standards/tools.lock.json` pins release tools and external archive hashes. For an installed skill, clone the runtime once into a chosen new directory, install its dependencies, and expose its absolute path to the agent process:

```sh
git clone https://github.com/vizmoe/skills.git skills-runtime
cd skills-runtime/tools/quillbind
pnpm install --frozen-lockfile
pnpm tools:install
export QUILLBIND_ROOT="$PWD"
pnpm quillbind doctor --json
```

Reuse an existing checkout by setting `QUILLBIND_ROOT` to its `tools/quillbind` directory. Keep the runtime on the same Git revision as the skill when updating. Setup downloads Java, EPUBCheck and the Chromium revision. Release checks need those tools; preparation, inspection and preview can run with Node and installed package dependencies. Ordinary builds use saved metadata and conversion locks offline. Online metadata discovery and conversion refreshes require explicit `--online`. Complete environment setup already authorized by the task; ask only about changes outside that scope.

Use `--help --json`, `schema --json`, `formats --json` and `taxonomy list --json` for executable contracts. Human logs go to stderr; JSON results go to stdout. A nonzero exit or `status: fail` prevents a success claim. The helper and launcher honor positive integer `QUILLBIND_TIMEOUT_SECONDS` (default 1,800).

The product emits one canonical EPUB with both platform checks. New-book inputs are Markdown directories. `UNSUPPORTED_FORMAT` reports the actual format boundary.
