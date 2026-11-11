"""Several conversations per Pip (0.52, D11; the user's calls of 10 Nov).

A Pip keeps one identity, memory, computer and routines, with as many conversations as the user likes. Each has its
own history, continuity checkpoints, steering and unread count; everything else stays the Pip's. The chat a Pip had
before becomes its first conversation, with every message in it (``migrate``). A request that names no conversation
(an older editor or SDK, a routine, a run's post) belongs to the first one. A Pip answers in its conversations in
parallel; two replies of one conversation never run together (pips.PipStore.claim_next).
"""
from __future__ import annotations

import re

from .workspace_registry import RegistryError, identifier

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_conversations (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 pip_id TEXT NOT NULL REFERENCES pips(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 title TEXT NOT NULL DEFAULT '' CHECK(length(CAST(title AS BLOB)) <= 480),
 first INTEGER NOT NULL DEFAULT 0 CHECK(first IN (0,1)),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 archived_at TEXT
);
CREATE INDEX IF NOT EXISTS pip_conversations_pip ON pip_conversations(pip_id,updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS pip_conversations_first ON pip_conversations(pip_id) WHERE first=1;
CREATE TABLE IF NOT EXISTS pip_conversation_reads (
 conversation_id TEXT PRIMARY KEY REFERENCES pip_conversations(id),
 pip_id TEXT NOT NULL REFERENCES pips(id),
 message_seq INTEGER NOT NULL DEFAULT 0
);
"""
# Tables whose rows belong to one conversation: each gains the column, and the migration fills it with the first one,
# except checkpoints: they are immutable (a trigger refuses any UPDATE: pip_chat_continuity.SCHEMA), so one saved before
# conversations keeps no conversation, and a checkpoint with none is the Pip's first conversation's (continuity.latest).
# A routine gains it too, left empty: empty is the Pip's first conversation, where routines post until moved.
SCOPED = ("pip_chat_messages", "pip_chat_checkpoints", "pip_chat_steers")
BACKFILLED = ("pip_chat_messages", "pip_chat_steers")
MAX_CONVERSATIONS = 500          # a Pip's, archived ones included (Dev Mode: yours, max_conversations)


def max_conversations() -> int:
    from .dev_mode import value
    return value("pip_conversations")
MAX_TITLE = 120
_ID = re.compile(r"conv_[0-9a-f]{32}")


def _columns(db, table) -> set:
    return {row[1] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}


def ensure(db) -> None:
    """The table, and the conversation column on every scoped table that exists (older registries lack it)."""
    for statement in SCHEMA.strip().split(";"):
        if statement.strip():
            db.execute(statement)
    for table in SCOPED + ("pip_routines",):
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() \
                and "conversation_id" not in _columns(db, table):
            db.execute(f"ALTER TABLE {table} ADD COLUMN conversation_id TEXT")
            db.execute(f"CREATE INDEX IF NOT EXISTS {table}_conversation ON {table}(conversation_id)")


def migrate(db) -> None:
    """Every Pip's chat so far becomes its first conversation, every message, checkpoint and steer in it; a Pip with
    no chat yet gets its (empty) first one too. Running it again changes nothing."""
    ensure(db)
    pips = {row[0] for row in db.execute("SELECT id FROM pips").fetchall()}
    for table in SCOPED:
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
            pips.update(row[0] for row in db.execute(
                f"SELECT DISTINCT pip_id FROM {table} WHERE conversation_id IS NULL").fetchall())
    for pip_id in sorted(pips):
        row = db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()
        if row is None:
            continue
        cid = first(db, pip_id, workspace_id=row[0])
        for table in BACKFILLED:
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                db.execute(f"UPDATE {table} SET conversation_id=? WHERE pip_id=? AND conversation_id IS NULL", (cid, pip_id))


def first(db, pip_id, *, workspace_id=None, now=None) -> str:
    """The Pip's first conversation, made when it has none yet."""
    row = db.execute("SELECT id FROM pip_conversations WHERE pip_id=? AND first=1", (pip_id,)).fetchone()
    if row:
        return row[0]
    if workspace_id is None:
        owner = db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()
        if owner is None:
            raise RegistryError("not_found", "That Pip doesn't exist.")
        workspace_id = owner[0]
    if now is None:
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    # Two connections can both find none (a send from the editor while a routine posts): the unique index keeps one.
    db.execute("INSERT OR IGNORE INTO pip_conversations(id,pip_id,workspace_id,title,first,created_at,updated_at) "
               "VALUES(?,?,?,?,1,?,?)", (identifier("conv"), pip_id, workspace_id, "", now, now))
    return db.execute("SELECT id FROM pip_conversations WHERE pip_id=? AND first=1", (pip_id,)).fetchone()[0]


def first_id(db, pip_id):
    """The Pip's first conversation if it has one; never makes it (for reads that may be rolled back)."""
    row = db.execute("SELECT id FROM pip_conversations WHERE pip_id=? AND first=1", (pip_id,)).fetchone()
    return row[0] if row else None


def resolve(db, pip_id, conversation_id=None) -> str:
    """The conversation a request is for: the one it names, which must be this Pip's and not archived, or the first."""
    if conversation_id is None:
        return first(db, pip_id)
    if not isinstance(conversation_id, str) or not _ID.fullmatch(conversation_id):
        raise RegistryError("invalid_request", "Name a conversation by its id.")
    row = db.execute("SELECT archived_at FROM pip_conversations WHERE id=? AND pip_id=?", (conversation_id, pip_id)).fetchone()
    if row is None:
        raise RegistryError("not_found", "That conversation isn't this Pip's.")
    if row[0] is not None:
        raise RegistryError("archived", "That conversation is archived. Restore it to write in it.")
    return conversation_id


def _title(value) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > MAX_TITLE:
        raise RegistryError("invalid_request", f"Keep a conversation's name under {MAX_TITLE} characters.")
    if re.search(r"[\x00-\x1f\x7f]", text):
        raise RegistryError("invalid_request", "A conversation's name is plain text on one line.")
    return text


def create(registry, pip_id, title="") -> dict:
    """A new conversation for the Pip (its first one is made first if it has none, so it stays first)."""
    db = registry.db
    owner = db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()
    if owner is None:
        raise RegistryError("not_found", "That Pip doesn't exist.")
    if db.execute("SELECT count(*) FROM pip_conversations WHERE pip_id=?", (pip_id,)).fetchone()[0] >= max_conversations():
        raise RegistryError("limit", f"A Pip keeps up to {max_conversations()} conversations. Archive or delete one first.")
    name = _title(title)
    now = registry.clock()
    first(db, pip_id, workspace_id=owner[0], now=now)
    cid = identifier("conv")
    db.execute("INSERT INTO pip_conversations(id,pip_id,workspace_id,title,first,created_at,updated_at) "
               "VALUES(?,?,?,?,0,?,?)", (cid, pip_id, owner[0], name, now, now))
    return view(db, cid)


def _own(db, pip_id, conversation_id):
    if not isinstance(conversation_id, str) or not _ID.fullmatch(conversation_id):
        raise RegistryError("invalid_request", "Name a conversation by its id.")
    row = db.execute("SELECT * FROM pip_conversations WHERE id=? AND pip_id=?", (conversation_id, pip_id)).fetchone()
    if row is None:
        raise RegistryError("not_found", "That conversation isn't this Pip's.")
    return row


def rename(registry, pip_id, conversation_id, title) -> dict:
    _own(registry.db, pip_id, conversation_id)
    registry.db.execute("UPDATE pip_conversations SET title=? WHERE id=?", (_title(title), conversation_id))
    return view(registry.db, conversation_id)


def archive(registry, pip_id, conversation_id, archived=True) -> dict:
    """Archive a conversation (it leaves the list and stays readable) or restore it. The first one stays: routines and
    an older client post there."""
    if type(archived) is not bool:
        raise RegistryError("invalid_request", "Say whether to archive or restore the conversation.")
    row = _own(registry.db, pip_id, conversation_id)
    if row["first"] and archived:
        raise RegistryError("first_conversation", "A Pip's first conversation stays: its routines post there.")
    registry.db.execute("UPDATE pip_conversations SET archived_at=? WHERE id=?",
                        (registry.clock() if archived else None, conversation_id))
    return view(registry.db, conversation_id)


def is_full(db, conversation_id) -> bool:
    """A conversation holds at most MAX_ARCHIVE_MESSAGES messages (the bound its history and checkpoints are read
    within); one with no room for another exchange is full."""
    from .pip_chat import MAX_ARCHIVE_MESSAGES
    count = db.execute("SELECT count(*) FROM pip_chat_messages WHERE conversation_id=?", (conversation_id,)).fetchone()[0]
    return count >= MAX_ARCHIVE_MESSAGES - 1


def roll_over(registry, pip_id, conversation_id) -> str:
    """A full conversation: the Pip carries on in a fresh one (its memory is the Pip's, so nothing it knows is lost).
    When the full one was its first, the new one becomes its first, so routines and an older editor follow it, and the
    full one keeps a dated name; otherwise the new one is "<name> (2)" and the routines that posted there move to it."""
    import contextlib
    from datetime import datetime
    db = registry.db
    with contextlib.nullcontext() if db.in_transaction else registry.transaction():
        full = _own(db, pip_id, conversation_id)
        if db.execute("SELECT count(*) FROM pip_conversations WHERE pip_id=?", (pip_id,)).fetchone()[0] >= max_conversations():
            raise RegistryError("limit", f"A Pip keeps up to {max_conversations()} conversations. Archive or delete one first.")
        now = registry.clock()
        try:
            day = datetime.fromisoformat(now.replace("Z", "+00:00")).strftime("%-d %b %Y")
        except ValueError:
            day = now[:10]
        name = full["title"] or "Chat"
        new_id = identifier("conv")
        if full["first"]:
            db.execute("UPDATE pip_conversations SET first=0, title=? WHERE id=?", (f"{name}, until {day}"[:MAX_TITLE], conversation_id))
            title, first_flag = "", 1
        else:
            match = re.fullmatch(r"(.*) \((\d+)\)", name)
            title = f"{match.group(1)} ({int(match.group(2)) + 1})" if match else f"{name} (2)"
            first_flag = 0
        db.execute("INSERT INTO pip_conversations(id,pip_id,workspace_id,title,first,created_at,updated_at) "
                   "VALUES(?,?,?,?,?,?,?)", (new_id, pip_id, full["workspace_id"], title[:MAX_TITLE], first_flag, now, now))
        if not first_flag and db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_routines'").fetchone():
            db.execute("UPDATE pip_routines SET conversation_id=? WHERE pip_id=? AND conversation_id=?", (new_id, pip_id, conversation_id))
    return new_id


def touch(db, conversation_id, now) -> None:
    """A message came: the conversation moves up the list."""
    db.execute("UPDATE pip_conversations SET updated_at=? WHERE id=?", (now, conversation_id))


def view(db, conversation_id) -> dict:
    row = db.execute("SELECT * FROM pip_conversations WHERE id=?", (conversation_id,)).fetchone()
    if row is None:
        raise RegistryError("not_found", "That conversation doesn't exist.")
    return {"id": row["id"], "pip_id": row["pip_id"], "title": row["title"], "first": bool(row["first"]),
            "created_at": row["created_at"], "updated_at": row["updated_at"], "archived": row["archived_at"] is not None}


def listed(db, pip_id, *, archived=False) -> list[dict]:
    """The Pip's conversations, the most recent first, each with its unread count; the first conversation is made when
    it has none."""
    first(db, pip_id)
    from .pip_unread import conversation_counts
    unread = conversation_counts(db, pip_id)
    rows = db.execute("SELECT id FROM pip_conversations WHERE pip_id=?" + ("" if archived else " AND archived_at IS NULL")
                      + " ORDER BY updated_at DESC, seq DESC", (pip_id,)).fetchall()
    return [{**view(db, row[0]), "unread": unread.get(row[0], 0)} for row in rows]
