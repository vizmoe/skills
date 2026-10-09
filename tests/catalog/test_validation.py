from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from validate_skills import (discover_skills, validate_distribution, validate_documentation,
                             validate_license, validate_resources, walk)


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

    def test_a_linked_binary_asset_is_reachable_without_decoding_it(self):
        (self.root / "assets").mkdir()
        (self.root / "assets/cover.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        with (self.root / "SKILL.md").open("a") as source:
            source.write("Use [the cover](assets/cover%2Epng).\n")
        validate_resources(self.root)

    def test_linked_data_cannot_make_an_undocumented_resource_reachable(self):
        (self.root / "templates").mkdir()
        (self.root / "templates/example.txt").write_text("unused.json\n")
        (self.root / "templates/unused.json").write_text("{}\n")
        with (self.root / "SKILL.md").open("a") as source:
            source.write("Use [the template](templates/example.txt).\n")
        with self.assertRaisesRegex(ValueError, "Unreachable resource.*unused.json"):
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

    def test_a_bundled_resource_no_document_mentions_is_rejected(self):
        (self.root / "agents").mkdir()
        (self.root / "agents/openai.yaml").write_text("interface:\n  display_name: Example\n")
        with self.assertRaisesRegex(ValueError, "Unreachable resource"):
            validate_resources(self.root)

    def test_a_script_named_only_inside_a_fenced_command_is_reachable(self):
        (self.root / "scripts").mkdir()
        (self.root / "scripts/audit.py").write_text("print('audit')\n")
        with (self.root / "references/rules.md").open("a") as source:
            source.write("\n```sh\npython3 <skill-directory>/scripts/audit.py --help\n```\n")
        validate_resources(self.root)

    def test_an_unreachable_document_outside_references_is_rejected(self):
        (self.root / "guides").mkdir()
        (self.root / "guides/orphan.md").write_text("# Orphan\n")
        with self.assertRaisesRegex(ValueError, "Unreachable reference"):
            validate_resources(self.root)


class DistributionBoundaryTests(unittest.TestCase):
    def test_only_the_catalogs_own_units_may_look_installable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / "skills/example"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("---\nname: example\ndescription: Do one task.\n---\n")
            validate_distribution(root, [skill], list(walk(root)))
            nested = skill / "references/nested"
            nested.mkdir(parents=True)
            (nested / "SKILL.md").write_text("---\nname: nested\ndescription: Shadow unit.\n---\n")
            with self.assertRaisesRegex(ValueError, "Installable SKILL.md"):
                validate_distribution(root, [skill], list(walk(root)))

    def test_dependency_and_build_trees_are_not_scanned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / "skills/example"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("---\nname: example\ndescription: Do one task.\n---\n")
            vendored = root / "tools/example/node_modules/other"
            vendored.mkdir(parents=True)
            (vendored / "SKILL.md").write_text("---\nname: other\ndescription: Vendored.\n---\n")
            validate_distribution(root, [skill], list(walk(root)))


class DocumentationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "docs").mkdir()
        (self.root / "CONTRIBUTING.md").write_text("# Contributing\n\n## Local checks\nRun the suite.\n")
        self.guide = self.root / "docs/README.md"
        self.guide.write_text("Read the [checks](../CONTRIBUTING.md#local-checks).\n")

    def documents(self):
        return validate_documentation(self.root, list(walk(self.root)))

    def test_valid_cross_tree_links(self):
        self.assertEqual(self.documents(), 2)

    def test_missing_cross_tree_target(self):
        self.guide.write_text("Read the [guide](../missing/page.md).\n")
        with self.assertRaisesRegex(ValueError, "Missing or escaping link target"):
            self.documents()

    def test_broken_cross_tree_anchor(self):
        self.guide.write_text("Read the [checks](../CONTRIBUTING.md#no-such-heading).\n")
        with self.assertRaisesRegex(ValueError, "Broken heading anchor"):
            self.documents()

    def test_link_escaping_the_repository(self):
        self.guide.write_text("Read the [private notes](../../private.md).\n")
        with self.assertRaisesRegex(ValueError, "Missing or escaping link target"):
            self.documents()

    def test_explicit_heading_identifiers_and_directory_links_resolve(self):
        (self.root / "docs/chapter.md").write_text("# River {#river}\n\nText.\n")
        self.guide.write_text("See [the river](chapter.md#river) and the [docs](../docs).\n")
        self.assertEqual(self.documents(), 3)

    def test_external_and_fenced_links_are_not_resolved(self):
        self.guide.write_text(
            "See [the spec](https://agentskills.io/specification).\n\n```md\n[example](missing.md)\n```\n"
        )
        self.assertEqual(self.documents(), 2)


if __name__ == "__main__":
    unittest.main()
