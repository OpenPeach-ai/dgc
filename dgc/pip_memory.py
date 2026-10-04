"""Explicit Pip-local finding exceptions, never suppression or execution authority.

Only the authenticated human controller calls mutation functions. Existing finding
reviews, shared context and checkpoint bytes are not rewritten or inferred here.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone

from . import pip_checkpoints as checkpoints
from .pip_overview import _bounded
from .pip_sources import from_record, validate_pin
from .redaction import redact_text, secret_values
from .workspace_registry import RegistryError, identifier

MAX_RECORD_BYTES = 6144
MAX_SNAPSHOT_BYTES = 8192
MAX_PAGE_BYTES = 65536
MAX_RECORDS = 1000
MAX_ACTIVE = 32
MAX_PINNED = 16
MAX_CURSOR = 2**53 - 1
SCHEMA = """
CREATE TABLE pip_memories(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 pip_id TEXT NOT NULL REFERENCES pips(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 source_run_id TEXT NOT NULL REFERENCES pip_runs(id),
 source_finding_index INTEGER NOT NULL CHECK(source_finding_index BETWEEN 0 AND 15),
 request_key_digest TEXT NOT NULL, request_digest TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=6144), digest TEXT NOT NULL,
 expires_at TEXT,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision IN (0,1)),
 revoked_at TEXT, revoked_by TEXT, revoke_reason TEXT,
 UNIQUE(pip_id,request_key_digest),
 CHECK((status='active' AND revision=0 AND revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
  OR (status='revoked' AND revision=1 AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)));
CREATE INDEX pip_memory_history ON pip_memories(pip_id,seq);
CREATE TRIGGER immutable_pip_memory BEFORE UPDATE OF seq,id,pip_id,workspace_id,source_run_id,
 source_finding_index,request_key_digest,request_digest,payload,digest,expires_at ON pip_memories
 BEGIN SELECT RAISE(ABORT,'immutable Pip memory'); END;
CREATE TRIGGER revoke_pip_memory_once BEFORE UPDATE OF status,revision,revoked_at,revoked_by,revoke_reason ON pip_memories
 WHEN OLD.status!='active' OR NEW.status!='revoked' OR OLD.revision!=0 OR NEW.revision!=1
 BEGIN SELECT RAISE(ABORT,'Pip memory may be revoked once'); END;
CREATE TRIGGER retain_pip_memory BEFORE DELETE ON pip_memories
 BEGIN SELECT RAISE(ABORT,'Pip memory history is retained'); END;
"""
_SOURCE_FIELDS = {'run_id','checkpoint_id','finding_index','finding_id','finding_identity','finding','context_reference',
                  'finding_review_revision','job_version','source_policy','source_revision','source_snapshot'}
_BODY_FIELDS = {'schema_version','id','pip_id','workspace_id','kind','source','reason','created_at','created_by',
                'expires_at','classification','verification','effect'}
_REVIEW_FIELDS = {'digest','status','revision','revoked_at','revoked_by','revoke_reason'}
_ROW_FIELDS = {'seq':None,'id':64,'pip_id':64,'workspace_id':64,'source_run_id':64,
               'source_finding_index':None,'request_key_digest':64,'request_digest':64,
               'payload':MAX_RECORD_BYTES,'digest':64,'expires_at':40,'status':16,'revision':None,
               'revoked_at':40,'revoked_by':128,'revoke_reason':1000}


def _error(message, code='invalid_memory'):
    return RegistryError(code, message)


def _text(value, name, maximum, *, multiline=False):
    try:
        return checkpoints._text(value, name, maximum, multiline=multiline)
    except RegistryError as exc:
        raise _error(str(exc), 'memory_limit' if exc.code == 'checkpoint_limit' else 'invalid_memory') from exc


def _integer(value, name, low=0, high=MAX_CURSOR):
    if type(value) is not int or not low <= value <= high:
        raise _error(f'{name} must be an integer between {low} and {high}.')
    return value


def _id(value, prefix):
    if not isinstance(value,str) or not re.fullmatch(prefix+r'_[0-9a-f]{32}',value):
        raise _error('Pip memory requires an exact local record identity.')
    return value


def _hash(value):
    if not isinstance(value,str) or not re.fullmatch(r'[0-9a-f]{64}',value):
        raise _error('Pip memory requires an exact SHA256 digest.')
    return value


def _encoded(value, maximum):
    try:
        return checkpoints._encoded(value,maximum)
    except RegistryError as exc:
        raise _error('Pip memory exceeds its bounded JSON contract.', 'memory_limit') from exc


def _digest(value, maximum=MAX_RECORD_BYTES):
    return hashlib.sha256(_encoded(value,maximum)).hexdigest()


def _timestamp(value):
    _text(value,'Memory time',40)
    try:
        parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
        if parsed.tzinfo is None:
            raise ValueError('timezone required')
        canonical=parsed.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
    except (ValueError,OverflowError) as exc:
        raise _error('Memory time must be an explicit timezone-aware timestamp.') from exc
    return canonical


def _canonical_time(value):
    if _timestamp(value) != value:
        raise _error('Stored memory timestamps must use canonical UTC milliseconds.')
    return value


def _scope(store,pip_id):
    _id(pip_id,'pip')
    rows=_bounded(store.db, 'SELECT p.id,p.workspace_id FROM pips p JOIN bindings b ON b.workspace_id=p.workspace_id '
                  'WHERE p.id=? AND b.runner_id=?',(pip_id,store.registry.runner_id),{'id':64,'workspace_id':64})
    if len(rows)!=1:
        raise _error('Pip not found on this runner.','not_found')
    _id(rows[0]['workspace_id'],'ws')
    return rows[0]


def _validate_source(source):
    if not isinstance(source,dict) or set(source)!=_SOURCE_FIELDS:
        raise _error('Memory source fields are unsupported.')
    _id(source['run_id'],'run'); _integer(source['checkpoint_id'],'Checkpoint ID',1)
    index=_integer(source['finding_index'],'Finding index',0,15)
    if source['finding_id'] != checkpoints._finding_id(source['run_id'],index):
        raise _error('Memory finding identity does not match its source.')
    checkpoints._validate_finding(source['finding'])
    if source['finding_identity'] != checkpoints._identity(source['finding']):
        raise _error('Memory finding content does not match its identity.')
    _integer(source['finding_review_revision'],'Finding review revision',0,100)
    _integer(source['job_version'],'Source job version',1)
    context=source['context_reference']
    if context is not None:
        if not isinstance(context,dict) or set(context)!={'revision','digest'}:
            raise _error('Memory context provenance is malformed.')
        _integer(context['revision'],'Source context revision'); _hash(context['digest'])
    from_record(source)
    _encoded(source,MAX_RECORD_BYTES)
    return source


def source_exception(store,pip_id,run_id,finding_index):
    """Read the exact candidate a human must review; no exception is recorded."""
    _id(run_id,'run'); _integer(finding_index,'Finding index',0,15)
    with checkpoints._read(store):
        pip=_scope(store,pip_id)
        member=store.db.execute('SELECT 1 FROM pip_runs WHERE id=? AND pip_id=? AND workspace_id=?',
                                (run_id,pip_id,pip['workspace_id'])).fetchone()
        if member is None:
            raise _error('Finding source does not belong to this Pip.','not_found')
        checkpoint=checkpoints.for_run(store,run_id)
        if checkpoint is None or finding_index>=len(checkpoint['findings']):
            raise _error('Choose a checked finding from a completed audit checkpoint.','checkpoint_unavailable')
        finding=checkpoint['findings'][finding_index]
        source={'run_id':run_id,'checkpoint_id':checkpoint['id'],'finding_index':finding_index,
                'finding_id':finding['finding_id'],'finding_identity':finding['identity'],
                'finding':{key:finding[key] for key in checkpoints._FINDING_FIELDS},
                'finding_review_revision':finding['review']['revision'],'job_version':checkpoint['job_version'],
                'context_reference':{'revision':checkpoint['context_revision'],'digest':checkpoint['context_digest']},
                **from_record(checkpoint)}
        _validate_source(source)
        candidate={'pip_id':pip_id,'workspace_id':pip['workspace_id'],'source':source}
        return {**candidate,'digest':_digest(candidate)}


def _validate_body(body):
    if not isinstance(body,dict) or set(body)!=_BODY_FIELDS or type(body['schema_version']) is not int or body['schema_version']!=1:
        raise _error('Memory body schema is unsupported.')
    for key,prefix in (('id','memory'),('pip_id','pip'),('workspace_id','ws')):
        _id(body[key],prefix)
    if (body['kind']!='finding_exception' or body['classification']!='user_recorded_exception'
            or body['verification']!='not_execution_verified' or body['effect']!='reference_only'):
        raise _error('Memory cannot claim verification, suppression or execution authority.')
    _validate_source(body['source']); _text(body['reason'],'Exception rationale',1000,multiline=True)
    _text(body['created_by'],'Recording actor',128); _canonical_time(body['created_at'])
    if body['expires_at'] is not None:
        _canonical_time(body['expires_at'])
        if body['expires_at']<=body['created_at']:
            raise _error('An exception must expire after it was recorded.')
    _encoded(body,MAX_RECORD_BYTES)
    return body


def _validate_memory(value):
    if not isinstance(value,dict) or set(value)!=_BODY_FIELDS|_REVIEW_FIELDS:
        raise _error('Saved memory has unsupported fields.')
    body=_validate_body({key:value[key] for key in _BODY_FIELDS})
    if _hash(value['digest'])!=_digest(body):
        raise _error('Saved memory failed its immutable digest check.','memory_mismatch')
    if value['status']=='active':
        if value['revision']!=0 or type(value['revision']) is not int or any(value[k] is not None for k in ('revoked_at','revoked_by','revoke_reason')):
            raise _error('Active memory has an invalid review receipt.')
    elif value['status']=='revoked':
        if value['revision']!=1 or type(value['revision']) is not int:
            raise _error('Revoked memory has an invalid review revision.')
        _canonical_time(value['revoked_at']); _text(value['revoked_by'],'Revoking actor',128)
        _text(value['revoke_reason'],'Revocation rationale',1000,multiline=True)
        if value['revoked_at']<body['created_at']:
            raise _error('Revocation cannot precede memory creation.')
    else:
        raise _error('Unknown memory lifecycle status.')
    return value


def _load(store,pip_id,memory_id):
    pip=_scope(store,pip_id); _id(memory_id,'memory')
    rows=_bounded(store.db,'SELECT * FROM pip_memories WHERE id=? AND pip_id=? AND workspace_id=?',
                  (memory_id,pip_id,pip['workspace_id']),_ROW_FIELDS)
    if not rows:
        raise _error('Memory not found for this Pip.','not_found')
    row=rows[0]; _integer(row['seq'],'Memory sequence',1)
    def unique(pairs):
        value={}
        for key,item in pairs:
            if key in value:
                raise ValueError('duplicate memory field')
            value[key]=item
        return value
    try:
        body=json.loads(row['payload'],object_pairs_hook=unique)
    except (ValueError,RecursionError,TypeError) as exc:
        raise _error('Stored memory is malformed JSON.') from exc
    memory={**_validate_body(body),**{key:row[key] for key in _REVIEW_FIELDS}}
    _validate_memory(memory)
    if (body['id']!=row['id'] or body['pip_id']!=pip_id or body['workspace_id']!=pip['workspace_id']
            or body['source']['run_id']!=row['source_run_id'] or body['source']['finding_index']!=row['source_finding_index']
            or body['expires_at']!=row['expires_at']):
        raise _error('Stored memory identities do not match its ledger.','memory_mismatch')
    _hash(row['request_key_digest']); _hash(row['request_digest'])
    actual=source_exception(store,pip_id,row['source_run_id'],row['source_finding_index'])['source']
    # Review status can change later. The original reviewed generation remains
    # historical; the immutable checked finding/source must still match exactly.
    if any(actual[key]!=body['source'][key] for key in _SOURCE_FIELDS-{'finding_review_revision'}):
        raise _error('Memory does not match its original checked source.','memory_mismatch')
    return memory,row


def record_exception(store,pip_id,run_id,finding_index,expected_source_digest,reason,expires_at,request_key,actor):
    """Explicit human action following source review; exact retries are durable."""
    _id(pip_id,'pip'); _id(run_id,'run'); _integer(finding_index,'Finding index',0,15); _hash(expected_source_digest)
    _text(reason,'Exception rationale',1000,multiline=True); _text(actor,'Recording actor',128)
    _text(request_key,'Request key',128)
    secrets=secret_values(); reason=redact_text(reason,secrets); actor=redact_text(actor,secrets)
    _text(reason,'Exception rationale',1000,multiline=True); _text(actor,'Recording actor',128)
    expiry=None if expires_at is None else _timestamp(expires_at)
    request={'pip_id':pip_id,'run_id':run_id,'finding_index':finding_index,'source_digest':expected_source_digest,
             'reason':reason,'expires_at':expiry,'actor':actor}
    request_digest=_digest(request); key_digest=hashlib.sha256(request_key.encode()).hexdigest()
    with store.registry.transaction():
        pip=_scope(store,pip_id)
        prior=_bounded(store.db,'SELECT id,request_digest FROM pip_memories WHERE pip_id=? AND request_key_digest=?',
                       (pip_id,key_digest),{'id':64,'request_digest':64})
        if prior:
            if prior[0]['request_digest']!=request_digest:
                raise _error('This request key already records a different exception.','conflict')
            return {'memory':_load(store,pip_id,prior[0]['id'])[0],'replayed':True}
        candidate=source_exception(store,pip_id,run_id,finding_index)
        if candidate['digest']!=expected_source_digest:
            raise _error('The source finding or its review changed. Inspect it again before recording an exception.','conflict')
        now=_timestamp(store.registry.clock())
        if expiry is not None and expiry<=now:
            raise _error('Choose an expiry in the future, or explicitly leave it unset.')
        from .pip_memory_statements import check_capacity
        check_capacity(store,pip_id,now)
        total=store.db.execute('SELECT count(*) FROM pip_memories').fetchone()[0]
        active=store.db.execute("SELECT count(*) FROM pip_memories WHERE pip_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)",(pip_id,now)).fetchone()[0]
        if total>=MAX_RECORDS or active>=MAX_ACTIVE:
            raise _error('The local exception archive or this Pip’s 32 active-exception budget is full. No exception was recorded.','memory_limit')
        if store.db.execute("SELECT 1 FROM pip_memories WHERE pip_id=? AND source_run_id=? AND source_finding_index=? AND status='active' AND (expires_at IS NULL OR expires_at>?)",(pip_id,run_id,finding_index,now)).fetchone():
            raise _error('This finding already has an active exception. Revoke it before recording a replacement.','conflict')
        body={'schema_version':1,'id':identifier('memory'),'pip_id':pip_id,'workspace_id':pip['workspace_id'],
              'kind':'finding_exception','source':candidate['source'],'reason':reason,'created_at':now,
              'created_by':actor,'expires_at':expiry,'classification':'user_recorded_exception',
              'verification':'not_execution_verified','effect':'reference_only'}
        _validate_body(body)
        store.db.execute('INSERT INTO pip_memories(id,pip_id,workspace_id,source_run_id,source_finding_index,request_key_digest,request_digest,payload,digest,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
            (body['id'],pip_id,pip['workspace_id'],run_id,finding_index,key_digest,request_digest,_encoded(body,MAX_RECORD_BYTES).decode(),_digest(body),expiry))
        store.registry.event(pip['workspace_id'],'pip_exception_recorded',pip_id=pip_id,run_id=run_id,
                             payload={'memory_id':body['id'],'finding_index':finding_index,'actor':actor})
        return {'memory':_load(store,pip_id,body['id'])[0],'replayed':False}


def revoke_exception(store,pip_id,memory_id,expected_revision,reason,actor):
    _integer(expected_revision,'Expected memory revision',0,1)
    _text(reason,'Revocation rationale',1000,multiline=True); _text(actor,'Revoking actor',128)
    reason=redact_text(reason,secret_values()); actor=redact_text(actor,secret_values())
    with store.registry.transaction():
        current,row=_load(store,pip_id,memory_id)
        if current['status']=='revoked':
            if current['revoked_by']==actor and current['revoke_reason']==reason:
                return {'memory':current,'replayed':True}
            raise _error('This exception was already revoked by another review.','conflict')
        if current['revision']!=expected_revision:
            raise _error('Memory changed. Reload it before revoking.','conflict')
        now=_timestamp(store.registry.clock())
        updated={**current,'status':'revoked','revision':1,'revoked_at':now,'revoked_by':actor,'revoke_reason':reason}
        _validate_memory(updated)
        changed=store.db.execute("UPDATE pip_memories SET status='revoked',revision=1,revoked_at=?,revoked_by=?,revoke_reason=? WHERE id=? AND revision=?",
                                 (now,actor,reason,memory_id,expected_revision))
        if changed.rowcount!=1:
            raise _error('Memory changed. Reload it before revoking.','conflict')
        store.registry.event(current['workspace_id'],'pip_exception_revoked',pip_id=pip_id,
                             payload={'memory_id':memory_id,'actor':actor})
        return {'memory':updated,'replayed':False}


def list_memories(store,pip_id,before_id=None,limit=20):
    _integer(limit,'Memory page size',1,20)
    with checkpoints._read(store):
        pip=_scope(store,pip_id); before=MAX_CURSOR+1
        if before_id is not None:
            _integer(before_id,'Memory cursor',1)
            if not store.db.execute('SELECT 1 FROM pip_memories WHERE seq=? AND pip_id=?',(before_id,pip_id)).fetchone():
                raise _error('Memory cursor does not belong to this Pip.','invalid_cursor')
            before=before_id
        rows=_bounded(store.db,'SELECT seq,id FROM pip_memories WHERE pip_id=? AND seq<? ORDER BY seq DESC LIMIT ?',
                       (pip_id,before,limit+1),{'seq':None,'id':64})
        result={'pip_id':pip_id,'workspace_id':pip['workspace_id'],'memories':[],'next_before_id':None}
        for row in rows[:limit]:
            memory,_=_load(store,pip_id,row['id']); result['memories'].append(memory)
            try:
                _encoded(result,MAX_PAGE_BYTES-128)
            except RegistryError:
                result['memories'].pop(); break
        count=len(result['memories'])
        result['next_before_id']=rows[count-1]['seq'] if count<len(rows) and count else None
        return result


def _applicability(memory,source,job_version):
    same_source=from_record(memory['source'])==source
    same_job=memory['source']['job_version']==job_version
    return ('exact_source_and_job' if same_source and same_job else 'historical_source' if same_job
            else 'historical_job' if same_source else 'historical_source_and_job')


def snapshot(store,pip_id,source,job_version,as_of,*,context_reference=None):
    source=validate_pin(source); _integer(job_version,'Pinned job version',1); now=_timestamp(as_of)
    with checkpoints._read(store):
        pip=_scope(store,pip_id)
        if store.db.execute('SELECT 1 FROM pip_memory_statements WHERE pip_id=? AND workspace_id=? LIMIT 1',
                            (pip_id,pip['workspace_id'])).fetchone():
            from .pip_memory_references import snapshot as typed_snapshot
            return typed_snapshot(store,pip_id,source,job_version,now,context_reference)
        total,revoked,expired=store.db.execute("SELECT count(*),coalesce(sum(status='revoked'),0),coalesce(sum(status='active' AND expires_at IS NOT NULL AND expires_at<=?),0) FROM pip_memories WHERE pip_id=?",(now,pip_id)).fetchone()
        eligible=total-revoked-expired
        for n in (total,revoked,expired):
            _integer(n,'Memory count',0,MAX_RECORDS)
        _integer(eligible,'Eligible memory count',0,MAX_ACTIVE)
        value={'schema_version':1,'pip_id':pip_id,'workspace_id':pip['workspace_id'],'source':source,
               'job_version':job_version,'as_of':now,'total_records':total,'revoked_records':revoked,
               'expired_records':expired,'eligible_records':eligible,'omitted_records':eligible,'entries':[]}
        rows=_bounded(store.db,"SELECT id FROM pip_memories WHERE pip_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY seq DESC LIMIT ?",(pip_id,now,MAX_PINNED),{'id':64})
        for row in rows:
            memory,_=_load(store,pip_id,row['id'])
            entry={'memory':memory,'applicability':_applicability(memory,source,job_version)}
            value['entries'].append(entry); value['omitted_records']-=1
            try:
                _encoded({**value,'digest':'0'*64},MAX_SNAPSHOT_BYTES)
            except RegistryError:
                value['entries'].pop(); value['omitted_records']+=1; break
        return {**value,'digest':_digest(value,MAX_SNAPSHOT_BYTES)}


def validate_snapshot(value,*,pip_id=None,workspace_id=None,source=None,job_version=None,context_reference=None):
    """Pure validation of queue-time reference data, including exact applicability."""
    if isinstance(value,dict) and type(value.get('schema_version')) is int and value['schema_version']==2:
        from .pip_memory_references import validate_snapshot as validate_typed
        return validate_typed(value,pip_id=pip_id,workspace_id=workspace_id,source=source,
                              job_version=job_version,context_reference=context_reference)
    fields={'schema_version','pip_id','workspace_id','source','job_version','as_of','total_records',
            'revoked_records','expired_records','eligible_records','omitted_records','entries','digest'}
    if not isinstance(value,dict) or set(value)!=fields or type(value['schema_version']) is not int or value['schema_version']!=1:
        raise _error('Pinned Pip memory schema is unsupported.')
    _encoded(value,MAX_SNAPSHOT_BYTES)
    _id(value['pip_id'],'pip'); _id(value['workspace_id'],'ws'); validate_pin(value['source'])
    _integer(value['job_version'],'Pinned job version',1); _canonical_time(value['as_of'])
    for key,expected in (('pip_id',pip_id),('workspace_id',workspace_id),('source',source),('job_version',job_version)):
        if expected is not None and value[key]!=expected:
            raise _error('Pinned memory does not belong to this run.','memory_mismatch')
    for key in ('total_records','revoked_records','expired_records'):
        _integer(value[key],key,0,MAX_RECORDS)
    for key in ('eligible_records','omitted_records'):
        _integer(value[key],key,0,MAX_ACTIVE)
    entries=value['entries']
    if (not isinstance(entries,list) or len(entries)>MAX_PINNED
            or value['total_records']!=value['eligible_records']+value['revoked_records']+value['expired_records']
            or len(entries)+value['omitted_records']!=value['eligible_records']):
        raise _error('Pinned memory counts are inconsistent.')
    seen=set()
    for entry in entries:
        if not isinstance(entry,dict) or set(entry)!={'memory','applicability'}:
            raise _error('Pinned memory entry fields are unsupported.')
        memory=_validate_memory(entry['memory'])
        if (memory['id'] in seen or memory['pip_id']!=value['pip_id'] or memory['workspace_id']!=value['workspace_id']
                or memory['status']!='active' or memory['created_at']>value['as_of']
                or memory['expires_at'] is not None and memory['expires_at']<=value['as_of']):
            raise _error('Pinned memory is duplicated, ineligible or crosses its scope.')
        if entry['applicability']!=_applicability(memory,value['source'],value['job_version']):
            raise _error('Pinned memory cannot inherit applicability across a source or job change.')
        seen.add(memory['id'])
    if _hash(value['digest'])!=_digest({k:v for k,v in value.items() if k!='digest'},MAX_SNAPSHOT_BYTES):
        raise _error('Pinned memory failed its content digest check.','memory_mismatch')
    return value
