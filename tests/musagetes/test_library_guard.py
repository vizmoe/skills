from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "skills/musagetes/scripts"))
import library_guard as guard


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / "original.wav"
        self.source.write_bytes(b"synthetic fixture, not an audio decode test")

    def entry(self, target="album/01.flac", **updates):
        return {"source": "original.wav", "target": target,
                "source_sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
                "operation": "create", **updates}

    def result(self, *entries):
        return guard.check_paths(self.root, {"schema_version": 1, "entries": list(entries)})

    def assert_blocked(self, code, *entries):
        result = self.result(*entries)
        self.assertFalse(result["ok"])
        self.assertIn(code, [issue["code"] for issue in result["issues"]])

    def test_valid_plan_does_not_create_or_modify_files(self):
        before = self.source.read_bytes(), sorted(self.root.iterdir())
        self.assertTrue(self.result(self.entry())["ok"])
        self.assertEqual(before, (self.source.read_bytes(), sorted(self.root.iterdir())))

    def test_existing_source_cannot_be_overwritten(self):
        self.assert_blocked("TARGET_EXISTS", self.entry("original.wav"))

    def test_existing_unrelated_target_is_preserved(self):
        target = self.root / "existing.flac"
        target.write_bytes(b"unrelated")
        self.assert_blocked("TARGET_EXISTS", self.entry(target.name))
        self.assertEqual(target.read_bytes(), b"unrelated")

    def test_existing_directory_is_not_a_file_target(self):
        (self.root / "album").mkdir()
        self.assert_blocked("TARGET_EXISTS", self.entry("album"))

    def test_changed_source_invalidates_snapshot(self):
        entry = self.entry()
        self.source.write_bytes(b"changed")
        self.assert_blocked("SOURCE_CHANGED", entry)

    def test_keep_requires_identical_path(self):
        self.assertTrue(self.result(self.entry("original.wav", operation="keep"))["ok"])
        self.assert_blocked("INVALID_KEEP", self.entry(operation="keep"))

    def test_duplicate_targets_and_case_aliases(self):
        for other in ["album/01.flac", "Album/01.FLAC"]:
            with self.subTest(other=other):
                self.assert_blocked("PLAN_COLLISION", self.entry(), self.entry(other))

    def test_unicode_equivalent_targets(self):
        self.assert_blocked("PLAN_COLLISION", self.entry("Café/a.flac"), self.entry("Cafe\u0301/a.flac"))

    def test_aliased_parent_directories_are_not_silently_merged(self):
        self.assert_blocked("PLAN_ALIAS_COLLISION", self.entry("Album/a.flac"), self.entry("album/b.flac"))

    def test_planned_file_directory_collision_in_both_orders(self):
        for paths in [("album", "album/01.flac"), ("album/01.flac", "album")]:
            with self.subTest(paths=paths):
                self.assert_blocked("PLAN_FILE_DIRECTORY_COLLISION", *(self.entry(p) for p in paths))

    def test_existing_parent_file_blocks_target(self):
        self.assert_blocked("NOT_DIRECTORY", self.entry("original.wav/01.flac"))

    def test_existing_case_alias_blocks_target(self):
        (self.root / "Album").mkdir()
        self.assert_blocked("EXISTING_ALIAS_COLLISION", self.entry("album/01.flac"))

    def test_source_symlinks_inside_and_outside_root_are_not_followed(self):
        for target in [self.source, self.root.parent / "not-owned.wav"]:
            link = self.root / "link.wav"
            link.symlink_to(target)
            try:
                self.assert_blocked("SYMLINK", self.entry(source="link.wav"))
            finally:
                link.unlink()

    def test_target_symlink_and_symlink_ancestor_block(self):
        (self.root / "linked").symlink_to(self.root, target_is_directory=True)
        self.assert_blocked("SYMLINK", self.entry("linked/01.flac"))
        (self.root / "dangling").symlink_to(self.root / "missing")
        self.assert_blocked("SYMLINK", self.entry("dangling"))

    def test_source_symlink_ancestor_blocks(self):
        (self.root / "alias").symlink_to(self.root, target_is_directory=True)
        self.assert_blocked("SYMLINK", self.entry(source="alias/original.wav"))

    def test_hardlinked_source_requires_review(self):
        os.link(self.source, self.root / "second.wav")
        self.assert_blocked("HARDLINK", self.entry())

    def test_path_escape_variants(self):
        for path in ["../outside", "/absolute", "C:/outside", "a/../b", "a//b", "./a", "a\\..\\b"]:
            with self.subTest(path=path):
                self.assert_blocked("PATH_ESCAPE", self.entry(path))

    def test_invalid_and_reserved_names(self):
        for path in ["Album:Title/a.flac", "album/CON.flac", "album/a?.flac", "album/a. ", "album/a..", "album/a\x01.flac", "album/a  b.flac"]:
            with self.subTest(path=path):
                self.assert_blocked("INVALID_TARGET_NAME", self.entry(path))

    def test_long_utf8_names_block_without_truncation(self):
        self.assert_blocked("NAME_TOO_LONG", self.entry("曲" * 200 + ".flac"))

    def test_single_source_can_split_to_multiple_distinct_targets(self):
        self.assertTrue(self.result(self.entry("album/01.flac"), self.entry("album/02.flac"))["ok"])

    def test_inventory_leaves_links_and_unknown_formats_unclassified(self):
        (self.root / "loop").symlink_to(self.root, target_is_directory=True)
        (self.root / "outside").symlink_to(self.root.parent, target_is_directory=True)
        before = sorted(self.root.iterdir())
        result = guard.inventory(self.root, True)
        self.assertTrue(result["ok"])
        files = {r["path"]: r for r in result["files"]}
        self.assertEqual(files["loop"]["kind"], "symlink")
        self.assertEqual(files["outside"]["disposition"], "SKIPPED")
        self.assertEqual(files["original.wav"]["hint"], "audio_candidate")
        self.assertEqual(files["original.wav"]["sha256"], self.entry()["source_sha256"])
        self.assertEqual(before, sorted(self.root.iterdir()))
        self.assertEqual(len(files), 3)

    def test_bad_schema_is_input_error(self):
        for plan in [{}, {"schema_version": True, "entries": [self.entry()]}, {"schema_version": 1, "entries": []}, {"schema_version": 1, "entries": [self.entry(operation="delete")]}]:
            with self.subTest(plan=plan), self.assertRaises(guard.GuardError):
                guard.check_paths(self.root, plan)

    def test_state_sources_targets_and_keep_are_protected(self):
        for target in ['.musagetes/track.flac', '.MUSAGETES/track.flac']:
            self.assert_blocked('PROTECTED_STATE', self.entry(target))
        state = self.root / '.musagetes/staging.wav'
        state.parent.mkdir()
        state.write_bytes(b'intermediate')
        self.assert_blocked('PROTECTED_STATE', self.entry(source='.musagetes/staging.wav'))
        self.assert_blocked('PROTECTED_STATE', self.entry('.musagetes/staging.wav', source='.musagetes/staging.wav', operation='keep'))

    def test_custom_state_is_protected_without_banning_all_dot_names(self):
        self.assertTrue(self.result(self.entry('.hidden/track.flac'))['ok'])
        plan = {'schema_version': 1, 'entries': [self.entry('records/session/track.flac')]}
        result = guard.check_paths(self.root, plan, ['records/session'])
        self.assertEqual(result['issues'][0]['code'], 'PROTECTED_STATE')

    def test_inventory_skips_state_and_diagnostic_never_calls_it_music(self):
        for relative in ['.musagetes/staging.wav', 'records/session/working.flac']:
            path = self.root / relative
            path.parent.mkdir(parents=True)
            path.write_bytes(b'private state fixture')
        result = guard.inventory(self.root, True, ['records/session'])
        files = {r['path']: r for r in result['files']}
        self.assertEqual(files['.musagetes']['kind'], 'state_boundary')
        self.assertNotIn('.musagetes/staging.wav', files)
        self.assertNotIn('records/session/working.flac', files)
        result = guard.inventory(self.root, False, ['records/session'], include_state=True)
        state = next(r for r in result['files'] if r['path'] == '.musagetes/staging.wav')
        self.assertEqual(state['hint'], 'state_artifact')
        self.assertTrue(state['protected_state'])

    def test_symlink_root_error_gives_actionable_real_path(self):
        with tempfile.TemporaryDirectory() as temp:
            alias = Path(temp) / 'Music'
            alias.symlink_to(self.root, target_is_directory=True)
            with self.assertRaises(guard.GuardError) as error:
                guard.root_path(str(alias))
            self.assertIn(str(self.root), error.exception.issue['detail'])
            self.assertIn('--root', error.exception.issue['detail'])

    def test_additional_audio_hints_and_iconv_detection(self):
        for suffix in ['.shn', '.tta', '.tak', '.mpc']:
            self.assertEqual(guard.hint(Path('record' + suffix)), 'audio_candidate')
        self.assertIn('iconv', guard.inventory(self.root)['tools'])

    def test_duplicate_json_keys_are_rejected(self):
        with self.assertRaises(guard.GuardError):
            json.loads('{"schema_version":1,"schema_version":2}', object_pairs_hook=guard.unique_object)

    def test_cli_works_from_unrelated_cwd_and_returns_blocked_exit(self):
        plan = self.root / "plan.json"
        plan.write_text(json.dumps({"schema_version": 1, "entries": [self.entry("original.wav")]}))
        result = subprocess.run([sys.executable, "-B", guard.__file__, "check-paths", "--root", str(self.root), "--plan", str(plan)], cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["scope"], "paths_only")


if __name__ == "__main__":
    unittest.main()
