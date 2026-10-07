"""A per-project index of saved sessions, so the Sessions list holds thousands and searches them.

Listing used to read every session file in full on every refresh: with 2,000 sessions that is the
whole of every transcript, each time. The index keeps what a listing shows (name, first message,
message count, last change) and a full-text copy of what was said, beside the sessions themselves
(``<sessions>/<project>/.index.sqlite``). A file is read again only when its size or time changes.
Search covers the name, the first message and everything said; without FTS5 it matches with LIKE.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from pathlib import Path

INDEX_NAME = ".index.sqlite"
MAX_BODY = 262144              # characters of a session kept for search
SNIPPET = 160
SCHEMA = (
    "CREATE TABLE IF NOT EXISTS meta(path TEXT PRIMARY KEY, mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL,"
    " updated REAL NOT NULL, preview TEXT NOT NULL, count INTEGER NOT NULL, name TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS body(path TEXT PRIMARY KEY, text TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS meta_updated ON meta(updated)",
)
FTS = "CREATE VIRTUAL TABLE IF NOT EXISTS body_fts USING fts5(text, content='body', content_rowid='rowid')"
FTS_TRIGGERS = (
    "CREATE TRIGGER IF NOT EXISTS body_ai AFTER INSERT ON body BEGIN INSERT INTO body_fts(rowid,text) VALUES(new.rowid,new.text); END",
    "CREATE TRIGGER IF NOT EXISTS body_ad AFTER DELETE ON body BEGIN INSERT INTO body_fts(body_fts,rowid,text) VALUES('delete',old.rowid,old.text); END",
    "CREATE TRIGGER IF NOT EXISTS body_au AFTER UPDATE ON body BEGIN INSERT INTO body_fts(body_fts,rowid,text) VALUES('delete',old.rowid,old.text);"
    " INSERT INTO body_fts(rowid,text) VALUES(new.rowid,new.text); END",
)


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str))
    return ""


def _open(directory: Path):
    db = sqlite3.connect(str(directory / INDEX_NAME), timeout=10)
    db.row_factory = sqlite3.Row
    for statement in SCHEMA:
        db.execute(statement)
    fts = True
    try:
        db.execute(FTS)
        for statement in FTS_TRIGGERS:
            db.execute(statement)
    except sqlite3.Error:
        fts = False
    db.commit()
    try:
        os.chmod(directory / INDEX_NAME, 0o600)
    except OSError:
        pass
    return db, fts


def _read(path: Path):
    """What the list shows of one session file, and what search reads. Kept as written, beside the
    session it came from; each reader redacts what it shows (page)."""
    from .clock import strip_turn_clock
    data = json.loads(path.read_text())
    msgs = data.get("messages", [])
    if not isinstance(msgs, list):
        msgs = []
    first = next((m.get("content", "") for m in msgs if isinstance(m, dict) and m.get("role") == "user"), "")
    preview = re.sub(r"\s+", " ", str(strip_turn_clock(_text_of(first)))).strip()
    name = str(data.get("name") or "")
    said = [_text_of(m.get("content")) for m in msgs if isinstance(m, dict) and m.get("role") in ("user", "assistant")]
    text = " \n".join(t for t in said if t)[:MAX_BODY]
    updated = float(data.get("updated", path.stat().st_mtime))
    return updated, preview, len(msgs), name, text


def sync(directory: Path):
    """Bring the index up to date with the session files: read new and changed ones, drop gone ones."""
    db, fts = _open(directory)
    try:
        seen = {}
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.is_file(follow_symlinks=False) and entry.name.endswith(".json"):
                    stat = entry.stat(follow_symlinks=False)
                    seen[entry.path] = (stat.st_mtime_ns, stat.st_size)
        known = {row["path"]: (row["mtime_ns"], row["size"]) for row in db.execute("SELECT path,mtime_ns,size FROM meta")}
        changed = [p for p, stamp in seen.items() if known.get(p) != stamp]
        gone = [p for p in known if p not in seen]
        if changed or gone:
            db.execute("BEGIN IMMEDIATE")
            for path in gone:
                db.execute("DELETE FROM meta WHERE path=?", (path,))
                db.execute("DELETE FROM body WHERE path=?", (path,))
            for path in changed:
                try:
                    updated, preview, count, name, text = _read(Path(path))
                except (OSError, ValueError, TypeError, AttributeError):
                    continue
                mtime_ns, size = seen[path]
                db.execute("INSERT OR REPLACE INTO meta VALUES(?,?,?,?,?,?,?)", (path, mtime_ns, size, updated, preview, count, name))
                if db.execute("UPDATE body SET text=? WHERE path=?", (text, path)).rowcount == 0:
                    db.execute("INSERT INTO body(path,text) VALUES(?,?)", (path, text))
            db.execute("COMMIT")
        return db, fts
    except BaseException:
        if db.in_transaction:
            db.rollback()
        db.close()
        raise


def snippet(text, query) -> str:
    """The words around the first place the query appears, on one line, cut at whole words (a
    snippet that opens on "…ough starter" reads as a fault). Both the Sessions and Pips lists use it."""
    flat = " ".join(str(text or "").split())
    words = query.strip().split()
    found = re.search(r"(?<!\w)" + re.escape(words[0]), flat, re.IGNORECASE) if words else None
    at = found.start() if found else (flat.casefold().find(words[0].casefold()) if words else -1)
    start = 0
    if at > 50:
        space = flat.find(" ", at - 50, at)
        start = space + 1 if space >= 0 else at
    end = start + SNIPPET
    if end < len(flat):
        space = flat.rfind(" ", start, end)
        end = space if space > start else end
    return ("…" if start else "") + flat[start:end] + ("…" if end < len(flat) else "")


def page(directory: Path, *, limit=None, offset=0, query="", redact_secrets=()):
    """[(path, updated, preview, count, name, match)] newest first; `match` is the words around
    where `query` was found in what was said, or None when the name or first message matched."""
    from .redaction import redact_text
    db, fts = sync(directory)
    try:
        params, where = [], ""
        query = " ".join(str(query or "").split())
        if query:
            pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            if fts:
                inner = "SELECT b.path FROM body_fts f JOIN body b ON b.rowid=f.rowid WHERE body_fts MATCH ?"
                params = [pattern, pattern, '"' + query.replace('"', '""') + '"*']
            else:
                inner = "SELECT path FROM body WHERE text LIKE ? ESCAPE '\\'"
                params = [pattern, pattern, pattern]
            where = (" WHERE m.name LIKE ? ESCAPE '\\' OR m.preview LIKE ? ESCAPE '\\' OR m.path IN (" + inner + ")")
        sql = "SELECT m.path,m.updated,m.preview,m.count,m.name FROM meta m" + where + " ORDER BY m.updated DESC, m.path DESC"
        if limit is not None:
            sql += " LIMIT ? OFFSET ?"
            params += [limit, offset]
        try:
            rows = db.execute(sql, params).fetchall()
        except sqlite3.Error:
            rows = []
        out = []
        for row in rows:
            match = None
            if query and query.casefold() not in (row["name"] + " " + row["preview"]).casefold():
                text = db.execute("SELECT text FROM body WHERE path=?", (row["path"],)).fetchone()
                match = redact_text(snippet(text[0] if text else "", query), redact_secrets)
            preview = re.sub(r"\s+", " ", redact_text(row["preview"], redact_secrets)).strip()[:56] or "(empty)"
            out.append((Path(row["path"]), row["updated"], preview, row["count"], redact_text(row["name"], redact_secrets), match))
        return out
    finally:
        db.close()
