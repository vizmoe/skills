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
