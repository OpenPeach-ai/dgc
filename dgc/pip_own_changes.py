"""A Personal Pip's own changes that applied at once, and their Undo (0.52, the user's call D6).

In a turn the user started (their own message, not one DGC sent: a routine, a hello, a follow-up after the Pip's
computer or an app), what the Pip changes about itself applies when its reply is saved: its name, its instructions
(goal), its schedule and its model, and a routine it adds is on. Each change is one row here, and the chat shows it
after the reply that made it as one line with Undo. Everything else still asks, as before: web reads, a computer,
apps, its level, and every change in a turn DGC started, so a routine reading a page can't change its own job.

Undo puts the job back as it was before the change (a new version: the history keeps both), only while nothing else
changed it since. Undo of a routine removes it.
"""
from __future__ import annotations

import json
import re

from .workspace_registry import RegistryError, identifier

# What a Pip may change about itself at once, in a turn the user started; in this order on the chat's line.
DIRECT_FIELDS = ("name", "goal", "schedule", "model_choice")
ACTOR = "pip_own_change"          # the actor on the versions these write (never an approved human review)
MAX_RECORDS = 100000

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_own_changes (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 pip_id TEXT NOT NULL REFERENCES pips(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 run_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('job','routine')),
 from_version INTEGER,
 to_version INTEGER,
 routine_id TEXT,
 fields TEXT NOT NULL CHECK(length(CAST(fields AS BLOB)) <= 256),
 after TEXT NOT NULL CHECK(length(CAST(after AS BLOB)) <= 8192),
 status TEXT NOT NULL CHECK(status IN ('applied','undone')),
 created_at TEXT NOT NULL,
 undone_at TEXT,
 CHECK((kind='job' AND to_version=from_version+1 AND routine_id IS NULL)
       OR (kind='routine' AND routine_id IS NOT NULL AND from_version IS NULL AND to_version IS NULL))
);
CREATE INDEX IF NOT EXISTS pip_own_changes_run ON pip_own_changes(run_id, seq);
CREATE INDEX IF NOT EXISTS pip_own_changes_pip ON pip_own_changes(pip_id, seq);
"""

_ID = re.compile(r"own_[0-9a-f]{32}")


def user_started(store, run) -> bool:
    """The user wrote the message this turn answers: no DGC key on it (pip_chat.DGC_KEYS)."""
    from .pip_chat import DGC_KEYS
    row = store.db.execute("SELECT request_key FROM pip_chat_messages WHERE run_id=? AND role='user'", (run["id"],)).fetchone()
    return row is not None and isinstance(row[0], str) and bool(row[0]) and not row[0].startswith(DGC_KEYS)


def _shown(field, value):
    """What the chat's Details shows for a new value."""
    if field == "goal" and isinstance(value, str) and len(value) > 600:
        return value[:599] + "…"
    return value


def record_job(store, run, pip_id, workspace_id, from_version, fields, definition, now) -> str:
    change_id = identifier("own")
    after = {field: _shown(field, definition.get(field)) for field in fields}
    after["by"] = definition.get("name")          # who made it, as it was called then (the chat's line keeps it)
    store.db.execute("INSERT INTO pip_own_changes(id,pip_id,workspace_id,run_id,kind,from_version,to_version,fields,after,"
                     "status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                     (change_id, pip_id, workspace_id, run["id"], "job", from_version, from_version + 1,
                      json.dumps(list(fields)), json.dumps(after, ensure_ascii=False, sort_keys=True), "applied", now))
    return change_id


def record_routine(store, run, routine, now) -> str:
    from .pip_routines import label
    change_id = identifier("own")
    after = {"title": routine["title"], "when": label(routine["trigger"]), "prompt": _shown("goal", routine["prompt"]),
             "by": store._job(routine["pip_id"])["name"]}
    store.db.execute("INSERT INTO pip_own_changes(id,pip_id,workspace_id,run_id,kind,routine_id,fields,after,status,created_at) "
                     "VALUES(?,?,?,?,?,?,?,?,?,?)",
                     (change_id, routine["pip_id"], routine["workspace_id"], run["id"], "routine", routine["id"],
                      json.dumps(["routine"]), json.dumps(after, ensure_ascii=False, sort_keys=True), "applied", now))
    return change_id


def own_versions(db, run_id) -> int:
    """How many versions this reply's own changes made: a draft saved with the same reply (an email, an event) is not
    stale because the Pip renamed itself in it."""
    return db.execute("SELECT count(*) FROM pip_own_changes WHERE run_id=? AND kind='job' AND status='applied'",
                      (run_id,)).fetchone()[0]


def _projection(row) -> dict:
    return {"id": row["id"], "kind": row["kind"], "fields": json.loads(row["fields"]), "after": json.loads(row["after"]),
            "status": row["status"], "created_at": row["created_at"], "undone_at": row["undone_at"]}


def for_runs(db, run_ids) -> dict:
    """{run_id: [change, ...]} for the chat: each change after the reply that made it."""
    ids = [r for r in dict.fromkeys(run_ids) if isinstance(r, str)][:500]
    if not ids:
        return {}
    rows = db.execute("SELECT * FROM pip_own_changes WHERE run_id IN (" + ",".join("?" * len(ids)) + ") ORDER BY seq",
                      ids).fetchall()
    result: dict = {}
    for row in rows:
        result.setdefault(row["run_id"], []).append(_projection(row))
    return result


def undo(store, pip_id, change_id, actor) -> dict:
    """Put it back: the job as it was before the change, while nothing else changed it since; a routine, removed."""
    if not isinstance(change_id, str) or not _ID.fullmatch(change_id):
        raise RegistryError("invalid_request", "Name the change to undo.")
    registry = store.registry
    with registry.transaction():
        store._job(pip_id)
        row = store.db.execute("SELECT * FROM pip_own_changes WHERE id=? AND pip_id=?", (change_id, pip_id)).fetchone()
        if row is None:
            raise RegistryError("not_found", "That change isn't this Pip's.")
        if row["status"] != "applied":
            raise RegistryError("invalid_state", "That change is already undone.")
        now = registry.clock()
        if row["kind"] == "job":
            job = store._job(pip_id)
            if job["current_version"] != row["to_version"]:
                raise RegistryError("conflict", "It changed since, so this can't be undone here. Change it back in "
                                                "its Settings.")
            before = store.db.execute("SELECT definition FROM pip_versions WHERE pip_id=? AND version=?",
                                      (pip_id, row["from_version"])).fetchone()
            if before is None:
                raise RegistryError("not_found", "The version before this change is gone.")
            previous = json.loads(before[0])
            # A version older than model choices has none: it ran on DGC's default.
            back = {field: previous.get(field, {"mode": "default"} if field == "model_choice" else None)
                    for field in json.loads(row["fields"])}
            store.restore_own_change(pip_id, row["to_version"], back,
                                     "Undone: " + ", ".join(json.loads(row["fields"])), now)
        else:
            store.db.execute("DELETE FROM pip_routines WHERE id=? AND pip_id=?", (row["routine_id"], pip_id))
        store.db.execute("UPDATE pip_own_changes SET status='undone',undone_at=? WHERE id=?", (now, change_id))
        registry.event(row["workspace_id"], "pip_own_change_undone", pip_id=pip_id,
                       payload={"change_id": change_id, "kind": row["kind"], "actor": actor})
        return _projection(store.db.execute("SELECT * FROM pip_own_changes WHERE id=?", (change_id,)).fetchone())


SETUP = ("The user typed /setup: they want to set you up for a job{job}. Ask at most three short numbered questions, "
         "only what you need and can't work out yourself (what it is for, what a good result looks like, when to do it), "
         "in one message. When they answer, change your own job with draft_pip_change: a name that fits the job, the "
         "instructions (goal) that make you good at it, and a schedule for when to do the job if they want one: every "
         "day, weekdays, weekends or the days they name, at a time (your schedule, not a routine for the same thing); "
         "add a routine with add_routine only for something else you should do by yourself regularly or at a time, "
         "such as a reminder. These apply at once and the user can undo "
         "them. If the job is already clear, skip the questions and set it up now.")
ASK_JOB = " (they didn't say which: ask what job they want you to do first)"
# The turn after /setup, which usually answers its questions: the /setup words reach only the /setup turn, so without
# these the answers ("every weekday at 9") followed the standing rule for something regular and became a routine (live,
# 10 Nov).
SETUP_ANSWER = ("Your last message answered the user's /setup. If this message answers your questions, set yourself up "
                "now with draft_pip_change: a name that fits the job, the instructions (goal) that make you good at it, "
                "and a schedule for when to do the job if they said when: every day, weekdays, weekends or the days "
                "they name, at a time (your schedule, not a routine for the same thing). Add a routine with add_routine "
                "only for something else you should do by yourself, such as a reminder. These apply at once and the "
                "user can undo them. Otherwise, answer as usual.")
_SETUP = re.compile(r"/setup(?:\s+(.*))?", re.S)


def setup_instructions(text, history=()) -> str | None:
    """The words a /setup message adds to the turn, or the turn right after one (``history``: the turn's earlier
    user/assistant pairs), or None."""
    if not isinstance(text, str):
        return None
    match = _SETUP.fullmatch(text.strip())
    if match is None:
        previous = history[-2] if isinstance(history, (list, tuple)) and len(history) >= 2 else None
        if (isinstance(previous, dict) and previous.get("role") == "user" and isinstance(previous.get("content"), str)
                and _SETUP.fullmatch(previous["content"].strip())):
            return SETUP_ANSWER
        return None
    job = (match.group(1) or "").strip()
    return SETUP.format(job=f": \"{job[:2000]}\"" if job else ASK_JOB)
