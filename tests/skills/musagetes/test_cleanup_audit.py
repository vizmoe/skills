from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[3] / 'skills/musagetes/scripts'
sys.path.insert(0, str(SCRIPTS))
import library_guard as guard

spec = importlib.util.spec_from_file_location('cleanup_audit', SCRIPTS / 'cleanup-audit.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.original = self.file('original/track.flac', b'audio')
        self.source = self.file('review/track.flac', b'audio')
        self.output = self.file('album/track.flac', b'audio')
        self.quarantine = self.root / '.musagetes/quarantine/track.flac'
        self.quarantine.parent.mkdir(parents=True)
        self.entry = {'id': 'track', 'role': 'review', 'source': self.ref(self.source),
                      'quarantine': '.musagetes/quarantine/track.flac',
                      'outputs': [self.ref(self.output)], 'reason': 'verified duplicate',
                      'stage': 'prepared', 'equivalence': {'method': 'bytes'}, 'audit': None}
        self.manifest = {'schema_version': 1, 'originals': [self.ref(self.original)], 'entries': [self.entry]}

    def file(self, rel, data):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def ref(self, path):
        return {'path': path.relative_to(self.root).as_posix(), 'sha256': guard.fingerprint(path)}

    def action(self):
        result = cleanup.audit(self.root, self.manifest)
        self.assertTrue(result['ok'], result)
        return result['entries'][0]['action']

    def reconcile(self):
        self.entry['audit'] = {
            'snapshot': self.ref(self.file('.musagetes/events/000002.json', b'{"fixture": "snapshot"}')),
            'report': self.ref(self.file('.musagetes/report.json', b'{"fixture": "report"}')),
            'binding': cleanup.binding(self.entry),
        }
        self.entry['stage'] = 'audited'

    def assertBlocked(self):
        result = cleanup.audit(self.root, self.manifest)
        self.assertFalse(result['ok'], result)
        self.assertEqual(result['entries'][0]['action'], 'REVIEW_REQUIRED')

    def test_interruption_and_replay_use_files_not_last_written_stage(self):
        before = copy.deepcopy(self.manifest)
        self.assertEqual(self.action(), 'QUARANTINE')
        self.assertEqual(self.manifest, before)
        self.source.rename(self.quarantine)  # Crash before recording the move.
        self.assertEqual(self.action(), 'RECONCILE')
        self.assertEqual(self.action(), 'RECONCILE')
        self.reconcile()
        self.assertEqual(self.action(), 'RECORD_REMOVE_INTENT')
        self.entry['stage'] = 'remove-intent'
        self.assertEqual(self.action(), 'REMOVE_QUARANTINE')
        self.quarantine.unlink()  # Crash before recording the removal.
        for _ in range(2):
            result = cleanup.audit(self.root, self.manifest)
            self.assertTrue(result['ok'])
            self.assertEqual(result['removed_ids'], ['track'])
            self.assertEqual(result['entries'][0]['action'], 'COMPLETE')
        self.assertEqual(self.original.read_bytes(), b'audio')
        self.assertEqual(self.output.read_bytes(), b'audio')

    def test_missing_or_changed_output_protects_the_only_remaining_copy(self):
        self.output.unlink()
        self.assertBlocked()
        self.output.write_bytes(b'other')
        self.assertBlocked()
        self.assertTrue(self.source.exists())

    def test_byte_equivalence_is_checked_not_just_declared(self):
        self.output.write_bytes(b'not equivalent')
        self.entry['outputs'] = [self.ref(self.output)]
        self.assertBlocked()

    def test_pcm_evidence_binds_both_file_hashes_and_stream_digest(self):
        self.output.write_bytes(b'retagged audio container')
        self.entry['outputs'] = [self.ref(self.output)]
        proof = {'source': self.entry['source'], 'outputs': self.entry['outputs'],
                 'source_digest': 'a' * 64, 'output_digest': 'a' * 64,
                 'method': 'pcm', 'command': 'fixture decoder; complete ordered concatenation'}
        proof_file = self.file('.musagetes/pcm.json', json.dumps(proof).encode())
        self.entry['equivalence'] = {'method': 'pcm', 'evidence': self.ref(proof_file)}
        self.assertEqual(self.action(), 'QUARANTINE')
        for update in ({'source_digest': 'b' * 64}, {'outputs': []}, {'command': ''}):
            proof_file.write_text(json.dumps(proof | update))
            self.entry['equivalence']['evidence'] = self.ref(proof_file)
            self.assertBlocked()

    def test_original_roles_aliases_and_unregistered_hardlinks_are_blocked(self):
        for role in ('original', 'derived', 'cache'):
            self.entry['role'] = role
            self.assertBlocked()
        self.entry['role'] = 'review'
        self.entry['source'] = self.ref(self.original)
        self.assertBlocked()
        self.entry['source'] = self.ref(self.source)
        (self.root / 'hardlink.flac').hardlink_to(self.source)
        self.assertBlocked()

    def test_disappearance_without_remove_intent_is_not_success(self):
        self.source.unlink()
        self.assertBlocked()
        self.entry['stage'] = 'remove-intent'
        self.assertBlocked()  # No audit receipt.

    def test_conflicting_copies_and_stale_receipts_do_not_authorize_removal(self):
        self.quarantine.write_bytes(b'audio')
        self.assertBlocked()
        self.source.unlink()
        self.reconcile()
        (self.root / self.entry['audit']['report']['path']).write_text('changed')
        self.assertBlocked()
        self.reconcile()
        self.entry['reason'] = 'changed plan'
        self.assertBlocked()

    def test_plan_cannot_remove_its_outputs_or_duplicate_ids(self):
        self.manifest['entries'].append(copy.deepcopy(self.entry))
        self.assertFalse(cleanup.audit(self.root, self.manifest)['ok'])
        self.manifest['entries'].pop()
        self.entry['outputs'] = [self.entry['source']]
        self.assertBlocked()

    def test_symlinks_and_path_escapes_are_never_followed(self):
        self.source.unlink()
        self.source.symlink_to(self.original)
        self.assertBlocked()
        self.entry['source']['path'] = '../outside.flac'
        self.assertBlocked()


if __name__ == '__main__':
    unittest.main()
