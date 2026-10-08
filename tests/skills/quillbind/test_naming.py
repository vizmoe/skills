"""Edition-aware naming proposals from synthetic inventories, never a live library."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from tests.support import ROOT, SkillInstallationTestCase

SCRIPT = ROOT / "skills/quillbind/scripts/naming.mjs"


def book(key, number=None, kind="main", date=None, title=None, subseries=None):
    return {
        "id": key, "edition": "台灣選定版", "kind": kind,
        "originalTitle": "原書名 " + key, "volumeTitle": title,
        "firstPublished": date,
        "source": {"path": "/synthetic/" + key + ".epub", "sha256": "a" * 64},
        "evidence": ["Matched title and credits in the selected edition."],
        "official": {
            "unified": None if number is None else {"number": number, "evidence": ["Official selected-edition volume."]},
            "subseries": subseries,
            "unavailableEvidence": ["Publisher and book explicitly identify this extra as unnumbered."] if number is None and subseries is None else [],
        },
    }


def inventory(*books, name="某系列"):
    return {
        "schemaVersion": 1,
        "series": {"name": name, "edition": "台灣選定版", "evidence": ["Publisher series catalog."]},
        "coverage": {"mainComplete": True, "extrasComplete": True, "evidence": ["All known main volumes and unnumbered extras included, including reference-only records."]},
        "chronology": None,
        "books": list(books),
    }


class NamingTests(unittest.TestCase):
    def plan(self, data, script=SCRIPT):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "inventory.json"
            source.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            original = source.read_bytes()
            result = subprocess.run(["node", str(script), "plan", "--input", str(source)], cwd=root,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual({p.name for p in root.iterdir()}, {"inventory.json"})
            self.assertTrue(result.stdout, result.stderr)
            return result.returncode, json.loads(result.stdout), hashlib.sha256(original).hexdigest()

    def success(self, data):
        code, report, digest = self.plan(data)
        self.assertEqual(code, 0, report)
        self.assertEqual(report["inputs"]["inventory"]["sha256"], digest)
        self.assertFalse(report["libraryWritten"])
        self.assertEqual(report["sourceVerification"], "declared-only")
        return {b["id"]: b for b in report["books"]}

    def failure(self, data, message):
        code, report, _ = self.plan(data)
        self.assertNotEqual(code, 0, report)
        self.assertEqual(report["code"], "NAMING_INPUT")
        self.assertIn(message, report["message"])

    def test_official_main_and_subseries_names_preserve_title_text(self):
        data = inventory(book("m1", "1"), book("m2", "2"),
                         book("s1", kind="side-story", title="幸福的櫻色龍捲風", subseries={"name": "SPIN OFF", "number": "1", "evidence": ["Official independent subseries."]}),
                         book("s2", kind="short-story-collection", title="秋高虎肥", subseries={"name": "SPIN OFF", "number": "2", "evidence": ["Official independent subseries."]}), name="TIGER×DRAGON")
        out = self.success(data)
        self.assertEqual([b["filenameStem"] for b in out.values()], [
            "TIGER×DRAGON (01)", "TIGER×DRAGON (02)",
            "TIGER×DRAGON SPIN OFF (01) 幸福的櫻色龍捲風", "TIGER×DRAGON SPIN OFF (02) 秋高虎肥"])
        self.assertEqual(out["s1"]["officialMetadata"], {"title": out["s1"]["filenameStem"], "series": "TIGER×DRAGON SPIN OFF", "position": "1"})

    def test_documented_inventory_matches_helper_contract(self):
        example = json.loads((ROOT / "skills/quillbind/references/naming-example.json").read_text())
        out = self.success(example)
        self.assertEqual(out["extra-1"]["filenameStem"], "某系列 (06.5-01) 外傳第一卷")
        self.assertEqual(out["extra-2"]["filenameStem"], "某系列 (06.5-02) 外傳第二卷")

    def test_official_subseries_requires_one_consistent_name(self):
        data = inventory(book("s1", kind="side-story", subseries={"name": "SPIN OFF", "number": "1", "evidence": ["Official subseries."]}),
                         book("s2", kind="side-story", subseries={"name": "Spin Off", "number": "2", "evidence": ["Same official subseries."]}))
        self.failure(data, "consistent subseries")

    def test_unified_number_wins_and_never_adds_work_type_to_main_series(self):
        b = book("extra", "11", kind="side-story", title="SIDE ARMS：原書名  II！", subseries={"name": "SIDE ARMS", "number": "1", "evidence": ["Older alternate classification."]})
        out = self.success(inventory(b))["extra"]
        self.assertEqual(out["filenameStem"], "某系列 (11) SIDE ARMS：原書名  II！")
        self.assertEqual(out["basis"], "official-unified")
        self.assertEqual(out["officialMetadata"]["position"], "11")

    def test_single_insertion_and_post_final_extra_are_local_only(self):
        out = self.success(inventory(book("m6", "6", date="2006"), book("extra", kind="extra", date="2007", title="番外篇")))
        self.assertEqual(out["extra"]["filenameStem"], "某系列 (06.5) 番外篇")
        self.assertIsNone(out["extra"]["officialMetadata"])
        self.assertEqual(out["extra"]["anchor"], "m6")
        self.assertEqual(out["extra"]["originalTitle"], "原書名 extra")

    def test_multiple_insertions_follow_first_publication_not_input_order(self):
        data = inventory(book("m7", "7", date="2010"), book("e2", kind="extra", date="2009", title="外傳第二卷"),
                         book("m6", "6", date="2006"), book("e1", kind="side-story", date="2008", title="外傳第一卷"))
        out = self.success(data)
        self.assertEqual(out["e1"]["filenameStem"], "某系列 (06.5-01) 外傳第一卷")
        self.assertEqual(out["e2"]["filenameStem"], "某系列 (06.5-02) 外傳第二卷")
        self.assertEqual(out["e1"]["sortKey"], ["某系列", "6", "5", 1])
        self.assertTrue(all(out[x]["officialMetadata"] is None for x in ("e1", "e2")))
        data["books"].reverse()
        again = self.success(data)
        self.assertEqual({k: v["filenameStem"] for k, v in out.items()}, {k: v["filenameStem"] for k, v in again.items()})

    def test_requires_complete_inventory_and_evidenced_chronology(self):
        data = inventory(book("m6", "6", date="2006"), book("e", kind="extra", date="2007"))
        data["coverage"]["extrasComplete"] = False
        self.failure(data, "complete")
        data["coverage"]["extrasComplete"] = True
        data["books"][1]["firstPublished"] = "2006"
        self.failure(data, "chronology")
        data["chronology"] = {"order": ["m6", "e"], "evidence": ["Publisher confirms the main volume preceded the same-year extra."]}
        self.assertEqual(self.success(data)["e"]["label"], "06.5")
        data["books"][1]["firstPublished"] = "2005"
        self.failure(data, "contradicts")

    def test_refuses_mixed_editions_duplicate_positions_and_unsupported_numbers(self):
        data = inventory(book("m1", "1"), book("m2", "2"))
        data["books"][1]["edition"] = "另一版"
        self.failure(data, "edition")
        data["books"][1]["edition"] = "台灣選定版"
        data["books"][1]["official"]["unified"]["number"] = "1"
        self.failure(data, "collision")
        for value in ("II", "二", "２", "06.5-01", "1.2.3", "1-2"):
            with self.subTest(value=value):
                data["books"][1]["official"]["unified"]["number"] = value
                self.failure(data, "Arabic")

    def test_reference_only_extras_still_determine_whole_series_suffixes(self):
        main = book("m6", "6", date="2006")
        other = book("e1", kind="extra", date="2007")
        main["source"] = other["source"] = None
        out = self.success(inventory(main, other, book("e2", kind="extra", date="2008")))
        self.assertEqual(list(out), ["e2"])
        self.assertEqual(out["e2"]["label"], "06.5-02")

    def test_local_chronology_does_not_require_irrelevant_subseries_dates(self):
        data = inventory(book("m6", "6", date="2006"), book("e", kind="extra", date="2006"),
                         book("sub", kind="side-story", subseries={"name": "SPIN OFF", "number": "1", "evidence": ["Official independent numbering."]}))
        data["chronology"] = {"order": ["m6", "e"], "evidence": ["Bibliography orders the main volume before the unnumbered extra."]}
        out = self.success(data)
        self.assertEqual(out["e"]["label"], "06.5")
        self.assertEqual(out["sub"]["label"], "01")

    def test_multiple_anchor_groups_and_natural_numeric_order(self):
        data = inventory(book("m100", "100", date="2012"), book("m9", "9", date="2009"),
                         book("e10", kind="extra", date="2011"), book("m10", "10", date="2010"),
                         book("e9", kind="short-story-collection", date="2009-06"))
        data["books"][1]["firstPublished"] = "2009-01"
        code, report, _ = self.plan(data)
        self.assertEqual(code, 0, report)
        self.assertEqual(report["order"], ["m9", "e9", "m10", "e10", "m100"])
        out = {b["id"]: b for b in report["books"]}
        self.assertEqual(out["m100"]["filenameStem"], "某系列 (100)")
        self.assertEqual(out["e9"]["label"], "09.5")
        self.assertEqual(out["e10"]["label"], "10.5")

    def test_official_fraction_is_distinct_from_a_local_insertion(self):
        out = self.success(inventory(book("official", "06.50", kind="extra")))["official"]
        self.assertEqual(out["label"], "06.5")
        self.assertEqual(out["officialMetadata"]["position"], "6.5")
        data = inventory(book("m6", "6", date="2006"), book("e", kind="extra", date="2007"),
                         book("official", "6.5", kind="extra"))
        self.failure(data, "collision")

    def test_refuses_unanchored_unknown_or_invalid_publication_order(self):
        data = inventory(book("m6", "6", date="2006"), book("e", kind="extra", date="2005"))
        self.failure(data, "preceding")
        data["books"][1]["firstPublished"] = None
        self.failure(data, "chronology")
        data["chronology"] = {"order": ["m6", "e"], "evidence": ["Bibliography explicitly orders these first publications, dates are unavailable."]}
        self.assertEqual(self.success(data)["e"]["label"], "06.5")
        data["chronology"]["order"] = ["m6", "m6"]
        self.failure(data, "exactly once")
        data["chronology"] = None
        for value in ("2007-02-29", "2007-13", "0000", "07", "2007-1-1"):
            with self.subTest(date=value):
                data["books"][1]["firstPublished"] = value
                self.failure(data, "date")

    def test_preserves_unicode_and_requires_supported_filename_components(self):
        original = "Cafe\u0301：『外傳』 II  +  III！"
        out = self.success(inventory(book("m", "01", title=original)))["m"]
        self.assertEqual(out["filenameStem"], "某系列 (01) " + original)
        self.assertEqual(out["officialMetadata"]["position"], "1")
        data = inventory(book("m", "1", title="甲/乙"))
        self.failure(data, "separator")
        data["books"][0]["volumeTitle"] = " 尾部空白 "
        self.failure(data, "whitespace")

    def test_requires_official_evidence_and_rejects_unknown_or_unsafe_input_shapes(self):
        base = inventory(book("m", "1"))
        cases = [
            (lambda d: d["books"][0]["official"]["unified"].update(evidence=[]), "Evidence"),
            (lambda d: d["books"][0].update(edition=""), "edition"),
            (lambda d: d["books"][0]["source"].update(sha256=["a" * 64]), "SHA-256"),
            (lambda d: d["books"][0]["source"].update(path="relative.epub"), "absolute"),
            (lambda d: d["books"][0].update(renamingOverride="invented"), "fields"),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                data = deepcopy(base)
                mutate(data)
                self.failure(data, message)
        extra = inventory(book("m", "1", date="2000"), book("e", kind="extra", date="2001"))
        extra["books"][1]["official"]["unavailableEvidence"] = []
        self.failure(extra, "Evidence")


class InstalledNamingTests(SkillInstallationTestCase):
    def test_installed_helper_is_read_only_and_refuses_report_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            installed = self.install_skill(root, "quillbind")
            data = root / "input.json"
            data.write_text(json.dumps(inventory(book("m1", "1"))))
            output = root / "plan.json"
            args = ["node", str(installed / "scripts/naming.mjs"), "plan", "--input", str(data), "--output", str(output)]
            result = subprocess.run(args, cwd=root, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            before = output.read_bytes()
            second = subprocess.run(args, cwd=root, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual(json.loads(second.stdout)["code"], "OUTPUT_EXISTS")
            self.assertEqual(output.read_bytes(), before)
            alias = root / "alias.json"
            alias.symlink_to(data)
            original = data.read_bytes()
            third = subprocess.run(args[:-1] + [str(alias)], cwd=root, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(third.returncode, 0)
            self.assertEqual(data.read_bytes(), original)
