from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'skills/musagetes/scripts'))
import library_guard as guard
import music_rules as rules


class StagingAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.output = self.write('album/01.flac', b'verified organized output')

    def write(self, relative: str, payload: bytes) -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return path

    def event(self, run='r1', sequence=1, album='a1', state='.musagetes', **updates) -> Path:
        event = {
            'schema_version': 1, 'root': str(self.root), 'run_id': run, 'album_id': album,
            'sequence': sequence, 'skill_version': guard.skill_version(), 'phase': 'FINALIZED',
            'status': 'COMPLETED', 'match_status': 'FULL',
            'expected_files': [{'path': 'album/01.flac', 'sha256': guard.fingerprint(self.output), 'role': 'output'}],
            'removed_paths': [], **updates,
        }
        path = self.root / state / 'runs' / run / 'albums' / album / 'events' / f'{sequence:06d}.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(event), encoding='utf-8')
        return path

    def test_staging_policy_is_parsed_from_execution_reference(self):
        policy = rules.read_staging_policy()
        self.assertIn('.part', policy.root_temp_suffixes)
        self.assertIn('.tmp', policy.root_temp_suffixes)
        self.assertIn('.restore', policy.root_temp_suffixes)
        self.assertIn('.metadata.flac', policy.root_temp_suffixes)
        self.assertIn('.part.', policy.root_temp_infixes)
        self.assertIn('.pcm', policy.staging_temp_suffixes)
        self.assertIn('staging', policy.state_staging_dirs)
        self.assertIn('quarantine', policy.state_staging_dirs)
        self.assertIn('.staging', policy.bypass_dirs)

        custom = self.root / 'execution-custom.md'
        custom.write_text(
            '# Execution\n\n## 事务与恢复\n\n### Staging 生命周期与退场\n\n'
            '| 残留规则类型 | 匹配模式 | 检查范围 |\n'
            '| --- | --- | --- |\n'
            '| `suffix` | `.scratch` | `root` |\n'
            '| `infix` | `.wip.` | `root` |\n'
            '| `suffix` | `.rawpcm` | `staging` |\n'
            '| `staging_dir` | `workstage` | `state` |\n'
            '| `bypass_dir` | `.workstage` | `root_top` |\n',
            encoding='utf-8',
        )
        parsed = rules.read_staging_policy(custom)
        self.assertEqual(parsed.root_temp_suffixes, frozenset({'.scratch'}))
        self.assertEqual(parsed.root_temp_infixes, frozenset({'.wip.'}))
        self.assertEqual(parsed.staging_temp_suffixes, frozenset({'.rawpcm'}))
        self.assertEqual(parsed.state_staging_dirs, frozenset({'workstage'}))
        self.assertEqual(parsed.bypass_dirs, frozenset({'.workstage'}))

        broken = self.root / 'execution-broken.md'
        broken.write_text('# Execution\n\n### Staging 生命周期与退场\n\nno table here\n', encoding='utf-8')
        with self.assertRaises(rules.RuleError) as ctx:
            rules.read_staging_policy(broken)
        self.assertEqual(ctx.exception.issue['code'], 'INVALID_STAGING_POLICY')

    def test_clean_finalized_library_passes_staging_audit_without_writes(self):
        self.event()
        self.write('.musagetes/runs/r1/run.json', b'{"run_id":"r1"}')
        self.write('.musagetes/runs/r1/scan/inventory.json', b'{}')
        self.write('.musagetes/runs/r1/evidence/mb.json', b'{}')
        self.write('.musagetes/runs/r1/preserved/a1/booklet.txt', b'notes')
        self.write('.musagetes/runs/r1/albums/a1/operations.jsonl', b'{}\n')
        before = sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob('*'))
        result = guard.staging_audit(self.root)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['scope'], 'staging_and_temp_residue_only')
        self.assertEqual(result['issues'], [])
        self.assertEqual(result['summary']['total_residual_bytes'], 0)
        self.assertEqual(before, sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob('*')))

    def test_active_recovery_staging_for_non_completed_album_is_allowed(self):
        staged = self.write('.musagetes/runs/r1/albums/a1/staging/source.flac', b'0123456789')
        self.event(
            phase='STAGED', status='REVIEW_REQUIRED', match_status='UNCONFIRMED',
            expected_files=[{'path': '.musagetes/runs/r1/albums/a1/staging/source.flac',
                             'sha256': guard.fingerprint(staged), 'role': 'staging'}],
        )
        result = guard.staging_audit(self.root)
        self.assertTrue(result['ok'], result)
        self.assertEqual(len(result['active_recovery_files']), 1)
        self.assertEqual(result['active_recovery_files'][0]['path'], '.musagetes/runs/r1/albums/a1/staging/source.flac')
        self.assertEqual(result['summary']['active_recovery_bytes'], 10)
        self.assertEqual(result['summary']['orphaned_staging_count'], 0)
        self.assertEqual(result['summary']['total_residual_bytes'], 0)

        staged.write_bytes(b'corrupted!')
        tampered = guard.staging_audit(self.root)
        self.assertFalse(tampered['ok'])
        self.assertIn('HISTORY_FILE_CHANGED', {i['code'] for i in tampered['issues']})

    def test_orphaned_staging_quarantine_backflow_and_empty_dirs_block(self):
        self.event()
        orphan = self.write('.musagetes/runs/r1/albums/a1/staging/split-01.flac', b'a' * 100)
        backflow = self.write('.musagetes/runs/r1/albums/a1/staging/track-map.json', b'{"map":1}')
        quarantined = self.write('.musagetes/quarantine/dup.flac', b'b' * 50)
        empty_dir = self.root / '.musagetes/runs/r1/albums/a1/staging/empty-sub'
        empty_dir.mkdir(parents=True)
        result = guard.staging_audit(self.root)
        self.assertFalse(result['ok'])
        orphan_paths = {row['path'] for row in result['orphaned_staging_files']}
        self.assertEqual(orphan_paths, {
            orphan.relative_to(self.root).as_posix(),
            backflow.relative_to(self.root).as_posix(),
            quarantined.relative_to(self.root).as_posix(),
        })
        self.assertEqual(result['empty_staging_dirs'], ['.musagetes/runs/r1/albums/a1/staging/empty-sub'])
        expected_bytes = 100 + len(b'{"map":1}') + 50
        self.assertEqual(result['summary']['orphaned_staging_bytes'], expected_bytes)
        self.assertEqual(result['summary']['total_residual_bytes'], expected_bytes)
        codes = {issue['code'] for issue in result['issues']}
        self.assertIn('ORPHANED_STAGING_FILE', codes)
        self.assertIn('EMPTY_STAGING_DIR', codes)

    def test_unregistered_top_level_staging_bypass_dir_is_caught(self):
        self.event()
        self.write('.staging/sources/disc.wav', b'w' * 200)
        self.write('.staging/splits/01/track-01.flac', b'f' * 80)
        self.write('.staging/converted/disc.flac', b'c' * 120)
        (self.root / '.staging/pcm').mkdir(parents=True)

        default_audit = guard.staging_audit(self.root)
        self.assertFalse(default_audit['ok'])
        self.assertEqual(len(default_audit['unregistered_staging_dirs']), 1)
        bypass = default_audit['unregistered_staging_dirs'][0]
        self.assertEqual(bypass['path'], '.staging')
        self.assertEqual(bypass['file_count'], 3)
        self.assertEqual(bypass['bytes'], 400)
        self.assertEqual(default_audit['summary']['total_residual_bytes'], 400)
        self.assertIn('UNREGISTERED_STAGING_DIR', {i['code'] for i in default_audit['issues']})

        registered_audit = guard.staging_audit(self.root, ['.staging'])
        self.assertFalse(registered_audit['ok'])
        self.assertEqual(registered_audit['unregistered_staging_dirs'], [])
        self.assertEqual(registered_audit['summary']['orphaned_staging_count'], 3)
        self.assertEqual(registered_audit['summary']['orphaned_staging_bytes'], 400)
        self.assertEqual(registered_audit['empty_staging_dirs'], ['.staging/pcm'])

    def test_temp_and_leaked_pcm_files_are_detected_by_scope(self):
        self.event()
        self.write('album/.01.flac.deadbeef.part.flac', b'p' * 30)
        self.write('album/draft.tmp', b't' * 20)
        self.write('.musagetes/runs/r1/albums/a1/staging/raw.pcm', b'r' * 500)
        # Non-staging .pcm outside state/staging is not treated as a staging PCM leak.
        self.write('album/raw-user-asset.pcm', b'u' * 40)

        result = guard.staging_audit(self.root)
        self.assertFalse(result['ok'])
        temp_paths = {row['path'] for row in result['temp_files']}
        self.assertEqual(temp_paths, {
            'album/.01.flac.deadbeef.part.flac',
            'album/draft.tmp',
            '.musagetes/runs/r1/albums/a1/staging/raw.pcm',
        })
        self.assertEqual(result['summary']['temp_file_bytes'], 550)
        # The leaked PCM is counted once in temp_files, not double-counted in orphaned_staging_files.
        self.assertEqual(result['orphaned_staging_files'], [])
        self.assertEqual(result['summary']['total_residual_bytes'], 550)

    def test_symlinks_in_staging_or_bypass_are_flagged_without_following(self):
        self.event()
        outside = self.root.parent / 'external-secret.flac'
        outside.write_bytes(b'outside')
        self.addCleanup(lambda: outside.unlink(missing_ok=True))
        link = self.root / '.musagetes/runs/r1/albums/a1/staging/escape.flac'
        link.parent.mkdir(parents=True)
        link.symlink_to(outside)

        result = guard.staging_audit(self.root)
        self.assertFalse(result['ok'])
        self.assertIn('SYMLINK', {i['code'] for i in result['issues']})
        self.assertEqual(outside.read_bytes(), b'outside')

    def test_cli_staging_audit_exit_codes(self):
        self.event()
        clean = subprocess.run(
            [sys.executable, '-B', guard.__file__, 'staging-audit', '--root', str(self.root)],
            cwd=self.root, text=True, capture_output=True, timeout=30,
        )
        self.assertEqual(clean.returncode, 0, clean.stderr)
        self.assertTrue(json.loads(clean.stdout)['ok'])

        self.write('.musagetes/runs/r1/albums/a1/staging/leftover.flac', b'stale')
        dirty = subprocess.run(
            [sys.executable, '-B', guard.__file__, 'staging-audit', '--root', str(self.root)],
            cwd=self.root, text=True, capture_output=True, timeout=30,
        )
        self.assertEqual(dirty.returncode, 1, dirty.stderr)
        payload = json.loads(dirty.stdout)
        self.assertFalse(payload['ok'])
        self.assertEqual(payload['summary']['orphaned_staging_count'], 1)


if __name__ == '__main__':
    unittest.main()
