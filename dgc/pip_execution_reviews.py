"""Durable user review of execution evidence. Recording a decision applies nothing."""
from __future__ import annotations

import hashlib
import json
import re

from .workspace_registry import RegistryError

SCHEMA = """
CREATE TABLE pip_execution_reviews (
 run_id TEXT NOT NULL REFERENCES pip_runs(id),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 100),
 result_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('open','accepted','dismissed')),
 actor TEXT NOT NULL,
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(run_id,revision)
);
CREATE TRIGGER immutable_pip_execution_review BEFORE UPDATE ON pip_execution_reviews
BEGIN SELECT RAISE(ABORT,'Execution review history is immutable'); END;
CREATE TRIGGER retained_pip_execution_review BEFORE DELETE ON pip_execution_reviews
BEGIN SELECT RAISE(ABORT,'Execution review history is retained'); END;
"""
MAX_RECORD_BYTES = 128 * 1024
MAX_REVIEWS = 100


def _text(value, label, limit):
    if (not isinstance(value, str) or not value.strip() or len(value) > limit
            or any(ord(c) < 32 and c not in '\n\t' or ord(c) == 127 for c in value)):
        raise RegistryError('invalid_execution_review', f'{label} must be nonempty bounded text.')
    try:
        if len(value.encode('utf-8')) > limit:
            raise ValueError
    except (ValueError, UnicodeError):
        raise RegistryError('invalid_execution_review', f'{label} exceeds its byte limit.') from None
    return value.strip()


def _evidence(store, run_id):
    _text(run_id, 'Run identity', 128)
    row = store.db.execute('''SELECT id,pip_id,workspace_id,status,manifest,result FROM pip_runs
       WHERE id=? AND length(CAST(manifest AS BLOB))<=? AND
       (result IS NULL OR length(CAST(result AS BLOB))<=?)''',
       (run_id, MAX_RECORD_BYTES, MAX_RECORD_BYTES)).fetchone()
    if row is None:
        raise RegistryError('not_found', 'The run is unavailable or exceeds the evidence review budget.')
    try:
        manifest = json.loads(row['manifest'])
        if not isinstance(manifest, dict):
            raise ValueError('Malformed manifest')
        from .pip_pulse_results import stored as pulse_stored
        from types import SimpleNamespace
        if pulse_stored(SimpleNamespace(db=store.db), row['workspace_id'], run_id) is not None:
            return None
        if row['status'] != 'succeeded' or manifest.get('run_kind') not in ('patch', 'test'):
            return None
        from .pip_handoffs import validate_manifest, validate_result_input
        from .pip_execution import validate_execution_result
        handoff = validate_manifest(manifest.get('handoff'), manifest)
        if (manifest.get('pip_id') != row['pip_id'] or manifest.get('workspace_id') != row['workspace_id']
                or handoff['run_id'] != row['id'] or handoff['payload']['workspace_id'] != row['workspace_id']
                or handoff['payload']['target']['pip_id'] != row['pip_id']):
            raise ValueError('Execution identity mismatch')
        result = validate_execution_result(json.loads(row['result']), handoff['payload']['action'])
        validate_result_input(result, manifest)
        digest = hashlib.sha256(json.dumps(result, sort_keys=True, ensure_ascii=False,
                separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()
    except (ValueError, TypeError, KeyError, RecursionError) as exc:
        raise RegistryError('invalid_execution_review', 'The run has no valid execution evidence to review.') from exc
    return row, digest


def _latest(store, run_id, digest):
    row = store.db.execute('''SELECT revision,
       CASE WHEN length(CAST(result_digest AS BLOB))=64 THEN result_digest END AS result_digest,
       CASE WHEN length(CAST(status AS BLOB))<=12 THEN status END AS status,
       CASE WHEN length(CAST(actor AS BLOB))<=128 THEN actor END AS actor,
       CASE WHEN length(CAST(reason AS BLOB))<=2000 THEN reason END AS reason,
       CASE WHEN length(CAST(created_at AS BLOB))<=40 THEN created_at END AS created_at
       FROM pip_execution_reviews WHERE run_id=? ORDER BY revision DESC LIMIT 1''', (run_id,)).fetchone()
    if row is None:
        return {'run_id': run_id, 'status': 'open', 'revision': 0, 'result_digest': digest,
                'actor': None, 'reason': '', 'updated_at': None}
    if (type(row['revision']) is not int or not 1 <= row['revision'] <= MAX_REVIEWS
            or row['status'] not in ('open', 'accepted', 'dismissed')
            or not isinstance(row['result_digest'], str) or not re.fullmatch(r'[0-9a-f]{64}', row['result_digest'])
            or not isinstance(row['created_at'], str) or not re.fullmatch(r'[0-9TZ:.+\-]{20,40}', row['created_at'])):
        raise RegistryError('invalid_execution_review', 'The saved execution review is invalid.')
    _text(row['actor'], 'Saved actor', 128)
    _text(row['reason'], 'Saved reason', 2000)
    if row['result_digest'] != digest:
        raise RegistryError('conflict', 'Execution evidence changed after its review. The previous decision cannot be reused.')
    return {'run_id': run_id, 'status': row['status'], 'revision': row['revision'],
            'result_digest': row['result_digest'], 'actor': row['actor'],
            'reason': row['reason'], 'updated_at': row['created_at']}


def for_run(store, run_id):
    evidence = _evidence(store, run_id)
    return None if evidence is None else _latest(store, run_id, evidence[1])


def accepted_patch_input(store, run_id):
    """Bounded authoritative source for a separately reviewed Pulse handoff."""
    evidence = _evidence(store, run_id)
    if evidence is None:
        raise RegistryError("source_unavailable", "Choose a completed Patch result with an accepted outcome review.")
    row, digest = evidence
    review_value = _latest(store, run_id, digest)
    manifest = json.loads(row["manifest"])
    if (manifest.get("run_kind") != "patch" or manifest.get("pip_type") != "patch"
            or review_value["status"] != "accepted" or review_value["revision"] < 1):
        raise RegistryError("source_unavailable", "Only an explicitly accepted Patch result can be handed to Pulse.")
    from .pip_execution import validate_execution_result
    result = validate_execution_result(json.loads(row["result"]), manifest["handoff"]["payload"]["action"])
    return {"manifest": manifest, "result": result, "review": review_value}


def review(store, run_id, status, expected_revision, actor, reason):
    """Record only a user assessment; no queue, model, file or permission mutation."""
    if not isinstance(status, str) or status not in ('open', 'accepted', 'dismissed'):
        raise RegistryError('invalid_execution_review', 'Choose open, accepted or dismissed for the result review.')
    if type(expected_revision) is not int or not 0 <= expected_revision < MAX_REVIEWS:
        raise RegistryError('invalid_execution_review', 'Use the current result review revision below 100.')
    actor = _text(actor, 'Reviewing actor', 128)
    reason = _text(reason, 'Review reason', 2000)
    with store.registry.transaction():
        evidence = _evidence(store, run_id)
        if evidence is None:
            raise RegistryError('invalid_execution_review', 'Only completed Patch/Pulse execution evidence can be reviewed.')
        row, digest = evidence
        current = _latest(store, run_id, digest)
        if current['revision'] != expected_revision:
            raise RegistryError('conflict', 'The execution result review changed. Reload its current decision before reviewing again.')
        now = store.registry.clock()
        store.db.execute('INSERT INTO pip_execution_reviews VALUES(?,?,?,?,?,?,?)',
                         (run_id, expected_revision + 1, digest, status, actor, reason, now))
        store.registry.event(row['workspace_id'], 'pip_execution_reviewed', pip_id=row['pip_id'], run_id=run_id,
                             payload={'status': status, 'revision': expected_revision + 1, 'actor': actor,
                                      'result_digest': digest, 'effect': 'review_only'})
        return _latest(store, run_id, digest)
