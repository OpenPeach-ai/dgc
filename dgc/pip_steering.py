"""Durable, bounded user interjections for a running Pip conversation.

The worker reads only a small, controller-written inbox in its private run folder.
It never opens the Pips registry or receives another Pip's messages.

A message the running reply never read is still the user's message, and what becomes of it is what Work does with
steering a turn did not take (headless._finish_steering):
- the reply finished: it waits (`pending` on a succeeded run) and becomes the Pip's next turn, in the order it was sent,
  one turn each;
- the user stopped the reply: it is not sent, and neither is anything waiting behind it (`missed`), to send again;
- the reply failed, timed out or the runner restarted: not sent either (`missed`); what was already waiting from an
  earlier reply still gets its turn, as Work's queue carries on after a failed turn.
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
# Messages waiting for a turn of their own: the reply they joined finished without reading them.
WAITING = ("SELECT s.* FROM pip_chat_steers s JOIN pip_runs r ON r.id=s.run_id "
           "WHERE s.pip_id=? AND s.status='pending' AND r.status='succeeded'")


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
        # Recheck under the write lock: the run may have finished while the editor sent the request.
        live = store.db.execute('SELECT status FROM pip_runs WHERE id=?', (run['id'],)).fetchone()
        if live is None or live['status'] not in ('queued', 'running'):
            raise RegistryError('conversation_changed', 'The Pip finished that reply. Send the message again as a new turn.')
        row = _insert(store, pip, run['id'], req, actor)
    return {'run': store.run(run['id']), 'message': message(row, live['status'])}


def _insert(store, pip, run_id, req, actor):
    if store.db.execute('SELECT count(*) FROM pip_chat_steers WHERE run_id=?', (run_id,)).fetchone()[0] >= MAX_PER_RUN:
        raise RegistryError('steer_limit', 'This Pip has eight mid-turn updates. Wait for its reply before sending another.')
    if store.db.execute("SELECT 1 FROM pip_chat_messages WHERE pip_id=? AND request_key=?", (pip['id'], req['request_key'])).fetchone():
        raise RegistryError('conflict', 'This message key already belongs to an earlier Pip message.')
    message_id = identifier('message')
    store.db.execute('INSERT INTO pip_chat_steers(id,pip_id,workspace_id,run_id,text,request_key,request_digest,requested_by,created_at,status) '
                     'VALUES(?,?,?,?,?,?,?,?,?,?)',
                     (message_id, pip['id'], pip['workspace_id'], run_id, req['text'], req['request_key'], req['digest'], actor,
                      store.registry.clock(), 'pending'))
    return store.db.execute('SELECT * FROM pip_chat_steers WHERE id=?', (message_id,)).fetchone()


def wait_behind(store, pip, req, actor):
    """Send with no reply running yet while earlier messages wait for theirs (their run has just closed): this one goes
    behind them, never ahead. None when nothing is waiting any more, or it brings photos or files, which only a turn of
    its own can take."""
    if req.get('images') or req.get('files') or not waiting(store.db, pip['id']):
        return None
    with store.registry.transaction():
        ahead = store.db.execute(WAITING + ' ORDER BY s.seq DESC LIMIT 1', (pip['id'],)).fetchone()
        if ahead is None:
            return None
        row = _insert(store, pip, ahead['run_id'], req, actor)
    return {'run': store.run(row['run_id']), 'message': message(row, 'succeeded')}


# The line under a message that wasn't sent ("Not sent · ...").
NOT_SENT = {'cancelled': 'Stopped before the Pip read this.', 'failed': 'The reply ended before the Pip read this.'}


def message(row, run_status):
    # A reply that failed or was stopped has no later turn for what it hadn't read, settled yet or not.
    unsent = row['status'] == 'missed' or (row['status'] == 'pending' and run_status in ('failed', 'cancelled'))
    status = ('failed' if unsent else
              run_status if row['status'] == 'applied' else
              'cancelling' if run_status == 'cancelling' else 'queued')
    item = {key: row[key] for key in ('id', 'pip_id', 'workspace_id', 'run_id', 'text', 'created_at')}
    item.update(role='user', model='', status=status, steered=True,
                steer_status='missed' if unsent else row['status'])
    if unsent:
        item['error'] = NOT_SENT.get(run_status, "The Pip couldn't start a reply to this.")
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


def waiting(db, pip_id):
    return db.execute(WAITING + ' ORDER BY s.seq', (pip_id,)).fetchall()


def stopped(db, pip_id, run_id):
    """Stop stops the queue too: what the reply hadn't read and everything waiting behind it comes back unsent, shown
    beside the reply that was stopped."""
    db.execute("UPDATE pip_chat_steers SET status='missed',run_id=? WHERE status='pending' AND (run_id=? OR id IN "
               "(SELECT s.id FROM pip_chat_steers s JOIN pip_runs r ON r.id=s.run_id "
               "WHERE s.pip_id=? AND s.status='pending' AND r.status='succeeded'))", (run_id, run_id, pip_id))


def advance(store, pip_id, config):
    """The oldest waiting message becomes the Pip's next turn, once nothing else is answering. A message that can't
    (the Pip was archived, the queue is full) says it wasn't sent; it is never left waiting for nothing."""
    from .pip_chat import answer_waiting
    while True:
        rows = waiting(store.db, pip_id)
        if not rows:
            return
        if store.db.execute("SELECT 1 FROM pip_runs r JOIN pip_chat_messages m ON m.run_id=r.id WHERE m.pip_id=? AND "
                            "m.role='user' AND r.status IN ('queued','running','cancelling') LIMIT 1", (pip_id,)).fetchone():
            return                                  # that reply's end brings this back
        try:
            answer_waiting(store, rows[0], config)
            return
        except RegistryError as exc:
            if exc.code == 'conversation_busy':
                return                              # another turn got in first; its end does the same
            if exc.code == 'runner_stopped':
                return                              # Pips are stopped: the runner's next start answers it
        except Exception:                           # noqa: BLE001 -- the words are kept and shown, whatever went wrong
            pass
        if store.db.in_transaction:
            store.db.rollback()
        with store.registry.transaction():
            store.db.execute("UPDATE pip_chat_steers SET status='missed' WHERE id=? AND status='pending'", (rows[0]['id'],))


def settle(store, run_id, config):
    """What becomes of what a chat reply hadn't read, when it has ended: see the top of this file."""
    row = store.db.execute('SELECT pip_id,status FROM pip_runs WHERE id=?', (run_id,)).fetchone()
    if row is None:
        return
    if row['status'] == 'cancelled':
        with store.registry.transaction():
            stopped(store.db, row['pip_id'], run_id)
        return
    if row['status'] == 'failed':
        miss_pending(store, run_id)
    advance(store, row['pip_id'], config)


def recover(store, config):
    """After the runner restarts: a reply it lost hadn't read these, so they weren't sent; messages already waiting for
    a turn (it stopped right after their reply finished) still get it."""
    with store.registry.transaction():
        store.db.execute("UPDATE pip_chat_steers SET status='missed' WHERE status='pending' AND run_id IN "
                         "(SELECT id FROM pip_runs WHERE status IN ('failed','cancelled'))")
    for pip in store.db.execute("SELECT DISTINCT s.pip_id FROM pip_chat_steers s JOIN pip_runs r ON r.id=s.run_id "
                                "WHERE s.status='pending' AND r.status='succeeded'").fetchall():
        advance(store, pip['pip_id'], config)


def forget_resent(store, pip_id, req, actor):
    """A message sent again in the same words is that message now, so its "Not sent" goes."""
    match = "pip_id=? AND status='missed' AND text=? AND requested_by=? AND request_key<>?"
    values = (pip_id, req['text'], actor, req['request_key'])
    if store.db.execute("SELECT 1 FROM pip_chat_steers WHERE " + match + " LIMIT 1", values).fetchone():
        with store.registry.transaction():
            store.db.execute("DELETE FROM pip_chat_steers WHERE " + match, values)
