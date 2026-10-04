"""Local metadata-only notification cache; read marks never decide source work.

The durable event cursor advances through at most 100 events per materialization.
Notifications may be pruned, but old events are never replayed to recreate them.
No transcript, error body, model text or external delivery belongs in this module.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import re
from datetime import datetime, timezone

from .pip_overview import _bounded, _integer, _now, _scope, _text
from .workspace_registry import RegistryError

RETENTION_LIMIT = 500
SYNC_LIMIT = 100
MAX_CURSOR = 2**53 - 1
SQL_CURSOR = 2**63 - 1
SEEN_LIMIT = 20000
SCHEMA = """
CREATE TABLE pip_notification_state(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    after_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(after_event_seq>=0),
    evicted_total INTEGER NOT NULL DEFAULT 0 CHECK(evicted_total>=0),
    unavailable_sources_total INTEGER NOT NULL DEFAULT 0 CHECK(unavailable_sources_total>=0),
    history_may_be_incomplete INTEGER NOT NULL DEFAULT 0 CHECK(history_may_be_incomplete IN (0,1)));
INSERT INTO pip_notification_state(singleton) VALUES(1);
CREATE TABLE pip_notification_seen(source_kind TEXT NOT NULL,source_id TEXT NOT NULL,
    PRIMARY KEY(source_kind,source_id));
CREATE TRIGGER retained_notification_identity BEFORE DELETE ON pip_notification_seen
    BEGIN SELECT RAISE(ABORT,'retained notification identity'); END;
CREATE TRIGGER immutable_notification_identity BEFORE UPDATE ON pip_notification_seen
    BEGIN SELECT RAISE(ABORT,'immutable notification identity'); END;
CREATE TABLE pip_notifications(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id), pip_id TEXT REFERENCES pips(id),
    source_kind TEXT NOT NULL, source_id TEXT NOT NULL, reference TEXT NOT NULL,
    occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
    read_at TEXT, read_by TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision IN (0,1)),
    UNIQUE(source_kind,source_id),
    CHECK((revision=0 AND read_at IS NULL AND read_by IS NULL) OR
          (revision=1 AND read_at IS NOT NULL AND read_by IS NOT NULL)));
CREATE INDEX pip_notification_page ON pip_notifications(workspace_id,seq);
CREATE TRIGGER immutable_pip_notification
    BEFORE UPDATE OF seq,id,workspace_id,pip_id,source_kind,source_id,reference,occurred_at,created_at
    ON pip_notifications BEGIN SELECT RAISE(ABORT,'immutable notification reference'); END;
CREATE TRIGGER one_way_pip_notification_read
    BEFORE UPDATE OF read_at,read_by,revision ON pip_notifications
    WHEN OLD.revision!=0 OR NEW.revision!=1 OR NEW.read_at IS NULL OR NEW.read_by IS NULL
    BEGIN SELECT RAISE(ABORT,'notification can be marked read once'); END;
"""

_EVENTS = {'pip_job_update_proposed', 'pip_handoff_proposed',
           'workspace_session_outcome_proposed', 'pip_run_failed'}
_TITLES = {'job_update':'Pip job update needs review', 'schedule_update':'Pip schedule update needs review',
           'handoff':'Pip handoff needs review', 'session_outcome':'Session statement needs review',
           'run':'Pip run failed'}
_FIELDS = {'seq':None, 'id':64, 'workspace_id':64, 'pip_id':64, 'source_kind':32,
           'source_id':64, 'reference':1024, 'occurred_at':40, 'created_at':40,
           'read_at':40, 'read_by':128, 'revision':None}


def _error(message, code='invalid_notification'):
    return RegistryError(code, message)


def _id(value, prefix):
    if not isinstance(value, str) or not re.fullmatch(prefix + r'_[0-9a-f]{32}', value):
        raise _error('Notification references require valid local record identities.')
    return value


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def _object(raw, maximum):
    if not isinstance(raw, str) or len(raw) > maximum:
        raise _error('Notification source metadata is missing or oversized.')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate metadata key')
            result[key] = value
        return result
    try:
        if len(raw.encode()) > maximum:
            raise ValueError('metadata byte budget')
        value = json.loads(raw, object_pairs_hook=unique,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite metadata')))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise _error('Notification source metadata is malformed.') from exc
    if not isinstance(value, dict):
        raise _error('Notification source metadata must be an object.')
    pending = [(value, 0)]
    count = 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if depth > 16 or count > 2048:
            raise _error('Notification source metadata exceeds its structure budget.')
        if isinstance(item, dict):
            pending.extend((v, depth + 1) for pair in item.items() for v in pair)
        elif isinstance(item, list):
            pending.extend((v, depth + 1) for v in item)
        elif isinstance(item, str):
            try:
                item.encode('utf-8')
            except UnicodeError as exc:
                raise _error('Notification source metadata contains invalid Unicode.') from exc
    return value


def _identity(kind, source_id):
    _text(source_id,'Notification source identity',64)
    return 'notification_' + hashlib.sha256((kind + '\0' + source_id).encode()).hexdigest()[:32]


def _timestamp(value):
    _text(value,'Notification time',40)
    try:
        parsed = datetime.fromisoformat(value.replace('Z','+00:00'))
        if parsed.tzinfo is None:
            raise ValueError('No timezone')
        return parsed.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
    except (ValueError, OverflowError) as exc:
        raise _error('Notification source time is invalid.') from exc


def _source(registry, kind, source_id, workspace_id, now):
    """Read only fixed metadata, with workspace predicates before any projection."""
    db = registry.db
    if kind in ('job_update', 'schedule_update', 'approval'):
        _id(source_id, 'approval')
        rows = _bounded(db, '''SELECT a.id,a.pip_id,a.proposal_id,a.action_type,a.status,a.created_at,a.expires_at,
                q.status AS proposal_status FROM pip_approvals a
                JOIN pip_proposals q ON q.id=a.proposal_id AND q.pip_id=a.pip_id
                JOIN pips p ON p.id=a.pip_id AND p.workspace_id=a.workspace_id
                WHERE a.id=? AND a.workspace_id=?''', (source_id, workspace_id),
            {'id':64,'pip_id':64,'proposal_id':64,'action_type':32,'status':16,'proposal_status':16,'created_at':40,'expires_at':40})
        if not rows:
            return None
        row = rows[0]
        if row['action_type'] not in ('job_update','schedule_update') or kind != 'approval' and row['action_type'] != kind:
            raise _error('Notification approval type changed.')
        _id(row['pip_id'],'pip'); _id(row['proposal_id'],'proposal')
        if row['status'] not in ('pending','approved','rejected','expired','superseded'):
            raise _error('Notification approval state is invalid.')
        status = 'expired' if row['status'] == 'pending' and _timestamp(row['expires_at']) <= now else row['status']
        if status == 'pending' and row['proposal_status'] != 'proposed':
            raise _error('Notification approval does not match its proposal.')
        return {'source_kind':row['action_type'], 'pip_id':row['pip_id'], 'status':status,
                'occurred_at':row['created_at'], 'reference':{'approval_id':source_id,'proposal_id':row['proposal_id'],'pip_id':row['pip_id']}}
    if kind == 'handoff':
        _id(source_id, 'handoff')
        rows = _bounded(db, '''SELECT h.id,h.target_pip_id,h.status,h.created_at,h.expires_at FROM pip_handoffs h
            JOIN pips p ON p.id=h.target_pip_id AND p.workspace_id=h.workspace_id WHERE h.id=? AND h.workspace_id=?''',
            (source_id, workspace_id), {'id':64,'target_pip_id':64,'status':16,'created_at':40,'expires_at':40})
        if not rows:
            return None
        row = rows[0]; _id(row['target_pip_id'],'pip')
        if row['status'] not in ('pending','accepted','rejected','expired'):
            raise _error('Notification handoff state is invalid.')
        status = 'expired' if row['status']=='pending' and _timestamp(row['expires_at'])<=now else row['status']
        return {'source_kind':kind,'pip_id':row['target_pip_id'],'status':status,'occurred_at':row['created_at'],
                'reference':{'handoff_id':source_id,'target_pip_id':row['target_pip_id']}}
    if kind == 'session_outcome':
        _id(source_id, 'outcome')
        rows = _bounded(db, 'SELECT id,status,payload FROM workspace_session_outcomes WHERE id=? AND workspace_id=?',
            (source_id,workspace_id), {'id':64,'status':16,'payload':8192})
        if not rows:
            return None
        row = rows[0]
        if row['status'] not in ('pending','accepted','rejected'):
            raise _error('Notification statement state is invalid.')
        # The table has no scalar creation time. Read this bounded envelope only
        # to obtain identity/time, never copy its statement into the cache.
        payload = _object(row['payload'],8192)
        if payload.get('id') != source_id or payload.get('workspace_id') != workspace_id:
            raise _error('Notification statement source does not match its workspace.')
        return {'source_kind':kind,'pip_id':None,'status':row['status'],'occurred_at':payload.get('created_at'),
                'reference':{'proposal_id':source_id}}
    if kind == 'run':
        _id(source_id, 'run')
        rows = _bounded(db, '''SELECT r.id,r.pip_id,r.status,r.finished_at FROM pip_runs r
            JOIN pips p ON p.id=r.pip_id AND p.workspace_id=r.workspace_id WHERE r.id=? AND r.workspace_id=?''',
            (source_id,workspace_id), {'id':64,'pip_id':64,'status':16,'finished_at':40})
        if not rows:
            return None
        row = rows[0]; _id(row['pip_id'],'pip')
        if row['status'] not in ('queued','running','cancelling','succeeded','failed','cancelled'):
            raise _error('Notification run state is invalid.')
        return {'source_kind':kind,'pip_id':row['pip_id'],'status':row['status'],'occurred_at':row['finished_at'],
                'reference':{'run_id':source_id,'pip_id':row['pip_id']}}
    raise _error('Unsupported notification source type.')


def _state(registry):
    row = registry.db.execute('SELECT after_event_seq,evicted_total,unavailable_sources_total,history_may_be_incomplete '
                              'FROM pip_notification_state WHERE singleton=1').fetchone()
    if row is None:
        raise _error('Notification storage is not initialized.')
    result = dict(row)
    for key in ('after_event_seq','evicted_total','unavailable_sources_total'):
        _integer(result[key],key,0,SQL_CURSOR if key=='after_event_seq' else MAX_CURSOR)
    if type(result['history_may_be_incomplete']) is not int or result['history_may_be_incomplete'] not in (0,1):
        raise _error('Notification retention state is invalid.')
    return result


def sync(registry, *, limit=SYNC_LIMIT):
    """Materialize at most 100 scanned events, with no source-state mutation."""
    _integer(limit,'Notification scan limit',1,SYNC_LIMIT)
    if registry.db.in_transaction:
        raise _error('Notification synchronization requires its own short transaction.')
    with registry.transaction():
        state = _state(registry); cursor = state['after_event_seq']; now = _now(registry)
        seen_count = registry.db.execute('SELECT count(*) FROM pip_notification_seen').fetchone()[0]
        _integer(seen_count,'Notification identity archive size',0,SEEN_LIMIT)
        # Never read payloads of unrelated transcript/progress/context events.
        rows = registry.db.execute('''SELECT seq,
            CASE WHEN typeof(workspace_id)='text' AND length(CAST(workspace_id AS BLOB))<=64 THEN workspace_id ELSE NULL END AS workspace_id,
            CASE WHEN typeof(event_type)='text' AND length(CAST(event_type AS BLOB))<=64 THEN event_type ELSE NULL END AS event_type,
            CASE WHEN typeof(pip_id)='text' AND length(CAST(pip_id AS BLOB))<=64 THEN pip_id ELSE NULL END AS pip_id,
            CASE WHEN typeof(run_id)='text' AND length(CAST(run_id AS BLOB))<=64 THEN run_id ELSE NULL END AS run_id,
            CASE WHEN event_type IN ('pip_job_update_proposed','pip_handoff_proposed','workspace_session_outcome_proposed')
                AND typeof(payload)='text' AND length(CAST(payload AS BLOB))<=8192 THEN payload ELSE NULL END AS payload
            FROM workspace_events WHERE seq>? ORDER BY seq LIMIT ?''', (cursor,limit)).fetchall()
        unavailable = 0
        for event in rows:
            if event['seq'] != cursor + 1:
                state['history_may_be_incomplete'] = 1
            cursor = event['seq']
            if event['event_type'] not in _EVENTS:
                if event['event_type'] is None:
                    unavailable += 1
                continue
            try:
                workspace_id = _id(event['workspace_id'],'ws')
                _scope(registry.db, workspace_id, registry.runner_id)
                if event['event_type'] == 'pip_run_failed':
                    kind, source_id = 'run', _id(event['run_id'],'run')
                else:
                    value = _object(event['payload'],8192)
                    kind, field = {'pip_job_update_proposed':('approval','approval_id'),
                                   'pip_handoff_proposed':('handoff','handoff_id'),
                                   'workspace_session_outcome_proposed':('session_outcome','proposal_id')}[event['event_type']]
                    source_id = value.get(field)
                source = _source(registry,kind,source_id,workspace_id,now)
                if source is None or source['pip_id'] != event['pip_id']:
                    raise _error('Notification event does not match its authoritative source.')
                if kind == 'approval' and value.get('proposal_id') != source['reference']['proposal_id']:
                    raise _error('Notification event names a different proposal.')
                if source['status'] != ('failed' if kind=='run' else 'pending'):
                    continue  # Already resolved before notification observation.
                occurred_at = _timestamp(source['occurred_at'])
                actual_kind = source['source_kind']
                if registry.db.execute('SELECT 1 FROM pip_notification_seen WHERE source_kind=? AND source_id=?',
                                       (actual_kind,source_id)).fetchone():
                    continue
                if seen_count >= SEEN_LIMIT:
                    unavailable += 1
                    continue
                registry.db.execute('''INSERT OR IGNORE INTO pip_notifications
                    (id,workspace_id,pip_id,source_kind,source_id,reference,occurred_at,created_at)
                    VALUES(?,?,?,?,?,?,?,?)''', (_identity(actual_kind,source_id), workspace_id,source['pip_id'],actual_kind,
                        source_id,_json(source['reference']),occurred_at,now))
                registry.db.execute('INSERT INTO pip_notification_seen VALUES(?,?)',(actual_kind,source_id))
                seen_count += 1
            except RegistryError:
                unavailable += 1  # Skip poisoned metadata, retain its event in ordinary history.
        boundary = registry.db.execute('SELECT seq FROM pip_notifications ORDER BY seq DESC LIMIT 1 OFFSET ?',
                                       (RETENTION_LIMIT,)).fetchone()
        evicted = registry.db.execute('DELETE FROM pip_notifications WHERE seq<=?',(boundary[0],)).rowcount if boundary else 0
        evicted_total = state['evicted_total'] + evicted
        unavailable_total = state['unavailable_sources_total'] + unavailable
        _integer(evicted_total,'Notification eviction count',0,MAX_CURSOR)
        _integer(unavailable_total,'Unavailable notification source count',0,MAX_CURSOR)
        registry.db.execute('UPDATE pip_notification_state SET after_event_seq=?,evicted_total=?,unavailable_sources_total=?,history_may_be_incomplete=? WHERE singleton=1',
            (cursor,evicted_total,unavailable_total,state['history_may_be_incomplete']))
        pending = registry.db.execute('SELECT 1 FROM workspace_events WHERE seq>? LIMIT 1',(cursor,)).fetchone() is not None
        return {'sync_scanned':len(rows),'sync_pending':pending}


def _reference(kind, source_id, pip_id, value):
    fields = {'job_update':{'approval_id','proposal_id','pip_id'},'schedule_update':{'approval_id','proposal_id','pip_id'},
              'handoff':{'handoff_id','target_pip_id'},'session_outcome':{'proposal_id'},'run':{'run_id','pip_id'}}
    if kind not in fields or set(value) != fields[kind]:
        raise _error('Notification link has unsupported fields.')
    for key, item in value.items():
        _id(item, {'approval_id':'approval','proposal_id':'outcome' if kind=='session_outcome' else 'proposal',
                   'pip_id':'pip','target_pip_id':'pip','handoff_id':'handoff','run_id':'run'}[key])
    key = 'approval_id' if kind in ('job_update','schedule_update') else 'handoff_id' if kind=='handoff' else 'proposal_id' if kind=='session_outcome' else 'run_id'
    if value[key] != source_id or (value.get('pip_id',value.get('target_pip_id')) != pip_id):
        raise _error('Notification link does not match its source.')
    return value


def _entry(registry, row, now):
    _integer(row['seq'],'Notification sequence',1,MAX_CURSOR)
    _id(row['id'],'notification'); _id(row['workspace_id'],'ws')
    if row['pip_id'] is not None:
        _id(row['pip_id'],'pip')
    if row['source_kind'] not in _TITLES or row['id'] != _identity(row['source_kind'],row['source_id']):
        raise _error('Notification identity does not match its source.')
    reference = _reference(row['source_kind'],row['source_id'],row['pip_id'],_object(row['reference'],1024))
    _timestamp(row['occurred_at']); _timestamp(row['created_at'])
    _integer(row['revision'],'Notification revision',0,1)
    if row['revision'] == 0:
        if row['read_at'] is not None or row['read_by'] is not None:
            raise _error('Unread notification has an invalid read receipt.')
    else:
        _timestamp(row['read_at']); _text(row['read_by'],'Reader identity',128)
    status = 'unavailable'
    try:
        current = _source(registry,row['source_kind'],row['source_id'],row['workspace_id'],now)
        if current is not None and current['reference'] == reference and current['pip_id'] == row['pip_id']:
            status = current['status']
    except RegistryError:
        pass  # Link remains historical; it cannot claim an actionable source.
    return {key:row[key] for key in ('id','seq','workspace_id','pip_id','occurred_at','created_at','read_at','read_by','revision')} | {
        'kind':'run_failed' if row['source_kind']=='run' else 'needs_review','source_kind':row['source_kind'],
        'reference':reference,'title':_TITLES[row['source_kind']], 'source_status':status,
        'actionable':status == ('failed' if row['source_kind']=='run' else 'pending')}


@contextlib.contextmanager
def _read(registry):
    if registry.db.in_transaction:
        yield
    else:
        registry.db.execute('BEGIN')
        try:
            yield
        finally:
            registry.db.rollback()


def list_notifications(registry, workspace_id=None, before_seq=None, limit=20):
    _integer(limit,'Notification page limit',1,20)
    if before_seq is not None:
        _integer(before_seq,'Notification cursor',1,MAX_CURSOR)
    _scope(registry.db,workspace_id,registry.runner_id)
    synchronized = sync(registry)
    with _read(registry):
        _scope(registry.db,workspace_id,registry.runner_id)
        state = _state(registry); now = _now(registry)
        scope = 'workspace_id IN (SELECT workspace_id FROM bindings WHERE runner_id=?)'
        params = [registry.runner_id]
        if workspace_id is not None:
            scope += ' AND workspace_id=?'; params.append(workspace_id)
        counts = registry.db.execute('SELECT count(*),coalesce(sum(revision=0),0),min(seq) FROM pip_notifications WHERE '+scope,params).fetchone()
        rows = _bounded(registry.db,'SELECT * FROM pip_notifications WHERE '+scope+' AND seq<? ORDER BY seq DESC LIMIT ?',
                        (*params,before_seq or MAX_CURSOR+1,limit+1),_FIELDS)
        more = len(rows)>limit; entries=[_entry(registry,row,now) for row in rows[:limit]]
        return {'runner_id':registry.runner_id,'workspace_id':workspace_id,'notifications':entries,
                'unread_count':counts[1],'retained_count':counts[0],'oldest_seq':counts[2],
                'next_before_seq':entries[-1]['seq'] if more else None,'has_more':more,
                'retention_limit':RETENTION_LIMIT,'evicted_total':state['evicted_total'],
                'unavailable_sources_total':state['unavailable_sources_total'],
                'history_may_be_incomplete':bool(state['history_may_be_incomplete'] or state['evicted_total'] or state['unavailable_sources_total']),
                **synchronized}


def mark_read(registry, notification_id, expected_revision, actor, workspace_id=None):
    _id(notification_id,'notification'); _integer(expected_revision,'Expected notification revision',0,1)
    _text(actor,'Notification reader',128)
    _scope(registry.db,workspace_id,registry.runner_id)
    with registry.transaction():
        _scope(registry.db,workspace_id,registry.runner_id)
        query = 'SELECT * FROM pip_notifications WHERE id=? AND workspace_id IN (SELECT workspace_id FROM bindings WHERE runner_id=?)'
        params = [notification_id,registry.runner_id]
        if workspace_id is not None:
            query += ' AND workspace_id=?'; params.append(workspace_id)
        rows = _bounded(registry.db,query,params,_FIELDS)
        if not rows:
            raise _error('Notification not found in this retained workspace view. Refresh notifications.', 'not_found')
        current = _entry(registry,rows[0],_now(registry))
        replayed = current['revision'] == 1
        if not replayed and current['revision'] != expected_revision:
            raise _error('Notification changed. Refresh before marking it read.','conflict')
        if not replayed:
            registry.db.execute('UPDATE pip_notifications SET revision=1,read_at=?,read_by=? WHERE id=? AND revision=0',
                                (_now(registry),actor,notification_id))
            rows = _bounded(registry.db,query,params,_FIELDS)
            current = _entry(registry,rows[0],_now(registry))
        return {'notification':current,'replayed':replayed}
