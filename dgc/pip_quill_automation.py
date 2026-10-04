"""Immutable reviewed Quill automation pins; no execution or source I/O."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import timedelta

from .workspace_registry import RegistryError

MAX_GRANT_BYTES = 4096
MAX_DEFINITION_BYTES = 24576
FIELDS = {'schema_version', 'pip_id', 'workspace_id', 'job_version', 'definition_digest',
          'job_digest', 'trigger', 'policy', 'occurrence', 'digest'}
JOB_FIELDS = {'name', 'goal', 'source_ref', 'pip_type', 'model_choice', 'source_policy'}
CALENDAR = {'job_version', 'expected_next_due', 'scheduled_at', 'next_due_at', 'checked_at', 'anchor_at'}
EVENT = {'job_version', 'expected_after_seq', 'checked_at', 'event', 'history_may_be_incomplete'}


def _fail(message='The saved Quill automation grant is invalid or does not match this draft.', code='invalid_draft_automation'):
    raise RegistryError(code, message)


def _encode(value, maximum):
    # Check direct caller data before serialization, including cycles/huge leaves.
    pending, count = [(value, 0)], 0
    while pending:
        item, depth = pending.pop(); count += 1
        if count > 256 or depth > 8:
            _fail()
        if type(item) in (dict, list):
            if len(item) > 128:
                _fail()
            if type(item) is dict:
                for key, child in item.items():
                    if type(key) is not str: _fail()
                    pending.extend(((key, depth+1), (child, depth+1)))
            else:
                pending.extend((child, depth+1) for child in item)
        elif type(item) is str:
            if len(item) > maximum or '\0' in item: _fail()
        elif type(item) is int:
            if not 0 <= item <= 2**53-1: _fail()
        elif type(item) not in (bool, type(None)):
            _fail()
    try:
        raw = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')
    except (ValueError, UnicodeError):
        _fail()
    if len(raw) > maximum: _fail()
    return raw


def _digest(value, maximum=MAX_GRANT_BYTES):
    return hashlib.sha256(_encode(value, maximum)).hexdigest()


def _hash(value):
    if not isinstance(value, str) or re.fullmatch('[0-9a-f]{64}', value) is None: _fail()


def _version(value):
    if type(value) is not int or not 1 <= value <= 999999: _fail()


def _time(value):
    from .pip_schedules import timestamp
    if not isinstance(value, str) or len(value) != 24 or timestamp(value) != value: _fail()


def _job(value):
    from .pip_models import validate_model_choice
    if not isinstance(value, dict) or set(value) != JOB_FIELDS: _fail()
    for key, maximum in (('name',120), ('goal',4000), ('source_ref',200)):
        text = value[key]
        if not isinstance(text, str) or not 1 <= len(text) <= maximum or text != text.strip() or '\0' in text: _fail()
    if (value['pip_type'] != 'quill' or value['source_policy'] != {'mode':'committed_only'}
            or validate_model_choice(value['model_choice']) != value['model_choice']): _fail()
    return _digest(value, MAX_DEFINITION_BYTES)


def validate_manifest(manifest):
    """Pure worker boundary. Legacy/manual manifests remain byte-compatible."""
    if not isinstance(manifest, dict): _fail()
    grant = manifest.get('draft_automation')
    automatic = (manifest.get('pip_type') == 'quill'
                 and (manifest.get('trigger') in ('schedule','event') or
                      any(key in manifest for key in ('schedule','scheduled_at','event_trigger'))))
    if 'draft_automation' not in manifest:
        if automatic: _fail('An automatic Quill draft requires its reviewed immutable grant.')
        return None
    _encode(grant, MAX_GRANT_BYTES)
    if not isinstance(grant, dict) or set(grant) != FIELDS or type(grant['schema_version']) is not int or grant['schema_version'] != 1: _fail()
    from .pips import READ_TOOLS
    from .pip_sources import from_record
    source = from_record(manifest)
    if (manifest.get('pip_type') != 'quill' or manifest.get('run_kind') != 'draft'
            or manifest.get('policy') != 'read_only' or manifest.get('tools') != sorted(READ_TOOLS)
            or source['source_policy'] != {'mode':'committed_only'} or source['source_snapshot'] is not None
            or any(key in manifest for key in ('handoff','specialists','conversation','audit_checkpoint','changes_since_checkpoint','pip_memory','main_chat_request'))): _fail()
    for key, prefix in (('pip_id','pip'),('workspace_id','ws')):
        if (not isinstance(grant[key], str) or re.fullmatch(prefix+'_[0-9a-f]{32}', grant[key]) is None
                or grant[key] != manifest.get(key)): _fail()
    _version(grant['job_version'])
    if grant['job_version'] != manifest.get('job_version') or type(manifest.get('job_version')) is not int: _fail()
    for key in ('definition_digest','job_digest','digest'): _hash(grant[key])
    if grant['job_digest'] != _job(manifest.get('job')): _fail()
    if grant['digest'] != _digest({k:v for k,v in grant.items() if k != 'digest'}): _fail()
    mode, policy, occurrence = grant['trigger'], grant['policy'], grant['occurrence']
    if mode != manifest.get('trigger') or not isinstance(occurrence, dict): _fail()
    from . import pip_schedules as calendar
    if mode == 'schedule':
        if (set(occurrence) != CALENDAR or any(key in manifest for key in ('event_trigger','event_occurrence'))
                or manifest.get('requested_by') != 'local-scheduler'
                or policy is None or calendar.validate_schedule(policy) != policy or manifest.get('schedule') != policy): _fail()
        _version(occurrence['job_version'])
        if occurrence['job_version'] != grant['job_version']: _fail()
        for key in ('expected_next_due','scheduled_at','checked_at','anchor_at'): _time(occurrence[key])
        if occurrence['next_due_at'] is not None: _time(occurrence['next_due_at'])
        try:
            first = calendar._instant(occurrence['expected_next_due'])
            if calendar.next_due(policy, first-timedelta(milliseconds=1), occurrence['anchor_at']) != occurrence['expected_next_due']:
                _fail()
        except (OverflowError, ValueError):
            _fail()
        planned = calendar.plan_due(policy, occurrence['expected_next_due'], occurrence['checked_at'], occurrence['anchor_at'])
        if (not planned or any(planned[key] != occurrence[key] for key in ('expected_next_due','scheduled_at','next_due_at','checked_at'))
                or manifest.get('scheduled_at') != occurrence['scheduled_at']): _fail()
    elif mode == 'event':
        from .pip_event_triggers import validate_manifest as validate_event, validate_event_trigger
        validate_event(manifest)
        pin = manifest.get('event_trigger')
        if (set(occurrence) != EVENT or any(key in manifest for key in ('schedule','scheduled_at','schedule_occurrence'))
                or manifest.get('requested_by') != 'local-event-trigger'
                or policy is None or validate_event_trigger(policy) != policy
                or pin['policy'] != policy or occurrence != {k:pin[k] for k in EVENT}): _fail()
    else:
        _fail()
    return grant


def _definition(registry, pip_id, workspace_id, version):
    # Identity membership precedes any body read. SQL caps the original cell.
    row = registry.db.execute('''SELECT CASE WHEN typeof(v.definition)='text'
        AND length(CAST(v.definition AS BLOB))<=? THEN v.definition END AS definition
        FROM pip_versions v JOIN pips p ON p.id=v.pip_id
        WHERE v.pip_id=? AND v.version=? AND p.workspace_id=?''',
        (MAX_DEFINITION_BYTES,pip_id,version,workspace_id)).fetchone()
    if row is None or row['definition'] is None: _fail('The original approved draft definition is unavailable or oversized.')
    raw = row['definition']
    try:
        from .pip_overview import _json_object
        definition = _json_object(raw, MAX_DEFINITION_BYTES)
        from .pips import _definition as validate
        checked = validate(**{k:definition.get(k) for k in ('name','goal','source_ref','schedule','pip_type','model_choice','adaptation_policy','event_trigger','source_policy')})
        if checked != definition: _fail()
        digest = hashlib.sha256(raw.encode('utf-8')).hexdigest()
    except (ValueError, UnicodeError, RecursionError, TypeError):
        _fail()
    return definition, digest


def _against_definition(registry, manifest, grant):
    definition, digest = _definition(registry, grant['pip_id'], grant['workspace_id'], grant['job_version'])
    if (definition['pip_type'] != 'quill' or definition['policy'] != 'read_only'
            or definition['trigger'] != grant['trigger'] or digest != grant['definition_digest']
            or manifest['job'] != {k:definition[k] for k in JOB_FIELDS}
            or definition['schedule' if grant['trigger']=='schedule' else 'event_trigger'] != grant['policy']): _fail()


def pin(registry, manifest, occurrence, *, anchor_at=None):
    """Called after occurrence CAS under the queue's write transaction."""
    if not registry.db.in_transaction: _fail('Draft automation must be pinned with its queued occurrence.')
    definition, digest = _definition(registry, manifest['pip_id'], manifest['workspace_id'], manifest['job_version'])
    mode = manifest['trigger']
    grant = {'schema_version':1, 'pip_id':manifest['pip_id'], 'workspace_id':manifest['workspace_id'],
             'job_version':manifest['job_version'], 'definition_digest':digest, 'job_digest':_job(manifest['job']),
             'trigger':mode, 'policy':definition['schedule' if mode=='schedule' else 'event_trigger'],
             'occurrence':{**occurrence, **({'anchor_at':anchor_at} if mode=='schedule' else {})}}
    grant['digest'] = _digest(grant)
    checked = {**manifest, 'draft_automation':grant}
    validate_manifest(checked); _against_definition(registry, checked, grant)
    return grant


def validate_parent(registry, row, manifest):
    grant = validate_manifest(manifest)
    if grant is None: return
    if any(row[key] != manifest.get(key) for key in ('pip_id','workspace_id','binding_id','requested_by')): _fail()
    if grant['trigger'] == 'schedule':
        from .pip_schedules import occurrence_key
        expected_key = occurrence_key(grant['job_version'],grant['occurrence']['scheduled_at'])
    else:
        from .pip_event_triggers import occurrence_key
        expected_key = occurrence_key(grant['job_version'],grant['occurrence']['event']['seq'])
    if row['idempotency_key'] != expected_key: _fail()
    _against_definition(registry, manifest, grant)


def validate_retry(prior, schedule_occurrence, event_occurrence):
    """New Quill retries retain the original full occurrence, without caller anchors."""
    raw = prior['manifest']
    if not isinstance(raw,str) or len(raw) > 131072 or len(raw.encode('utf-8')) > 131072: _fail()
    from .pip_overview import _json_object
    manifest = _json_object(raw, 131072)
    grant = validate_manifest(manifest)
    if grant is None:
        if manifest.get('pip_type') == 'quill' and (schedule_occurrence is not None or event_occurrence is not None):
            _fail('This request key belongs to another Quill request.', 'conflict')
        return
    expected = grant['occurrence']
    if grant['trigger'] == 'schedule':
        expected = {k:v for k,v in expected.items() if k!='anchor_at'}
        okay = event_occurrence is None and schedule_occurrence == expected
    else:
        okay = schedule_occurrence is None and event_occurrence == expected
    if not okay: _fail('This request key belongs to another Quill occurrence.', 'conflict')
