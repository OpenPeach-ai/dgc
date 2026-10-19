"""A finished Pip run posts its result in that Pip's own chat, as a short message from the Pip.

Grok Bots and OpenAI Dots both post a scheduled run's result in the bot's own conversation, where you
can reply to it, and keep a separate run list for the record. A Pip does the same: each run's result
appears in its chat, and the run list behind it is the History tab (it was Runs).

Which runs. A source review (Scout, Lens, Rook, Lock), a Pulse check, a Quill draft and a Personal
Pip's scheduled task, when it finishes or fails. Chat replies are the chat already; Patch work and a
handoff's test run are reviewed where they were handed off, and a cancelled run is the user's own doing.

Exactly once. ``post`` writes one row, keyed by the run, inside the transaction that finishes the run
(``PipStore.finish`` and ``recover``). The runner finishes runs whether or not an editor is open, so a
run that ends overnight is in the chat in the morning; a crash either loses both the finish and the post
or keeps both.

What it says is the Work chat's card (``pip_report_delivery`` builds both): what kind of run, the
outcome and counts, the top three findings with severity, title and file:line, or why it stopped, in
words a person can act on, and when it runs next. A clean run is the same row; the editor draws it as
one quiet line.

Not a chat turn. A post is not in ``pip_chat_messages``: it never starts a reply, never pairs with a
user message and is never sent to the model as something the user said. The Pip's next reply reads the
latest few as reference data (``recent``, the conversation's ``run_posts`` beside ``last_report``), so
"is this the same as last week?" has an answer, and the full report is still a tool call away.

The editor reads posts with ``list_pip_run_posts`` (Pips API 51) and draws each where it falls among
the chat's messages; History uses the same posts to say what each run found.
"""
from __future__ import annotations

import json
import re
import sqlite3

from . import pip_report_delivery as delivery
from .workspace_registry import RegistryError

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_run_posts(
 run_id TEXT PRIMARY KEY, pip_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
 posted_at TEXT NOT NULL, post TEXT NOT NULL CHECK(length(CAST(post AS BLOB))<=8192));
CREATE INDEX IF NOT EXISTS pip_run_posts_chat ON pip_run_posts(pip_id,posted_at,run_id);
"""
KINDS = ("audit", "checks", "draft", "result")
OUTCOMES = (*delivery.OUTCOMES, "draft", "result")
TRIGGERS = ("schedule", "event", "you", "chat", "handoff")
PREVIEW_CHARS = 1200       # a Personal Pip's result as its chat shows it; Open full result has the rest
MAX_POST_BYTES = 8192
MAX_PAGE = 50
RECENT = 5                 # posts the Pip's next reply reads as reference
RECENT_PREVIEW = 400
_RUN = re.compile(r"run_[0-9a-f]{32}\Z")


def ensure(db) -> None:
    for statement in (part.strip() for part in SCHEMA.split(";")):
        if statement:
            db.execute(statement)


def _has_table(db) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_run_posts'").fetchone() is not None


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _trigger(manifest: dict) -> str:
    """Who started it, in the words the chat uses: its schedule, an event, you, a chat, a handoff."""
    trigger = manifest.get("trigger")
    return {"schedule": "schedule", "event": "event", "main_chat": "chat", "handoff": "handoff"}.get(trigger, "you")


def _next_run(db, pip_id: str) -> str | None:
    """When an active, scheduled Pip runs next, for a failure's "I'll run again at ...". None: no schedule."""
    try:
        row = db.execute("""SELECT s.next_due_at FROM pip_schedule_state s JOIN pips p ON p.id=s.pip_id
            WHERE s.pip_id=? AND p.status='active'""", (pip_id,)).fetchone()
    except sqlite3.Error:
        return None
    value = row[0] if row else None
    return value if isinstance(value, str) and 0 < len(value) <= 40 else None


def _preview(text: str) -> tuple[str, bool]:
    """A result's start, cut at a paragraph or a sentence where one is near the limit."""
    text = text.strip()
    if len(text) <= PREVIEW_CHARS:
        return text, False
    cut = text[:PREVIEW_CHARS]
    for mark in ("\n\n", "\n", ". "):
        at = cut.rfind(mark)
        if at >= PREVIEW_CHARS // 2:
            return cut[:at + (1 if mark == ". " else 0)].rstrip(), True
    return cut.rstrip() + "…", True


def line(post: dict) -> str:
    """The post in one plain line, as the Work chat's terminal line says it ("Pip 'X' finished: ...")."""
    name = delivery._text(post.get("name"), 120)
    outcome = post.get("outcome")
    if outcome == "draft":
        return f"Pip '{name}' finished: a draft, {delivery._text(post.get('title'), 200)}"
    if outcome == "result":
        return f"Pip '{name}' finished: " + delivery._text(post.get("preview"), 200)
    return delivery.summary_line(post)


def build(registry, run_id: str) -> dict | None:
    """What a finished run posts in its Pip's chat; None for a run that posts nothing."""
    return _build(registry, run_id)[0]


def _build(registry, run_id: str) -> tuple[dict | None, str | None]:
    db = registry.db
    row = db.execute("""SELECT id,pip_id,workspace_id,status,finished_at,
            CASE WHEN length(CAST(requested_by AS BLOB))<=128 THEN requested_by END AS requested_by,
            CASE WHEN length(CAST(manifest AS BLOB))<=131072 THEN manifest END AS manifest,
            CASE WHEN length(CAST(result AS BLOB))<=262144 THEN result END AS result,
            CASE WHEN length(CAST(error AS BLOB))<=16384 THEN error END AS error
        FROM pip_runs WHERE id=?""", (run_id,)).fetchone()
    if row is None or row["status"] not in ("succeeded", "failed") or not _RUN.match(row["id"] or ""):
        return None, None
    try:
        manifest = json.loads(row["manifest"]) if row["manifest"] else {}
    except (ValueError, RecursionError):
        return None, None
    if not isinstance(manifest, dict):
        return None, None
    kind = manifest.get("run_kind", "audit")
    pip = delivery._pip(db, row["pip_id"])
    if pip is None:
        return None, None
    if kind == "audit" or kind == "test" and "pulse_verification" in manifest:
        candidate = delivery._candidate(registry, row, pip)
        if candidate is None:
            return None, None
        post = dict(candidate["report"])
        post.pop("earlier", None)
    elif kind in ("draft", "personal_task"):
        post = {"run_id": row["id"], "pip_id": row["pip_id"], **pip, "kind": "draft" if kind == "draft" else "result",
                "finished_at": row["finished_at"]}
        try:
            result = json.loads(row["result"]) if row["result"] else None
            error = json.loads(row["error"]) if row["error"] else None
        except (ValueError, RecursionError):
            return None, None
        if row["status"] == "failed":
            reason, detail = delivery._reason(error)
            post.update(outcome="failed", reason=reason, detail=detail)
        elif kind == "draft":
            if not isinstance(result, dict) or not isinstance(result.get("title"), str):
                return None, None
            post.update(outcome="draft", title=delivery._text(result["title"], 200),
                        summary=delivery._text(result.get("summary"), 400))
        else:
            if not isinstance(result, dict) or not isinstance(result.get("text"), str) or not result["text"].strip():
                return None, None
            preview, truncated = _preview(result["text"])
            post.update(outcome="result", preview=preview, truncated=truncated)
    else:
        return None, None
    post["trigger"] = _trigger(manifest)
    if post["outcome"] == "failed":
        upcoming = _next_run(db, row["pip_id"])
        if upcoming and upcoming > (row["finished_at"] or ""):
            post["next_run_at"] = upcoming
    post["text"] = line(post)
    return post, row["workspace_id"]


def _fit(post: dict) -> str | None:
    """The post as stored, within its bound: the saved detail, then the preview, give way first."""
    encoded = _json(post)
    if len(encoded.encode()) <= MAX_POST_BYTES:
        return encoded
    post = dict(post)
    post.pop("detail", None)
    if isinstance(post.get("preview"), str):
        post["preview"], post["truncated"] = post["preview"][:600].rstrip() + "…", True
    encoded = _json(post)
    return encoded if len(encoded.encode()) <= MAX_POST_BYTES else None


def post(registry, run_id: str) -> bool:
    """Post a run that has just finished, in the caller's transaction. Never fails the finish: a run
    whose result no longer reads posts nothing, and History still has it."""
    try:
        value, workspace_id = _build(registry, run_id)
        encoded = _fit(value) if value is not None else None
        if encoded is None:
            return False
        ensure(registry.db)
        return registry.db.execute("INSERT OR IGNORE INTO pip_run_posts VALUES(?,?,?,?,?)",
            (value["run_id"], value["pip_id"], workspace_id, value["finished_at"], encoded)).rowcount == 1
    except (RegistryError, ValueError, TypeError, KeyError, IndexError, RecursionError, sqlite3.Error):
        return False


def _valid(value) -> dict | None:
    if (not isinstance(value, dict) or not _RUN.match(str(value.get("run_id") or ""))
            or value.get("kind") not in KINDS or value.get("outcome") not in OUTCOMES
            or value.get("trigger") not in TRIGGERS or not isinstance(value.get("text"), str)):
        return None
    return value


def _rows(db, pip_id: str, limit: int, before=None):
    where, args = "pip_id=?", [pip_id]
    if before is not None:
        where += " AND (posted_at<? OR (posted_at=? AND run_id<?))"
        args += [before[0], before[0], before[1]]
    return db.execute(f"""SELECT run_id,posted_at,CASE WHEN length(CAST(post AS BLOB))<={MAX_POST_BYTES} THEN post END AS post
        FROM pip_run_posts WHERE {where} ORDER BY posted_at DESC,run_id DESC LIMIT ?""", (*args, limit)).fetchall()


def _decode(row) -> dict | None:
    try:
        value = _valid(json.loads(row["post"])) if row["post"] else None
    except (ValueError, RecursionError):
        return None
    if value is None:
        return None
    return {**value, "posted_at": row["posted_at"]}


def page(store, pip_id: str, before_id=None, limit=20) -> dict:
    """``list_pip_run_posts``: this Pip's posts, oldest first, a page at a time (newest page first)."""
    if type(limit) is not int or not 1 <= limit <= MAX_PAGE:
        raise RegistryError("invalid_request", f"Ask for 1 to {MAX_PAGE} posts at a time.")
    pip = store._job(pip_id)
    db = store.db
    empty = {"pip_id": pip_id, "workspace_id": pip["workspace_id"], "posts": [], "next_before_id": None}
    if not _has_table(db):
        if before_id is not None:
            raise RegistryError("invalid_cursor", "That run is not one of this Pip's posts.")
        return empty
    before = None
    if before_id is not None:
        cursor = db.execute("SELECT posted_at,run_id FROM pip_run_posts WHERE run_id=? AND pip_id=?",
                            (before_id, pip_id)).fetchone() if isinstance(before_id, str) and len(before_id) <= 128 else None
        if cursor is None:
            raise RegistryError("invalid_cursor", "That run is not one of this Pip's posts.")
        before = (cursor[0], cursor[1])
    rows = _rows(db, pip_id, limit + 1, before)
    posts = [p for p in (_decode(row) for row in rows[:limit]) if p is not None]
    more = len(rows) > limit
    return {**empty, "posts": list(reversed(posts)),
            "next_before_id": rows[limit - 1]["run_id"] if more else None}


def recent(store, pip_id: str) -> list[dict]:
    """The latest posts, oldest first, as the Pip's next reply reads them: what its own runs said here."""
    if not _has_table(store.db):
        return []
    out = []
    for row in _rows(store.db, pip_id, RECENT):
        value = _decode(row)
        if value is None:
            continue
        item = {k: value[k] for k in ("run_id", "posted_at", "kind", "outcome", "trigger", "text", "total", "counts",
                                      "findings", "checks", "failed_checks", "reason", "title", "next_run_at")
                if k in value}
        if isinstance(value.get("preview"), str):
            item["preview"] = value["preview"][:RECENT_PREVIEW]
        out.append(item)
    return list(reversed(out))


def validate_recent(value) -> list:
    """The conversation context's ``run_posts``, as the worker accepts it."""
    if (not isinstance(value, list) or len(value) > RECENT or any(_valid(v) is None for v in value)
            or len(_json(value).encode()) > 4 * MAX_POST_BYTES):
        raise RegistryError("invalid_history", "The chat's run posts exceed their bounded reference contract.")
    return value


NOTICE = ("run_posts: what your own runs posted in this chat, oldest first. DGC wrote them from each run's saved "
          "result; the user did not say them. Each names its run_id. A post is a summary: read the full report before "
          "you rely on a detail, and never say a later run fixed something unless its report shows it.")

