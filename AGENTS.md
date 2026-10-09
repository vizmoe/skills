# Skill catalog maintenance

Installable resources belong in `skills/<name>/`, with `SKILL.md` as the entrypoint. Keep human guides in `docs/skills/<name>/`, catalog checks in `tests/catalog/`, skill behavior tests in `tests/skills/<name>/`, and optional runtime workspaces in `tools/<name>/`. Installation copies the skill directory; keep development files and runtime state outside it.

For catalog layout, licensing or a new skill, read [CONTRIBUTING.md](CONTRIBUTING.md). Validate with `python3 -B scripts/validate_skills.py` and run all Python catalog and skill tests with `python3 -B -m unittest discover -s tests -v`. Publish from Git through `npx skills add`.

The validator enforces three conventions beyond the official format: every bundled file must be reachable from `SKILL.md` by link or by name in a reachable document, Markdown links and heading anchors must resolve across the whole repository, and `skills/<name>/SKILL.md` must be the only SKILL.md present. Bundled resources use lowercase hyphenated filenames, and frontmatter follows the spec's field order.

For changes to a skill or its tests, read `docs/skills/<name>/README.md` and its linked development guidance. For runtime changes, follow that workspace's `AGENTS.md` and development guide. Preserve the runtime's existing release gates; skill installation and domain artifact delivery are separate contracts. Maintenance does not authorize operations on real user libraries.
