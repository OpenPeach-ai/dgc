"""Pips on a server, with no VS Code and no desktop (Pips for SDK apps, part 4).

A developer runs their own app and DGC's Pips runner on a server or in a container, and needs to know it is healthy:

* **Health** (``dgc pips health``): exit 0 when the runner is online and running and holds its supervisor lease, else
  exit 1 with one line saying why: Pips are off, Pips are stopped, no runner runs, its heartbeat is stale, or the
  state can't be read. ``--json`` gives the same as one object, for probes. It only reads: the registry is opened
  read-only (never created, migrated or written), and the lease is looked at only while a fresh heartbeat says a
  runner already holds it, so a runner that is starting never meets the probe. Cheap enough to run every 10 seconds.
* **Server mode** (``dgc pips serve --server``, and the unit ``dgc pips service install --server`` writes): the same
  foreground supervisor without the paths a desktop needs. No desktop notifications; no borrowing the user's
  signed-in Chrome (a server has none: the Pip is told so and asks nobody); one plain line on stdout for each event,
  for ``docker logs`` and journald. Pip computers stay where their sandbox runs headless, and where it doesn't, each
  says why (pip_computer_box.capability, logged once at start).
* **The guardrail**: on a server, Pips run on an API key or a self-hosted model only. A run whose model is the user's
  own Claude Code or Codex plan (pip_brain, chosen for the Pip or followed through "Same as DGC") is refused before
  anything starts: the run is marked failed (``server_subscription``) with words saying why and how to change it,
  and is never switched to another model.

Server mode is a property of the supervisor process (``active``), set for as long as ``pip_daemon.serve`` runs with
``server=True``; the runs it starts read it. The supervisor's own record says so too (``mode``), for health and for
the SDK side's Keep Pips running notice (pip_keep_running.for_schedule): a server runner needs no login service.
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
import sys
import threading
from datetime import datetime
from pathlib import Path

from .workspace_registry import RegistryError, state_directory, utc_now

_SERVER = threading.Event()
MODE = "server"                          # the supervisor record's "mode" while it runs in server mode
SUBSCRIPTION_REFUSED = "server_subscription"
NO_CHROME = ("This Pips runner is on a server, where there is no Chrome of the user's to lend, so borrowing their "
             "Chrome isn't possible here. Do what you can without it, and say what you would need.")
QUIET_EVENTS = frozenset({"pip_run_progress"})      # a run's every step: its chat and report have them
MAX_DETAIL = 400
STATES = ("running", "off", "stopped", "no_runner", "heartbeat_stale", "state_unreadable")


def active() -> bool:
    """Whether this process's supervisor runs in server mode."""
    return _SERVER.is_set()


@contextlib.contextmanager
def server_mode():
    _SERVER.set()
    try:
        yield
    finally:
        _SERVER.clear()


# --------------------------------------------------------------------------------------------- the guardrail

def _plan(settings) -> str:
    engine = str(((settings or {}).get("brain") or {}).get("engine") or "")
    try:
        from .pip_brain import ENGINES, name
        return name(engine) if engine in ENGINES else "Claude Code or Codex"
    except Exception:                    # noqa: BLE001 - the words still say what was refused
        return "Claude Code or Codex"


def subscription_refusal(plan: str, pip_id: str, version, follows_default: bool) -> str:
    whose = (f"this Pip follows DGC's default model, which here is your {plan} plan" if follows_default
             else f"this Pip's model is your {plan} plan")
    change = (f"Set DGC's own model to an API key or a self-hosted model (dgc setup), or give this Pip one: in its "
              f"Settings, or with dgc pips propose {pip_id} --expected-version {version} --model MODEL and then "
              "dgc pips accept." if follows_default else
              f"Give this Pip an API-key or self-hosted model instead: in its Settings, or with dgc pips propose "
              f"{pip_id} --expected-version {version} --model MODEL and then dgc pips accept.")
    return (f"Not run: {whose}, and Pips on a server run only on an API key or a self-hosted model. A personal "
            f"Claude Code or Codex plan is for you at your own computer, not for a server, so DGC doesn't use it "
            f"here and doesn't switch this Pip to another model by itself. {change} Then run it again.")


def refuse_subscription(registry, row, settings) -> None:
    """In server mode, refuse a run whose pinned model is a personal subscription (its settings carry ``brain``)."""
    if not active() or not isinstance(settings, dict) or "brain" not in settings:
        return
    version, follows_default = "N", False
    try:
        found = registry.db.execute("SELECT current_version FROM pips WHERE id=?", (row["pip_id"],)).fetchone()
        if found is not None:
            version = found[0]
            definition = registry.db.execute("SELECT definition FROM pip_versions WHERE pip_id=? AND version=?",
                                             (row["pip_id"], version)).fetchone()
            choice = json.loads(definition[0]).get("model_choice") if definition is not None else None
            follows_default = isinstance(choice, dict) and choice.get("mode") == "default"
    except (sqlite3.Error, ValueError, TypeError, KeyError, IndexError):
        pass
    raise RegistryError(SUBSCRIPTION_REFUSED, subscription_refusal(_plan(settings), row["pip_id"], version,
                                                                   follows_default))


# --------------------------------------------------------------------------------------------- one line per event

def _plain(text, limit=MAX_DETAIL) -> str:
    """One line, with no control characters: what a log line may carry."""
    flat = " ".join("".join(ch if ch.isprintable() else " " for ch in str(text or "")).split())
    return flat if len(flat) <= limit else flat[:limit - 1] + "…"


def line(event: str, detail: str = "", *, at: str | None = None, **fields) -> str:
    """``<UTC time> <event>[ key=value ...][: detail]``: one plain line, for docker logs and journald."""
    parts = [_plain(at or utc_now(), 40), _plain(event, 80)]
    parts += [f"{key}={_plain(value, 120).replace(' ', '_')}" for key, value in fields.items() if value not in (None, "")]
    text = " ".join(parts)
    return text + (": " + _plain(detail) if detail else "")


def say(event: str, detail: str = "", *, out=None, **fields) -> None:
    stream = out if out is not None else sys.stdout
    try:
        print(line(event, detail, **fields), file=stream, flush=True)
    except (OSError, ValueError):        # a closed stdout never stops the runner
        pass


def _error_detail(payload) -> str:
    error = payload.get("error") if isinstance(payload.get("error"), dict) else payload
    code, message = error.get("code"), error.get("message")
    if not isinstance(code, str) or not code:
        return ""
    return code + (": " + message if isinstance(message, str) and message else "")


class EventLog:
    """Tails the registry's activity from where it stood at start and prints one line for each event. A run's
    progress steps are left out; a failed or cancelled run says why in its own words (already redacted)."""

    def __init__(self, registry, *, out=None):
        self.out = out
        self.last = registry.db.execute("SELECT COALESCE(MAX(seq),0) FROM workspace_events").fetchone()[0]
        self._said = None                # the last line's content: one stop recorded in each workspace is one line

    def say(self, event, detail="", **fields):
        say(event, detail, out=self.out, **fields)

    def tick(self, registry) -> int:
        rows = registry.db.execute("SELECT seq,event_type,pip_id,run_id,payload,created_at FROM workspace_events "
                                   "WHERE seq>? ORDER BY seq LIMIT 500", (self.last,)).fetchall()
        told = 0
        for seq, kind, pip_id, run_id, payload, created_at in rows:
            self.last = seq
            if kind in QUIET_EVENTS:
                continue
            try:
                value = json.loads(payload)
            except (TypeError, ValueError):
                value = {}
            value = value if isinstance(value, dict) else {}
            fields = {"pip": pip_id, "run": run_id}
            detail = ""
            if kind == "pip_run_queued" and run_id:
                by = registry.db.execute("SELECT requested_by FROM pip_runs WHERE id=?", (run_id,)).fetchone()
                fields["by"] = by[0] if by else None
            elif kind in ("pip_run_failed", "pip_run_cancelled"):
                detail = _error_detail(value)
            elif kind in ("pip_runtime_stopped", "pip_runtime_resumed"):
                fields["by"] = value.get("actor") if isinstance(value.get("actor"), str) else None
            said = (kind, created_at, detail, tuple(fields.items()))
            if said == self._said:
                continue
            self._said = said
            self.say(kind, detail, at=created_at, **fields)
            told += 1
        return told


def started(log: EventLog, directory: Path) -> None:
    """The runner's first lines: that it runs in server mode, where, and whether Pip computers can run here."""
    from . import __version__
    log.say("runner_started", f"server mode, DGC {__version__}, Pips state {directory}")
    try:
        from .pip_computer_box import capability
        can = capability()
        if can.get("available"):
            log.say("pip_computers", "available here (their own headless browser, in a bubblewrap box)")
        else:
            log.say("pip_computers", "unavailable here: " + str(can.get("reason") or "no reason given"))
    except Exception as exc:             # noqa: BLE001 - a check, never a reason not to run
        log.say("pip_computers", f"unavailable here: the check failed ({type(exc).__name__})")


def is_server_runner(registry) -> bool:
    """Whether the supervisor record of this state says it runs in server mode (online or not: callers check)."""
    try:
        from .pip_daemon import SUPERVISOR_KEY, _read
        value = _read(registry, SUPERVISOR_KEY) or {}
        return value.get("mode") == MODE
    except Exception:                    # noqa: BLE001
        return False


# --------------------------------------------------------------------------------------------- health

class _ReadOnlyState:
    """What pip_daemon.runner_status reads from a registry, over a read-only connection."""

    def __init__(self, db, now):
        self.db, self._now = db, now
        row = db.execute("SELECT value FROM metadata WHERE key='runner_id'").fetchone()
        self.runner_id = row[0] if row else None

    def clock(self):
        return self._now


def _age(now: str, then) -> float | None:
    try:
        return round((datetime.fromisoformat(now.replace("Z", "+00:00"))
                      - datetime.fromisoformat(str(then).replace("Z", "+00:00"))).total_seconds(), 1)
    except (TypeError, ValueError, AttributeError):
        return None


def _seconds(value: float) -> str:
    value = max(0, int(round(value)))
    if value < 120:
        return f"{value} s"
    if value < 7200:
        return f"{value // 60} min"
    return f"{value // 3600} h"


def _result(state, message, **facts) -> dict:
    value = {"healthy": state == "running", "state": state, "message": message}
    value.update(facts)
    return value


def health(config, *, directory: Path | None = None, now: str | None = None) -> dict:
    """Is the Pips runner of this DGC home online and running, holding its lease? Read-only; never raises."""
    try:
        return _health(config, directory, now or utc_now())
    except Exception as exc:             # noqa: BLE001 - a probe answers, whatever happened
        return _result("state_unreadable", f"The Pips runner's state can't be read ({type(exc).__name__}).")


def _health(config, directory, now) -> dict:
    from . import pip_daemon
    if config.get("pips_enabled", False) is not True:
        return _result("off", "Pips are off in this DGC profile. Turn them on: dgc pips enable (or dgc pips serve "
                       "--server --enable), then start the runner.")
    directory = Path(directory) if directory is not None else state_directory()
    path = directory / "registry.sqlite3"
    try:
        info = path.lstat()
    except FileNotFoundError:
        return _result("no_runner", "No Pips runner has run with this DGC home yet. Start one: dgc pips serve --server.",
                       lease_held=False)
    except OSError as exc:
        return _result("state_unreadable", f"The Pips state at {path} can't be read ({type(exc).__name__}).")
    import stat
    if not stat.S_ISREG(info.st_mode):
        return _result("state_unreadable", f"The Pips state at {path} is not a regular file.")
    try:
        # mode=ro: a probe never creates, upgrades or writes the registry, whichever DGC version made it.
        db = sqlite3.connect(path.absolute().as_uri() + "?mode=ro", uri=True, timeout=2, isolation_level=None)
    except sqlite3.Error as exc:
        return _result("state_unreadable", f"The Pips state at {path} can't be opened ({type(exc).__name__}).")
    try:
        db.execute("PRAGMA query_only=1")
        state = _ReadOnlyState(db, now)
        record = pip_daemon._read(state, pip_daemon.SUPERVISOR_KEY)
        control = pip_daemon._read(state, pip_daemon.CONTROL_KEY)
        if (record or {}).get("invalid") or (control or {}).get("invalid"):
            return _result("state_unreadable", "The Pips runner's saved state is damaged and can't be read.")
        status = pip_daemon.runner_status(state)
    except sqlite3.Error as exc:
        return _result("state_unreadable", f"The Pips state at {path} can't be read ({type(exc).__name__}).")
    finally:
        db.close()
    record = record or {}
    age = _age(now, record.get("heartbeat_at"))
    facts = {"status": status["status"], "online": status["online"], "paused": status["paused"],
             "heartbeat_at": status["heartbeat_at"], "heartbeat_age_seconds": age, "started_at": status["started_at"],
             "server_mode": record.get("mode") == MODE if record else None, "counts": status["counts"],
             "lease_held": None}
    if status["paused"]:
        return _result("stopped", "Pips are stopped: the emergency stop is on. Run dgc pips resume, then start the "
                       "runner again.", **facts)
    if not record:
        return _result("no_runner", "No Pips runner has started with this DGC home. Start one: dgc pips serve --server.",
                       **{**facts, "lease_held": False})
    said = record.get("status")
    if said == "stopped":
        error = (record.get("error") or {}) if isinstance(record.get("error"), dict) else {}
        why = f" It said: {_plain(error.get('message'), 300)}" if isinstance(error.get("message"), str) else ""
        when = f" at {record['heartbeat_at']}" if isinstance(record.get("heartbeat_at"), str) else ""
        return _result("no_runner", f"No Pips runner is running: the last one stopped{when}.{why}", **facts)
    fresh = age is not None and 0 <= age <= pip_daemon.STALE_SECONDS
    if not fresh:
        if age is None:
            return _result("heartbeat_stale", "The Pips runner's heartbeat can't be read: it is stuck, or it stopped "
                           "without saying so.", **facts)
        if age < 0:
            return _result("heartbeat_stale", "The Pips runner's last heartbeat is in the future: check this "
                           "computer's clock.", **facts)
        return _result("heartbeat_stale", f"The Pips runner's last heartbeat was {_seconds(age)} ago (it beats every "
                       f"{int(pip_daemon.HEARTBEAT_SECONDS)} s): it is stuck, or it stopped without saying so.", **facts)
    if said != "running":
        return _result("no_runner", "The Pips runner is shutting down.", **facts)
    # A fresh heartbeat says a runner took the lease before writing it, so this look can't collide with a runner
    # that is starting (its non-blocking take would fail); an empty lease means the runner has just gone.
    from .scheduler import named_process_lock
    lease = named_process_lock("pips-supervisor", str(directory))
    if lease.acquire(blocking=False):
        lease.release()
        return _result("no_runner", "No Pips runner holds the lease, though its heartbeat is recent: it stopped a "
                       "moment ago.", **{**facts, "lease_held": False})
    if lease.last_error:
        return _result("state_unreadable", "The Pips runner's lease can't be checked here.", **facts)
    counts = status["counts"]
    work = f"{counts['running']} running, {counts['queued']} queued"
    return _result("running", f"The Pips runner is running{' in server mode' if facts['server_mode'] else ''}: "
                   f"heartbeat {_seconds(age)} ago; {work}.", **{**facts, "lease_held": True})
