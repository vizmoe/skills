from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'skills/musagetes/scripts'))
import library_guard as guard


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.output = self.root / 'album/01.flac'
        self.output.parent.mkdir()
        self.output.write_bytes(b'synthetic verified output')

    def event(self, run='r1', sequence=1, album='a1', state='.musagetes', **updates):
        event = {'schema_version': 1, 'root': str(self.root), 'run_id': run, 'album_id': album,
                 'sequence': sequence, 'skill_version': guard.skill_version(), 'phase': 'FINALIZED',
                 'status': 'COMPLETED', 'match_status': 'FULL',
                 'expected_files': [{'path': 'album/01.flac', 'sha256': guard.fingerprint(self.output), 'role': 'output'}],
                 'removed_paths': [], **updates}
        path = self.root / state / 'runs' / run / 'albums' / album / 'events' / f'{sequence:06d}.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(event))
        return path

    def test_fresh_library_has_no_completion_claim(self):
        result = guard.history(self.root)
        self.assertTrue(result['ok'])
        self.assertEqual(result['albums'], [])

    def test_latest_sequence_across_runs_wins_over_mtime_and_name(self):
        early = self.event(run='z_old')
        latest = self.event(run='a_new', sequence=2, phase='COMMITTED', status=None)
        os.utime(latest, (1, 1))
        result = guard.history(self.root)
        self.assertTrue(result['ok'])
        self.assertTrue(early.exists())
        album = result['albums'][0]
        self.assertEqual(album['latest']['event']['run_id'], 'a_new')
        self.assertFalse(album['reuse_candidate'])

    def test_complete_unchanged_files_are_only_reuse_candidates(self):
        self.event()
        result = guard.history(self.root)
        self.assertTrue(result['albums'][0]['reuse_candidate'])
        self.assertEqual(result['scope'], 'recorded_files_only')
        self.assertEqual(self.output.read_bytes(), b'synthetic verified output')

    def test_changed_missing_and_reappeared_files_block_reuse(self):
        self.event(removed_paths=['original.wav'])
        self.output.write_bytes(b'changed')
        self.assertFalse(guard.history(self.root)['ok'])
        self.output.unlink()
        self.assertFalse(guard.history(self.root)['ok'])
        self.output.write_bytes(b'synthetic verified output')
        (self.root / 'original.wav').write_bytes(b'reappeared')
        result = guard.history(self.root)
        self.assertFalse(result['ok'])
        self.assertIn('REMOVED_PATH_REAPPEARED', [i['code'] for i in result['albums'][0]['issues']])

    def test_corrupt_latest_never_falls_back_to_earlier_complete(self):
        self.event()
        self.event(run='r2', sequence=2).write_text('{broken')
        result = guard.history(self.root)
        self.assertFalse(result['albums'][0]['reuse_candidate'])
        self.assertFalse(result['ok'])

    def test_duplicate_sequences_block_reuse(self):
        self.event()
        self.event(run='r2')
        self.assertFalse(guard.history(self.root)['ok'])

    def test_wrong_identity_version_or_completion_manifest_blocks(self):
        for updates in [{'root': '/another/root'}, {'album_id': 'other'}, {'run_id': 'other'},
                        {'sequence': True}, {'skill_version': '0.0.0'}, {'phase': 'COMMITTED'},
                        {'expected_files': [{'path': 'album/01.flac', 'sha256': guard.fingerprint(self.output), 'role': 'source'}]}]:
            with self.subTest(updates=updates):
                path = self.event()
                event = json.loads(path.read_text()) | updates
                path.write_text(json.dumps(event))
                self.assertFalse(guard.history(self.root)['ok'])

    def test_state_paths_cannot_be_published_outputs(self):
        self.event(expected_files=[{'path': '.musagetes/fake.flac', 'sha256': '0' * 64, 'role': 'output'}])
        self.assertFalse(guard.history(self.root)['ok'])

    def test_legacy_layout_requires_explicit_review(self):
        self.event()
        legacy = self.root / '.musagetes/runs/legacy/state.json'
        legacy.parent.mkdir()
        legacy.write_text('{}')
        result = guard.history(self.root)
        self.assertFalse(result['ok'])
        self.assertFalse(result['albums'][0]['reuse_candidate'])
        self.assertEqual(result['issues'][0]['code'], 'UNRECOGNIZED_HISTORY')

    def test_symlinked_state_event_or_output_is_not_followed(self):
        event = self.event()
        raw = event.read_text()
        target = self.root / 'elsewhere.json'
        target.write_text(raw)
        event.unlink()
        event.symlink_to(target)
        self.assertFalse(guard.history(self.root)['ok'])
        event.unlink()
        event.write_text(raw)
        self.output.unlink()
        self.output.symlink_to(target)
        self.assertFalse(guard.history(self.root)['ok'])

    def test_state_directory_symlink_blocks_without_following(self):
        (self.root / '.musagetes').symlink_to(self.root, target_is_directory=True)
        self.assertFalse(guard.history(self.root)['ok'])

    def test_bad_default_state_does_not_hide_alternative_history(self):
        (self.root / '.musagetes').symlink_to(self.root, target_is_directory=True)
        self.event(state='alternate-state')
        result = guard.history(self.root, ['alternate-state'])
        self.assertFalse(result['ok'])
        self.assertEqual(result['albums'][0]['latest']['event']['album_id'], 'a1')
        self.assertFalse(result['albums'][0]['reuse_candidate'])

    def test_custom_nested_state_and_case_alias_are_discovered(self):
        self.event(state='bookkeeping/run-state')
        result = guard.history(self.root, ['bookkeeping/run-state'])
        self.assertTrue(result['albums'][0]['reuse_candidate'])
        self.event(run='r2', sequence=2, state='.MUSAGETES')
        result = guard.history(self.root, ['bookkeeping/run-state'])
        self.assertTrue(result['ok'])
        self.assertEqual(result['albums'][0]['latest']['event']['sequence'], 2)

    def test_two_albums_are_verified_independently(self):
        self.event()
        self.event(album='a2', expected_files=[{'path': 'missing.flac', 'sha256': '0' * 64, 'role': 'output'}])
        result = guard.history(self.root)
        self.assertFalse(result['ok'])
        self.assertTrue(result['albums'][0]['reuse_candidate'])
        self.assertFalse(result['albums'][1]['reuse_candidate'])


if __name__ == '__main__':
    unittest.main()
