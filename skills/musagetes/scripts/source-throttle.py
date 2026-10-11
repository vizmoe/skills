#!/usr/bin/env python3
"""Read-only scheduling decisions for musagetes' externally executed requests."""
from __future__ import annotations

import argparse
import copy
from datetime import timezone
from email.utils import parsedate_to_datetime
import json
import math
from pathlib import Path
import random
import re
import sys
import time
from urllib.parse import urlsplit


def number(value, name, *, positive=False):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value < 0 or (positive and value == 0)):
        raise ValueError(f'{name} must be a finite {"positive" if positive else "nonnegative"} number.')
    return value


def integer(value, name, *, positive=False):
    number(value, name, positive=positive)
    if not isinstance(value, int):
        raise ValueError(f'{name} must be an integer.')
    return value


def read_policy(path=None):
    """Read service floors, response classes and tuning from the shipped reference."""
    path = path or Path(__file__).resolve().parent.parent / 'references/requests.md'
    hosts, outcomes, settings = {}, {}, {}
    headings = {'来源间隔': '主机（逗号分隔别名，首项为状态键）',
                '响应分类': '响应码或传输错误', '调度参数': '参数'}
    section = None
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.startswith('## '):
            section = line[3:].strip()
        if not line.startswith('|') or section not in headings:
            continue
        cells = [cell.strip() for cell in line.strip('|').split('|')]
        if len(cells) != 3:
            raise ValueError('Malformed request policy table row.')
        if cells[0] == headings[section] or re.fullmatch(r':?-+:?', cells[0]):
            continue
        if not re.fullmatch(r'`[^`]+`', cells[0]):
            raise ValueError('Request policy row keys must be backtick-delimited.')
        cells[0] = cells[0][1:-1]
        keys, value, _ = cells
        if section == '来源间隔':
            aliases = [key.strip() for key in keys.split(',')]
            floor = number(float(value), 'source interval', positive=True)
            for host in aliases:
                if not host or host in hosts:
                    raise ValueError('Duplicate or empty source in request policy.')
                hosts[host] = (aliases[0], floor)
        elif section == '响应分类':
            if not re.fullmatch(r'`[^`]+`', value):
                raise ValueError('Response categories must be backtick-delimited.')
            value = value[1:-1]
            if value not in {'success', 'throttle', 'transient', 'block', 'stop'}:
                raise ValueError('Unknown response category in request policy.')
            for item in keys.split(','):
                item = item.strip()
                if re.fullmatch(r'\d{3}-\d{3}', item):
                    start, end = map(int, item.split('-'))
                    if not 100 <= start <= end <= 599:
                        raise ValueError('Invalid HTTP status range in request policy.')
                    expanded = [str(code) for code in range(start, end + 1)]
                else:
                    if not re.fullmatch(r'[1-5]\d{2}|timeout|connection|tls|unknown', item):
                        raise ValueError('Invalid response in request policy.')
                    expanded = [item]
                for key in expanded:
                    if key in outcomes:
                        raise ValueError('Duplicate response in request policy.')
                    outcomes[key] = value
        else:
            if keys in settings:
                raise ValueError('Duplicate setting in request policy.')
            settings[keys] = float(value)
    counts = {'max_attempts', 'recovery_successes', 'circuit_failures'}
    expected = counts | {'backoff_factor', 'max_interval', 'jitter_ratio',
                         'recovery_factor', 'circuit_seconds', 'max_inline_wait'}
    if set(settings) != expected or '*' not in hosts or not outcomes:
        raise ValueError('Request policy must declare sources, response classes and all settings.')
    for key, value in settings.items():
        number(value, key, positive=key != 'jitter_ratio')
        if key in counts:
            if not value.is_integer():
                raise ValueError(f'{key} must be an integer.')
            settings[key] = int(value)
    if settings['backoff_factor'] <= 1 or settings['recovery_factor'] <= 1 or settings['jitter_ratio'] > 1:
        raise ValueError('Invalid backoff/recovery factor or jitter ratio.')
    return {'hosts': hosts, 'outcomes': outcomes, 'settings': settings}


def read_state(raw):
    if raw is None:
        return {'schema_version': 1, 'sources': {}}
    if (not isinstance(raw, dict) or set(raw) != {'schema_version', 'sources'}
            or type(raw['schema_version']) is not int or raw['schema_version'] != 1
            or not isinstance(raw['sources'], dict)):
        raise ValueError('Invalid scheduling state; restore the last valid state instead of resetting it.')
    fields = {'minimum_interval', 'interval', 'successes', 'failures', 'not_before', 'updated_at', 'blocked'}
    for host, source in raw['sources'].items():
        if not isinstance(host, str) or not host or not isinstance(source, dict) or set(source) != fields:
            raise ValueError('Invalid source state.')
        for key in ('minimum_interval', 'interval', 'not_before', 'updated_at'):
            number(source[key], key, positive=key in {'minimum_interval', 'interval'})
        for key in ('successes', 'failures'):
            integer(source[key], key)
        if (type(source['blocked']) is not bool or source['interval'] < source['minimum_interval']
                or source['not_before'] < source['updated_at']):
            raise ValueError('Inconsistent source state.')
    return copy.deepcopy(raw)


def http_date(value):
    try:
        parsed = parsedate_to_datetime(value)
        return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).timestamp()
    except (TypeError, ValueError, OverflowError):
        return None


def retry_after(headers, now):
    value = headers.get('retry-after', '').strip()
    if re.fullmatch(r'[0-9]+', value):
        return number(float(value), 'Retry-After')
    date = http_date(value)
    if date is None:
        return None
    server_date = http_date(headers.get('date'))
    return max(0, date - (now if server_date is None else server_date))


def evaluate(data, *, policy=None, jitter=random.random):
    allowed = {'operation', 'url', 'now', 'attempt', 'state', 'minimum_interval',
               'status', 'error', 'headers', 'cache_available'}
    if not isinstance(data, dict) or set(data) - allowed:
        raise ValueError('Expected a scheduling event with documented input keys.')
    operation = data.get('operation')
    if not isinstance(operation, str) or operation not in {'check', 'observe'}:
        raise ValueError('operation must be check or observe.')
    url = data.get('url')
    if not isinstance(url, str):
        raise ValueError('url must be an HTTP(S) URL.')
    parsed = urlsplit(url)
    if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError('url must be an HTTP(S) URL without embedded credentials.')
    host = parsed.hostname.lower().rstrip('.')
    now = number(data.get('now', time.time()), 'now')
    attempt = integer(data.get('attempt'), 'attempt', positive=True)
    minimum = number(data.get('minimum_interval', 0), 'minimum_interval')
    headers = data.get('headers', {})
    if not isinstance(headers, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in headers.items()):
        raise ValueError('headers must map response header names to strings.')
    lowered = {key.lower(): value for key, value in headers.items()}
    if len(lowered) != len(headers):
        raise ValueError('Duplicate response header names.')
    if type(data.get('cache_available', False)) is not bool:
        raise ValueError('cache_available must be a boolean.')
    if operation == 'check' and ('status' in data or 'error' in data):
        raise ValueError('check cannot include a response.')
    if operation == 'observe':
        if ('status' in data) == ('error' in data):
            raise ValueError('observe requires exactly one of status or error.')
        if 'status' in data:
            status = integer(data['status'], 'status')
            if not 100 <= status <= 599:
                raise ValueError('status must be an HTTP status code.')
        elif not isinstance(data['error'], str) or data['error'] not in {'timeout', 'connection', 'tls', 'unknown'}:
            raise ValueError('Unknown transport error.')

    policy = policy or read_policy()
    config = policy['settings']
    source_key, floor = policy['hosts'].get(host, (host, policy['hosts']['*'][1]))
    state = read_state(data.get('state'))
    source = state['sources'].setdefault(source_key, {
        'minimum_interval': floor, 'interval': floor, 'successes': 0, 'failures': 0,
        'not_before': 0, 'updated_at': 0, 'blocked': False})
    if now < source['updated_at']:
        raise ValueError('now predates the latest source observation; reconcile the clock/state first.')
    source['minimum_interval'] = max(source['minimum_interval'], floor, minimum)
    source['interval'] = max(source['interval'], source['minimum_interval'])
    if source['not_before']:
        source['not_before'] = max(source['not_before'], source['updated_at'] + source['interval'])

    def result(action, reason, **details):
        number(source['not_before'], 'not_before')
        return {'scope': 'request_scheduling_only', 'action': action, 'reason': reason,
                'source': source_key, 'wait_seconds': max(0, source['not_before'] - now),
                'not_before': source['not_before'], 'state': state, **details}

    if source['blocked']:
        return result('blocked', 'source_access_blocked')
    if operation == 'check':
        if attempt > config['max_attempts']:
            return result('stop', 'attempts_exhausted')
        wait = source['not_before'] - now
        if wait > config['max_inline_wait']:
            return result('defer', 'source_cooldown')
        return result('wait', 'source_pacing') if wait > 0 else result('ready', 'source_available')

    category = policy['outcomes'].get(str(data.get('status', data.get('error'))), 'stop')
    if data.get('status') == 304 and not data.get('cache_available', False):
        category = 'stop'
    retry_seconds = retry_after(lowered, now)
    source['updated_at'] = now
    if category == 'success':
        source['failures'] = 0
        source['successes'] += 1
        if source['successes'] >= config['recovery_successes']:
            source['interval'] = max(source['minimum_interval'], source['interval'] / config['recovery_factor'])
            source['successes'] = 0
    else:
        source['successes'] = 0
    delay = source['interval']
    if category in {'throttle', 'transient'}:
        source['failures'] += 1
        source['interval'] = max(source['minimum_interval'], min(config['max_interval'],
                                 source['interval'] * config['backoff_factor']))
        noise = number(jitter(), 'jitter')
        if noise > 1:
            raise ValueError('jitter must be between 0 and 1.')
        delay = source['interval'] * (1 + config['jitter_ratio'] * noise)
        if source['failures'] >= config['circuit_failures']:
            delay = max(delay, config['circuit_seconds'])
    if category == 'block':
        source['blocked'] = True
    source['not_before'] = max(source['not_before'], now + delay, now + (retry_seconds or 0))
    details = {'category': category, 'retry_after_seconds': retry_seconds}
    if category == 'success':
        return result('complete', 'transport_success', **details)
    if category == 'block':
        return result('blocked', 'source_access_blocked', **details)
    if category in {'throttle', 'transient'}:
        if attempt >= config['max_attempts']:
            return result('stop', 'attempts_exhausted', **details)
        if source['not_before'] - now > config['max_inline_wait']:
            return result('defer', 'source_cooldown', **details)
        return result('retry', category, **details)
    return result('stop', 'response_requires_review', **details)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, help='JSON event path, or - for stdin')
    args = parser.parse_args()
    try:
        raw = sys.stdin.read() if args.input == '-' else Path(args.input).read_text(encoding='utf-8')
        output = evaluate(json.loads(raw))
        print(json.dumps(output, ensure_ascii=False, allow_nan=False))
        return 0
    except (OSError, ValueError, OverflowError) as error:
        print(json.dumps({'error': 'INVALID_REQUEST_SCHEDULE', 'message': str(error)}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
