# Musagetes maintenance

For changes to invocation or domain rules, read the [behavior cases](../../../tests/skills/musagetes/skill-cases.md). Run the focused suite from the repository root:

```sh
python3 -B -m unittest discover -s tests/skills/musagetes -v
```

Use the [catalog checks](../../../CONTRIBUTING.md#本地验证) for installed-resource validation and all Python regression suites. Fixtures must stay separate from real music libraries.

Resource paths are relative to the skill directory; music roots come from the caller, and runtime state stays inside the authorized root. `library_guard.py` and `music_rules.py` provide read-only checks, not transaction execution.

Keep field definitions in [metadata-whitelist](../../../skills/musagetes/references/metadata-whitelist.md), completion semantics in [delivery](../../../skills/musagetes/references/delivery.md), batch/recovery rules in [execution](../../../skills/musagetes/references/execution.md), and machine interfaces in [tools](../../../skills/musagetes/references/tools.md). Update `metadata.version` when rules or runtime behavior change. Writable tools require corresponding transaction and recovery verification.

Upstream scheduling rules and parsed policy tables live in [requests](../../../skills/musagetes/references/requests.md). `source-throttle.py` returns decisions and replacement state without HTTP, sleeps or writes; the caller owns serial request execution and state persistence. Scheduling tests use synthetic responses and injected clocks/jitter, so they do not claim live transport or shared-IP quota enforcement.

The helpers read these references at run time instead of keeping a second copy, so edit the reference and the executed rule follows. `read_whitelist` parses the two whitelist tables, and `read_vocabulary` parses the status dimensions from delivery's status table plus the phase sequence from execution's transaction section. Both reject malformed tables, and `BRANCHED_ON` in `music_rules.py` names the values the helpers branch on so that renaming one in a reference fails loudly rather than silently disabling a check. Because the references are a run-time dependency, they must stay inside the installed skill; the installation test exercises `history` from a real installation to prove it.
