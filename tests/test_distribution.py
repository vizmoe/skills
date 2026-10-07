"""Exercise the public skills installer in a temporary project, never globally."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SKILLS_CLI = "skills@1.7.1"


class DistributionTests(unittest.TestCase):
    def test_musagetes_installs_and_scans_without_repository_state(self):
        source = ROOT / "skills/musagetes"
        self.assertTrue((source / "SKILL.md").is_file(), "Missing standard skill directory")
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            result = subprocess.run(
                ["npx", "--yes", SKILLS_CLI, "add", str(ROOT), "--skill", "musagetes",
                 "--agent", "codex", "--copy", "--yes"],
                cwd=project, env={**os.environ, "DISABLE_TELEMETRY": "1", "CI": "1"},
                text=True, capture_output=True, timeout=120,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            installed = project / ".agents/skills/musagetes"
            expected = {p.relative_to(source) for p in source.rglob("*") if p.is_file()}
            actual = {p.relative_to(installed) for p in installed.rglob("*") if p.is_file()}
            self.assertEqual(actual, expected)
            for relative in expected:
                self.assertEqual((installed / relative).read_bytes(), (source / relative).read_bytes(), str(relative))
            self.assertIn(Path("LICENSE"), actual)
            for name in (".git", "work", "tests", "dist", "AGENTS.md", "README.md"):
                self.assertFalse((installed / name).exists(), name)
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


if __name__ == "__main__":
    unittest.main()
