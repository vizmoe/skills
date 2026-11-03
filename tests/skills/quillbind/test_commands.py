"""Documented runtime commands must work from an installed skill."""
import re
import unittest

from tests.support import ROOT

SKILL = ROOT / "skills/quillbind"
# An installed skill exposes the runtime only through this launcher; `quillbind` is not on PATH.
BARE = re.compile(r"(?:^|[`\s])quillbind\s+(?:epub|metadata|manga|novel|init|doctor|inspect|build|preview|preflight|validate|qa|schema|formats|taxonomy|version)\b")


class DocumentedCommandTests(unittest.TestCase):
    def test_runtime_commands_use_the_installed_launcher(self):
        offenders = []
        for path in sorted(SKILL.rglob("*.md")):
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                # Setup inside the runtime checkout legitimately runs `pnpm quillbind`.
                if BARE.search(line.replace("pnpm quillbind", "")):
                    offenders.append(f"{path.relative_to(ROOT)}:{number}: {line.strip()}")
        self.assertEqual(offenders, [], "Use node <skill-directory>/scripts/quillbind.mjs:\n" + "\n".join(offenders))


if __name__ == "__main__":
    unittest.main()
