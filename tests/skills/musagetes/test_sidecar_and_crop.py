from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "skills/musagetes/scripts"))
import library_guard as guard
import music_rules as rules


def encode_image(width: int, height: int, fmt: str = "PNG", **save_kwargs) -> bytes:
    buf = io.BytesIO()
    mode = "RGBA" if fmt == "PNG" else "RGB"
    color = (40, 80, 120, 255) if mode == "RGBA" else (40, 80, 120)
    Image.new(mode, (width, height), color).save(buf, format=fmt, **save_kwargs)
    return buf.getvalue()


class SidecarPolicyTableTests(unittest.TestCase):
    def setUp(self):
        self.references = Path(rules.__file__).resolve().parents[1] / "references"
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def rewritten_delivery(self, old: str, new: str) -> Path:
        text = (self.references / "delivery.md").read_text(encoding="utf-8")
        self.assertIn(old, text)
        path = self.directory / "delivery.md"
        path.write_text(text.replace(old, new, 1), encoding="utf-8")
        return path

    def test_documented_sidecar_policy_parses_cleanly(self):
        policy = rules.read_sidecar_policy()
        self.assertEqual(set(policy.rules), {"cue", "playlist", "scan_image", "companion_text", "video_disc_media"})
        for ext in (".cue", ".m3u", ".m3u8", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".bmp", ".gif",
                    ".log", ".txt", ".nfo", ".md5", ".sfv", ".accurip",
                    ".iso", ".mds", ".mdf", ".vob", ".ifo", ".bup", ".bdmv", ".clpi", ".mpls", ".m2ts",
                    ".mp4", ".mkv", ".avi", ".mov", ".m4v", ".ts", ".wmv"):
            rule = policy.lookup(ext)
            self.assertIsNotNone(rule, ext)
            assert rule is not None
            self.assertEqual(rule.when_online_verified, "clean")
            self.assertEqual(rule.when_online_incomplete, "preserve")
        self.assertIsNone(policy.lookup(".flac"))
        self.assertIsNone(policy.lookup(".rar"))

    def test_sidecar_extension_added_to_table_is_executed_immediately(self):
        path = self.rewritten_delivery("| `playlist` | `.m3u, .m3u8` |", "| `playlist` | `.m3u, .m3u8, .pls` |")
        updated = rules.read_sidecar_policy(path)
        self.assertEqual(updated.lookup(".pls").category, "playlist")
        self.assertIsNone(rules.read_sidecar_policy().lookup(".pls"))

    def test_malformed_or_overlapping_sidecar_policy_fails_closed(self):
        cases = {
            "duplicate extension": ("| `playlist` | `.m3u, .m3u8` |", "| `playlist` | `.m3u, .cue` |"),
            "invalid action": ("| `cue` | `.cue` | `clean` | `preserve` |", "| `cue` | `.cue` | `delete` | `preserve` |"),
            "missing category": ("| `cue` | `.cue` | `clean` | `preserve` |", ""),
        }
        for label, (old, new) in cases.items():
            with self.subTest(case=label):
                path = self.rewritten_delivery(old, new)
                with self.assertRaises(rules.RuleError) as ctx:
                    rules.read_sidecar_policy(path)
                self.assertEqual(ctx.exception.issue["code"], "INVALID_SIDECAR_POLICY")


class CoverCropPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_crop_preflight_validates_panel_extract_without_mutating_scan(self):
        spread = self.root / "booklet_spread.png"
        spread.write_bytes(encode_image(2000, 1000, "PNG"))
        before = spread.read_bytes()

        full = rules.inspect_cover(spread)
        self.assertFalse(full["ok"])
        self.assertEqual(full["issues"], [{"code": "COVER_RATIO_EXCEEDED"}])

        cropped = rules.inspect_cover(spread, crop=(1000, 0, 2000, 1000))
        self.assertTrue(cropped["ok"], cropped)
        self.assertEqual((cropped["source_width"], cropped["source_height"]), (2000, 1000))
        self.assertEqual(cropped["crop_box"], [1000, 0, 2000, 1000])
        self.assertEqual((cropped["width"], cropped["height"], cropped["pixels"]), (1000, 1000, 1_000_000))
        self.assertTrue(cropped["full_decode_verified"])
        self.assertEqual(spread.read_bytes(), before)

    def test_crop_coordinates_apply_after_exif_orientation(self):
        exif = Image.Exif()
        exif[0x0112] = 6  # Rotate 90 CW: stored 1000x2000 -> displayed 2000x1000
        scan = self.root / "rotated_spread.jpg"
        scan.write_bytes(encode_image(1000, 2000, "JPEG", exif=exif.tobytes()))
        cropped = rules.inspect_cover(scan, crop=(1000, 0, 2000, 1000))
        self.assertTrue(cropped["ok"], cropped)
        self.assertEqual((cropped["source_width"], cropped["source_height"]), (2000, 1000))
        self.assertEqual((cropped["width"], cropped["height"]), (1000, 1000))

    def test_invalid_and_ratio_exceeding_crops_fail_loudly(self):
        spread = self.root / "spread.png"
        spread.write_bytes(encode_image(2000, 1000, "PNG"))
        wide_crop = rules.inspect_cover(spread, crop=(0, 0, 1401, 1000))
        self.assertFalse(wide_crop["ok"])
        self.assertEqual(wide_crop["issues"], [{"code": "COVER_RATIO_EXCEEDED"}])

        for bad_box in [(-1, 0, 100, 100), (100, 0, 100, 100), (200, 0, 100, 100), (0, 0, 2001, 1000), (0, 0, 1000, 1001)]:
            with self.subTest(crop=bad_box), self.assertRaises(rules.RuleError) as ctx:
                rules.inspect_cover(spread, crop=bad_box)
            self.assertEqual(ctx.exception.issue["code"], "INVALID_CROP_BOX")

    def test_cli_cover_info_crop_flags_and_exit_codes(self):
        spread = self.root / "spread.png"
        spread.write_bytes(encode_image(2000, 1000, "PNG"))
        before = spread.read_bytes()

        ok = subprocess.run(
            [sys.executable, "-B", guard.__file__, "cover-info", "--root", str(self.root),
             "--image", "spread.png", "--crop", "1000,0,2000,1000"],
            cwd=self.root, capture_output=True, text=True,
        )
        self.assertEqual(ok.returncode, 0, ok.stderr + ok.stdout)
        payload = json.loads(ok.stdout)
        self.assertEqual(payload["crop_box"], [1000, 0, 2000, 1000])
        self.assertEqual((payload["width"], payload["height"]), (1000, 1000))

        bad_ratio = subprocess.run(
            [sys.executable, "-B", guard.__file__, "cover-info", "--root", str(self.root),
             "--image", "spread.png", "--crop", "0,0,1500,1000"],
            cwd=self.root, capture_output=True, text=True,
        )
        self.assertEqual(bad_ratio.returncode, 1)
        self.assertIn("COVER_RATIO_EXCEEDED", [i["code"] for i in json.loads(bad_ratio.stdout)["issues"]])

        malformed = subprocess.run(
            [sys.executable, "-B", guard.__file__, "cover-info", "--root", str(self.root),
             "--image", "spread.png", "--crop", "bad,box"],
            cwd=self.root, capture_output=True, text=True,
        )
        self.assertEqual(malformed.returncode, 2)
        self.assertEqual(json.loads(malformed.stdout)["issues"][0]["code"], "INVALID_CROP_BOX")
        self.assertEqual(spread.read_bytes(), before)


class CheckSidecarsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.album = self.root / "Album"
        (self.album / "Scans").mkdir(parents=True)
        self.files = {}
        for rel, content in [
            ("Album/disc.cue", b'FILE "disc.wav" WAVE\n'),
            ("Album/playlist.m3u8", b"01.flac\n"),
            ("Album/rip.log", b"EAC log\n"),
            ("Album/notes.txt", b"Tracklist\n"),
            ("Album/Scans/01.jpg", encode_image(40, 40, "JPEG")),
            ("Album/Scans/02.webp", encode_image(40, 40, "WEBP")),
            ("Album/track.flac", b"synthetic audio"),
            ("Album/bonus.iso", b"synthetic dvd"),
            ("Album/bonus.mp4", b"synthetic video"),
            ("Album/uninspected.rar", b"synthetic archive"),
        ]:
            path = self.root / rel
            path.write_bytes(content)
            self.files[rel] = hashlib.sha256(content).hexdigest()

    def make_plan(self, paths, action="clean", *, online_meta=True, online_cover=True, cover_source="online"):
        return {
            "schema_version": 1,
            "album_id": "album-001",
            "online_metadata_verified": online_meta,
            "online_cover_verified": online_cover,
            "cover_source": cover_source,
            "entries": [{"path": p, "sha256": self.files[p], "action": action} for p in paths],
        }

    def test_online_verified_allows_cleaning_cue_m3u8_scans_text_and_video_disc_media(self):
        sidecars = ["Album/disc.cue", "Album/playlist.m3u8", "Album/rip.log", "Album/notes.txt",
                    "Album/Scans/01.jpg", "Album/Scans/02.webp", "Album/bonus.iso", "Album/bonus.mp4"]
        plan = self.make_plan(sidecars, "clean")
        res = guard.check_sidecars(self.root, plan)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["scope"], "sidecar_cleanup_policy_only")
        self.assertTrue(res["online_cover_and_metadata_verified"])
        self.assertEqual(len(res["entries"]), len(sidecars))
        by_path = {e["path"]: e for e in res["entries"]}
        self.assertEqual(by_path["Album/bonus.iso"]["category"], "video_disc_media")
        self.assertEqual(by_path["Album/bonus.mp4"]["category"], "video_disc_media")
        # Explicit preserve remains allowed even when online cover & metadata are verified.
        pres = guard.check_sidecars(self.root, self.make_plan(sidecars, "preserve"))
        self.assertTrue(pres["ok"], pres)

    def test_missing_online_cover_or_local_scan_fallback_blocks_sidecar_cleanup(self):
        sidecars = ["Album/disc.cue", "Album/playlist.m3u8", "Album/notes.txt", "Album/Scans/01.jpg"]
        for cover_source, online_meta, online_cover in [
            ("local_scan_crop", True, False),
            ("local_scan_front", True, False),
            ("missing", True, False),
            ("online", False, True),
            ("embedded", True, False),
        ]:
            with self.subTest(cover_source=cover_source, online_meta=online_meta, online_cover=online_cover):
                clean_res = guard.check_sidecars(
                    self.root,
                    self.make_plan(sidecars, "clean", online_meta=online_meta, online_cover=online_cover, cover_source=cover_source),
                )
                self.assertFalse(clean_res["ok"])
                codes = [i["code"] for i in clean_res["issues"]]
                self.assertEqual(codes.count("SIDECAR_CLEANUP_BLOCKED"), len(sidecars))

                preserve_res = guard.check_sidecars(
                    self.root,
                    self.make_plan(sidecars, "preserve", online_meta=online_meta, online_cover=online_cover, cover_source=cover_source),
                )
                self.assertTrue(preserve_res["ok"], preserve_res)

    def test_claiming_online_cover_verified_with_local_scan_source_is_rejected(self):
        plan = self.make_plan(["Album/Scans/01.jpg"], "clean", online_meta=True, online_cover=True, cover_source="local_scan_crop")
        res = guard.check_sidecars(self.root, plan)
        self.assertFalse(res["ok"])
        self.assertIn("INCONSISTENT_COVER_SOURCE", [i["code"] for i in res["issues"]])

    def test_audio_archive_symlinks_state_and_changed_files_are_rejected(self):
        for non_sidecar in ["Album/track.flac", "Album/uninspected.rar"]:
            with self.subTest(path=non_sidecar):
                res = guard.check_sidecars(self.root, self.make_plan([non_sidecar], "clean"))
                self.assertFalse(res["ok"])
                self.assertIn("UNSUPPORTED_SIDECAR_EXTENSION", [i["code"] for i in res["issues"]])

        link = self.album / "link.cue"
        link.symlink_to(self.album / "disc.cue")
        self.files["Album/link.cue"] = self.files["Album/disc.cue"]
        link_res = guard.check_sidecars(self.root, self.make_plan(["Album/link.cue"], "clean"))
        self.assertFalse(link_res["ok"])
        self.assertIn("SYMLINK", [i["code"] for i in link_res["issues"]])

        state_file = self.root / ".musagetes/note.txt"
        state_file.parent.mkdir()
        state_file.write_bytes(b"state")
        self.files[".musagetes/note.txt"] = hashlib.sha256(b"state").hexdigest()
        state_res = guard.check_sidecars(self.root, self.make_plan([".musagetes/note.txt"], "clean"))
        self.assertFalse(state_res["ok"])
        self.assertIn("PROTECTED_STATE", [i["code"] for i in state_res["issues"]])

        (self.root / "Album/notes.txt").write_bytes(b"mutated")
        changed_res = guard.check_sidecars(self.root, self.make_plan(["Album/notes.txt"], "clean"))
        self.assertFalse(changed_res["ok"])
        self.assertIn("SOURCE_CHANGED", [i["code"] for i in changed_res["issues"]])

        escape_plan = self.make_plan(["Album/disc.cue"], "clean")
        escape_plan["entries"].append({"path": "../outside.cue", "sha256": self.files["Album/disc.cue"], "action": "clean"})
        escape_res = guard.check_sidecars(self.root, escape_plan)
        self.assertFalse(escape_res["ok"])
        self.assertIn("PATH_ESCAPE", [i["code"] for i in escape_res["issues"]])

        dup_res = guard.check_sidecars(self.root, self.make_plan(["Album/disc.cue", "Album/disc.cue"], "clean"))
        self.assertFalse(dup_res["ok"])
        self.assertIn("DUPLICATE_SIDECAR_ENTRY", [i["code"] for i in dup_res["issues"]])

    def test_cli_check_sidecars_stdin_and_read_only(self):
        before = (self.root / "Album/disc.cue").read_bytes()
        plan = self.make_plan(["Album/disc.cue", "Album/Scans/01.jpg"], "clean")
        proc = subprocess.run(
            [sys.executable, "-B", guard.__file__, "check-sidecars", "--root", str(self.root), "--input", "-"],
            input=json.dumps(plan), cwd=self.root, capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        self.assertTrue(json.loads(proc.stdout)["ok"])
        self.assertEqual((self.root / "Album/disc.cue").read_bytes(), before)

        blocked_plan = self.make_plan(["Album/disc.cue"], "clean", online_meta=True, online_cover=False, cover_source="local_scan_crop")
        blocked = subprocess.run(
            [sys.executable, "-B", guard.__file__, "check-sidecars", "--root", str(self.root), "--input", "-"],
            input=json.dumps(blocked_plan), cwd=self.root, capture_output=True, text=True,
        )
        self.assertEqual(blocked.returncode, 1)
        self.assertIn("SIDECAR_CLEANUP_BLOCKED", [i["code"] for i in json.loads(blocked.stdout)["issues"]])


if __name__ == "__main__":
    unittest.main()
