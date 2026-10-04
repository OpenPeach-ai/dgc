"""Explicit local supervision of the existing Pips worker, without another agent loop.

The SQLite metadata rows contain JSON control/heartbeat records. No PID from a
record is ever signalled. The existing pips-runner lease still owns actual work.
"""
from __future__ import annotations

import json
import os
import signal
import threading
from datetime import datetime

from .scheduler import named_process_lock
from .workspace_registry import RegistryError, WorkspaceRegistry, identifier, state_directory, utc_now

CONTROL_KEY = "pips_runtime_control"
SUPERVISOR_KEY = "pips_supervisor"
HEARTBEAT_SECONDS = 2.0
STALE_SECONDS = 15.0
_UNSET = object()


def _read(registry, key):
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
    if row is None:
        return None
    try:
        if len(row[0]) > 8192:
            raise ValueError("oversized record")
        value = json.loads(row[0])
        if not isinstance(value, dict) or type(value.get("schema_version")) is not int or value["schema_version"] != 1:
            raise ValueError("invalid record")
        return value
    except (ValueError, TypeError):
        return {"invalid": True}


def _write(registry, key, value):
    registry.db.execute("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (key, json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)))


def is_runtime_paused(registry):
    """Read on every claim/enqueue, inside its transaction. Malformed state stops work."""
    value = _read(registry, CONTROL_KEY)
    return value is not None and (type(value.get("paused")) is not bool or value["paused"])


def _counts(registry):
    counts = {"queued": 0, "running": 0, "cancelling": 0}
    for row in registry.db.execute("SELECT status,count(*) FROM pip_runs WHERE status IN ('queued','running','cancelling') GROUP BY status"):
        counts[row[0]] = row[1]
    return counts


def runner_status(registry):
    """Heartbeat freshness is an observation, not evidence that a model is reachable."""
    value = _read(registry, SUPERVISOR_KEY) or {}
    status = value.get("status", "offline")
    if status not in ("running", "stopping", "stopped"):
        status = "offline"
    fresh = False
    try:
        age = (datetime.fromisoformat(registry.clock().replace("Z", "+00:00"))
               - datetime.fromisoformat(value["heartbeat_at"].replace("Z", "+00:00"))).total_seconds()
        fresh = 0 <= age <= STALE_SECONDS
    except (KeyError, TypeError, ValueError, AttributeError):
        pass
    online = fresh and status in ("running", "stopping")
    paused = is_runtime_paused(registry)
    if status != "stopped" and not online:
        status = "offline"
    elif online and paused:
        status = "stopping"
    result = {"runner_id": registry.runner_id, "status": status, "online": online,
            "paused": paused, "heartbeat_at": value.get("heartbeat_at"),
            "started_at": value.get("started_at"), "counts": _counts(registry)}
    error = value.get("error")
    if isinstance(error, dict) and error.get("code") == "runner_failed" and isinstance(error.get("message"), str):
        result["error"] = {"code": "runner_failed", "message": error["message"][:300]}
    return result


def _actor(actor):
    if not isinstance(actor, str) or not actor.strip() or len(actor) > 160 or "\x00" in actor:
        raise RegistryError("invalid_request", "The runtime operation requires an actor identifier.")
    return actor.strip()


def _set_paused(registry, paused, actor, *, expected_control=_UNSET):
    with registry.transaction():
        if expected_control is not _UNSET and _read(registry, CONTROL_KEY) != expected_control:
            raise RegistryError("conflict", "The runtime stop changed while resuming. Review its status and retry locally.")
        _write(registry, CONTROL_KEY, {"schema_version": 1, "paused": paused,
                                      "revision": identifier("control"),
                                      "changed_at": registry.clock(), "actor": actor})
        from .pip_event_triggers import discard_runtime_backlog
        discard_runtime_backlog(registry)
        for workspace in registry.list():
            registry.event(workspace["id"], "pip_runtime_stopped" if paused else "pip_runtime_resumed",
                           payload={"actor": actor})


def stop_all(config, actor):
    """Persist emergency stop first; stale Config objects cannot override this record."""
    from .pips import PipStore
    actor = _actor(actor)
    with WorkspaceRegistry() as registry:
        _set_paused(registry, True, actor)
        store = PipStore(registry)
        jobs = [row[0] for row in registry.db.execute("SELECT id FROM pips WHERE status='active'")]
        for pip_id in jobs:
            store.set_paused(pip_id, True, actor)
        runs = [row[0] for row in registry.db.execute("SELECT id FROM pip_runs WHERE status IN ('queued','running','cancelling')")]
        for run_id in runs:
            store.cancel(run_id, actor)
        result = runner_status(registry)
        result["affected"] = {"paused_jobs": len(jobs), "cancelled_runs": len(runs)}
        return result


def resume_runtime(config, actor):
    """Local-only: clear global stop, leaving jobs paused and launching no worker."""
    from .pips import PipStore
    actor = _actor(actor)
    directory = state_directory()
    supervisor = named_process_lock("pips-supervisor", str(directory))
    if not supervisor.acquire(blocking=False):
        raise RegistryError("runner_running", "Wait for the Pips supervisor to stop before resuming the runtime.")
    worker = named_process_lock("pips-runner", str(directory))
    held = False
    try:
        held = worker.acquire(blocking=False)
        if not held:
            raise RegistryError("runner_running", "Wait for the current Pips worker to finish stopping before resuming.")
        with WorkspaceRegistry(directory) as registry:
            expected_control = _read(registry, CONTROL_KEY)
            # Holding the worker lease proves these are interrupted records, not live work.
            PipStore(registry).recover()
            _set_paused(registry, False, actor, expected_control=expected_control)
            return runner_status(registry)
    finally:
        if held:
            worker.release()
        supervisor.release()


def _heartbeat(registry, record, status):
    with registry.transaction():
        current = _read(registry, SUPERVISOR_KEY)
        if current is not None and current.get("instance_id") != record["instance_id"]:
            raise RegistryError("supervisor_changed", "The Pips supervisor identity changed unexpectedly.")
        record.update(status=status, heartbeat_at=registry.clock())
        _write(registry, SUPERVISOR_KEY, record)


def _controller(directory):
    from . import pips
    with pips._THREAD_LOCK:
        return pips._THREADS.get(str(directory))


def _shutdown_owned(registry, runtime_config, record):
    from . import pips
    # A non-persisting clone: ordinary Ctrl+C does not change the user's enable flag
    # or the global emergency stop, and never cancels another process's runs.
    runtime_config.set("pips_enabled", False, persist=False)
    failure = None
    while True:
        thread = _controller(registry.directory)
        if thread is None:
            break
        run_id = pips.active_run_id(registry.directory)
        if run_id:
            try:
                pips.PipStore(registry).cancel(run_id, "local-supervisor-shutdown")
            except Exception as exc:
                failure = failure or exc
        try:
            _heartbeat(registry, record, "stopping")
        except Exception as exc:
            failure = failure or exc
        # Do not abandon an owned process because writing status failed. The
        # disabled config also reaches the worker's existing cancellation watch.
        thread.join(HEARTBEAT_SECONDS)
    if failure:
        raise failure


def serve(config, *, enable=False, stop_event=None, clock=utc_now):
    """Foreground heartbeat/queue supervision; Event.wait is injectable for tests."""
    from . import pips
    from .pip_schedules import ScheduleTick, has_due_schedule
    from .pip_event_triggers import EventTick, has_due_trigger
    if enable:
        config.set("pips_enabled", True)
    if config.get("pips_enabled", False) is not True:
        raise RegistryError("disabled", "Pips are disabled in this profile. Run dgc pips serve --enable to turn them on.")
    directory = state_directory()
    lease = named_process_lock("pips-supervisor", str(directory))
    if not lease.acquire(blocking=False):
        raise RegistryError("runner_running", "A Pips supervisor is already running for this local state directory.")
    event = stop_event if stop_event is not None else threading.Event()
    handlers = {}
    schedule_tick = None
    event_tick = None
    try:
        with WorkspaceRegistry(directory, clock=clock) as registry:
            if is_runtime_paused(registry):
                raise RegistryError("runtime_paused", "Pips were stopped. Run dgc pips resume locally before starting the supervisor.")
            pips.clear_drain_failure(directory)
            runtime_config = config.clone_for_root(config.project_root)
            record = {"schema_version": 1, "instance_id": identifier("supervisor"),
                      "pid": os.getpid(), "started_at": clock(), "heartbeat_at": clock(), "status": "running"}
            with registry.transaction():
                _write(registry, SUPERVISOR_KEY, record)
            if stop_event is None and threading.current_thread() is threading.main_thread():
                for sig in (signal.SIGINT, signal.SIGTERM):
                    handlers[sig] = signal.getsignal(sig)
                    signal.signal(sig, lambda *_: event.set())
            try:
                while not event.is_set() and not is_runtime_paused(registry):
                    _check_controller(directory)
                    if schedule_tick is not None:
                        schedule_tick.check()
                    if event_tick is not None:
                        event_tick.check()
                    _heartbeat(registry, record, "running")
                    if ((schedule_tick is None or not schedule_tick.is_alive())
                            and has_due_schedule(registry)):
                        schedule_tick = ScheduleTick(runtime_config, directory, clock)
                        schedule_tick.start()
                    if ((event_tick is None or not event_tick.is_alive()) and has_due_trigger(registry)):
                        event_tick = EventTick(runtime_config, directory, clock)
                        event_tick.start()
                    pips.start_queued(runtime_config)
                    _check_controller(directory)
                    stopping = event.wait(HEARTBEAT_SECONDS)
                    _check_controller(directory)
                    if stopping:
                        break
            finally:
                schedule_failure = None
                if event_tick is not None:
                    event_tick.stop()
                    try:
                        event_tick.join()
                    except RegistryError as exc:
                        schedule_failure = exc
                        record["error"] = {"code": exc.code, "message": str(exc)}
                if schedule_tick is not None:
                    schedule_tick.stop()
                    try:
                        schedule_tick.join()
                    except RegistryError as exc:
                        schedule_failure = exc
                        record["error"] = {"code": exc.code, "message": str(exc)}
                _shutdown_owned(registry, runtime_config, record)
                failure = pips.drain_failure(directory)
                if failure:
                    record["error"] = failure
                _heartbeat(registry, record, "stopped")
                _check_controller(directory)
                if schedule_failure is not None:
                    raise schedule_failure
            return runner_status(registry)
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
        lease.release()


def _check_controller(directory):
    from .pips import drain_failure
    failure = drain_failure(directory)
    if failure:
        raise RegistryError(failure["code"], failure["message"])


def handle_command(config, argv):
    """Compatibility route; the product CLI owns parsing and confirmations."""
    from .pip_cli import handle_command as local_command
    return local_command(config, argv)
