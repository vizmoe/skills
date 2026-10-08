"""Public helper contracts using synthetic inventories; no live library access."""
from pathlib import Path
import hashlib
import json
import subprocess
import tempfile
import unittest

from tests.support import ROOT, SkillInstallationTestCase

SKILL = ROOT / "skills/quillbind"


class TagAuditTests(unittest.TestCase):
    def run_audit(self, books, vocabulary=None, decisions=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory = root / "inventory.json"
            inventory.write_text(json.dumps(books), encoding="utf-8")
            vocab = root / "vocabulary.json"
            vocab.write_bytes((SKILL / "references/tag-vocabulary.json").read_bytes()
                             if vocabulary is None else json.dumps(vocabulary).encode())
            args = ["node", str(SKILL / "scripts/tags.mjs"), "audit", "--input", str(inventory), "--vocabulary", str(vocab)]
            if decisions is not None:
                plan = root / "decisions.json"
                plan.write_text(json.dumps(decisions), encoding="utf-8")
                args += ["--decisions", str(plan)]
            before = {p.name: p.read_bytes() for p in root.iterdir()}
            result = subprocess.run(args, capture_output=True, text=True, timeout=30)
            self.assertEqual({p.name: p.read_bytes() for p in root.iterdir()}, before)
            return result.returncode, json.loads(result.stdout), before

    def test_normalizes_only_declared_aliases_and_preserves_unknown_tags(self):
        code, report, before = self.run_audit([
            {"id": 1, "title": "Synthetic", "tags": [" fantasy ", "Literature.Fantasy", "science. computer   science", "简体中文", "Author Name"]}
        ])
        self.assertEqual(code, 0)
        book = report["books"][0]
        self.assertEqual(book["proposed"], ["Literature.Fantasy", "Science.Computer Science", "简体中文", "Author Name"])
        self.assertEqual([f["tag"] for f in book["unresolved"]], ["简体中文", "Author Name"])
        self.assertEqual(report["status"], "needs-review")
        self.assertFalse(report["libraryWritten"])
        self.assertEqual(report["inputs"]["inventory"]["sha256"], hashlib.sha256(before["inventory.json"]).hexdigest())
        self.assertEqual(report["inputs"]["vocabulary"]["sha256"], hashlib.sha256(before["vocabulary.json"]).hexdigest())

    def test_classification_uses_evidence_not_title_author_series_or_language(self):
        books = [
            {"id": 1, "title": "Synthetic prose", "tags": ["Literature.Manga"]},
            {"id": 2, "title": "Synthetic artwork", "tags": ["Literature.Light Novel", "Arts.General"]},
            {"id": 3, "title": "A Light Novel in English", "languages": ["eng"], "tags": []},
        ]
        decisions = [
            {"id": 1, "kind": "light-novel", "evidence": ["Publisher identifies the selected volume as prose."]},
            {"id": 2, "kind": "art-book", "evidence": ["Interior pages and publisher identify an art collection."]},
        ]
        code, report, _ = self.run_audit(books, decisions=decisions)
        self.assertEqual(code, 0)
        self.assertEqual(report["books"][0]["proposed"], ["Literature.Light Novel"])
        self.assertEqual(report["books"][1]["proposed"], ["Arts.General"])
        self.assertEqual(report["books"][2]["proposed"], [])
        self.assertEqual(report["books"][2]["unresolved"][0]["code"], "MISSING_TAGS")
        self.assertTrue(report["books"][0]["evidence"])

    def test_explicit_field_decisions_require_evidence_and_preserve_other_tags(self):
        code, report, _ = self.run_audit(
            [{"id": 1, "title": "Synthetic", "tags": ["Literature.Light Novel", "简体中文"]}],
            decisions=[{"id": 1, "add": ["Literature.Fantasy"], "remove": ["简体中文"], "evidence": ["User-supplied genre; script belongs in language metadata."]}],
        )
        self.assertEqual(code, 0)
        self.assertEqual(report["books"][0]["proposed"], ["Literature.Light Novel", "Literature.Fantasy"])
        self.assertEqual(report["books"][0]["unresolved"], [])
        self.assertEqual(report["books"][0]["removed"], ["简体中文"])

    def test_invalid_inputs_and_unscoped_or_unsupported_decisions_fail(self):
        inventory = [{"id": 1, "title": "Synthetic", "tags": []}]
        for decisions in ([{"id": 1, "kind": "manga"}],
                          [{"id": 9, "kind": "manga", "evidence": ["Publisher"]}],
                          [{"id": 1, "add": ["Uncontrolled.Tag"], "evidence": ["Publisher"]}],
                          [{"id": 1, "kind": "manga", "add": ["Literature.Light Novel"], "evidence": ["Publisher"]}]):
            with self.subTest(decisions=decisions):
                code, error, _ = self.run_audit(inventory, decisions=decisions)
                self.assertNotEqual(code, 0)
                self.assertEqual(error["code"], "INPUT_INVALID")
        for bad in ([*inventory, *inventory], [{"id": 1, "title": "Synthetic", "tags": "Fantasy"}]):
            code, error, _ = self.run_audit(bad)
            self.assertNotEqual(code, 0)
            self.assertEqual(error["code"], "INPUT_INVALID")

    def test_vocabulary_controls_mappings_and_gaps(self):
        vocabulary = {"version": 3, "structure": "Major.Controlled Subclass",
                      "fixed_major_classes": {"Literature": "P", "Music": "M"},
                      "controlled_subclasses": {"Literature": ["Fiction"], "Music": []},
                      "flat_to_hierarchical": {"Fiction": "Literature.Fiction"}}
        books = [{"id": 1, "title": "Synthetic", "tags": ["Literature.Fantasy"]}]
        code, report, _ = self.run_audit(books, vocabulary)
        self.assertEqual(code, 0)
        self.assertEqual(report["books"][0]["proposed"], ["Literature.Fantasy"])
        self.assertEqual(report["books"][0]["unresolved"][0]["code"], "UNKNOWN_TAG")
        code, report, _ = self.run_audit(books, vocabulary, [{"id": 1, "kind": "light-novel", "evidence": ["Publisher"]}])
        self.assertEqual(code, 0)
        self.assertIn("VOCABULARY_GAP", [item["code"] for item in report["books"][0]["unresolved"]])
        vocabulary["flat_to_hierarchical"]["Invalid"] = "Literature.Missing"
        code, error, _ = self.run_audit(books, vocabulary)
        self.assertNotEqual(code, 0)
        self.assertEqual(error["code"], "TAXONOMY_INVALID")

    def test_ambiguous_aliases_fail_and_normalization_is_idempotent(self):
        vocabulary = json.loads((SKILL / "references/tag-vocabulary.json").read_text())
        vocabulary["flat_to_hierarchical"]["fantasy"] = "Literature.Fiction"
        code, error, _ = self.run_audit([], vocabulary)
        self.assertNotEqual(code, 0)
        self.assertEqual(error["code"], "TAXONOMY_INVALID")
        original = [{"id": 1, "title": "Synthetic", "tags": ["Fantasy", "Literature.Fantasy", "Unknown"]}]
        _, first, _ = self.run_audit(original)
        original[0]["tags"] = first["books"][0]["proposed"]
        code, second, _ = self.run_audit(original)
        self.assertEqual(code, 0)
        self.assertEqual(second["books"][0]["proposed"], original[0]["tags"])
        self.assertEqual(second["books"][0]["changes"], [])
        self.assertEqual(second["status"], "needs-review")


class InstalledTagAuditTests(SkillInstallationTestCase):
    def test_installed_audit_works_without_runtime_and_refuses_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            installed = self.install_skill(root, "quillbind")
            source = root / "inventory.json"
            source.write_text('[{"id":1,"title":"Synthetic","tags":["Fantasy"]}]')
            output = root / "report.json"
            args = ["node", str(installed / "scripts/tags.mjs"), "audit", "--input", str(source), "--output", str(output)]
            first = subprocess.run(args, cwd=root, capture_output=True, text=True, timeout=30)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertEqual(json.loads(output.read_text())["books"][0]["proposed"], ["Literature.Fantasy"])
            before = output.read_bytes()
            second = subprocess.run(args, cwd=root, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual(json.loads(second.stdout)["code"], "OUTPUT_EXISTS")
            self.assertEqual(output.read_bytes(), before)
            alias = root / "alias.json"
            alias.symlink_to(source)
            third = subprocess.run(args[:-1] + [str(alias)], cwd=root, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(third.returncode, 0)
            self.assertEqual(source.read_text(), '[{"id":1,"title":"Synthetic","tags":["Fantasy"]}]')
