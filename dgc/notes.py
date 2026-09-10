"""Context notes — a small, searchable trace of a project that outlives its context window.

Compaction protects the model's context; it also throws away what was already tried. A model
that cannot see its own failed attempts repeats them, and a long or multi-day run makes that
worse, not better. Notes are the durable half: short, typed, per project, written mostly by the
harness from tool results it already sees, so a local model gets the benefit without having to
remember anything itself.

What this is NOT: the pre-compaction archive (`sessions.recall_*`). That is the user's raw
scrollback, display-only, and it never re-enters the model's context. Notes are a curated
projection that deliberately may — so every note is bounded, redacted, and carries where it
came from, and the whole store degrades to "no notes" rather than raising into a turn.
"""
from __future__ import annotations

import os
import re
import sqlite3
import time
from pathlib import Path

SCHEMA_VERSION = 1

#: What a note can be. Kept small on purpose — a vocabulary nobody can remember is not used.
KINDS = ("requirement", "decision", "attempt", "failure", "outcome", "state")

MAX_TEXT = 2_000            # one note's text
MAX_EVIDENCE = 1_000        # the command/output tail that justifies it
MAX_ROWS = 5_000            # per project; the oldest are pruned past this
DEFAULT_LIMIT = 8


def notes_path(project_root) -> Path:
    from . import sessions
    return sessions.project_dir(project_root) / "notes.sqlite"


def _clean(value, limit: int) -> str:
    """Bound a field and strip the control characters a terminal or a prompt should never see."""
    text = str(value if value is not None else "")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", text)
    text = re.sub(r"[ \t]+", " ", text).strip()
    return text[:limit]


class NoteStore:
    """A per-project note store. Every method fails soft: a locked, corrupt, or read-only
    database costs the caller nothing but the notes themselves."""

    def __init__(self, project_root, *, redact_secrets=(), max_rows: int = MAX_ROWS) -> None:
        self.project_root = project_root
        self.max_rows = int(max_rows)
        self._secrets = tuple(redact_secrets or ())
        self._db: sqlite3.Connection | None = None
        self._fts = False
        self._broken = False
        self._any: bool | None = None       # cached "is there anything to read?"

    # ---------------------------------------------------------------- storage ---
    def _connect(self) -> sqlite3.Connection | None:
        if self._db is not None or self._broken:
            return self._db
        try:
            path = notes_path(self.project_root)
            db = sqlite3.connect(str(path), timeout=2.0, isolation_level=None)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.execute("""CREATE TABLE IF NOT EXISTS notes(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL, text TEXT NOT NULL, file TEXT NOT NULL DEFAULT '',
                tool TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '',
                session TEXT NOT NULL DEFAULT '', turn INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL, schema_version INTEGER NOT NULL)""")
            db.execute("CREATE INDEX IF NOT EXISTS notes_file ON notes(file)")
            db.execute("CREATE INDEX IF NOT EXISTS notes_kind ON notes(kind)")
            try:
                # Search is the whole point, but a Python built without FTS5 must still take
                # notes — the reader falls back to LIKE.
                db.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts
                              USING fts5(text, file, tool, content='notes', content_rowid='id')""")
                db.execute("""CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
                    INSERT INTO notes_fts(rowid, text, file, tool)
                    VALUES (new.id, new.text, new.file, new.tool); END""")
                db.execute("""CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
                    INSERT INTO notes_fts(notes_fts, rowid, text, file, tool)
                    VALUES ('delete', old.id, old.text, old.file, old.tool); END""")
                self._fts = True
            except sqlite3.Error:
                self._fts = False
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
            self._db = db
        except (sqlite3.Error, OSError, ValueError):
            self._broken = True
            self._db = None
        return self._db

    def close(self) -> None:
        if self._db is not None:
            try:
                self._db.close()
            except sqlite3.Error:
                pass
            self._db = None

    # ------------------------------------------------------------------ write ---
    def add(self, kind: str, text: str, *, file: str = "", tool: str = "",
            evidence: str = "", session: str = "", turn: int = 0) -> int | None:
        """Record one note. Returns its id, or None when nothing was stored."""
        from .redaction import redact_text
        if kind not in KINDS:
            return None
        body = _clean(redact_text(text, self._secrets), MAX_TEXT)
        if not body:
            return None
        db = self._connect()
        if db is None:
            return None
        try:
            cur = db.execute(
                "INSERT INTO notes(kind, text, file, tool, evidence, session, turn, created_at,"
                " schema_version) VALUES (?,?,?,?,?,?,?,?,?)",
                (kind, body, _clean(file, 400), _clean(tool, 80),
                 _clean(redact_text(evidence, self._secrets), MAX_EVIDENCE),
                 _clean(session, 120), int(turn or 0), time.time(), SCHEMA_VERSION))
            self._prune(db)
            self._any = True
            return int(cur.lastrowid)
        except (sqlite3.Error, OverflowError, ValueError):
            return None

    def _prune(self, db: sqlite3.Connection) -> None:
        try:
            (count,) = db.execute("SELECT COUNT(*) FROM notes").fetchone()
            if count > self.max_rows:
                db.execute("DELETE FROM notes WHERE id IN (SELECT id FROM notes"
                           " ORDER BY id LIMIT ?)", (count - self.max_rows,))
        except sqlite3.Error:
            pass

    # ------------------------------------------------------------------- read ---
    def _rows(self, sql: str, params: tuple) -> list[dict]:
        from .redaction import redact_text
        db = self._connect()
        if db is None:
            return []
        try:
            rows = db.execute(sql, params).fetchall()
        except sqlite3.Error:
            return []
        out = []
        for row in rows:
            item = {k: row[k] for k in row.keys()}
            # Redact on read as well: a secret learned after the note was written must not leak.
            item["text"] = redact_text(item.get("text", ""), self._secrets)
            item["evidence"] = redact_text(item.get("evidence", ""), self._secrets)
            out.append(item)
        return out

    def recent(self, limit: int = DEFAULT_LIMIT, kinds: tuple[str, ...] = ()) -> list[dict]:
        limit = max(1, min(int(limit or DEFAULT_LIMIT), 100))
        if kinds:
            marks = ",".join("?" * len(kinds))
            return self._rows(f"SELECT * FROM notes WHERE kind IN ({marks})"
                              " ORDER BY id DESC LIMIT ?", (*kinds, limit))
        return self._rows("SELECT * FROM notes ORDER BY id DESC LIMIT ?", (limit,))

    def for_file(self, path: str, *, kinds: tuple[str, ...] = ("failure",),
                 limit: int = 5) -> list[dict]:
        """Notes about one file, newest first — the reminder an edit or a test wants."""
        name = _clean(path, 400)
        if not name:
            return []
        limit = max(1, min(int(limit or 5), 50))
        marks = ",".join("?" * len(kinds)) if kinds else ""
        clause = f" AND kind IN ({marks})" if kinds else ""
        # Match the stored path or its tail, so "src/app.py" finds a note filed as "app.py".
        # The tail clause must require a file: `'src/app.py' LIKE '%' || ''` is true of every
        # note that has no file at all, which quietly returned the whole store.
        return self._rows(
            f"SELECT * FROM notes WHERE file <> '' AND (file = ? OR file LIKE ?"
            f" OR ? LIKE '%' || file){clause} ORDER BY id DESC LIMIT ?",
            (name, "%" + os.path.basename(name), name, *kinds, limit))

    def search(self, query: str, limit: int = DEFAULT_LIMIT) -> list[dict]:
        """Full-text search over the trace; falls back to LIKE without FTS5."""
        text = _clean(query, 200)
        if not text:
            return []
        limit = max(1, min(int(limit or DEFAULT_LIMIT), 100))
        if self._connect() is not None and self._fts:
            # Quote each term: a bare path or an error string is not FTS5 syntax.
            terms = " ".join(f'"{t}"' for t in re.findall(r"[A-Za-z0-9_./-]+", text)[:12])
            if terms:
                found = self._rows(
                    "SELECT notes.* FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid"
                    " WHERE notes_fts MATCH ? ORDER BY notes.id DESC LIMIT ?", (terms, limit))
                if found:
                    return found
        like = f"%{text}%"
        return self._rows("SELECT * FROM notes WHERE text LIKE ? OR file LIKE ?"
                          " ORDER BY id DESC LIMIT ?", (like, like, limit))

    def has_notes(self) -> bool:
        """Whether this project has a trace at all — asked before the tool is advertised, so an
        empty project pays nothing for a feature with nothing to say."""
        if self._any is None:
            self._any = self.count() > 0
        return self._any

    def count(self) -> int:
        db = self._connect()
        if db is None:
            return 0
        try:
            (value,) = db.execute("SELECT COUNT(*) FROM notes").fetchone()
            return int(value)
        except sqlite3.Error:
            return 0


def handle_command(agent, rest: str) -> str:
    """`/notes [QUERY|on|off]` for every terminal surface; returns Markdown to show."""
    config = agent.config
    word = str(rest or "").strip()
    if word.lower() in ("on", "off"):
        config.set("notes", word.lower() == "on")
        if word.lower() == "off":
            return "Context notes are **off** for every project. Nothing further is recorded."
        return "Context notes are **on** — what this project learns is recorded again."
    store = agent.notes()
    if store is None:
        return "Context notes are **off**. `/notes on` starts recording again."
    rows = store.search(word) if word else store.recent(10)
    total = store.count()
    if not rows:
        return (f"No notes match `{word}`." if word else
                "No notes yet. They are written as the project runs — a failing command, an edit, "
                "a test that passed — and survive compaction and restarts.")
    head = (f"**Notes matching `{word}`**" if word else "**What this project has learned**")
    body = render(rows, limit_chars=3_000)
    return f"{head} ({len(rows)} of {total}):\n\n{body}\n\n`/notes <query>` searches · `/notes off` stops recording."


def render(rows, *, header: str = "", limit_chars: int = 1_600) -> str:
    """Notes as a bounded block of text — the one shape the model, the tool and /notes share."""
    if not rows:
        return ""
    lines = [header] if header else []
    for row in rows:
        when = time.strftime("%Y-%m-%d", time.localtime(float(row.get("created_at") or 0)))
        where = f" {row.get('file')}" if row.get("file") else ""
        lines.append(f"- [{row.get('kind')}{where} · {when}] {row.get('text')}")
        if len("\n".join(lines)) > limit_chars:
            break
    text = "\n".join(lines)
    return text[:limit_chars]
