from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from validate_skills import discover_skills, validate_license, validate_resources


class ProjectLicenseTests(unittest.TestCase):
    def test_missing_or_divergent_distribution_notice_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project_license = root / "LICENSE"
            project_license.write_text("project license")
            skill = root / "example"
            skill.mkdir()
            for notice in (None, "different license", "project license"):
                with self.subTest(notice=notice):
                    if notice is not None:
                        (skill / "LICENSE").write_text(notice)
                    if notice == "project license":
                        validate_license(skill, project_license, "MIT")
                    else:
                        with self.assertRaisesRegex(ValueError, "LICENSE"):
                            validate_license(skill, project_license, "MIT")
            with self.assertRaisesRegex(ValueError, "MIT"):
                validate_license(skill, project_license, None)

    def test_every_skill_bundles_the_project_license(self):
        root = Path(__file__).resolve().parents[2]
        license_file = root / "LICENSE"
        self.assertTrue(license_file.is_file(), "The project needs a root LICENSE")
        for skill in sorted((root / "skills").iterdir()):
            with self.subTest(skill=skill.name):
                self.assertEqual((skill / "LICENSE").read_bytes(), license_file.read_bytes())


class DiscoveryTests(unittest.TestCase):
    def test_empty_and_incomplete_catalogs_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "skills").mkdir()
            with self.assertRaisesRegex(ValueError, "No skills"):
                discover_skills(root)
            (root / "skills/new-skill").mkdir()
            with self.assertRaisesRegex(ValueError, "SKILL.md"):
                discover_skills(root)

    def test_linked_skill_directories_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "skills").mkdir()
            (root / "elsewhere").mkdir()
            (root / "elsewhere/SKILL.md").write_text("Outside catalog")
            (root / "skills/linked").symlink_to(root / "elsewhere", target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "local skill"):
                discover_skills(root)


class ResourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "example"
        (self.root / "references").mkdir(parents=True)
        (self.root / "SKILL.md").write_text("Read [rules](references/rules.md#安全).\n")
        (self.root / "references/rules.md").write_text("# Rules\n\n## 安全\nPreserve sources.\n")

    def test_valid_resources(self):
        validate_resources(self.root)

    def test_task_specific_resource_directories_are_installable(self):
        (self.root / "templates").mkdir()
        (self.root / "templates/example.txt").write_text("A resource used by a future skill.\n")
        with (self.root / "SKILL.md").open("a") as source:
            source.write("Use [the template](templates/example.txt).\n")
        validate_resources(self.root)

    def test_markdown_link_examples_inside_code_are_literal(self):
        with (self.root / "SKILL.md").open("a") as source:
            source.write("Use `[1](#fn1)` only with an existing target.\n\n```md\n[example](missing.md)\n```\n")
        validate_resources(self.root)

    def test_missing_reference(self):
        (self.root / "references/rules.md").unlink()
        with self.assertRaisesRegex(ValueError, "Missing"):
            validate_resources(self.root)

    def test_missing_heading(self):
        (self.root / "references/rules.md").write_text("# Rules\n")
        with self.assertRaisesRegex(ValueError, "anchor"):
            validate_resources(self.root)

    def test_reference_escape(self):
        outside = self.root.parent / "private.md"
        outside.write_text("local only")
        (self.root / "SKILL.md").write_text("Read [private](../private.md).\n")
        with self.assertRaisesRegex(ValueError, "escaping"):
            validate_resources(self.root)

    def test_unreachable_reference(self):
        (self.root / "references/orphan.md").write_text("# Orphan\n")
        with self.assertRaisesRegex(ValueError, "Unreachable"):
            validate_resources(self.root)

    def test_symlinked_resource(self):
        source = self.root / "references/rules.md"
        source.unlink()
        source.symlink_to(self.root / "SKILL.md")
        with self.assertRaises(ValueError):
            validate_resources(self.root)

    def test_development_and_history_are_not_installable(self):
        for name in ("work", "tests", ".git", "dist"):
            with self.subTest(name=name):
                directory = self.root / name
                directory.mkdir()
                with self.assertRaisesRegex(ValueError, "Development"):
                    validate_resources(self.root)
                directory.rmdir()

    def test_nested_history_and_generated_directories_are_rejected(self):
        for name in (".git", "node_modules", "__pycache__"):
            with self.subTest(name=name):
                directory = self.root / "references" / name
                directory.mkdir()
                with self.assertRaisesRegex(ValueError, "Development"):
                    validate_resources(self.root)
                directory.rmdir()


if __name__ == "__main__":
    unittest.main()
