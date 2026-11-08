"""Routines recover and tell you (Pips package 2, 0.52).

A routine runs while nobody watches, so its trouble has to be handled for the user and said once, plainly.

- **One quiet retry.** A routine's run that fails for a reason a second go can fix (a rate limit, a provider error, a
  crash) starts again by itself, once, as the same run: after 15 seconds, or 60 after a rate limit. It is told to check
  what it already did. Nothing is shown for it: a retry that works looks like a run that worked. Never for a run that
  already sent something, a run the user stopped, or one stuck twice (pip_run_watchdog).
- **What only you can fix is said once.** Signed out, out of credit, a usage limit, a model or tool that isn't set up:
  no retry, since a second go meets the same wall. Each Pip and cause gets one desktop notice (``TROUBLE_KEY``) until a
  run of that Pip works again. A run that keeps failing for any other reason is the same: one notice, not one per run.
- **Every failure leaves a line in its chat.** A failed run's hidden turn carries its reason (pip_chat); a routine
  that couldn't even start (its model signed out, say) has no run, so its Pip's chat gets a note instead (``NOTES_KEY``),
  and the same trouble again adds to that note's count rather than another line. Such a routine tries again after
  ``BLOCKED_RETRY`` rather than on every heartbeat.
- **A missed routine is caught up or said.** Up to ``LATE_LIMIT`` (12 hours) late it runs once; later, its chat gets
  "Missed 8:00; the computer was off" (or, when DGC was running then, why it didn't run) and it waits for its next time.
- **Stay quiet.** A routine told to say something only when there is something to say may reply with only ``QUIET``.
  That reply is kept, shown as one faint line, never counted unread and never notified.
- **One line of health per Pip.** ``health`` says when its routines last ran and how it went, and when they run next,
  or that it can't run and why, with what fixes it.
- **A question that waits a day.** Core mentions it once, in a line of its next reply (``long_waits``).
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone

RETRY_SECONDS = 15
RATE_LIMIT_RETRY_SECONDS = 60
LATE_LIMIT = timedelta(hours=12)
BLOCKED_RETRY = timedelta(minutes=5)       # a routine that couldn't start tries again this often, not every heartbeat
LONG_WAIT = timedelta(hours=24)
QUIET = "NOTHING_NEW"
OWNER_CAUSES = ("signed_out", "credits", "usage_limit", "setup")
RETRY_CAUSES = ("rate_limited", "provider", "failed")
TROUBLE_KEY = "pip_routine_trouble:"       # per Pip: {cause: {"since", "run_id", "said"}}
NOTES_KEY = "pip_routine_notes:"           # per Pip: the lines its chat shows for routines that never ran
TOLD_KEY = "pip_long_waits_told"           # questions Core has mentioned: their attention ids
MAX_NOTES = 20
MAX_TOLD = 400

# A failure's words, judged in this order. The first that matches decides.
_SIGNED_OUT = re.compile(
    r"isn'?t signed in|not signed in|not logged in|signed out|log ?in again|sign ?in again|please (?:run )?/?login"
    r"|authentication[_ ](?:error|failed)|invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key|\b401\b|unauthori[sz]ed"
    r"|oauth token|token (?:has )?expired|credentials? (?:are |is )?(?:expired|invalid|missing)", re.I)
_CREDITS = re.compile(r"credit balance|out of credit|insufficient[ _](?:quota|credit|funds|balance)"
                      r"|exceeded your current quota|billing|payment required|\b402\b", re.I)
_USAGE = re.compile(r"usage limit|hit your (?:\w+ )?limit|limit (?:will )?resets?|weekly limit|session limit"
                    r"|\d+-hour limit|plan limit", re.I)
_RATE = re.compile(r"\b429\b|rate[ _-]?limit|too many requests", re.I)
_SETUP = re.compile(r"isn'?t installed|not installed|no such model|model not found|unknown model|model .*does not exist"
                    r"|\b404\b", re.I)
_PROVIDER = re.compile(r"\b5\d\d\b|overload|service unavailable|bad gateway|internal server error|timed? ?out|timeout"
                       r"|connection (?:refused|reset|error|aborted)|cannot connect|could not connect|unreachable"
                       r"|temporar|try again|empty reply|stream", re.I)
# Codes a second go would only repeat or undo: stopped by the user, stuck twice, cut off after a send, refused.
_FINAL = frozenset(("cancelled", "stalled", "stalled_stopped", "stalled_after_send", "interrupted_after_send",
                    "interrupted", "card_in_chat", "invalid_request", "limit", "paused", "runner_stopped"))
_RETRIED = frozenset(("model_failed", "run_failed", "invalid_reply", "worker_failed", "model_unavailable"))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(value: datetime) -> str:
    """The Pips registry's own form (pip_schedules.timestamp): UTC milliseconds, so stored times compare as text."""
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _instant(value) -> datetime | None:
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _plain(text, limit) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def classify(code, message) -> tuple[str, str]:
    """What a routine's failure is: ("retry", rate_limited|provider|failed), ("owner", signed_out|credits|usage_limit|
    setup) or ("final", its code). ``code`` and ``message`` are the run's error (or a refused start's)."""
    code = str(code or "")
    text = str(message or "")
    if code in _FINAL:
        return "final", code
    if _SIGNED_OUT.search(text):
        return "owner", "signed_out"
    if _CREDITS.search(text):
        return "owner", "credits"
    if _USAGE.search(text):
        return "owner", "usage_limit"
    if _RATE.search(text):
        return "retry", "rate_limited"
    if _SETUP.search(text) or code in ("unsupported_model", "model_not_available", "execution_unavailable"):
        return "owner", "setup"
    if _PROVIDER.search(text):
        return "retry", "provider"
    if code in _RETRIED or not code:
        return "retry", "failed"
    return "final", code


def retry_delay(cause: str) -> int:
    return RATE_LIMIT_RETRY_SECONDS if cause == "rate_limited" else RETRY_SECONDS


def wait_of(seconds) -> float:
    """The pause before a retry. A live check may shorten it (DGC_PIP_RETRY_SECONDS), never lengthen it, never under 1 s."""
    import os
    raw = os.environ.get("DGC_PIP_RETRY_SECONDS", "").strip()
    try:
        shorter = float(raw) if raw else float(seconds)
    except ValueError:
        shorter = float(seconds)
    if shorter != shorter:
        shorter = float(seconds)
    return max(1.0, min(float(seconds), shorter))


def is_quiet(text) -> bool:
    """A routine's reply that is only ``QUIET`` (any case, in marks or quotes, with a full stop)."""
    words = re.sub(r"[\s*_`'\".!]+", "", str(text or ""))
    return words.upper() == QUIET.replace("_", "") or words.upper() == QUIET


# -- Which runs are routines ---------------------------------------------------------------------------------------

def routine_of(db, run_id) -> dict | None:
    """The routine a run's hidden turn was written for: {id, pip_id, title, trigger}, or None for any other run."""
    try:
        turn = db.execute("SELECT pip_id,request_key FROM pip_chat_messages WHERE run_id=? AND role='user'",
                          (str(run_id),)).fetchone()
        if turn is None or not str(turn[1] or "").startswith("routine_"):
            return None
        tail = str(turn[1])[len("routine_"):].rsplit("_", 1)[0]
        row = db.execute("SELECT id,pip_id,title,trigger FROM pip_routines WHERE pip_id=? AND substr(id,-16)=?",
                         (turn[0], tail)).fetchone()
    except sqlite3.Error:
        return None
    if row is None:
        return {"id": "", "pip_id": turn[0], "title": "", "trigger": {}}
    try:
        trigger = json.loads(row[3])
    except (TypeError, ValueError):
        trigger = {}
    return {"id": row[0], "pip_id": row[1], "title": row[2], "trigger": trigger}


def _pip_name(db, pip_id) -> str:
    try:
        row = db.execute("SELECT json_extract(v.definition,'$.name') FROM pips p JOIN pip_versions v ON v.pip_id=p.id "
                         "AND v.version=p.current_version WHERE p.id=?", (pip_id,)).fetchone()
    except sqlite3.Error:
        row = None
    return _plain(row[0] if row and row[0] else "Your Pip", 60)


def first_sentence(text, limit=160) -> str:
    """The reason in a failure's own words, its first sentence: what a line and a notice say."""
    text = _plain(text, 600)
    end = re.search(r"(?<=[.!?])\s", text)
    return _plain(text[:end.start()] if end else text, limit)


# -- Trouble: what was said once ------------------------------------------------------------------------------------

def _read(db, key, default):
    try:
        row = db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        value = json.loads(row[0]) if row is not None and len(row[0]) <= 65536 else default
    except (sqlite3.Error, TypeError, ValueError):
        return default
    return value if isinstance(value, type(default)) else default


def _write(db, key, value) -> None:
    if value:
        db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (key, json.dumps(value, sort_keys=True)))
    else:
        db.execute("DELETE FROM metadata WHERE key=?", (key,))


def troubles(db, pip_id) -> dict:
    """{cause: {since, run_id, said, routine}} for a Pip whose routines are in trouble now."""
    value = _read(db, TROUBLE_KEY + str(pip_id), {})
    return {cause: item for cause, item in value.items()
            if cause in OWNER_CAUSES + RETRY_CAUSES and isinstance(item, dict) and isinstance(item.get("since"), str)}


def note_trouble(db, pip_id, cause, *, since, said, routine="", run_id="") -> bool:
    """Remember a Pip's routine trouble, in the caller's transaction. True when it is new: the one time it is told."""
    held = troubles(db, pip_id)
    if cause in held:
        return False
    held[cause] = {"since": since, "said": _plain(said, 300), "routine": _plain(routine, 160), "run_id": str(run_id)}
    _write(db, TROUBLE_KEY + str(pip_id), held)
    return True


def clear_trouble(db, pip_id) -> None:
    """A run of this Pip worked: what it was told about is over, and the next trouble is told again."""
    try:
        db.execute("DELETE FROM metadata WHERE key=?", (TROUBLE_KEY + str(pip_id),))
    except sqlite3.Error:
        pass


def all_troubles(db, limit=50) -> list[dict]:
    """Every Pip's routine trouble, for the desktop notice: [{id, pip_id, cause, since, said}], newest first."""
    found = []
    try:
        rows = db.execute("SELECT key FROM metadata WHERE key LIKE ? ESCAPE '\\' LIMIT 500",
                          (TROUBLE_KEY.replace("_", "\\_") + "%",)).fetchall()
    except sqlite3.Error:
        return []
    for (key,) in rows:
        pip_id = key[len(TROUBLE_KEY):]
        for cause, item in troubles(db, pip_id).items():
            found.append({"id": f"trouble:{pip_id}:{cause}:{item['since']}", "pip_id": pip_id, "cause": cause,
                          "since": item["since"], "said": item.get("said") or ""})
    found.sort(key=lambda item: item["since"], reverse=True)
    return found[:limit]


def reason_words(cause, reason) -> str:
    """Why, in a sentence a person reads: a model request's raw answer in words (model_errors.plain_failure), else its
    first sentence. The raw answer stays on the run, for Details."""
    from .model_errors import plain_failure
    said = plain_failure(reason)
    if said == str(reason or ""):
        said = {"rate_limited": "the model provider is limiting requests",
                "provider": "the model provider had a problem on its side"}.get(cause) or first_sentence(reason)
    said = first_sentence(said)
    return said if said.endswith((".", "!", "?", "…")) else said + "."


def notice_words(db, pip_id, cause, reason, title) -> str:
    """What the one desktop notice says."""
    name = _pip_name(db, pip_id)
    what = f"“{_plain(title, 60)}”" if title else "its routine"
    if cause in OWNER_CAUSES:
        return f"{name} can't run {what}: {reason_words(cause, reason)}"
    return f"{name}'s routine {what} keeps failing: {reason_words(cause, reason)}"


def after_run(registry, row, error) -> None:
    """After a run ends (pips._run_claimed): a routine's failure that is final is remembered once per Pip and cause
    for its notice; any run of the Pip that worked ends its trouble."""
    db = registry.db
    if error is None:
        with registry.transaction():
            clear_trouble(db, row["pip_id"])
        return
    routine = routine_of(db, row["id"])
    if routine is None:
        return
    code = error.get("code") if isinstance(error, dict) else ""
    message = error.get("message") if isinstance(error, dict) else ""
    kind, cause = classify(code, message)
    if kind == "final" and cause in ("cancelled",):
        return                                  # the user stopped it: nothing to tell them
    if kind == "final":
        cause = "failed"
    with registry.transaction():
        note_trouble(db, row["pip_id"], cause, since=stamp(_now()), run_id=row["id"], routine=routine["title"],
                     said=notice_words(db, row["pip_id"], cause, message, routine["title"]))


# -- Notes: a routine that never ran ---------------------------------------------------------------------------------

def notes(db, pip_id) -> list[dict]:
    """The lines a Pip's chat shows for its routines that didn't run, oldest first:
    [{id, kind: missed|blocked, routine_id, title, due, at, text, count}]."""
    held = _read(db, NOTES_KEY + str(pip_id), [])
    keep = []
    for item in held:
        if (isinstance(item, dict) and item.get("kind") in ("missed", "blocked") and isinstance(item.get("id"), str)
                and isinstance(item.get("at"), str) and isinstance(item.get("text"), str)):
            keep.append({"id": item["id"][:80], "kind": item["kind"], "routine_id": str(item.get("routine_id") or "")[:80],
                         "title": _plain(item.get("title"), 160), "due": str(item.get("due") or "")[:40],
                         "at": item["at"][:40], "text": _plain(item["text"], 300),
                         "count": item["count"] if type(item.get("count")) is int and item["count"] > 0 else 1})
    return keep[-MAX_NOTES:]


def add_note(db, pip_id, *, kind, routine_id, title, due, text, now) -> dict:
    """One line in a Pip's chat, in the caller's transaction. The same trouble for the same routine, with no other note
    since, adds to the last one's count instead of a second line: once per time it was due, however often it is tried."""
    held = notes(db, pip_id)
    text = _plain(text, 300)
    at = stamp(now)
    last = held[-1] if held else None
    if last and last["kind"] == kind and last["routine_id"] == routine_id and last["text"] == text:
        if last["due"] != due:
            last["count"] += 1
            last["due"], last["at"] = due, at
        note = last
    else:
        note = {"id": f"note_{routine_id[-12:]}_{at}", "kind": kind, "routine_id": routine_id, "title": _plain(title, 160),
                "due": due, "at": at, "text": text, "count": 1}
        held.append(note)
    _write(db, NOTES_KEY + str(pip_id), held[-MAX_NOTES:])
    return note


def couldnt_start(registry, row, exc, *, due, now) -> None:
    """A routine whose turn was refused before any run began: one note in its chat, one notice for its Pip."""
    kind, cause = classify(getattr(exc, "code", ""), str(exc))
    reason = reason_words(cause, str(exc)) if str(exc).strip() else "It couldn't start."
    with registry.transaction():
        add_note(registry.db, row["pip_id"], kind="blocked", routine_id=row["id"], title=row["title"], due=due,
                 now=now, text=f"Couldn't start: {reason}")
        note_trouble(registry.db, row["pip_id"], cause if kind == "owner" else "failed", since=stamp(now),
                     routine=row["title"], said=notice_words(registry.db, row["pip_id"],
                                                             cause if kind == "owner" else "failed", str(exc), row["title"]))


def awake_since(db) -> datetime | None:
    """Since when the runner has been running without a gap (pip_daemon keeps it with its heartbeat)."""
    try:
        row = db.execute("SELECT value FROM metadata WHERE key='pips_supervisor'").fetchone()
        value = json.loads(row[0]) if row else {}
    except (sqlite3.Error, TypeError, ValueError):
        return None
    return _instant(value.get("awake_since") or value.get("started_at")) if isinstance(value, dict) else None


def missed_words(db, due: datetime, zone: str | None, pip_id: str = "") -> str:
    """"Missed 8:00; the computer was off", in the routine's own time zone. When the runner was running then, why it
    didn't run: Pips were turned off, or this Pip was paused."""
    from zoneinfo import ZoneInfo
    try:
        local = due.astimezone(ZoneInfo(zone)) if zone else due
    except Exception:                       # noqa: BLE001 - an unknown zone reads in UTC
        local = due
    when = f"{local.hour}:{local.minute:02d}"
    at = stamp(due)

    def last_before(sql, *params):
        try:
            row = db.execute(sql + " AND created_at<=? ORDER BY seq DESC LIMIT 1", (*params, at)).fetchone()
        except sqlite3.Error:
            return None
        return row
    runtime = last_before("SELECT event_type FROM workspace_events WHERE event_type IN "
                          "('pip_runtime_stopped','pip_runtime_resumed')")
    if runtime is not None and runtime[0] == "pip_runtime_stopped":
        return f"Missed {when}; Pips were turned off then"
    status = last_before("SELECT payload FROM workspace_events WHERE event_type='pip_status_changed' AND pip_id=?", pip_id)
    try:
        if status is not None and json.loads(status[0]).get("status") == "paused":
            return f"Missed {when}; it was paused then"
    except (TypeError, ValueError, AttributeError):
        pass
    since = awake_since(db)
    if since is not None and since <= due:
        return f"Missed {when}; it was busy then"
    return f"Missed {when}; the computer was off"


# -- Health ---------------------------------------------------------------------------------------------------------

def _brain_engine(db, pip_id) -> str:
    """The subscription CLI the Pip's last run used ("claude", "codex"), or ""."""
    try:
        row = db.execute("SELECT CASE WHEN length(CAST(manifest AS BLOB))<=131072 THEN manifest END FROM pip_runs "
                         "WHERE pip_id=? ORDER BY created_at DESC,id DESC LIMIT 1", (pip_id,)).fetchone()
        manifest = json.loads(row[0]) if row and row[0] else {}
    except (sqlite3.Error, TypeError, ValueError):
        return ""
    brain = (manifest.get("model_settings") or {}).get("brain") if isinstance(manifest, dict) else None
    return str(brain.get("engine") or "") if isinstance(brain, dict) else ""


def _fix(cause, text, engine) -> dict | None:
    if cause == "signed_out":
        found = re.search(r"\b(claude|codex)\b", text, re.I)
        key = engine or (found.group(1).lower() if found else "")
        if key in ("claude", "codex"):
            from .subscriptions import get_engine
            sub = get_engine(key)
            return {"kind": "sign_in", "engine": key, "name": sub.short_label if sub else key,
                    "command": "claude" if key == "claude" else "codex login"}
        return {"kind": "model"}
    if cause in ("credits", "usage_limit", "setup"):
        return {"kind": "model"}
    return None


def _blocked_words(cause, text, engine) -> str:
    if cause == "signed_out":
        found = re.match(r"\s*(.+?) isn'?t signed in", text or "")
        if found and len(found.group(1)) <= 40:
            return f"{found.group(1)} signed out"
        if engine:
            from .subscriptions import get_engine
            sub = get_engine(engine)
            return f"{sub.short_label if sub else engine} signed out"
        return "its model is signed out"
    if cause == "credits":
        return "its model is out of credit"
    if cause == "usage_limit":
        return "its model reached its usage limit"
    return reason_words(cause, text).rstrip(".") if text else "it isn't set up"


def health(db, pip_id) -> dict | None:
    """One line's worth of a Pip's routines, or None when it has none on: {last: {at, outcome} | None, next_at,
    blocked: {cause, text, fix} | None}. outcome: worked | nothing_new | failed | missed | running."""
    try:
        on = db.execute("SELECT id,next_due_at FROM pip_routines WHERE pip_id=? AND status='on'", (pip_id,)).fetchall()
    except sqlite3.Error:
        return None
    if not on:
        return None
    upcoming = sorted(str(row[1]) for row in on if row[1])
    last = None
    try:
        run = db.execute("""SELECT r.id,r.status,coalesce(r.finished_at,r.started_at,r.created_at),
            (SELECT a.text FROM pip_chat_messages a WHERE a.run_id=r.id AND a.role='assistant')
            FROM pip_chat_messages u JOIN pip_runs r ON r.id=u.run_id
            WHERE u.pip_id=? AND u.role='user' AND u.request_key LIKE 'routine\\_%' ESCAPE '\\'
            ORDER BY u.seq DESC LIMIT 1""", (pip_id,)).fetchone()
    except sqlite3.Error:
        run = None
    if run is not None:
        status, reply = run[1], run[3]
        outcome = ("running" if status in ("queued", "running", "cancelling") else
                   ("nothing_new" if is_quiet(reply) else "worked") if status == "succeeded" else "failed")
        last = {"at": str(run[2]), "outcome": outcome}
    missed = [note for note in notes(db, pip_id) if note["kind"] == "missed"]
    if missed and (last is None or missed[-1]["at"] > last["at"]):
        last = {"at": missed[-1]["due"] or missed[-1]["at"], "outcome": "missed"}
    blocked = None
    held = troubles(db, pip_id)
    for cause in OWNER_CAUSES:
        if cause in held:
            engine = _brain_engine(db, pip_id)
            if cause == "signed_out" and engine:
                from .pip_brain import available
                try:
                    if not available(engine):
                        continue                # signed in again since: its next run will tell
                except Exception:               # noqa: BLE001 - can't tell: say what was seen
                    pass
            text = held[cause].get("said") or ""
            reason = text.split(": ", 1)[1] if ": " in text else text
            blocked = {"cause": cause, "text": _blocked_words(cause, reason, engine), "fix": _fix(cause, reason, engine)}
            break
    return {"last": last, "next_at": upcoming[0] if upcoming else None, "blocked": blocked}


# -- Core mentions a question that has waited a day ------------------------------------------------------------------

def _waited(since: datetime, now: datetime) -> str:
    days = int((now - since) / LONG_WAIT)
    return "since yesterday" if days <= 1 else f"for {days} days"


def long_waits(registry, now: datetime, limit=3) -> list[dict]:
    """What the user's Personal Pips have waited on for a day or more and Core hasn't mentioned yet, oldest first:
    [{id, pip, what, waited}]."""
    from . import pip_attention
    try:
        waiting = pip_attention.collect(registry, stamp(now))
    except Exception:                           # noqa: BLE001 - a mention never costs the reply
        return []
    told = set(_read(registry.db, TOLD_KEY, []))
    found = []
    for item in waiting.get("items") or []:
        created = _instant(item.get("created_at"))
        if created is None or now - created < LONG_WAIT or item.get("id") in told:
            continue
        name = item.get("pip_name") or _pip_name(registry.db, item.get("pip_id"))
        found.append({"id": str(item["id"])[:160], "pip": _plain(name, 60), "what": _plain(item.get("title"), 160),
                      "waited": _waited(created, now), "created_at": item.get("created_at")})
    found.sort(key=lambda item: str(item["created_at"]))
    return [{key: item[key] for key in ("id", "pip", "what", "waited")} for item in found[:limit]]


def mark_told(db, ids) -> None:
    """Core said these, in the caller's transaction: never again."""
    ids = [str(i)[:160] for i in ids or [] if isinstance(i, str)]
    if not ids:
        return
    held = [i for i in _read(db, TOLD_KEY, []) if isinstance(i, str) and i not in ids]
    _write(db, TOLD_KEY, (held + ids)[-MAX_TOLD:])


SAY_LONG_WAITS = ("long_waits: questions the user's other Pips have waited on for a day or more. Unless you already "
                  "said so in this conversation, say it in one plain line of your reply: which Pip waits, on what, for "
                  "how long, and that they can answer in that Pip's chat. It is a sentence in your reply, not a card or a "
                  "new question; then go on with what they asked.")
