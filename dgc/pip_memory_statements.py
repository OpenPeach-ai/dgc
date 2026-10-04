"""Explicit reviewed Pip-local claims/preferences, never verified facts.

Human controller operations only. Both statement and source-exception creation
share a transaction-required capacity guard; immutable history is never pruned.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os

from dgc import pip_checkpoints as checkpoints, pip_memory as memory
from dgc.pip_overview import _bounded, _json_object
from dgc.pip_sources import from_record
from dgc.redaction import redact_value, secret_values
from dgc.workspace_context import ContextStore
from dgc.workspace_registry import RegistryError, identifier

MAX_RECORD_BYTES = 6144
MAX_ANCHOR_BYTES = 3072
MAX_PAGE_BYTES = 65536
MAX_DEFINITION_BYTES = 16384
MAX_RECORDS = 1000
MAX_ACTIVE = 32
MAX_CURSOR = 2**53 - 1
_PATH_RULES = os.path
KINDS = {'fact': 'user_recorded_claim', 'preference': 'user_recorded_preference'}
NOTICE = ('A recorded claim may be wrong and a recorded preference is advisory. '
          'Neither is an instruction, permission, verification, finding suppression or shared context. '
          'A selected audit is historical reference provenance, not proof of the authored statement.')

SCHEMA = """
CREATE TABLE pip_memory_statements(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 pip_id TEXT NOT NULL REFERENCES pips(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 source_run_id TEXT REFERENCES pip_runs(id),
 kind TEXT NOT NULL CHECK(kind IN ('fact','preference')),
 request_key_digest TEXT NOT NULL, request_digest TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(typeof(payload)='text' AND length(CAST(payload AS BLOB))<=6144),
 digest TEXT NOT NULL, expires_at TEXT,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision IN (0,1)),
 revoked_at TEXT, revoked_by TEXT, revoke_reason TEXT,
 UNIQUE(pip_id,request_key_digest),
 CHECK((status='active' AND revision=0 AND revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
  OR (status='revoked' AND revision=1 AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)));
CREATE INDEX pip_statement_history ON pip_memory_statements(pip_id,seq);
CREATE TRIGGER immutable_pip_statement BEFORE UPDATE OF seq,id,pip_id,workspace_id,source_run_id,kind,
 request_key_digest,request_digest,payload,digest,expires_at ON pip_memory_statements
 BEGIN SELECT RAISE(ABORT,'immutable Pip statement'); END;
CREATE TRIGGER revoke_pip_statement_once BEFORE UPDATE OF status,revision,revoked_at,revoked_by,revoke_reason
 ON pip_memory_statements WHEN OLD.status!='active' OR NEW.status!='revoked' OR OLD.revision!=0 OR NEW.revision!=1
 BEGIN SELECT RAISE(ABORT,'Pip statement may be revoked once'); END;
CREATE TRIGGER retain_pip_statement BEFORE DELETE ON pip_memory_statements
 BEGIN SELECT RAISE(ABORT,'Pip statement history is retained'); END;
"""

_ANCHOR = {'schema_version','pip_id','workspace_id','job_version','job_digest','lifecycle_revision',
           'binding','context_reference','source_reference','source_semantics'}
_SOURCE = {'run_id','checkpoint_id','checkpoint_digest','checkpoint_digest_kind','job_version',
           'source_policy','source_revision','source_snapshot','context_reference'}
_BODY = {'schema_version','id','pip_id','workspace_id','kind','title','statement','reason','anchor',
         'anchor_digest','created_at','created_by','expires_at','classification','verification','effect'}
_REVIEW = {'digest','status','revision','revoked_at','revoked_by','revoke_reason'}
_ROW = {'seq':None,'id':64,'pip_id':64,'workspace_id':64,'source_run_id':64,'kind':16,
        'request_key_digest':64,'request_digest':64,'payload':MAX_RECORD_BYTES,'digest':64,
        'expires_at':40,'status':16,'revision':None,'revoked_at':40,'revoked_by':128,'revoke_reason':1000}


def _error(message, code='invalid_statement'):
    return RegistryError(code, message)


def _exact(value, fields, label):
    if not isinstance(value,dict) or set(value)!=fields:
        raise _error(f'{label} contains unsupported or missing fields.')


def _integer(value, label, low=0, high=MAX_CURSOR):
    if type(value) is not int or not low<=value<=high:
        raise _error(f'{label} must be an integer between {low} and {high}.')
    return value


def _text(value, label, maximum, *, multiline=False):
    try:
        return memory._text(value,label,maximum,multiline=multiline)
    except RegistryError as exc:
        raise _error(str(exc)) from exc


def _id(value,prefix):
    try:
        return memory._id(value,prefix)
    except RegistryError as exc:
        raise _error('A statement requires an exact local identity.') from exc


def _hash(value):
    try:
        return memory._hash(value)
    except RegistryError as exc:
        raise _error('A statement requires an exact SHA256 digest.') from exc


def _time(value):
    try:
        return memory._canonical_time(value)
    except RegistryError as exc:
        raise _error('Stored statement time must be canonical UTC milliseconds.') from exc


def _encoded(value,maximum=MAX_RECORD_BYTES):
    try:
        return memory._encoded(value,maximum)
    except RegistryError as exc:
        raise _error('Statement data exceeds its bounded JSON contract.','statement_limit') from exc


def _digest(value,maximum=MAX_RECORD_BYTES):
    return hashlib.sha256(_encoded(value,maximum)).hexdigest()


def _return(value,config):
    # Do not silently rewrite reviewed text while retaining its original digest.
    # Future redacted model references have their own projection contract.
    if redact_value(value,secret_values(config)) != value:
        raise _error('Configured credentials overlap this statement view. Remove credentials from authored text or use a separately redacted reference view.','secret_detected')
    return value


@contextlib.contextmanager
def _write(store):
    if store.db.in_transaction:
        yield
    else:
        with store.registry.transaction():
            yield


def _scope(store,pip_id):
    _id(pip_id,'pip'); _id(store.registry.runner_id,'runner')
    rows=_bounded(store.db,'''SELECT p.id,p.workspace_id,p.status,
        CASE WHEN typeof(p.current_version)='integer' THEN p.current_version ELSE NULL END AS current_version,
        b.id AS binding_id,b.runner_id,b.canonical_root,b.updated_at AS binding_updated_at
        FROM pips p JOIN bindings b ON b.workspace_id=p.workspace_id
        WHERE p.id=? AND b.runner_id=? LIMIT 2''',(pip_id,store.registry.runner_id),
        {'id':64,'workspace_id':64,'status':16,'current_version':None,'binding_id':64,
         'runner_id':64,'canonical_root':4096,'binding_updated_at':40})
    if len(rows)!=1:
        raise _error('Pip not found on this runner.','not_found')
    row=rows[0]; _id(row['workspace_id'],'ws'); _id(row['binding_id'],'binding'); _id(row['runner_id'],'runner')
    _integer(row['current_version'],'Job version',1,999999); _time(row['binding_updated_at'])
    root=_text(row['canonical_root'],'Stored binding root',4096)
    if not _PATH_RULES.isabs(root) or _PATH_RULES.normpath(root)!=root:
        raise _error('Stored binding root is not an absolute canonical path.')
    if row['status'] not in ('active','paused','archived'):
        raise _error('Pip lifecycle state is invalid.')
    return row


def _definition_digest(store,pip_id,version):
    rows=_bounded(store.db,'SELECT definition FROM pip_versions WHERE pip_id=? AND version=?',
                  (pip_id,version),{'definition':MAX_DEFINITION_BYTES})
    if len(rows)!=1:
        raise _error('The statement job version is unavailable.','statement_mismatch')
    raw=rows[0]['definition']; _json_object(raw,MAX_DEFINITION_BYTES)
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def _source(store,pip,run_id):
    if run_id is None:
        return None
    _id(run_id,'run')
    # Membership and scalar terminal status precede any manifest/report decoding.
    if not store.db.execute("SELECT 1 FROM pip_runs WHERE id=? AND pip_id=? AND workspace_id=? AND status='succeeded'",
                            (run_id,pip['id'],pip['workspace_id'])).fetchone():
        raise _error('Select a successful audit of this same Pip.','not_found')
    runs=_bounded(store.db,'SELECT finished_at,manifest,result FROM pip_runs WHERE id=? AND pip_id=? AND workspace_id=?',
                  (run_id,pip['id'],pip['workspace_id']),
                  {'finished_at':40,'manifest':checkpoints.MAX_MANIFEST_BYTES,'result':checkpoints.MAX_PAYLOAD_BYTES})
    _time(runs[0]['finished_at'])
    manifest=_json_object(runs[0]['manifest'],checkpoints.MAX_MANIFEST_BYTES)
    result=_json_object(runs[0]['result'],checkpoints.MAX_PAYLOAD_BYTES)
    if (manifest.get('run_kind','audit')!='audit' or manifest.get('pip_id')!=pip['id']
            or manifest.get('workspace_id')!=pip['workspace_id']):
        raise _error('Selected source manifest is not an audit of this same Pip.','statement_mismatch')
    _integer(manifest.get('job_version'),'Source job version',1,999999)
    from dgc.workspace_context import validate_snapshot
    context=validate_snapshot(manifest.get('workspace_context'),workspace_id=pip['workspace_id'])
    checkpoints.encode_result(result)
    rows=_bounded(store.db,'SELECT id,payload FROM pip_checkpoints WHERE run_id=? AND pip_id=? AND workspace_id=?',
                  (run_id,pip['id'],pip['workspace_id']),{'id':None,'payload':checkpoints.MAX_PAYLOAD_BYTES})
    if len(rows)!=1:
        raise _error('The selected result has no checked audit checkpoint.','checkpoint_unavailable')
    row=rows[0]; _integer(row['id'],'Checkpoint identity',1)
    checked=checkpoints._load(store,row['id'],reviews=False)
    if checked['run_id']!=run_id or checked['pip_id']!=pip['id'] or checked['workspace_id']!=pip['workspace_id']:
        raise _error('The selected checkpoint crossed its source scope.','statement_mismatch')
    if (checked['job_version']!=manifest['job_version'] or checked['context_revision']!=context['revision']
            or checked['context_digest']!=context['digest'] or from_record(checked)!=from_record(manifest)
            or [{k:f[k] for k in checkpoints._FINDING_FIELDS} for f in checked['findings']]!=result['findings']):
        raise _error('The selected checkpoint does not match its original audited result or provenance.','statement_mismatch')
    captured=from_record(manifest)['source_snapshot']
    if captured is not None and result.get('snapshot')!={k:captured[k] for k in ('sha256','files','bytes')}:
        raise _error('The selected audit result does not match its captured source.','statement_mismatch')
    value={'run_id':run_id,'checkpoint_id':row['id'],
           'checkpoint_digest':hashlib.sha256(row['payload'].encode('utf-8')).hexdigest(),
           'checkpoint_digest_kind':'stored_checkpoint_utf8','job_version':checked['job_version'],
           **from_record(checked),'context_reference':{'revision':checked['context_revision'],'digest':checked['context_digest']}}
    _validate_source(value)
    return value


def _context(value):
    _exact(value,{'revision','digest'},'Context reference')
    _integer(value['revision'],'Context revision',0,2147483647); _hash(value['digest'])


def _validate_source(value):
    _exact(value,_SOURCE,'Selected audit reference'); _id(value['run_id'],'run')
    _integer(value['checkpoint_id'],'Checkpoint identity',1); _integer(value['job_version'],'Source job version',1,999999)
    _hash(value['checkpoint_digest']); _context(value['context_reference']); from_record(value)
    if value['checkpoint_digest_kind']!='stored_checkpoint_utf8':
        raise _error('The checkpoint hash must identify original stored checkpoint bytes.')


def validate_anchor(value):
    _exact(value,_ANCHOR,'Statement anchor')
    if type(value['schema_version']) is not int or value['schema_version']!=1:
        raise _error('Statement anchor version is unsupported.')
    _id(value['pip_id'],'pip'); _id(value['workspace_id'],'ws')
    _integer(value['job_version'],'Job version',1,999999); _hash(value['job_digest'])
    _integer(value['lifecycle_revision'],'Lifecycle revision'); _context(value['context_reference'])
    binding=value['binding']; _exact(binding,{'binding_id','runner_id','updated_at','root_digest'},'Binding reference')
    _id(binding['binding_id'],'binding'); _id(binding['runner_id'],'runner'); _time(binding['updated_at']); _hash(binding['root_digest'])
    if value['source_reference'] is None:
        if value['source_semantics']!='not_observed':
            raise _error('An unselected source cannot claim source observation.')
    else:
        _validate_source(value['source_reference'])
        if value['source_semantics']!='selected_audit_reference':
            raise _error('A selected audit is a reference, not statement verification.')
    _encoded(value,MAX_ANCHOR_BYTES)
    return value


def _anchor(store,pip,source_run_id):
    context=ContextStore(store.registry).snapshot(pip['workspace_id'])
    row=store.db.execute("SELECT CASE WHEN typeof(revision)='integer' THEN revision ELSE NULL END FROM pip_lifecycle_state WHERE pip_id=?",(pip['id'],)).fetchone()
    if row is None:raise _error('Pip lifecycle revision is unavailable.')
    revision=_integer(row[0],'Lifecycle revision')
    value={'schema_version':1,'pip_id':pip['id'],'workspace_id':pip['workspace_id'],
        'job_version':pip['current_version'],'job_digest':_definition_digest(store,pip['id'],pip['current_version']),
        'lifecycle_revision':revision,
        'binding':{'binding_id':pip['binding_id'],'runner_id':pip['runner_id'],'updated_at':pip['binding_updated_at'],
                   'root_digest':hashlib.sha256(pip['canonical_root'].encode('utf-8')).hexdigest()},
        'context_reference':{'revision':context['revision'],'digest':context['digest']},
        'source_reference':_source(store,pip,source_run_id),
        'source_semantics':'not_observed' if source_run_id is None else 'selected_audit_reference'}
    return validate_anchor(value)


def anchor(store,pip_id,source_run_id=None,*,config=None):
    """Read-only review candidate; no source filesystem, transcript or model I/O."""
    with checkpoints._read(store):
        value=_anchor(store,_scope(store,pip_id),source_run_id)
        return _return({'anchor':value,'digest':_digest(value,MAX_ANCHOR_BYTES)},config)


def _counts(store,pip_id,now):
    row=store.db.execute("SELECT count(*),coalesce(sum(status='revoked'),0),coalesce(sum(status='active' AND expires_at IS NOT NULL AND expires_at<=?),0) FROM pip_memory_statements WHERE pip_id=?",(now,pip_id)).fetchone()
    retained,revoked,expired=tuple(row)
    for count in row:_integer(count,'Statement count',0,MAX_RECORDS)
    active=retained-revoked-expired; _integer(active,'Active statement count',0,MAX_ACTIVE)
    return {'retained':retained,'active':active,'expired':expired,'revoked':revoked}


def check_capacity(store,pip_id,now):
    """Required before either ledger INSERT inside its owning write transaction.

    Does not apply to exact replay. Both statement and exception writers invoke
    this guard under their owning write transaction before creating a new row.
    """
    if not store.db.in_transaction:
        raise _error('Combined memory capacity must be checked inside the write transaction.','transaction_required')
    _scope(store,pip_id); _time(now)
    total=store.db.execute('SELECT (SELECT count(*) FROM pip_memories)+(SELECT count(*) FROM pip_memory_statements)').fetchone()[0]
    active=0
    for table in ('pip_memories','pip_memory_statements'):
        active+=store.db.execute(f"SELECT count(*) FROM {table} WHERE pip_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)",(pip_id,now)).fetchone()[0]
    _integer(total,'Combined retained count',0,MAX_RECORDS); _integer(active,'Combined active count',0,MAX_ACTIVE)
    if total>=MAX_RECORDS or active>=MAX_ACTIVE:
        raise _error('The combined local memory archive or this Pip’s active-memory budget is full.','memory_limit')


def _validate_body(value):
    _exact(value,_BODY,'Statement body')
    if type(value['schema_version']) is not int or value['schema_version']!=1:
        raise _error('Statement body version is unsupported.')
    for key,prefix in (('id','memory'),('pip_id','pip'),('workspace_id','ws')):_id(value[key],prefix)
    if (not isinstance(value['kind'],str) or value['kind'] not in KINDS
            or value['classification']!=KINDS[value['kind']] or value['verification']!='not_execution_verified'
            or value['effect']!='reference_only'):
        raise _error('Statements cannot claim verification or grant authority.')
    _text(value['title'],'Statement title',200); _text(value['statement'],'Statement text',2000,multiline=True)
    _text(value['reason'],'Recording reason',1000,multiline=True); _text(value['created_by'],'Recording actor',128)
    _time(value['created_at']); validate_anchor(value['anchor'])
    if any(value[key]!=value['anchor'][key] for key in ('pip_id','workspace_id')):
        raise _error('Statement and anchor scope differ.','statement_mismatch')
    if _hash(value['anchor_digest'])!=_digest(value['anchor'],MAX_ANCHOR_BYTES):
        raise _error('Statement anchor failed its digest check.','statement_mismatch')
    if value['expires_at'] is not None:
        _time(value['expires_at'])
        if value['expires_at']<=value['created_at']:
            raise _error('Statement expiry must follow creation.')
    _encoded(value)
    return value


def validate_memory(value):
    """Pure closed validation; historical hashes do not prove authored claims."""
    _exact(value,_BODY|_REVIEW,'Saved statement')
    body=_validate_body({k:value[k] for k in _BODY})
    if _hash(value['digest'])!=_digest(body):
        raise _error('Statement failed its immutable body digest check.','statement_mismatch')
    _integer(value['revision'],'Statement revision',0,1)
    if value['status']=='active':
        if value['revision']!=0 or any(value[k] is not None for k in ('revoked_at','revoked_by','revoke_reason')):
            raise _error('Active statement has an invalid review receipt.')
    elif value['status']=='revoked':
        if value['revision']!=1:raise _error('Revoked statement has an invalid revision.')
        _time(value['revoked_at']); _text(value['revoked_by'],'Revoking actor',128)
        _text(value['revoke_reason'],'Revocation reason',1000,multiline=True)
        if value['revoked_at']<value['created_at']:raise _error('Revocation cannot precede creation.')
    else:raise _error('Statement lifecycle is unsupported.')
    _encoded(value,MAX_RECORD_BYTES+1536)
    return value


def _load(store,pip,memory_id):
    _id(memory_id,'memory')
    rows=_bounded(store.db,'SELECT * FROM pip_memory_statements WHERE id=? AND pip_id=? AND workspace_id=?',
                  (memory_id,pip['id'],pip['workspace_id']),_ROW)
    if len(rows)!=1:raise _error('Statement not found for this Pip.','not_found')
    row=rows[0]; _integer(row['seq'],'Statement sequence',1)
    body=_json_object(row['payload'],MAX_RECORD_BYTES)
    _validate_body(body)
    value=validate_memory({**body,**{k:row[k] for k in _REVIEW}})
    selected=value['anchor']['source_reference']
    source_run=None if selected is None else selected['run_id']
    if (value['id']!=row['id'] or value['pip_id']!=pip['id'] or value['workspace_id']!=pip['workspace_id']
            or value['kind']!=row['kind'] or value['expires_at']!=row['expires_at'] or source_run!=row['source_run_id']):
        raise _error('Statement scalar columns disagree with its immutable body.','statement_mismatch')
    _hash(row['request_key_digest']); _hash(row['request_digest'])
    request={'operation':'record_statement','pip_id':pip['id'],'kind':value['kind'],'title':value['title'],
             'statement':value['statement'],'reason':value['reason'],'expires_at':value['expires_at'],
             'anchor_digest':value['anchor_digest'],'source_run_id':source_run,'actor':value['created_by']}
    if _digest(request)!=row['request_digest']:
        raise _error('Statement request receipt does not match its immutable body.','statement_mismatch')
    if _definition_digest(store,pip['id'],value['anchor']['job_version'])!=value['anchor']['job_digest']:
        raise _error('Statement does not match its original job definition.','statement_mismatch')
    if selected is not None and _source(store,pip,source_run)!=selected:
        raise _error('Statement no longer matches its selected immutable audit.','statement_mismatch')
    return value,row


def _effective(value,now):
    return 'revoked' if value['status']=='revoked' else 'expired' if value['expires_at'] is not None and value['expires_at']<=now else 'active'


def get(store,pip_id,memory_id,*,config=None):
    with checkpoints._read(store):
        pip=_scope(store,pip_id); value,_=_load(store,pip,memory_id); now=memory._timestamp(store.registry.clock())
        return _return({'pip_id':pip_id,'workspace_id':pip['workspace_id'],'as_of':now,
                        'memory':value,'effective_status':_effective(value,now)},config)


def record(store,pip_id,kind,title,statement,reason,expires_at,expected_anchor_digest,request_key,actor,
           *,source_run_id=None,config=None):
    """Authenticated human operation; no callable model tool is added here."""
    _id(pip_id,'pip'); _hash(expected_anchor_digest)
    if not isinstance(kind,str) or kind not in KINDS:raise _error('Choose fact or preference.')
    _text(title,'Statement title',200); _text(statement,'Statement text',2000,multiline=True)
    _text(reason,'Recording reason',1000,multiline=True); _text(actor,'Recording actor',128)
    _text(request_key,'Request key',128)
    if source_run_id is not None:_id(source_run_id,'run')
    expiry=None if expires_at is None else memory._timestamp(expires_at)
    request={'operation':'record_statement','pip_id':pip_id,'kind':kind,'title':title,'statement':statement,
             'reason':reason,'expires_at':expiry,'anchor_digest':expected_anchor_digest,'source_run_id':source_run_id,'actor':actor}
    _return(request,config); request_digest=_digest(request)
    key_digest=hashlib.sha256(('record_statement\0'+request_key).encode('utf-8')).hexdigest()
    with _write(store):
        pip=_scope(store,pip_id)
        prior=_bounded(store.db,'SELECT id,request_digest FROM pip_memory_statements WHERE pip_id=? AND request_key_digest=?',
                       (pip_id,key_digest),{'id':64,'request_digest':64})
        if prior:
            if prior[0]['request_digest']!=request_digest:raise _error('This request key records a different statement.','conflict')
            return _return({'memory':_load(store,pip,prior[0]['id'])[0],'replayed':True},config)
        if pip['status']=='archived':raise _error('Restore this Pip before recording a new statement.','archived')
        reviewed=_anchor(store,pip,source_run_id)
        if _digest(reviewed,MAX_ANCHOR_BYTES)!=expected_anchor_digest:
            raise _error('The reviewed job, lifecycle, binding, context or selected source changed. Inspect a fresh anchor.','conflict')
        now=memory._timestamp(store.registry.clock())
        if expiry is not None and expiry<=now:raise _error('Choose a future expiry or explicitly leave it unset.')
        check_capacity(store,pip_id,now)
        body={'schema_version':1,'id':identifier('memory'),'pip_id':pip_id,'workspace_id':pip['workspace_id'],
              'kind':kind,'title':title,'statement':statement,'reason':reason,'anchor':reviewed,
              'anchor_digest':expected_anchor_digest,'created_at':now,'created_by':actor,'expires_at':expiry,
              'classification':KINDS[kind],'verification':'not_execution_verified','effect':'reference_only'}
        _validate_body(body)
        value=validate_memory({**body,'digest':_digest(body),'status':'active','revision':0,
                               'revoked_at':None,'revoked_by':None,'revoke_reason':None})
        response=_return({'memory':value,'replayed':False},config)
        store.db.execute('''INSERT INTO pip_memory_statements(id,pip_id,workspace_id,source_run_id,kind,
            request_key_digest,request_digest,payload,digest,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)''',
            (body['id'],pip_id,pip['workspace_id'],source_run_id,kind,key_digest,request_digest,
             _encoded(body).decode('utf-8'),value['digest'],expiry))
        store.registry.event(pip['workspace_id'],'pip_statement_recorded',pip_id=pip_id,run_id=source_run_id,
                             payload={'memory_id':body['id'],'kind':kind,'actor':actor})
        return response


def revoke(store,pip_id,memory_id,expected_revision,reason,actor,*,config=None):
    _integer(expected_revision,'Expected statement revision',0,0)
    _text(reason,'Revocation reason',1000,multiline=True); _text(actor,'Revoking actor',128)
    _return({'reason':reason,'actor':actor},config)
    with _write(store):
        pip=_scope(store,pip_id); value,_=_load(store,pip,memory_id)
        if value['status']=='revoked':
            if value['revoked_by']!=actor or value['revoke_reason']!=reason:
                raise _error('Another review already revoked this statement.','conflict')
            return _return({'memory':value,'replayed':True},config)
        if value['revision']!=expected_revision:raise _error('Statement changed. Refresh before revoking.','conflict')
        now=memory._timestamp(store.registry.clock())
        updated=validate_memory({**value,'status':'revoked','revision':1,'revoked_at':now,'revoked_by':actor,'revoke_reason':reason})
        response=_return({'memory':updated,'replayed':False},config)
        changed=store.db.execute("UPDATE pip_memory_statements SET status='revoked',revision=1,revoked_at=?,revoked_by=?,revoke_reason=? WHERE id=? AND pip_id=? AND revision=0 AND status='active'",(now,actor,reason,memory_id,pip_id))
        if changed.rowcount!=1:raise _error('Statement changed. Refresh before revoking.','conflict')
        store.registry.event(pip['workspace_id'],'pip_statement_revoked',pip_id=pip_id,
                             payload={'memory_id':memory_id,'actor':actor})
        return response


def history(store,pip_id,before_id=None,limit=20,*,config=None):
    _integer(limit,'Statement page size',1,20)
    if before_id is not None:_integer(before_id,'Statement cursor',1)
    with checkpoints._read(store):
        pip=_scope(store,pip_id); now=memory._timestamp(store.registry.clock())
        before=MAX_CURSOR+1 if before_id is None else before_id
        if before_id is not None and not store.db.execute('SELECT 1 FROM pip_memory_statements WHERE seq=? AND pip_id=? AND workspace_id=?',(before_id,pip_id,pip['workspace_id'])).fetchone():
            raise _error('The statement cursor belongs to another Pip.','invalid_cursor')
        rows=_bounded(store.db,'SELECT seq,id FROM pip_memory_statements WHERE pip_id=? AND workspace_id=? AND seq<? ORDER BY seq DESC LIMIT ?',
                      (pip_id,pip['workspace_id'],before,limit+1),{'seq':None,'id':64})
        page={'pip_id':pip_id,'workspace_id':pip['workspace_id'],'as_of':now,'entries':[],
              'counts':_counts(store,pip_id,now),'returned_records':0,'remaining_records':0,
              'next_before_id':None,'has_more':False,'page_reduced_for_budget':False}
        for row in rows[:limit]:
            value,_=_load(store,pip,row['id']); entry={'memory':value,'effective_status':_effective(value,now)}
            page['entries'].append(entry)
            try:_encoded(page,MAX_PAGE_BYTES-256)
            except RegistryError:
                page['entries'].pop(); page['page_reduced_for_budget']=True; break
        count=len(page['entries']); page['returned_records']=count
        if count:
            cursor=_integer(rows[count-1]['seq'],'Statement cursor',1)
            remaining=store.db.execute('SELECT count(*) FROM pip_memory_statements WHERE pip_id=? AND workspace_id=? AND seq<?',(pip_id,pip['workspace_id'],cursor)).fetchone()[0]
            _integer(remaining,'Remaining statement count',0,MAX_RECORDS)
            page.update(remaining_records=remaining,next_before_id=cursor if remaining else None,has_more=bool(remaining))
        elif rows:
            raise _error('A whole statement does not fit the page budget.','statement_limit')
        _encoded(page,MAX_PAGE_BYTES)
        return _return(page,config)
