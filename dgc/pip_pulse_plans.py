"""Reviewed, model-free Pulse grants and bounded monotonic command receipts.

No source/process/model I/O. A validated shape is not an approval. Historical
checks use only immutable SQL records; live checks are explicitly separate.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import re
from datetime import timedelta

from .workspace_registry import RegistryError

MAX_PLAN_BYTES = 12 * 1024
MAX_DEFINITION_BYTES = 16 * 1024
MAX_GRANT_BYTES = 4096
MAX_RECEIPT_BYTES = 65536
MAX_MANIFEST_BYTES = 128 * 1024
JOB_FIELDS = {'name','goal','source_ref','pip_type','model_choice','source_policy','verification_plan'}
GRANT_FIELDS = {'schema_version','pip_id','workspace_id','binding_id','runner_id','job_version',
                'definition_digest','approval_id','plan_digest','action_digest','lifecycle_revision',
                'source_revision','binding_digest','model','trigger','request','digest'}
RECEIPT_FIELDS = {'schema_version','classification','grant_digest','plan_digest','model_invoked',
                  'snapshot','phase','terminal_reason','commands'}
MANUAL_FIELDS = {'expected_version','expected_lifecycle_revision','expected_plan_digest','actor','idempotency_key'}
CALENDAR_FIELDS = {'job_version','expected_next_due','scheduled_at','next_due_at','checked_at','anchor_at'}
STOP_STATES = {'cancelled','timed_out','output_limit','resource_limit'}
TERMINAL_REASONS = {'complete','cancelled','timed_out','interrupted','output_limit','resource_limit','stale_grant','infrastructure_failure'}
TERMINAL = {'succeeded','failed','cancelled'}


def _fail(message='The reviewed Pulse plan or receipt is invalid.', code='invalid_pulse_plan'):
    raise RegistryError(code, message)


def _encode(value, maximum):
    pending, count, size = [(value,0)], 0, 0
    while pending:
        item, depth = pending.pop(); count += 1
        if count > 4096 or depth > 12: _fail('Pulse data exceeds its structural bound.')
        kind = type(item)
        if kind in (dict,list):
            if len(item) > 128: _fail()
            size += 2 + len(item)
            if kind is dict:
                for key, child in item.items():
                    if type(key) is not str: _fail()
                    pending.extend(((key,depth+1),(child,depth+1)))
            else: pending.extend((child,depth+1) for child in item)
        elif kind is str:
            if len(item) > maximum: _fail('Pulse text exceeds its byte bound.')
            try: size += len(item.encode('utf-8')) + 2
            except UnicodeError: _fail('Pulse text must be valid Unicode.')
        elif kind is int:
            if not -(2**53-1) <= item <= 2**53-1: _fail()
            size += len(str(item))
        elif kind in (bool,type(None)): size += 5
        else: _fail()
        if size > maximum: _fail('Pulse data exceeds its byte bound.')
    try: raw = json.dumps(value, sort_keys=True, separators=(',',':'), ensure_ascii=False, allow_nan=False).encode('utf-8')
    except (ValueError,UnicodeError,RecursionError): _fail()
    if len(raw) > maximum: _fail('Pulse data exceeds its byte bound.')
    return raw


def _load(raw, maximum):
    if type(raw) is not str or len(raw) > maximum: _fail('Stored Pulse data is unavailable or oversized.')
    try:
        if len(raw.encode('utf-8')) > maximum: _fail()
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result: _fail('Stored Pulse data has duplicate fields.')
                result[key] = value
            return result
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: _fail())
    except (ValueError,UnicodeError,RecursionError): _fail()
    _encode(value, maximum)
    if type(value) is not dict: _fail()
    return value


def _digest(value, maximum, domain=b''):
    return hashlib.sha256(domain + _encode(value, maximum)).hexdigest()


def _text(value, maximum=128):
    if type(value) is not str or not value or len(value) > maximum or any(ord(c)<32 or ord(c)==127 for c in value): _fail()
    try:
        if len(value.encode('utf-8')) > maximum: _fail()
    except UnicodeError: _fail()
    return value


def _hash(value):
    if type(value) is not str or re.fullmatch('[0-9a-f]{64}', value) is None: _fail()
    return value


def _integer(value, low=0, high=2**53-1):
    if type(value) is not int or not low <= value <= high: _fail()
    return value


def _id(value, prefix):
    if type(value) is not str or re.fullmatch(prefix+'_[0-9a-f]{32}', value) is None: _fail()
    return value


def validate_plan(value):
    if value is None: return None
    _encode(value, MAX_PLAN_BYTES)
    if type(value) is not dict or set(value) != {'schema_version','action'} or type(value['schema_version']) is not int or value['schema_version'] != 1: _fail()
    from .pip_execution import validate_action
    result = {'schema_version':1, 'action':validate_action('pulse', value['action'])}
    _encode(result, MAX_PLAN_BYTES)
    return result


def plan_digest(plan):
    plan = validate_plan(plan)
    if plan is None: _fail('A missing plan is not an execution grant.')
    return _digest(plan, MAX_PLAN_BYTES, b'dgc.pulse.plan.v1\0')


def validate_job(*, pip_type, plan, source_policy, schedule, event_trigger, live_plan=None):
    checked = validate_plan(plan)
    if checked is None:
        # A live-data Pulse (pip_live_data) runs its approved read-only commands on its schedule instead.
        if pip_type == 'pulse' and schedule is not None and live_plan is None:
            _fail('Pulse schedules require a reviewed verification plan.', 'review_required')
        return None
    if live_plan is not None:
        _fail('A Pulse runs its tests or reads live data, not both.', 'unsupported_live_plan')
    from .pip_sources import validate_policy
    from .pip_schedules import validate_schedule
    if pip_type != 'pulse' or validate_policy(source_policy) != {'mode':'committed_only'} or event_trigger is not None:
        _fail('Standing verification plans support committed-source Pulse and manual/calendar requests only.')
    validate_schedule(schedule)
    return checked


def _manual(value):
    _encode(value, MAX_GRANT_BYTES)
    if type(value) is not dict or set(value) != MANUAL_FIELDS: _fail('A manual Pulse request needs its exact review pins.')
    _integer(value['expected_version'],1,999999); _integer(value['expected_lifecycle_revision'])
    _hash(value['expected_plan_digest']); _text(value['actor']); _text(value['idempotency_key'],200)
    return {'kind':'manual','actor':value['actor'],'key_digest':hashlib.sha256(value['idempotency_key'].encode()).hexdigest(),
            **{key:value[key] for key in ('expected_version','expected_lifecycle_revision','expected_plan_digest')}}


def _grant_digest(value):
    return _digest(value, MAX_GRANT_BYTES, b'dgc.pulse.grant.v1\0')


def _calendar(request, manifest, version):
    from . import pip_schedules as calendar
    if set(request) != {'kind','policy','occurrence'} or request['kind'] != 'schedule': _fail()
    policy, occurrence = request['policy'], request['occurrence']
    if type(occurrence) is not dict or set(occurrence) != CALENDAR_FIELDS or policy is None or calendar.validate_schedule(policy) != policy: _fail()
    if _integer(occurrence['job_version'],1,999999) != version: _fail()
    for key in ('expected_next_due','scheduled_at','checked_at','anchor_at'):
        value=occurrence[key]
        if type(value) is not str or len(value)!=24 or calendar.timestamp(value)!=value: _fail()
    following=occurrence['next_due_at']
    if following is not None and (type(following) is not str or len(following)!=24 or calendar.timestamp(following)!=following): _fail()
    try:
        first=calendar._instant(occurrence['expected_next_due'])
        if calendar.next_due(policy,first-timedelta(milliseconds=1),occurrence['anchor_at'])!=occurrence['expected_next_due']: _fail()
        planned=calendar.plan_due(policy,occurrence['expected_next_due'],occurrence['checked_at'],occurrence['anchor_at'])
    except (OverflowError,ValueError): _fail()
    if not planned or any(planned[k]!=occurrence[k] for k in ('expected_next_due','scheduled_at','next_due_at','checked_at')): _fail()
    if manifest.get('schedule')!=policy or manifest.get('scheduled_at')!=occurrence['scheduled_at'] or manifest.get('requested_by')!='local-scheduler': _fail()


def validate_manifest(manifest):
    if type(manifest) is not dict: _fail()
    grant=manifest.get('pulse_verification')
    if 'pulse_verification' not in manifest:
        job=manifest.get('job')
        if (manifest.get('run_kind')=='test' and 'handoff' not in manifest
                and (manifest.get('model') is None or type(job) is dict and job.get('verification_plan') is not None)):
            _fail('A standalone Pulse run requires its immutable reviewed grant.')
        return None
    _encode(manifest, MAX_MANIFEST_BYTES)
    if type(grant) is not dict or set(grant)!=GRANT_FIELDS or type(grant['schema_version']) is not int or grant['schema_version']!=1: _fail()
    from .pip_sources import from_record
    from .pip_execution import action_digest
    from .pip_models import validate_model_choice
    source=from_record(manifest)
    forbidden=('handoff','specialists','conversation','audit_checkpoint','changes_since_checkpoint','workspace_context','pip_memory','main_chat_request','event_trigger','event_occurrence','draft_automation')
    if (manifest.get('run_kind')!='test' or manifest.get('pip_type')!='pulse'
            or manifest.get('policy')!='review_required' or manifest.get('tools')!=[]
            or 'model' not in manifest or manifest['model'] is not None
            or 'model_settings' not in manifest or manifest['model_settings'] is not None
            or source['source_policy']!={'mode':'committed_only'} or source['source_snapshot'] is not None
            or any(key in manifest for key in forbidden)): _fail()
    job=manifest.get('job')
    if type(job) is not dict or set(job)!=JOB_FIELDS: _fail()
    for key,maximum in (('name',120),('goal',4000),('source_ref',200)):
        value=job[key]
        if type(value) is not str or not value or len(value)>maximum or value!=value.strip() or '\0' in value: _fail()
    if job['pip_type']!='pulse' or job['source_policy']!={'mode':'committed_only'}: _fail()
    choice=validate_model_choice(job['model_choice'])
    if choice!=job['model_choice'] or grant['model']!={'invoked':False,'choice':choice} or type(grant['model']['invoked']) is not bool: _fail()
    plan=validate_plan(job['verification_plan'])
    if plan is None or plan!=job['verification_plan']: _fail()
    for key,prefix in (('pip_id','pip'),('workspace_id','ws'),('binding_id','binding'),('runner_id','runner')):
        _id(grant[key],prefix)
        if grant[key]!=manifest.get(key): _fail()
    _id(grant['approval_id'],'approval'); _integer(grant['job_version'],1,999999); _integer(grant['lifecycle_revision'])
    if type(manifest.get('job_version')) is not int or grant['job_version']!=manifest['job_version']: _fail()
    for key in ('definition_digest','plan_digest','action_digest','binding_digest','digest'): _hash(grant[key])
    if (grant['plan_digest']!=plan_digest(plan) or grant['action_digest']!=action_digest(plan['action'])
            or manifest.get('policy_digest')!=grant['action_digest'] or grant['source_revision']!=source['source_revision']
            or grant['digest']!=_grant_digest({k:v for k,v in grant.items() if k!='digest'})): _fail()
    request=grant['request']
    if type(request) is not dict or grant['trigger']!=manifest.get('trigger'): _fail()
    if grant['trigger']=='manual':
        if set(request)!={'kind','actor','key_digest','expected_version','expected_lifecycle_revision','expected_plan_digest'} or request['kind']!='manual': _fail()
        _text(request['actor']); _hash(request['key_digest'])
        if (_integer(request['expected_version'],1,999999)!=grant['job_version']
                or _integer(request['expected_lifecycle_revision'])!=grant['lifecycle_revision']
                or request['expected_plan_digest']!=grant['plan_digest'] or request['actor']!=manifest.get('requested_by')
                or any(k in manifest for k in ('schedule','scheduled_at','schedule_occurrence'))): _fail()
    elif grant['trigger']=='schedule': _calendar(request,manifest,grant['job_version'])
    else: _fail()
    return json.loads(_encode(grant,MAX_GRANT_BYTES))


def _definition(registry, pip_id, workspace_id, version):
    row=registry.db.execute('''SELECT CASE WHEN typeof(v.definition)='text' AND length(CAST(v.definition AS BLOB))<=?
       THEN v.definition END AS definition, CASE WHEN length(CAST(v.actor AS BLOB))<=128 THEN v.actor END AS actor,
       CASE WHEN length(CAST(v.created_at AS BLOB))<=40 THEN v.created_at END AS created_at
       FROM pip_versions v JOIN pips p ON p.id=v.pip_id WHERE v.pip_id=? AND v.version=? AND p.workspace_id=?''',
       (MAX_DEFINITION_BYTES,pip_id,version,workspace_id)).fetchone()
    if row is None or row['definition'] is None: _fail('The original approved Pulse definition is unavailable.')
    definition=_load(row['definition'],MAX_DEFINITION_BYTES)
    plan=validate_job(pip_type=definition.get('pip_type'),plan=definition.get('verification_plan'),
                      source_policy=definition.get('source_policy'),schedule=definition.get('schedule'),event_trigger=definition.get('event_trigger'))
    if plan is None or definition.get('policy')!='review_required' or plan!=definition['verification_plan']: _fail()
    # An actual accepted human review must have produced this exact immutable
    # version. Self-consistent hashes or a row inserted by adaptation are not one.
    from .pip_approvals import digest
    approvals=registry.db.execute('''SELECT CASE WHEN length(CAST(a.id AS BLOB))<=128 THEN a.id END AS id
       FROM pip_approvals a JOIN pip_proposals q ON q.id=a.proposal_id
       WHERE a.pip_id=? AND a.workspace_id=? AND a.expected_version=? AND a.status='approved'
       AND q.pip_id=a.pip_id AND q.expected_version=a.expected_version AND q.status='accepted'
       AND q.definition=? AND a.definition_digest=? AND a.resolved_by=? AND a.resolved_at=? LIMIT 2''',
       (pip_id,workspace_id,version-1,row['definition'],digest(definition),row['actor'],row['created_at'])).fetchall()
    _text(row['actor']); _text(row['created_at'],40)
    if row['actor']=='core_adaptation' or len(approvals)!=1: _fail('The Pulse version lacks one exact accepted human review.')
    return definition,hashlib.sha256(row['definition'].encode()).hexdigest(),_id(approvals[0]['id'],'approval')


def _binding(registry, binding_id, workspace_id, runner_id):
    row=registry.db.execute('''SELECT id,workspace_id,runner_id,
       CASE WHEN typeof(canonical_root)='text' AND length(CAST(canonical_root AS BLOB))<=4096 THEN canonical_root END AS canonical_root,
       CASE WHEN length(CAST(updated_at AS BLOB))<=40 THEN updated_at END AS updated_at
       FROM bindings WHERE id=? AND workspace_id=? AND runner_id=?''',(binding_id,workspace_id,runner_id)).fetchone()
    if row is None: _fail('The Pulse binding changed.','stale_grant')
    value=dict(row); _text(value['canonical_root'],4096); _text(value['updated_at'],40)
    return _digest(value,8192)


def _against_definition(registry, manifest, grant):
    definition,digest,approval=_definition(registry,grant['pip_id'],grant['workspace_id'],grant['job_version'])
    if (digest!=grant['definition_digest'] or approval!=grant['approval_id']
            or any(definition.get(key)!=manifest['job'][key] for key in JOB_FIELDS)):
        _fail('The Pulse grant differs from its original approved definition.')
    if grant['trigger']=='schedule' and definition.get('schedule')!=grant['request']['policy']: _fail()
    return definition


def pin(store, pip, manifest, *, manual_request=None, schedule_occurrence=None, anchor_at=None):
    registry=store.registry
    if not registry.db.in_transaction: _fail('Pulse grants must be pinned in their enqueue transaction.')
    if (manual_request is None)==(schedule_occurrence is None): _fail()
    definition,digest,approval=_definition(registry,manifest['pip_id'],manifest['workspace_id'],manifest['job_version'])
    from .pip_execution import action_digest
    from .pip_archive import revision
    plan=definition['verification_plan']
    request=_manual(manual_request) if manual_request is not None else {'kind':'schedule','policy':definition.get('schedule'),
                                                        'occurrence':{**schedule_occurrence,'anchor_at':anchor_at}}
    grant={'schema_version':1, **{k:manifest[k] for k in ('pip_id','workspace_id','binding_id','runner_id','job_version','source_revision')},
           'definition_digest':digest,'approval_id':approval,'plan_digest':plan_digest(plan),'action_digest':action_digest(plan['action']),
           'lifecycle_revision':revision(registry,manifest['pip_id']),
           'binding_digest':_binding(registry,manifest['binding_id'],manifest['workspace_id'],manifest['runner_id']),
           'model':{'invoked':False,'choice':definition['model_choice']},'trigger':request['kind'],'request':request}
    grant['digest']=_grant_digest(grant)
    checked={**manifest,'pulse_verification':grant}
    validate_manifest(checked); _against_definition(registry,checked,grant)
    if pip['id']!=grant['pip_id'] or pip['current_version']!=grant['job_version'] or pip['workspace_id']!=grant['workspace_id']: _fail()
    require_current(registry, {'pip_id':grant['pip_id'],'workspace_id':grant['workspace_id'],'binding_id':grant['binding_id'],
                              'requested_by':manifest['requested_by'], 'idempotency_key':manual_request['idempotency_key'] if manual_request is not None else _schedule_key(grant)},checked)
    return grant


def _schedule_key(grant):
    from .pip_schedules import occurrence_key
    return occurrence_key(grant['job_version'],grant['request']['occurrence']['scheduled_at'])


def validate_parent(registry, row, manifest):
    grant=validate_manifest(manifest)
    if grant is None: return None
    if any(row[key]!=manifest.get(key) for key in ('pip_id','workspace_id','binding_id','requested_by')): _fail()
    key=_text(row['idempotency_key'],200)
    if grant['trigger']=='manual':
        if hashlib.sha256(key.encode()).hexdigest()!=grant['request']['key_digest']: _fail()
    elif key!=_schedule_key(grant): _fail()
    _against_definition(registry,manifest,grant)
    return grant


def require_current(registry, row, manifest):
    grant=validate_parent(registry,row,manifest)
    if grant is None: _fail()
    if grant['runner_id'] != registry.runner_id:
        _fail('This Pulse grant belongs to another runner.','stale_grant')
    current=registry.db.execute('''SELECT p.status,p.current_version,l.revision FROM pips p
       JOIN pip_lifecycle_state l ON l.pip_id=p.id WHERE p.id=? AND p.workspace_id=?''',
       (grant['pip_id'],grant['workspace_id'])).fetchone()
    if (current is None or current['status']!='active' or current['current_version']!=grant['job_version']
            or type(current['revision']) is not int or current['revision']!=grant['lifecycle_revision']
            or _binding(registry,grant['binding_id'],grant['workspace_id'],grant['runner_id'])!=grant['binding_digest']):
        _fail('The reviewed Pulse job, lifecycle or binding changed.','stale_grant')


def validate_retry(row, *, manual_request=None, schedule_occurrence=None):
    # This seam sees historical non-Pulse retries too. Apply only the existing
    # transport byte/JSON boundary until classification; Pulse's stricter
    # integer, structure and duplicate-key contract belongs to standalone runs.
    raw=row['manifest']
    if type(raw) is not str or len(raw)>MAX_MANIFEST_BYTES: _fail()
    try:
        if len(raw.encode('utf-8'))>MAX_MANIFEST_BYTES: _fail()
        manifest=json.loads(raw)
    except (ValueError,UnicodeError,RecursionError): _fail()
    grant=validate_manifest(manifest)
    if grant is None:
        if manual_request is not None: _fail('This request key belongs to another operation.','conflict')
        return False
    manifest=_load(raw,MAX_MANIFEST_BYTES)
    grant=validate_manifest(manifest)
    if any(row[key]!=manifest.get(key) for key in ('pip_id','workspace_id','binding_id','requested_by')): _fail()
    key=_text(row['idempotency_key'],200)
    if (grant['trigger']=='manual' and hashlib.sha256(key.encode()).hexdigest()!=grant['request']['key_digest']) or (grant['trigger']=='schedule' and key!=_schedule_key(grant)): _fail()
    if schedule_occurrence is not None: _encode(schedule_occurrence,MAX_GRANT_BYTES)
    if grant['trigger']=='manual':
        okay=schedule_occurrence is None and manual_request is not None and _manual(manual_request)==grant['request']
    else:
        expected={k:v for k,v in grant['request']['occurrence'].items() if k!='anchor_at'}
        okay=manual_request is None and schedule_occurrence==expected
    if not okay: _fail('This request key belongs to a different Pulse request.','conflict')
    return True


def _snapshot(value):
    if value is None: return None
    from .pip_execution import MAX_FILES,MAX_SOURCE_BYTES
    if type(value) is not dict or set(value)!={'sha256','files','bytes'}: _fail()
    _hash(value['sha256']); _integer(value['files'],0,MAX_FILES); _integer(value['bytes'],0,MAX_SOURCE_BYTES)
    return dict(value)


def initial_receipt(manifest, snapshot=None):
    grant=validate_manifest(manifest)
    if grant is None: _fail()
    return {'schema_version':1,'classification':'reviewed_command_outcomes','grant_digest':grant['digest'],
            'plan_digest':grant['plan_digest'],'model_invoked':False,'snapshot':_snapshot(snapshot),'phase':'running',
            'terminal_reason':None,'commands':[{'index':i,'launch_state':'not_started','outcome':None}
                   for i in range(len(manifest['job']['verification_plan']['action']['tests']))]}


def validate_receipt(value, manifest, *, run_status):
    grant=validate_manifest(manifest)
    if grant is None: _fail()
    raw=_encode(value,MAX_RECEIPT_BYTES)
    if (type(value) is not dict or set(value)!=RECEIPT_FIELDS or type(value['schema_version']) is not int or value['schema_version']!=1
            or value['classification']!='reviewed_command_outcomes' or value['grant_digest']!=grant['digest']
            or value['plan_digest']!=grant['plan_digest'] or value['model_invoked'] is not False): _fail()
    _snapshot(value['snapshot'])
    if run_status in TERMINAL:
        reason=value['terminal_reason']
        if (value['phase']!='terminal' or type(reason) is not str or reason not in TERMINAL_REASONS
                or (run_status=='succeeded')!=(reason=='complete') or (run_status=='cancelled')!=(reason=='cancelled')): _fail()
    elif run_status not in ('queued','running','cancelling') or value['phase']!='running' or value['terminal_reason'] is not None: _fail()
    action=manifest['job']['verification_plan']['action']; commands=value['commands']
    if type(commands) is not list or len(commands)!=len(action['tests']): _fail()
    from .pip_execution import validate_command_result
    blocked=False
    for index,command in enumerate(commands):
        if type(command) is not dict or set(command)!={'index','launch_state','outcome'} or type(command['index']) is not int or command['index']!=index: _fail()
        state=command['launch_state']
        if type(state) is not str or state not in ('not_started','launch_reserved','finished'): _fail()
        if blocked and state!='not_started': _fail('Pulse command progress is not a monotonic prefix.')
        if state=='finished':
            if value['snapshot'] is None: _fail()
            outcome=validate_command_result(command['outcome'],action,index)
            blocked=outcome['status'] in STOP_STATES
        else:
            if command['outcome'] is not None: _fail()
            if state=='launch_reserved' and value['snapshot'] is None: _fail()
            blocked=True
    if value['terminal_reason']=='complete' and any(c['launch_state']!='finished' or c['outcome']['status'] not in ('passed','failed') for c in commands): _fail()
    if run_status=='queued' and any(c['launch_state']!='not_started' for c in commands): _fail()
    return json.loads(raw)


def seal_receipt(value, manifest, *, run_status, terminal_reason):
    if run_status not in TERMINAL: _fail()
    if value is None: value=initial_receipt(manifest)
    if type(value) is dict and value.get('phase')=='terminal':
        if value.get('terminal_reason')!=terminal_reason: _fail('A sealed Pulse receipt cannot change.','conflict')
        return validate_receipt(value,manifest,run_status=run_status)
    checked=validate_receipt(value,manifest,run_status='running')
    checked.update(phase='terminal',terminal_reason=terminal_reason)
    return validate_receipt(checked,manifest,run_status=run_status)


def _row(registry, run_id):
    _id(run_id,'run')
    # Scalar membership first; no arbitrary lookup of another row's private body.
    scope=registry.db.execute('''SELECT
        CASE WHEN length(CAST(r.pip_id AS BLOB))<=128 THEN r.pip_id END AS pip_id,
        CASE WHEN length(CAST(r.workspace_id AS BLOB))<=128 THEN r.workspace_id END AS workspace_id
        FROM pip_runs r JOIN pips p
        ON p.id=r.pip_id AND p.workspace_id=r.workspace_id WHERE r.id=?''',(run_id,)).fetchone()
    if scope is None: _fail('The Pulse run is unavailable.')
    _id(scope['pip_id'],'pip'); _id(scope['workspace_id'],'ws')
    row=registry.db.execute('''SELECT id,pip_id,workspace_id,binding_id,status,
        CASE WHEN typeof(manifest)='text' AND length(CAST(manifest AS BLOB))<=? THEN manifest END AS manifest,
        CASE WHEN result IS NULL OR (typeof(result)='text' AND length(CAST(result AS BLOB))<=?) THEN result END AS result,
        (result IS NOT NULL) AS had_result,
        CASE WHEN length(CAST(requested_by AS BLOB))<=128 THEN requested_by END AS requested_by,
        CASE WHEN length(CAST(idempotency_key AS BLOB))<=200 THEN idempotency_key END AS idempotency_key
        FROM pip_runs WHERE id=? AND pip_id=? AND workspace_id=?''',
        (MAX_MANIFEST_BYTES,MAX_RECEIPT_BYTES,run_id,scope['pip_id'],scope['workspace_id'])).fetchone()
    if row is None or row['manifest'] is None or row['had_result'] and row['result'] is None: _fail('Stored Pulse run exceeds its bound.')
    manifest=_load(row['manifest'],MAX_MANIFEST_BYTES); validate_parent(registry,row,manifest)
    result=_load(row['result'],MAX_RECEIPT_BYTES) if row['result'] is not None else None
    if result is not None: validate_receipt(result,manifest,run_status=row['status'])
    return row,manifest,result


def _transaction(registry):
    return contextlib.nullcontext() if registry.db.in_transaction else registry.transaction()


def _write(registry,row,value):
    raw=_encode(value,MAX_RECEIPT_BYTES).decode()
    changed=registry.db.execute('UPDATE pip_runs SET result=? WHERE id=? AND status=? AND result IS ?',
                               (raw,row['id'],row['status'],row['result'])).rowcount
    if changed!=1: _fail('Pulse command progress changed.','conflict')
    return json.loads(raw)


def initialize_progress(registry, run_id, snapshot):
    snapshot=_snapshot(snapshot)
    if snapshot is None: _fail('Command preparation requires a captured snapshot.')
    with _transaction(registry):
        row,manifest,value=_row(registry,run_id)
        if row['status']!='running': _fail('Only a claimed Pulse run can prepare commands.','conflict')
        require_current(registry,row,manifest)
        expected=initial_receipt(manifest,snapshot)
        if value is not None:
            if value!=expected: _fail('Pulse preparation is already consumed.','conflict')
            return value
        return _write(registry,row,expected)


def reserve_command(registry, run_id, index):
    with _transaction(registry):
        row,manifest,value=_row(registry,run_id)
        if row['status']!='running' or value is None or value['snapshot'] is None: _fail('Pulse cannot start another command.','conflict')
        require_current(registry,row,manifest)
        _integer(index,0,len(value['commands'])-1)
        if value['commands'][index]['launch_state']!='not_started' or any(c['launch_state']!='finished' or c['outcome']['status'] not in ('passed','failed') for c in value['commands'][:index]):
            _fail('The Pulse command was already reserved or is out of order.','conflict')
        value['commands'][index]['launch_state']='launch_reserved'
        validate_receipt(value,manifest,run_status=row['status'])
        return _write(registry,row,value)


def complete_command(registry, run_id, index, outcome):
    _encode(outcome,MAX_RECEIPT_BYTES)
    with _transaction(registry):
        row,manifest,value=_row(registry,run_id)
        if row['status'] not in ('running','cancelling') or value is None: _fail('A terminal Pulse receipt cannot change.','conflict')
        _integer(index,0,len(value['commands'])-1)
        from .pip_execution import validate_command_result
        outcome=validate_command_result(outcome,manifest['job']['verification_plan']['action'],index)
        command=value['commands'][index]
        if command['launch_state']=='finished' and command['outcome']==outcome: return value
        if command['launch_state']!='launch_reserved': _fail('The Pulse outcome has no matching reservation.','conflict')
        command.update(launch_state='finished',outcome=outcome)
        validate_receipt(value,manifest,run_status=row['status'])
        return _write(registry,row,value)
