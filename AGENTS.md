# Skill catalog maintenance

Installable resources belong in `skills/<name>/`, with `SKILL.md` as the entrypoint. Keep human guides in `docs/skills/<name>/`, catalog checks in `tests/catalog/`, skill behavior tests in `tests/skills/<name>/`, and optional runtime workspaces in `tools/<name>/`. Installation copies the skill directory; keep development files and runtime state outside it.

For catalog layout, licensing or a new skill, read [CONTRIBUTING.md](CONTRIBUTING.md). Validate with `python3 -B scripts/validate_skills.py` and run all Python catalog and skill tests with `python3 -B -m unittest discover -s tests -v`. Publish from Git through `npx skills add`.

For changes to a skill or its tests, read `docs/skills/<name>/README.md` and its linked development guidance. For runtime changes, follow that workspace's `AGENTS.md` and development guide. Preserve the runtime's existing release gates; skill installation and domain artifact delivery are separate contracts. Maintenance does not authorize operations on real user libraries.
