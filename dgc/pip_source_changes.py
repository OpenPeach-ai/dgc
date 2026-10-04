"""Bounded committed-tree differences pinned for audits, never adaptive authority.

This lists paths/status only. It neither reads the working tree nor runs external
text conversion, rename heuristics, hooks, filters or lazy remote object fetches.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import PurePosixPath
import re
import signal
import subprocess
import threading
import time

from .workspace_registry import RegistryError

MAX_SNAPSHOT_BYTES = 8192
MAX_GIT_BYTES = 1024 * 1024
MAX_CHANGES = 10000
MAX_PATHS = 64
MAX_PATH_BYTES = 1024
GIT_TIMEOUT = 10.0
_KEYS = frozenset({'schema_version', 'baseline_checkpoint_id', 'baseline_revision', 'source_revision',
                  'comparison', 'status', 'reason', 'changes', 'total_changes', 'omitted_changes', 'digest'})
_REASONS = frozenset({'no_checkpoint', 'baseline_unavailable', 'comparison_unavailable',
                      'comparison_timeout', 'metadata_limit', 'unsupported_path', 'invalid_metadata'})
_STATUS = {'A': 'added', 'D': 'deleted', 'M': 'modified', 'T': 'type_changed'}
_SHA = re.compile(r'[0-9a-f]{40}|[0-9a-f]{64}')
_HEADER = re.compile(rb':([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([ADMT])')


def _bad(message='The pinned source-change reference is invalid.'):
    return RegistryError('invalid_source_changes', message)


def _revision(value):
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise _bad('Source changes require exact committed source identities.')
    return value


def _baseline(previous):
    if not isinstance(previous, dict) or 'checkpoint' not in previous:
        raise _bad('Source changes require the pinned audit checkpoint envelope.')
    checkpoint = previous['checkpoint']
    if checkpoint is None:
        return None, None
    if not isinstance(checkpoint, dict) or type(checkpoint.get('id')) is not int or not 1 <= checkpoint['id'] <= 2**63 - 1:
        raise _bad('The source-change baseline checkpoint identity is invalid.')
    return checkpoint['id'], _revision(checkpoint.get('source_revision'))


def _path(value):
    if not isinstance(value, str) or not value or len(value) > MAX_PATH_BYTES:
        raise _bad('A changed path exceeds the bounded path format.')
    try:
        raw = value.encode('utf-8', 'strict')
    except UnicodeError as exc:
        raise _bad('A changed path must be valid UTF-8.') from exc
    p = PurePosixPath(value)
    if (len(raw) > MAX_PATH_BYTES or p.is_absolute() or not p.parts or p.as_posix() != value
            or any(part in ('.', '..') or part.lower() == '.git' for part in p.parts)
            or '\\' in value or ':' in value or '\x00' in value):
        raise _bad('A changed path is unsafe or ambiguous.')
    return value


def _encoded(value):
    try:
        result = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise _bad() from exc
    if len(result) > MAX_SNAPSHOT_BYTES:
        raise RegistryError('source_changes_limit', 'The source-change reference exceeds 8 KiB.')
    return result


def _pin(value):
    digest = hashlib.sha256(_encoded(value)).hexdigest()
    return json.loads(_encoded({**value, 'digest': digest}))


def validate_snapshot(value, *, source_revision, previous_checkpoint):
    """Check closed fields, provenance, whole paths, counts, digest and byte budget."""
    expected_id, expected_old = _baseline(previous_checkpoint)
    _revision(source_revision)
    if not isinstance(value, dict) or len(value) != len(_KEYS) or set(value) != _KEYS:
        raise _bad()
    if (type(value['schema_version']) is not int or value['schema_version'] != 1
            or value['baseline_checkpoint_id'] != expected_id
            or type(value['baseline_checkpoint_id']) is not type(expected_id)
            or value['baseline_revision'] != expected_old or value['source_revision'] != source_revision
            or value['comparison'] != 'commit_trees' or value['status'] not in ('compared', 'unavailable')):
        raise _bad('The source-change reference does not match this run and checkpoint.')
    changes = value['changes']
    if not isinstance(changes, list) or len(changes) > MAX_PATHS:
        raise _bad()
    prior = None
    for item in changes:
        if not isinstance(item, dict) or set(item) != {'status', 'path'} or item['status'] not in _STATUS.values():
            raise _bad()
        _path(item['path'])
        key = item['path'].encode('utf-8')
        if prior is not None and key <= prior:
            raise _bad('Changed paths must be unique and in Git byte order.')
        prior = key
    if value['status'] == 'unavailable':
        if (not isinstance(value['reason'], str) or value['reason'] not in _REASONS or changes or value['total_changes'] is not None or value['omitted_changes'] is not None
                or ((expected_id is None) != (value['reason'] == 'no_checkpoint'))):
            raise _bad('Unavailable comparisons must not claim an empty or complete diff.')
    elif (expected_id is None or value['reason'] is not None or type(value['total_changes']) is not int
          or not len(changes) <= value['total_changes'] <= MAX_CHANGES
          or type(value['omitted_changes']) is not int or value['omitted_changes'] != value['total_changes'] - len(changes)
          or (expected_old == source_revision and value['total_changes'] != 0)):
        raise _bad('Source-change counts do not match their complete path records.')
    digest = value['digest']
    if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise _bad()
    raw = {key: item for key, item in value.items() if key != 'digest'}
    if hashlib.sha256(_encoded(raw)).hexdigest() != digest:
        raise _bad('The pinned source-change reference digest does not match.')
    _encoded(value)
    return value


class _Unavailable(Exception):
    def __init__(self, reason):
        self.reason = reason


def _capture(root, args, maximum, *, deadline=None):
    """Read at most maximum+1 bytes; a watchdog kills/reaps the owned Git group."""
    env = {key: os.environ[key] for key in ('PATH', 'SYSTEMROOT', 'WINDIR', 'LANG') if key in os.environ}
    env.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_TERMINAL_PROMPT': '0',
                'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1',
                'GIT_ALLOW_PROTOCOL': '', 'GIT_PAGER': 'cat'})
    argv = ['git', '-c', 'core.hooksPath=' + os.devnull, '-c', 'core.fsmonitor=false',
            '-c', 'protocol.allow=never', '-C', str(root), *args]
    deadline = time.monotonic() + GIT_TIMEOUT if deadline is None else deadline
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _Unavailable('comparison_timeout')
    try:
        proc = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, start_new_session=os.name == 'posix')
    except OSError as exc:
        raise _Unavailable('comparison_unavailable') from exc
    timed_out = threading.Event()
    def kill():
        if proc.poll() is not None:
            return
        try:
            if os.name == 'posix': os.killpg(proc.pid, signal.SIGKILL)
            else: proc.kill()
        except ProcessLookupError:
            pass
    def expire():
        timed_out.set(); kill()
    timer = threading.Timer(remaining, expire); timer.daemon = True
    try:
        timer.start()
        try:
            raw = proc.stdout.read(maximum + 1)
        except OSError as exc:
            raise _Unavailable('comparison_unavailable') from exc
        if len(raw) > maximum:
            raise _Unavailable('metadata_limit')
        try:
            code = proc.wait(timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as exc:
            raise _Unavailable('comparison_timeout') from exc
        if timed_out.is_set():
            raise _Unavailable('comparison_timeout')
        return code, raw
    finally:
        timer.cancel()
        kill()
        proc.wait()
        proc.stdout.close()


def _parse(raw):
    if len(raw) > MAX_GIT_BYTES or raw.count(b'\0') > MAX_CHANGES * 2:
        raise _Unavailable('metadata_limit')
    if not raw:
        return []
    if not raw.endswith(b'\0'):
        raise _Unavailable('invalid_metadata')
    records = raw[:-1].split(b'\0')
    if len(records) % 2:
        raise _Unavailable('invalid_metadata')
    result, prior = [], None
    for index in range(0, len(records), 2):
        header, name = records[index:index + 2]
        match = _HEADER.fullmatch(header)
        if match is None:
            raise _Unavailable('invalid_metadata')
        if len(name) > MAX_PATH_BYTES:
            raise _Unavailable('unsupported_path')
        try:
            path = _path(name.decode('utf-8', 'strict'))
        except (RegistryError, UnicodeError) as exc:
            raise _Unavailable('unsupported_path') from exc
        if prior is not None and name <= prior:
            raise _Unavailable('invalid_metadata')
        prior = name
        result.append({'status': _STATUS[match.group(5).decode('ascii')], 'path': path})
    return result


def snapshot(root, source_revision, previous_checkpoint):
    """Pin a bounded comparison or a truthful unavailable marker. No tree writes."""
    revision = _revision(source_revision)
    checkpoint_id, baseline = _baseline(previous_checkpoint)
    value = {'schema_version': 1, 'baseline_checkpoint_id': checkpoint_id, 'baseline_revision': baseline,
             'source_revision': revision, 'comparison': 'commit_trees', 'status': 'unavailable',
             'reason': 'no_checkpoint', 'changes': [], 'total_changes': None, 'omitted_changes': None}
    if checkpoint_id is None:
        return _pin(value)
    try:
        if baseline == revision:
            changes = []
        else:
            deadline = time.monotonic() + GIT_TIMEOUT
            code, output = _capture(root, ['cat-file', '-t', baseline], 32, deadline=deadline)
            if code or output != b'commit\n':
                raise _Unavailable('baseline_unavailable')
            code, output = _capture(root, ['diff-tree', '--no-commit-id', '--raw', '-r', '-z', '--no-abbrev',
                '--no-renames', '--no-ext-diff', '--no-textconv', baseline, revision, '--'], MAX_GIT_BYTES, deadline=deadline)
            if code:
                raise _Unavailable('comparison_unavailable')
            changes = _parse(output)
        value.update(status='compared', reason=None, total_changes=len(changes), omitted_changes=len(changes))
        for item in changes[:MAX_PATHS]:
            value['changes'].append(item); value['omitted_changes'] -= 1
            try:
                _pin(value)
            except RegistryError as exc:
                value['changes'].pop(); value['omitted_changes'] += 1
                if exc.code != 'source_changes_limit': raise
                break
    except _Unavailable as exc:
        value.update(status='unavailable', reason=exc.reason, changes=[], total_changes=None, omitted_changes=None)
    result = _pin(value)
    return validate_snapshot(result, source_revision=revision, previous_checkpoint=previous_checkpoint)


def _source_domains(source, previous_checkpoint):
    from .pip_sources import validate_pin, from_record
    current = validate_pin(source)
    if not isinstance(previous_checkpoint, dict) or 'checkpoint' not in previous_checkpoint:
        raise _bad('Source changes require the pinned audit checkpoint envelope.')
    previous = previous_checkpoint['checkpoint']
    if previous is None:
        return current, None, None
    if (not isinstance(previous, dict) or type(previous.get('id')) is not int
            or not 1 <= previous['id'] <= 2**63 - 1):
        raise _bad('The source-change baseline checkpoint identity is invalid.')
    return current, from_record(previous), previous['id']


def _unavailable_source(current, previous, checkpoint_id):
    return {'schema_version': 2, 'baseline_checkpoint_id': checkpoint_id,
            'source': current, 'baseline_source': previous, 'comparison': 'commit_trees',
            'status': 'unavailable', 'reason': 'current_tree_source',
            'changes': [], 'total_changes': None, 'omitted_changes': None}


def snapshot_for_source(root, source, previous_checkpoint):
    """Preserve v1 Git comparisons; explicitly report unsupported snapshot diffs."""
    current, previous, checkpoint_id = _source_domains(source, previous_checkpoint)
    if (current['source_policy']['mode'] == 'committed_only'
            and (previous is None or previous['source_policy']['mode'] == 'committed_only')):
        return snapshot(root, current['source_revision'], previous_checkpoint)
    return _pin(_unavailable_source(current, previous, checkpoint_id))


def validate_for_source(value, source, previous_checkpoint):
    """Validate against exact source pins; hashes never turn snapshots into commits."""
    current, previous, checkpoint_id = _source_domains(source, previous_checkpoint)
    if (current['source_policy']['mode'] == 'committed_only'
            and (previous is None or previous['source_policy']['mode'] == 'committed_only')):
        return validate_snapshot(value, source_revision=current['source_revision'], previous_checkpoint=previous_checkpoint)
    expected = _pin(_unavailable_source(current, previous, checkpoint_id))
    if (not isinstance(value, dict) or type(value.get('schema_version')) is not int
            or value != expected):
        raise _bad('Current-tree source must explicitly report that committed-tree comparison is unavailable.')
    return expected
