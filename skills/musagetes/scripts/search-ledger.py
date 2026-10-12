#!/usr/bin/env python3
"""Audit search coverage without executing requests or changing cached evidence."""
import argparse
import json
from pathlib import Path
import re
import runpy
import sys


def recording_fields():
    text = (Path(__file__).resolve().parent.parent / 'references/search.md').read_text(encoding='utf-8')
    rows = re.findall(r'^\| `musicbrainz-recording` \| `([^`]+)` \|$', text, re.M)
    if len(rows) != 1 or 'dur' not in rows[0].split():
        raise ValueError('Recording field table is missing or malformed.')
    fields = rows[0].split()
    if len(fields) != len(set(fields)) or any(not re.fullmatch('[a-z]+', field) for field in fields):
        raise ValueError('Invalid or duplicate recording fields.')
    return set(fields)


def query_fields(query):
    # Mask quoted and escaped characters before reading explicit field prefixes.
    visible, quoted, escaped = [], False, False
    for char in query:
        if escaped:
            visible.append(' ')
            escaped = False
        elif char == '\\':
            visible.append(' ')
            escaped = True
        elif char == '"':
            visible.append(' ')
            quoted = not quoted
        else:
            visible.append(' ' if quoted else char)
    return sorted(set(re.findall(r'\b([A-Za-z][A-Za-z0-9_]*)\s*:', ''.join(visible)))), not (quoted or escaped)


def classify(attempt, source, allowed, outcomes):
    if not isinstance(attempt, dict) or not isinstance(attempt.get('query'), str) or not attempt['query'].strip():
        raise ValueError('Each attempt needs its actual nonempty query.')
    for key in ('syntax_valid', 'response_valid'):
        if type(attempt.get(key)) is not bool:
            raise ValueError(f'{key} must be a boolean.')
    status = attempt.get('http_status')
    if status is not None and (type(status) is not int or not 100 <= status <= 599):
        raise ValueError('http_status must be an HTTP integer or null.')
    count = attempt.get('result_count')
    if count is not None and (type(count) is not int or count < 0):
        raise ValueError('result_count must be a nonnegative integer.')
    fields, balanced = query_fields(attempt['query'])
    if (not attempt['syntax_valid'] or not balanced or (source == 'musicbrainz-recording'
            and (set(fields) - allowed or ('dur' in fields and attempt.get('duration_unit') != 'ms')))):
        outcome = 'INVALID_QUERY'
    elif outcomes.get(str(status if status is not None else attempt.get('transport_error'))) in {'throttle', 'transient'}:
        outcome = 'TEMPORARY_FAILURE'
    elif status is None or not 200 <= status < 300 or not attempt['response_valid']:
        outcome = 'FAILED'
    else:
        if count is None or type(attempt.get('pages_complete')) is not bool:
            raise ValueError('A valid response requires result_count and pages_complete.')
        outcome = 'INCOMPLETE' if not attempt['pages_complete'] else ('HIT' if count else 'ZERO')
    return {'status': outcome, 'fields': fields}


def audit(data):
    if not isinstance(data, dict) or not isinstance(data.get('routes'), list) or not data['routes']:
        raise ValueError('Expected a nonempty routes list.')
    allowed = recording_fields()
    # Reuse the scheduler's parsed response policy rather than a second status list.
    scheduler = runpy.run_path(str(Path(__file__).with_name('source-throttle.py')))
    outcomes = scheduler['read_policy']()['outcomes']
    completed, pending, results, seen = [], [], [], set()
    errors = {'INVALID_QUERY', 'TEMPORARY_FAILURE', 'FAILED'}
    error_count = attempt_error_count = 0
    required_complete = True
    required_count = 0
    for route in data['routes']:
        if not isinstance(route, dict):
            raise ValueError('Each route must be an object.')
        identity, source = route.get('id'), route.get('source')
        if not isinstance(identity, str) or not identity.strip() or identity in seen:
            raise ValueError('Route IDs must be nonempty and unique.')
        if not isinstance(source, str) or not source.strip() or type(route.get('required')) is not bool or not isinstance(route.get('attempts'), list):
            raise ValueError('Route requires source, required and attempts.')
        seen.add(identity)
        attempts = [classify(item, source, allowed, outcomes) for item in route['attempts']]
        latest = attempts[-1] if attempts else {'status': 'NOT_RUN', 'fields': []}
        attempt_error_count += sum(item['status'] in errors for item in attempts)
        error_count += latest['status'] in errors
        complete = latest['status'] in {'HIT', 'ZERO'}
        (completed if complete else pending).append(identity)
        if route['required']:
            required_count += 1
            required_complete = required_complete and complete
        results.append({'id': identity, 'required': route['required'], **latest})
    coverage_complete = bool(required_count) and required_complete
    return {'scope': 'search_coverage_only', 'routes': results, 'completed_routes': completed,
            'pending': pending, 'coverage_complete': coverage_complete,
            'no_results': coverage_complete and all(item['status'] == 'ZERO' for item in results),
            'error_count': error_count, 'attempt_error_count': attempt_error_count}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, help='JSON path or - for stdin')
    args = parser.parse_args()
    try:
        raw = sys.stdin.read() if args.input == '-' else Path(args.input).read_text(encoding='utf-8')
        result = audit(json.loads(raw))
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result['coverage_complete'] else 1
    except (ValueError, OSError) as error:
        print(json.dumps({'error': 'INVALID_SEARCH_LEDGER', 'message': str(error)}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
