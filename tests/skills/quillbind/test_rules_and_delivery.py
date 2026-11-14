"""Reference-parsed rule tables and read-only delivery/naming verification helpers."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from tests.support import ROOT, SkillInstallationTestCase

SKILL = ROOT / "skills/quillbind"
DELIVERY = SKILL / "scripts/delivery-audit.mjs"
NAMING = SKILL / "scripts/naming.mjs"
RULES = SKILL / "scripts/skill-rules.mjs"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ReferenceRuleParserTests(unittest.TestCase):
    def eval_rules(self, references_dir: Path):
        code = (
            f"import * as mod from {json.dumps(RULES.as_uri())};\n"
            f"const dir = {json.dumps(str(references_dir))};\n"
            "try {\n"
            "  const out = {\n"
            "    tags: await mod.readWorkTypeTagRules(dir),\n"
            "    naming: await mod.readNamingRules(dir),\n"
            "    bibliography: await mod.readBibliographyRules(dir),\n"
            "    delivery: await mod.readDeliveryRules(dir),\n"
            "  };\n"
            "  console.log(JSON.stringify({ ok: true, out }));\n"
            "} catch (err) {\n"
            "  console.log(JSON.stringify({ ok: false, code: err.code, message: err.message }));\n"
            "  process.exitCode = 1;\n"
            "}\n"
        )
        res = subprocess.run(
            ["node", "--input-type=module", "-e", code],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return res.returncode, json.loads(res.stdout)

    def test_parses_all_reference_rule_tables_and_detects_mutations(self):
        rc, payload = self.eval_rules(SKILL / "references")
        self.assertEqual(rc, 0, payload)
        out = payload["out"]
        self.assertEqual(
            out["tags"]["light-novel"],
            {"required": "Literature.Light Novel", "forbidden": ["Literature.Manga"]},
        )
        self.assertEqual(
            out["tags"]["art-book"],
            {
                "forbidden": ["Literature.Light Novel", "Literature.Manga"],
                "requiresPrefix": "Arts.",
            },
        )
        self.assertEqual(
            out["naming"]["kinds"],
            ["main", "side-story", "short-story-collection", "extra"],
        )
        self.assertEqual(
            out["naming"]["bases"],
            ["official-unified", "official-subseries", "local-insertion"],
        )
        self.assertTrue(out["bibliography"]["isbnDispositions"]["unresolved"]["requiresAttemptedSources"])
        self.assertTrue(out["bibliography"]["editionClasses"]["self-made"]["requiresIdentification"])
        self.assertTrue(out["delivery"]["statuses"]["completed"]["filesWritten"])
        self.assertFalse(out["delivery"]["statuses"]["plan-only"]["filesWritten"])

        with tempfile.TemporaryDirectory() as tmp:
            copied = Path(tmp) / "references"
            shutil.copytree(SKILL / "references", copied)
            tags_md = copied / "tags.md"
            tags_md.write_text(
                tags_md.read_text(encoding="utf-8").replace("| `manga` |", "| `comic-strip` |"),
                encoding="utf-8",
            )
            bad_rc, bad_payload = self.eval_rules(copied)
            self.assertNotEqual(bad_rc, 0)
            self.assertEqual(bad_payload["code"], "RULE_TABLE_INVALID")


class DeliveryAuditHelperTests(unittest.TestCase):
    def run_cli(self, *args, script=DELIVERY, cwd=None):
        res = subprocess.run(
            ["node", str(script), *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        body = res.stdout.strip() or res.stderr.strip()
        return res.returncode, json.loads(body)

    def test_snapshot_protects_calibre_sidecars_with_stat_only_for_metadata_db(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            library_dir = root / "Library"
            book_dir = library_dir / "Author Name" / "Book Title (1)"
            book_dir.mkdir(parents=True)

            # Synthetic placeholder bytes; delivery-audit must stat metadata.db without reading it.
            db_file = library_dir / "metadata.db"
            db_file.write_bytes(b"synthetic-calibre-db-placeholder")
            opf_file = book_dir / "metadata.opf"
            opf_file.write_text("<package/>", encoding="utf-8")
            cover_file = book_dir / "cover.jpg"
            cover_file.write_bytes(b"\xff\xd8\xff\xd9")
            book_file = book_dir / "book.epub"
            book_bytes = b"synthetic-epub-archive"
            book_file.write_bytes(book_bytes)

            snap_path = root / "before.json"
            rc, snap = self.run_cli("snapshot", "--path", str(book_file), "--output", str(snap_path))
            self.assertEqual(rc, 0, snap)
            by_path = {entry["path"]: entry for entry in snap["entries"]}
            self.assertEqual(by_path[str(db_file.resolve())]["inspection"], "stat-only")
            self.assertNotIn("sha256", by_path[str(db_file.resolve())]["state"])
            self.assertEqual(
                by_path[str(opf_file.resolve())]["state"]["sha256"],
                sha256_bytes(b"<package/>"),
            )

            # Clean completed report passes
            out_file = root / "out.epub"
            out_bytes = b"verified-staged-and-final-epub"
            out_file.write_bytes(out_bytes)
            report = {
                "schemaVersion": 1,
                "status": "completed",
                "items": [
                    {
                        "source": {"path": str(book_file), "sha256": sha256_bytes(book_bytes)},
                        "staged": {"path": str(out_file), "sha256": sha256_bytes(out_bytes)},
                        "final": {"path": str(out_file), "sha256": sha256_bytes(out_bytes)},
                        "bookType": "light-novel",
                        "language": "zh-Hans",
                        "editionClass": "self-made",
                        "identificationEvidence": ["Title and colophon match Volume 1."],
                        "isbn": {
                            "disposition": "added",
                            "value": "9780306406157",
                        },
                        "synopsis": {
                            "value": "少年与少女在边境重逢的故事。",
                            "sourceLanguage": "ja",
                            "translationSource": "https://bookwalker.jp/de00000000-0000-4000-8000-000000000001/",
                        },
                    }
                ],
            }
            report_path = root / "report.json"
            report_path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
            rc_ok, audited = self.run_cli("audit", "--input", str(report_path), "--before", str(snap_path))
            self.assertEqual(rc_ok, 0, audited)
            self.assertTrue(audited["ok"])

            # Mutating sidecar metadata.opf fails with CALIBRE_SIDECAR_MODIFIED
            opf_file.write_text("<package modified='yes'/>", encoding="utf-8")
            rc_sidecar, sidecar_audit = self.run_cli("audit", "--input", str(report_path), "--before", str(snap_path))
            self.assertEqual(rc_sidecar, 1)
            self.assertIn("CALIBRE_SIDECAR_MODIFIED", [i["code"] for i in sidecar_audit["issues"]])

    def test_audit_catches_inplace_backup_isbn_edition_and_synopsis_violations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            epub = root / "target.epub"
            epub_bytes = b"updated-inplace-bytes"
            epub.write_bytes(epub_bytes)

            bad_report = {
                "schemaVersion": 1,
                "status": "completed",
                "items": [
                    {
                        "source": {"path": str(epub), "sha256": sha256_bytes(b"original-bytes")},
                        "final": {"path": str(epub), "sha256": sha256_bytes(epub_bytes)},
                        "bookType": "light-novel",
                        "language": "zh-Hans",
                        "editionClass": "self-made",
                        "isbn": {"disposition": "unresolved"},
                        "synopsis": {
                            "value": "自制录入本，未找到 ISBN。物語がはじまる。",
                            "sourceLanguage": "ja",
                        },
                    }
                ],
            }
            report_path = root / "bad-report.json"
            report_path.write_text(json.dumps(bad_report, ensure_ascii=False), encoding="utf-8")
            rc, audited = self.run_cli("audit", "--input", str(report_path))
            self.assertEqual(rc, 1)
            codes = {issue["code"] for issue in audited["issues"]}
            self.assertEqual(
                codes,
                {
                    "BACKUP_REQUIRED_FOR_INPLACE",
                    "MISSING_ISBN_ATTEMPTED_SOURCES",
                    "MISSING_IDENTIFICATION_EVIDENCE",
                    "SYNOPSIS_CONTAINS_PROVENANCE",
                    "MISSING_TRANSLATION_SOURCE",
                    "UNTRANSLATED_JAPANESE_SYNOPSIS",
                },
            )

    def test_verify_naming_checks_real_hashes_and_destination_collisions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vol1 = root / "raw-1.epub"
            vol2 = root / "raw-2.epub"
            vol1.write_bytes(b"volume-1")
            vol2.write_bytes(b"volume-2")
            inv = {
                "schemaVersion": 1,
                "series": {"name": "某系列", "edition": "台版", "evidence": ["Catalog"]},
                "coverage": {"mainComplete": True, "extrasComplete": True, "evidence": ["Complete"]},
                "chronology": None,
                "books": [
                    {
                        "id": "v1",
                        "edition": "台版",
                        "kind": "main",
                        "originalTitle": "某系列 1",
                        "volumeTitle": None,
                        "firstPublished": "2020",
                        "source": {"path": str(vol1), "sha256": sha256_bytes(b"volume-1")},
                        "evidence": ["Vol 1"],
                        "official": {"unified": {"number": "1", "evidence": ["Vol 1"]}, "subseries": None, "unavailableEvidence": []},
                    },
                    {
                        "id": "v2",
                        "edition": "台版",
                        "kind": "main",
                        "originalTitle": "某系列 2",
                        "volumeTitle": None,
                        "firstPublished": "2021",
                        "source": {"path": str(vol2), "sha256": sha256_bytes(b"volume-2")},
                        "evidence": ["Vol 2"],
                        "official": {"unified": {"number": "2", "evidence": ["Vol 2"]}, "subseries": None, "unavailableEvidence": []},
                    },
                ],
            }
            inv_path = root / "inv.json"
            plan_path = root / "plan.json"
            inv_path.write_text(json.dumps(inv, ensure_ascii=False), encoding="utf-8")
            subprocess.run(
                ["node", str(NAMING), "plan", "--input", str(inv_path), "--output", str(plan_path)],
                check=True,
                capture_output=True,
                timeout=30,
            )

            rc_ok, ok_res = self.run_cli("verify-naming", "--plan", str(plan_path))
            self.assertEqual(rc_ok, 0, ok_res)
            self.assertEqual(ok_res["sourceVerification"], "verified-on-disk")

            # Existing destination collision and source hash drift are both caught
            (root / "某系列 (01).epub").write_bytes(b"existing-collision")
            vol2.write_bytes(b"mutated-volume-2")
            rc_bad, bad_res = self.run_cli("verify-naming", "--plan", str(plan_path))
            self.assertEqual(rc_bad, 1)
            self.assertEqual(
                {i["code"] for i in bad_res["issues"]},
                {"DESTINATION_EXISTS", "SOURCE_HASH_MISMATCH"},
            )


class InstalledDeliveryAuditTests(SkillInstallationTestCase):
    def test_installed_delivery_audit_runs_standalone_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            installed = self.install_skill(root, "quillbind")
            helper = installed / "scripts/delivery-audit.mjs"
            book = root / "sample.cbz"
            book.write_bytes(b"cbz-bytes")
            snap = root / "snap.json"
            first = subprocess.run(
                ["node", str(helper), "snapshot", "--path", str(book), "--output", str(snap)],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            second = subprocess.run(
                ["node", str(helper), "snapshot", "--path", str(book), "--output", str(snap)],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(second.returncode, 2)
            self.assertEqual(json.loads(second.stderr)["code"], "OUTPUT_EXISTS")
