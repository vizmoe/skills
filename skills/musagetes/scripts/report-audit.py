#!/usr/bin/env python3
"""Read-only report projection joining current files with latest recorded outcomes."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

from library_guard import (GuardError, collision_key, fingerprint, parts, root_path,
                           source_path, unique_object)
from music_rules import read_vocabulary


def require(condition, detail):
    if not condition:
        raise ValueError(detail)


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def latest(records, files, statuses, with_outputs=True):
    result, seen = {}, set()
    keys = {'file_id', 'sequence', 'status', 'evidence'} | ({'outputs'} if with_outputs else set())
    for record in records:
        require(isinstance(record, dict) and set(record) == keys, 'Invalid outcome fields.')
        ident, sequence = record['file_id'], record['sequence']
        require(nonempty(ident) and ident in files and type(sequence) is int and sequence > 0,
                'Outcome must name a known file and positive integer sequence.')
        require((ident, sequence) not in seen and record['status'] in statuses and nonempty(record['evidence']),
                'Duplicate sequence, invalid outcome or missing evidence.')
        seen.add((ident, sequence))
        if with_outputs:
            outputs = record['outputs']
            require(isinstance(outputs, list) and all(nonempty(i) and i in files for i in outputs),
                    'Outputs must name known files.')
            require(len(outputs) == len(set(outputs)), 'Duplicate output ID.')
            if record['status'] in ('published', 'removed'):
                require(outputs, 'Completed outcome needs surviving outputs.')
                require(files[ident]['kind'] != 'audio' or all(files[i]['kind'] == 'audio' for i in outputs),
                        'Audio cannot be replaced by a document.')
        else:
            require(files[ident]['kind'] == 'cue', 'CUE outcomes must refer to CUE files.')
        if ident not in result or sequence > result[ident]['sequence']:
            result[ident] = record
    return result


def audit(root: Path, request: dict) -> dict:
    keys = {'files', 'groups', 'publications', 'cleanups', 'cues'}
    require(isinstance(request, dict) and set(request) == keys and all(isinstance(request[k], list) for k in keys),
            'Expected files, groups, publications, cleanups and cues arrays.')
    groups, files, paths = {}, {}, set()
    for group in request['groups']:
        require(isinstance(group, dict) and set(group) == {'id', 'cover'} and nonempty(group['id'])
                and group['id'] not in groups and group['cover'] in ('present', 'missing', 'unknown', 'not_applicable'),
                'Invalid or duplicate group.')
        groups[group['id']] = group
    vocabulary = read_vocabulary()
    for item in request['files']:
        require(isinstance(item, dict) and set(item) == {'id', 'group', 'path', 'sha256', 'kind', 'match_status'},
                'Invalid file fields.')
        require(nonempty(item['id']) and item['id'] not in files and nonempty(item['group']) and item['group'] in groups,
                'File needs a unique ID and known group.')
        parts(item['path'])
        key = collision_key(item['path'])
        require(key not in paths and item['kind'] in ('audio', 'cue', 'evidence'), 'Duplicate path or invalid verified kind.')
        require(isinstance(item['sha256'], str) and re.fullmatch('[0-9a-f]{64}', item['sha256']), 'Invalid file SHA-256.')
        require((item['kind'] == 'audio' and isinstance(item['match_status'], str) and item['match_status'] in vocabulary.match)
                or (item['kind'] != 'audio' and item['match_status'] is None), 'Invalid matching dimension.')
        paths.add(key)
        files[item['id']] = item
    publications = latest(request['publications'], files, ('published', 'pending'))
    cleanups = latest(request['cleanups'], files, ('removed', 'pending', 'preserved'))
    cues = latest(request['cues'], files, ('missing_source', 'duplicate', 'resolved', 'pending'), False)
    issues, actual = [], {}
    for ident, item in files.items():
        try:
            digest = fingerprint(source_path(root, item['path']))
            actual[ident] = 'present' if digest == item['sha256'] else 'changed'
            if actual[ident] == 'changed':
                issues.append({'file_id': ident, 'code': 'FILE_CHANGED', 'expected_sha256': item['sha256'], 'actual_sha256': digest})
        except FileNotFoundError:
            actual[ident] = 'missing'
        except (GuardError, OSError) as error:
            actual[ident] = 'unsafe'
            issues.append({'file_id': ident, 'code': 'FILE_UNVERIFIED', 'detail': str(error)})
    categories = {key: [] for key in ('unidentified_audio', 'partial_matches', 'missing_cover', 'unknown_cover',
                  'cue_missing_source', 'cue_duplicates', 'cue_other', 'evidence_files', 'published', 'cleaned_duplicates')}
    published, superseded, accounted = set(), set(), set()
    for outcomes, complete in ((publications, 'published'), (cleanups, 'removed')):
        for ident, event in outcomes.items():
            if event['status'] != complete:
                continue
            if not all(actual[i] == 'present' for i in event['outputs']):
                issues.append({'file_id': ident, 'code': 'OUTCOME_OUTPUT_UNVERIFIED', 'outcome': complete})
                continue
            if complete == 'removed' and actual[ident] != 'missing':
                issues.append({'file_id': ident, 'code': 'CLEANUP_NOT_APPLIED'})
                continue
            accounted.add(ident)
            if complete == 'published':
                published.update(event['outputs'])
            else:
                categories['cleaned_duplicates'].append(ident)
            if ident not in event['outputs']:
                superseded.add(ident)
    review = {}
    for ident, item in files.items():
        if actual[ident] == 'missing' and ident not in accounted:
            issues.append({'file_id': ident, 'code': 'UNEXPLAINED_MISSING_FILE'})
        if actual[ident] != 'present' or ident in superseded:
            continue
        if item['kind'] == 'audio':
            if item['match_status'] == 'UNCONFIRMED':
                categories['unidentified_audio'].append(ident)
            elif item['match_status'] == 'PARTIAL_MATCH':
                categories['partial_matches'].append(ident)
            if ident not in published:
                review.setdefault(item['group'], []).append(ident)
        elif item['kind'] == 'evidence':
            categories['evidence_files'].append(ident)
        else:
            outcome = cues.get(ident, {}).get('status')
            category = {'missing_source': 'cue_missing_source', 'duplicate': 'cue_duplicates'}.get(outcome, 'cue_other')
            categories[category].append(ident)
    categories['published'] = sorted(published)
    for ident, group in groups.items():
        if group['cover'] in ('missing', 'unknown'):
            categories['missing_cover' if group['cover'] == 'missing' else 'unknown_cover'].append(ident)
    categories = {key: sorted(values) for key, values in categories.items()}
    return {'scope': 'recorded_files_and_latest_outcomes_only', 'ok': not issues, 'issues': issues,
            'categories': categories, 'counts': {key: len(values) for key, values in categories.items()},
            'review_groups': {key: sorted(values) for key, values in sorted(review.items())}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--input', required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.read() if args.input == '-' else Path(args.input).read_text(encoding='utf-8')
        result = audit(root_path(args.root), json.loads(raw, object_pairs_hook=unique_object))
    except (ValueError, OSError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
