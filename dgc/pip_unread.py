"""Per-Pip unread chat and run-post cursors for the local human view.

The two feeds have independent cursors. Marking an observed page read cannot
consume a reply or scheduled result that arrived while that page was open.
"""
from __future__ import annotations

import json

from .workspace_registry import RegistryError

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_read_state(
 pip_id TEXT PRIMARY KEY REFERENCES pips(id),
 message_seq INTEGER NOT NULL DEFAULT 0,
 post_rowid INTEGER NOT NULL DEFAULT 0);
"""


def migrate(db) -> None:
    """Existing conversations start read; subsequent arrivals become unread."""
    from .pip_run_posts import _has_table
    if not _has_table(db):
        db.execute("""INSERT OR IGNORE INTO pip_read_state(pip_id,message_seq)
            SELECT p.id,COALESCE((SELECT max(m.seq) FROM pip_chat_messages m
                WHERE m.pip_id=p.id AND m.role='assistant'),0) FROM pips p""")
        return
    db.execute("""INSERT OR IGNORE INTO pip_read_state(pip_id,message_seq,post_rowid)
        SELECT p.id,COALESCE((SELECT max(m.seq) FROM pip_chat_messages m WHERE m.pip_id=p.id AND m.role='assistant'),0),
        COALESCE((SELECT max(r.rowid) FROM pip_run_posts r WHERE r.pip_id=p.id),0) FROM pips p""")


def _preview(text: str) -> str:
    return " ".join(text.split())[:180]


def _summary(db, pip_id: str) -> dict:
    from .pip_run_posts import _has_table
    state = db.execute("SELECT message_seq,post_rowid FROM pip_read_state WHERE pip_id=?", (pip_id,)).fetchone()
    seq, post_rowid = (state[0], state[1]) if state else (0, 0)
    messages = db.execute("""SELECT count(*) FROM pip_chat_messages
        WHERE pip_id=? AND role='assistant' AND seq>?""", (pip_id, seq)).fetchone()[0]
    has_posts = _has_table(db)
    posts = (db.execute("""SELECT count(*) FROM pip_run_posts
        WHERE pip_id=? AND rowid>?""", (pip_id, post_rowid)).fetchone()[0]
        if has_posts else 0)
    latest_message = db.execute("""SELECT id,text,created_at FROM pip_chat_messages
        WHERE pip_id=? AND role='assistant' AND seq>? ORDER BY seq DESC LIMIT 1""", (pip_id, seq)).fetchone()
    latest_post = (db.execute("""SELECT run_id,post,posted_at FROM pip_run_posts
        WHERE pip_id=? AND rowid>? ORDER BY rowid DESC LIMIT 1""", (pip_id, post_rowid)).fetchone()
        if has_posts else None)
    newest = ''
    newest_at = ''
    if latest_message and (not latest_post or latest_message[2] >= latest_post[2]):
        newest = _preview(latest_message[1])
        newest_at = latest_message[2]
    elif latest_post:
        try:
            value = json.loads(latest_post[1])
            newest = _preview(value.get('text', '')) if isinstance(value, dict) and isinstance(value.get('text'), str) else ''
            newest_at = latest_post[2]
        except (ValueError, TypeError):
            pass
    return {'pip_id': pip_id, 'count': messages + posts, 'messages': messages, 'posts': posts,
            'latest_at': newest_at, 'latest_message_id': latest_message[0] if latest_message else None,
            'latest_post_id': latest_post[0] if latest_post else None,
            'latest': newest or ('New message' if messages else 'New run result' if posts else '')}


def list_unread(store, workspace_id: str) -> dict:
    store.registry.get(workspace_id)
    rows = store.db.execute("""SELECT p.id,v.definition FROM pips p JOIN pip_versions v
        ON v.pip_id=p.id AND v.version=p.current_version
        WHERE p.workspace_id=? AND p.status!='archived' ORDER BY p.created_at,p.id""",
                            (workspace_id,)).fetchall()
    items = []
    for pip_id, definition in rows:
        item = _summary(store.db, pip_id)
        if item['count']:
            item['workspace_id'] = workspace_id
            try:
                value = json.loads(definition) if len(definition.encode()) <= 16384 else {}
            except (ValueError, TypeError):
                value = {}
            item['name'] = value.get('name', 'Pip') if isinstance(value, dict) and isinstance(value.get('name'), str) else 'Pip'
            item['pip_type'] = value.get('pip_type', 'scout') if isinstance(value, dict) and isinstance(value.get('pip_type'), str) else 'scout'
        items.append(item)
    return {'workspace_id': workspace_id, 'pips': [item for item in items if item['count']],
            'total': sum(item['count'] for item in items)}


def mark_read(store, pip_id: str, message_id=None, post_id=None) -> dict:
    """Advance only to IDs the visible chat received, never to current server HEAD."""
    store._job(pip_id)
    if message_id is not None and (not isinstance(message_id, str) or len(message_id) > 128):
        raise RegistryError('invalid_cursor', 'Choose a message from this Pip.')
    if post_id is not None and (not isinstance(post_id, str) or len(post_id) > 128):
        raise RegistryError('invalid_cursor', 'Choose a run post from this Pip.')
    with store.registry.transaction():
        db = store.db
        message = db.execute("SELECT seq FROM pip_chat_messages WHERE pip_id=? AND id=? AND role='assistant'",
                             (pip_id, message_id)).fetchone() if message_id else None
        from .pip_run_posts import _has_table
        post = db.execute("SELECT rowid FROM pip_run_posts WHERE pip_id=? AND run_id=?",
                          (pip_id, post_id)).fetchone() if post_id and _has_table(db) else None
        if message_id and message is None or post_id and post is None:
            raise RegistryError('invalid_cursor', 'That message or run post does not belong to this Pip.')
        db.execute('INSERT OR IGNORE INTO pip_read_state(pip_id) VALUES(?)', (pip_id,))
        if message:
            db.execute('UPDATE pip_read_state SET message_seq=max(message_seq,?) WHERE pip_id=?',
                       (message[0], pip_id))
        if post:
            db.execute("UPDATE pip_read_state SET post_rowid=max(post_rowid,?) WHERE pip_id=?",
                       (post[0], pip_id))
    return _summary(store.db, pip_id)
