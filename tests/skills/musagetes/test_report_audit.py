from __future__ import annotations

import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[3] / 'skills/musagetes/scripts'
sys.path.insert(0, str(SCRIPTS))
import library_guard as guard

spec = importlib.util.spec_from_file_location('report_audit', SCRIPTS / 'report-audit.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class ReportAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.request = {'files': [], 'groups': [{'id': 'review', 'cover': 'unknown'}],
                        'publications': [], 'cleanups': [], 'cues': []}

    def file(self, ident, kind='audio', group='review', match='UNCONFIRMED'):
        extension = {'audio': 'aac', 'cue': 'cue', 'evidence': 'json'}[kind]
        path = self.root / group / f'{ident}.{extension}'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f'synthetic {kind} {ident}'.encode())
        self.request['files'].append({'id': ident, 'group': group, 'path': path.relative_to(self.root).as_posix(),
            'sha256': guard.fingerprint(path), 'kind': kind, 'match_status': match if kind == 'audio' else None})
        return path

    def event(self, file_id, sequence=1, status='published', outputs=None):
        return {'file_id': file_id, 'sequence': sequence, 'status': status,
                'outputs': outputs if outputs is not None else [file_id], 'evidence': 'synthetic verified operation'}

    def test_audio_attachments_and_nine_cover_gaps_have_independent_counts(self):
        self.file('unknown')
        for n in range(4):
            self.file(f'cue{n}', kind='cue')
            self.request['cues'].append({'file_id': f'cue{n}', 'sequence': 1,
                'status': 'missing_source' if n < 2 else 'duplicate', 'evidence': 'synthetic CUE outcome'})
        for n in range(19):
            self.file(f'proof{n}', kind='evidence')
        for n in range(9):
            group = f'album{n}'
            self.request['groups'].append({'id': group, 'cover': 'missing'})
            self.file(f'track{n}', group=group, match='FULL')
            self.request['publications'].append(self.event(f'track{n}'))
        before = copy.deepcopy(self.request)
        result = report.audit(self.root, self.request)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['counts']['unidentified_audio'], 1)
        self.assertEqual(result['counts']['evidence_files'], 19)
        self.assertEqual(result['counts']['cue_missing_source'], 2)
        self.assertEqual(result['counts']['cue_duplicates'], 2)
        self.assertEqual(result['counts']['missing_cover'], 9)
        self.assertEqual(result['review_groups'], {'review': ['unknown']})
        self.assertEqual(self.request, before)

    def test_six_ground_snow_tracks_join_latest_publication_and_cleanup(self):
        self.request['groups'].append({'id': 'ground-snow', 'cover': 'present'})
        for n in range(6):
            source, output = f'review{n}', f'output{n}'
            path = self.file(source, group='ground-snow')
            self.file(output, group='ground-snow', match='FULL')
            self.request['publications'] += [self.event(source, sequence=2, outputs=[output]),
                self.event(source, status='pending', outputs=[])]  # Deliberately unsorted.
            self.request['cleanups'] += [self.event(source, sequence=2, status='removed', outputs=[output]),
                self.event(source, status='pending', outputs=[])]
            path.unlink()
        for _ in range(2):
            result = report.audit(self.root, self.request)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['counts']['published'], 6)
            self.assertEqual(result['counts']['cleaned_duplicates'], 6)
            self.assertEqual(result['counts']['unidentified_audio'], 0)
            self.assertEqual(result['review_groups'], {})

    def test_partial_identity_and_missing_cover_do_not_become_unidentified(self):
        self.request['groups'][0]['cover'] = 'missing'
        self.file('partial', match='PARTIAL_MATCH')
        self.file('known', match='FULL')
        result = report.audit(self.root, self.request)
        self.assertEqual(result['counts']['partial_matches'], 1)
        self.assertEqual(result['counts']['unidentified_audio'], 0)
        self.assertEqual(result['counts']['missing_cover'], 1)

    def test_latest_pending_outcome_reopens_review_and_latest_cue_wins(self):
        self.file('track')
        self.file('cue', kind='cue')
        self.request['publications'] = [self.event('track'), self.event('track', 2, 'pending', [])]
        self.request['cues'] = [dict(file_id='cue', sequence=n, status=status, evidence='fixture')
                               for n, status in ((2, 'resolved'), (1, 'missing_source'))]
        result = report.audit(self.root, self.request)
        self.assertEqual(result['review_groups'], {'review': ['track']})
        self.assertEqual(result['counts']['cue_missing_source'], 0)

    def test_unverified_publication_or_removal_blocks_a_clean_report(self):
        source = self.file('source')
        output = self.file('output', match='FULL')
        self.request['publications'] = [self.event('source', outputs=['output'])]
        output.write_bytes(b'changed after publication')
        result = report.audit(self.root, self.request)
        self.assertFalse(result['ok'])
        self.assertIn('source', result['categories']['unidentified_audio'])
        self.request['publications'] = []
        self.request['cleanups'] = [self.event('source', status='removed', outputs=['output'])]
        self.assertFalse(report.audit(self.root, self.request)['ok'])
        self.assertTrue(source.exists())

    def test_missing_audio_without_a_verified_outcome_is_an_error(self):
        self.file('lost').unlink()
        result = report.audit(self.root, self.request)
        self.assertFalse(result['ok'])
        self.assertEqual(result['counts']['unidentified_audio'], 0)  # No actual file to count.
        self.assertEqual(result['issues'][0]['code'], 'UNEXPLAINED_MISSING_FILE')

    def test_duplicate_sequences_unknown_targets_and_aliases_are_invalid(self):
        self.file('track')
        for records in ([self.event('track'), self.event('track')], [self.event('track', outputs=['absent'])]):
            self.request['publications'] = records
            with self.assertRaises(ValueError):
                report.audit(self.root, self.request)
        self.request['publications'] = []
        self.request['files'].append({**self.request['files'][0], 'id': 'alias', 'path': 'REVIEW/TRACK.AAC'})
        with self.assertRaises(ValueError):
            report.audit(self.root, self.request)

    def test_links_are_not_counted_as_verified_audio(self):
        track = self.file('track')
        target = self.root / 'target'
        track.rename(target)
        track.symlink_to(target)
        result = report.audit(self.root, self.request)
        self.assertFalse(result['ok'])
        self.assertEqual(result['counts']['unidentified_audio'], 0)


if __name__ == '__main__':
    unittest.main()
