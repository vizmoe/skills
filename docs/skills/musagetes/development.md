# Musagetes maintenance

For changes to invocation or domain rules, read the [behavior cases](../../../tests/skills/musagetes/skill-cases.md). Run the focused suite from the repository root:

```sh
python3 -B -m unittest discover -s tests/skills/musagetes -v
```

Use the [catalog checks](../../../CONTRIBUTING.md#本地验证) for installed-resource validation and all Python regression suites. Fixtures must stay separate from real music libraries.

Resource paths are relative to the skill directory; music roots come from the caller, and runtime state stays inside the authorized root. `library_guard.py` and `music_rules.py` provide read-only checks, not transaction execution.

Keep field definitions in [METADATA_WHITELIST](../../../skills/musagetes/references/METADATA_WHITELIST.md), completion semantics in [DELIVERY](../../../skills/musagetes/references/DELIVERY.md), batch/recovery rules in [EXECUTION](../../../skills/musagetes/references/EXECUTION.md), and machine interfaces in [TOOLS](../../../skills/musagetes/references/TOOLS.md). Update `metadata.version` when rules or runtime behavior change. Writable tools require corresponding transaction and recovery verification.
