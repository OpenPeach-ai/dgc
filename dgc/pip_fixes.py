"""What a Pip found, and what became of it: the fix by level, in the Pip's own chat (0.52, Pips API 96).

pips-flow-design §1 and Q3 (agreed 14 Nov): a Pip's chat is its home. When a check finds something, the Pip's level
decides what happens next, and there is no "Fix it" card and no hidden Work session:

  Ask me first      a fix waits at the ordinary Allow card (Allow · Not now)
  Approve for me    it starts fixing in its own copy by itself, new findings only (his yes); the change waits at Apply
  Do it all         it fixes and applies by itself, with Undo, never over a file you changed ("Do it all applies all":
                    his no to a size, delete or test fuse, 14 Nov); the card says when its tests failed in its copy

A fix is an ordinary turn of that Pip in its own chat (a message from DGC under FIX_KEY, like a routine's), so it runs
in its own computer on its own copy of the folder, with its own helpers, and its change is the copy's change card
(pip_project_copies: Apply, Review, Discard; Undo once it is in). The turn ends with one verdict line per finding
(``FINDING n: fixed | already fixed | not a defect | needs you — why``) and ``TESTS: passed | failed | not run``.

Guards for a fix nobody watched: one try per finding (a finding that comes back after a fix is asked about, at every
level, and marked "back"); a finding you said Not now to, or that it found is not a defect, is not asked about again;
one fix at a time per Pip. What only you can do (a verdict "needs you") becomes one waiting item: one line at the top
of its chat and one row in Needs attention, with I've done it · Remind me later · Not a problem. A waiting item never
pauses the Pip (his question 14 Nov): its routines and checks go on.

This module keeps the records and derives what each fix is now from its turn and its change; the turn itself is sent
by ``send_due`` (the supervisor's tick, or at once from Allow).
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
from datetime import datetime, timedelta, timezone

from .workspace_registry import RegistryError

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_fixes(
 id TEXT PRIMARY KEY, pip_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('ask','declined','queued','ended')),
 findings TEXT NOT NULL CHECK(length(CAST(findings AS BLOB))<=131072), count INTEGER NOT NULL,
 asked_at TEXT, decided_at TEXT, by TEXT, fix_run_id TEXT, started_at TEXT, change_id TEXT,
 tests TEXT, message TEXT, note TEXT, revision INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS pip_fixes_pip ON pip_fixes(pip_id,created_at);
CREATE TABLE IF NOT EXISTS pip_waiting(
 id TEXT PRIMARY KEY, pip_id TEXT NOT NULL, workspace_id TEXT NOT NULL, fix_id TEXT, identity TEXT NOT NULL,
 title TEXT NOT NULL, blocks TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('waiting','later','done','dismissed')),
 since TEXT NOT NULL, remind_at TEXT, answered_at TEXT, previous TEXT, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, UNIQUE(pip_id,identity));
CREATE INDEX IF NOT EXISTS pip_waiting_pip ON pip_waiting(pip_id,state);
"""
FIX_KEY = "dgcfix_"                    # the fix turn's message key (pip_chat.DGC_KEYS): FIX_KEY + the fix's 32 hex
FIX = re.compile(r"pipfix_[0-9a-f]{32}\Z")
WAIT = re.compile(r"pipwait_[0-9a-f]{32}\Z")
CHANGE = re.compile(r"pchange_[0-9a-f]{32}\Z")
STATES = ("ask", "declined", "queued", "running", "ready", "applied", "held", "unchanged", "failed", "stopped",
          "interrupted", "undone", "discarded")
VERDICTS = ("open", "fixed", "already_fixed", "not_a_defect", "needs_you")
MAX_FINDINGS = 16
MAX_LISTED = 100
MAX_WAITING = 50
REMIND_AFTER = timedelta(days=1)       # Remind me later: back tomorrow (the one-day nudge)
UNDO_SECONDS = 10 * 60                 # an answer to a waiting item can be undone for ten minutes
LOCAL = ("editor-user", "local-console")
LEVEL_BY = {"approve": "pip-level:approve", "full": "pip-level:full"}
_VERDICT_LINE = re.compile(r"^\s*FINDING\s+(\d{1,2})\s*:\s*(fixed|already fixed|not a defect|needs you)\b\s*[—–:-]?\s*(.*)$",
                           re.IGNORECASE | re.MULTILINE)
_TESTS_LINE = re.compile(r"^\s*TESTS\s*:\s*(passed|failed|not run)\b", re.IGNORECASE | re.MULTILINE)
_RESULT_LINE = re.compile(r"^\s*RESULT\s*:\s*(PASS|RETRY)\b", re.IGNORECASE)        # the Pip's check (pip_agents)
FIX_TEXT = (
    "This message is from DGC, not the user. Fix what your check found, in your own copy of {folder} on your "
    "computer: the user's real folder is untouched until your change is applied. The findings:\n{findings}\n"
    "Work only on these. Change only what each needs; never change live data or services, and never commit, push or "
    "deploy. If the project has tests you can run in your copy, run them. Then say in a few short sentences what was "
    "wrong, what you changed, and what you left alone and why. End your reply with one line per finding, "
    "\"FINDING n: fixed\", \"FINDING n: already fixed\", \"FINDING n: not a defect\" or \"FINDING n: needs you\", "
    "each followed by \" — \" and why in a few words (\"needs you\" is for what only the user can do: data, money, an "
    "account), and one line \"TESTS: passed\", \"TESTS: failed\" or \"TESTS: not run\".")


# ---- records ------------------------------------------------------------------------------------------------------
def ensure(db) -> None:
    for statement in (part.strip() for part in SCHEMA.split(";")):
        if statement:
            db.execute(statement)


def _has(db) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_fixes'").fetchone() is not None


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _load(text, fallback):
    try:
        value = json.loads(text) if text else fallback
    except (ValueError, TypeError, RecursionError):
        return fallback
    return value if isinstance(value, type(fallback)) else fallback


def _now(registry) -> str:
    return registry.clock()


def _instant(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _clip(value, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def identity(finding: dict) -> str:
    """The same issue across checks: its file, the code it quotes and its title (pip_checkpoints' identity), so a fix
    asked about once is not asked about again by the next night's check."""
    source = {key: finding.get(key) for key in ("path", "evidence", "title")}
    return hashlib.sha256(_json(source).encode()).hexdigest()


def _issue(finding: dict) -> tuple:
    """A looser match for a reworded title: the same file and the same quoted code (pip_checkpoints._issue)."""
    return (finding.get("path"), " ".join(str(finding.get("evidence") or "").split()))


def digest(row) -> str:
    return hashlib.sha256(_json([row["id"], row["state"], row["revision"], row["findings"]]).encode()).hexdigest()[:32]


# ---- what each fix is now -------------------------------------------------------------------------------------------
def _turn(db, row):
    """The fix's turn: its run row, found by the run id kept or by the message DGC sent under its key."""
    run_id = row["fix_run_id"]
    if not run_id:
        found = db.execute("SELECT run_id FROM pip_chat_messages WHERE pip_id=? AND request_key=? AND run_id IS NOT NULL "
                           "LIMIT 1", (row["pip_id"], FIX_KEY + row["id"][7:])).fetchone() if _table(db, "pip_chat_messages") else None
        run_id = found[0] if found else None
    if not run_id:
        return None
    return db.execute("SELECT id,status,started_at,created_at,finished_at,"
                      "CASE WHEN length(CAST(error AS BLOB))<=16384 THEN error END AS error,"
                      "json_extract(CASE WHEN json_valid(result) THEN result END,'$.usage.input_tokens') AS input_tokens,"
                      "json_extract(CASE WHEN json_valid(result) THEN result END,'$.usage.output_tokens') AS output_tokens "
                      "FROM pip_runs WHERE id=?", (run_id,)).fetchone()


def _agent(db, row):
    """The fix's sub-agent job (pip_agents), the newest, or None."""
    if not _table(db, "pip_agent_jobs"):
        return None
    return db.execute("SELECT * FROM pip_agent_jobs WHERE fix_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1", (row["id"],)).fetchone()


def _table(db, name) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def _change_status(db, change_id):
    if not change_id or not _table(db, "pip_project_changes"):
        return None
    row = db.execute("SELECT status FROM pip_project_changes WHERE id=?", (change_id,)).fetchone()
    return row[0] if row else None


def _state(db, row, run=None, change=None) -> str:
    """ask, declined, queued, running, ready, applied, held, unchanged, failed, stopped, interrupted, undone, discarded."""
    if row["state"] in ("ask", "declined"):
        return row["state"]
    if row["state"] == "queued" and run is None:
        return "queued"
    if run is not None and run["status"] == "queued":
        return "queued"
    if run is not None and run["status"] in ("running", "cancelling"):
        return "running"
    if row["note"] == "gone":
        return "unchanged"
    if run is not None and run["status"] == "cancelled":
        return "stopped"
    if run is not None and run["status"] == "failed":
        error = _load(run["error"], {})
        return "interrupted" if str(error.get("code") or "").startswith(("interrupted", "stalled")) else "failed"
    change = change if change is not None else _change_status(db, row["change_id"])
    return {"pending": "ready", "applied": "applied", "partial": "held", "not_applied": "held",
            "discarded": "discarded", "undone": "undone"}.get(change, "unchanged" if run is not None or row["state"] == "ended" else "queued")


def _steps(db, run) -> list:
    """What the fix is doing, step by step. Not kept yet: the live card says what it is doing from the run's progress
    events, and Steps opens its trace."""
    return []


def view(db, row) -> dict:
    run = _turn(db, row)
    state = _state(db, row, run)
    job = _agent(db, row)
    if job is not None:
        from . import pip_agents
        if job["state"] in pip_agents.LIVE and row["state"] != "ended":
            state = "running"                                # its sub-agent works, or its Pip checks the work
        elif job["state"] in ("held", "stopped", "asked", "left", "failed"):
            state = job["state"]                             # asked: after its last try (Try again · Leave it)
    out = {"id": row["id"], "run_id": row["run_id"], "state": state, "count": row["count"], "digest": digest(row),
           "asked_at": row["asked_at"], "decided_at": row["decided_at"], "by": row["by"] or "",
           "fix_run_id": run["id"] if run is not None else None,
           "started_at": (run["started_at"] or run["created_at"]) if run is not None else row["started_at"],
           "helpers": 0, "steps": _steps(db, run), "change_id": row["change_id"],
           "findings": [{key: f.get(key) for key in ("id", "title", "path", "line", "severity", "state", "verdict", "why")
                         if f.get(key) not in (None, "")} for f in _load(row["findings"], [])][:MAX_FINDINGS]}
    for finding in out["findings"]:
        finding.setdefault("verdict", "open")
    if row["tests"] in ("passed", "failed"):
        out["tests"] = row["tests"]
    if run is not None:
        used = sum(v for v in (run["input_tokens"], run["output_tokens"]) if type(v) is int and v >= 0)
        if used:
            out["tokens"] = used                 # what the fix cost (his answer 1, 14 Nov: cost shown)
    if job is not None:
        from . import pip_agents
        out["agent"] = pip_agents.view(db, job)              # its sub-agent: try n of 3, what it is doing, its model
        out["helpers"] = 1 if job["state"] in pip_agents.LIVE else 0
    message = row["message"] or ("The last check no longer finds these." if row["note"] == "gone" else "")
    if not message and state == "ask":
        # The Pip asks in its own words above the Allow card (the live check of 14 Nov found it never did).
        message = _asks(row["count"])
    if message:
        out["message"] = _clip(message, 600)
    return out


_COUNT_WORDS = ("", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten")


def _asks(count) -> str:
    if count == 1:
        return "Want me to fix this?"
    return f"Want me to fix these {_COUNT_WORDS[count] if 0 < count < len(_COUNT_WORDS) else count}?"


def _rows(db, pip_id):
    return db.execute("SELECT * FROM pip_fixes WHERE pip_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?",
                      (pip_id, MAX_LISTED)).fetchall()


def _waiting_view(row, now) -> dict:
    answered = _instant(row["answered_at"])
    current = _instant(now)
    out = {"id": row["id"], "title": row["title"], "blocks": row["blocks"], "since": row["since"], "state": row["state"],
           "can_undo": bool(row["state"] != "waiting" and answered is not None and current is not None
                            and (current - answered).total_seconds() <= UNDO_SECONDS)}
    if row["remind_at"]:
        out["remind_at"] = row["remind_at"]
    return out


def _refresh_waiting(registry, pip_id) -> None:
    """Remind me later is back once its day is over: the one-day nudge."""
    now = _now(registry)
    registry.db.execute("UPDATE pip_waiting SET state='waiting',remind_at=NULL,previous=NULL,updated_at=? "
                        "WHERE pip_id=? AND state='later' AND remind_at<=?", (now, pip_id, now))


def listing(store, pip_id) -> dict:
    """list_pip_fixes: {pip_id, folder, fixes (oldest first), waiting}."""
    registry, db = store.registry, store.db
    pip = store._job(pip_id)
    with registry.transaction():
        ensure(db)
        _refresh_waiting(registry, pip_id)
    folder = ""
    row = db.execute("SELECT name FROM workspaces WHERE id=?", (pip["workspace_id"],)).fetchone()
    if row is not None and pip.get("source_policy") != {"mode": "personal"}:
        folder = _clip(row[0], 200)
    now = _now(registry)
    from .pip_holds import asked_refs
    asked = {ref.split(":", 1)[1] for ref in asked_refs(db) if ref.startswith("fix:")}
    # One asked in its chat at Do it all has no card there (pip_holds.ask); once answered it shows as it goes.
    fixes = [view(db, r) for r in reversed(_rows(db, pip_id)) if not (r["state"] == "ask" and r["id"] in asked)]
    waiting = [_waiting_view(r, now) for r in db.execute(
        "SELECT * FROM pip_waiting WHERE pip_id=? AND (state IN ('waiting','later') OR updated_at>=?) "
        "ORDER BY since,id LIMIT ?", (pip_id, _iso(_instant(now) - timedelta(days=1)) if _instant(now) else now,
                                      MAX_WAITING)).fetchall()]
    return {"pip_id": pip_id, "folder": folder, "fixes": fixes, "waiting": waiting}


# ---- a check ended: what to fix -------------------------------------------------------------------------------------
def _earlier(db, pip_id) -> dict:
    """identity -> what became of it in this Pip's earlier fixes: "asked" (still waiting), "declined", "fixed",
    "not_a_defect", "needs_you", "tried" (a turn ran, no verdict); and the loose (file, code) matches for rewording."""
    seen, loose = {}, {}
    rank = {"failed": 0, "tried": 1, "asked": 2, "needs_you": 3, "declined": 4, "not_a_defect": 5, "fixed": 6}
    for row in db.execute("SELECT * FROM pip_fixes WHERE pip_id=? ORDER BY created_at,rowid", (pip_id,)).fetchall():
        # A fix whose turn failed, was stopped or interrupted didn't really try: its findings may be asked about again.
        broke = row["state"] == "ended" and _state(db, row, _turn(db, row)) in ("failed", "stopped", "interrupted")
        for finding in _load(row["findings"], []):
            if not isinstance(finding, dict) or not finding.get("identity"):
                continue
            verdict = finding.get("verdict")
            what = ("declined" if row["state"] == "declined" else "asked" if row["state"] == "ask"
                    else "fixed" if verdict in ("fixed", "already_fixed") else verdict if verdict in ("not_a_defect", "needs_you")
                    else "failed" if broke else "tried")
            for table, key in ((seen, finding["identity"]), (loose, (finding.get("path"), finding.get("issue")))):
                if rank[what] >= rank.get(table.get(key), 0):
                    table[key] = what
    return {"seen": seen, "loose": loose}


def _what_was(earlier, finding) -> str | None:
    return earlier["seen"].get(finding["identity"]) or earlier["loose"].get((finding.get("path"), finding.get("issue")))


def _boxed_folder_pip(store, pip_id) -> dict | None:
    from .pips import has_box
    try:
        pip = store._job(pip_id)
    except RegistryError:
        return None
    if pip.get("source_policy") == {"mode": "personal"} or not has_box(pip):
        return None
    return pip


def after_check(store, run, result) -> str | None:
    """A check (an audit) ended well: the findings it has not asked about become a fix, by the Pip's level. Returns
    the fix's id, or None (nothing new to fix, a fix already under way, or a Pip with no box to fix in)."""
    if not isinstance(result, dict) or not isinstance(result.get("findings"), list) or not result["findings"]:
        return None
    pip = _boxed_folder_pip(store, run["pip_id"])
    if pip is None:
        return None
    registry, db = store.registry, store.db
    from . import pip_levels
    from .pip_report_delivery import continuity_of, _compared
    raw = [f for f in result["findings"] if isinstance(f, dict)][:MAX_FINDINGS]
    states = continuity_of(db, run["id"], len(result["findings"]))
    states = (["new" if same is None else "still" for same in states] if states is not None
              else _compared(db, run["id"], len(result["findings"])))
    with registry.transaction():
        ensure(db)
        earlier = _earlier(db, run["pip_id"])
        open_fix = db.execute("SELECT * FROM pip_fixes WHERE pip_id=? AND state IN ('ask','queued') ORDER BY created_at DESC,rowid DESC "
                              "LIMIT 1", (run["pip_id"],)).fetchone()
        if open_fix is not None and open_fix["state"] == "queued":
            turn = _turn(db, open_fix)
            if turn is None or turn["status"] not in ("succeeded", "failed", "cancelled"):
                return None                              # one fix at a time: the next check after it ends asks
            # Its turn ended but its end was never recorded: settle it from the turn, so it never blocks the next.
            db.execute("UPDATE pip_fixes SET state='ended',fix_run_id=?,revision=revision+1,updated_at=? WHERE id=?",
                       (turn["id"], _now(registry), open_fix["id"]))
            open_fix = None
        busy = db.execute("SELECT id,change_id FROM pip_fixes WHERE pip_id=? AND state='ended' AND change_id IS NOT NULL "
                          "ORDER BY created_at DESC,rowid DESC LIMIT 1", (run["pip_id"],)).fetchone()
        if busy is not None and _change_status(db, busy["change_id"]) == "pending":
            return None                                  # its last fix still waits at Apply
        chosen = []
        for index, finding in enumerate(raw):
            item = {"id": f"finding_{index + 1}", "index": index, "title": _clip(finding.get("title"), 300),
                    "path": finding.get("path") if isinstance(finding.get("path"), str) else None,
                    "line": finding.get("line") if type(finding.get("line")) is int else None,
                    "severity": finding.get("severity") if finding.get("severity") in ("critical", "high", "medium", "low") else "low",
                    "evidence": str(finding.get("evidence") or "")[:2000], "identity": identity(finding),
                    "issue": " ".join(str(finding.get("evidence") or "").split())[:2000],
                    "state": (states[index] if states is not None and index < len(states) else "new")}
            was = _what_was(earlier, item)
            if was in ("declined", "not_a_defect", "needs_you", "asked", "tried"):
                continue                                 # asked once, or not for fixing: never asked again
            if was == "fixed":
                item["state"] = "back"                   # fixed before and found again: asked, never fixed again by itself
            if was == "failed":
                item["retry"] = True                     # its fix failed: asked again, never rerun by itself
            chosen.append(item)
        if open_fix is not None:
            # Its Allow card still waits: it asks about what this check still finds, and what is new since.
            ids = {identity(r) for r in raw}
            issues = {(r.get("path"), " ".join(str(r.get("evidence") or "").split())[:2000]) for r in raw}
            kept = [f for f in _load(open_fix["findings"], []) if isinstance(f, dict)
                    and (f.get("identity") in ids or (f.get("path"), f.get("issue")) in issues)]
            merged = kept + [c for c in chosen if c["identity"] not in {k.get("identity") for k in kept}]
            now = _now(registry)
            if not merged:
                db.execute("UPDATE pip_fixes SET state='ended',note='gone',revision=revision+1,updated_at=? WHERE id=?",
                           (now, open_fix["id"]))
                return None
            for number, item in enumerate(merged, 1):
                item["id"] = f"finding_{number}"
            db.execute("UPDATE pip_fixes SET findings=?,count=?,run_id=?,revision=revision+1,updated_at=? WHERE id=?",
                       (_json(merged[:MAX_FINDINGS]), min(len(merged), MAX_FINDINGS), run["id"], now, open_fix["id"]))
            return open_fix["id"]
        if not chosen:
            return None
        level = pip_levels.effective(registry, run["pip_id"])
        back = any(item["state"] == "back" or item.get("retry") for item in chosen)     # these always ask
        if level == pip_levels.APPROVE and not back:
            fresh = [item for item in chosen if item["state"] == "new"]
            if not fresh:
                return None                              # Approve for me fixes new findings only (his yes, 14 Nov)
            chosen = fresh
        for number, item in enumerate(chosen, 1):
            item["id"] = f"finding_{number}"
        by_level = level in (pip_levels.APPROVE, pip_levels.FULL) and not back
        now = _now(registry)
        fix_id = "pipfix_" + secrets.token_hex(16)
        db.execute("INSERT INTO pip_fixes(id,pip_id,workspace_id,run_id,state,findings,count,asked_at,decided_at,by,"
                   "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                   (fix_id, run["pip_id"], run["workspace_id"], run["id"], "queued" if by_level else "ask",
                    _json(chosen), len(chosen), now, now if by_level else None,
                    LEVEL_BY.get(level) if by_level else None, now, now))
        registry.event(run["workspace_id"], "pip_fix_" + ("queued" if by_level else "asked"), pip_id=run["pip_id"],
                       run_id=run["id"], payload={"fix_id": fix_id, "count": len(chosen)})
        if not by_level and level == pip_levels.FULL:
            # At Do it all, asked in its chat instead of a card (his rule, 17 Nov): what came back after a fix is never
            # fixed again by itself. The supervisor's next pass sends the turn that asks (pip_holds.announce_due).
            from . import pip_holds
            title = " ".join(str(chosen[0].get("title") or "").split())[:120] if chosen else ""
            pip_holds.ask(registry, run["pip_id"], "fix", fix_id, run_id=run["id"], announce=True,
                          what=f"fix {len(chosen)} thing{'s' if len(chosen) != 1 else ''} again"
                               + (f": {title}" if title else ""),
                          why="it came back after an earlier fix, so I don't fix it again by myself")
        return fix_id


# ---- the user's answers ---------------------------------------------------------------------------------------------
def _fix(db, pip_id, fix_id):
    if not isinstance(fix_id, str) or not FIX.match(fix_id):
        raise RegistryError("invalid_request", "Choose one of this Pip's fixes.")
    row = db.execute("SELECT * FROM pip_fixes WHERE id=? AND pip_id=?", (fix_id, pip_id)).fetchone() if _has(db) else None
    if row is None:
        raise RegistryError("not_found", "That fix is no longer there. Open the chat again.")
    return row


def decide(store, pip_id, fix_id, expected_digest, allow, actor, config=None) -> dict:
    """decide_pip_fix: Allow starts the fix in its own copy; Not now leaves it as it is, and it is not asked again."""
    if actor not in LOCAL:
        raise RegistryError("forbidden", "Only you can allow a fix, from the Pip's chat, Home or Needs attention.")
    if type(allow) is not bool:
        raise RegistryError("invalid_request", "allow is true or false.")
    registry, db = store.registry, store.db
    store._job(pip_id)
    with registry.transaction():
        ensure(db)
        row = _fix(db, pip_id, fix_id)
        if row["state"] != "ask":
            raise RegistryError("invalid_state", "This fix was answered already.")
        if expected_digest != digest(row):
            raise RegistryError("conflict", "What it wants to fix changed since you looked. Look again, then answer.")
        now = _now(registry)
        db.execute("UPDATE pip_fixes SET state=?,decided_at=?,by='you',revision=revision+1,updated_at=? WHERE id=?",
                   ("queued" if allow else "declined", now, now, fix_id))
        registry.event(row["workspace_id"], "pip_fix_" + ("allowed" if allow else "declined"), pip_id=pip_id,
                       run_id=row["run_id"], payload={"fix_id": fix_id, "by": actor})
    if allow and config is not None:
        send_due(registry, config, only=fix_id)
    return {"fix": view(db, _fix(db, pip_id, fix_id))}


def _brief(row, folder) -> str:
    lines = []
    for number, finding in enumerate(_load(row["findings"], []), 1):
        where = f" — {finding['path']}" + (f":{finding['line']}" if finding.get("line") else "") if finding.get("path") else ""
        lines.append(f"{number}. [{finding.get('severity', 'low')}] {finding.get('title', '')}{where}"
                     + (" (it came back after an earlier fix)" if finding.get("state") == "back" else ""))
        if finding.get("evidence"):
            lines.append("   Evidence: " + " ".join(str(finding["evidence"]).split())[:400])
    return FIX_TEXT.format(folder=folder or "the project", findings="\n".join(lines))


def send_due(registry, config, *, only=None) -> int:
    """Send each queued fix's turn whose chat is free (the supervisor's tick, and at once from Allow). A chat that is
    busy keeps it for a later tick; a Pip that is gone or archived ends it."""
    db = registry.db
    if not _has(db):
        return 0
    from .pips import PipStore
    from . import pip_chat
    store, sent = PipStore(registry), 0
    rows = db.execute("SELECT * FROM pip_fixes WHERE state='queued' AND fix_run_id IS NULL" + (" AND id=?" if only else "")
                      + " ORDER BY created_at,rowid LIMIT 20", (only,) if only else ()).fetchall()
    from . import pip_agents
    for row in rows:
        job = _agent(db, row)
        if job is not None and job["state"] in pip_agents.LIVE:
            continue                                         # its sub-agent job is under way
        try:
            pip = store._job(row["pip_id"])
            folder = db.execute("SELECT name FROM workspaces WHERE id=?", (pip["workspace_id"],)).fetchone()
            from . import pip_agents
            count = len(_load(row["findings"], []))
            job = pip_agents.start(store, config, row["pip_id"], kind="fix",
                                   title=f"Fix {count} thing{'s' if count != 1 else ''} in {folder[0] if folder else 'its folder'}",
                                   brief=_brief(row, folder[0] if folder else ""), fix_id=row["id"])
        except RegistryError as exc:
            with registry.transaction():
                db.execute("UPDATE pip_fixes SET state='ended',message=?,revision=revision+1,updated_at=? WHERE id=?",
                           (_clip(f"It couldn't start: {exc}", 600), _now(registry), row["id"]))
            continue
        with registry.transaction():
            db.execute("UPDATE pip_fixes SET fix_run_id=?,started_at=?,updated_at=? WHERE id=?",
                       (job["run_id"], _now(registry), _now(registry), row["id"]))
        sent += 1
    from . import pip_agents
    sent += pip_agents.send_due(registry, config)          # the Pip's checks and the sub-agents' next tries
    return sent


# ---- the fix turn ended ---------------------------------------------------------------------------------------------
def fix_of_key(key) -> str | None:
    return "pipfix_" + key[len(FIX_KEY):] if isinstance(key, str) and re.fullmatch(FIX_KEY + r"[0-9a-f]{32}", key) else None


def verdicts(text: str, count: int) -> tuple[dict, str | None]:
    """{finding number: (verdict, why)} from the turn's lines, and its TESTS word."""
    found = {}
    for match in _VERDICT_LINE.finditer(text or ""):
        number = int(match.group(1))
        if 1 <= number <= count and number not in found:
            found[number] = (match.group(2).lower().replace(" ", "_"), _clip(match.group(3), 400))
    tests = _TESTS_LINE.search(text or "")
    word = tests.group(1).lower() if tests else None
    return found, ("passed" if word == "passed" else "failed" if word == "failed" else None)


def after_fix_turn(store, run, status, result, error) -> None:
    """The fix's turn ended: its verdicts, its tests, its change, and what only you can do."""
    db, registry = store.db, store.registry
    if not _has(db):
        return
    key = db.execute("SELECT request_key FROM pip_chat_messages WHERE run_id=? AND role='user' ORDER BY seq LIMIT 1",
                     (run["id"],)).fetchone() if _table(db, "pip_chat_messages") else None
    fix_id = fix_of_key(key[0] if key else None)
    if fix_id is None:
        return
    row = db.execute("SELECT * FROM pip_fixes WHERE id=? AND pip_id=?", (fix_id, run["pip_id"])).fetchone()
    if row is None:
        return
    findings = _load(row["findings"], [])
    text = str((result or {}).get("text") or "") if isinstance(result, dict) else ""
    said, tests = verdicts(text, len(findings))
    for number, finding in enumerate(findings, 1):
        if number in said:
            finding["verdict"], finding["why"] = said[number]
    change_id = None
    if status == "succeeded" and _table(db, "pip_project_changes"):
        from . import pip_project_copies
        try:
            pip_project_copies.refresh(store, run["pip_id"])
        except (RegistryError, OSError):
            pass
        change = db.execute("SELECT id FROM pip_project_changes WHERE pip_id=? AND updated_at>=? ORDER BY updated_at DESC "
                            "LIMIT 1", (run["pip_id"], run.get("started_at") or row["created_at"])).fetchone()
        change_id = change[0] if change else None
    message = _first_words(text)
    now = _now(registry)
    with registry.transaction():
        db.execute("UPDATE pip_fixes SET state='ended',findings=?,fix_run_id=?,change_id=?,tests=?,message=?,"
                   "revision=revision+1,updated_at=? WHERE id=?",
                   (_json(findings), run["id"], change_id, tests, message, now, fix_id))
        for finding in findings:
            if finding.get("verdict") == "needs_you":
                db.execute("INSERT OR IGNORE INTO pip_waiting(id,pip_id,workspace_id,fix_id,identity,title,blocks,state,since,"
                           "created_at,updated_at) VALUES(?,?,?,?,?,?,?,'waiting',?,?,?)",
                           ("pipwait_" + secrets.token_hex(16), run["pip_id"], row["workspace_id"], fix_id,
                            finding.get("identity") or identity(finding), _clip(finding.get("title"), 200),
                            _clip(finding.get("why") or "", 300), now, now, now))
        registry.event(row["workspace_id"], "pip_fix_ended", pip_id=run["pip_id"], run_id=run["id"],
                       payload={"fix_id": fix_id, "status": status, "change_id": change_id})


def after_agent_job(store, job) -> None:
    """Its sub-agent job ended (pip_agents): the Pip's verdicts from its check, the tests the sub-agent ran, the change
    now in the Pip's copy (or why there is none), and what only you can do."""
    db, registry = store.db, store.registry
    if not _has(db):
        return
    row = db.execute("SELECT * FROM pip_fixes WHERE id=?", (job["fix_id"],)).fetchone()
    if row is None or row["state"] == "ended":
        return
    findings = _load(row["findings"], [])
    said, _ = verdicts(job["verdict"] or "", len(findings))
    _, tests = verdicts(job["said"] or "", len(findings))
    for number, finding in enumerate(findings, 1):
        if number in said:
            finding["verdict"], finding["why"] = said[number]
    change_id, held = None, job["state"] == "held"
    if job["state"] == "merged" and _table(db, "pip_project_changes"):
        from . import pip_project_copies
        try:
            pip_project_copies.refresh(store, row["pip_id"])
        except (RegistryError, OSError):
            pass
        change = db.execute("SELECT id FROM pip_project_changes WHERE pip_id=? AND updated_at>=? ORDER BY updated_at DESC "
                            "LIMIT 1", (row["pip_id"], job["created_at"])).fetchone()
        change_id = change[0] if change else None
    files = _load(job["held"], []) if held else []
    message = {"merged": _first_words(job["verdict"] or ""),
               "held": "Your copy of " + ", ".join(files[:5]) + (" and more" if len(files) > 5 else "")
                       + " changed while its sub-agent worked, so it didn't overwrite them.",
               "asked": f"It tried {job['tries']} times and it isn't right yet: " + (job["notes"] or "see its last check."),
               "failed": "Its sub-agent stopped with an error: " + _clip(job["said"] or "", 300),
               "stopped": "Its sub-agent was stopped. Nothing reached your copy."}.get(job["state"], "")
    now = _now(registry)
    with registry.transaction():
        db.execute("UPDATE pip_fixes SET state='ended',findings=?,fix_run_id=?,change_id=?,tests=?,message=?,note=?,"
                   "revision=revision+1,updated_at=? WHERE id=?",
                   (_json(findings), job["run_id"], change_id, tests, _clip(message, 600),
                    "held" if held else row["note"], now, row["id"]))
        for finding in findings:
            if finding.get("verdict") == "needs_you":
                db.execute("INSERT OR IGNORE INTO pip_waiting(id,pip_id,workspace_id,fix_id,identity,title,blocks,state,since,"
                           "created_at,updated_at) VALUES(?,?,?,?,?,?,?,'waiting',?,?,?)",
                           ("pipwait_" + secrets.token_hex(16), row["pip_id"], row["workspace_id"], row["id"],
                            finding.get("identity") or identity(finding), _clip(finding.get("title"), 200),
                            _clip(finding.get("why") or "", 300), now, now, now))
        registry.event(row["workspace_id"], "pip_fix_ended", pip_id=row["pip_id"], run_id=job["run_id"],
                       payload={"fix_id": row["id"], "status": job["state"], "change_id": change_id})
    if change_id and job["state"] == "merged":
        from . import pip_levels, pip_project_copies
        if pip_levels.effective(registry, row["pip_id"]) == pip_levels.FULL:
            try:
                pip_project_copies.auto_apply(store, row["pip_id"])     # Do it all: applied, with Undo
            except (RegistryError, OSError):
                pass


def shown_text(text: str) -> str:
    """A Pip's reply as the chat shows it: without the lines meant for DGC (FINDING n, TESTS, RESULT)."""
    kept = [line for line in (text or "").splitlines() if not _VERDICT_LINE.match(line) and not _TESTS_LINE.match(line)
            and not _RESULT_LINE.match(line) and not re.match(r"^\s*FINDING\s+\d{1,2}\s*:", line, re.I)]
    return "\n".join(kept).strip()


def _first_words(text: str) -> str:
    """What it says it did, without its verdict lines: the first few sentences, for the card."""
    return _clip(" ".join(shown_text(text).splitlines()), 600)


# ---- waiting on you -------------------------------------------------------------------------------------------------
def answer_waiting(store, pip_id, waiting_id, answer, actor) -> dict:
    """answer_pip_waiting: I've done it (done) · Remind me later (later: back tomorrow) · Not a problem (dismissed) ·
    Undo (back to waiting, within ten minutes of the answer). Answering never pauses or restarts the Pip."""
    if actor not in LOCAL:
        raise RegistryError("forbidden", "Only you can answer this.")
    if answer not in ("done", "later", "not_a_problem", "undo"):
        raise RegistryError("invalid_request", "Answer done, later, not_a_problem or undo.")
    if not isinstance(waiting_id, str) or not WAIT.match(waiting_id):
        raise RegistryError("invalid_request", "Choose one of the things this Pip waits on you for.")
    registry, db = store.registry, store.db
    store._job(pip_id)
    with registry.transaction():
        ensure(db)
        row = db.execute("SELECT * FROM pip_waiting WHERE id=? AND pip_id=?", (waiting_id, pip_id)).fetchone()
        if row is None:
            raise RegistryError("not_found", "That's no longer waiting. Open the chat again.")
        now = _now(registry)
        if answer == "undo":
            view_now = _waiting_view(row, now)
            if not view_now["can_undo"]:
                raise RegistryError("invalid_state", "That answer can't be undone any more.")
            db.execute("UPDATE pip_waiting SET state='waiting',remind_at=NULL,answered_at=NULL,previous=NULL,updated_at=? "
                       "WHERE id=?", (now, waiting_id))
        else:
            if row["state"] != "waiting":
                raise RegistryError("invalid_state", "That was answered already.")
            state = {"done": "done", "later": "later", "not_a_problem": "dismissed"}[answer]
            remind = _iso(_instant(now) + REMIND_AFTER) if answer == "later" and _instant(now) else None
            db.execute("UPDATE pip_waiting SET state=?,remind_at=?,answered_at=?,previous=?,updated_at=? WHERE id=?",
                       (state, remind, now, row["state"], now, waiting_id))
    return {"waiting": listing(store, pip_id)["waiting"]}


# ---- Needs attention ------------------------------------------------------------------------------------------------
def attention_rows(db, pip_ids, now) -> list:
    """The flow's rows for list_pip_attention (one per thing, newest first): fix_ask (card: the fix), fix_ready and
    fix_held (card: its change), waiting (card: the waiting item)."""
    if not pip_ids or not _has(db):
        return []
    marks = json.dumps(sorted(pip_ids))
    out = []
    from .pip_holds import asked_refs
    asked = {ref.split(":", 1)[1] for ref in asked_refs(db) if ref.startswith("fix:")}
    for row in db.execute("SELECT * FROM pip_fixes WHERE pip_id IN (SELECT value FROM json_each(?)) AND state IN ('ask','ended') "
                          "AND created_at>=? ORDER BY created_at DESC LIMIT 500",
                          (marks, _iso(_instant(now) - timedelta(days=30)) if _instant(now) else "")).fetchall():
        findings = _load(row["findings"], [])
        what = (findings[0].get("title") if findings else "") or ""
        if row["state"] == "ask" and row["id"] in asked:
            continue                                     # asked in its chat at Do it all (pip_holds.ask)
        if row["state"] == "ask":
            out.append({"kind": "fix_ask", "card": row["id"], "pip_id": row["pip_id"], "created_at": row["asked_at"] or row["created_at"],
                        "title": f"Fix {row['count']} thing{'s' if row['count'] != 1 else ''}?", "detail": what})
            continue
        change = _change_status(db, row["change_id"])
        if change == "pending" and row["change_id"]:
            out.append({"kind": "fix_ready", "card": row["change_id"], "pip_id": row["pip_id"], "created_at": row["updated_at"],
                        "title": "Its fix is ready to apply", "detail": row["message"] or what})
        elif change in ("partial", "not_applied") and row["change_id"]:
            out.append({"kind": "fix_held", "card": row["change_id"], "pip_id": row["pip_id"], "created_at": row["updated_at"],
                        "title": "Part of its fix was held back", "detail": "You changed a file it changed. Look at it."})
    if _table(db, "pip_waiting"):
        for row in db.execute("SELECT * FROM pip_waiting WHERE pip_id IN (SELECT value FROM json_each(?)) AND "
                              "(state='waiting' OR (state='later' AND remind_at<=?)) ORDER BY since DESC LIMIT 200",
                              (marks, now)).fetchall():
            out.append({"kind": "waiting", "card": row["id"], "pip_id": row["pip_id"], "created_at": row["since"],
                        "title": row["title"], "detail": row["blocks"]})
    return out


def after_run(store, run, *, status, result, error) -> None:
    """PipStore.finish, after its transaction: a check that ended well may become a fix; a fix's turn says what became
    of it. Never fails the finish."""
    try:
        manifest = run.get("manifest") if isinstance(run.get("manifest"), dict) else {}
        kind = manifest.get("run_kind", "audit")
        if kind == "audit" and status == "succeeded":
            after_check(store, run, result)
        elif kind == "conversation" and manifest.get("agent"):
            from . import pip_agents                        # a sub-agent's try ended: due for its Pip's check
            pip_agents.after_agent_run(store, run, status, result, error)
        elif kind == "conversation" and status in ("succeeded", "failed", "cancelled"):
            from . import pip_agents
            if pip_agents.check_of_run(store.db, run["id"]) is not None:
                pip_agents.after_check_turn(store, run, status, result)    # the Pip checked a sub-agent's work
            else:
                after_fix_turn(store, run, status, result, error)       # (a fix turn from before sub-agents)
    except Exception:                                    # noqa: BLE001 - the run's own end stands either way
        try:
            store.registry._rollback_after_error()
        except Exception:                                # noqa: BLE001
            pass


def is_fix_turn(db, run_id) -> bool:
    if not _table(db, "pip_chat_messages"):
        return False
    row = db.execute("SELECT request_key FROM pip_chat_messages WHERE run_id=? AND role='user' ORDER BY seq LIMIT 1",
                     (run_id,)).fetchone()
    return fix_of_key(row[0] if row else None) is not None


# ---- Pips API 96 commands -------------------------------------------------------------------------------------------
def control(store, command, request, actor, config) -> dict:
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you answer a Pip's fixes, on this computer.")
    pip_id = request.get("pip_id")
    store._job(pip_id)
    if command == "list_pip_fixes":
        return listing(store, pip_id)
    if command == "decide_pip_fix":
        return decide(store, pip_id, request.get("fix_id"), request.get("expected_digest"), request.get("allow"), actor,
                      config)
    if command == "answer_pip_waiting":
        return answer_waiting(store, pip_id, request.get("waiting_id"), request.get("answer"), actor)
    if command == "start_pip_work_helper":
        return start_work_helper(store, pip_id, request.get("fix_id"), actor, config)
    if command == "retry_pip_fix":
        return retry(store, pip_id, request.get("fix_id"), request.get("again"), actor, config)
    if command in ("list_pip_agents", "stop_pip_agent", "set_pip_agents"):
        # Its sub-agents (pip_agents, Pips API 97): the agent map in its chat, Stop, and how many run at once; since
        # API 104 also the model they run on, their thinking, their window and their fallback.
        from . import pip_agents
        if command == "list_pip_agents":
            return pip_agents.listing(store, pip_id)
        if command == "stop_pip_agent":
            return {"agent": pip_agents.stop(store, pip_id, request.get("agent_id"), actor)}
        return pip_agents.configure(store.registry, pip_id, request)
    if command == "commit_pip_project_change":
        from . import pip_project_copies
        return pip_project_copies.commit(store, pip_id, request.get("change_id"), actor)
    raise RegistryError("invalid_request", "Unknown fix command.")


RETRIABLE = ("asked", "held", "failed", "stopped")
_DONE = ("fixed", "already fixed", "not a defect")


def retry(store, pip_id, fix_id, again, actor, config) -> dict:
    """retry_pip_fix (Pips API 97), after a fix's sub-agent ended without its change (its last try, held, failed or
    stopped). Try again: a fresh sub-agent in a copy made from the Pip's copy as it is now, for what isn't fixed yet,
    with what the Pip's last check said. Leave it: it ends there and is never asked again."""
    if actor not in LOCAL:
        raise RegistryError("forbidden", "Only you can try a fix again, from the Pip's chat.")
    if type(again) is not bool:
        raise RegistryError("invalid_request", "again is true or false.")
    from . import pip_agents
    registry, db = store.registry, store.db
    store._job(pip_id)
    row = _fix(db, pip_id, fix_id)
    job = _agent(db, row)
    if row["state"] != "ended" or job is None or job["state"] not in RETRIABLE:
        raise RegistryError("invalid_state", "This fix isn't waiting on you. Open the chat again.")
    if not again:
        pip_agents.leave(store, job)
        with registry.transaction():
            db.execute("UPDATE pip_fixes SET message=?,note='left',revision=revision+1,updated_at=? WHERE id=?",
                       ("Left as it is. I won't try this again.", _now(registry), row["id"]))
            registry.event(row["workspace_id"], "pip_fix_left", pip_id=pip_id, run_id=job["run_id"],
                           payload={"fix_id": row["id"], "by": actor})
        return {"fix": view(db, _fix(db, pip_id, fix_id))}
    findings = _load(row["findings"], [])
    open_ = [f for f in findings if f.get("verdict") not in _DONE] or findings
    redo = dict(row)
    redo["findings"] = _json(open_)
    folder = db.execute("SELECT name FROM workspaces WHERE id=?", (row["workspace_id"],)).fetchone()
    folder = folder[0] if folder else ""
    brief = _brief(redo, folder)
    if job["notes"]:
        brief += "\n\nWhat your Pip's last check said, so do it differently this time: " + _clip(job["notes"], 1500)
    started = pip_agents.start(store, config, pip_id, kind="fix",
                               title=f"Fix {len(open_)} thing{'s' if len(open_) != 1 else ''} in {folder or 'its folder'}",
                               brief=brief, fix_id=row["id"])
    now = _now(registry)
    with registry.transaction():
        db.execute("UPDATE pip_fixes SET state='queued',fix_run_id=?,started_at=?,message=NULL,note=NULL,change_id=NULL,"
                   "revision=revision+1,updated_at=? WHERE id=?", (started["run_id"], now, now, row["id"]))
        registry.event(row["workspace_id"], "pip_fix_allowed", pip_id=pip_id, run_id=row["run_id"],
                       payload={"fix_id": row["id"], "by": actor, "again": True})
    return {"fix": view(db, _fix(db, pip_id, fix_id))}


def start_work_helper(store, pip_id, fix_id, actor, config) -> dict:
    """start_pip_work_helper: "Start a helper with Work tools" for a fix its copy can't do (a file Git ignores, a
    service to run). Not built yet in this step: it says so instead of pretending."""
    raise RegistryError("unsupported_command", "Starting a helper with Work tools isn't ready yet in this build.")
