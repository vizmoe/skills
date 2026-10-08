from pathlib import Path
import json
import os
import subprocess
import tempfile

from tests.support import SkillInstallationTestCase


class QuillbindInstallationTests(SkillInstallationTestCase):
    def test_quillbind_installs_and_reports_a_missing_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            installed = self.install_skill(project, "quillbind")
            node = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
            env = {**os.environ, "PATH": str(project / "empty-path")}
            env.pop("QUILLBIND_ROOT", None)
            result = subprocess.run(
                [node, str(installed / "scripts/quillbind.mjs"), "version", "--json"],
                cwd=project, env=env, text=True, capture_output=True, timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout)["code"], "ENVIRONMENT_ERROR")
            self.assertIn("QUILLBIND_ROOT", json.loads(result.stdout)["message"])
