import copy
import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[3] / 'skills/musagetes/scripts/search-ledger.py'


class SearchLedgerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('search_ledger', SCRIPT)
        cls.ledger = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.ledger)

    def attempt(self, **updates):
        return {'query': 'recording:"The Ray of Light" AND dur:[270000 TO 290000]',
                'syntax_valid': True, 'duration_unit': 'ms', 'http_status': 200,
                'response_valid': True, 'result_count': 0, 'pages_complete': True, **updates}

    def audit(self, attempts, **route):
        return self.ledger.audit({'routes': [{'id': 'variant', 'source': 'musicbrainz-recording',
            'required': True, 'attempts': attempts, **route}]})

    def test_valid_zero_is_distinct_from_invalid_duration_field(self):
        good = self.audit([self.attempt()])
        self.assertTrue(good['no_results'])
        bad = self.audit([self.attempt(query='recording:"The Ray" AND length:[270000 TO 290000]')])
        self.assertFalse(bad['no_results'])
        self.assertEqual(bad['routes'][0]['status'], 'INVALID_QUERY')
        self.assertEqual(bad['error_count'], 1)

    def test_failed_cached_attempt_is_pending_until_successful_retry(self):
        failure = self.attempt(http_status=503)
        self.assertEqual(self.audit([failure])['routes'][0]['status'], 'TEMPORARY_FAILURE')
        repaired = self.audit([failure, self.attempt()])
        self.assertTrue(repaired['no_results'])
        self.assertEqual(repaired['error_count'], 0)
        self.assertEqual(repaired['attempt_error_count'], 1)
        self.assertEqual(repaired['pending'], [])

    def test_not_run_truncated_and_hit_do_not_support_no_result_claim(self):
        for attempts, expected in [([], 'NOT_RUN'), ([self.attempt(pages_complete=False)], 'INCOMPLETE'),
                                   ([self.attempt(result_count=5)], 'HIT')]:
            with self.subTest(expected=expected):
                result = self.audit(attempts)
                self.assertFalse(result['no_results'])
                self.assertEqual(result['routes'][0]['status'], expected)

    def test_all_required_routes_must_be_completed(self):
        routes = [{'id': 'zero', 'source': 'musicbrainz-recording', 'required': True, 'attempts': [self.attempt()]},
                  {'id': 'credits', 'source': 'musicbrainz-recording', 'required': True, 'attempts': []}]
        result = self.ledger.audit({'routes': routes})
        self.assertFalse(result['coverage_complete'])
        self.assertEqual(result['pending'], ['credits'])
        self.assertEqual(result['completed_routes'], ['zero'])

    def test_fields_inside_quoted_titles_and_escaped_colons_are_not_query_fields(self):
        result = self.audit([self.attempt(query='recording:"length: story" AND artistname:"NAGI☆" AND alias:Ray')])
        self.assertTrue(result['no_results'])
        self.assertEqual(result['routes'][0]['fields'], ['alias', 'artistname', 'recording'])

    def test_invalid_syntax_units_transport_and_response_body_remain_visible(self):
        for updates, status in [({'syntax_valid': False}, 'INVALID_QUERY'),
                ({'duration_unit': 'seconds'}, 'INVALID_QUERY'), ({'http_status': None, 'transport_error': 'timeout'}, 'TEMPORARY_FAILURE'),
                ({'http_status': None, 'transport_error': 'unknown'}, 'FAILED'),
                ({'response_valid': False}, 'FAILED'), ({'http_status': 403}, 'FAILED')]:
            with self.subTest(updates=updates):
                result = self.audit([self.attempt(**updates)])
                self.assertEqual(result['routes'][0]['status'], status)
                self.assertFalse(result['no_results'])

    def test_duplicate_routes_and_untyped_counts_are_rejected(self):
        with self.assertRaises(ValueError):
            self.audit([self.attempt(result_count=True)])
        route = {'id': 'a', 'source': 'musicbrainz-recording', 'required': True, 'attempts': []}
        with self.assertRaises(ValueError):
            self.ledger.audit({'routes': [route, route]})

    def test_audit_does_not_modify_cached_attempts(self):
        attempts = [self.attempt(http_status=503), self.attempt(result_count=1)]
        snapshot = copy.deepcopy(attempts)
        self.audit(attempts)
        self.assertEqual(attempts, snapshot)
