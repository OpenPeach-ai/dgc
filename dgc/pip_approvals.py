"""Durable, one-use human reviews of exact definitions, including Pulse plans."""
from __future__ import annotations

import contextlib
import hashlib
import json
from datetime import datetime, timedelta, timezone

from .workspace_registry import RegistryError, identifier

SCHEMA = """
CREATE TABLE pip_approvals(
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL UNIQUE REFERENCES pip_proposals(id),
    pip_id TEXT NOT NULL REFERENCES pips(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    expected_version INTEGER NOT NULL,
    action_type TEXT NOT NULL CHECK(action_type IN ('job_update','schedule_update')),
    action_summary TEXT NOT NULL, definition_digest TEXT NOT NULL,
    requested_by TEXT NOT NULL, session_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','superseded')),
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    resolved_by TEXT, resolved_at TEXT);
CREATE INDEX pip_approval_history ON pip_approvals(pip_id,created_at,id);
CREATE TABLE pip_proposal_origins(
    session_id TEXT NOT NULL, request_key TEXT NOT NULL, request_digest TEXT NOT NULL,
    proposal_id TEXT NOT NULL UNIQUE REFERENCES pip_proposals(id),
    PRIMARY KEY(session_id,request_key));
CREATE TABLE pip_schedule_state(
    pip_id TEXT PRIMARY KEY REFERENCES pips(id),job_version INTEGER NOT NULL,
    anchor_at TEXT NOT NULL,next_due_at TEXT NOT NULL,last_due_at TEXT,last_checked_at TEXT,
    FOREIGN KEY(pip_id,job_version) REFERENCES pip_versions(pip_id,version));
CREATE INDEX pip_schedule_due ON pip_schedule_state(next_due_at,pip_id);
CREATE TRIGGER immutable_pip_approval
    BEFORE UPDATE OF id,proposal_id,pip_id,workspace_id,expected_version,action_type,
        action_summary,definition_digest,requested_by,session_id,created_at,expires_at
    ON pip_approvals BEGIN SELECT RAISE(ABORT,'immutable approval request'); END;
CREATE TRIGGER one_way_pip_approval
    BEFORE UPDATE OF status,resolved_by,resolved_at ON pip_approvals
    WHEN OLD.status!='pending' OR NEW.status='pending' OR NEW.resolved_at IS NULL OR NEW.resolved_by IS NULL
    BEGIN SELECT RAISE(ABORT,'approval can only be resolved once'); END;
CREATE TRIGGER immutable_proposal_origin
    BEFORE UPDATE ON pip_proposal_origins BEGIN SELECT RAISE(ABORT,'immutable proposal origin'); END;
CREATE TRIGGER immutable_pip_proposal
    BEFORE UPDATE OF id,pip_id,expected_version,definition,actor,reason,created_at
    ON pip_proposals BEGIN SELECT RAISE(ABORT,'immutable saved proposal'); END;
"""


def digest(definition):
    return hashlib.sha256(json.dumps(definition, sort_keys=True, separators=(",", ":"),
                                    ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def expires_at(now):
    return (datetime.fromisoformat(now.replace('Z', '+00:00')).astimezone(timezone.utc)
            + timedelta(days=7)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def create(registry, proposal, workspace_id, *, session_id=None, schedule_changed=False, event_changed=False):
    """Called only inside the same transaction that saves the immutable proposal."""
    approval_id = identifier('approval')
    definition = json.loads(proposal['definition'])
    registry.db.execute('''INSERT INTO pip_approvals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (approval_id, proposal['id'], proposal['pip_id'], workspace_id, proposal['expected_version'],
         'schedule_update' if schedule_changed else 'job_update',
         ('Create ' if proposal['expected_version'] == 0 else 'Change event trigger for ' if event_changed else 'Change schedule for ' if schedule_changed else 'Update ') + definition['name'],
         digest(definition), proposal['actor'], session_id, 'pending', proposal['created_at'],
         expires_at(proposal['created_at']), None, None))
    return approval_id


def migrate(registry):
    """Backfill legacy proposals without inventing an approving identity or time."""
    for row in registry.db.execute('SELECT q.*,p.workspace_id FROM pip_proposals q JOIN pips p ON p.id=q.pip_id').fetchall():
        approval_id = create(registry, row, row['workspace_id'])
        status = {'accepted': 'approved', 'rejected': 'rejected', 'superseded': 'superseded'}.get(row['status'])
        if status:
            # Historic resolver was not retained; explicitly mark unknown provenance.
            registry.db.execute('UPDATE pip_approvals SET status=?,resolved_by=?,resolved_at=? WHERE id=?',
                                (status, 'legacy-unrecorded', 'unrecorded', approval_id))


def expire_pending(registry, pip_id, *, now=None):
    now = now if now is not None else registry.clock()
    # Most refreshes have nothing to expire. Finish this read before acquiring
    # any write lock, then re-read under the lock if expiry is actually due.
    if registry.db.execute("SELECT 1 FROM pip_approvals WHERE pip_id=? AND status='pending' AND expires_at<=? LIMIT 1",
                           (pip_id, now)).fetchone() is None:
        return
    own = not registry.db.in_transaction
    with registry.transaction() if own else contextlib.nullcontext():
        rows = registry.db.execute("SELECT * FROM pip_approvals WHERE pip_id=? AND status='pending' AND expires_at<=?", (pip_id, now)).fetchall()
        for row in rows:
            resolve(registry, row, 'expired', 'expiry', now)
            registry.db.execute("UPDATE pip_proposals SET status='expired' WHERE id=? AND status='proposed'", (row['proposal_id'],))


def resolve(registry, approval, status, actor, now):
    changed = registry.db.execute("UPDATE pip_approvals SET status=?,resolved_by=?,resolved_at=? WHERE id=? AND status='pending'",
                                  (status, actor, now, approval['id'])).rowcount
    if changed != 1:
        raise RegistryError('conflict', 'This review has already been resolved. Refresh the Pip.')
    registry.event(approval['workspace_id'], 'pip_approval_' + status, pip_id=approval['pip_id'],
                   payload={'approval_id': approval['id'], 'proposal_id': approval['proposal_id'], 'actor': actor})


def history(registry, pip_id, before_id=None, limit=20):
    if type(limit) is not int or not 1 <= limit <= 20:
        raise RegistryError('invalid_request', 'Approval history limit must be between 1 and 20.')
    expire_pending(registry, pip_id)
    params = [pip_id]
    where = 'pip_id=?'
    if before_id is not None:
        if not isinstance(before_id, str) or len(before_id) > 128:
            raise RegistryError('invalid_cursor', 'Use the approval cursor from the previous page.')
        prior = registry.db.execute('SELECT created_at,id FROM pip_approvals WHERE pip_id=? AND id=?', (pip_id, before_id)).fetchone()
        if not prior:
            raise RegistryError('invalid_cursor', 'Approval cursor does not belong to this Pip.')
        where += ' AND (created_at,id)<(?,?)'
        params.extend(prior)
    rows = registry.db.execute('SELECT * FROM pip_approvals WHERE ' + where + ' ORDER BY created_at DESC,id DESC LIMIT ?', (*params, limit + 1)).fetchall()
    result = [dict(row) for row in rows[:limit]]
    for row in result:
        row.pop('session_id', None)  # Session correlation stays local and private.
        row.pop('definition_digest', None)
    return {'approvals': result, 'next_before_id': result[-1]['id'] if len(rows) > limit else None}
