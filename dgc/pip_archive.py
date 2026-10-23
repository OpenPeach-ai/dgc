"""Human-only, reversible Pip archival with retained evidence and exact receipts."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone

from .workspace_registry import RegistryError, identifier

MAX_REVISION = 2**53 - 1
MAX_RECEIPTS = 10000
SCHEMA = """
CREATE TABLE pip_lifecycle_state(
 pip_id TEXT PRIMARY KEY REFERENCES pips(id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991));
INSERT INTO pip_lifecycle_state SELECT id,0 FROM pips;
CREATE TRIGGER pip_lifecycle_created AFTER INSERT ON pips
 BEGIN INSERT INTO pip_lifecycle_state VALUES(NEW.id,0); END;
CREATE TRIGGER pip_lifecycle_changed AFTER UPDATE OF status ON pips WHEN OLD.status!=NEW.status
 BEGIN
 UPDATE pip_lifecycle_state SET revision=revision+1 WHERE pip_id=NEW.id;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'missing lifecycle revision') END;
 END;
CREATE TABLE pip_archive_requests(
 id TEXT PRIMARY KEY,pip_id TEXT NOT NULL REFERENCES pips(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),actor TEXT NOT NULL,
 request_key TEXT NOT NULL,request_digest TEXT NOT NULL,
 receipt TEXT NOT NULL CHECK(length(CAST(receipt AS BLOB))<=8192),
 UNIQUE(actor,request_key));
CREATE TRIGGER immutable_pip_archive_request BEFORE UPDATE ON pip_archive_requests
 BEGIN SELECT RAISE(ABORT,'immutable Pip archival receipt'); END;
CREATE TRIGGER retain_pip_archive_request BEFORE DELETE ON pip_archive_requests
 BEGIN SELECT RAISE(ABORT,'Pip archival history is retained'); END;
"""
_FIELDS = {'id','operation','pip_id','workspace_id','job_version','lifecycle_revision_before',
           'lifecycle_revision_after','status_before','status_after','reason','actor','created_at'}


def _integer(value, label, low=0, high=MAX_REVISION):
    if type(value) is not int or not low <= value <= high:
        raise RegistryError('invalid_request', f'{label} must be an integer between {low} and {high}.')
    return value


def _text(value, label, maximum, *, multiline=False):
    from .pip_checkpoints import _text as checked_text
    return checked_text(value, label, maximum, multiline=multiline)


def _id(value, prefix):
    if not isinstance(value,str) or not re.fullmatch(prefix+r'_[0-9a-f]{32}',value):
        raise RegistryError('invalid_request', 'Use an exact Pip archival identity.')
    return value


def _json(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def _now(registry):
    value=_text(registry.clock(),'Archival timestamp',40)
    try:
        stamp=datetime.fromisoformat(value.replace('Z','+00:00'))
        if stamp.tzinfo is None:raise ValueError()
        return stamp.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
    except (ValueError,OverflowError) as exc:
        raise RegistryError('invalid_request','Archival requires a timezone-aware timestamp.') from exc


def revision(registry, pip_id):
    row=registry.db.execute('SELECT revision FROM pip_lifecycle_state WHERE pip_id=?',(pip_id,)).fetchone()
    if row is None:
        raise RegistryError('invalid_lifecycle','Pip lifecycle revision is missing. Inspect the local registry.')
    return _integer(row[0],'Lifecycle revision')


def require_live(store, pip_id):
    """Early and write-transaction guard; does not decode job or historical data."""
    row=store.db.execute('SELECT status FROM pips WHERE id=?',(pip_id,)).fetchone()
    if row is None:raise RegistryError('not_found','Pip not found on this runner.')
    if row[0]=='archived':
        raise RegistryError('archived','This Pip is archived. Restore it to paused before changing it or starting new work.')
    if row[0] not in ('active','paused'):
        raise RegistryError('invalid_lifecycle','The Pip has an unsupported lifecycle status.')


def _current(store,pip_id):
    _id(pip_id,'pip')
    from .pip_overview import _bounded
    rows=_bounded(store.db,'''SELECT p.id,p.workspace_id,p.current_version,p.status FROM pips p
        JOIN bindings b ON b.workspace_id=p.workspace_id WHERE p.id=? AND b.runner_id=?''',
        (pip_id,store.registry.runner_id),{'id':64,'workspace_id':64,'current_version':None,'status':16})
    if len(rows)!=1:raise RegistryError('not_found','Pip not found on this runner.')
    row=rows[0]; _id(row['workspace_id'],'ws'); _integer(row['current_version'],'Job version',1,999999)
    if row['status'] not in ('active','paused','archived'):
        raise RegistryError('invalid_lifecycle','The Pip has an unsupported lifecycle status.')
    return {**row,'lifecycle_revision':revision(store.registry,pip_id)}


def _saved(store,request,digest):
    from .pip_overview import _bounded
    rows=_bounded(store.db,'SELECT * FROM pip_archive_requests WHERE actor=? AND request_key=?',
        (request['actor'],request['request_key']),{'id':64,'pip_id':64,'workspace_id':64,'actor':128,
        'request_key':128,'request_digest':64,'receipt':8192})
    if not rows:return None
    row=rows[0]
    if row['request_digest']!=digest or row['pip_id']!=request['pip_id']:
        raise RegistryError('conflict','This archival retry key was already used for different work.')
    try:
        saved=json.loads(row['receipt'])
    except (ValueError,TypeError,RecursionError) as exc:
        raise RegistryError('invalid_receipt','The saved archival receipt is malformed.') from exc
    if not isinstance(saved,dict) or set(saved)!=_FIELDS:
        raise RegistryError('invalid_receipt','The saved archival receipt has unsupported fields.')
    _id(saved['id'],'archive'); _id(saved['workspace_id'],'ws')
    for key in ('id','pip_id','workspace_id','actor'):
        if saved[key]!=row[key]:raise RegistryError('invalid_receipt','The archival receipt identity differs from its ledger.')
    for key,expected in {'operation':request['operation'],'job_version':request['expected_version'],
            'lifecycle_revision_before':request['expected_lifecycle_revision'],'reason':request['reason']}.items():
        if saved[key]!=expected:raise RegistryError('invalid_receipt','The archival receipt differs from its exact request.')
    _integer(saved['job_version'],'Saved job version',1,999999)
    before=_integer(saved['lifecycle_revision_before'],'Saved lifecycle revision',0,MAX_REVISION-1)
    if type(saved['lifecycle_revision_after']) is not int or saved['lifecycle_revision_after']!=before+1:
        raise RegistryError('invalid_receipt','The archival receipt did not advance one lifecycle revision.')
    expected_before=('active','paused') if saved['operation']=='archive' else ('archived',)
    expected_after='archived' if saved['operation']=='archive' else 'paused'
    if saved['status_before'] not in expected_before or saved['status_after']!=expected_after:
        raise RegistryError('invalid_receipt','The archival receipt contradicts its operation.')
    _text(saved['created_at'],'Saved archival time',40)
    try:
        if datetime.fromisoformat(saved['created_at'].replace('Z','+00:00')).tzinfo is None:raise ValueError()
    except ValueError as exc:raise RegistryError('invalid_receipt','The archival timestamp is invalid.') from exc
    return saved


def _require_idle(store,pip_id,now):
    if store.db.execute("SELECT 1 FROM pip_runs WHERE pip_id=? AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1",(pip_id,)).fetchone():
        raise RegistryError('pip_busy','Finish or explicitly cancel queued, running or waiting work before archiving this Pip.')
    if store.db.execute('''SELECT 1 FROM pip_proposals q LEFT JOIN pip_approvals a ON a.proposal_id=q.id AND a.pip_id=q.pip_id
            WHERE q.pip_id=? AND q.status='proposed' AND (a.id IS NULL OR (a.status='pending' AND a.expires_at>?)) LIMIT 1''',
            (pip_id,now)).fetchone() or store.db.execute("SELECT 1 FROM pip_approvals WHERE pip_id=? AND status='pending' AND expires_at>? LIMIT 1",(pip_id,now)).fetchone():
        raise RegistryError('pending_review','Resolve pending job or schedule proposals before archiving this Pip.')
    if store.db.execute("SELECT 1 FROM pip_handoffs WHERE (source_pip_id=? OR target_pip_id=?) AND status='pending' AND expires_at>? LIMIT 1",
            (pip_id,pip_id,now)).fetchone():
        raise RegistryError('pending_review','Resolve incoming and outgoing handoff proposals before archiving this Pip.')
    # A review DGC opened for your own app (pip_sdk_app_approvals) waits as its draft does, which never held archiving.
    if store.db.execute("SELECT 1 FROM pip_app_actions WHERE pip_id=? AND status='pending' AND expires_at>? AND requested_by<>'pip-app-review' LIMIT 1",(pip_id,now)).fetchone():
        raise RegistryError('pending_review','Resolve pending message reviews before archiving this Pip.')


def _discard_schedule_backlog(store,pip_id,now):
    """Consume due occurrences without executing or moving the approved anchor."""
    from .pip_overview import _bounded
    from .pip_schedules import plan_due
    rows=_bounded(store.db,'SELECT * FROM pip_schedule_state WHERE pip_id=?',(pip_id,),
        {'pip_id':64,'job_version':None,'anchor_at':40,'next_due_at':40,'last_due_at':40,'last_checked_at':40})
    if not rows:return
    state=rows[0]; job=store._job(pip_id)
    if state['job_version']!=job['current_version'] or job.get('schedule') is None:
        raise RegistryError('invalid_schedule','The archived schedule cursor does not match its approved job.')
    plan=plan_due(job['schedule'],state['next_due_at'],now,state['anchor_at'])
    if plan is None:return
    store.db.execute('UPDATE pip_schedule_state SET next_due_at=?,last_due_at=?,last_checked_at=? WHERE pip_id=?',
        (plan['next_due_at'],plan['scheduled_at'],plan['checked_at'],pip_id))
    store.registry.event(job['workspace_id'],'pip_schedule_skipped',pip_id=pip_id,
        payload={'job_version':job['current_version'],'scheduled_at':plan['scheduled_at'],
                 'next_due_at':plan['next_due_at'],'reason':'job_archived','coalesced':plan['coalesced']})


def transition(store,pip_id,*,archived,expected_version,expected_lifecycle_revision,request_key,reason,actor):
    """Authenticated human control only. Never exposed as a native model tool."""
    _id(pip_id,'pip')
    if type(archived) is not bool:raise RegistryError('invalid_request','Choose archive or restore explicitly.')
    _integer(expected_version,'Expected job version',1,999999)
    _integer(expected_lifecycle_revision,'Expected lifecycle revision',0,MAX_REVISION-1)
    if not isinstance(request_key,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',request_key):
        raise RegistryError('invalid_request','Archival retry keys use 1–128 letters, digits, underscores or hyphens.')
    reason=_text(reason,'Archival reason',1000,multiline=True); actor=_text(actor,'Archival actor',128)
    request={'operation':'archive' if archived else 'restore','pip_id':pip_id,'expected_version':expected_version,
             'expected_lifecycle_revision':expected_lifecycle_revision,'request_key':request_key,'reason':reason,'actor':actor}
    digest=hashlib.sha256(_json(request).encode()).hexdigest()
    with store.registry.transaction():
        current=_current(store,pip_id)
        saved=_saved(store,request,digest)
        replayed=saved is not None
        if saved is not None:
            if saved['workspace_id']!=current['workspace_id'] or saved['lifecycle_revision_after']>current['lifecycle_revision']:
                raise RegistryError('invalid_receipt','The historical archival receipt does not belong to the current lifecycle.')
        else:
            if (current['current_version'],current['lifecycle_revision'])!=(expected_version,expected_lifecycle_revision):
                raise RegistryError('conflict','The Pip job or lifecycle changed. Refresh before archiving or restoring it.')
            if archived and current['status']=='archived' or not archived and current['status']!='archived':
                raise RegistryError('no_change','This Pip is already archived.' if archived else 'Only an archived Pip can be restored.')
            if store.db.execute('SELECT count(*) FROM pip_archive_requests').fetchone()[0]>=MAX_RECEIPTS:
                raise RegistryError('limit','The archival receipt archive is full; no lifecycle change was made.')
            now=_now(store.registry)
            # Restore is also fail-closed if corrupt or older code inserted work
            # while archived. No hidden backlog or unresolved review is revived.
            _require_idle(store,pip_id,now)
            status='archived' if archived else 'paused'
            changed=store.db.execute('UPDATE pips SET status=?,updated_at=? WHERE id=? AND current_version=? AND status=?',
                (status,now,pip_id,expected_version,current['status'])).rowcount
            if changed!=1:raise RegistryError('conflict','The Pip changed before its lifecycle could be recorded.')
            after=revision(store.registry,pip_id)
            if after!=expected_lifecycle_revision+1:raise RegistryError('conflict','The lifecycle revision changed unexpectedly.')
            from .pip_event_triggers import discard_status_backlog
            discard_status_backlog(store.registry,pip_id,current['workspace_id'])
            _discard_schedule_backlog(store,pip_id,now)
            saved={'id':identifier('archive'),'operation':request['operation'],'pip_id':pip_id,
                   'workspace_id':current['workspace_id'],'job_version':expected_version,
                   'lifecycle_revision_before':expected_lifecycle_revision,'lifecycle_revision_after':after,
                   'status_before':current['status'],'status_after':status,'reason':reason,'actor':actor,'created_at':now}
            store.db.execute('INSERT INTO pip_archive_requests VALUES(?,?,?,?,?,?,?)',
                (saved['id'],pip_id,current['workspace_id'],actor,request_key,digest,_json(saved)))
            store.registry.event(current['workspace_id'],'pip_archived' if archived else 'pip_restored',pip_id=pip_id,
                payload={'receipt_id':saved['id'],'actor':actor,'status':status,'lifecycle_revision':after})
        return {'pip':store.get(pip_id),'receipt':saved,'replayed':replayed}
