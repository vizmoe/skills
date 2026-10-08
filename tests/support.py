"""Real skills CLI installation into disposable projects."""
from pathlib import Path
import os
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SKILLS_CLI = "skills@1.7.1"


class SkillInstallationTestCase(unittest.TestCase):
    def install_skill(self, project: Path, name: str, catalog: Path = ROOT) -> Path:
        source = catalog / "skills" / name
        project.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["npx", "--yes", SKILLS_CLI, "add", str(catalog), "--skill", name,
             "--agent", "codex", "--copy", "--yes"],
            cwd=project, env={**os.environ, "DISABLE_TELEMETRY": "1", "CI": "1"},
            text=True, capture_output=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        installed = project / ".agents/skills" / name
        self.assertEqual((installed / "LICENSE").read_bytes(), (catalog / "LICENSE").read_bytes())
        expected = {p.relative_to(source) for p in source.rglob("*") if p.is_file()}
        actual = {p.relative_to(installed) for p in installed.rglob("*") if p.is_file()}
        self.assertEqual(actual, expected)
        for relative in expected:
            self.assertEqual((installed / relative).read_bytes(), (source / relative).read_bytes(), str(relative))
        for forbidden in (".git", "work", "tests", "evals", "dist", "AGENTS.md", "node_modules"):
            self.assertFalse((installed / forbidden).exists(), forbidden)
        return installed
