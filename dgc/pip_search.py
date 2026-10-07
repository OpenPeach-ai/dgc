"""Find a Pip by what it is about: its name and title, its instructions, and what was said in its chat.

A full-text index (SQLite FTS5) over every Pip's chat, kept by triggers, as DGC's notes are. A Python
built without FTS5 still searches the chat, with LIKE (slower). DGC's own turns (a Pip's hello, the
"carry on" after you allow something) are not your chat and never match.
"""
from __future__ import annotations

import sqlite3

from .session_index import snippet  # noqa: F401  (one rule for both lists)

FTS = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS pip_chat_fts USING fts5(text, content='pip_chat_messages', content_rowid='seq')",
    "CREATE TRIGGER IF NOT EXISTS pip_chat_fts_ai AFTER INSERT ON pip_chat_messages BEGIN "
    "INSERT INTO pip_chat_fts(rowid, text) VALUES (new.seq, new.text); END",
    "CREATE TRIGGER IF NOT EXISTS pip_chat_fts_ad AFTER DELETE ON pip_chat_messages BEGIN "
    "INSERT INTO pip_chat_fts(pip_chat_fts, rowid, text) VALUES ('delete', old.seq, old.text); END",
    "CREATE TRIGGER IF NOT EXISTS pip_chat_fts_au AFTER UPDATE OF text ON pip_chat_messages BEGIN "
    "INSERT INTO pip_chat_fts(pip_chat_fts, rowid, text) VALUES ('delete', old.seq, old.text); "
    "INSERT INTO pip_chat_fts(rowid, text) VALUES (new.seq, new.text); END",
)
MAX_MATCHES = 5000          # messages read per search, newest first


def install(db) -> bool:
    """Create the index and fill it from the chats already there. False without FTS5."""
    try:
        db.execute("SAVEPOINT pip_search")
        for statement in FTS:
            db.execute(statement)
        db.execute("INSERT INTO pip_chat_fts(pip_chat_fts) VALUES('rebuild')")
        db.execute("RELEASE pip_search")
        return True
    except sqlite3.Error:
        db.execute("ROLLBACK TO pip_search")
        db.execute("RELEASE pip_search")
        return False


def _indexed(db) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE name='pip_chat_fts'").fetchone() is not None


def _dgc_turn(row) -> bool:
    from .pip_chat import DGC_KEYS
    return row["role"] == "user" and str(row["request_key"] or "").startswith(DGC_KEYS)


def chat_matches(db, workspace_id, query) -> dict:
    """Each Pip whose chat mentions the query: {pip_id: newest matching message text}."""
    words = query.strip()
    if not words:
        return {}
    if _indexed(db):
        expression = '"' + words.replace('"', '""') + '"*'
        sql = ("SELECT m.pip_id, m.text, m.role, m.request_key FROM pip_chat_fts f JOIN pip_chat_messages m ON m.seq=f.rowid "
               "WHERE pip_chat_fts MATCH ? AND m.workspace_id=? ORDER BY m.seq DESC LIMIT ?")
        params = (expression, workspace_id, MAX_MATCHES)
    else:
        pattern = "%" + words.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        sql = ("SELECT pip_id, text, role, request_key FROM pip_chat_messages WHERE workspace_id=? AND text LIKE ? ESCAPE '\\' "
               "ORDER BY seq DESC LIMIT ?")
        params = (workspace_id, pattern, MAX_MATCHES)
    found = {}
    try:
        rows = db.execute(sql, params).fetchall()
    except sqlite3.Error:
        return {}
    for row in rows:
        if row["pip_id"] not in found and not _dgc_turn(row):
            found[row["pip_id"]] = row["text"]
    return found
