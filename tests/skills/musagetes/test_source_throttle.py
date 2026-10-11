from __future__ import annotations

import copy
from email.utils import formatdate
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / 'skills/musagetes/scripts/source-throttle.py'
REFERENCE = ROOT / 'skills/musagetes/references/requests.md'
MB = 'https://musicbrainz.org/ws/2/release/?query=album'
ITUNES = 'https://itunes.apple.com/search?term=album&country=JP'


class SourceThrottleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SCRIPT.is_file():
            raise AssertionError('Musagetes needs a callable response-aware request scheduler.')
        spec = importlib.util.spec_from_file_location('source_throttle', SCRIPT)
        cls.throttle = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.throttle)

    def event(self, *, state=None, url=MB, now=1000, attempt=1, **response):
        data = {'operation': 'observe', 'url': url, 'now': now, 'attempt': attempt,
                'state': state, **response}
        if 'status' not in response and 'error' not in response:
            data['operation'] = 'check'
        return self.throttle.evaluate(data, jitter=lambda: 0)

    def test_initial_request_is_ready_and_service_floors_apply_after_success(self):
        for url, floor in [(MB, 1.1), (ITUNES, 3.1)]:
            with self.subTest(url=url):
                self.assertEqual(self.event(url=url)['action'], 'ready')
                completed = self.event(url=url, status=200)
                self.assertEqual(completed['action'], 'complete')
                waiting = self.event(url=url, state=completed['state'])
                self.assertEqual(waiting['action'], 'wait')
                self.assertAlmostEqual(waiting['wait_seconds'], floor)

    def test_cooldown_is_shared_across_queries_albums_and_storefronts(self):
        limited = self.event(url=ITUNES, status=429, headers={'Retry-After': '45'})
        waiting = self.event(url='https://itunes.apple.com/lookup?id=12&country=US',
                             now=1001, state=limited['state'])
        self.assertEqual(waiting['action'], 'wait')
        self.assertEqual(waiting['not_before'], 1045)
        independent = self.event(now=1001, state=limited['state'])
        self.assertEqual(independent['action'], 'ready')

    def test_musicbrainz_503_and_429_both_increase_spacing(self):
        for status in (429, 503):
            with self.subTest(status=status):
                first = self.event(status=status)
                second = self.event(status=status, state=first['state'],
                                    now=first['not_before'], attempt=2)
                self.assertEqual(first['action'], 'retry')
                self.assertGreater(first['wait_seconds'], 1.1)
                self.assertGreater(second['wait_seconds'], first['wait_seconds'])
                self.assertEqual(self.event(now=second['not_before'], state=second['state'])['action'], 'ready')

    def test_temporary_statuses_and_transport_failures_retry(self):
        for response in [{'status': n} for n in (408, 500, 502, 504)] + [
                {'error': 'timeout'}, {'error': 'connection'}]:
            with self.subTest(response=response):
                self.assertEqual(self.event(**response)['action'], 'retry')

    def test_permanent_errors_are_not_retried_or_treated_as_throttling(self):
        for status in (400, 404, 405, 410, 422, 501):
            with self.subTest(status=status):
                result = self.event(status=status)
                self.assertEqual(result['action'], 'stop')
                self.assertEqual(result['state']['sources']['musicbrainz.org']['interval'], 1.1)
        for error in ('tls', 'unknown'):
            self.assertEqual(self.event(error=error)['action'], 'stop')

    def test_authentication_and_access_failures_block_only_that_source(self):
        for status in (401, 403):
            with self.subTest(status=status):
                result = self.event(status=status)
                self.assertEqual(result['action'], 'blocked')
                self.assertEqual(self.event(now=5000, state=result['state'])['action'], 'blocked')
                self.assertEqual(self.event(url=ITUNES, state=result['state'])['action'], 'ready')

    def test_retry_after_seconds_is_case_insensitive_and_not_cut_to_wait_cap(self):
        result = self.event(status=429, headers={'rEtRy-AfTeR': '7200'})
        self.assertEqual(result['action'], 'defer')
        self.assertEqual(result['not_before'], 8200)
        self.assertEqual(self.event(state=result['state'], now=8199)['action'], 'wait')
        self.assertEqual(self.event(state=result['state'], now=8200)['action'], 'ready')

    def test_http_date_uses_server_date_to_tolerate_clock_skew(self):
        result = self.event(status=503, headers={
            'Date': formatdate(2000, usegmt=True),
            'Retry-After': formatdate(2090, usegmt=True)})
        self.assertEqual(result['not_before'], 1090)
        self.assertEqual(result['action'], 'defer')
        without_date = self.event(status=503, headers={'Retry-After': formatdate(1040, usegmt=True)})
        self.assertEqual(without_date['not_before'], 1040)

    def test_bad_past_or_zero_retry_after_still_obeys_local_backoff(self):
        for value in ('nonsense', '-1', '1.5', 'NaN', '0', formatdate(0, usegmt=True)):
            with self.subTest(value=value):
                result = self.event(status=429, headers={'Retry-After': value})
                self.assertEqual(result['action'], 'retry')
                self.assertGreaterEqual(result['wait_seconds'], 2.2)

    def test_retry_budget_is_checked_before_and_after_requests(self):
        exhausted = self.event(status=503, attempt=3)
        self.assertEqual(exhausted['action'], 'stop')
        self.assertEqual(exhausted['reason'], 'attempts_exhausted')
        self.assertEqual(self.event(attempt=4)['action'], 'stop')

    def test_persistent_failure_opens_source_circuit_even_for_new_queries(self):
        result = self.event(status=503)
        result = self.event(status=503, state=result['state'], now=result['not_before'], attempt=2)
        third_time = result['not_before']
        result = self.event(status=503, state=result['state'], now=third_time, attempt=3)
        self.assertEqual(result['action'], 'stop')
        self.assertGreaterEqual(result['not_before'], third_time + 300)
        other_album = self.event(url=MB + '2', state=result['state'], now=third_time + 1)
        self.assertEqual(other_album['action'], 'defer')

    def test_success_recovers_gradually_and_never_below_service_floor(self):
        result = self.event(status=503)
        raised = result['state']['sources']['musicbrainz.org']['interval']
        for index in range(3):
            result = self.event(status=200, state=result['state'], now=result['not_before'])
            interval = result['state']['sources']['musicbrainz.org']['interval']
            if index < 2:
                self.assertEqual(interval, raised)
        self.assertLess(interval, raised)
        for _ in range(9):
            result = self.event(status=200, state=result['state'], now=result['not_before'])
        self.assertEqual(result['state']['sources']['musicbrainz.org']['interval'], 1.1)

    def test_success_or_terminal_failure_never_erases_an_existing_server_pause(self):
        limited = self.event(status=429, headers={'Retry-After': '7200'})
        for status in (200, 404):
            result = self.event(status=status, state=limited['state'], now=1001)
            self.assertGreaterEqual(result['not_before'], 8200)

    def test_jitter_only_adds_bounded_delay(self):
        data = {'operation': 'observe', 'url': MB, 'now': 1000, 'attempt': 1, 'status': 429}
        low = self.throttle.evaluate(data, jitter=lambda: 0)
        high = self.throttle.evaluate(data, jitter=lambda: 1)
        self.assertGreater(high['not_before'], low['not_before'])
        self.assertLessEqual(high['wait_seconds'], low['wait_seconds'] * 1.25 + 1e-9)

    def test_unvalidated_304_is_not_reported_as_complete(self):
        self.assertEqual(self.event(status=304)['action'], 'stop')
        self.assertEqual(self.event(status=304, cache_available=True)['action'], 'complete')

    def test_aliases_share_quota_and_minimum_override_only_slows_requests(self):
        result = self.event(status=503)
        self.assertEqual(self.event(url='https://WWW.MUSICBRAINZ.ORG/ws/2/artist',
                                    state=result['state'])['action'], 'wait')
        slower = self.event(status=200, minimum_interval=10)
        slower = self.event(status=200, state=slower['state'], now=slower['not_before'])
        self.assertGreaterEqual(slower['wait_seconds'], 10)
        self.assertGreaterEqual(self.event(url=ITUNES, status=200, minimum_interval=0.1)['wait_seconds'], 3.1 - 1e-9)

    def test_evaluation_does_not_mutate_input_state(self):
        state = self.event(status=503)['state']
        snapshot = copy.deepcopy(state)
        self.event(status=200, state=state, now=1010)
        self.assertEqual(state, snapshot)

    def test_reference_tables_are_the_policy_source(self):
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / 'requests.md'
            text = REFERENCE.read_text()
            changed = text.replace('| `itunes.apple.com` | 3.1 |', '| `itunes.apple.com` | 5 |')
            self.assertNotEqual(text, changed)
            reference.write_text(changed)
            policy = self.throttle.read_policy(reference)
            result = self.throttle.evaluate({'operation': 'observe', 'url': ITUNES,
                'now': 1000, 'attempt': 1, 'status': 200}, policy=policy)
            self.assertEqual(result['wait_seconds'], 5)

    def test_malformed_policy_rows_fail_instead_of_silently_losing_a_service_floor(self):
        original = REFERENCE.read_text()
        for replacement in ('| itunes.apple.com | 3.1 |', '| `itunes.apple.com` | invalid |'):
            with self.subTest(replacement=replacement), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'requests.md'
                path.write_text(original.replace('| `itunes.apple.com` | 3.1 |', replacement))
                with self.assertRaises(ValueError):
                    self.throttle.read_policy(path)

    def test_policy_changes_to_response_classes_and_retry_budget_are_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'requests.md'
            path.write_text(REFERENCE.read_text()
                .replace('`408, 500, 502, 504, timeout, connection`', '`408, 409, 500, 502, 504, timeout, connection`')
                .replace('| `max_attempts` | 3 |', '| `max_attempts` | 2 |'))
            policy = self.throttle.read_policy(path)
            data = {'operation': 'observe', 'url': MB, 'now': 1000, 'attempt': 1, 'status': 409}
            self.assertEqual(self.throttle.evaluate(data, policy=policy)['action'], 'retry')
            self.assertEqual(self.throttle.evaluate({**data, 'attempt': 2}, policy=policy)['action'], 'stop')

    def test_backoff_cap_does_not_cap_a_higher_verified_floor(self):
        result = self.event(status=429)
        for _ in range(10):
            result = self.event(status=503, state=result['state'], now=result['not_before'])
        self.assertEqual(result['state']['sources']['musicbrainz.org']['interval'], 60)
        slower = self.event(status=429, minimum_interval=90)
        self.assertGreaterEqual(slower['wait_seconds'], 90)
        self.assertEqual(slower['action'], 'defer')

    def test_raising_floor_at_unix_epoch_still_updates_next_request_time(self):
        completed = self.event(status=200, now=0)
        check = self.event(state=completed['state'], now=1, minimum_interval=10)
        self.assertEqual(check['not_before'], 10)

    def test_clock_rollback_and_corrupt_source_state_are_rejected(self):
        state = self.event(status=429)['state']
        with self.assertRaises(ValueError):
            self.event(state=state, now=999)
        for updates in ({'not_before': 999}, {'interval': 0}, {'successes': -1}, {'blocked': 'false'}):
            damaged = copy.deepcopy(state)
            damaged['sources']['musicbrainz.org'].update(updates)
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                self.event(state=damaged)

    def test_oversized_server_delay_fails_closed(self):
        with self.assertRaises(ValueError):
            self.event(status=429, headers={'Retry-After': '9' * 400})

    def test_invalid_state_and_input_fail_instead_of_resetting_a_cooldown(self):
        for update in ({'attempt': 0}, {'status': 99}, {'status': True}, {'now': float('nan')},
                       {'url': 'not a URL'}, {'state': {}}, {'headers': []},
                       {'status': 429, 'error': 'timeout'}):
            data = {'operation': 'observe', 'url': MB, 'now': 1000, 'attempt': 1, 'status': 200, **update}
            with self.subTest(update=update), self.assertRaises(ValueError):
                self.throttle.evaluate(data)
        for error in ([], {}, 1):
            with self.subTest(error=error), self.assertRaises(ValueError):
                self.event(error=error)

    def test_cli_reads_and_outputs_json_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'event.json'
            raw = json.dumps({'operation': 'observe', 'url': MB, 'now': 1000,
                              'attempt': 1, 'status': 503, 'headers': {'Retry-After': '3600'}})
            path.write_text(raw)
            result = subprocess.run([sys.executable, '-B', str(SCRIPT), '--input', str(path)],
                                    cwd=root, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            decision = json.loads(result.stdout)
            self.assertEqual(decision['scope'], 'request_scheduling_only')
            self.assertEqual(decision['action'], 'defer')
            self.assertEqual(decision['not_before'], 4600)
            self.assertEqual(list(root.iterdir()), [path])
            self.assertEqual(path.read_text(), raw)

    def test_cli_rejects_bad_input_with_a_json_error(self):
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), '--input', '-'],
            input=json.dumps({'operation': 'observe', 'url': MB, 'attempt': 1, 'error': []}),
            text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(json.loads(result.stdout)['error'], 'INVALID_REQUEST_SCHEDULE')


if __name__ == '__main__':
    unittest.main()
