"""Reviewed event triggers for source auditors and Quill's private drafts.

Only trusted controller event *identities* enter a run. Event payloads are never
copied into prompts, and an event grants no tools, permissions, or source access.
"""
from __future__ import annotations

import json
import re
import threading
from datetime import timedelta

from .pip_schedules import _instant, timestamp
from .workspace_registry import RegistryError, WorkspaceRegistry

SCHEMA_V10 = """
CREATE TABLE pip_event_trigger_state(
    pip_id TEXT PRIMARY KEY REFERENCES pips(id),
    job_version INTEGER NOT NULL,
    after_seq INTEGER NOT NULL CHECK(typeof(after_seq)='integer' AND after_seq>=0),
    next_allowed_at TEXT NOT NULL,last_checked_at TEXT,
    FOREIGN KEY(pip_id,job_version) REFERENCES pip_versions(pip_id,version));
CREATE INDEX pip_event_trigger_due ON pip_event_trigger_state(last_checked_at,pip_id);
CREATE INDEX pip_event_source ON workspace_events(workspace_id,event_type,seq);
"""
EVENTS = {
    "context_updated": ("workspace_context_recorded", "workspace_context_archived",
                        "workspace_finding_accepted", "workspace_execution_recorded"),
    "finding_accepted": ("pip_finding_accepted",),
    "commit_changed": ("workspace_commit_changed",),
    "committed_paths_changed": ("workspace_committed_paths_changed",),
    "session_turn_completed": ("workspace_session_turn_completed",),
}
MAX_TICK_ITEMS = 8
CHECK_SECONDS = 30
_OCCURRENCE = {"job_version", "expected_after_seq", "checked_at", "event", "history_may_be_incomplete"}
_EVENT = {"seq", "event_id", "event_type", "created_at"}
_SOURCE_SEMANTICS = "Current approved committed source at enqueue; event metadata does not select a historical checkout."


def validate_event_trigger(value):
    if value is None:
        return None
    if not isinstance(value, dict) or len(value) > 4 or set(value) - {"events", "minimum_minutes", "missed_policy", "commit_paths"}:
        raise RegistryError("invalid_event_trigger", "Use events, minimum_minutes and coalesce_latest for an event trigger.")
    events = value.get("events")
    if (not isinstance(events, list) or not 1 <= len(events) <= len(EVENTS)
            or any(not isinstance(item, str) or item not in EVENTS for item in events)
            or len(set(events)) != len(events)):
        raise RegistryError("invalid_event_trigger", "Choose distinct supported context, finding, committed-source or saved-turn events.")
    paths = "committed_paths_changed" in events
    if paths and "commit_changed" in events:
        raise RegistryError("invalid_event_trigger", "Choose either all committed changes or reviewed committed paths, not both.")
    if paths != ("commit_paths" in value):
        raise RegistryError("invalid_event_trigger", "Reviewed path rules are required only for committed_paths_changed.")
    minutes = value.get("minimum_minutes", 5)
    if type(minutes) is not int or not 5 <= minutes <= 10080:
        raise RegistryError("invalid_event_trigger", "Event-triggered runs must be at least 5–10080 minutes apart.")
    if value.get("missed_policy", "coalesce_latest") != "coalesce_latest":
        raise RegistryError("invalid_event_trigger", "Missed events coalesce to the latest retained event; backlog replay is unsupported.")
    result = {"events": sorted(events), "minimum_minutes": minutes, "missed_policy": "coalesce_latest"}
    if paths:
        from .pip_commit_paths import validate_rules
        result["commit_paths"] = validate_rules(value["commit_paths"])
    return result


def _definition(registry, pip_id):
    row = registry.db.execute("""SELECT p.workspace_id,p.current_version,p.status,
        CASE WHEN length(CAST(v.definition AS BLOB))<=24576 THEN v.definition END AS definition
        FROM pips p JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version WHERE p.id=?""",
        (pip_id,)).fetchone()
    if row is None:
        raise RegistryError("not_found", "Pip not found on this runner.")
    try:
        if row["definition"] is None:
            raise ValueError("budget")
        definition = json.loads(row["definition"])
        spec = validate_event_trigger(definition.get("event_trigger"))
        if spec is not None and (definition.get("pip_type", "rook") not in ("scout", "lens", "rook", "lock", "quill")
                                 or definition.get("policy") != "read_only" or definition.get("schedule") is not None):
            raise ValueError("authority")
        if spec is not None and (definition.get('pip_type') == 'quill' or 'committed_paths_changed' in spec['events']):
            from .pip_sources import validate_policy
            if validate_policy(definition.get('source_policy', 'committed_only'))['mode'] != 'committed_only':
                raise ValueError('source')
    except (ValueError, TypeError, AttributeError) as exc:
        raise RegistryError("invalid_event_trigger", "The stored event trigger is not a supported read-only definition.") from exc
    return row, spec


def reset_trigger(registry, pip_id, job_version, spec, approved_at):
    """Called inside approval/version transaction; unchanged policy keeps its cursor."""
    if not registry.db.in_transaction:
        raise RegistryError("event_transaction", "Event triggers must change with the reviewed job version.")
    spec = validate_event_trigger(spec)
    row, stored = _definition(registry, pip_id)
    if type(job_version) is not int or row["current_version"] != job_version or stored != spec:
        raise RegistryError("conflict", "Event trigger does not match the approved job version.")
    now = timestamp(approved_at)
    from .pip_commit_detector import reset_observation
    reset_observation(registry, pip_id, job_version, spec, now)
    previous = registry.db.execute("""SELECT s.*,
        CASE WHEN length(CAST(v.definition AS BLOB))<=24576 THEN v.definition END AS definition
        FROM pip_event_trigger_state s JOIN pip_versions v
        ON v.pip_id=s.pip_id AND v.version=s.job_version WHERE s.pip_id=?""", (pip_id,)).fetchone()
    if spec is None:
        if previous:
            registry.db.execute("DELETE FROM pip_event_trigger_state WHERE pip_id=?", (pip_id,))
            registry.event(row["workspace_id"], "pip_event_trigger_disabled", pip_id=pip_id,
                           payload={"job_version": job_version})
        return
    if previous and previous["definition"] is None:
        raise RegistryError("stored_data_limit", "Previous trigger definition exceeds its review budget.")
    if previous and previous['job_version'] != job_version and 'committed_paths_changed' in spec['events']:
        # A new approved version cannot consume an old-version match. Keep the
        # existing cooldown even when the human changes the filter/ref.
        latest = registry.db.execute("SELECT coalesce(max(seq),0) FROM workspace_events WHERE workspace_id=?",
                                     (row['workspace_id'],)).fetchone()[0]
        registry.db.execute("UPDATE pip_event_trigger_state SET job_version=?,after_seq=max(after_seq,?),last_checked_at=NULL WHERE pip_id=?",
                            (job_version, latest, pip_id))
        return
    if previous and validate_event_trigger(json.loads(previous["definition"]).get("event_trigger")) == spec:
        registry.db.execute("UPDATE pip_event_trigger_state SET job_version=? WHERE pip_id=?", (job_version, pip_id))
        return
    latest = registry.db.execute("SELECT coalesce(max(seq),0) FROM workspace_events WHERE workspace_id=?",
                                 (row["workspace_id"],)).fetchone()[0]
    registry.db.execute("""INSERT INTO pip_event_trigger_state VALUES(?,?,?,?,NULL)
        ON CONFLICT(pip_id) DO UPDATE SET job_version=excluded.job_version,after_seq=excluded.after_seq,
        next_allowed_at=excluded.next_allowed_at,last_checked_at=NULL""", (pip_id, job_version, latest, now))
    registry.event(row["workspace_id"], "pip_event_trigger_armed", pip_id=pip_id,
                   payload={"job_version": job_version, "after_seq": latest, "events": spec["events"]})


def _types(spec):
    return tuple(kind for item in spec["events"] for kind in EVENTS[item])


def _latest(registry, workspace_id, pip_id, spec, after, *, through=9007199254740991):
    kinds = _types(spec)
    placeholders = ",".join("?" for _ in kinds)
    # Do not select payload: an event is a notification, not a forwarded prompt.
    row = registry.db.execute("""SELECT seq,
        CASE WHEN length(CAST(event_id AS BLOB))<=36 THEN event_id END AS event_id,
        CASE WHEN length(CAST(event_type AS BLOB))<=64 THEN event_type END AS event_type,
        CASE WHEN length(CAST(created_at AS BLOB))<=32 THEN created_at END AS created_at
        FROM workspace_events WHERE workspace_id=? AND seq>? AND seq<=?
        AND (event_type NOT IN ('workspace_commit_changed','workspace_committed_paths_changed') OR pip_id=?) AND event_type IN ("""
        + placeholders + ") ORDER BY seq DESC LIMIT 1", (workspace_id, after, through, pip_id, *kinds)).fetchone()
    if row is None:
        return None
    event = dict(row)
    _validate_event(event)
    return event


def _validate_event(event):
    if (not isinstance(event, dict) or set(event) != _EVENT
            or type(event.get("seq")) is not int or not 1 <= event["seq"] <= 9007199254740991
            or not isinstance(event.get("event_id"), str) or not re.fullmatch(r"evt_[0-9a-f]{32}", event["event_id"])
            or event.get("event_type") not in {kind for kinds in EVENTS.values() for kind in kinds}
            or not isinstance(event.get("created_at"), str) or len(event["created_at"]) > 32):
        raise RegistryError("invalid_event_trigger", "Event identity is malformed or outside its metadata budget.")
    timestamp(event["created_at"])


def occurrence_key(version, seq):
    if (type(version) is not int or not 1 <= version < 1000000
            or type(seq) is not int or not 1 <= seq <= 9007199254740991):
        raise RegistryError("invalid_event_trigger", "An event occurrence needs a valid job version and event sequence.")
    return f"event:{version}:{seq}"


def validate_retry(prior, occurrence):
    """Exact retries cannot alias a manual run or another occurrence envelope."""
    raw = prior["manifest"]
    if not isinstance(raw, str) or len(raw) > 131072:
        raise RegistryError("stored_data_limit", "The saved retry manifest exceeds its budget.")
    pin = json.loads(raw).get("event_trigger")
    if occurrence is None:
        if pin is not None:
            raise RegistryError("conflict", "This retry key belongs to an event-triggered run.")
    elif not isinstance(pin, dict) or {key: pin.get(key) for key in _OCCURRENCE} != occurrence:
        raise RegistryError("conflict", "This retry key belongs to a different event occurrence.")


def _state(registry, pip_id):
    row = registry.db.execute("""SELECT
        CASE WHEN length(CAST(pip_id AS BLOB))<=36 THEN pip_id END AS pip_id,job_version,after_seq,
        CASE WHEN length(CAST(next_allowed_at AS BLOB))<=32 THEN next_allowed_at END AS next_allowed_at,
        CASE WHEN last_checked_at IS NULL OR length(CAST(last_checked_at AS BLOB))<=32
            THEN last_checked_at ELSE 'invalid' END AS last_checked_at
        FROM pip_event_trigger_state WHERE pip_id=?""", (pip_id,)).fetchone()
    if row is None:
        raise RegistryError("conflict", "The event trigger is no longer armed.")
    state = dict(row)
    if (not isinstance(state["pip_id"], str) or not re.fullmatch(r"pip_[0-9a-f]{32}", state["pip_id"])
            or type(state["job_version"]) is not int or not 1 <= state["job_version"] < 1000000
            or type(state["after_seq"]) is not int or not 0 <= state["after_seq"] <= 9007199254740991
            or not isinstance(state["next_allowed_at"], str)):
        raise RegistryError("invalid_event_trigger", "Stored event cursor is invalid or exceeds its metadata budget.")
    timestamp(state["next_allowed_at"])
    if state["last_checked_at"] is not None:
        timestamp(state["last_checked_at"])
    return state


def plan(registry, pip_id, *, now):
    row, spec = _definition(registry, pip_id)
    state = _state(registry, pip_id)
    checked = timestamp(now)
    if spec is None or state["job_version"] != row["current_version"]:
        raise RegistryError("conflict", "The event trigger needs its current approved version.")
    if checked < state["next_allowed_at"]:
        return None
    event = _latest(registry, row["workspace_id"], pip_id, spec, state["after_seq"])
    if event is None:
        return None
    if timestamp(event["created_at"]) > checked:
        return None  # Clock rollback never consumes a future event.
    _path_match(registry, pip_id, spec, event)
    oldest = registry.db.execute("SELECT min(seq) FROM workspace_events WHERE workspace_id=?",
                                 (row["workspace_id"],)).fetchone()[0]
    return {"job_version": row["current_version"], "expected_after_seq": state["after_seq"],
            "checked_at": checked, "event": event,
            # Global sequence gaps can also come from other workspaces. This is
            # deliberately a conservative possibility, never an exact loss count.
            "history_may_be_incomplete": bool(state["after_seq"] and oldest and oldest > state["after_seq"] + 1)}


def _path_match(registry, pip_id, spec, event):
    """Read only the scoped retained match; caller payloads are never authority."""
    if event['event_type'] != 'workspace_committed_paths_changed':
        return None
    from .pip_commit_detector import _path_current
    from .pip_commit_paths import validate_match, _load
    current = _path_current(registry, pip_id)
    if current['policy'] != spec:
        raise RegistryError('conflict', 'The reviewed path policy changed before event admission.')
    row = registry.db.execute("""SELECT CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB))<=4096 THEN payload END
        FROM workspace_events WHERE workspace_id=? AND pip_id=? AND seq=? AND event_id=? AND event_type=? AND created_at=?""",
        (current['workspace_id'], pip_id, event['seq'], event['event_id'], event['event_type'], event['created_at'])).fetchone()
    if row is None:
        raise RegistryError('conflict', 'The selected path event is no longer retained in this workspace.')
    if row[0] is None:
        raise RegistryError('stored_data_limit', 'The selected path event exceeds its bounded contract.')
    value = _load(row[0],4096)
    return validate_match(value, **{key:current[key] for key in ('pip_id','workspace_id','job_version','binding_id','binding_digest','source_ref')},
                          rules=spec['commit_paths'], event=event)


def validate_enqueue(registry, pip_id, occurrence, actor, key):
    """Revalidate under the same write lock as manifest insertion and cursor advance."""
    if not registry.db.in_transaction:
        raise RegistryError("event_transaction", "Event enqueue requires the job write transaction.")
    if not isinstance(occurrence, dict) or set(occurrence) != _OCCURRENCE or actor != "local-event-trigger":
        raise RegistryError("invalid_event_trigger", "Event occurrences come only from the local supervisor.")
    _validate_event(occurrence["event"])
    if (type(occurrence["expected_after_seq"]) is not int or not 0 <= occurrence["expected_after_seq"] <= 9007199254740991
            or type(occurrence["history_may_be_incomplete"]) is not bool
            or not isinstance(occurrence["checked_at"], str) or len(occurrence["checked_at"]) > 32):
        raise RegistryError("invalid_event_trigger", "Malformed event occurrence cursor.")
    if key != occurrence_key(occurrence["job_version"], occurrence["event"]["seq"]):
        raise RegistryError("invalid_event_trigger", "Event request key does not identify this occurrence.")
    row, spec = _definition(registry, pip_id)
    state = _state(registry, pip_id)
    if (not spec or row["current_version"] != occurrence["job_version"]
            or state["job_version"] != occurrence["job_version"] or state["after_seq"] != occurrence["expected_after_seq"]):
        raise RegistryError("conflict", "The job version or event cursor changed before enqueue.")
    checked = timestamp(occurrence["checked_at"])
    if checked < state["next_allowed_at"] or checked > timestamp(registry.clock()):
        raise RegistryError("invalid_event_trigger", "The event is outside its approved execution window.")
    event = occurrence["event"]
    if event != _latest(registry, row["workspace_id"], pip_id, spec, state["after_seq"], through=event["seq"]):
        raise RegistryError("conflict", "The retained event no longer matches the queued occurrence.")
    if timestamp(event["created_at"]) > checked:
        raise RegistryError("invalid_event_trigger", "A future event cannot start an audit.")
    oldest = registry.db.execute("SELECT min(seq) FROM workspace_events WHERE workspace_id=?", (row["workspace_id"],)).fetchone()[0]
    incomplete = bool(state["after_seq"] and oldest and oldest > state["after_seq"] + 1)
    if incomplete != occurrence["history_may_be_incomplete"]:
        raise RegistryError("conflict", "Event retention changed; plan a new occurrence with the current history boundary.")
    if registry.db.execute("SELECT 1 FROM pip_runs WHERE pip_id=? AND status IN ('queued','running','cancelling') LIMIT 1", (pip_id,)).fetchone():
        raise RegistryError("event_busy", "This Pip already has queued or active work; this event is skipped.")
    result = {"policy": spec, **occurrence, "source_semantics": _SOURCE_SEMANTICS}
    match = _path_match(registry, pip_id, spec, event)
    if match is not None:
        result['commit_path_match'] = match
    return result


def validate_manifest(manifest):
    """Validate the saved worker pin without loading live mutable event history."""
    pin = manifest.get("event_trigger")
    if pin is None:
        if manifest.get("trigger") == "event":
            raise RegistryError("invalid_event_trigger", "An event-triggered run requires its immutable event pin.")
        return
    match_fields = {'commit_path_match'} if isinstance(pin, dict) and isinstance(pin.get('event'), dict) and pin['event'].get('event_type') == 'workspace_committed_paths_changed' else set()
    if (not isinstance(pin, dict) or set(pin) != _OCCURRENCE | {"policy", "source_semantics"} | match_fields
            or manifest.get("trigger") != "event"
            or manifest.get("run_kind", "audit") != ('draft' if manifest.get('pip_type') == 'quill' else 'audit')
            or pin.get("job_version") != manifest.get("job_version")
            or manifest.get("pip_type", "rook") not in ("rook", "scout", "lens", "lock", "quill")
            or manifest.get("policy") != "read_only" or pin.get("source_semantics") != _SOURCE_SEMANTICS):
        raise RegistryError("invalid_event_trigger", "The saved event pin does not match this read-only run.")
    _validate_event(pin["event"])
    occurrence_key(pin["job_version"], pin["event"]["seq"])
    spec = validate_event_trigger(pin["policy"])
    if (spec is None or spec != pin["policy"] or pin["event"]["event_type"] not in _types(spec)
            or type(pin["expected_after_seq"]) is not int or not 0 <= pin["expected_after_seq"] < pin["event"]["seq"]
            or type(pin["history_may_be_incomplete"]) is not bool
            or not isinstance(pin["checked_at"], str) or len(pin["checked_at"]) > 32
            or timestamp(pin["checked_at"]) < timestamp(pin["event"]["created_at"])):
        raise RegistryError("invalid_event_trigger", "The saved event metadata or policy is invalid.")
    from .pip_commit_paths import validate_manifest as validate_paths
    validate_paths(manifest)


def commit_occurrence(registry, pip_id, occurrence):
    if not registry.db.in_transaction:
        raise RegistryError("event_transaction", "Event cursor advance requires its queue transaction.")
    row, spec = _definition(registry, pip_id)
    if spec is None:
        raise RegistryError("conflict", "The event trigger was removed.")
    next_allowed = timestamp(_instant(occurrence["checked_at"]) + timedelta(minutes=spec["minimum_minutes"]))
    changed = registry.db.execute("""UPDATE pip_event_trigger_state
        SET after_seq=?,next_allowed_at=?,last_checked_at=?
        WHERE pip_id=? AND job_version=? AND after_seq=?""",
        (occurrence["event"]["seq"], next_allowed, occurrence["checked_at"], pip_id,
         occurrence["job_version"], occurrence["expected_after_seq"])).rowcount
    if changed != 1:
        raise RegistryError("conflict", "The event cursor changed while saving the run.")


def discard_status_backlog(registry, pip_id, workspace_id):
    """Pausing/resuming consumes old events, including while the daemon was offline."""
    if not registry.db.in_transaction:
        raise RegistryError("event_transaction", "Status changes must consume trigger backlog atomically.")
    latest = registry.db.execute("SELECT coalesce(max(seq),0) FROM workspace_events WHERE workspace_id=?",
                                 (workspace_id,)).fetchone()[0]
    registry.db.execute("UPDATE pip_event_trigger_state SET after_seq=max(after_seq,?),last_checked_at=NULL WHERE pip_id=?",
                        (latest, pip_id))
    # No detector observations run while paused. Rebaseline on resume so a
    # commit made during that interval is not retrospectively treated as new.
    registry.db.execute("UPDATE pip_commit_observations SET revision=NULL,last_checked_at=NULL WHERE pip_id=?", (pip_id,))
    registry.db.execute("UPDATE pip_commit_path_observations SET revision=NULL,last_checked_at=NULL,last_probe=NULL,last_comparison_at=NULL,last_comparison=NULL WHERE pip_id=?", (pip_id,))


def discard_runtime_backlog(registry):
    """Global stop/resume is atomic even if per-job pausing is interrupted later."""
    if not registry.db.in_transaction:
        raise RegistryError("event_transaction", "Runtime stop must discard trigger backlog in its write transaction.")
    registry.db.execute("""UPDATE pip_event_trigger_state SET
        after_seq=max(after_seq,coalesce((SELECT max(e.seq) FROM workspace_events e JOIN pips p
            ON e.workspace_id=p.workspace_id WHERE p.id=pip_event_trigger_state.pip_id),0)),
        last_checked_at=NULL""")
    registry.db.execute("UPDATE pip_commit_observations SET revision=NULL,last_checked_at=NULL")
    registry.db.execute("UPDATE pip_commit_path_observations SET revision=NULL,last_checked_at=NULL,last_probe=NULL,last_comparison_at=NULL,last_comparison=NULL")


def _touch(registry, pip_id, version, checked, *, occurrence=None, reason=None):
    from .pip_daemon import is_runtime_paused
    with registry.transaction():
        if is_runtime_paused(registry):
            return False
        row, spec = _definition(registry, pip_id)
        state = _state(registry, pip_id)
        if row["current_version"] != version or state["job_version"] != version:
            return False
        if occurrence is not None:
            if reason == "job_paused" and row["status"] == "active":
                return False
            if reason == "job_busy" and not registry.db.execute(
                    "SELECT 1 FROM pip_runs WHERE pip_id=? AND status IN ('queued','running','cancelling') LIMIT 1", (pip_id,)).fetchone():
                return False
            if state["after_seq"] != occurrence["expected_after_seq"]:
                return False
            commit_occurrence(registry, pip_id, occurrence)
            registry.event(row["workspace_id"], "pip_event_trigger_skipped", pip_id=pip_id,
                           payload={"job_version": version, "event_seq": occurrence["event"]["seq"], "reason": reason})
        else:
            registry.db.execute("UPDATE pip_event_trigger_state SET last_checked_at=? WHERE pip_id=? AND job_version=?",
                                (checked, pip_id, version))
            if reason:
                safe = reason if isinstance(reason, str) and re.fullmatch(r"[a-z_]{1,64}", reason) else "event_failed"
                registry.event(row["workspace_id"], "pip_event_trigger_deferred", pip_id=pip_id,
                               payload={"job_version": version, "code": safe, "retry_after_seconds": CHECK_SECONDS})
        return True


def tick(registry, config, *, now=None, limit=MAX_TICK_ITEMS, stop_event=None):
    from .pips import PipStore
    from .pip_daemon import is_runtime_paused
    if type(limit) is not int or not 1 <= limit <= MAX_TICK_ITEMS:
        raise RegistryError("invalid_event_trigger", "An event tick may examine one to eight jobs.")
    result = {"examined": 0, "enqueued": 0, "skipped": 0, "deferred": 0, "stale": 0, "stopped": False}
    if config.get("pips_enabled", False) is not True or is_runtime_paused(registry):
        result["stopped"] = True
        return result
    checked = timestamp(registry.clock() if now is None else now)
    retry_before = timestamp(_instant(checked) - timedelta(seconds=CHECK_SECONDS))
    states = registry.db.execute("""SELECT s.pip_id,s.job_version FROM pip_event_trigger_state s
        JOIN pips p ON p.id=s.pip_id
        WHERE p.status!='archived' AND (s.last_checked_at IS NULL OR s.last_checked_at<=?) AND s.next_allowed_at<=?
        ORDER BY s.last_checked_at,s.pip_id LIMIT ?""", (retry_before, checked, limit)).fetchall()
    store = PipStore(registry)
    for state in states:
        if (stop_event is not None and stop_event.is_set()) or is_runtime_paused(registry):
            result["stopped"] = True
            break
        pip_id, version = state
        result["examined"] += 1
        try:
            occurrence = plan(registry, pip_id, now=checked)
            if occurrence is None:
                _touch(registry, pip_id, version, checked)
                continue
            row, spec = _definition(registry, pip_id)
            busy = registry.db.execute("SELECT 1 FROM pip_runs WHERE pip_id=? AND status IN ('queued','running','cancelling') LIMIT 1", (pip_id,)).fetchone()
            if row["status"] != "active" or busy:
                reason = "job_paused" if row["status"] != "active" else "job_busy"
                result["skipped"] += int(_touch(registry, pip_id, version, checked, occurrence=occurrence, reason=reason))
                continue
            try:
                store.enqueue(pip_id, occurrence_key(version, occurrence["event"]["seq"]),
                              "local-event-trigger", config, event_occurrence=occurrence)
            except RegistryError as exc:
                if exc.code in ("paused", "event_busy", "source_unchanged"):
                    reason = {"paused": "job_paused", "event_busy": "job_busy"}.get(exc.code, exc.code)
                    result["skipped"] += int(_touch(registry, pip_id, version, checked, occurrence=occurrence, reason=reason))
                    continue
                raise
            result["enqueued"] += 1
        except RegistryError as exc:
            if exc.code == "runner_stopped":
                result["stopped"] = True
                break
            if exc.code == "conflict":
                result["stale"] += 1
                continue
            try:
                _touch(registry, pip_id, version, checked, reason=exc.code)
            except RegistryError:
                pass  # A corrupt definition is refused; do not overwrite it.
            result["deferred"] += 1
    return result


class EventTick:
    """One owned tick keeps source-resolution work off the heartbeat thread."""
    def __init__(self, config, directory, clock):
        self.config, self.directory, self.clock = config, directory, clock
        self.stop_event = threading.Event()
        self.error = None
        self.started = False
        self.thread = threading.Thread(target=self._run, name="dgc-pips-events", daemon=True)

    def _run(self):
        try:
            with WorkspaceRegistry(self.directory, clock=self.clock) as registry:
                from .pip_commit_detector import tick as detect_commits
                self.observations = detect_commits(registry, self.config, stop_event=self.stop_event)
                self.result = tick(registry, self.config, stop_event=self.stop_event)
        except BaseException:
            self.error = RegistryError("runner_failed", "The event controller failed; review local state before restarting.")

    def start(self):
        try:
            self.thread.start()
            self.started = True
        except Exception as exc:
            self.error = RegistryError("runner_failed", "The event controller could not start.")
            raise self.error from exc
        return self

    def check(self):
        if self.error:
            raise self.error

    def is_alive(self):
        return self.thread.is_alive()

    def stop(self):
        self.stop_event.set()

    def join(self):
        if self.started:
            self.thread.join()
        self.check()


def has_due_trigger(registry):
    checked = timestamp(registry.clock())
    retry_before = timestamp(_instant(checked) - timedelta(seconds=CHECK_SECONDS))
    due = registry.db.execute("""SELECT 1 FROM pip_event_trigger_state s
        JOIN pips p ON p.id=s.pip_id
        WHERE p.status!='archived' AND s.next_allowed_at<=?
        AND (s.last_checked_at IS NULL OR s.last_checked_at<=?) LIMIT 1""", (checked, retry_before)).fetchone() is not None
    return (due or registry.db.execute("""SELECT 1 FROM pip_commit_observations s JOIN pips p ON p.id=s.pip_id
        WHERE p.status='active' AND (s.last_checked_at IS NULL OR s.last_checked_at<=?) LIMIT 1""", (retry_before,)).fetchone() is not None
        or registry.db.execute("""SELECT 1 FROM pip_commit_path_observations s JOIN pips p ON p.id=s.pip_id
        WHERE p.status='active' AND (s.last_checked_at IS NULL OR s.last_checked_at<=?) LIMIT 1""", (retry_before,)).fetchone() is not None)
