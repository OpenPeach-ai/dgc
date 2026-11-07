"""Per-Pip unread chat and run-post cursors for the local human view.

The two feeds have independent cursors. Marking an observed page read cannot
consume a reply or scheduled result that arrived while that page was open.

What counts is what the Pip's chat shows (reported 3 Nov: a Gmail Pip's home row said
"51 unread" for a chat with far fewer items). The chat hides the turns DGC writes and
draws each reply where its turn falls, so one item is a turn the user sees (their own
message, a routine's run, the Pip's hello) with every reply under it: the reply after an
Allow (a follow-up turn, pip_chat.FOLLOW_UP_KEYS) carries on the item above it rather
than standing alone. An item is unread while it has a reply after the cursor. Runs that
passed or found nothing, one after another with no message between, are one message
in the chat (pipRunPosts.js ``timeline``), and count once too.
"""
from __future__ import annotations

import json
import re
from bisect import bisect_right

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
    """One plain line of a reply for a row: no Markdown marks, whatever the reply was written in."""
    from .pip_chat import without_breaks
    from .pip_report_delivery import plain_words
    return plain_words(without_breaks(text))[:180]


_RUN_LINE = re.compile(r"Pip '.*?' (finished|failed|needs you): ", re.DOTALL)


def _post_preview(text: str) -> str:
    """A run's post in a row that already has its Pip's name: "Pip 'X' finished: 5 findings" under X reads "5 findings"."""
    said = _RUN_LINE.match(text)
    if said:
        rest = text[said.end():]
        text = rest if said.group(1) == "finished" else f"{said.group(1)}: {rest}"
    words = _preview(text)
    return words[:1].upper() + words[1:]


def _unread_items(db, pip_id: str, seq: int) -> int:
    """How many of the chat's items have a reply after the cursor. An item is the turn the user sees with its
    replies: the reply to a follow-up turn DGC wrote belongs to the nearest turn before it that is not one."""
    from .pip_chat import FOLLOW_UP_KEYS
    replies = db.execute("""SELECT a.seq,u.seq,u.request_key FROM pip_chat_messages a
        LEFT JOIN pip_chat_messages u ON u.run_id=a.run_id AND u.role='user'
        WHERE a.pip_id=? AND a.role='assistant' AND a.seq>?""", (pip_id, seq)).fetchall()
    items = set()
    for reply, turn, key in replies:
        if turn is None:
            items.add(-reply)                  # a reply with no turn of its own is an item by itself
            continue
        while isinstance(key, str) and key.startswith(FOLLOW_UP_KEYS):
            row = db.execute("""SELECT seq,request_key FROM pip_chat_messages
                WHERE pip_id=? AND role='user' AND seq<? ORDER BY seq DESC LIMIT 1""", (pip_id, turn)).fetchone()
            if row is None:
                break                          # nothing above it: the follow-up is its own item
            turn, key = row
        items.add(turn)
    return len(items)


def _fold(kind, outcome, checks) -> str:
    """Which runs the chat folds into one message (pipRunPosts.js timeline); '' for a run it says on its own."""
    if outcome == 'checks_passed':
        return f"checks:{checks if type(checks) is int and checks >= 0 else 0}"
    if outcome == 'clear':
        return f"{kind}:clear"
    return 'live:clear' if outcome == 'live_clear' else ''


def _unread_posts(db, pip_id: str, post_rowid: int) -> int:
    """How many of the chat's run messages have a post after the cursor: all-clear runs of one kind in a row, with
    no message between them, are one message there."""
    first = db.execute("SELECT min(posted_at) FROM pip_run_posts WHERE pip_id=? AND rowid>?",
                       (pip_id, post_rowid)).fetchone()[0]
    if first is None:
        return 0
    from .pip_chat import DGC_KEYS
    # The messages the chat shows (not DGC's own turns), by time: one between two runs keeps them apart.
    said = sorted(at for at, role, key in db.execute(
        "SELECT created_at,role,request_key FROM pip_chat_messages WHERE pip_id=? AND created_at>?", (pip_id, first))
        if role == 'assistant' or not (isinstance(key, str) and key.startswith(DGC_KEYS)))
    runs = db.execute("""SELECT rowid>?,posted_at,CASE WHEN json_valid(post) THEN json_extract(post,'$.kind') END,
        CASE WHEN json_valid(post) THEN json_extract(post,'$.outcome') END,
        CASE WHEN json_valid(post) THEN json_extract(post,'$.checks.total') END
        FROM pip_run_posts WHERE pip_id=? AND posted_at>=? ORDER BY posted_at,run_id""",
                      (post_rowid, pip_id, first)).fetchall()
    count, before = 0, None                    # before: the run above it (posted_at, fold, its message is counted)
    for unread, at, kind, outcome, checks in runs:
        fold = _fold(kind, outcome, checks)
        joins = (before is not None and fold and fold == before[1]
                 and bisect_right(said, at) == bisect_right(said, before[0]))
        counted = before[2] if joins else False
        if unread and not counted:
            count, counted = count + 1, True
        before = (at, fold, counted)
    return count


def _summary(db, pip_id: str) -> dict:
    from .pip_run_posts import _has_table
    state = db.execute("SELECT message_seq,post_rowid FROM pip_read_state WHERE pip_id=?", (pip_id,)).fetchone()
    seq, post_rowid = (state[0], state[1]) if state else (0, 0)
    messages = _unread_items(db, pip_id, seq)
    has_posts = _has_table(db)
    posts = _unread_posts(db, pip_id, post_rowid) if has_posts else 0
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
            newest = _post_preview(value.get('text', '')) if isinstance(value, dict) and isinstance(value.get('text'), str) else ''
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
