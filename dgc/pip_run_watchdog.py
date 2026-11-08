"""A Pip run never hangs or dies silently (Pips package 1, decision D8, 0.52).

Before this, a run with no wall-clock budget (every chat reply, task and routine) waited on its worker for ever: a
model that stopped answering, or a tool that never came back, left the Pip "working" and its routines queued behind
it, with nothing said. A restart failed every running run.

- **Quiet means stuck.** The controller hears every line its worker writes. A run it hears nothing from for
  ``SILENCE_SECONDS`` (20 minutes), or ``TOOL_SILENCE_SECONDS`` (2 hours) while a tool call is open, is stopped. A run
  that is working is never touched, however long it takes: the worker says it is alive (``PULSE_SECONDS``) whenever
  its model writes or thinks, at most that often, and never from a timer, so a hung model goes quiet.
- **Waiting on you is not quiet.** Code in the supervisor that waits on the user inside a run (Chrome's own "Allow
  remote debugging?") holds ``waiting_on_you(run_id)``, and the clock stands still meanwhile. Everything else that
  needs the user is a card, and the run ends while it waits.
- **Started again, once.** A stuck run is started again in place, as the same run, told to check what it already did
  (``NOTES``), and its chat says "Got stuck, started again". Stuck a second time, it stops and says so.
- **A restart reruns it once.** A run the runner finds still running when it starts (it was restarted or updated
  mid-run) goes back in the queue, once, with the same note's restart wording.
- **Only what can safely run again.** A model run (a chat reply, a task, a routine, a review, a draft) is started
  again; a run that did its work in the controller (a standalone Pulse plan's commands, a live-data run's commands)
  or a reviewed change or test run (patch, test) never is: a second go could repeat what it did. Those fail as
  before, saying the runner stopped.
- **Nothing happens twice.** A run that already sent something (a computer submit or an app action that went out) is
  never run again by either path; it fails with one line saying why. What the stuck try only drafted is withdrawn,
  so the new try redoes it instead of the old card sending it a second time.

What each run has been through is kept in the registry's metadata (``KEY``), so a reload, History and the reply's
line all read the same thing.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager

from .workspace_registry import RegistryError

SILENCE_SECONDS = 20 * 60
TOOL_SILENCE_SECONDS = 2 * 60 * 60
PULSE_SECONDS = 30

KEY = "pip_run_attempts:"                # metadata: {"stalled": n, "restarted": n, "last": "stalled"|"restart"}
RETRY_ACTOR = "pip-retry"                # who withdrew a stuck try's unsent drafts

STUCK_LINE = "Got stuck, started again"
RESUMED_LINE = "DGC restarted, so it started again"
# What the new try is told, ahead of its usual prompt. Fixed words only: the worker refuses anything else.
NOTES = {
    "stalled": ("Note from DGC: your first try at this got stuck and DGC started it again. Check what you already did "
                "(your notes, your files, drafts waiting for the user) before you do any of it a second time."),
    "restart": ("Note from DGC: DGC restarted while you were working on this, so it started again. Check what you "
                "already did (your notes, your files, drafts waiting for the user) before you do any of it a second time."),
}

# The run's error when it stops instead (pip_report_delivery._REASONS has the same words).
STUCK_AGAIN = ("stalled", "Got stuck again, so it stopped.")
STUCK_NOT_RERUN = ("stalled_stopped", "Got stuck, so it stopped.")      # a run that may not run again (may_run_again)
STUCK_AFTER_SEND = ("stalled_after_send", "Got stuck after it had sent something, so it wasn't started again.")
RESTART_AFTER_SEND = ("interrupted_after_send", "DGC restarted after it had sent something, so it wasn't run again.")


class Stalled(RegistryError):
    """Raised by the controller when it stopped a quiet worker; the runner starts the run again once (pips)."""

    def __init__(self):
        super().__init__("stalled", "It went quiet for too long, so DGC stopped it.")


class Activity:
    """When the controller last heard its worker, and which tool calls are open. Thread-safe: the reader writes it,
    the watcher reads it."""

    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._lock = threading.Lock()
        self._at = clock()
        self._open: dict[str, int] = {}

    def heard(self, kind=None, event=None, mark=None) -> None:
        """Any line at all. A tool call opens, its result or refusal closes; a Pip's own tools mark the same as steps."""
        call = ""
        if isinstance(event, dict) and isinstance(event.get("call_id"), str):
            call = event["call_id"]
        if not call and isinstance(mark, dict) and isinstance(mark.get("call_id"), str):
            call = mark["call_id"]
        with self._lock:
            self._at = self._clock()
            if kind in ("tool_call", "step_start"):
                self._open[call] = self._open.get(call, 0) + 1
            elif kind in ("tool_result", "tool_denied", "step_end"):
                left = self._open.get(call, 0) - 1
                if left > 0:
                    self._open[call] = left
                else:
                    self._open.pop(call, None)

    def stuck(self, waiting=False) -> bool:
        """Whether it has been quiet past its limit. Waiting on the user resets the clock instead."""
        with self._lock:
            now = self._clock()
            if waiting:
                self._at = now
                return False
            limit = (limit_of("DGC_PIP_TOOL_SILENCE_SECONDS", TOOL_SILENCE_SECONDS) if self._open
                     else limit_of("DGC_PIP_SILENCE_SECONDS", SILENCE_SECONDS))
            return now - self._at >= limit


def limit_of(name, default) -> float:
    """A live check's shorter limit from the environment (DGC_PIP_SILENCE_SECONDS, DGC_PIP_TOOL_SILENCE_SECONDS), so a
    stuck run can be watched in real VS Code in seconds: only ever shorter than the default, and never under 10 s."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return max(10.0, min(float(default), value)) if value == value else default


def may_run_again(manifest) -> bool:
    """A run DGC may start again, after a stall or a restart: a model run whose effects it tracks (sent_something).
    Never a run that did its work in the controller (a standalone Pulse plan, a live-data run) or a reviewed change or
    test run (patch, test): a second go could repeat what the first one did."""
    if not isinstance(manifest, dict):
        return False
    if manifest.get("run_kind", "audit") not in ("conversation", "personal_task", "audit", "draft"):
        return False
    try:
        from .pip_pulse_plans import validate_manifest as standalone_pulse
        return standalone_pulse(manifest) is None
    except Exception:                       # noqa: BLE001 - can't tell what it is: never run it again
        return False


# -- Waiting on you: process-local, the supervisor is the only one that waits on the user inside a run ----------------
_WAITING: dict[str, int] = {}
_WAITING_LOCK = threading.Lock()


@contextmanager
def waiting_on_you(run_id):
    run_id = str(run_id or "")
    with _WAITING_LOCK:
        _WAITING[run_id] = _WAITING.get(run_id, 0) + 1
    try:
        yield
    finally:
        with _WAITING_LOCK:
            left = _WAITING.get(run_id, 0) - 1
            if left > 0:
                _WAITING[run_id] = left
            else:
                _WAITING.pop(run_id, None)


def is_waiting(run_id) -> bool:
    with _WAITING_LOCK:
        return _WAITING.get(str(run_id or ""), 0) > 0


# -- What a run has been through -----------------------------------------------------------------------------------

def attempts(db, run_id) -> dict:
    """{"stalled": n, "restarted": n, "last": ""|"stalled"|"restart", "told": bool}: nothing yet is all zero."""
    blank = {"stalled": 0, "restarted": 0, "last": "", "told": False}
    try:
        row = db.execute("SELECT value FROM metadata WHERE key=?", (KEY + str(run_id),)).fetchone()
        value = json.loads(row[0]) if row is not None and len(row[0]) <= 512 else {}
    except (sqlite3.Error, TypeError, ValueError):
        return blank
    if not isinstance(value, dict):
        return blank
    return {"stalled": value.get("stalled") if type(value.get("stalled")) is int else 0,
            "restarted": value.get("restarted") if type(value.get("restarted")) is int else 0,
            "last": value.get("last") if value.get("last") in NOTES else "",
            "told": value.get("told") is True}


def _save(db, run_id, value) -> None:
    db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (KEY + str(run_id), json.dumps(value, sort_keys=True)))


def record(db, run_id, why) -> dict:
    """Count one more stall or restart for a run, in the caller's transaction."""
    value = attempts(db, run_id)
    value["stalled" if why == "stalled" else "restarted"] += 1
    value["last"], value["told"] = ("stalled" if why == "stalled" else "restart"), False
    _save(db, run_id, value)
    return value


def told(db, run_id) -> None:
    """Its chat has said it started again; a reload doesn't say it twice."""
    value = attempts(db, run_id)
    value["told"] = True
    _save(db, run_id, value)


def note_for(db, run_id) -> str | None:
    """What a run's next try is told, if it is a try after a stall or a restart."""
    last = attempts(db, run_id)["last"]
    return NOTES.get(last)


def line_for(db, run_id) -> str:
    """The one line a run that started again shows: "" for a run that never did."""
    value = attempts(db, run_id)
    return {"stalled": STUCK_LINE, "restart": RESUMED_LINE}.get(value["last"], "")


def sent_something(db, run_id) -> bool:
    """Whether anything this run did has gone out: a computer submit that was sent, or an app action that went (or
    may have gone: ``unknown``). Drafts and cards waiting for the user haven't."""
    for query in ("SELECT 1 FROM pip_computer_actions WHERE run_id=? AND status='sent' LIMIT 1",
                  "SELECT 1 FROM pip_app_actions WHERE source_run_id=? AND status IN ('dispatching','succeeded','unknown') LIMIT 1"):
        try:
            if db.execute(query, (str(run_id),)).fetchone() is not None:
                return True
        except sqlite3.OperationalError:
            continue                    # an older registry without that table has sent nothing through it
    return False


def withdraw_unsent(db, run_id, now) -> int:
    """What a stuck try drafted and nobody decided yet, withdrawn before the new try (which redoes it), in the
    caller's transaction: otherwise both the old card and the new try's could send the same thing."""
    withdrawn = 0
    for query in ("UPDATE pip_computer_actions SET status='expired',resolved_by=?,resolved_at=? WHERE run_id=? AND status='pending'",
                  "UPDATE pip_app_actions SET status='expired',resolved_by=?,resolved_at=? WHERE source_run_id=? AND status='pending'"):
        try:
            withdrawn += db.execute(query, (RETRY_ACTOR, now, str(run_id))).rowcount
        except sqlite3.OperationalError:
            continue
    return withdrawn
