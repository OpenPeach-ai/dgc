"""/goal for one Pip (pips-15): "Keep going until done", with a card showing turns and status, and a real ending.

A Personal Pip's conversation can hold one goal, set by the user (``set_pip_goal``; a new one replaces the old). Each of
its turns is a hidden turn in that conversation under ``KEY``, carrying Work's continuation prompt (goals.cycle_prompt:
the objective as the user's data, the completion audit, blocked only after the same blocker three turns running). In a
goal's turn the Pip is offered ``update_goal`` (completed or blocked, with its reason and evidence). When a turn ends:

* ``update_goal`` completed: done; blocked: blocked (its reason kept);
* otherwise, a question or a card left waiting for the user (its choices, a card it raised): needs you, and it waits;
* otherwise, after ``MAX_TURNS`` turns: blocked, saying so;
* otherwise it is still going: the runner's check (``tick``) starts the next turn once this one has finished, never
  two at once. A turn the user stopped stops the goal; one that failed blocks it with the reason.

Turns are started as the user who set the goal (a follow-up of their ask, as a card's answer is), under DGC's own key,
so nothing a turn does counts as the user's own words. Kept in ``pip_goals`` (made the first time it is needed).
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets

from .workspace_registry import RegistryError

KEY = "goal_"
MAX_TURNS = 20
MAX_OBJECTIVE = 4000
STATUSES = ("active", "done", "needs_you", "blocked", "stopped")
UPDATES = ("completed", "blocked", "needs_you")
ENDED = {"completed": "done", "blocked": "blocked", "needs_you": "needs_you"}     # what each update makes the goal
LOCAL = ("editor-user", "local-console")
TOOL = "update_goal"

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_goals (
 id TEXT PRIMARY KEY,
 pip_id TEXT NOT NULL,
 conversation_id TEXT,
 objective TEXT NOT NULL CHECK(length(CAST(objective AS BLOB)) BETWEEN 1 AND 16000),
 status TEXT NOT NULL CHECK(status IN ('active','done','needs_you','blocked','stopped')),
 turns INTEGER NOT NULL DEFAULT 0,
 actor TEXT NOT NULL,
 reason TEXT CHECK(reason IS NULL OR length(CAST(reason AS BLOB)) <= 2000),
 evidence TEXT CHECK(evidence IS NULL OR length(CAST(evidence AS BLOB)) <= 8000),
 last_key TEXT,
 waiting_before INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pip_goals_pip ON pip_goals(pip_id, created_at);
"""


def _ensure(db) -> None:
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_goals'").fetchone() is None:
        from .workspace_registry import _execute_schema
        _execute_schema(db, SCHEMA)


def _has(db) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_goals'").fetchone() is not None


def _now(registry) -> str:
    from .pip_routines import _now as now, stamp
    return stamp(now(registry))


def _view(row) -> dict:
    return {"id": row["id"], "pip_id": row["pip_id"], "conversation_id": row["conversation_id"],
            "objective": row["objective"], "status": row["status"], "turns": row["turns"], "max_turns": MAX_TURNS,
            "reason": row["reason"] or "", "evidence": json.loads(row["evidence"]) if row["evidence"] else [],
            "started_at": row["created_at"], "updated_at": row["updated_at"]}


def _conversation(store, pip_id, conversation_id):
    """For a read: the conversation named (this Pip's), else its first; never makes one."""
    from .pip_conversations import first_id
    if conversation_id is None:
        return first_id(store.db, pip_id)
    row = store.db.execute("SELECT id FROM pip_conversations WHERE id=? AND pip_id=?",
                           (conversation_id if isinstance(conversation_id, str) else "", pip_id)).fetchone()
    if row is None:
        raise RegistryError("not_found", "That conversation isn't this Pip's.")
    return row[0]


def _turn_key(goal_id: str, turn: int) -> str:
    return f"{KEY}{goal_id[-16:]}_{turn}"


def _turn_text(row) -> str:
    from .goals import cycle_prompt
    return (f"This message is from DGC, not the user: the user set this conversation a goal, and this is your turn "
            f"{row['turns'] + 1} of at most {MAX_TURNS} toward it. Keep going: never to check in or confirm progress. Only when "
            "you can't take the next step without something only the user can give, call update_goal(status='needs_you') "
            "with what you need, and ask them for it in your reply: the goal waits for their answer.\n\n"
            + cycle_prompt(row["objective"]))


def _send_turn(store, row, config) -> dict:
    """Queue the goal's next turn. Its key names the goal and the turn, so the context it is given finds the goal
    (``context_for``) while the turn is being queued; ``last_key`` is the one the runner's check then looks for."""
    from . import pip_chat
    key = _turn_key(row["id"], row["turns"] + 1)
    waiting = pip_chat._cards_waiting(store, row["pip_id"])       # a card more after its turn: it waits for you
    sent = pip_chat.send(store, row["pip_id"], _turn_text(row), key, row["actor"], config,
                         conversation_id=row["conversation_id"], _intro=True)
    with store.registry.transaction():
        store.db.execute("UPDATE pip_goals SET last_key=?,waiting_before=?,updated_at=? WHERE id=?",
                         (key, waiting, _now(store.registry), row["id"]))
    return sent


# --------------------------------------------------------------------------------------------- the user's side

def set_goal(store, pip_id, objective, conversation_id, actor, config) -> dict:
    """set_pip_goal: the conversation's goal, replacing one there before; its first turn starts now."""
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you give a Pip a goal, on this computer.")
    job = store._job(pip_id)
    if job["source_policy"] != {"mode": "personal"}:
        raise RegistryError("invalid_request", "A goal is for a Personal Pip: Work's /goal does a project's.")
    text = str(objective or "").strip()
    if not text or len(text) > MAX_OBJECTIVE or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text):
        raise RegistryError("invalid_request", f"Say what the goal is, in up to {MAX_OBJECTIVE} characters.")
    registry, db = store.registry, store.db
    from .pip_conversations import resolve
    with registry.transaction():
        conversation = resolve(db, pip_id, conversation_id)       # this Pip's and not archived; its first made if need be
    at = _now(registry)
    goal_id = "pipgoal_" + secrets.token_hex(16)
    with registry.transaction():
        _ensure(db)
        db.execute("INSERT INTO pip_goals(id,pip_id,conversation_id,objective,status,turns,actor,created_at,updated_at) "
                   "VALUES(?,?,?,?,'active',0,?,?,?)", (goal_id, pip_id, conversation, text, actor, at, at))
    try:
        _send_turn(store, db.execute("SELECT * FROM pip_goals WHERE id=?", (goal_id,)).fetchone(), config)
    except BaseException:
        with registry.transaction():                   # its first turn couldn't start (a reply running): no goal
            db.execute("DELETE FROM pip_goals WHERE id=?", (goal_id,))
        raise
    with registry.transaction():
        db.execute("UPDATE pip_goals SET status='stopped',reason=?,updated_at=? WHERE pip_id=? AND conversation_id IS ? "
                   "AND status IN ('active','needs_you') AND id!=?", ("Replaced by a new goal.", at, pip_id, conversation,
                                                                     goal_id))
    return _view(db.execute("SELECT * FROM pip_goals WHERE id=?", (goal_id,)).fetchone())


def get(store, pip_id, conversation_id=None) -> dict:
    """get_pip_goal: the conversation's latest goal (null when none was set)."""
    store._job(pip_id)
    db = store.db
    if not _has(db):
        return {"pip_id": pip_id, "goal": None}
    conversation = _conversation(store, pip_id, conversation_id)
    row = db.execute("SELECT * FROM pip_goals WHERE pip_id=? AND conversation_id IS ? ORDER BY created_at DESC,rowid DESC LIMIT 1",
                     (pip_id, conversation)).fetchone()
    return {"pip_id": pip_id, "goal": _view(row) if row else None}


def stop(store, pip_id, goal_id, actor) -> dict:
    """stop_pip_goal: no more turns; a turn running now finishes as any reply does."""
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you stop a Pip's goal, on this computer.")
    db = store.db
    row = db.execute("SELECT * FROM pip_goals WHERE id=? AND pip_id=?", (goal_id, pip_id)).fetchone() if _has(db) else None
    if row is None:
        raise RegistryError("not_found", "That goal isn't this Pip's.")
    if row["status"] in ("active", "needs_you"):
        with store.registry.transaction():
            db.execute("UPDATE pip_goals SET status='stopped',reason=?,updated_at=? WHERE id=?",
                       ("Stopped by you.", _now(store.registry), goal_id))
    return _view(db.execute("SELECT * FROM pip_goals WHERE id=?", (goal_id,)).fetchone())


# --------------------------------------------------------------------------------------------- the Pip's side

_KEY = re.compile(KEY + r"([0-9a-f]{16})_([1-9][0-9]{0,3})")


def _by_key(db, key):
    """The goal a turn's key names, and which of its turns it is."""
    match = _KEY.fullmatch(key) if isinstance(key, str) else None
    if match is None or not _has(db):
        return None, 0
    row = db.execute("SELECT * FROM pip_goals WHERE substr(id,-16)=?", (match[1],)).fetchone()
    return row, int(match[2])


def context_for(store, pip, req) -> dict | None:
    """What the Pip is told of its goal, and the sign that it may call update_goal: in a goal's own turn, and (as Work
    offers update_goal in every turn while a goal is on) in a reply to the user's own message, or to DGC's turn after a
    card they decided, in that conversation while its goal is on or waits for them. Never in a routine's turn."""
    key = req.get("request_key")
    row, turn = _by_key(store.db, key)
    if row is not None:
        if row["pip_id"] != pip["id"] or row["status"] != "active":
            return None
        return {"objective": row["objective"][:2000], "turn": turn, "max_turns": MAX_TURNS, "own": True}
    from .pip_chat import DGC_KEYS, FOLLOW_UP_KEYS
    if not _has(store.db) or (str(key or "").startswith(DGC_KEYS) and not str(key or "").startswith(FOLLOW_UP_KEYS)):
        return None
    row = _open_goal(store, pip["id"], req.get("conversation_id"))
    if row is None:
        return None
    return {"objective": row["objective"][:2000], "turn": max(1, min(row["turns"], MAX_TURNS)), "max_turns": MAX_TURNS}


def _open_goal(store, pip_id, conversation_id):
    """The goal of this conversation (the first when none is named) that is on or waits for the user, or None."""
    from .pip_conversations import first_id
    where = conversation_id if isinstance(conversation_id, str) else first_id(store.db, pip_id)
    return store.db.execute("SELECT * FROM pip_goals WHERE pip_id=? AND conversation_id IS ? AND status IN "
                            "('active','needs_you') ORDER BY created_at DESC,rowid DESC LIMIT 1", (pip_id, where)).fetchone()


def valid_context(value) -> bool:
    """``own``: the goal's own turn (DGC's), which has no choices to offer."""
    return (isinstance(value, dict) and set(value) - {"own"} == {"objective", "turn", "max_turns"}
            and value.get("own", True) is True
            and isinstance(value["objective"], str) and 0 < len(value["objective"]) <= 2000
            and type(value["turn"]) is int and 1 <= value["turn"] <= MAX_TURNS and value["max_turns"] == MAX_TURNS)


def valid_update(value) -> bool:
    return (isinstance(value, dict) and set(value) <= {"status", "reason", "evidence"} and value.get("status") in UPDATES
            and isinstance(value.get("reason", ""), str) and len(value.get("reason", "")) <= 2000
            and isinstance(value.get("evidence", []), list) and len(value.get("evidence", [])) <= 20
            and all(isinstance(e, str) and len(e) <= 1000 for e in value.get("evidence", [])))


def schema() -> dict:
    """The tool a goal's turn offers: Work's update_goal, said for the goal in this conversation."""
    return {"type": "function", "function": {"name": TOOL, "description": (
        "Mark the goal you are working toward in this conversation completed or genuinely blocked, for the whole goal, "
        "never merely this turn, or that it needs the user. completed: only when the whole objective is achieved and no "
        "required work remains, proved requirement by requirement against current evidence. blocked: only after the "
        "same blocking condition three goal turns running, when you cannot progress without the user or an outside "
        "change. needs_you: only when the next step needs something only the user can give (a choice, a fact, a "
        "permission), never to check in or confirm progress; summary says what you need, and your reply asks for it. "
        "Otherwise don't call it: take the next concrete step, and DGC gives you another turn."),
        "parameters": {"type": "object", "required": ["status", "summary"],
                       "properties": {"status": {"type": "string", "enum": list(UPDATES)},
                                      "summary": {"type": "string",
                                                  "description": "Outcome or observed blocker for the entire goal"},
                                      "evidence": {"type": "array", "items": {"type": "string"},
                                                   "description": "One line per requirement: what proves it (or, for "
                                                                  "blocked, the blocker as observed each time)"}}}}}


def _lines(value) -> list:
    """The evidence lines, however the model sent them: a list, a list written as JSON text (deepseek-v4.1-flash:cloud,
    live 12 Nov), or plain text a line each."""
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            parsed = None
        value = parsed if isinstance(parsed, list) else value.splitlines()
    if not isinstance(value, list):
        return []
    return [" ".join(str(e).split())[:300] for e in value if str(e).strip()][:20]


def tool_result(arguments) -> tuple[dict | None, str]:
    """In the worker: (the update, what the model is told)."""
    args = arguments if isinstance(arguments, dict) else {}
    status = args.get("status")
    if status not in UPDATES:
        return None, ("Not recorded: status is completed, blocked or needs_you. Otherwise take the next step; DGC gives "
                      "you another turn.")
    reason = " ".join(str(args.get("summary") or args.get("reason") or "").split())[:500]
    evidence = _lines(args.get("evidence"))
    if status == "needs_you":
        if not reason:
            return None, "Not recorded: needs_you says in summary what you need from the user."
        return ({"status": status, "reason": reason, "evidence": evidence},
                "Recorded: the goal waits for the user's answer. Ask them for it in your reply, briefly.")
    if status == "completed" and not evidence:
        return None, "Not recorded: completed needs one line of evidence per requirement."
    told = ("Recorded: the goal ends as done when your reply is saved. Say what you did, briefly."
            if status == "completed" else "Recorded: the goal ends as blocked. Say what stops it and what would unblock it.")
    return {"status": status, "reason": reason, "evidence": evidence}, told


# What a reply leaves for the user to decide: each is a card below it.
CARDS = ("message_draft", "calendar_draft", "connector_action_draft", "setup_draft", "core_setup_drafts", "routine_drafts")


def commit(store, run, result, choices=None) -> None:
    """When a chat reply is saved (in its transaction): a goal's turn counts, and how the goal stands."""
    db = store.db
    if not _has(db) or not isinstance(result, dict):
        return
    key = db.execute("SELECT request_key FROM pip_chat_messages WHERE run_id=? AND role='user'", (run["id"],)).fetchone()
    row, turn = _by_key(db, key[0] if key else None)
    if row is None:
        if not _ended_by(store, run, result):
            _answered(store, run, result, choices)
        return
    if row["status"] != "active" or turn != row["turns"] + 1 or row["pip_id"] != run["pip_id"]:
        return                                         # not the turn it is waiting on
    update = result.get("goal_update")
    status, reason, evidence = "active", None, None
    if isinstance(update, dict) and update.get("status") in UPDATES:
        status = ENDED[update["status"]]
        reason, evidence = update.get("reason") or None, json.dumps(update.get("evidence") or [])
    elif _needs_you(store, run, result, row, result.get("choices") if choices is None else choices):
        status, reason = "needs_you", "Waiting for your answer in the chat."
    elif turn >= MAX_TURNS:
        status, reason = "blocked", f"Stopped after {MAX_TURNS} turns without finishing. Look at where it got to, then set it again."
    db.execute("UPDATE pip_goals SET turns=?,status=?,reason=COALESCE(?,reason),evidence=COALESCE(?,evidence),updated_at=? "
               "WHERE id=?", (turn, status, reason, evidence, _now(store.registry), row["id"]))


def _ended_by(store, run, result) -> bool:
    """A reply to the user's own message (or after a card) that said, with update_goal, how the goal ended."""
    update = result.get("goal_update")
    if not isinstance(update, dict) or update.get("status") not in UPDATES:
        return False
    where = store.db.execute("SELECT conversation_id FROM pip_chat_messages WHERE run_id=? AND role='user'",
                             (run["id"],)).fetchone()
    row = _open_goal(store, run["pip_id"], where[0] if where else None) if where else None
    if row is None:
        return False
    store.db.execute("UPDATE pip_goals SET status=?,reason=?,evidence=?,updated_at=? WHERE id=?",
                     (ENDED[update["status"]], update.get("reason") or None,
                      json.dumps(update.get("evidence") or []), _now(store.registry), row["id"]))
    return True


def _answered(store, run, result, choices) -> None:
    """Another reply in a conversation whose goal waits for the user (their answer, or DGC's turn after a card they
    decided): unless it asks them something again, the goal carries on, and the runner's check starts its next turn."""
    where = store.db.execute("SELECT conversation_id FROM pip_chat_messages WHERE run_id=? AND role='user'",
                             (run["id"],)).fetchone()
    if where is None:
        return
    goal = store.db.execute("SELECT id FROM pip_goals WHERE pip_id=? AND conversation_id IS ? AND status='needs_you'",
                            (run["pip_id"], where[0])).fetchone()
    if goal is None or choices or any(result.get(name) for name in CARDS):
        return
    from . import pip_chat
    try:
        if pip_chat._left_waiting(store, run, result):
            return
    except Exception:                          # noqa: BLE001 - a card check never fails a reply
        return
    store.db.execute("UPDATE pip_goals SET status='active',reason=NULL,updated_at=? WHERE id=?",
                     (_now(store.registry), goal[0]))


def _needs_you(store, run, result, row, choices) -> bool:
    """Its turn asked the user something: a question with choices, a card below the reply, a step its computer holds,
    or one card more waiting for them than when the turn began."""
    if choices or any(result.get(name) for name in CARDS):
        return True
    from . import pip_chat
    try:
        if pip_chat._left_waiting(store, run, result):
            return True
    except Exception:                          # noqa: BLE001 - a card check never fails a reply
        pass
    return pip_chat._cards_waiting(store, run["pip_id"]) > (row["waiting_before"] or 0)


# --------------------------------------------------------------------------------------------- the runner

def tick(registry, config) -> int:
    """Start the next turn of each goal still going whose last turn has finished. Returns how many it started."""
    from .pips import PipStore
    db = registry.db
    if not _has(db):
        return 0
    store, started = PipStore(registry), 0
    for row in db.execute("SELECT * FROM pip_goals WHERE status='active' ORDER BY updated_at").fetchall():
        last = db.execute("SELECT r.status FROM pip_chat_messages m JOIN pip_runs r ON r.id=m.run_id WHERE m.pip_id=? "
                          "AND m.role='user' AND m.request_key=?", (row["pip_id"], row["last_key"])).fetchone()
        if last is None or last["status"] in ("queued", "running", "cancelling"):
            continue                                   # still to run, or running: never a second at once
        if last["status"] in ("cancelled", "stopped"):
            with registry.transaction():
                db.execute("UPDATE pip_goals SET status='stopped',reason=?,updated_at=? WHERE id=? AND status='active'",
                           ("Its turn was stopped.", _now(registry), row["id"]))
            continue
        if last["status"] == "failed":
            with registry.transaction():
                db.execute("UPDATE pip_goals SET status='blocked',reason=?,updated_at=? WHERE id=? AND status='active'",
                           ("Its last turn failed. Look at the chat, then set it again.", _now(registry), row["id"]))
            continue
        if row["turns"] == 0:
            continue                                   # its first turn hasn't been counted yet
        try:
            _send_turn(store, row, config)
            started += 1
        except RegistryError as exc:
            if exc.code != "conversation_busy":        # the user is talking to it: the next check tries again
                with registry.transaction():
                    db.execute("UPDATE pip_goals SET status='blocked',reason=?,updated_at=? WHERE id=?",
                               (str(exc)[:500], _now(registry), row["id"]))
    return started


# --------------------------------------------------------------------------------------------- the commands

def control(store, command, request, actor, config) -> dict:
    """Pips API 92, local only."""
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you work with a Pip's goal, on this computer.")
    pip_id = request.get("pip_id")
    if command == "set_pip_goal":
        return {"goal": set_goal(store, pip_id, request.get("objective"), request.get("conversation_id"), actor, config)}
    if command == "get_pip_goal":
        return get(store, pip_id, request.get("conversation_id"))
    if command == "stop_pip_goal":
        return {"goal": stop(store, pip_id, request.get("goal_id"), actor)}
    raise RegistryError("invalid_request", "Unknown goal command.")
