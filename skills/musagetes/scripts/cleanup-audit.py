#!/usr/bin/env python3
"""Read-only recovery audit for duplicate working/review copies, never a deleter."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

from library_guard import (collision_key, fingerprint, is_protected,
                           parts, root_path, source_path, unique_object)


def require(condition, detail):
    if not condition:
        raise ValueError(detail)


def file_ref(value):
    require(isinstance(value, dict) and set(value) == {'path', 'sha256'}, 'Expected path/sha256 reference.')
    parts(value['path'])
    require(isinstance(value['sha256'], str) and re.fullmatch('[0-9a-f]{64}', value['sha256']), 'Invalid SHA-256.')
    return value


def current_hash(root, relative):
    try:
        return fingerprint(source_path(root, relative))
    except FileNotFoundError:
        return None


def verify(root, ref):
    file_ref(ref)
    require(current_hash(root, ref['path']) == ref['sha256'], f"Missing or changed file: {ref['path']}")


def binding(entry):
    """Bind a receipt to the immutable plan, excluding journal stage and receipt."""
    plan = {k: v for k, v in entry.items() if k not in {'stage', 'audit'}}
    return hashlib.sha256(json.dumps(plan, sort_keys=True, ensure_ascii=True,
                                     separators=(',', ':')).encode()).hexdigest()


def equivalent(root, entry):
    proof = entry['equivalence']
    require(isinstance(proof, dict), 'Missing equivalence evidence.')
    method = proof.get('method')
    if method == 'bytes':
        require(set(proof) == {'method'} and len(entry['outputs']) == 1
                and entry['source']['sha256'] == entry['outputs'][0]['sha256'], 'Byte identity failed.')
        return
    require(method in ('pcm', 'packets') and set(proof) == {'method', 'evidence'}, 'Unsupported equivalence method.')
    verify(root, proof['evidence'])
    report = json.loads(source_path(root, proof['evidence']['path']).read_text(encoding='utf-8'),
                        object_pairs_hook=unique_object)
    require(isinstance(report, dict) and report.get('method') == method
            and report.get('source') == entry['source'] and report.get('outputs') == entry['outputs'],
            'Equivalence evidence does not bind the current ordered source/output mapping.')
    digest = report.get('source_digest')
    require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest)
            and digest == report.get('output_digest'), 'Decoded stream/packet digest mismatch.')
    require(isinstance(report.get('command'), str) and report['command'].strip(), 'Missing decoder evidence command.')


def receipt(root, entry):
    record = entry['audit']
    require(isinstance(record, dict) and set(record) == {'binding', 'snapshot', 'report'}
            and record['binding'] == binding(entry), 'Missing or stale reconciliation receipt.')
    for key in ('snapshot', 'report'):
        verify(root, record[key])


def audit(root: Path, manifest: dict, state_dirs=None) -> dict:
    require(isinstance(manifest, dict) and set(manifest) == {'schema_version', 'originals', 'entries'}
            and type(manifest['schema_version']) is int and manifest['schema_version'] == 1,
            'Expected schema_version 1, originals and entries.')
    require(isinstance(manifest['originals'], list) and manifest['originals']
            and isinstance(manifest['entries'], list) and manifest['entries'], 'Lists must be nonempty.')
    entries = manifest['entries']
    issues, results, originals, candidates, ids = [], [], set(), set(), set()
    try:
        for ref in manifest['originals']:
            verify(root, ref)
            originals.add(collision_key(ref['path']))
        for entry in entries:
            require(isinstance(entry, dict) and set(entry) == {
                'id', 'role', 'source', 'quarantine', 'outputs', 'reason', 'stage', 'equivalence', 'audit'},
                'Invalid entry keys.')
            require(isinstance(entry['id'], str) and entry['id'].strip() and entry['id'] not in ids,
                    'Entry IDs must be unique nonempty strings.')
            ids.add(entry['id'])
            file_ref(entry['source'])
            parts(entry['quarantine'])
            require(isinstance(entry['outputs'], list) and entry['outputs'], 'Missing surviving outputs.')
            output_keys = [collision_key(file_ref(ref)['path']) for ref in entry['outputs']]
            require(len(output_keys) == len(set(output_keys)), 'Duplicate output mapping.')
            for path in (entry['source']['path'], entry['quarantine']):
                key = collision_key(path)
                require(key not in candidates and key not in originals, 'Candidate aliases another candidate or original.')
                candidates.add(key)
        for entry in entries:
            for ref in entry['outputs']:
                require(collision_key(ref['path']) not in candidates, 'Output is also a cleanup candidate.')
    except (ValueError, OSError) as error:
        issues.append(str(error))
    for entry in entries:
        result = {'id': entry.get('id') if isinstance(entry, dict) else None, 'action': 'REVIEW_REQUIRED'}
        try:
            require(not issues, 'Resolve manifest-wide errors first.')
            require(entry['role'] in ('working', 'review'), 'Only proven working/review duplicates are supported.')
            require(isinstance(entry['reason'], str) and entry['reason'].strip(), 'Missing cleanup reason.')
            stage = entry['stage']
            require(stage in ('prepared', 'quarantined', 'audited', 'remove-intent', 'removed'), 'Invalid journal stage.')
            require(not is_protected(entry['source']['path'], state_dirs)
                    and is_protected(entry['quarantine'], state_dirs), 'Use a work source and protected quarantine.')
            for ref in entry['outputs']:
                require(not is_protected(ref['path'], state_dirs), 'Surviving outputs must be published outside state.')
                verify(root, ref)
            equivalent(root, entry)
            source = current_hash(root, entry['source']['path'])
            quarantine = current_hash(root, entry['quarantine'])
            expected = entry['source']['sha256']
            require(source in (None, expected) and quarantine in (None, expected), 'Candidate changed; preserve it.')
            require(not (source and quarantine), 'Both source and quarantine exist; reconcile ownership.')
            if stage in ('audited', 'remove-intent', 'removed'):
                receipt(root, entry)
                # Evidence, receipts and originals must survive the entire transaction.
                refs = [entry['audit']['snapshot'], entry['audit']['report']]
                if 'evidence' in entry['equivalence']:
                    refs.append(entry['equivalence']['evidence'])
                require(all(collision_key(ref['path']) not in candidates for ref in refs), 'Cleanup would erase its own evidence.')
            if source:
                require(stage == 'prepared', 'Source reappeared or journal is inconsistent.')
                result['action'] = 'QUARANTINE'
            elif quarantine:
                require(stage != 'removed', 'Journal claims removal while quarantine exists.')
                result['action'] = ('REMOVE_QUARANTINE' if stage == 'remove-intent' else
                                    'RECORD_REMOVE_INTENT' if stage == 'audited' else 'RECONCILE')
            else:
                require(stage in ('remove-intent', 'removed'), 'Copies disappeared without audited removal intent.')
                result['action'] = 'COMPLETE'
        except (ValueError, OSError) as error:
            result['issue'] = str(error)
        results.append(result)
    return {'scope': 'cleanup_files_and_evidence_bindings_only', 'ok': not issues and all('issue' not in r for r in results),
            'entries': results, 'issues': issues,
            'removed_ids': sorted(r['id'] for r in results if r['action'] == 'COMPLETE')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--input', required=True)
    parser.add_argument('--state-dir', action='append')
    args = parser.parse_args()
    try:
        raw = sys.stdin.read() if args.input == '-' else Path(args.input).read_text(encoding='utf-8')
        result = audit(root_path(args.root), json.loads(raw, object_pairs_hook=unique_object), args.state_dir)
    except (ValueError, OSError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
