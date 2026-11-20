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


def _parse_host_row(keys, value, hosts):
    aliases = [key.strip() for key in keys.split(',')]
    floor = number(float(value), 'source interval', positive=True)
    for host in aliases:
        if not host or host in hosts:
            raise ValueError('Duplicate or empty source in request policy.')
        hosts[host] = (aliases[0], floor)


def _expand_response_keys(item):
    if re.fullmatch(r'\d{3}-\d{3}', item):
        start, end = map(int, item.split('-'))
        if not 100 <= start <= end <= 599:
            raise ValueError('Invalid HTTP status range in request policy.')
        return [str(code) for code in range(start, end + 1)]
    if not re.fullmatch(r'[1-5]\d{2}|timeout|connection|tls|unknown', item):
        raise ValueError('Invalid response in request policy.')
    return [item]


def _parse_outcome_row(keys, value, outcomes):
    if not re.fullmatch(r'`[^`]+`', value):
        raise ValueError('Response categories must be backtick-delimited.')
    category = value[1:-1]
    if category not in {'success', 'throttle', 'transient', 'block', 'stop'}:
        raise ValueError('Unknown response category in request policy.')
    for item in keys.split(','):
        for key in _expand_response_keys(item.strip()):
            if key in outcomes:
                raise ValueError('Duplicate response in request policy.')
            outcomes[key] = category


def _parse_policy_row(section, line, headings, hosts, outcomes, settings):
    cells = [cell.strip() for cell in line.strip('|').split('|')]
    if len(cells) != 3:
        raise ValueError('Malformed request policy table row.')
    if cells[0] == headings[section] or re.fullmatch(r':?-+:?', cells[0]):
        return
    if not re.fullmatch(r'`[^`]+`', cells[0]):
        raise ValueError('Request policy row keys must be backtick-delimited.')
    keys, value = cells[0][1:-1], cells[1]
    if section == '来源间隔':
        _parse_host_row(keys, value, hosts)
    elif section == '响应分类':
        _parse_outcome_row(keys, value, outcomes)
    else:
        if keys in settings:
            raise ValueError('Duplicate setting in request policy.')
        settings[keys] = float(value)


def _validate_policy_settings(hosts, outcomes, settings):
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
        if line.startswith('|') and section in headings:
            _parse_policy_row(section, line, headings, hosts, outcomes, settings)
    _validate_policy_settings(hosts, outcomes, settings)
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


class _ScheduleContext:
    def __init__(self, source_key: str, source: dict, now: float, state: dict):
        self.source_key = source_key
        self.source = source
        self.now = now
        self.state = state


def retry_after(headers, now):
    value = headers.get('retry-after', '').strip()
    if re.fullmatch(r'\d+', value, re.ASCII):
        return number(float(value), 'Retry-After')
    date = http_date(value)
    if date is None:
        return None
    server_date = http_date(headers.get('date'))
    return max(0, date - (now if server_date is None else server_date))


def _parse_headers(raw_headers):
    if not isinstance(raw_headers, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in raw_headers.items()):
        raise ValueError('headers must map response header names to strings.')
    lowered = {key.lower(): value for key, value in raw_headers.items()}
    if len(lowered) != len(raw_headers):
        raise ValueError('Duplicate response header names.')
    return lowered


def _validate_operation_payload(operation, data):
    if operation == 'check':
        if 'status' in data or 'error' in data:
            raise ValueError('check cannot include a response.')
        return
    if ('status' in data) == ('error' in data):
        raise ValueError('observe requires exactly one of status or error.')
    if 'status' in data:
        status = integer(data['status'], 'status')
        if not 100 <= status <= 599:
            raise ValueError('status must be an HTTP status code.')
    elif not isinstance(data['error'], str) or data['error'] not in {'timeout', 'connection', 'tls', 'unknown'}:
        raise ValueError('Unknown transport error.')


def _parse_evaluate_input(data):
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
    lowered = _parse_headers(data.get('headers', {}))
    if type(data.get('cache_available', False)) is not bool:
        raise ValueError('cache_available must be a boolean.')
    _validate_operation_payload(operation, data)
    return operation, host, now, attempt, minimum, lowered


def _build_decision(ctx, action, reason, **details):
    number(ctx.source['not_before'], 'not_before')
    return {'scope': 'request_scheduling_only', 'action': action, 'reason': reason,
            'source': ctx.source_key, 'wait_seconds': max(0, ctx.source['not_before'] - ctx.now),
            'not_before': ctx.source['not_before'], 'state': ctx.state, **details}


def _decide_check(ctx, attempt, config):
    if attempt > config['max_attempts']:
        return _build_decision(ctx, 'stop', 'attempts_exhausted')
    wait = ctx.source['not_before'] - ctx.now
    if wait > config['max_inline_wait']:
        return _build_decision(ctx, 'defer', 'source_cooldown')
    action, reason = ('wait', 'source_pacing') if wait > 0 else ('ready', 'source_available')
    return _build_decision(ctx, action, reason)


def _update_source_on_observe(source, category, config, jitter):
    if category == 'success':
        source['failures'] = 0
        source['successes'] += 1
        if source['successes'] >= config['recovery_successes']:
            source['interval'] = max(source['minimum_interval'], source['interval'] / config['recovery_factor'])
            source['successes'] = 0
        return source['interval']
    source['successes'] = 0
    if category in {'throttle', 'transient'}:
        source['failures'] += 1
        source['interval'] = max(source['minimum_interval'], min(config['max_interval'],
                                 source['interval'] * config['backoff_factor']))
        noise = number(jitter(), 'jitter')
        if noise > 1:
            raise ValueError('jitter must be between 0 and 1.')
        delay = source['interval'] * (1 + config['jitter_ratio'] * noise)
        if source['failures'] >= config['circuit_failures']:
            return max(delay, config['circuit_seconds'])
        return delay
    if category == 'block':
        source['blocked'] = True
    return source['interval']


def _decide_observe(ctx, attempt, category, retry_seconds, config):
    details = {'category': category, 'retry_after_seconds': retry_seconds}
    if category == 'success':
        return _build_decision(ctx, 'complete', 'transport_success', **details)
    if category == 'block':
        return _build_decision(ctx, 'blocked', 'source_access_blocked', **details)
    if category in {'throttle', 'transient'}:
        if attempt >= config['max_attempts']:
            return _build_decision(ctx, 'stop', 'attempts_exhausted', **details)
        if ctx.source['not_before'] - ctx.now > config['max_inline_wait']:
            return _build_decision(ctx, 'defer', 'source_cooldown', **details)
        return _build_decision(ctx, 'retry', category, **details)
    return _build_decision(ctx, 'stop', 'response_requires_review', **details)


def evaluate(data, *, policy=None, jitter=random.random):
    operation, host, now, attempt, minimum, lowered = _parse_evaluate_input(data)
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
    ctx = _ScheduleContext(source_key, source, now, state)
    if source['blocked']:
        return _build_decision(ctx, 'blocked', 'source_access_blocked')
    if operation == 'check':
        return _decide_check(ctx, attempt, config)
    category = policy['outcomes'].get(str(data.get('status', data.get('error'))), 'stop')
    if data.get('status') == 304 and not data.get('cache_available', False):
        category = 'stop'
    retry_seconds = retry_after(lowered, now)
    source['updated_at'] = now
    delay = _update_source_on_observe(source, category, config, jitter)
    source['not_before'] = max(source['not_before'], now + delay, now + (retry_seconds or 0))
    return _decide_observe(ctx, attempt, category, retry_seconds, config)


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
