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

    def test_delete_after_verification_allows_verified_original_cleanup_and_protects_preserved_originals(self):
        self.output.write_bytes(b'verified retagged flac')
        orig_entry = {
            'id': 'orig-track',
            'role': 'original',
            'source': self.ref(self.original),
            'quarantine': '.musagetes/quarantine/orig-track.flac',
            'outputs': [self.ref(self.output)],
            'reason': 'album COMPLETED with verified PCM equivalence',
            'stage': 'prepared',
            'equivalence': {'method': 'bytes'},
            'audit': None,
        }
        proof = {
            'source': orig_entry['source'],
            'outputs': orig_entry['outputs'],
            'source_digest': 'c' * 64,
            'output_digest': 'c' * 64,
            'method': 'pcm',
            'command': 'ffmpeg decode pcm check',
        }
        proof_file = self.file('.musagetes/orig-pcm.json', json.dumps(proof).encode())
        orig_entry['equivalence'] = {'method': 'pcm', 'evidence': self.ref(proof_file)}
        manifest = {
            'schema_version': 1,
            'original_policy': 'delete-after-verification',
            'originals': [],
            'entries': [orig_entry],
        }
        res = cleanup.audit(self.root, manifest)
        self.assertTrue(res['ok'], res)
        self.assertEqual(res['original_policy'], 'delete-after-verification')
        self.assertEqual(res['entries'][0]['action'], 'QUARANTINE')

        # Explicitly listed originals remain protected even under delete-after-verification.
        protected_manifest = copy.deepcopy(manifest)
        protected_manifest['originals'] = [self.ref(self.original)]
        self.assertFalse(cleanup.audit(self.root, protected_manifest)['ok'])

        # Walk the full crash-safe quarantine -> reconcile -> remove-intent -> remove -> complete lifecycle.
        q_path = self.root / orig_entry['quarantine']
        self.original.rename(q_path)
        self.assertEqual(cleanup.audit(self.root, manifest)['entries'][0]['action'], 'RECONCILE')
        orig_entry['audit'] = {
            'snapshot': self.ref(self.file('.musagetes/events/000003.json', b'{"ok":true}')),
            'report': self.ref(self.file('.musagetes/report-orig.json', b'{"ok":true}')),
            'binding': cleanup.binding(orig_entry),
        }
        orig_entry['stage'] = 'audited'
        self.assertEqual(cleanup.audit(self.root, manifest)['entries'][0]['action'], 'RECORD_REMOVE_INTENT')
        orig_entry['stage'] = 'remove-intent'
        self.assertEqual(cleanup.audit(self.root, manifest)['entries'][0]['action'], 'REMOVE_QUARANTINE')
        q_path.unlink()
        done = cleanup.audit(self.root, manifest)
        self.assertTrue(done['ok'], done)
        self.assertEqual(done['entries'][0]['action'], 'COMPLETE')
        self.assertEqual(done['removed_ids'], ['orig-track'])
        self.assertFalse(self.original.exists())
        self.assertTrue(self.output.exists())

        # Missing surviving output blocks original cleanup.
        self.output.unlink()
        self.assertFalse(cleanup.audit(self.root, manifest)['ok'])


if __name__ == '__main__':
    unittest.main()
