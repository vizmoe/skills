"""All catalog entries must survive a real, isolated skills CLI installation."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from tests.support import ROOT, SkillInstallationTestCase

sys.path.insert(0, str(ROOT / "scripts"))
from validate_skills import discover_skills


class DistributionTests(SkillInstallationTestCase):
    def test_every_catalog_skill_installs(self):
        with tempfile.TemporaryDirectory() as directory:
            for skill in discover_skills(ROOT):
                with self.subTest(skill=skill.name):
                    self.install_skill(Path(directory) / skill.name, skill.name)

    def test_a_future_skill_is_discovered_validated_and_installed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "catalog"
            skill = catalog / "skills/future-workflow"
            (skill / "templates").mkdir(parents=True)
            shutil.copy2(ROOT / "LICENSE", catalog / "LICENSE")
            shutil.copy2(ROOT / "LICENSE", skill / "LICENSE")
            (skill / "SKILL.md").write_text(
                "---\nname: future-workflow\n"
                "description: Create a document from the bundled template when requested.\n"
                "license: MIT\n---\n\nUse [the template](templates/example.txt).\n"
            )
            (skill / "templates/example.txt").write_text("A future skill's task resource.\n")
            (catalog / "README.md").write_text("Human-facing catalog overview.\n")
            (catalog / "tests").mkdir()
            (catalog / "tests/development-only.txt").write_text("Keep outside installations.\n")
            self.assertEqual([item.name for item in discover_skills(catalog)], ["future-workflow"])
            result = subprocess.run(
                [sys.executable, "-B", str(ROOT / "scripts/validate_skills.py"), "--root", str(catalog)],
                text=True, capture_output=True, timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Resource validation passed: future-workflow", result.stdout)
            self.install_skill(root / "project", "future-workflow", catalog)
