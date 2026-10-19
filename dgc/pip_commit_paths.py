"""Bounded committed-path metadata contracts; no dispatch or observer writes."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import time

from .workspace_registry import RegistryError

RULES_MAX_BYTES = 2048
COMPARISON_MAX_BYTES = 2048
MATCH_MAX_BYTES = 4096
PROBE_MAX_BYTES = 1024
MANIFEST_MAX_BYTES = 131072
EVENT = 'committed_paths_changed'
EVENT_TYPE = 'workspace_committed_paths_changed'
RULES_DOMAIN = b'dgc.pips.commit_paths.rules.v1\0'
COMPARISON_DOMAIN = b'dgc.pips.commit_paths.comparison.v1\0'
MATCH_DOMAIN = b'dgc.pips.commit_paths.match.v1\0'
_COMPARISON_FIELDS = {'schema_version','comparison','before_revision','after_revision','policy_digest',
                      'status','reason','changed_entries','matched_rule_indices','digest'}
_COMPARISON_REASONS = {'baseline_unavailable','comparison_unavailable','comparison_timeout',
                       'metadata_limit','unsupported_path','invalid_metadata','root_changed'}
_PROBE_FIELDS = {'schema_version','checked_at','status','reason','before_revision','after_revision',
                 'policy_digest','comparison_digest'}
_MATCH_FIELDS = {'schema_version','pip_id','workspace_id','job_version','binding_id','binding_digest',
                 'source_ref','policy_digest','observed_at','comparison','digest'}
_OCCURRENCE = {'job_version','expected_after_seq','checked_at','event','history_may_be_incomplete'}
_JOB_FIELDS = {'name','goal','source_ref','pip_type','model_choice','source_policy'}


def _fail(message='The committed-path trigger metadata is invalid.', code='invalid_commit_paths'):
    raise RegistryError(code, message)


def _encode(value, maximum):
    """Check direct-call values before serializing; never stringify hostile text."""
    pending, count, size = [(value, 0)], 0, 0
    while pending:
        item, depth = pending.pop(); count += 1
        if count > 65536 or depth > 24: _fail('Committed-path metadata exceeds its structural bound.')
        kind = type(item)
        if kind in (dict, list):
            if len(item) > 16384: _fail()
            # A lower bound, including exact separators. Escaping can only add
            # bytes; final serialization enforces the exact acceptance limit.
            size += 2 + max(0, len(item)-1) + (len(item) if kind is dict else 0)
            if kind is dict:
                for key, child in item.items():
                    if type(key) is not str: _fail()
                    pending.extend(((key, depth+1), (child, depth+1)))
            else: pending.extend((child, depth+1) for child in item)
        elif kind is str:
            if len(item) > maximum: _fail('Committed-path text exceeds its byte bound.')
            try: size += len(item.encode('utf-8')) + 2
            except UnicodeError: _fail('Committed-path metadata requires valid Unicode.')
        elif kind is int:
            if not -(2**63) <= item < 2**63: _fail()
            size += len(str(item))
        elif kind is float:
            if not math.isfinite(item): _fail()
            size += 1
        elif kind is bool: size += 4 if item else 5
        elif kind is type(None): size += 4
        else: _fail()
        if size > maximum: _fail('Committed-path metadata exceeds its byte bound.')
    try: raw = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')
    except (ValueError, UnicodeError, RecursionError): _fail()
    if len(raw) > maximum: _fail('Committed-path metadata exceeds its byte bound.')
    return raw


def _load(raw, maximum):
    if type(raw) is not str or len(raw) > maximum: _fail('Saved committed-path metadata is unavailable or oversized.')
    try:
        if len(raw.encode('utf-8')) > maximum: _fail()
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result: _fail('Saved committed-path metadata has duplicate fields.')
                result[key] = value
            return result
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: _fail())
    except (ValueError, UnicodeError, RecursionError): _fail()
    _encode(value, maximum)
    if type(value) is not dict: _fail()
    return value


def _integer(value, low=0, high=9007199254740991):
    if type(value) is not int or not low <= value <= high: _fail()
    return value


def _hash(value):
    if type(value) is not str or re.fullmatch('[0-9a-f]{64}', value) is None: _fail()
    return value


def _revision(value):
    if type(value) is not str or re.fullmatch('[0-9a-f]{40}|[0-9a-f]{64}', value) is None: _fail()
    return value


def _id(value, prefix):
    if type(value) is not str or re.fullmatch(prefix+'_[0-9a-f]{32}', value) is None: _fail()
    return value


def _time(value):
    from .pip_schedules import timestamp
    if type(value) is not str or len(value) != 24 or timestamp(value) != value: _fail()
    return value


def _ref(value):
    if (type(value) is not str or not 1 <= len(value) <= 200
            or re.fullmatch('[A-Za-z0-9][A-Za-z0-9._/-]*', value) is None or '..' in value): _fail()
    return value


def _path(value, maximum, *, rule=False):
    if type(value) is not str or not 1 <= len(value) <= maximum: _fail()
    try: raw = value.encode('utf-8')
    except UnicodeError: _fail()
    path = PurePosixPath(value)
    if (len(raw) > maximum or path.is_absolute() or not path.parts or path.as_posix() != value
            or any(part in ('.','..') or part.lower() == '.git' for part in path.parts)
            or any(ord(c) < 32 or ord(c) == 127 for c in value)
            or '\\' in value or ':' in value or value != value.strip()
            or (rule and any(c in '*?[]' for c in value))): _fail()
    return value


def validate_rules(value):
    if type(value) is not list or not 1 <= len(value) <= 32: _fail('Choose one to 32 exact paths or directory prefixes.')
    result, seen = [], set()
    for item in value:
        if type(item) is not dict or set(item) != {'kind','path'} or type(item['kind']) is not str or item['kind'] not in ('exact','directory'): _fail()
        path = _path(item['path'], 256, rule=True)
        if path in seen: _fail('Committed-path rules must have distinct paths.')
        seen.add(path); result.append({'kind':item['kind'], 'path':path})
    result.sort(key=lambda item:(item['path'].encode('utf-8'), item['kind']))
    _encode(result, RULES_MAX_BYTES)
    return result


def _digest(value, maximum, domain):
    return hashlib.sha256(domain + _encode(value, maximum)).hexdigest()


def rules_digest(rules):
    return _digest(validate_rules(rules), RULES_MAX_BYTES, RULES_DOMAIN)


def _seal(value, maximum, domain):
    result = {**value, 'digest':_digest(value, maximum, domain)}
    _encode(result, maximum)
    return result


def validate_comparison(value, *, before_revision, after_revision, rules):
    rules = validate_rules(rules)
    _revision(before_revision); _revision(after_revision)
    if type(value) is not dict or set(value) != _COMPARISON_FIELDS: _fail()
    _encode(value, COMPARISON_MAX_BYTES)
    if (type(value['schema_version']) is not int or value['schema_version'] != 1
            or value['comparison'] != 'commit_trees' or value['before_revision'] != before_revision
            or value['after_revision'] != after_revision or value['policy_digest'] != rules_digest(rules)
            or type(value['status']) is not str or value['status'] not in ('matched','unmatched','unavailable')): _fail()
    indices = value['matched_rule_indices']
    if type(indices) is not list or len(indices) > len(rules): _fail()
    for index in indices: _integer(index, 0, len(rules)-1)
    if indices != sorted(set(indices)): _fail()
    if value['status'] == 'unavailable':
        if type(value['reason']) is not str or value['reason'] not in _COMPARISON_REASONS or value['changed_entries'] is not None or indices: _fail()
    else:
        _integer(value['changed_entries'], 0, 10000)
        if (value['reason'] is not None or (value['status'] == 'matched') != bool(indices)
                or (indices and value['changed_entries'] == 0)
                or (before_revision == after_revision and (value['changed_entries'] != 0 or indices))): _fail()
    _hash(value['digest'])
    if value['digest'] != _digest({k:v for k,v in value.items() if k != 'digest'}, COMPARISON_MAX_BYTES, COMPARISON_DOMAIN): _fail()
    return value


def compare(root, before_revision, after_revision, rules, *, deadline):
    """Compare exact Git trees; unknown/truncated metadata never becomes a match."""
    from .pip_source_changes import _capture, _parse, _Unavailable, MAX_GIT_BYTES
    _revision(before_revision); _revision(after_revision); rules = validate_rules(rules)
    if type(deadline) not in (int,float) or not math.isfinite(deadline): _fail()
    result = {'schema_version':1,'comparison':'commit_trees','before_revision':before_revision,
              'after_revision':after_revision,'policy_digest':rules_digest(rules),'status':'unavailable',
              'reason':'comparison_unavailable','changed_entries':None,'matched_rule_indices':[]}
    try:
        if time.monotonic() >= deadline: raise _Unavailable('comparison_timeout')
        location = Path(root)
        if len(str(location)) > 4096 or len(str(location).encode('utf-8')) > 4096 or not location.is_absolute():
            raise _Unavailable('comparison_unavailable')
        if location.resolve(strict=True) != location or not location.is_dir(): raise _Unavailable('comparison_unavailable')
        start = location.stat()
        code, raw = _capture(location, ['rev-parse','--show-toplevel'], 4097, deadline=deadline)
        if code or raw != str(location).encode('utf-8')+b'\n': raise _Unavailable('comparison_unavailable')
        for revision, reason in ((before_revision,'baseline_unavailable'), (after_revision,'comparison_unavailable')):
            code, raw = _capture(location, ['cat-file','-t',revision], 32, deadline=deadline)
            if code or raw != b'commit\n': raise _Unavailable(reason)
        if before_revision == after_revision: changes = []
        else:
            code, raw = _capture(location, ['diff-tree','--no-commit-id','--raw','-r','-z','--no-abbrev',
                '--no-renames','--no-ext-diff','--no-textconv',before_revision,after_revision,'--'], MAX_GIT_BYTES, deadline=deadline)
            if code: raise _Unavailable('comparison_unavailable')
            changes = _parse(raw)
        matched = set()
        for item in changes:
            try: path = _path(item['path'], 1024)
            except RegistryError as exc: raise _Unavailable('unsupported_path') from exc
            for index, rule in enumerate(rules):
                if path == rule['path'] if rule['kind'] == 'exact' else path.startswith(rule['path']+'/'):
                    matched.add(index)
        end = location.stat()
        if (location.resolve(strict=True) != location or (start.st_dev,start.st_ino) != (end.st_dev,end.st_ino)):
            raise _Unavailable('root_changed')
        if time.monotonic() >= deadline: raise _Unavailable('comparison_timeout')
        result.update(status='matched' if matched else 'unmatched', reason=None,
                      changed_entries=len(changes), matched_rule_indices=sorted(matched))
    except _Unavailable as exc:
        result['reason'] = exc.reason if exc.reason in _COMPARISON_REASONS else 'comparison_unavailable'
    except (OSError,ValueError,RuntimeError,UnicodeError):
        result['reason'] = 'comparison_unavailable'
    return validate_comparison(_seal(result, COMPARISON_MAX_BYTES, COMPARISON_DOMAIN),
        before_revision=before_revision, after_revision=after_revision, rules=rules)


def validate_probe(value, *, rules, checked_at):
    if type(value) is not dict or set(value) != _PROBE_FIELDS: _fail()
    _encode(value, PROBE_MAX_BYTES); _time(checked_at)
    if (type(value['schema_version']) is not int or value['schema_version'] != 1
            or value['checked_at'] != checked_at or value['policy_digest'] != rules_digest(rules)
            or type(value['status']) is not str or value['status'] not in ('baselined','unchanged','compared','unavailable')): _fail()
    before, after = value['before_revision'], value['after_revision']
    if before is not None: _revision(before)
    if after is not None: _revision(after)
    if value['status'] == 'unavailable':
        if (type(value['reason']) is not str or value['reason'] not in _COMPARISON_REASONS | {'root_unavailable','ref_unavailable'}
                or value['comparison_digest'] is not None): _fail()
    else:
        if value['reason'] is not None or after is None: _fail()
        if value['status'] == 'baselined' and before is not None: _fail()
        if value['status'] == 'unchanged' and before != after: _fail()
        if value['status'] == 'compared':
            if before is None or before == after: _fail()
            _hash(value['comparison_digest'])
        elif value['comparison_digest'] is not None: _fail()
    return value


def _match_body(value, rules):
    if type(value) is not dict or set(value) != _MATCH_FIELDS: _fail()
    _encode(value, MATCH_MAX_BYTES)
    if type(value['schema_version']) is not int or value['schema_version'] != 1: _fail()
    for key, prefix in (('pip_id','pip'),('workspace_id','ws'),('binding_id','binding')): _id(value[key], prefix)
    _integer(value['job_version'], 1, 999999); _hash(value['binding_digest']); _ref(value['source_ref'])
    _time(value['observed_at']); _hash(value['digest'])
    if value['policy_digest'] != rules_digest(rules): _fail()
    comparison = value['comparison']
    if type(comparison) is not dict: _fail()
    validate_comparison(comparison, before_revision=comparison.get('before_revision'),
                        after_revision=comparison.get('after_revision'), rules=rules)
    if comparison['status'] != 'matched': _fail('A path wakeup requires a complete matching comparison.')
    if value['digest'] != _digest({k:v for k,v in value.items() if k != 'digest'}, MATCH_MAX_BYTES, MATCH_DOMAIN): _fail()
    return value


def pin_match(*, pip_id, workspace_id, job_version, binding_id, binding_digest,
              source_ref, rules, comparison, observed_at):
    """Build metadata only. Controller event publication supplies its authority."""
    value = {'schema_version':1,'pip_id':pip_id,'workspace_id':workspace_id,'job_version':job_version,
             'binding_id':binding_id,'binding_digest':binding_digest,'source_ref':source_ref,
             'policy_digest':rules_digest(rules),'observed_at':observed_at,'comparison':comparison}
    return _match_body(_seal(value, MATCH_MAX_BYTES, MATCH_DOMAIN), rules)


def _event(value):
    if type(value) is not dict or set(value) != {'seq','event_id','event_type','created_at'}: _fail()
    _integer(value['seq'], 1); _id(value['event_id'], 'evt'); _time(value['created_at'])
    if type(value['event_type']) is not str: _fail()
    return value


def validate_match(value, *, pip_id, workspace_id, job_version, binding_id,
                   binding_digest, source_ref, rules, event):
    value = _match_body(value, rules); _event(event)
    expected = {'pip_id':pip_id,'workspace_id':workspace_id,'job_version':job_version,
                'binding_id':binding_id,'binding_digest':binding_digest,'source_ref':source_ref}
    if (any(type(value[key]) is not type(item) or value[key] != item for key,item in expected.items())
            or event['event_type'] != EVENT_TYPE or value['observed_at'] != event['created_at']): _fail()
    return value


def _is_new(manifest):
    if type(manifest) is not dict: _fail()
    pin = manifest.get('event_trigger')
    if type(pin) is not dict: return False
    policy, event = pin.get('policy'), pin.get('event')
    return ('commit_path_match' in pin or type(event) is dict and event.get('event_type') == EVENT_TYPE
            or type(policy) is dict and ('commit_paths' in policy
                or type(policy.get('events')) is list and EVENT in policy['events']))


def validate_manifest(manifest):
    """Pure new-mode worker boundary; legacy manifests keep their own limits."""
    if not _is_new(manifest): return None
    _encode(manifest, MANIFEST_MAX_BYTES)
    from .pip_event_triggers import validate_event_trigger, EVENTS, _SOURCE_SEMANTICS
    from .pip_sources import from_record
    pin = manifest['event_trigger']; policy = validate_event_trigger(pin.get('policy'))
    if policy is None or EVENT not in policy['events'] or policy != pin['policy']: _fail()
    rules = validate_rules(policy.get('commit_paths'))
    if rules != policy['commit_paths']: _fail()
    event = _event(pin.get('event')); selected = event['event_type'] == EVENT_TYPE
    fields = _OCCURRENCE | {'policy','source_semantics'} | ({'commit_path_match'} if selected else set())
    if (set(pin) != fields or manifest.get('trigger') != 'event' or manifest.get('policy') != 'read_only'
            or manifest.get('pip_type') not in ('scout','lens','rook','lock','quill')
            or manifest.get('run_kind') != ('draft' if manifest.get('pip_type') == 'quill' else 'audit')
            or manifest.get('requested_by') != 'local-event-trigger'
            or pin['source_semantics'] != _SOURCE_SEMANTICS
            or any(key in manifest for key in ('handoff','conversation','specialists','pulse_verification',
                                               'main_chat_request','schedule','scheduled_at','schedule_occurrence'))): _fail()
    source = from_record(manifest)
    if source['source_policy']['mode'] != 'committed_only' or source['source_snapshot'] is not None: _fail()
    _integer(manifest.get('job_version'), 1, 999999)
    if type(pin['job_version']) is not int or pin['job_version'] != manifest['job_version']: _fail()
    for key,prefix in (('pip_id','pip'),('workspace_id','ws'),('binding_id','binding')): _id(manifest.get(key), prefix)
    _integer(pin['expected_after_seq'], 0, event['seq']-1); _time(pin['checked_at'])
    if (type(pin['history_may_be_incomplete']) is not bool or pin['checked_at'] < event['created_at']
            or event['event_type'] not in {kind for name in policy['events'] for kind in EVENTS[name]}): _fail()
    job = manifest.get('job')
    if (type(job) is not dict or set(job) != _JOB_FIELDS or job['pip_type'] != manifest['pip_type']
            or job['source_policy'] != source['source_policy']): _fail()
    _ref(job['source_ref'])
    match = None
    if selected:
        value = pin['commit_path_match']
        if type(value) is not dict: _fail()
        match = validate_match(value, pip_id=manifest['pip_id'], workspace_id=manifest['workspace_id'],
            job_version=manifest['job_version'], binding_id=manifest['binding_id'],
            binding_digest=value.get('binding_digest'), source_ref=job['source_ref'], rules=rules, event=event)
    return {'policy':policy, 'match':match}


def validate_parent(registry, row, manifest):
    """Original run/version binding only. No live source, event or binding lookup."""
    supplied_new = _is_new(manifest)
    try:
        run_id, pip_id, workspace_id = row['id'], row['pip_id'], row['workspace_id']
    except (KeyError,IndexError,TypeError): _fail()
    # Membership precedes bounded original manifest/definition reads and decode.
    if registry.db.execute('''SELECT 1 FROM pip_runs r JOIN pips p ON p.id=r.pip_id
         WHERE r.id=? AND r.pip_id=? AND r.workspace_id=? AND p.workspace_id=r.workspace_id''',
         (run_id,pip_id,workspace_id)).fetchone() is None: _fail()
    actual = registry.db.execute('''SELECT
         CASE WHEN length(CAST(binding_id AS BLOB))<=128 THEN binding_id END AS binding_id,
         CASE WHEN length(CAST(requested_by AS BLOB))<=128 THEN requested_by END AS requested_by,
         CASE WHEN length(CAST(idempotency_key AS BLOB))<=200 THEN idempotency_key END AS idempotency_key,
         CASE WHEN typeof(manifest)='text' AND length(CAST(manifest AS BLOB))<=131072 THEN manifest END AS manifest
         FROM pip_runs WHERE id=? AND pip_id=? AND workspace_id=?''',(run_id,pip_id,workspace_id)).fetchone()
    raw = actual['manifest']
    # Classify the actual stored run as well: stripping a new policy from a
    # supplied dictionary must not bypass its parent check. Legacy values keep
    # their previous JSON/byte contract, including their larger scalar limits.
    try:
        if type(raw) is not str: _fail('Saved run metadata is unavailable or oversized.')
        classified = json.loads(raw)
    except (ValueError,UnicodeError,RecursionError): _fail()
    if not supplied_new and not _is_new(classified): return None
    _id(run_id,'run'); _id(pip_id,'pip'); _id(workspace_id,'ws')
    saved = _load(raw, MANIFEST_MAX_BYTES)
    checked = validate_manifest(saved)
    if checked is None or saved != manifest: _fail()
    for key, expected in (('pip_id',pip_id),('workspace_id',workspace_id),('binding_id',actual['binding_id']),
                           ('requested_by',actual['requested_by'])):
        if saved.get(key) != expected: _fail()
    for key in ('binding_id','requested_by','idempotency_key'):
        try:
            if row[key] != actual[key]: _fail()
        except (KeyError,IndexError,TypeError): _fail()
    pin = saved['event_trigger']
    key = f"event:{saved['job_version']}:{pin['event']['seq']}"
    if actual['requested_by'] != 'local-event-trigger' or actual['idempotency_key'] != key: _fail()
    original = registry.db.execute('''SELECT CASE WHEN typeof(definition)='text'
         AND length(CAST(definition AS BLOB))<=24576 THEN definition END AS definition
         FROM pip_versions WHERE pip_id=? AND version=?''',(pip_id,saved['job_version'])).fetchone()
    if original is None: _fail()
    definition = _load(original['definition'], 24576)
    from .pips import _definition
    canonical = _definition(**{key:definition.get(key) for key in ('name','goal','source_ref','schedule','pip_type',
        'model_choice','adaptation_policy','event_trigger','source_policy','verification_plan','github_plan')})
    if (canonical != definition or definition['policy'] != 'read_only' or definition['trigger'] != 'event'
            or definition['schedule'] is not None or definition['event_trigger'] != checked['policy']
            or saved['job'] != {key:definition[key] for key in _JOB_FIELDS}): _fail()
    return checked

SCHEMA_V22 = """
CREATE TABLE pip_commit_path_observations (
 pip_id TEXT PRIMARY KEY REFERENCES pips(id),
 job_version INTEGER NOT NULL CHECK(typeof(job_version)='integer' AND job_version BETWEEN 1 AND 999999),
 binding_id TEXT NOT NULL REFERENCES bindings(id),
 binding_updated_at TEXT NOT NULL CHECK(typeof(binding_updated_at)='text' AND length(CAST(binding_updated_at AS BLOB))<=40),
 binding_digest TEXT NOT NULL CHECK(typeof(binding_digest)='text' AND length(CAST(binding_digest AS BLOB))=64),
 source_ref TEXT NOT NULL CHECK(typeof(source_ref)='text' AND length(CAST(source_ref AS BLOB)) BETWEEN 1 AND 200),
 policy_digest TEXT NOT NULL CHECK(typeof(policy_digest)='text' AND length(CAST(policy_digest AS BLOB))=64),
 revision TEXT CHECK(revision IS NULL OR (typeof(revision)='text' AND length(CAST(revision AS BLOB)) IN (40,64))),
 last_checked_at TEXT CHECK(last_checked_at IS NULL OR (typeof(last_checked_at)='text' AND length(CAST(last_checked_at AS BLOB))=24)),
 last_probe TEXT CHECK(last_probe IS NULL OR (typeof(last_probe)='text' AND length(CAST(last_probe AS BLOB))<=1024)),
 observed_changes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(observed_changes)='integer' AND observed_changes BETWEEN 0 AND 9007199254740991),
 last_comparison_at TEXT CHECK(last_comparison_at IS NULL OR (typeof(last_comparison_at)='text' AND length(CAST(last_comparison_at AS BLOB))=24)),
 last_comparison TEXT CHECK(last_comparison IS NULL OR (typeof(last_comparison)='text' AND length(CAST(last_comparison AS BLOB))<=2048)),
 CHECK((last_comparison IS NULL)=(last_comparison_at IS NULL)),
 CHECK(last_probe IS NULL OR last_checked_at IS NOT NULL),
 FOREIGN KEY(pip_id,job_version) REFERENCES pip_versions(pip_id,version)
);
CREATE INDEX pip_commit_path_observation_due ON pip_commit_path_observations(last_checked_at,pip_id);
"""
