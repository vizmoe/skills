from pathlib import Path
import json
import subprocess
import sys
import tempfile

from tests.support import SkillInstallationTestCase


class MusagetesInstallationTests(SkillInstallationTestCase):
    def test_musagetes_installs_and_scans_without_repository_state(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            installed = self.install_skill(project, "musagetes")
            self.assertTrue((installed / "LICENSE").is_file())
            library = project / "music"
            library.mkdir()
            track = library / "track.wav"
            track.write_bytes(b"synthetic audio inventory fixture")
            result = subprocess.run(
                [sys.executable, "-B", str(installed / "scripts/library_guard.py"),
                 "inventory", "--root", str(library), "--hash"],
                cwd=library, text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('"audio_candidate"', result.stdout)
            self.assertEqual(list(library.iterdir()), [track])
            self.assertEqual(track.read_bytes(), b"synthetic audio inventory fixture")
            self.assertFalse(list(installed.rglob("__pycache__")))
            # history parses the status vocabulary from the bundled references at run time.
            recorded = subprocess.run(
                [sys.executable, "-B", str(installed / "scripts/library_guard.py"),
                 "history", "--root", str(library)],
                cwd=library, text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(recorded.returncode, 0, recorded.stderr)
            self.assertEqual(json.loads(recorded.stdout)["scope"], "recorded_files_only")
            self.assertEqual(list(library.iterdir()), [track])
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
            original = {"path": "track.wav", "sha256": json.loads(result.stdout)["files"][0]["sha256"]}
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
            self.assertEqual(list(library.iterdir()), [track])
            self.assertFalse(list(installed.rglob("__pycache__")))
