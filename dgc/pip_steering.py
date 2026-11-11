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

# A message that joins a running reply is a message like any other: up to 256 KB (Limits for everyone, 10 Nov; it was
# 8 KiB). widen() moves an older registry's table to this bound, every row kept.
MAX_TEXT_BYTES = 256 * 1024
SCHEMA = f"""
CREATE TABLE IF NOT EXISTS pip_chat_steers (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 pip_id TEXT NOT NULL REFERENCES pips(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 run_id TEXT NOT NULL REFERENCES pip_runs(id),
 text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<={MAX_TEXT_BYTES}),
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
# The photos and files a message brought while a reply ran (Pips API 84): what they are (digest, type, size, a file's
# name), beside the message, as its @ marks and its quote are. The bytes are kept where every message's are
# (pip_chat.store_images, store_files), under the same limits and checks. When the message becomes a turn of its own
# they move to that message's rows (pip_chat.insert_user). Made the first time a message brings any.
ATTACHMENTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_chat_steer_attachments (
 message_id TEXT PRIMARY KEY,
 pip_id TEXT NOT NULL REFERENCES pips(id),
 images TEXT NOT NULL CHECK(length(CAST(images AS BLOB)) BETWEEN 2 AND 131072),
 files TEXT NOT NULL CHECK(length(CAST(files AS BLOB)) BETWEEN 2 AND 131072)
);
"""
# What one message's photos and files add to the inbox: their digests, names and kept paths, never their bytes.
MAX_ATTACHMENT_NOTE_BYTES = 512 * 1024
# The worker's inbox holds every update a reply has not read yet: eight at most, each escaped at worst six bytes a byte.
MAX_INBOX_BYTES = MAX_PER_RUN * (6 * MAX_TEXT_BYTES + 256 + MAX_ATTACHMENT_NOTE_BYTES) + 2
# Messages waiting for a turn of their own: the reply they joined finished without reading them. Each conversation of a
# Pip has its own queue (pip_conversations): a steer belongs to the conversation of the reply it joined.
WAITING = ("SELECT s.* FROM pip_chat_steers s JOIN pip_runs r ON r.id=s.run_id "
           "WHERE s.pip_id=? AND s.status='pending' AND r.status='succeeded'")
_IN_CONVERSATION = " AND s.conversation_id IS ?"


def conversation_of(db, run_id):
    """The conversation a chat reply is in: its user message says which."""
    row = db.execute("SELECT conversation_id FROM pip_chat_messages WHERE run_id=? AND role='user'", (run_id,)).fetchone()
    return row[0] if row else None


def _kept_attachments(db) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_chat_steer_attachments'").fetchone() is not None


def save_attachments(db, pip_id, message_id, images, files) -> None:
    if images or files:
        db.execute(ATTACHMENTS_SCHEMA)
        db.execute("INSERT OR REPLACE INTO pip_chat_steer_attachments VALUES(?,?,?,?)",
                   (message_id, pip_id, json.dumps(images or []), json.dumps(files or [], ensure_ascii=False)))


def attachments(db, message_id):
    """(images, files) a message sent while a reply ran brought, as pip_chat keeps them ({sha256, mime, bytes} and
    {name, sha256, bytes}); two empty lists for none, for a row that doesn't read as that, or a registry from before."""
    if not _kept_attachments(db):
        return [], []
    row = db.execute("SELECT images,files FROM pip_chat_steer_attachments WHERE message_id=?", (message_id,)).fetchone()
    if row is None:
        return [], []
    from .pip_chat import validate_files, validate_images
    try:
        images, files = json.loads(row[0]), json.loads(row[1])
        return (validate_images(images) if images else []), (validate_files(files) if files else [])
    except (ValueError, RegistryError):
        return [], []


def drop_attachments(db, message_id) -> None:
    if _kept_attachments(db):
        db.execute("DELETE FROM pip_chat_steer_attachments WHERE message_id=?", (message_id,))


def shown(db, message_id, item):
    """``item`` (a message row for the chat) with what it brought, as a message of its own lists them: `images`
    [{index, mime, bytes}] and `files` [{index, name, bytes}], each only when it has any."""
    images, files = attachments(db, message_id)
    if images:
        item['images'] = [{'index': i, 'mime': image['mime'], 'bytes': image['bytes']} for i, image in enumerate(images)]
    if files:
        item['files'] = [{'index': i, 'name': file['name'], 'bytes': file['bytes']} for i, file in enumerate(files)]
    return item


def send(store, pip, run, req, actor):
    """Save an interjection against the one active conversation, idempotently. From API 84 it may bring photos and
    files (already checked and kept by pip_chat.send): the reply reads them with it when its model can take them
    there, and otherwise they are the Pip's next turn, as words it didn't read are."""
    if run['status'] == 'cancelling':
        raise RegistryError('conversation_busy', 'This Pip is stopping. Send after it stops.')
    with store.registry.transaction():
        prior = store.db.execute('SELECT * FROM pip_chat_steers WHERE pip_id=? AND request_key=?',
                                 (pip['id'], req['request_key'])).fetchone()
        if prior:
            if prior['request_digest'] != req['digest'] or prior['requested_by'] != actor:
                raise RegistryError('conflict', 'This message key was already used for different words or by another device.')
            return {'run': store.run(prior['run_id']), 'message': _said(store, prior, store.run(prior['run_id'])['status'])}
        # Recheck under the write lock: the run may have finished while the editor sent the request.
        live = store.db.execute('SELECT status FROM pip_runs WHERE id=?', (run['id'],)).fetchone()
        if live is None or live['status'] not in ('queued', 'running'):
            raise RegistryError('conversation_changed', 'The Pip finished that reply. Send the message again as a new turn.')
        row = _insert(store, pip, run['id'], req, actor)
    return {'run': store.run(run['id']), 'message': _said(store, row, live['status'])}


def _insert(store, pip, run_id, req, actor):
    if store.db.execute('SELECT count(*) FROM pip_chat_steers WHERE run_id=?', (run_id,)).fetchone()[0] >= MAX_PER_RUN:
        raise RegistryError('steer_limit', 'This Pip has eight mid-turn updates. Wait for its reply before sending another.')
    if store.db.execute("SELECT 1 FROM pip_chat_messages WHERE pip_id=? AND request_key=?", (pip['id'], req['request_key'])).fetchone():
        raise RegistryError('conflict', 'This message key already belongs to an earlier Pip message.')
    message_id = identifier('message')
    store.db.execute('INSERT INTO pip_chat_steers(id,pip_id,workspace_id,run_id,text,request_key,request_digest,requested_by,created_at,status,'
                     'conversation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                     (message_id, pip['id'], pip['workspace_id'], run_id, req['text'], req['request_key'], req['digest'], actor,
                      store.registry.clock(), 'pending', conversation_of(store.db, run_id)))
    from .pip_chat import save_mentions
    save_mentions(store.db, pip['id'], message_id, req.get('display_mentions'))
    from .pip_replies import save as save_reply
    save_reply(store.db, pip['id'], message_id, req.get('reply_to'))
    save_attachments(store.db, pip['id'], message_id, req.get('images'), req.get('files'))
    return store.db.execute('SELECT * FROM pip_chat_steers WHERE id=?', (message_id,)).fetchone()


def _said(store, row, run_status):
    from .pip_chat import message_mentions
    said = message(row, run_status)
    marks = message_mentions(store.db, row['id'])
    if marks:
        said['display_mentions'] = marks
    from .pip_replies import of as quote_of
    quote = quote_of(store.db, row['id'])
    if quote:
        said['reply_to'] = quote
    return shown(store.db, row['id'], said)


def wait_behind(store, pip, req, actor):
    """Send with no reply running yet while earlier messages wait for theirs (their run has just closed): this one goes
    behind them, never ahead, with any photos and files it brings (API 84). None when nothing is waiting any more."""
    conversation_id = req.get('conversation_id')
    if not waiting(store.db, pip['id'], conversation_id):
        return None
    with store.registry.transaction():
        ahead = store.db.execute(WAITING + _IN_CONVERSATION + ' ORDER BY s.seq DESC LIMIT 1',
                                 (pip['id'], conversation_id)).fetchone()
        if ahead is None:
            return None
        row = _insert(store, pip, ahead['run_id'], req, actor)
    return {'run': store.run(row['run_id']), 'message': _said(store, row, 'succeeded')}


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


def stage(db, run_id, folder: Path, directory=None):
    """Publish the run's pending messages atomically; the worker sees only its own bounded inbox.

    A message that brought photos or files (API 84) names each by what it is and where it is kept (``directory``, the
    registry's): the worker reads the kept file itself and checks it against its digest, as it does a turn's own. One
    whose kept file is gone, or with no ``directory`` to find them in, is not published: it waits for a turn of its
    own, which says what is missing."""
    rows = db.execute("SELECT id,pip_id,text FROM pip_chat_steers WHERE run_id=? AND status='pending' ORDER BY seq", (run_id,)).fetchall()
    path = folder / 'steering.json'
    # One that quotes a message of the Pip's (Reply, pip_replies) is read with that quote, marked as one.
    from .pip_replies import of as quote_of, quoted
    items = []
    for row in rows:
        item = {'id': row['id'], 'text': quoted(row['text'], quote_of(db, row['id']), MAX_TEXT_BYTES)}
        images, files = attachments(db, row['id'])
        if images or files:
            if directory is None:
                continue
            from .pip_chat import file_paths, image_paths
            try:
                if images:
                    item['images'] = [{**image, 'path': str(kept)} for image, kept in zip(images, image_paths(directory, row['pip_id'], images))]
                if files:
                    item['files'] = [{**file, 'path': str(kept)} for file, kept in zip(files, file_paths(directory, row['pip_id'], files))]
            except RegistryError:
                continue
            if len(json.dumps(item).encode()) - len(json.dumps(item['text']).encode()) > MAX_ATTACHMENT_NOTE_BYTES:
                continue
        items.append(item)
    encoded = json.dumps(items, ensure_ascii=False).encode()
    if len(encoded) > MAX_INBOX_BYTES:
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
    if len(raw) > MAX_INBOX_BYTES:
        return []
    try:
        items = json.loads(raw)
    except (ValueError, UnicodeError):
        return []
    if not isinstance(items, list) or len(items) > MAX_PER_RUN:
        return []
    return [item for item in items if isinstance(item, dict) and {'id', 'text'} <= set(item) <= {'id', 'text', 'images', 'files'}
            and isinstance(item['id'], str) and item['id'].startswith('message_')
            and isinstance(item['text'], str) and len(item['text'].encode()) <= MAX_TEXT_BYTES
            and _named(item.get('images'), {'sha256', 'mime', 'bytes', 'path'})
            and _named(item.get('files'), {'name', 'sha256', 'bytes', 'path'})
            and item['id'] not in seen]


def _named(value, fields) -> bool:
    """A message's photos or files in the worker's inbox: none, or a short list of exactly these fields. What each
    says is checked where it is read (pips: its digest, its size, where it is kept)."""
    return value is None or (isinstance(value, list) and 1 <= len(value) <= 64 and all(
        isinstance(item, dict) and set(item) == fields and isinstance(item['path'], str) and 0 < len(item['path']) <= 4096
        for item in value))


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


def waiting(db, pip_id, conversation_id=None):
    """What waits for a turn in one conversation (the first when none is named, as an older client means)."""
    if conversation_id is None:
        from .pip_conversations import first
        conversation_id = first(db, pip_id)
    return db.execute(WAITING + _IN_CONVERSATION + ' ORDER BY s.seq', (pip_id, conversation_id)).fetchall()


def stopped(db, pip_id, run_id):
    """Stop stops the queue too: what the reply hadn't read and everything waiting behind it comes back unsent, shown
    beside the reply that was stopped."""
    db.execute("UPDATE pip_chat_steers SET status='missed',run_id=? WHERE status='pending' AND (run_id=? OR id IN "
               "(SELECT s.id FROM pip_chat_steers s JOIN pip_runs r ON r.id=s.run_id "
               "WHERE s.pip_id=? AND s.status='pending' AND r.status='succeeded' AND s.conversation_id IS ?))",
               (run_id, run_id, pip_id, conversation_of(db, run_id)))


def advance(store, pip_id, config, conversation_id=None):
    """The oldest waiting message of a conversation becomes its next turn, once nothing else is answering in it. A
    message that can't (the Pip was archived, the queue is full) says it wasn't sent; it is never left waiting for
    nothing."""
    from .pip_chat import answer_waiting
    if conversation_id is None:
        from .pip_conversations import first
        conversation_id = first(store.db, pip_id)
    while True:
        rows = waiting(store.db, pip_id, conversation_id)
        if not rows:
            return
        if store.db.execute("SELECT 1 FROM pip_runs r JOIN pip_chat_messages m ON m.run_id=r.id WHERE m.pip_id=? AND "
                            "m.conversation_id IS ? AND m.role='user' AND r.status IN ('queued','running','cancelling') LIMIT 1",
                            (pip_id, conversation_id)).fetchone():
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
    advance(store, row['pip_id'], config, conversation_of(store.db, run_id))


def recover(store, config):
    """After the runner restarts: a reply it lost hadn't read these, so they weren't sent; messages already waiting for
    a turn (it stopped right after their reply finished) still get it."""
    with store.registry.transaction():
        store.db.execute("UPDATE pip_chat_steers SET status='missed' WHERE status='pending' AND run_id IN "
                         "(SELECT id FROM pip_runs WHERE status IN ('failed','cancelled'))")
    for pip in store.db.execute("SELECT DISTINCT s.pip_id,s.conversation_id FROM pip_chat_steers s JOIN pip_runs r ON r.id=s.run_id "
                                "WHERE s.status='pending' AND r.status='succeeded'").fetchall():
        advance(store, pip['pip_id'], config, pip['conversation_id'])


def forget_resent(store, pip_id, req, actor):
    """A message sent again in the same words is that message now, so its "Not sent" goes."""
    match = "pip_id=? AND status='missed' AND text=? AND requested_by=? AND request_key<>?"
    values = (pip_id, req['text'], actor, req['request_key'])
    if store.db.execute("SELECT 1 FROM pip_chat_steers WHERE " + match + " LIMIT 1", values).fetchone():
        with store.registry.transaction():
            if store.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_chat_mentions'").fetchone():
                store.db.execute("DELETE FROM pip_chat_mentions WHERE message_id IN "
                                 "(SELECT id FROM pip_chat_steers WHERE " + match + ")", values)
            from .pip_replies import forget as forget_replies
            forget_replies(store.db, match, values)
            if _kept_attachments(store.db):
                store.db.execute("DELETE FROM pip_chat_steer_attachments WHERE message_id IN "
                                 "(SELECT id FROM pip_chat_steers WHERE " + match + ")", values)
            store.db.execute("DELETE FROM pip_chat_steers WHERE " + match, values)


def widen(db) -> None:
    """An older registry's table took 8 KiB a message: rebuilt with the 256 KB bound, every row, its seq (so the order
    carries on), its conversation and its indexes kept. Running it again changes nothing."""
    row = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='pip_chat_steers'").fetchone()
    if row is None or f"<={MAX_TEXT_BYTES}" in (row[0] or ""):
        return
    columns = [r[1] for r in db.execute("PRAGMA table_info(pip_chat_steers)").fetchall()]
    db.execute("ALTER TABLE pip_chat_steers RENAME TO pip_chat_steers_8k")
    db.execute(SCHEMA.strip().split(";")[0])
    if "conversation_id" in columns:
        db.execute("ALTER TABLE pip_chat_steers ADD COLUMN conversation_id TEXT")
    names = ",".join(columns)
    db.execute(f"INSERT INTO pip_chat_steers({names}) SELECT {names} FROM pip_chat_steers_8k")
    db.execute("DROP TABLE pip_chat_steers_8k")
    db.execute("CREATE INDEX IF NOT EXISTS pip_chat_steers_run ON pip_chat_steers(run_id,seq)")
    if "conversation_id" in columns:
        db.execute("CREATE INDEX IF NOT EXISTS pip_chat_steers_conversation ON pip_chat_steers(conversation_id)")
