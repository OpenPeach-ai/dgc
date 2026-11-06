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
import stat
import time
from pathlib import Path

INDEX_NAME = ".index.sqlite"
MAX_BODY = 262144              # characters of a session kept for search
MAX_INDEX_FILE_BYTES = 32 * 1024 * 1024
INDEX_VERSION = 2                 # v2 keeps listing fields for oversized checkpoint sessions
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
    flags = (os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
             | getattr(os, "O_BINARY", 0))
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("Session index requires a regular file")
        raw = stream.read(MAX_INDEX_FILE_BYTES + 1)
        if info.st_size > MAX_INDEX_FILE_BYTES or len(raw) > MAX_INDEX_FILE_BYTES:
            # Checkpoint snapshots can dwarf the conversation. The writer stores the listing
            # fields before checkpoints, so decode complete top-level fields from this bounded
            # prefix and stop as soon as those fields are present. Never parse the snapshot tail.
            try:
                data = _large_prefix(raw[:MAX_INDEX_FILE_BYTES])
            except (UnicodeError, ValueError, TypeError):
                return info.st_mtime, "Large session — open to view", 0, "", ""
        else:
            data = json.loads(raw)
    msgs = data.get("messages", [])
    if not isinstance(msgs, list):
        msgs = []
    first = next((m.get("content", "") for m in msgs if isinstance(m, dict) and m.get("role") == "user"), "")
    preview = re.sub(r"\s+", " ", str(strip_turn_clock(_text_of(first)))).strip()[:56]
    name = str(data.get("name") or "")
    said = [_text_of(m.get("content")) for m in msgs if isinstance(m, dict) and m.get("role") in ("user", "assistant")]
    text = " \n".join(t for t in said if t)[:MAX_BODY]
    updated = float(data.get("updated", info.st_mtime))
    return updated, preview, len(msgs), name, text


# Keys sessions.save writes after "name". Reaching one means an unnamed chat: stop before its
# value, which may be the large checkpoint tail.
_AFTER_NAME = frozenset({
    "mode", "plan_return_mode", "todos", "goal", "goal_status", "goal_details", "goal_elapsed_seconds",
    "goal_active_since", "usage", "prompt_cache", "activity", "timing", "agents", "checkpoints",
    "chat_changes", "subscription_sessions", "images", "revision"})


def _large_prefix(raw: bytes) -> dict:
    """Decode listing fields from a large JSON file without reading its checkpoint tail."""
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        # The bounded read may end inside one multibyte character in a later snapshot.
        # Accept that incomplete tail only; malformed text in a listing field still fails.
        if exc.end != len(raw):
            raise
        source = raw[:exc.start].decode("utf-8")
    decoder = json.JSONDecoder()
    fields: dict = {}
    at = 0

    def spaces(position: int) -> int:
        while position < len(source) and source[position] in " \r\n\t":
            position += 1
        return position

    at = spaces(at)
    if at >= len(source) or source[at] != "{":
        raise ValueError("session is not an object")
    at += 1
    while at < len(source):
        try:
            at = spaces(at)
            key, at = decoder.raw_decode(source, at)
            if not isinstance(key, str):
                raise ValueError("session key is not text")
            if key in _AFTER_NAME and "updated" in fields and "messages" in fields:
                break          # sessions.save writes "name" before these, and only when a chat has one
            at = spaces(at)
            if at >= len(source) or source[at] != ":":
                raise ValueError("session key has no value")
            at = spaces(at + 1)
            value, at = decoder.raw_decode(source, at)
        except ValueError:
            break              # a later field runs past the bounded prefix
        if key in ("updated", "messages", "name"):
            fields[key] = value
        if all(key in fields for key in ("updated", "messages", "name")):
            return fields
        at = spaces(at)
        if at >= len(source) or source[at] != ",":
            break
        at += 1
    if "updated" in fields and "messages" in fields:
        return fields          # a chat with no name has no "name" key
    raise ValueError("listing fields are outside the bounded prefix")


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
        old_index = int(db.execute("PRAGMA user_version").fetchone()[0]) < INDEX_VERSION
        changed = [p for p, stamp in seen.items()
                   if known.get(p) != stamp or (old_index and stamp[1] > MAX_INDEX_FILE_BYTES)]
        gone = [p for p in known if p not in seen]
        if changed or gone or old_index:
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
            if old_index:
                db.execute(f"PRAGMA user_version={INDEX_VERSION}")
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
