# Skill catalog maintenance

Installable resources belong in `skills/<name>/`, with `SKILL.md` as the entrypoint. Keep tests, development documentation and local run data outside that directory: skills.sh installs its contents. Publish from this Git repository through `npx skills add`; validate with `python3 -B scripts/validate_skills.py` and exercise actual installation with `python3 -B -m unittest discover -s tests -v`.

For Musagetes changes, run `python3 -B -m unittest discover -s tests/musagetes -v`. Read [behavior cases](tests/musagetes/skill-cases.md) when changing invocation or domain rules. Maintenance does not authorize operations on real music libraries.

Musagetes resource paths are relative to its skill directory; music roots come from the caller, and runtime state stays inside the authorized root. `library_guard.py` and `music_rules.py` provide read-only checks, not transaction execution. Keep field definitions in `references/METADATA_WHITELIST.md`, completion semantics in `references/DELIVERY.md`, batch/recovery rules in `references/EXECUTION.md`, and machine interfaces in `references/TOOLS.md`. Update `metadata.version` when rules or runtime behavior change. Writable tools require corresponding transaction and recovery verification.

For Quillbind runtime changes, follow [tools/quillbind/AGENTS.md](tools/quillbind/AGENTS.md) and its development guide. Skills installation and EPUB book publication are separate contracts; preserve every EPUB release gate.
