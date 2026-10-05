"""Conversational drafts of a complete, human-reviewed Pip setup.

Drafting never changes a job. Acceptance binds the exact card to the existing
workspace/session, applies one immutable definition and optionally queues one
native run in the same transaction. Pulse execution requires its exact reviewed
command or restricted local HTTP plan; a prose goal grants no authority.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .workspace_registry import RegistryError, canonical_directory, identifier

MAX_BYTES = 16 * 1024
MAX_PENDING = 20
MAX_LIST = 5
MAX_RETAINED = 1000
SCHEMA = """
CREATE TABLE pip_setup_proposals(
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 session_id TEXT NOT NULL REFERENCES session_workspaces(session_id),
 request_key TEXT NOT NULL,request_digest TEXT NOT NULL,
 body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=16384),digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
 receipt TEXT CHECK(receipt IS NULL OR length(CAST(receipt AS BLOB))<=4096),
 created_at TEXT NOT NULL,expires_at TEXT NOT NULL,UNIQUE(session_id,request_key));
CREATE INDEX pip_setup_pending ON pip_setup_proposals(workspace_id,status,expires_at,created_at,id);
CREATE TRIGGER immutable_pip_setup BEFORE UPDATE OF
 id,workspace_id,session_id,request_key,request_digest,body,digest,created_at,expires_at ON pip_setup_proposals
 BEGIN SELECT RAISE(ABORT,'immutable Pip setup draft'); END;
CREATE TRIGGER resolve_pip_setup_once BEFORE UPDATE OF status,receipt ON pip_setup_proposals
 WHEN OLD.status!='pending' OR NEW.status='pending' OR NEW.receipt IS NULL
 BEGIN SELECT RAISE(ABORT,'Pip setup can only be resolved once'); END;
CREATE TRIGGER retain_pip_setup BEFORE DELETE ON pip_setup_proposals
 BEGIN SELECT RAISE(ABORT,'Pip setup history is retained'); END;
"""
_REQUIRED = {'target_root', 'name', 'goal', 'pip_type', 'work_kind', 'schedule', 'run_now', 'request_key', 'reason'}
_PINS = {'pip_id', 'expected_version', 'expected_lifecycle_revision'}
_BODY = {'schema_version', 'request', 'definition', 'workspace_id', 'binding_id', 'runner_id',
         'project_root', 'root_identity', 'session_id', 'created_at', 'expires_at', 'next_run_at', 'counts_for_date'}
_AUDIT = {'scout', 'lens', 'rook', 'lock'}
SCOPE_NOTICE = ('Accepting this setup activates the Pip with the displayed schedule. '
                'Committed source only. Reads files and saves a private report or documentation draft. '
                'Does not run tests, open URLs, contact the application, change project files or deploy.')


def _fail(message, code='invalid_request'):
    raise RegistryError(code, message)


def _text(value, label, maximum, *, multiline=False):
    if (type(value) is not str or not value.strip() or len(value) > maximum
            or any(ord(c) < 32 and not (multiline and c in '\n\t')
                   or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value)):
        _fail(f'{label} must be bounded nonempty text without control characters.')
    return value.strip()


def _encode(value, maximum=MAX_BYTES):
    # Bound the object graph before the JSON encoder makes its allocation.
    pending, count, chars = [(value, 0)], 0, 0
    while pending:
        item, depth = pending.pop(); count += 1
        if count > 512 or depth > 8:
            _fail('The setup contains too many fields or nested values.', 'request_limit')
        if type(item) in (dict, list):
            if len(item) > 64:
                _fail('The setup contains too many fields.', 'request_limit')
            if type(item) is dict:
                for key, child in item.items():
                    if type(key) is not str:
                        _fail('Setup field names must be text.')
                    pending.extend(((key, depth + 1), (child, depth + 1)))
            else:
                pending.extend((child, depth + 1) for child in item)
        elif type(item) is str:
            chars += len(item)
            if chars > maximum or any(0xD800 <= ord(c) <= 0xDFFF for c in item):
                _fail('The setup exceeds its text budget.', 'request_limit')
        elif type(item) is int:
            if not 0 <= item <= 2**63 - 1:
                _fail('Setup integers are out of range.')
        elif type(item) not in (bool, type(None)):
            _fail('The setup contains an unsupported value.')
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    if len(raw.encode('utf-8')) > maximum:
        _fail('The setup exceeds its byte budget.', 'request_limit')
    return raw


def _digest(value):
    return hashlib.sha256(_encode(value).encode('utf-8')).hexdigest()


def _id(value, prefix):
    if type(value) is not str or re.fullmatch(prefix + r'_[0-9a-f]{32}', value) is None:
        _fail(f'Use the exact {prefix} identity from the current workspace.')
    return value


def _integer(value, label, lower, upper):
    if type(value) is not int or not lower <= value <= upper:
        _fail(f'{label} is out of range.')
    return value


def needs_card(request) -> bool:
    """A setup that keeps its own card whatever the permission mode: one that reads the user's
    connected accounts (their mail, calendar, files) or runs commands on a schedule (Pulse).
    Everything else is approved by the tool call's ordinary permission, like any other tool."""
    if not isinstance(request, dict):
        return True
    return (request.get("app_plan") is not None
            or (request.get("pip_type") == "pulse" and request.get("scope") != "personal"))


def validate_request(value):
    _encode(value)
    if (type(value) is not dict or not _REQUIRED <= set(value)
            or set(value) - (_REQUIRED | _PINS | {'source_ref', 'model_choice', 'verification_plan', 'scope', 'app_plan', 'web_plan', 'event_trigger'})
            or (set(value) & _PINS and not _PINS <= set(value))):
        _fail('Supply the complete source-only setup; an existing Pip needs pip_id, expected_version and expected_lifecycle_revision together.')
    request = dict(value)
    for key, maximum in (('target_root', 4096), ('name', 120), ('goal', 4000), ('reason', 1000), ('request_key', 64)):
        request[key] = _text(value[key], key, maximum, multiline=key in ('goal', 'reason'))
    if not Path(request['target_root']).is_absolute():
        _fail('target_root must be the absolute project folder. Open that project before proposing its Pip.')
    if re.fullmatch(r'[A-Za-z0-9_-]{1,64}', request['request_key']) is None:
        _fail('request_key must use 1–64 letters, digits, underscores or hyphens.')
    personal = value.get('scope', 'project') == 'personal'
    if value.get('scope','project') not in ('project','personal'):_fail('Choose project or personal scope.')
    if 'app_plan' in value:
        from .pip_app_access import validate as validate_apps
        request['app_plan'] = validate_apps(value['app_plan'])
        if not personal:_fail('App reads currently require personal scope.')
    if 'web_plan' in value:
        from .pip_web_reads import validate as validate_web
        request['web_plan'] = validate_web(value['web_plan'])
        if not personal:_fail('Web reads currently require personal scope.')
    pulse = value['pip_type'] == 'pulse' and not personal
    if type(value['pip_type']) is not str or value['pip_type'] not in _AUDIT | {'quill', 'pulse'}:
        _fail('Conversational setup supports source reviewers, Quill and reviewed Pulse plans.')
    if personal:
        if value['work_kind'] != 'personal_task' or 'verification_plan' in value:
            _fail('Personal setup needs personal_task and cannot contain project command permissions.')
    elif pulse:
        from .pip_pulse_plans import validate_plan
        plan = validate_plan(value.get('verification_plan'))
        if plan is None:
            _fail('Pulse needs an exact verification_plan for human review; a goal alone cannot authorize tests.')
        expected_kind = 'app_smoke_test' if plan['action']['network'] == 'loopback_http_v1' else 'command_verification'
        if value['work_kind'] != expected_kind:
            _fail('The work kind must match the reviewed command or local HTTP plan.', 'unsupported_work_kind')
        request['verification_plan'] = plan
    else:
        if 'verification_plan' in value:
            _fail('Only Pulse accepts a reviewed verification plan.')
        if value['work_kind'] == 'app_smoke_test':
            _fail('An application smoke test needs a reviewed Pulse execution plan and a confirmed local URL. Do not substitute a source review.', 'unsupported_work_kind')
        if value['work_kind'] != ('documentation_draft' if value['pip_type'] == 'quill' else 'source_review'):
            _fail('The work kind must match the Pip role.', 'unsupported_work_kind')
    if type(value['run_now']) is not bool:
        _fail('run_now must be an explicit true or false.')
    if 'event_trigger' in value:
        # One trigger fits a setup card: review the committed source after each new commit to
        # source_ref. Path rules and other events stay with the Pip's own job controls.
        if personal or value['pip_type'] not in _AUDIT | {'quill'} or _PINS & set(value):
            _fail('A commit trigger on a setup card is for a new project reviewer or Quill.', 'unsupported_setup')
        if value['schedule'] is not None:
            _fail('A Pip runs on a schedule or after commits, not both.', 'invalid_event_trigger')
        from .pip_event_triggers import validate_event_trigger
        trigger = validate_event_trigger(value['event_trigger'])
        if trigger is None or trigger['events'] != ['commit_changed']:
            _fail('A setup card can only trigger a review after each new commit.', 'unsupported_setup')
        request['event_trigger'] = trigger
    from .pip_schedules import validate_schedule
    request['schedule'] = validate_schedule(value['schedule'])
    request['source_ref'] = _text(value.get('source_ref', 'HEAD'), 'source_ref', 200)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*', request['source_ref']) or '..' in request['source_ref']:
        _fail('source_ref must be HEAD, a branch name or a full commit ID.')
    if _PINS <= set(value):
        _id(value['pip_id'], 'pip')
        _integer(value['expected_version'], 'expected_version', 1, 999998)
        _integer(value['expected_lifecycle_revision'], 'expected_lifecycle_revision', 0, 2**53 - 2)
    if 'model_choice' in value:
        from .pip_models import validate_model_choice
        request['model_choice'] = validate_model_choice(value['model_choice'])
    _encode(request)
    return request


def validate_root(request, root):
    """Called by the model executor BEFORE it opens registry state."""
    selected = canonical_directory(root)
    target = canonical_directory(request['target_root'])
    if target != selected:
        _fail('The requested project differs from this chat workspace. Open the requested project and ask there; no Pip was created or changed.', 'workspace_mismatch')
    return selected


def _root_identity(root):
    info = Path(root).stat()
    return {'device': info.st_dev, 'inode': info.st_ino}


def _scope(registry, root, session_id, personal=False):
    if personal:
        identity=registry.session_identity(session_id)
        workspace=registry.personal()
        binding=registry.binding(workspace['id'])
        if identity is None or binding['canonical_root'] != str(root):
            _fail('Personal setup needs a known local chat and its private profile binding.', 'session_required')
        return workspace,binding
    workspace = registry.lookup(root)
    if workspace is None:
        _fail('This chat needs an existing registered Pips workspace before drafting setup.', 'not_found')
    identity = registry.session_identity(session_id)
    binding = registry.binding(workspace['id'])
    if (identity is None or identity['workspace_id'] != workspace['id']
            or identity['workspace_binding_id'] != binding['id'] or binding['canonical_root'] != str(root)):
        _fail('The owning chat is not authoritatively associated with this project binding.', 'session_required')
    return workspace, binding


def _definition(store, request, workspace_id):
    from .pips import _definition as build_definition
    personal=request.get('scope')=='personal'
    extra = {'source_policy': {'mode':'personal'}} if personal else {}
    if 'app_plan' in request:extra['app_plan']=request['app_plan']
    if 'web_plan' in request:extra['web_plan']=request['web_plan']
    if 'pip_id' in request:
        from .pip_adaptation import can_propose
        from .pip_archive import require_live
        pip = store._job(request['pip_id'])
        if pip['workspace_id'] != workspace_id:
            _fail('Pip not found in this workspace.', 'not_found')
        require_live(store, request['pip_id'])
        if (pip['current_version'] != request['expected_version']
                or pip['lifecycle_revision'] != request['expected_lifecycle_revision']):
            _fail('The Pip job or lifecycle changed. Read its current definition before drafting again.', 'conflict')
        if pip['pip_type'] != request['pip_type']:
            _fail('Setup cannot change an existing Pip character or role. Create a new Pip instead.', 'conflict')
        if not can_propose(pip['adaptation_policy']):
            _fail('This Pip does not allow model setup proposals. Use its human controls.', 'permission_denied')
        if pip.get('event_trigger') is not None or pip['source_policy'] != {'mode': 'personal' if personal else 'committed_only'}:
            _fail('This Pip uses event triggers or current-tree source. Review those separately before using conversational calendar setup.', 'unsupported_setup')
        extra = {**extra, **{key: pip[key] for key in ('model_choice', 'adaptation_policy', 'source_policy')}, 'app_plan': request.get('app_plan',pip.get('app_plan')),
                 'web_plan': request.get('web_plan',pip.get('web_plan')), 'github_plan': pip.get('github_plan')}
    if 'model_choice' in request:
        extra['model_choice'] = request['model_choice']
    if 'verification_plan' in request:
        extra['verification_plan'] = request['verification_plan']
    if 'event_trigger' in request:
        extra['event_trigger'] = request['event_trigger']
    return build_definition(**{key: request[key] for key in ('name', 'goal', 'source_ref', 'schedule', 'pip_type')}, **extra)


def _plan(schedule, run_now, created_at):
    from .pip_schedules import _instant, next_due, timestamp
    after = _instant(created_at)
    counts_for = None
    if schedule is not None and schedule['type'] == 'daily' and run_now:
        zone = ZoneInfo(schedule['timezone'])
        day = after.astimezone(zone).date()
        counts_for = day.isoformat()
        # The requested immediate run consumes this local day's occurrence,
        # including when the user accepts before the displayed clock time.
        after = datetime.combine(day + timedelta(days=1), time.min, zone) - timedelta(microseconds=1)
    due = next_due(schedule, after, created_at)
    if schedule is not None and due is None:
        _fail('The one-time occurrence has passed. Choose a future instant and review again.', 'invalid_schedule')
    return due, counts_for


def _load(registry, setup_id, workspace_id):
    _id(setup_id, 'setup'); _id(workspace_id, 'ws')
    row = registry.db.execute('''SELECT id,workspace_id,session_id,request_key,request_digest,digest,status,created_at,expires_at,
        CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB))<=16384 THEN body END AS body,
        CASE WHEN receipt IS NULL OR (typeof(receipt)='text' AND length(CAST(receipt AS BLOB))<=4096) THEN receipt ELSE '!' END AS receipt
        FROM pip_setup_proposals WHERE id=? AND workspace_id=?''', (setup_id, workspace_id)).fetchone()
    if row is None:
        _fail('Setup not found in this workspace.', 'not_found')
    try:
        body = json.loads(row['body'])
        if type(body) is not dict or set(body) != _BODY or body['schema_version'] != 1 or _digest(body) != row['digest']:
            raise ValueError()
        for key in ('workspace_id', 'session_id', 'created_at', 'expires_at'):
            if body[key] != row[key]:
                raise ValueError()
        request = validate_request(body['request'])
        if request != body['request'] or request['request_key'] != row['request_key'] or _digest(request) != row['request_digest']:
            raise ValueError()
        from .pips import _definition as build_definition
        definition = body['definition']
        checked = build_definition(**{k: definition.get(k) for k in ('name', 'goal', 'source_ref', 'schedule', 'pip_type', 'model_choice', 'adaptation_policy', 'event_trigger', 'source_policy', 'verification_plan', 'app_plan', 'web_plan', 'github_plan')})
        if checked != definition or any(definition[k] != request[k] for k in ('name', 'goal', 'source_ref', 'schedule', 'pip_type')):
            raise ValueError()
        if 'model_choice' in request and definition['model_choice'] != request['model_choice']:
            raise ValueError()
        if definition.get('verification_plan') != request.get('verification_plan'): raise ValueError()
        personal=request.get('scope')=='personal'
        if (definition['policy'] != ('review_required' if request['pip_type'] == 'pulse' and not personal else 'read_only') or definition['source_policy'] != {'mode': 'personal' if personal else 'committed_only'}
                or definition['event_trigger'] != request.get('event_trigger') or body['project_root'] != request['target_root']):
            raise ValueError()
        from .pip_approvals import expires_at
        if body['expires_at'] != expires_at(body['created_at']) or _plan(request['schedule'], request['run_now'], body['created_at']) != (body['next_run_at'], body['counts_for_date']):
            raise ValueError()
        receipt = json.loads(row['receipt']) if row['receipt'] is not None else None
        if row['status'] == 'pending':
            if receipt is not None: raise ValueError()
        else:
            receipt_fields = {'setup_id', 'pip_id', 'job_version', 'run_id', 'next_run_at', 'accepted', 'actor', 'resolved_at'}
            if (type(receipt) is not dict or set(receipt) - {'replacement_setup_id'} != receipt_fields
                    or receipt['setup_id'] != setup_id or type(receipt['accepted']) is not bool
                    or receipt['accepted'] != (row['status'] == 'accepted')): raise ValueError()
            _text(receipt['actor'], 'actor', 128)
            if 'replacement_setup_id' in receipt:
                if receipt['accepted']: raise ValueError()
                _id(receipt['replacement_setup_id'], 'setup')
            from .pip_schedules import timestamp
            if timestamp(receipt['resolved_at']) != receipt['resolved_at']: raise ValueError()
            if receipt['accepted']:
                _id(receipt['pip_id'], 'pip'); _integer(receipt['job_version'], 'job_version', 1, 999999)
                if receipt['job_version'] != request.get('expected_version', 0) + 1 or ('pip_id' in request and receipt['pip_id'] != request['pip_id']): raise ValueError()
                if request['run_now']: _id(receipt['run_id'], 'run')
                elif receipt['run_id'] is not None: raise ValueError()
                if receipt['next_run_at'] != body['next_run_at']: raise ValueError()
            elif (receipt['pip_id'] != request.get('pip_id') or receipt['job_version'] != request.get('expected_version')
                    or receipt['run_id'] is not None or receipt['next_run_at'] is not None): raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError, RegistryError) as exc:
        _fail('The saved setup or receipt no longer matches its bounded review. Nothing was applied.', 'review_changed')
    return dict(row), body, receipt


def _projection(registry, row, body, receipt):
    from .pip_schedules import timestamp
    req = body['request']
    status = row['status']
    if status == 'pending' and timestamp(registry.clock()) >= body['expires_at']:
        status = 'expired'
    return {'id': row['id'], 'digest': row['digest'], 'workspace_id': row['workspace_id'],
            'project_root': body['project_root'], 'pip_id': req.get('pip_id'),
            **{key: req[key] for key in ('name', 'goal', 'pip_type', 'work_kind', 'source_ref', 'schedule', 'run_now', 'reason')},
            'next_run_at': body['next_run_at'], 'status': status, 'created_at': body['created_at'], 'expires_at': body['expires_at'],
            'expected_version': req.get('expected_version'), 'expected_lifecycle_revision': req.get('expected_lifecycle_revision'),
            'model_choice': body['definition']['model_choice'],
            **({'app_plan': body['definition']['app_plan']} if body['definition'].get('app_plan') else {}),
            **({'web_plan': body['definition']['web_plan']} if body['definition'].get('web_plan') else {}),
            **({'event_trigger': req['event_trigger']} if req.get('event_trigger') else {}),
            'receipt': receipt, 'permissions': body['definition']['policy'], 'source_policy': 'personal' if req.get('scope')=='personal' else 'committed_only',
            **({'verification_plan': req['verification_plan']} if req['pip_type'] == 'pulse' and req.get('scope')!='personal' else {}),
            'scope_notice': ('Personal scope. No project files, shell or browsing. Only the reviewed app reads and web reads listed here, if any.' if req.get('scope')=='personal' else pulse_scope(req['verification_plan']) if req['pip_type'] == 'pulse' else SCOPE_NOTICE),
            'runner_notice': (f"DGC checks {req['source_ref']} for new local commits only while the local Pips runner is enabled and running, and reviews at most every {req['event_trigger']['minimum_minutes']} minutes. Saving setup does not start or resume the runner."
                              if req.get('event_trigger') else 'A schedule runs only while the local Pips runner is enabled and running. Saving setup does not start or resume the runner.'),
            'run_now_policy': ("The immediate run counts as today's daily occurrence; the next scheduled run is on the following local date."
                               if body['counts_for_date'] else 'Queue one run after approval, in addition to the displayed future schedule.' if req['run_now'] else None)}


def get(registry, setup_id, workspace_id):
    return _projection(registry, *_load(registry, setup_id, workspace_id))


def list_pending(registry, workspace_id):
    _id(workspace_id, 'ws')
    from .pip_schedules import timestamp
    rows = registry.db.execute("SELECT id FROM pip_setup_proposals WHERE workspace_id=? AND status='pending' AND expires_at>? ORDER BY created_at,id LIMIT ?",
                               (workspace_id, timestamp(registry.clock()), MAX_LIST)).fetchall()
    return [get(registry, row['id'], workspace_id) for row in rows]


def propose(registry, request, root, session_id, actor='core_setup'):
    request = validate_request(request)
    root = validate_root(request, root)
    if request.get('scope')=='personal':
        # Validate the originating chat before switching to private profile storage.
        _scope(registry,root,session_id)
        root=Path(registry.binding(registry.personal()['id'])['canonical_root'])
    request['target_root'] = str(root)
    _text(session_id, 'session_id', 256)
    if actor != 'core_setup': _fail('Setup drafts need the trusted chat origin.', 'session_required')
    from .redaction import contains_secret
    if contains_secret(request): _fail('Do not include credentials in setup requests.', 'secret_detected')
    with registry.transaction():
        return _store_draft(registry, request, root, session_id)


def _store_draft(registry, request, root, session_id, *, setup_id=None):
    """Store a validated request under the caller's existing write transaction."""
    from .pips import PipStore
    from .pip_schedules import timestamp
    from .pip_approvals import expires_at
    workspace, binding = _scope(registry, root, session_id, request.get('scope')=='personal')
    digest = _digest(request)
    prior = registry.db.execute('SELECT id,workspace_id,request_digest FROM pip_setup_proposals WHERE session_id=? AND request_key=?', (session_id, request['request_key'])).fetchone()
    if prior:
        if prior['workspace_id'] != workspace['id'] or prior['request_digest'] != digest:
            _fail('This setup retry key belongs to different content.', 'conflict')
        return get(registry, prior['id'], workspace['id'])
    now = timestamp(registry.clock())
    if registry.db.execute("SELECT count(*) FROM pip_setup_proposals WHERE workspace_id=? AND status='pending' AND expires_at>?", (workspace['id'], now)).fetchone()[0] >= MAX_PENDING:
        _fail('Review existing setup cards before adding more; this workspace has 20 pending drafts.', 'limit')
    if registry.db.execute('SELECT count(*) FROM pip_setup_proposals').fetchone()[0] >= MAX_RETAINED:
        _fail('The local setup archive is full at 1,000 drafts. No setup was stored.', 'limit')
    definition = _definition(PipStore(registry), request, workspace['id'])
    due, counts_for = _plan(request['schedule'], request['run_now'], now)
    body = {'schema_version': 1, 'request': request, 'definition': definition,
            'workspace_id': workspace['id'], 'binding_id': binding['id'], 'runner_id': registry.runner_id,
            'project_root': str(root), 'root_identity': _root_identity(root), 'session_id': session_id,
            'created_at': now, 'expires_at': expires_at(now), 'next_run_at': due, 'counts_for_date': counts_for}
    setup_id = setup_id or identifier('setup')
    registry.db.execute('INSERT INTO pip_setup_proposals VALUES(?,?,?,?,?,?,?,\'pending\',NULL,?,?)',
                        (setup_id, workspace['id'], session_id, request['request_key'], digest, _encode(body), _digest(body), now, body['expires_at']))
    registry.event(workspace['id'], 'pip_setup_proposed', pip_id=request.get('pip_id'), payload={'setup_id': setup_id, 'digest': _digest(body)}, created_at=now)
    return get(registry, setup_id, workspace['id'])


def revise(registry, setup_id, workspace_id, expected_digest, model_choice, actor, config):
    """Human model selection creates a replacement card, never an approved job.

The original receipt links its replacement so replay is durable even after event
retention. Original bodies/digests stay immutable. An unrelated rejection cannot
be reopened, and changing the replacement again requires its own current digest.
"""
    actor = _text(actor, 'authenticated actor', 128)
    if actor.startswith(('core_', 'model', 'local-scheduler', 'local-event-trigger')):
        _fail('Only an authenticated human control may revise setup.', 'permission_denied')
    if type(expected_digest) is not str or re.fullmatch('[0-9a-f]{64}', expected_digest) is None:
        _fail('Review requires the exact displayed setup digest.')
    from .pip_access import require_unrestricted
    from .pip_models import validate_model_choice, resolve_model_choice
    from .pip_schedules import timestamp
    from .redaction import contains_secret, secret_values
    require_unrestricted(config)
    if config.get('pips_enabled', False) is not True:
        _fail('Enable Pips before revising setup.', 'disabled')
    choice = validate_model_choice(model_choice)
    row, body, _ = _load(registry, setup_id, workspace_id)
    if row['digest'] != expected_digest:
        _fail('The displayed setup changed. Read the current card before revising.', 'review_changed')
    if body['request'].get('scope')=='personal':
        config=config.clone_for_root(Path(registry.binding(registry.personal()['id'])['canonical_root']))
    root = canonical_directory(config.project_root)
    if str(root) != body['project_root']:
        _fail('Open the setup card in its original project before revising it.', 'workspace_mismatch')
    # Model discovery is outside the SQLite transaction. An idempotent retry of
    # a completed revision only reads its receipt and needs no provider request.
    if row['status'] == 'pending':
        resolve_model_choice(config, choice)
    with registry.transaction():
        row, body, receipt = _load(registry, setup_id, workspace_id)
        if row['digest'] != expected_digest:
            _fail('The displayed setup changed. Read the current card before revising.', 'review_changed')
        request = {**body['request'], 'model_choice': choice,
                   'request_key': 'rev_' + _digest({'setup_id': setup_id, 'digest': expected_digest,
                                                   'model_choice': choice})[:60]}
        request = validate_request(request)
        if row['status'] != 'pending':
            replacement = receipt.get('replacement_setup_id') if receipt else None
            if row['status'] != 'rejected' or replacement is None:
                _fail('This setup was already resolved. Ask for a new card.', 'conflict')
            child_row, child_body, child_receipt = _load(registry, replacement, workspace_id)
            if child_body['request'] != request or child_body['session_id'] != body['session_id']:
                _fail('This setup was revised with a different model. Refresh its replacement card.', 'conflict')
            return _projection(registry, child_row, child_body, child_receipt)
        now = timestamp(registry.clock())
        if now >= body['expires_at']:
            _fail('This setup expired. Ask for a fresh card.', 'expired')
        workspace, binding = _scope(registry, root, body['session_id'], body['request'].get('scope')=='personal')
        if (workspace['id'] != workspace_id or binding['id'] != body['binding_id']
                or registry.runner_id != body['runner_id'] or _root_identity(root) != body['root_identity']):
            _fail('The project binding or directory changed. Ask for a fresh setup card.', 'conflict')
        if contains_secret(request, secret_values(config)):
            _fail('The setup overlaps configured credentials. Ask for a draft without secrets.', 'secret_detected')
        if choice == body['definition']['model_choice']:
            return _projection(registry, row, body, receipt)
        replacement = identifier('setup')
        receipt = {'setup_id': setup_id, 'pip_id': request.get('pip_id'),
                   'job_version': request.get('expected_version'), 'run_id': None, 'next_run_at': None,
                   'accepted': False, 'actor': actor, 'resolved_at': now, 'replacement_setup_id': replacement}
        registry.db.execute("UPDATE pip_setup_proposals SET status='rejected',receipt=? WHERE id=? AND status='pending'",
                            (_encode(receipt, 4096), setup_id))
        result = _store_draft(registry, request, root, body['session_id'], setup_id=replacement)
        if result['id'] != replacement:
            _fail('The replacement retry key is already in use. Refresh the setup card.', 'conflict')
        registry.event(workspace_id, 'pip_setup_revised', pip_id=request.get('pip_id'),
                       payload={'setup_id': setup_id, 'replacement_setup_id': replacement,
                                'digest': result['digest'], 'actor': actor}, created_at=now)
        return result


def _prepare_immediate_audit(registry, body, pip_id):
    """Read-only preflight for the unchanged native queue's checkpoint CAS.

The new identity is not yet stored. Its only valid prior checkpoint is empty;
enqueue recomputes that pin after insertion inside the acceptance transaction.
Existing targets retain their actual checkpoint and reviewed finding history.
"""
    from .pips import PipStore, source_revision
    from . import pip_checkpoints
    from .pip_source_changes import snapshot_for_source
    from .pip_sources import pin
    request = body['request']
    binding = registry.binding(body['workspace_id'])
    if binding['id'] != body['binding_id'] or binding['canonical_root'] != body['project_root']:
        _fail('The project binding changed. Ask for a fresh setup card.', 'conflict')
    store = PipStore(registry)
    lifecycle = 0
    if request.get('pip_id'):
        pip = store._job(pip_id)
        _definition(store, request, body['workspace_id'])
        checkpoint = pip_checkpoints.snapshot(store, pip_id)
        lifecycle = pip['lifecycle_revision'] + int(pip['status'] == 'paused')
    else:
        checkpoint = pip_checkpoints._pin({'schema_version': 1, 'pip_id': pip_id,
                                          'workspace_id': body['workspace_id'], 'checkpoint': None})
    revision = source_revision(binding['canonical_root'], request['source_ref'])
    source = pin('committed_only', source_revision=revision)
    return {'pip_id': pip_id, 'workspace_id': body['workspace_id'], 'job_version': request.get('expected_version', 0) + 1,
            'lifecycle_revision': lifecycle, 'binding_id': binding['id'], 'canonical_root': binding['canonical_root'],
            'source_revision': revision, 'checkpoint': checkpoint,
            'changes': snapshot_for_source(binding['canonical_root'], source, checkpoint)}


def review(registry, setup_id, workspace_id, expected_digest, actor, config, accept: bool):
    """Human control only. No model executor may expose this function."""
    if type(accept) is not bool: _fail('Accept or reject must be an explicit human choice.')
    actor = _text(actor, 'authenticated actor', 128)
    if actor.startswith(('core_', 'model', 'local-scheduler', 'local-event-trigger')):
        _fail('Only an authenticated human control may review setup.', 'permission_denied')
    if type(expected_digest) is not str or re.fullmatch('[0-9a-f]{64}', expected_digest) is None:
        _fail('Review requires the exact displayed setup digest.')
    from .pip_access import require_unrestricted
    require_unrestricted(config)
    if config.get('pips_enabled', False) is not True: _fail('Enable Pips before reviewing setup.', 'disabled')
    from .pips import PipStore, _json
    from .pip_schedules import _instant, timestamp
    from .redaction import contains_secret, secret_values
    # require_supervisor opens its own registry. Never call it under this
    # connection's write lock, and exact accepted retries need no live worker.
    preview, saved_body, _ = _load(registry, setup_id, workspace_id)
    if preview['digest'] != expected_digest:
        _fail('The displayed setup changed. Read the current card before reviewing.', 'review_changed')
    personal=saved_body['request'].get('scope')=='personal'
    if personal:
        config=config.clone_for_root(Path(registry.binding(registry.personal()['id'])['canonical_root']))
    model_preparation = None
    if accept and preview['status'] == 'pending' and (saved_body['request']['pip_type'] != 'pulse' or personal) and ('model_choice' in saved_body['request'] or saved_body['request']['run_now']):
        if str(canonical_directory(config.project_root)) != saved_body['project_root']:
            _fail('Open the setup card in its original project before accepting it.', 'workspace_mismatch')
        from .pips import _model_settings
        choice = saved_body['definition']['model_choice']
        model_preparation = {'choice': choice,
                             'settings': _model_settings(config.clone_for_root(Path(saved_body['project_root'])), choice)}
    planned_pip_id = saved_body['request'].get('pip_id') or identifier('pip')
    audit_preparation = None
    if accept and preview['status'] == 'pending' and saved_body['request']['run_now']:
        # Do not inspect Git or another directory just because a caller supplied
        # its workspace ID. The selected human control's root must agree first.
        if str(canonical_directory(config.project_root)) != saved_body['project_root']:
            _fail('Open the setup card in its original project before accepting it.', 'workspace_mismatch')
        if timestamp(registry.clock()) >= saved_body['expires_at']:
            _fail('This setup expired. Ask for a fresh card.', 'expired')
        if contains_secret(saved_body, secret_values(config)):
            _fail('The setup overlaps configured credentials. Ask for a draft without secrets.', 'secret_detected')
        from .pip_runtime import require_supervisor
        require_supervisor(config)
        if saved_body['request']['pip_type'] == 'pulse' and not personal:
            # Warm the bounded OS probe before holding SQLite's writer lock.
            # enqueue rechecks the cached capability and exact plan pins.
            from .pip_execution import require_capability
            require_capability()
        if saved_body['request']['pip_type'] in _AUDIT and not personal:
            audit_preparation = _prepare_immediate_audit(registry, saved_body, planned_pip_id)
    with registry.transaction():
        row, body, receipt = _load(registry, setup_id, workspace_id)
        if row['digest'] != expected_digest: _fail('The displayed setup changed. Read the current card before reviewing.', 'review_changed')
        if row['status'] != 'pending':
            if (row['status'] == 'accepted') != accept: _fail('This setup was already resolved with a different decision.', 'conflict')
            return _projection(registry, row, body, receipt)
        now = timestamp(registry.clock())
        if now >= body['expires_at']: _fail('This setup expired. Ask for a fresh card.', 'expired')
        request = body['request']
        receipt = {'setup_id': setup_id, 'pip_id': request.get('pip_id'), 'job_version': request.get('expected_version'),
                   'run_id': None, 'next_run_at': None, 'accepted': accept, 'actor': actor, 'resolved_at': now}
        if accept:
            root = canonical_directory(config.project_root)
            if str(root) != body['project_root']:
                _fail('Open the setup card in its original project before accepting it.', 'workspace_mismatch')
            workspace, binding = _scope(registry, root, body['session_id'], body['request'].get('scope')=='personal')
            if (workspace['id'] != workspace_id or binding['id'] != body['binding_id']
                    or registry.runner_id != body['runner_id'] or _root_identity(root) != body['root_identity']):
                _fail('The project binding or directory changed. Ask for a fresh setup card.', 'conflict')
            if contains_secret(body, secret_values(config)):
                _fail('The setup overlaps configured credentials. Ask for a draft without secrets.', 'secret_detected')
            if body['next_run_at'] is not None and now >= body['next_run_at']:
                _fail('The displayed next occurrence has passed. Ask for a fresh setup card.', 'stale_occurrence')
            if body['counts_for_date'] is not None and _instant(now).astimezone(ZoneInfo(request['schedule']['timezone'])).date().isoformat() != body['counts_for_date']:
                _fail("The local date changed. Review today's immediate run and the next occurrence again.", 'stale_occurrence')
            store = PipStore(registry)
            if _definition(store, request, workspace_id) != body['definition']:
                _fail('The saved definition no longer matches this setup.', 'review_changed')
            pip_id = planned_pip_id
            if 'pip_id' in request:
                if registry.db.execute("SELECT 1 FROM pip_runs WHERE pip_id=? AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1", (pip_id,)).fetchone():
                    _fail('Finish or cancel this Pip\'s queued or active work before accepting setup.', 'pip_busy')
                if registry.db.execute("SELECT 1 FROM pip_approvals WHERE pip_id=? AND status='pending' AND expires_at>? LIMIT 1", (pip_id, now)).fetchone():
                    _fail('Resolve this Pip\'s existing job reviews before accepting setup.', 'pending_review')
            elif registry.db.execute('SELECT count(*) FROM pips WHERE workspace_id=?', (workspace_id,)).fetchone()[0] >= 100:
                _fail('This workspace already has 100 Pips.', 'limit')
            from .pips import source_revision
            if not personal:source_revision(root, body['definition']['source_ref'])
            version = request.get('expected_version', 0) + 1
            if 'pip_id' not in request:
                registry.db.execute('INSERT INTO pips VALUES(?,?,?,?,?,?)', (pip_id, workspace_id, 'active', version, now, now))
            registry.db.execute('INSERT INTO pip_versions VALUES(?,?,?,?,?,?)', (pip_id, version, _json(body['definition']), actor, request['reason'], now))
            if 'pip_id' in request:
                registry.db.execute("UPDATE pips SET current_version=?,status='active',updated_at=? WHERE id=? AND current_version=?",
                                    (version, now, pip_id, request['expected_version']))
            registry.db.execute('DELETE FROM pip_schedule_state WHERE pip_id=?', (pip_id,))
            if request['schedule'] is not None:
                # The reviewed occurrence stays exact. Anchor at draft creation
                # allows interval previews to survive a later human acceptance.
                registry.db.execute('INSERT INTO pip_schedule_state VALUES(?,?,?,?,NULL,NULL)',
                                    (pip_id, version, body['created_at'], body['next_run_at']))
            if request.get('event_trigger') is not None:
                from .pip_event_triggers import reset_trigger
                reset_trigger(registry, pip_id, version, request['event_trigger'], now)
            pulse_request = None
            if request['pip_type'] == 'pulse' and not personal:
                # This human setup decision is also the exact durable execution
                # review. Reuse the existing approval lineage, including v1's
                # expected_version=0; the model never reaches this control.
                from . import pip_approvals
                from .pip_pulse_plans import plan_digest
                proposal_id = identifier('proposal')
                registry.db.execute('INSERT INTO pip_proposals VALUES(?,?,?,?,?,?,?,?)',
                    (proposal_id, pip_id, version - 1, _json(body['definition']), 'core_setup',
                     'Reviewed setup ' + setup_id + ': ' + request['reason'], 'proposed', body['created_at']))
                proposal = registry.db.execute('SELECT * FROM pip_proposals WHERE id=?', (proposal_id,)).fetchone()
                approval_id = pip_approvals.create(registry, proposal, workspace_id, session_id=body['session_id'], schedule_changed=request['schedule'] is not None)
                approval = registry.db.execute('SELECT * FROM pip_approvals WHERE id=?', (approval_id,)).fetchone()
                pip_approvals.resolve(registry, approval, 'approved', actor, now)
                registry.db.execute("UPDATE pip_proposals SET status='accepted' WHERE id=?", (proposal_id,))
                pulse_request = {'actor': actor, 'idempotency_key': 'setup-' + setup_id, 'expected_version': version,
                    'expected_lifecycle_revision': store._job(pip_id)['lifecycle_revision'],
                    'expected_plan_digest': plan_digest(request['verification_plan'])}
            run = store.enqueue(pip_id, 'setup-' + setup_id, actor, config, _audit_preparation=audit_preparation,
                                _model_preparation=model_preparation, pulse_request=pulse_request) if request['run_now'] else None
            receipt.update(pip_id=pip_id, job_version=version, run_id=run['id'] if run else None, next_run_at=body['next_run_at'])
            registry.event(workspace_id, 'pip_setup_accepted', pip_id=pip_id, run_id=receipt['run_id'],
                           payload={'setup_id': setup_id, 'digest': expected_digest, 'job_version': version, 'next_run_at': body['next_run_at']}, created_at=now)
        else:
            registry.event(workspace_id, 'pip_setup_rejected', pip_id=request.get('pip_id'), payload={'setup_id': setup_id, 'digest': expected_digest}, created_at=now)
        changed = registry.db.execute("UPDATE pip_setup_proposals SET status=?,receipt=? WHERE id=? AND status='pending'",
                                      ('accepted' if accept else 'rejected', _encode(receipt, 4096), setup_id)).rowcount
        if changed != 1: _fail('This setup was resolved elsewhere. Refresh its card.', 'conflict')
        return get(registry, setup_id, workspace_id)


def pulse_scope(plan):
    if plan['action']['network'] == 'loopback_http_v1':
        return ('Only the displayed local HTTP GET checks. No redirects, cookies, credentials, external hosts or shell commands. '
                '10 seconds and 64 KiB response body per check. Status checks do not verify rendering, login success or user journeys. '
                'The running app may differ from the recorded committed source. No model is invoked.')
    return ('Only the displayed commands, in an isolated committed-source copy with network off. '
            '60 seconds, 30 CPU seconds, 512 MiB per process, 64 KiB output and 32 processes per command. '
            'No changes are applied to the project. No model is invoked.')
