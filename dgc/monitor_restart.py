"""A chat's monitors come back when the chat is opened again.

A monitor runs only while DGC runs: a window reload, a lost connection or a killed backend ends it
(the watchdog in dgc.monitors makes sure of that), and nothing keeps watching while DGC is closed.
What this module adds is the second half: DGC writes down each monitor it starts, and when the same
session is opened again -- a new `dgc serve` resuming it from the editor, or the terminal resuming
it -- it starts each one that was still running when DGC stopped, once, with the same command,
folder, sandbox and permissions, and says so to the user and to the model.

The journal
    ``<session>.monitors`` beside the transcript (the non-JSON suffix keeps it out of session
    pickers), written under the session-family lease like the ``.metrics`` journal. At most
    ``MAX_RECORDS`` records. One per monitor, kept across its restarts: ``key`` is its identity,
    ``id`` the monitor id it has now. A record says how the monitor was started (the validated
    arguments, the folder, whether it ran sandboxed, the mode and whether the user approved it) and
    how its last run ended:

      stopped      the user or the model stopped it            never restarted
      timeout      it reached its time limit                   never restarted
      exited       its command exited on its own               never restarted
      flood        DGC stopped it for printing too much        never restarted
      rewound      a rewind removed the turn that started it   never restarted
      expired      its time ran out while DGC was closed       never restarted
      failed       a restart did not start it                  only by the user's Restart
      dgc_stopped  DGC stopped (closed, reloaded, killed),     restarted on the next open, once
                   or the chat was closed or replaced          the process that ran it has ended

    Everything is keyed on the process that ran the monitor having actually ended. A record still
    ``running`` whose owner is gone is a DGC that died without its cleanup (SIGKILL, OOM): restarted
    like ``dgc_stopped``, its ``alive_at`` heartbeat (every ``HEARTBEAT_S``) saying roughly when it
    stopped watching. A record whose owner still runs is left alone: that DGC still has the session
    (a window that re-attached to it, a chat switched away in the same process). A reopen that finds
    the owner still exiting -- the window reloaded a moment before -- waits for it, up to
    ``WAIT_FOR_OWNER_S``, and brings the monitor back once it is gone.

Permissions
    A restart is decided again under the session's permissions as they are now. A deny (plan
    mode, a deny rule, a session policy) or a PreToolUse hook that blocks it means it is not
    started; so does a command that needs approval now when it did not need it then (allowed by
    auto mode or a rule that has since gone). Those are shown as stopped, with a Restart the user
    can press; their press is the approval (a deny still wins). A command the user approved
    stays approved for the rest of its time limit. A command carrying a credential DGC knows is
    never written to the journal, so it is never restarted.

Time left
    A monitor's limit is wall-clock from its first start: a 5-minute monitor started at 10:00
    ends at 10:05 however long DGC was closed in between. ``persistent`` has no limit.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

SUFFIX = ".monitors"
SCHEMA_VERSION = 1
MAX_RECORDS = 8
MAX_JOURNAL_BYTES = 128 * 1024
HEARTBEAT_S = 30.0
LEASE_WAIT_S = 10.0          # how long a restart waits for the checkout's write lease
WAIT_FOR_OWNER_S = 30.0      # how long a reopen waits for the previous DGC to finish exiting

ENDS = ("stopped", "timeout", "exited", "flood", "rewound", "expired", "failed", "dgc_stopped")
RESTARTABLE = "dgc_stopped"
# How a monitor's stop request maps to how its run ended. "shutdown" is DGC stopping (the process
# ending, or the chat being closed or replaced), unless the caller names something else (a rewind).
STOP_ENDS = {"stopped": "stopped", "timeout": "timeout", "flood": "flood", "exited": "exited"}

_write_lock = threading.Lock()       # one journal read-modify-write at a time in this process


# ---- the journal -------------------------------------------------------------------------------
def journal_path(session_file, session_root) -> Path:
    from . import sessions
    return sessions.resolve_path(session_root, session_file).with_suffix(SUFFIX)


def _clean(record) -> dict | None:
    """A record as read from disk, or None when it is not one this version can use."""
    if not isinstance(record, dict):
        return None
    key, mid = record.get("key"), record.get("id")
    if not (isinstance(key, str) and re.fullmatch(r"[0-9a-f]{12}", key)):
        return None
    if not (isinstance(mid, str) and re.fullmatch(r"mon\d{1,9}", mid)):
        return None
    if record.get("state") not in ("running", "ended"):
        return None
    if record.get("state") == "ended" and record.get("end") not in ENDS:
        return None
    for name in ("started_at", "run_started_at"):
        if not isinstance(record.get(name), (int, float)) or isinstance(record.get(name), bool):
            return None
    return record


def read(session_file, session_root) -> list:
    """The journal's records, oldest first. [] when there is none or it cannot be read."""
    from . import sessions
    try:
        path = journal_path(session_file, session_root)
        with sessions._lock_for(path):
            if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_JOURNAL_BYTES:
                return []
            data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, RuntimeError):
        return []
    if not isinstance(data, dict) or data.get("schema_version") != SCHEMA_VERSION:
        return []
    return [r for r in (_clean(item) for item in list(data.get("records") or [])[:MAX_RECORDS * 2]) if r]


def _prune(records: list) -> list:
    """At most MAX_RECORDS: the running ones always stay; then the restartable ones, newest first."""
    if len(records) <= MAX_RECORDS:
        return records
    def rank(record):
        live = record.get("state") == "running" or record.get("end") in (RESTARTABLE, "failed")
        return (1 if live else 0, float(record.get("ended_at") or record.get("run_started_at") or 0))
    keep = sorted(records, key=rank, reverse=True)[:MAX_RECORDS]
    return [record for record in records if record in keep]


def update(session_file, session_root, mutate) -> bool:
    """Read the journal, let ``mutate(records)`` change the list in place, write it back.

    Best effort, never raises: a journal that cannot be written costs the restart, not the monitor.
    """
    from . import sessions
    try:
        path = journal_path(session_file, session_root)
        with _write_lock, sessions._lock_for(path):
            records = []
            if path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_JOURNAL_BYTES:
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                    if isinstance(data, dict) and data.get("schema_version") == SCHEMA_VERSION:
                        records = [r for r in (_clean(item) for item in data.get("records") or []) if r]
                except (OSError, ValueError, TypeError):
                    records = []
            before = json.dumps(records, sort_keys=True, default=str)
            mutate(records)
            records[:] = _prune(records)
            if json.dumps(records, sort_keys=True, default=str) == before:
                return True
            if not records:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
                return True
            text = json.dumps({"schema_version": SCHEMA_VERSION, "id": path.stem,
                               "records": records}, default=str)
            sessions._atomic_write(path, text)
        return True
    except (OSError, ValueError, TypeError, RuntimeError):
        return False


def _find(records: list, key: str) -> dict | None:
    return next((record for record in records if record.get("key") == key), None)


# ---- what the hub records ----------------------------------------------------------------------
def owner() -> dict:
    """This process, as a record names its owner: pid and when it started (a recycled pid differs)."""
    from .monitors import _probes
    pid = os.getpid()
    return {"pid": pid, "stamp": _probes["starttime"](pid)}


def owner_alive(who) -> bool:
    if not isinstance(who, dict) or not isinstance(who.get("pid"), int):
        return False
    pid = who["pid"]
    if pid <= 0:
        return False
    from .monitors import _probes
    stamp = _probes["starttime"](pid)
    if not stamp:
        return False
    return not who.get("stamp") or stamp == who.get("stamp")


def new_key() -> str:
    return uuid.uuid4().hex[:12]


def record_started(target, monitor, spec: dict, *, restart: dict | None = None) -> None:
    """A monitor started (or restarted): write its record as running."""
    if not target:
        return
    from .redaction import contains_secret, secret_values
    now = time.time()
    run = uuid.uuid4().hex[:12]
    monitor.journal_run = run
    if restart is not None:
        key = str(restart.get("key"))

        def mutate(records):
            record = _find(records, key)
            if record is None:
                return
            record.update({"id": monitor.id, "state": "running", "run": run, "owner": owner(),
                           "run_started_at": now, "alive_at": now, "restarts":
                           int(record.get("restarts") or 0) + 1})
            if spec.get("permission"):
                record["permission"] = dict(spec["permission"])   # the user's Restart approved it
            for stale in ("end", "ended_at"):
                record.pop(stale, None)
        monitor.journal_key = key
        update(*target, mutate)
        return
    key = new_key()
    monitor.journal_key = key
    command = str(spec.get("command") or "")
    secret = contains_secret(command, secret_values(getattr(monitor.hub, "config", None)))
    persistent = bool(spec.get("persistent"))
    timeout_ms = int(spec.get("timeout_ms") or 0)
    record = {
        "key": key, "id": monitor.id, "state": "running", "run": run, "owner": owner(),
        # A command carrying a credential DGC knows is not written down: never restarted.
        "command": "" if secret else command, "secret": secret,
        "description": str(spec.get("description") or "")[:200],
        "label": str(spec.get("label") or "")[:400],
        "cwd": str(spec.get("cwd") or ""),
        "persistent": persistent, "timeout_ms": timeout_ms,
        "started_at": now, "run_started_at": now, "alive_at": now,
        "deadline": None if persistent else now + timeout_ms / 1000.0,
        "sandboxed": bool(spec.get("sandboxed")),
        "permission": dict(spec.get("permission") or {}),
        "restarts": 0,
    }
    update(*target, lambda records: records.append(record))


def record_ended(target, monitor, end: str) -> None:
    """A monitor's run ended: say how, unless a newer run of the same record has begun since."""
    key, run = getattr(monitor, "journal_key", ""), getattr(monitor, "journal_run", "")
    if not target or not key:
        return
    now = time.time()

    def mutate(records):
        record = _find(records, key)
        if record is None or record.get("run") != run or record.get("state") != "running":
            return
        record.update({"state": "ended", "end": end if end in ENDS else RESTARTABLE,
                       "ended_at": now, "alive_at": now})
    update(*target, mutate)


def record_alive(target, monitors) -> None:
    """The heartbeat: these monitors are still watching (the stop time a killed DGC never wrote)."""
    runs = {getattr(m, "journal_key", ""): getattr(m, "journal_run", "") for m in monitors}
    if not target or not runs:
        return
    now = time.time()

    def mutate(records):
        for record in records:
            if record.get("state") == "running" and runs.get(record.get("key")) == record.get("run"):
                record["alive_at"] = now
    update(*target, mutate)


def move_running(old_target, new_target, monitors) -> None:
    """A branch continues this conversation in a new session: its running monitors go with it."""
    keys = {getattr(m, "journal_key", "") for m in monitors} - {""}
    if not old_target or not new_target or not keys:
        return
    moved: list = []

    def take(records):
        for record in [r for r in records if r.get("key") in keys]:
            records.remove(record)
            moved.append(record)
    update(*old_target, take)
    if moved:
        update(*new_target, lambda records: records.extend(moved))


# ---- reopening ---------------------------------------------------------------------------------
def _stopped_by_dgc(record: dict) -> bool:
    return record.get("state") == "running" or record.get("end") == RESTARTABLE


def _mine(record: dict, me: dict) -> bool:
    who = record.get("owner") or {}
    return who.get("pid") == me.get("pid") and who.get("stamp") == me.get("stamp")


def due(record: dict, me: dict | None = None) -> bool:
    """Is this record one a reopen restarts now: DGC's stopping ended it, and the process that ran it
    has ended? One whose process still runs is that DGC's (a window re-attached to it, or a chat
    switched away there), and is never restarted by another opening of the session."""
    me = me or owner()
    if not _stopped_by_dgc(record) or _mine(record, me):
        return False
    return not owner_alive(record.get("owner"))


def awaited(record: dict, me: dict | None = None) -> bool:
    """DGC's stopping ended it, but the process that ran it is still there: perhaps still exiting."""
    me = me or owner()
    return _stopped_by_dgc(record) and not _mine(record, me) and owner_alive(record.get("owner"))


def has_due(session_file, session_root) -> bool:
    me = owner()
    return any(due(record, me) or awaited(record, me) for record in read(session_file, session_root))


def _clock(at: float, other: float | None = None) -> str:
    """10:05, or Oct 17 22:10 when the other end of the span is on another day."""
    local = time.localtime(at)
    fmt = "%H:%M"
    if other is not None:
        there = time.localtime(other)
        if (there.tm_year, there.tm_yday) != (local.tm_year, local.tm_yday):
            fmt = "%b %d %H:%M"
        elif time.strftime("%H:%M", there) == time.strftime("%H:%M", local):
            fmt = "%H:%M:%S"
    return time.strftime(fmt, local)


def _name(record: dict) -> str:
    text = " ".join(str(record.get("description") or record.get("label") or record.get("id")).split())
    return text.replace('"', "'")[:80]


@dataclass
class Outcome:
    """What happened to one monitor when its chat came back (or when the user pressed Restart)."""
    key: str
    id: str
    description: str
    command: str
    state: str                  # restarted | stopped | expired | failed
    message: str                # the line the user sees
    note: str                   # the line the model reads
    stopped_at: float | None
    at: float
    restart: bool = False       # a Restart is offered
    by_user: bool = False

    def event(self) -> dict:
        """The fields of a `monitor_restart` event."""
        return {"key": self.key, "id": self.id, "description": self.description,
                "command": self.command, "state": self.state, "message": self.message,
                "stopped_at": int(self.stopped_at) if self.stopped_at else None,
                "at": int(self.at), "restart": bool(self.restart), "by_user": bool(self.by_user)}

    def item(self) -> dict:
        return {"key": self.key, "id": self.id, "description": self.description,
                "state": self.state, "message": self.message,
                "stopped_at": int(self.stopped_at) if self.stopped_at else None,
                "at": int(self.at), "by_user": bool(self.by_user)}


NOTICE_OPEN = "<dgc-note>"
NOTICE_CLOSE = "</dgc-note>"


def notice_message(outcomes: list) -> dict:
    """The transcript message that tells the model, at its next turn, what happened -- the same
    facts the user was shown. Tagged so every projection shows it as a note, never as a prompt."""
    by_user = all(outcome.by_user for outcome in outcomes)
    head = ("DGC note, not a message from the user: the user pressed Restart on a monitor that "
            "stopped when DGC stopped." if by_user else
            "DGC note, not a message from the user: DGC stopped while this chat had background "
            "monitors running (a window reload, a lost connection, or DGC closing), and the chat "
            "was opened again. Nothing watched while DGC was stopped: lines printed in that gap "
            "were not seen.")
    body = "\n".join(f"- {outcome.note}" for outcome in outcomes)
    label = (outcomes[0].message if len(outcomes) == 1
             else f"{len(outcomes)} monitors after DGC reopened this chat")
    return {"role": "user", "content": f"{NOTICE_OPEN}\n{head}\n{body}\n{NOTICE_CLOSE}",
            "_dgc_notice": {"kind": "monitor_restart", "label": label[:200],
                            "items": [outcome.item() for outcome in outcomes]}}


def history_items(message: dict) -> list:
    """A saved restart note as the editor replays it: one marker per monitor, no Restart."""
    notice = message.get("_dgc_notice") if isinstance(message, dict) else None
    items = []
    for row in list((notice or {}).get("items") or [])[:MAX_RECORDS]:
        if not isinstance(row, dict) or row.get("state") not in ("restarted", "stopped", "expired", "failed"):
            continue
        items.append({"role": "monitor_restart", "key": str(row.get("key") or "")[:16],
                      "id": str(row.get("id") or "")[:16], "state": row["state"],
                      "description": str(row.get("description") or "")[:200],
                      "message": str(row.get("message") or "")[:600],
                      "at": int(row.get("at") or 0) if isinstance(row.get("at"), int) else 0,
                      "restart": False})
    return items


def _why_blocked(decision: str, reason: str) -> str:
    text = str(reason or "")
    if decision == "deny":
        if text.startswith("plan mode"):
            return "plan mode is on"
        if text.startswith("blocked by deny rule"):
            return text.replace("blocked by deny rule", "a deny rule blocks it", 1)
        return text or "the permissions in force now do not allow it"
    return "it would need your approval now, and it did not when it started"


def _stopped_at(record: dict) -> tuple[float, bool]:
    """When it stopped watching, and whether that is only approximate (DGC died unassisted)."""
    if record.get("state") == "ended" and isinstance(record.get("ended_at"), (int, float)):
        return float(record["ended_at"]), False
    alive = record.get("alive_at")
    return (float(alive) if isinstance(alive, (int, float)) else float(record["run_started_at"])), True


def _outcome(record, state, message, note, stopped_at, now, *, restart=False, by_user=False,
             mid=None) -> Outcome:
    return Outcome(key=record["key"], id=mid or record["id"], description=_name(record),
                   command=str(record.get("label") or "")[:400], state=state, message=message,
                   note=note, stopped_at=stopped_at, at=now, restart=restart, by_user=by_user)


def _set_end(target, key: str, end: str) -> None:
    now = time.time()

    def mutate(records):
        record = _find(records, key)
        if record is not None:
            record.update({"state": "ended", "end": end, "ended_at": record.get("ended_at") or now})
    update(*target, mutate)


def _bring_back(agent, target, record: dict, *, by_user: bool) -> Outcome:
    """Restart one recorded monitor, or say why not. Never retries."""
    from .monitors import MIN_TIMEOUT_MS
    from .permissions import ASK, DENY
    now = time.time()
    name = _name(record)
    stopped_at, approximate = _stopped_at(record)
    since = _clock(stopped_at, now)
    gap = f"{'about ' if approximate else ''}{since} and {_clock(now, stopped_at)}"
    mid = record["id"]
    if record.get("secret") or not record.get("command"):
        _set_end(target, record["key"], "failed")
        why = "its command carried a credential, which DGC does not save"
        return _outcome(record, "failed", f'Monitor "{name}" was not restarted: {why}.',
                        f'{mid} "{name}" was NOT restarted: {why}. It is not running; nothing has '
                        f"watched it since {since}.", stopped_at, now, by_user=by_user)
    remaining_ms = None
    if not record.get("persistent"):
        deadline = record.get("deadline")
        deadline = float(deadline) if isinstance(deadline, (int, float)) else now
        remaining_ms = int((deadline - now) * 1000)
        if remaining_ms < MIN_TIMEOUT_MS:
            _set_end(target, record["key"], "expired")
            ran_out = _clock(deadline, stopped_at)
            while_closed = ", while DGC was closed" if deadline > stopped_at else ""
            return _outcome(record, "expired",
                            f'Monitor "{name}" was not restarted: its time limit ran out at '
                            f"{ran_out}{while_closed}.",
                            f'{mid} "{name}" was not restarted: its time limit ran out at {ran_out}. '
                            "It is not running.", stopped_at, now, by_user=by_user)
    command = str(record["command"])
    decision, reason = agent._monitor_permission("monitor", {"command": command})
    blocked = ""
    if decision == DENY:
        blocked = _why_blocked(DENY, reason)
    elif decision == ASK and not by_user and (record.get("permission") or {}).get("allowed_by") != "approval":
        blocked = _why_blocked(ASK, reason)
    allowed_by = "approval" if by_user else (record.get("permission") or {}).get("allowed_by", "policy")
    args = {"command": command, "description": record.get("description") or "",
            "persistent": bool(record.get("persistent")),
            "timeout_ms": remaining_ms if remaining_ms is not None else int(record.get("timeout_ms") or 0)}
    if not blocked:
        hooked, output = agent._run_lifecycle_hooks("PreToolUse", {"tool": "monitor", "args": args})
        if hooked:
            blocked = "a PreToolUse hook blocked it" + (f" ({str(output).strip()[:160]})" if str(output).strip() else "")
    if blocked:
        if by_user:
            return _outcome(record, "stopped",
                            f'Monitor "{name}" was not restarted: {blocked}.',
                            f'{mid} "{name}": the user pressed Restart, and it was not restarted: '
                            f"{blocked}. It is not running.", stopped_at, now, restart=True,
                            by_user=True)
        return _outcome(record, "stopped",
                        f'Monitor "{name}" stopped when DGC restarted: {blocked}, so it was not '
                        f"started again. Nothing has watched it since {since}.",
                        f'{mid} "{name}" was NOT restarted: {blocked}. It is not running; nothing '
                        f"has watched it since {since}. The user can restart it from the chat.",
                        stopped_at, now, restart=True)
    cancel = threading.Event()
    timer = threading.Timer(LEASE_WAIT_S, cancel.set)
    timer.daemon = True
    timer.start()
    try:
        ctx = SimpleNamespace(project_root=Path(record.get("cwd") or agent.config.project_root),
                              config=agent.config, cancelled=cancel)
        result, monitor = agent.monitors.start_monitor(
            {**args, "_dgc_permission": {"mode": agent.mode, "allowed_by": allowed_by}}, ctx,
            restart=record)
    finally:
        timer.cancel()
    if monitor is None:
        why = str(result or "it did not start").removeprefix("error:").strip().rstrip(".")
        _set_end(target, record["key"], "failed")
        return _outcome(record, "failed", f'Monitor "{name}" could not be restarted: {why}.',
                        f'{mid} "{name}" could not be restarted ({why}). It is not running; '
                        f"nothing has watched it since {since}.", stopped_at, now,
                        restart=True, by_user=by_user)
    renamed = f" It is {monitor.id} now." if monitor.id != mid else ""
    until = ("It runs until monitor_stop or the session ends." if record.get("persistent")
             else f"It stops at {_clock(float(record['deadline']), now)}, its original limit.")
    if by_user:
        message = f'Monitor "{name}" restarted; nothing was watched between {gap}.'
        note = (f'{mid} "{name}": the user restarted it at {_clock(now, stopped_at)} with the same '
                f"command, folder and sandbox. Nothing was watched between {gap}.{renamed} {until}")
    else:
        message = f'Monitor "{name}" restarted after DGC reopened this chat; nothing was watched between {gap}.'
        note = (f'{mid} "{name}" was restarted at {_clock(now, stopped_at)} with the same command, '
                f"folder and sandbox. Nothing was watched between {gap}.{renamed} {until}")
    return _outcome(record, "restarted", message, note, stopped_at, now, by_user=by_user,
                    mid=monitor.id)


def restart_all(agent) -> list:
    """Once per reopen: bring back every monitor of this session that DGC's stopping ended. One whose
    process is still exiting is left to ``restart_awaited`` (the frontend asks until it is gone)."""
    target = agent._monitor_journal_target()
    if target is None:
        return []
    me = owner()
    records = read(*target)
    outcomes = [_bring_back(agent, target, record, by_user=False) for record in records if due(record, me)]
    waiting = {record["key"] for record in records if awaited(record, me)}
    agent._monitor_restart_awaited = (waiting, time.monotonic() + WAIT_FOR_OWNER_S) if waiting else None
    if outcomes:
        agent._monitor_restart_noted(outcomes)
    return outcomes


def awaiting(agent) -> str:
    """"ready" when a monitor the reopen waited on can be brought back now, "wait" while its process
    is still there, "" when there is nothing (left) to wait for."""
    waiting = getattr(agent, "_monitor_restart_awaited", None)
    if not waiting:
        return ""
    keys, deadline = waiting
    target = agent._monitor_journal_target()
    me = owner()
    records = [r for r in read(*target) if r.get("key") in keys] if target else []
    if any(due(r, me) for r in records):
        return "ready"
    if time.monotonic() >= deadline or not any(awaited(r, me) for r in records):
        agent._monitor_restart_awaited = None    # it kept running: that DGC still has the session
        return ""
    return "wait"


def restart_awaited(agent) -> list:
    """The waited-on monitors whose process has now ended: as a reopen would have brought them back."""
    waiting = getattr(agent, "_monitor_restart_awaited", None)
    target = agent._monitor_journal_target()
    if not waiting or target is None:
        return []
    keys, deadline = waiting
    me = owner()
    records = [r for r in read(*target) if r.get("key") in keys]
    outcomes = [_bring_back(agent, target, record, by_user=False) for record in records if due(record, me)]
    left = {r["key"] for r in read(*target) if r.get("key") in keys and awaited(r, me)}
    agent._monitor_restart_awaited = (left, deadline) if left and time.monotonic() < deadline else None
    if outcomes:
        agent._monitor_restart_noted(outcomes)
    return outcomes


def restart_one(agent, key: str) -> Outcome | None:
    """The user pressed Restart. None when there is no such stopped monitor in this session."""
    target = agent._monitor_journal_target()
    if target is None:
        return None
    me = owner()
    record = next((r for r in read(*target) if r.get("key") == str(key or "")), None)
    if record is None or not (due(record, me) or record.get("end") == "failed"):
        return None
    outcome = _bring_back(agent, target, record, by_user=True)
    agent._monitor_restart_noted([outcome])
    return outcome
