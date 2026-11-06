"""Durable, bounded Pip workflows.

Routing a result is independent of permission to use a tool. Each edge uses the
ordinary handoff ledger; unattended mode only answers that *handoff* review.
The receiving Pip keeps its own Ask/Approve/Full level and app grants.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone

from .workspace_registry import RegistryError, identifier

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_flows (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 name TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('reviewed','unattended')),
 definition TEXT NOT NULL CHECK(length(CAST(definition AS BLOB))<=16384),
 definition_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('on','paused','retired')),
 revision INTEGER NOT NULL CHECK(revision>=0),
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 enabled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pip_flows_workspace ON pip_flows(workspace_id,created_at,id);
CREATE TABLE IF NOT EXISTS pip_flow_steps (
 id TEXT PRIMARY KEY,
 flow_id TEXT NOT NULL REFERENCES pip_flows(id),
 stage INTEGER NOT NULL CHECK(stage>=0 AND stage<=2),
 source_run_id TEXT NOT NULL REFERENCES pip_runs(id),
 handoff_id TEXT UNIQUE REFERENCES pip_handoffs(id),
 status TEXT NOT NULL CHECK(status IN ('review','queued','paused')),
 reason TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(flow_id,stage,source_run_id)
);
CREATE INDEX IF NOT EXISTS pip_flow_steps_source ON pip_flow_steps(source_run_id);
CREATE INDEX IF NOT EXISTS pip_flow_steps_handoff ON pip_flow_steps(handoff_id);
"""

MODES = ('reviewed', 'unattended')
MAX_FLOWS = 20
MAX_PIPS = 4
PROJECT_READERS = frozenset({'scout', 'lens', 'rook', 'lock'})
LOCAL = ('editor-user', 'local-console')


def _fail(message, code='invalid_flow'):
    raise RegistryError(code, message)


def _text(value, label, maximum, *, multiline=False):
    from .pip_handoffs import _text as bounded
    try:
        return bounded(value, label, maximum, multiline=multiline)
    except RegistryError as exc:
        raise RegistryError('invalid_flow', str(exc)) from exc


def _encoded(value):
    try:
        data = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise RegistryError('invalid_flow', 'Workflow definition must be bounded JSON.') from exc
    if len(data) > 16384:
        _fail('Workflow definition exceeds 16 KiB.')
    return data


def _digest(value):
    return hashlib.sha256(_encoded(value)).hexdigest()


def _now(store):
    from .pip_handoffs import _now
    return _now(store)


def _pin(store, pip_id, config):
    from .pip_archive import require_live
    from .pip_handoffs import connection_digest
    from .pip_models import validate_pinned_connection
    from .pips import _model_settings
    from pathlib import Path
    job = store._job(pip_id)
    require_live(store, pip_id)
    kind = store.registry.get(job['workspace_id'])['kind']
    root = store.registry.binding(job['workspace_id'])['canonical_root']
    source_mode = job['source_policy'].get('mode') if isinstance(job['source_policy'], dict) else None
    if job['status'] != 'active' or (kind == 'personal' and source_mode != 'personal') \
            or (kind != 'personal' and (source_mode != 'committed_only'
                                       or job['pip_type'] not in PROJECT_READERS
                                       or not (Path(root)/'.git').exists())) or kind not in ('personal', 'git', 'folder'):
        _fail('A workflow needs active Pips of one kind. Project workflows use committed source and read-only Pips.')
    model = _model_settings(config.clone_for_root(Path(root)), job['model_choice'], personal=kind=='personal')
    validate_pinned_connection(config, model)
    return {'pip_id': pip_id, 'job_version': job['current_version'],
            'lifecycle_revision': job['lifecycle_revision'], 'model': model['model'],
            'connection_digest': connection_digest(model), 'app_plan_digest': _digest(job.get('app_plan')),
            'web_plan_digest': _digest(job.get('web_plan'))}


def _definition(store, pip_ids, tasks, config):
    if (not isinstance(pip_ids, list) or not 2 <= len(pip_ids) <= MAX_PIPS
            or not all(isinstance(v, str) for v in pip_ids) or len(set(pip_ids)) != len(pip_ids)
            or not isinstance(tasks, list) or len(tasks) != len(pip_ids)-1):
        _fail('Choose two to four distinct Pips and one task for each handoff.')
    ids = [_text(value, 'Pip identity', 128) for value in pip_ids]
    words = [_text(value, 'Handoff task', 4000, multiline=True) for value in tasks]
    pins = [_pin(store, value, config) for value in ids]
    workspaces = {store._job(value)['workspace_id'] for value in ids}
    if len(workspaces) != 1:
        _fail('All Pips in a workflow must belong to the same workspace.')
    workspace = workspaces.pop()
    result = {'version': 1, 'kind': 'personal' if store.registry.get(workspace)['kind']=='personal' else 'project',
              'pips': pins, 'tasks': words, 'max_starts_per_day': 3}
    _encoded(result)
    return workspace, result


def _row(store, flow_id):
    _text(flow_id, 'Workflow identity', 128)
    raw = store.db.execute('SELECT * FROM pip_flows WHERE id=?', (flow_id,)).fetchone()
    if raw is None:
        _fail('Workflow not found.', 'not_found')
    row = dict(raw)
    if row['definition'] is None or len(row['definition'].encode('utf-8')) > 16384:
        _fail('Stored workflow exceeds its limit.', 'stored_data_limit')
    try:
        definition = json.loads(row['definition'])
    except (ValueError, TypeError, RecursionError) as exc:
        raise RegistryError('stored_data_limit', 'Stored workflow is malformed.') from exc
    if (_digest(definition) != row['definition_digest'] or definition.get('version') != 1
            or definition.get('kind') not in ('personal', 'project')
            or not isinstance(definition.get('pips'), list) or not 2 <= len(definition['pips']) <= MAX_PIPS
            or not isinstance(definition.get('tasks'), list)
            or len(definition['tasks']) != len(definition['pips'])-1):
        _fail('Stored workflow definition differs from its review.', 'stored_data_limit')
    row['definition'] = definition
    return row


def get(store, flow_id):
    row = _row(store, flow_id)
    row['steps'] = [dict(step) for step in store.db.execute(
        'SELECT s.id,s.stage,s.source_run_id,s.handoff_id,s.status,s.reason,s.created_at, '
        'h.status AS handoff_status,h.run_id AS target_run_id FROM pip_flow_steps s '
        'LEFT JOIN pip_handoffs h ON h.id=s.handoff_id '
        'WHERE s.flow_id=? ORDER BY s.created_at DESC,s.id DESC LIMIT 30', (flow_id,))]
    return row


def listing(store, workspace_id):
    _text(workspace_id, 'Workspace identity', 128)
    if store.registry.get(workspace_id)['kind'] not in ('personal', 'git', 'folder'):
        _fail('Choose a registered Personal or Project workspace.')
    return [get(store, row['id']) for row in store.db.execute(
        "SELECT id FROM pip_flows WHERE workspace_id=? AND status!='retired' ORDER BY created_at DESC,id DESC LIMIT ?",
        (workspace_id, MAX_FLOWS))]


def core_suggestions(store, workspace_id):
    """Find Core's reviewed team after all its Pip cards were accepted.

    Core never authorizes a route. The ordered setup receipts only prefill the
    local workflow form; the person supplies the tasks and reviews its mode.
    """
    if store.registry.get(workspace_id)['kind'] != 'personal':
        return []
    from .pip_setup import _load
    groups = {}
    rows = store.db.execute(
        "SELECT id,session_id,request_key,status FROM pip_setup_proposals "
        "WHERE workspace_id=? AND session_id LIKE 'core-pip:%' AND request_key LIKE 'core_%' "
        "ORDER BY created_at DESC,id DESC LIMIT 300", (workspace_id,)).fetchall()
    for row in rows:
        match = re.fullmatch(r'core_(run[0-9a-f]{32})_([0-2])', row['request_key'])
        if match:
            groups.setdefault((row['session_id'], match.group(1)), []).append((int(match.group(2)), row))
    existing = {tuple(pin['pip_id'] for pin in flow['definition']['pips'])
                for flow in listing(store, workspace_id)}
    suggestions = []
    for (session_id, _), entries in groups.items():
        if not 2 <= len(entries) <= 3 or sorted(index for index, _ in entries) != list(range(len(entries))):
            continue
        if any(row['status'] != 'accepted' for _, row in entries):
            continue
        pips = []
        for _, row in sorted(entries):
            _, body, receipt = _load(store.registry, row['id'], workspace_id)
            if (body['session_id'] != session_id or body['request'].get('scope') != 'personal'
                    or receipt is None or not receipt.get('accepted') or not receipt.get('pip_id')):
                break
            job = store._job(receipt['pip_id'])
            if job['status'] != 'active' or job['workspace_id'] != workspace_id:
                break
            pips.append({'pip_id': job['id'], 'name': job['name']})
        if len(pips) == len(entries) and tuple(p['pip_id'] for p in pips) not in existing:
            suggestions.append({'id': 'core_' + entries[0][1]['request_key'].split('_')[1],
                                'pips': pips})
        if len(suggestions) >= 5:
            break
    return suggestions


def create(store, name, pip_ids, tasks, mode, actor, config, *, expected_pins=None, unique_name=False):
    if actor not in (*LOCAL, 'work-reviewed'):
        _fail('Only you can create a Pip workflow on this computer.', 'local_only')
    name = _text(name, 'Workflow name', 120)
    if mode not in MODES:
        _fail('Choose reviewed or unattended routing.')
    workspace, definition = _definition(store, pip_ids, tasks, config)
    from .redaction import redact_value, secret_values
    if redact_value({'name': name, 'tasks': tasks}, secret_values(config)) != {'name': name, 'tasks': tasks}:
        _fail('Remove credentials from workflow names and tasks.', 'secret_detected')
    with store.registry.transaction():
        if expected_pins is not None:
            if (not isinstance(expected_pins, list) or len(expected_pins) != len(definition['pips'])
                    or any(type(expected) is not dict or set(expected) != {'pip_id', 'job_version', 'lifecycle_revision'}
                           or any(expected.get(key) != actual[key] for key in expected)
                           for expected, actual in zip(expected_pins, definition['pips']))):
                _fail('A Pip changed since Work inspected it. Read its definition again.', 'conflict')
        if unique_name:
            prior = store.db.execute("SELECT id FROM pip_flows WHERE workspace_id=? AND name=? AND status!='retired'",
                                     (workspace, name)).fetchall()
            for row in prior:
                flow = get(store, row['id'])
                if flow['mode'] == mode and flow['definition'] == definition:
                    return flow
            if prior:
                _fail('A different workflow with this name already exists. Read workflows and choose a new name.', 'conflict')
        if store.db.execute("SELECT count(*) FROM pip_flows WHERE workspace_id=? AND status!='retired'",
                            (workspace,)).fetchone()[0] >= MAX_FLOWS:
            _fail('This workspace already has twenty workflows.', 'flow_limit')
        # Re-pin in the write transaction: a job may have changed while the form was open.
        if any(_pin(store, pip_id, config) != pin for pip_id, pin in zip(pip_ids, definition['pips'])):
            _fail('A Pip changed while reviewing the workflow. Refresh and try again.', 'conflict')
        flow_id, now = identifier('flow'), _now(store)
        store.db.execute('INSERT INTO pip_flows VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                         (flow_id, workspace, name, mode, _encoded(definition).decode(), _digest(definition),
                          'on', 0, actor, now, now, now))
        store.registry.event(workspace, 'pip_flow_created', payload={'flow_id': flow_id, 'mode': mode})
    return get(store, flow_id)


def set_status(store, flow_id, expected_revision, status, actor, config):
    if actor not in LOCAL:
        _fail('Only you can pause or resume a workflow on this computer.', 'local_only')
    if type(expected_revision) is not int or expected_revision < 0 or status not in ('on', 'paused', 'retired'):
        _fail('Refresh the workflow before changing it.')
    row = _row(store, flow_id)
    if row['revision'] != expected_revision:
        _fail('Workflow changed. Refresh and try again.', 'conflict')
    if row['status'] == 'retired':
        _fail('This workflow was retired and cannot be resumed.', 'conflict')
    if status == row['status']:
        return get(store, flow_id)
    if status == 'on':
        if any(_pin(store, p['pip_id'], config) != p for p in row['definition']['pips']):
            _fail('A Pip changed. Create a new reviewed workflow before resuming.', 'stale_flow')
    with store.registry.transaction():
        now = _now(store)
        changed = store.db.execute('UPDATE pip_flows SET status=?,revision=revision+1,updated_at=?,enabled_at=? '
                                   'WHERE id=? AND revision=?', (status, now, now if status == 'on' else row['enabled_at'],
                                                                  flow_id, expected_revision)).rowcount
        if changed != 1:
            _fail('Workflow changed. Refresh and try again.', 'conflict')
        store.registry.event(row['workspace_id'], 'pip_flow_' + ('resumed' if status == 'on' else status),
                             payload={'flow_id': flow_id})
    return get(store, flow_id)


def _step(store, flow, stage, run_id, status, reason=None, handoff_id=None):
    with store.registry.transaction():
        prior = store.db.execute('SELECT id FROM pip_flow_steps WHERE flow_id=? AND stage=? AND source_run_id=?',
                                 (flow['id'], stage, run_id)).fetchone()
        if prior:
            return
        store.db.execute('INSERT INTO pip_flow_steps VALUES(?,?,?,?,?,?,?,?)',
                         (identifier('flowstep'), flow['id'], stage, run_id, handoff_id, status, reason, _now(store)))
        store.registry.event(flow['workspace_id'], 'pip_flow_step_' + status,
                             pip_id=flow['definition']['pips'][stage+1]['pip_id'], run_id=run_id,
                             payload={'flow_id': flow['id'], 'stage': stage, 'handoff_id': handoff_id})


def _pause_changed(store, flow, reason='scope_changed'):
    with store.registry.transaction():
        changed = store.db.execute("UPDATE pip_flows SET status='paused',revision=revision+1,updated_at=? "
                                   "WHERE id=? AND status='on' AND revision=?",
                                   (_now(store), flow['id'], flow['revision'])).rowcount
        if changed:
            store.registry.event(flow['workspace_id'], 'pip_flow_paused',
                                 payload={'flow_id': flow['id'], 'reason': reason})


def _advance(store, config, flow, stage, run):
    if flow['status'] != 'on' or run['status'] != 'succeeded' or run['workspace_id'] != flow['workspace_id']:
        return
    pips = flow['definition']['pips']
    kind = run['manifest'].get('run_kind')
    routine_reply = kind == 'conversation' and run.get('requested_by') == 'local-routine'
    if (stage >= len(pips)-1 or pips[stage]['pip_id'] != run['pip_id']
            or flow['definition']['kind'] == 'personal' and not (kind == 'personal_task' or stage == 0 and routine_reply)
            or flow['definition']['kind'] == 'project' and kind != 'audit'):
        return
    if store.db.execute('SELECT 1 FROM pip_flow_steps WHERE flow_id=? AND stage=? AND source_run_id=?',
                        (flow['id'], stage, run['id'])).fetchone():
        return
    if any(_pin(store, pin['pip_id'], config) != pin for pin in pips):
        _step(store, flow, stage, run['id'], 'paused', 'A Pip or its model, app reads or job changed.')
        _pause_changed(store, flow)
        return
    if stage == 0:
        # A rolling window prevents six starts in a few minutes across midnight.
        try:
            finished = datetime.fromisoformat(run['finished_at'].replace('Z', '+00:00'))
            if finished.tzinfo is None:
                raise ValueError('timezone missing')
        except (TypeError, AttributeError, ValueError) as exc:
            raise RegistryError('stored_data_limit', 'The completed run has no valid finish time.') from exc
        cutoff = (finished.astimezone(timezone.utc) - timedelta(days=1)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        count = store.db.execute('SELECT count(*) FROM pip_flow_steps s JOIN pip_runs r ON r.id=s.source_run_id '
                                 'WHERE s.flow_id=? AND s.stage=0 AND r.finished_at>? AND r.finished_at<=?',
                                 (flow['id'], cutoff, run['finished_at'])).fetchone()[0]
        if count >= flow['definition']['max_starts_per_day']:
            _step(store, flow, stage, run['id'], 'paused', 'Daily workflow run limit reached.')
            return
    from .pip_handoffs import accept, propose, propose_personal
    actor = 'pip-flow:' + flow['id']
    key = hashlib.sha256((flow['id'] + ':' + str(stage) + ':' + run['id']).encode()).hexdigest()
    if flow['definition']['kind'] == 'personal':
        text = run['result'].get('text') if isinstance(run.get('result'), dict) else None
        if (isinstance(run.get('result'), dict) and isinstance(run['result'].get('computer'), dict)
                and run['result']['computer'].get('held')):
            _step(store, flow, stage, run['id'], 'paused', 'A computer action is still waiting for your decision.')
            return
        if not isinstance(text, str) or not text or len(text.encode('utf-8')) > 12000:
            _step(store, flow, stage, run['id'], 'paused', 'The result cannot be shared as a bounded exact excerpt.')
            return
        handoff = propose_personal(store, run['id'], pips[stage+1]['pip_id'], text,
                                   flow['definition']['tasks'][stage], key, actor, config)
    else:
        from . import pip_checkpoints
        checkpoint = pip_checkpoints.for_run(store, run['id'])
        if checkpoint is None or not checkpoint['findings']:
            _step(store, flow, stage, run['id'], 'paused', 'No source-checked finding to hand on.')
            return
        handoff = propose(store, run['id'], 0, pips[stage+1]['pip_id'],
                          flow['definition']['tasks'][stage], {'kind': 'read_only'}, key, actor, config)
    if flow['mode'] == 'reviewed':
        _step(store, flow, stage, run['id'], 'review', handoff_id=handoff['id'])
        return
    # A paused workflow cannot dispatch just because a proposal already exists.
    if _row(store, flow['id'])['status'] != 'on':
        _step(store, flow, stage, run['id'], 'paused', 'Workflow paused before dispatch.', handoff['id'])
        return
    def still_on():
        row = store.db.execute('SELECT status,revision,definition_digest FROM pip_flows WHERE id=?',
                               (flow['id'],)).fetchone()
        if (row is None or row['status'] != 'on' or row['revision'] != flow['revision']
                or row['definition_digest'] != flow['definition_digest']):
            _fail('Workflow changed or paused before dispatch.', 'stale_flow')
    try:
        accepted = accept(store, handoff['id'], handoff['revision'], actor, config,
                          _origin_check=still_on)
    except RegistryError:
        _step(store, flow, stage, run['id'], 'paused',
              'The handoff stayed pending because its authority changed.', handoff['id'])
        return
    _step(store, flow, stage, run['id'], 'queued', handoff_id=accepted['handoff']['id'])


def after_run(store, config, run_id):
    """Offer the next edge after one completed task. Repeatable for crash recovery."""
    run = store.run(run_id)
    if run['status'] != 'succeeded' or not run.get('finished_at'):
        return
    rows = store.db.execute('SELECT id,definition FROM pip_flows WHERE workspace_id=? AND status=\'on\'',
                            (run['workspace_id'],)).fetchall()
    for candidate in rows:
        flow = _row(store, candidate['id'])
        if run['finished_at'] < flow['enabled_at']:
            continue
        first = flow['definition']['pips'][0]['pip_id']
        if run['pip_id'] == first:
            try:
                _advance(store, config, flow, 0, run)
            except RegistryError:
                _step(store, flow, 0, run['id'], 'paused', 'The handoff could not be prepared. Review the workflow.')
                _pause_changed(store, flow)
        # A later Pip's run must be the accepted output of this flow's previous edge.
        for row in store.db.execute('SELECT s.stage FROM pip_flow_steps s JOIN pip_handoffs h ON h.id=s.handoff_id '
                                    'WHERE s.flow_id=? AND h.run_id=? AND h.status=\'accepted\'',
                                    (flow['id'], run_id)).fetchall():
            try:
                _advance(store, config, flow, row['stage'] + 1, run)
            except RegistryError:
                _step(store, flow, row['stage'] + 1, run['id'], 'paused',
                      'The next handoff could not be prepared. Review the workflow.')
                _pause_changed(store, flow)


def recover(store, config):
    """Replay recent successful source receipts after a controller restart.

    This cannot create an old handoff on first installation: flow.enabled_at is
    the lower bound, and an unchanged run/edge has a unique receipt and key.
    """
    flows = [get(store, row['id']) for row in store.db.execute(
        "SELECT id FROM pip_flows WHERE status='on' ORDER BY created_at,id").fetchall()]
    for flow in flows:
        first = flow['definition']['pips'][0]['pip_id']
        # Only unprocessed starts and accepted intermediate handoff runs are
        # eligible. Ordinary chats and already recorded steps cannot crowd out
        # a genuinely missed run after a long-lived workflow restarts.
        personal_filter = ("AND (json_extract(r.manifest,'$.run_kind')='personal_task' OR "
                           "(json_extract(r.manifest,'$.run_kind')='conversation' AND r.requested_by='local-routine')) ") \
            if flow['definition']['kind']=='personal' else "AND json_extract(r.manifest,'$.run_kind')='audit' "
        starts = store.db.execute(
            "SELECT r.id,r.finished_at FROM pip_runs r WHERE r.pip_id=? AND r.workspace_id=? "
            "AND r.status='succeeded' AND r.finished_at>=? " + personal_filter +
            "AND NOT EXISTS(SELECT 1 FROM pip_flow_steps s WHERE s.flow_id=? AND s.stage=0 AND s.source_run_id=r.id) "
            "ORDER BY r.finished_at,r.id LIMIT 2001",
            (first, flow['workspace_id'], flow['enabled_at'], flow['id'])).fetchall()
        next_runs = store.db.execute(
            "SELECT r.id,r.finished_at FROM pip_runs r JOIN pip_handoffs h ON h.run_id=r.id "
            "JOIN pip_flow_steps s ON s.handoff_id=h.id WHERE s.flow_id=? AND s.stage<? "
            "AND h.status='accepted' AND r.status='succeeded' AND r.finished_at>=? "
            "AND NOT EXISTS(SELECT 1 FROM pip_flow_steps done WHERE done.flow_id=s.flow_id "
            "AND done.stage=s.stage+1 AND done.source_run_id=r.id) "
            "ORDER BY r.finished_at,r.id LIMIT 2001",
            (flow['id'], len(flow['definition']['pips'])-2, flow['enabled_at'])).fetchall()
        if len(starts)>2000 or len(next_runs)>2000:
            # Fail closed instead of silently losing the oldest missed step.
            _pause_changed(store, flow, 'recovery_limit')
            continue
        for row in sorted([*starts,*next_runs], key=lambda r:(r['finished_at'],r['id'])):
            after_run(store, config, row['id'])
