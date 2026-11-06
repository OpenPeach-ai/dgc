"""Durable, bounded user interjections for a running Pip conversation.

The worker reads only a small, controller-written inbox in its private run folder.
It never opens the Pips registry or receives another Pip's messages.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from .workspace_registry import RegistryError, identifier

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_chat_steers (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 pip_id TEXT NOT NULL REFERENCES pips(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 run_id TEXT NOT NULL REFERENCES pip_runs(id),
 text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<=8192),
 request_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 requested_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','applied','missed')),
 UNIQUE(pip_id,request_key)
);
CREATE INDEX IF NOT EXISTS pip_chat_steers_run ON pip_chat_steers(run_id,seq);
"""
MAX_PER_RUN = 8


def send(store, pip, run, req, actor):
    """Save an interjection against the one active conversation, idempotently."""
    if req.get('images') or req.get('files'):
        raise RegistryError('steer_attachments', 'Send photos or files after this Pip finishes its reply. Mid-turn updates are text only.')
    if run['status'] == 'cancelling':
        raise RegistryError('conversation_busy', 'This Pip is stopping. Send after it stops.')
    with store.registry.transaction():
        prior = store.db.execute('SELECT * FROM pip_chat_steers WHERE pip_id=? AND request_key=?',
                                 (pip['id'], req['request_key'])).fetchone()
        if prior:
            if prior['request_digest'] != req['digest'] or prior['requested_by'] != actor:
                raise RegistryError('conflict', 'This message key was already used for different words or by another device.')
            return {'run': store.run(prior['run_id']), 'message': message(prior, store.run(prior['run_id'])['status'])}
        if store.db.execute('SELECT count(*) FROM pip_chat_steers WHERE run_id=?', (run['id'],)).fetchone()[0] >= MAX_PER_RUN:
            raise RegistryError('steer_limit', 'This Pip has eight mid-turn updates. Wait for its reply before sending another.')
        if store.db.execute("SELECT 1 FROM pip_chat_messages WHERE pip_id=? AND request_key=?", (pip['id'], req['request_key'])).fetchone():
            raise RegistryError('conflict', 'This message key already belongs to an earlier Pip message.')
        # Recheck under the write lock: the run may have finished while the editor sent the request.
        live = store.db.execute('SELECT status FROM pip_runs WHERE id=?', (run['id'],)).fetchone()
        if live is None or live['status'] not in ('queued', 'running'):
            raise RegistryError('conversation_changed', 'The Pip finished that reply. Send the message again as a new turn.')
        stamp = store.registry.clock()
        message_id = identifier('message')
        store.db.execute('INSERT INTO pip_chat_steers(id,pip_id,workspace_id,run_id,text,request_key,request_digest,requested_by,created_at,status) '
                         'VALUES(?,?,?,?,?,?,?,?,?,?)',
                         (message_id, pip['id'], pip['workspace_id'], run['id'], req['text'], req['request_key'], req['digest'], actor, stamp, 'pending'))
        row = store.db.execute('SELECT * FROM pip_chat_steers WHERE id=?', (message_id,)).fetchone()
        from .pip_chat import save_mentions
        save_mentions(store.db, pip['id'], message_id, req.get('display_mentions'))
    said = message(row, live['status'])
    if req.get('display_mentions'):
        said['display_mentions'] = req['display_mentions']
    return {'run': store.run(run['id']), 'message': said}


def message(row, run_status):
    status = ('failed' if row['status'] == 'missed' else
              'queued' if row['status'] == 'pending' and run_status in ('queued', 'running') else
              run_status if row['status'] == 'applied' else 'failed')
    item = {key: row[key] for key in ('id', 'pip_id', 'workspace_id', 'run_id', 'text', 'created_at')}
    item.update(role='user', model='', status=status, steered=True,
                steer_status=row['status'])
    if row['status'] == 'missed':
        item['error'] = 'The Pip finished before it could read this. Send it again.'
    return item


def in_run(db, run_id):
    return db.execute('SELECT * FROM pip_chat_steers WHERE run_id=? ORDER BY seq', (run_id,)).fetchall()


def applied_text(db, run_id):
    return [row['text'] for row in in_run(db, run_id) if row['status'] == 'applied']


def stage(db, run_id, folder: Path):
    """Publish the run's pending messages atomically; the worker sees only its own bounded inbox."""
    rows = db.execute("SELECT id,text FROM pip_chat_steers WHERE run_id=? AND status='pending' ORDER BY seq", (run_id,)).fetchall()
    path = folder / 'steering.json'
    encoded = json.dumps([{'id': row['id'], 'text': row['text']} for row in rows], ensure_ascii=False).encode()
    if len(encoded) > 70_000:
        raise RegistryError('steer_limit', 'The Pip steering inbox exceeded its size limit.')
    temporary = folder / 'steering.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(encoded)
    os.replace(temporary, path)


def read_worker(folder: Path, seen: set[str]):
    try:
        raw = (folder / 'steering.json').read_bytes()
    except FileNotFoundError:
        return []
    if len(raw) > 70_000:
        return []
    try:
        items = json.loads(raw)
    except (ValueError, UnicodeError):
        return []
    if not isinstance(items, list) or len(items) > MAX_PER_RUN:
        return []
    return [item for item in items if isinstance(item, dict) and set(item) == {'id', 'text'}
            and isinstance(item['id'], str) and item['id'].startswith('message_')
            and isinstance(item['text'], str) and len(item['text'].encode()) <= 8192
            and item['id'] not in seen]


def applied(store, run_id, ids):
    if not isinstance(ids, list) or len(ids) > MAX_PER_RUN or any(not isinstance(i, str) or not i.startswith('message_') for i in ids):
        raise RegistryError('invalid_steer', 'The Pip worker reported invalid steering identities.')
    with store.registry.transaction():
        for message_id in ids:
            store.db.execute("UPDATE pip_chat_steers SET status='applied' WHERE id=? AND run_id=? AND status='pending'",
                             (message_id, run_id))


def miss_pending(store, run_id):
    with store.registry.transaction():
        store.db.execute("UPDATE pip_chat_steers SET status='missed' WHERE run_id=? AND status='pending'", (run_id,))
