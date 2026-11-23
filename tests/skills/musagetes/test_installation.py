from pathlib import Path
import io
import json
import subprocess
import sys
import tempfile
import wave

from PIL import Image

from tests.support import SkillInstallationTestCase


class MusagetesInstallationTests(SkillInstallationTestCase):
    def test_musagetes_installs_and_scans_without_repository_state(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            installed = self.install_skill(project, "musagetes")
            self.assertTrue((installed / "LICENSE").is_file())
            self.assertTrue((installed / "requirements.txt").is_file())
            library = project / "music"
            library.mkdir()
            track = library / "track.wav"
            with wave.open(str(track), "wb") as writer:
                writer.setnchannels(2)
                writer.setsampwidth(2)
                writer.setframerate(44100)
                writer.writeframes(b"\x00\x00\x00\x00" * 441)
            track_bytes = track.read_bytes()
            cover = library / "cover.webp"
            cover_buf = io.BytesIO()
            Image.new("RGB", (120, 100), (30, 60, 90)).save(cover_buf, format="WEBP")
            cover.write_bytes(cover_buf.getvalue())
            cover_bytes = cover.read_bytes()
            result = subprocess.run(
                [sys.executable, "-B", str(installed / "scripts/library_guard.py"),
                 "inventory", "--root", str(library), "--hash"],
                cwd=library, text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('"audio_candidate"', result.stdout)
            self.assertEqual(sorted(library.iterdir()), [cover, track])
            self.assertEqual(track.read_bytes(), track_bytes)
            self.assertFalse(list(installed.rglob("__pycache__")))
            cover_res = subprocess.run(
                [sys.executable, "-B", str(installed / "scripts/library_guard.py"),
                 "cover-info", "--root", str(library), "--image", "cover.webp", "--crop", "0,0,100,100"],
                cwd=library, text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(cover_res.returncode, 0, cover_res.stderr)
            cover_payload = json.loads(cover_res.stdout)
            self.assertTrue(cover_payload["full_decode_verified"])
            self.assertEqual(cover_payload["crop_box"], [0, 0, 100, 100])
            audio_res = subprocess.run(
                [sys.executable, "-B", str(installed / "scripts/library_guard.py"),
                 "audio-info", "--root", str(library), "--audio", "track.wav"],
                cwd=library, text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(audio_res.returncode, 0, audio_res.stderr)
            self.assertEqual(json.loads(audio_res.stdout)["codec"], "pcm")
            # history parses the status vocabulary from the bundled references at run time.
            recorded = subprocess.run(
                [sys.executable, "-B", str(installed / "scripts/library_guard.py"),
                 "history", "--root", str(library)],
                cwd=library, text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(recorded.returncode, 0, recorded.stderr)
            self.assertEqual(json.loads(recorded.stdout)["scope"], "recorded_files_only")
            staging = subprocess.run(
                [sys.executable, "-B", str(installed / "scripts/library_guard.py"),
                 "staging-audit", "--root", str(library)],
                cwd=library, text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(staging.returncode, 0, staging.stderr)
            self.assertEqual(json.loads(staging.stdout)["scope"], "staging_and_temp_residue_only")
            self.assertEqual(sorted(library.iterdir()), [cover, track])
            # Installed scheduling reads its own policy reference, without HTTP or writes.
            throttle = [sys.executable, "-B", str(installed / "scripts/source-throttle.py"), "--input", "-"]
            observation = subprocess.run(throttle, input=json.dumps({
                "operation": "observe", "url": "https://musicbrainz.org/ws/2/release/test",
                "attempt": 1, "now": 1000, "status": 503, "headers": {"Retry-After": "120"}}),
                cwd=library, text=True, capture_output=True, timeout=30)
            self.assertEqual(observation.returncode, 0, observation.stderr)
            decision = json.loads(observation.stdout)
            self.assertEqual(decision["action"], "defer")
            check = subprocess.run(throttle, input=json.dumps({
                "operation": "check", "url": "https://musicbrainz.org/ws/2/artist/other",
                "attempt": 1, "now": 1010, "state": decision["state"]}),
                cwd=library, text=True, capture_output=True, timeout=30)
            self.assertEqual(check.returncode, 0, check.stderr)
            self.assertEqual(json.loads(check.stdout)["not_before"], 1120)
            self.assertEqual(json.loads(check.stdout)["action"], "defer")
            coverage = subprocess.run([sys.executable, "-B", str(installed / "scripts/search-ledger.py"), "--input", "-"],
                input=json.dumps({"routes": [{"id": "variant", "source": "musicbrainz-recording", "required": True, "attempts": []}]}),
                cwd=library, text=True, capture_output=True, timeout=30)
            self.assertEqual(coverage.returncode, 1, coverage.stderr)
            self.assertEqual(json.loads(coverage.stdout)["pending"], ["variant"])
            files_by_path = {f["path"]: f for f in json.loads(result.stdout)["files"]}
            sidecar_check = subprocess.run(
                [sys.executable, "-B", str(installed / "scripts/library_guard.py"),
                 "check-sidecars", "--root", str(library), "--input", "-"],
                input=json.dumps({
                    "schema_version": 1, "album_id": "alb-1",
                    "online_metadata_verified": True, "online_cover_verified": False,
                    "cover_source": "local_scan_crop",
                    "entries": [{"path": "cover.webp", "sha256": files_by_path["cover.webp"]["sha256"], "action": "clean"}],
                }),
                cwd=library, text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(sidecar_check.returncode, 1, sidecar_check.stderr)
            self.assertIn("SIDECAR_CLEANUP_BLOCKED", [i["code"] for i in json.loads(sidecar_check.stdout)["issues"]])
            original = {"path": "track.wav", "sha256": files_by_path["track.wav"]["sha256"]}
            cleanup = subprocess.run([sys.executable, "-B", str(installed / "scripts/cleanup-audit.py"),
                "--root", str(library), "--input", "-"], input=json.dumps({"schema_version": 1,
                "originals": [original], "entries": [{"id": "original", "role": "review", "source": original,
                "quarantine": ".musagetes/quarantine/track.wav", "outputs": [original], "reason": "invalid role claim",
                "stage": "prepared", "equivalence": {"method": "bytes"}, "audit": None}]}),
                cwd=library, text=True, capture_output=True, timeout=30)
            self.assertEqual(cleanup.returncode, 1, cleanup.stderr)
            self.assertFalse(json.loads(cleanup.stdout)["ok"])
            report = subprocess.run([sys.executable, "-B", str(installed / "scripts/report-audit.py"),
                "--root", str(library), "--input", "-"], input=json.dumps({
                "files": [{"id": "track", "group": "g", **original, "kind": "audio", "match_status": "UNCONFIRMED"}],
                "groups": [{"id": "g", "cover": "unknown"}], "publications": [], "cleanups": [], "cues": []}),
                cwd=library, text=True, capture_output=True, timeout=30)
            self.assertEqual(report.returncode, 0, report.stderr)
            self.assertEqual(json.loads(report.stdout)["counts"]["unidentified_audio"], 1)
            self.assertEqual(sorted(library.iterdir()), [cover, track])
            self.assertEqual(cover.read_bytes(), cover_bytes)
            self.assertFalse(list(installed.rglob("__pycache__")))
