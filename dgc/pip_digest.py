"""What your Pips found since you last looked: one short digest instead of a message per run.

Three parts, all read from durable records (checkpoints, runs, reviews), never from the bounded
activity log:

- Notification settings, per Pip: the least severe new finding that reaches the digest, and the
  least severe one that brings the digest back before tomorrow (an alert). They are the user's
  display preference, not part of the reviewed job: they grant nothing, so they change without a
  job review, and only the local user (the Pips view or the CLI) can change them, never a model.
- The digest: per Pip, its runs, its new findings at or above its threshold, the runs skipped
  because nothing had changed, and the earlier findings that went away after their file
  changed. It is due once a local day when there is something to say, or straight away when a
  finding reaches a Pip's alert level. Seeing it anywhere (editor, terminal, CLI) marks it seen.
- Finding outcomes, per Pip: of everything it reported, what was accepted or dismissed, what went
  away after its file changed (likely fixed) and what went away without one. "Went away" is never
  called "fixed": a later run simply stopped reporting it.

Finding titles are model text from a source-checked audit. They are shown to the user as text,
never given to a model, and configured secrets are redacted.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from .workspace_registry import RegistryError

SEVERITIES = ("low", "medium", "high", "critical")
DEFAULT_SETTINGS = {"min_severity": "medium", "alert_severity": "high"}
FIRST_WINDOW = timedelta(days=1)       # a profile's first digest looks back one day
MAX_WINDOW = timedelta(days=7)         # and no digest looks back further than a week
MAX_CHECKPOINTS = 400                  # checkpoints read for one digest
MAX_OUTCOME_CHECKPOINTS = 200          # checkpoints walked for one Pip's outcomes
MAX_PIPS = 20                          # Pips listed in one digest, most important first
MAX_FINDINGS = 5                       # findings listed per Pip
MAX_TITLE = 200
MAX_MANIFEST_BYTES = 2 * 1024 * 1024

SCHEMA = """
CREATE TABLE pip_notify_settings (
 pip_id TEXT PRIMARY KEY REFERENCES pips(id),
 min_severity TEXT NOT NULL CHECK(min_severity IN ('low','medium','high','critical')),
 alert_severity TEXT CHECK(alert_severity IS NULL OR alert_severity IN ('low','medium','high','critical')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1),
 updated_by TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE pip_digest_state (
 id INTEGER PRIMARY KEY CHECK(id=1),
 seen_until TEXT NOT NULL,
 seen_day TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
"""
_LOCAL_ACTORS = ("editor-user", "local-console")


def _fail(message, code="invalid_digest"):
    raise RegistryError(code, message)


def _rank(severity):
    return SEVERITIES.index(severity)


def _now(registry):
    from .pip_schedules import _instant
    return _instant(registry.clock())


def _stamp(instant):
    from .pip_schedules import timestamp
    return timestamp(instant)


def local_day(instant) -> str:
    """The calendar day on this computer, which is what "once a day" means to its user."""
    return instant.astimezone().date().isoformat()


# ---------------------------------------------------------------- settings ---
def settings(registry, pip_id) -> dict:
    from .pips import PipStore
    PipStore(registry)._job(pip_id)                   # not_found for an unknown Pip
    row = registry.db.execute("SELECT * FROM pip_notify_settings WHERE pip_id=?", (pip_id,)).fetchone()
    if row is None:
        return {"pip_id": pip_id, **DEFAULT_SETTINGS, "revision": 0, "is_default": True}
    return {"pip_id": pip_id, "min_severity": row["min_severity"], "alert_severity": row["alert_severity"],
            "revision": row["revision"], "is_default": False}


def _all_settings(registry) -> dict:
    return {row["pip_id"]: {"min_severity": row["min_severity"], "alert_severity": row["alert_severity"]}
            for row in registry.db.execute("SELECT pip_id,min_severity,alert_severity FROM pip_notify_settings")}


def set_settings(registry, pip_id, *, min_severity, alert_severity, expected_revision, actor) -> dict:
    """Change one Pip's notification settings. Local user only; the reviewed job is untouched."""
    if actor not in _LOCAL_ACTORS:
        _fail("Change a Pip's notifications in the Pips view or the CLI on this computer.", "local_only")
    if min_severity not in SEVERITIES:
        _fail("Choose low, medium, high or critical as the least severe finding to show.")
    if alert_severity is not None and alert_severity not in SEVERITIES:
        _fail("Choose low, medium, high, critical or no alerts.")
    if alert_severity is not None and _rank(alert_severity) < _rank(min_severity):
        _fail("Alerts must be at least as severe as the findings the digest shows.")
    if type(expected_revision) is not int or expected_revision < 0:
        _fail("Read the current settings before changing them.")
    with registry.transaction():
        current = settings(registry, pip_id)
        if current["revision"] != expected_revision:
            _fail("These notification settings changed. Refresh and try again.", "conflict")
        if (current["min_severity"], current["alert_severity"]) == (min_severity, alert_severity) and not current["is_default"]:
            return current
        now = registry.clock()
        registry.db.execute("""INSERT INTO pip_notify_settings VALUES(?,?,?,?,?,?)
            ON CONFLICT(pip_id) DO UPDATE SET min_severity=excluded.min_severity,
            alert_severity=excluded.alert_severity,revision=excluded.revision,
            updated_by=excluded.updated_by,updated_at=excluded.updated_at""",
                            (pip_id, min_severity, alert_severity, expected_revision + 1, actor, now))
        workspace = registry.db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()[0]
        registry.event(workspace, "pip_notify_settings_changed", pip_id=pip_id,
                       payload={"min_severity": min_severity, "alert_severity": alert_severity,
                                "revision": expected_revision + 1})
        return settings(registry, pip_id)


# ------------------------------------------------------------------ digest ---
def _state(registry):
    return registry.db.execute("SELECT seen_until,seen_day FROM pip_digest_state WHERE id=1").fetchone()


def _title(text, secrets):
    from .redaction import redact_text
    text = " ".join(redact_text(str(text), secrets).split())
    return text if len(text) <= MAX_TITLE else text[:MAX_TITLE - 1].rstrip() + "…"


def _changed_paths(store, run_id):
    """Paths the run's source changed since its baseline, and whether that list is complete."""
    bound = store.db.execute("SELECT length(CAST(manifest AS BLOB)) FROM pip_runs WHERE id=?", (run_id,)).fetchone()
    if bound is None or bound[0] is None or bound[0] > MAX_MANIFEST_BYTES:
        return set(), False
    manifest = json.loads(store.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run_id,)).fetchone()[0])
    changes = manifest.get("changes_since_checkpoint")
    if not isinstance(changes, dict) or changes.get("status") != "compared":
        return set(), False
    paths = {item.get("path") for item in changes.get("changes") or () if isinstance(item, dict)}
    return paths, changes.get("omitted_changes") == 0


def _gone(store, checkpoint, baseline_cache):
    """Findings of the baseline checkpoint that this one no longer reports, split by whether
    their file changed in between. Uncompared checkpoints say nothing."""
    from .pip_checkpoints import _load
    baseline_id = checkpoint.get("baseline_checkpoint_id")
    if baseline_id is None or checkpoint["counts"].get("not_observed") in (None, 0):
        return [], []
    if baseline_id not in baseline_cache:
        try:
            baseline_cache[baseline_id] = _load(store, baseline_id, reviews=False)["findings"]
        except RegistryError:
            baseline_cache[baseline_id] = []
    current = {item["identity"] for item in checkpoint["findings"]}
    paths, _complete = _changed_paths(store, checkpoint["run_id"])
    after_change, without = [], []
    for item in baseline_cache[baseline_id]:
        if item["identity"] not in current:
            (after_change if item["path"] in paths else without).append(item)
    return after_change, without


def build(registry, config=None) -> dict:
    """The digest since the user last looked (at most a week), and whether it is due now."""
    from .pip_checkpoints import _load
    from .pip_overview import pending_reviews
    from .pips import PipStore
    from .redaction import secret_values
    store = PipStore(registry)
    secrets = secret_values(config) if config is not None else secret_values()
    now = _now(registry)
    state = _state(registry)
    seen_until = None
    if state is not None:
        from .pip_schedules import _instant
        seen_until = _instant(state["seen_until"])
    since = max(seen_until or now - FIRST_WINDOW, now - MAX_WINDOW)
    since_s, until_s = _stamp(since), _stamp(now)
    preferences = _all_settings(registry)
    pips = {}

    def entry(pip_id):
        if pip_id not in pips:
            job = store._job(pip_id)
            chosen = preferences.get(pip_id, DEFAULT_SETTINGS)
            personal = job["source_policy"] == {"mode": "personal"}
            pips[pip_id] = {"pip_id": pip_id, "workspace_id": job["workspace_id"], "name": job["name"],
                            "pip_type": job["pip_type"], "scope": "personal" if personal else "project",
                            "status": job["status"], **chosen,
                            "runs": {"succeeded": 0, "failed": 0, "cancelled": 0}, "skipped_unchanged": 0,
                            "new_total": 0, "below_threshold": 0, "new_findings": [],
                            "gone_after_change": 0, "alert": False, "latest_run_id": None}
        return pips[pip_id]

    for row in registry.db.execute("""SELECT pip_id,status,count(*) AS n FROM pip_runs
            WHERE finished_at>? AND finished_at<=? AND status IN ('succeeded','failed','cancelled')
            GROUP BY pip_id,status""", (since_s, until_s)):
        item = entry(row["pip_id"])
        item["runs"][row["status"]] += row["n"]
    for row in registry.db.execute("""SELECT id,pip_id FROM pip_runs WHERE finished_at>? AND finished_at<=?
            AND status IN ('succeeded','failed','cancelled') ORDER BY finished_at""", (since_s, until_s)):
        entry(row["pip_id"])["latest_run_id"] = row["id"]
    for row in registry.db.execute("""SELECT pip_id,payload FROM workspace_events
            WHERE event_type IN ('pip_schedule_skipped','pip_event_trigger_skipped')
            AND created_at>? AND created_at<=? AND pip_id IS NOT NULL LIMIT 5000""", (since_s, until_s)):
        try:
            reason = json.loads(row["payload"]).get("reason")
        except ValueError:
            continue
        if reason == "source_unchanged":
            entry(row["pip_id"])["skipped_unchanged"] += 1

    checkpoints = registry.db.execute("""SELECT c.id FROM pip_checkpoints c JOIN pip_runs r ON r.id=c.run_id
            WHERE r.finished_at>? AND r.finished_at<=? ORDER BY c.id LIMIT ?""",
                                      (since_s, until_s, MAX_CHECKPOINTS + 1)).fetchall()
    truncated = len(checkpoints) > MAX_CHECKPOINTS
    baselines = {}
    for (checkpoint_id,) in checkpoints[:MAX_CHECKPOINTS]:
        try:
            checkpoint = _load(store, checkpoint_id, reviews=False)
        except RegistryError:
            continue
        item = entry(checkpoint["pip_id"])
        floor, alert = _rank(item["min_severity"]), item["alert_severity"]
        for finding in checkpoint["findings"]:
            if finding["comparison"] != "new":
                continue
            if _rank(finding["severity"]) < floor:
                item["below_threshold"] += 1
                continue
            item["new_total"] += 1
            if alert is not None and _rank(finding["severity"]) >= _rank(alert):
                item["alert"] = True
            item["new_findings"].append({"severity": finding["severity"], "title": _title(finding["title"], secrets),
                                         "path": finding["path"], "line": finding["line"],
                                         "run_id": checkpoint["run_id"], "finding_index": finding["finding_index"]})
        item["gone_after_change"] += len(_gone(store, checkpoint, baselines)[0])
    for item in pips.values():
        item["new_findings"].sort(key=lambda f: -_rank(f["severity"]))
        item["new_findings"] = item["new_findings"][:MAX_FINDINGS]

    reviews = pending_reviews(registry, limit=1)["total_pending"]
    setups = registry.db.execute("SELECT count(*) FROM pip_setup_proposals WHERE status='pending' AND expires_at>?",
                                 (until_s,)).fetchone()[0]
    ordered = sorted(pips.values(), key=lambda p: (not p["alert"], -p["new_total"], -p["runs"]["failed"],
                                                   -sum(p["runs"].values()), p["name"]))
    failed = sum(p["runs"]["failed"] for p in ordered)
    alert = any(p["alert"] for p in ordered)
    anything = bool(ordered) or reviews or setups
    today = local_day(now)
    daily = anything and (state is None or state["seen_day"] != today)
    return {"schema_version": 1, "since": since_s, "until": until_s, "first": state is None,
            "due": bool(alert or daily), "reason": "alert" if alert else "daily" if daily else None,
            "headline": _headline(ordered, failed, reviews + setups),
            "pips": ordered[:MAX_PIPS], "omitted_pips": max(0, len(ordered) - MAX_PIPS),
            "failed_runs": failed, "pending_reviews": reviews, "pending_setups": setups,
            "truncated": truncated}


def _plural(count, word):
    return f"{count} {word}{'' if count == 1 else 's'}"


def _headline(pips, failed, reviews) -> str:
    """One line for a status bar or a terminal tip: what most needs attention first."""
    parts = []
    new = [p for p in pips if p["new_total"]]
    if new:
        total = sum(p["new_total"] for p in new)
        worst = max((f["severity"] for p in new for f in p["new_findings"]), key=_rank)
        where = new[0]["name"] if len(new) == 1 else _plural(len(new), "Pip")
        parts.append(f"{_plural(total, 'new finding')} from {where} (worst: {worst})")
    if failed:
        parts.append(_plural(failed, "failed run"))
    if reviews:
        parts.append(f"{_plural(reviews, 'review')} waiting")
    gone = sum(p["gone_after_change"] for p in pips)
    if gone:
        parts.append(f"{gone} earlier finding{'' if gone == 1 else 's'} gone after a change")
    if not parts:
        ran = sum(sum(p["runs"].values()) for p in pips)
        skipped = sum(p["skipped_unchanged"] for p in pips)
        if ran or skipped:
            parts.append(f"Nothing new from {_plural(len(pips), 'Pip')}"
                         + (f" · {_plural(ran, 'run')}" if ran else "")
                         + (f" · {skipped} skipped, nothing changed" if skipped else ""))
        else:
            parts.append("No Pip work since you last looked")
    return " · ".join(parts)


def mark_seen(registry, until, actor) -> dict:
    """Record that the user saw the digest up to `until`. Never moves backwards."""
    from .pip_schedules import _instant
    if actor not in _LOCAL_ACTORS:
        _fail("Digests are read on this computer.", "local_only")
    now = _now(registry)
    try:
        instant = _instant(until)
    except (RegistryError, ValueError, TypeError):
        _fail("Mark the digest seen with the time it was built.")
    if _stamp(instant) != until or instant > now:
        _fail("Mark the digest seen with the time it was built.")
    with registry.transaction():
        state = _state(registry)
        if state is not None and state["seen_until"] >= until:
            return {"seen_until": state["seen_until"], "seen_day": state["seen_day"]}
        day, stamp = local_day(now), _stamp(now)
        registry.db.execute("""INSERT INTO pip_digest_state VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE
            SET seen_until=excluded.seen_until,seen_day=excluded.seen_day,updated_at=excluded.updated_at""",
                            (until, day, stamp))
        return {"seen_until": until, "seen_day": day}


# ---------------------------------------------------------------- outcomes ---
def outcomes(registry, pip_id) -> dict:
    """What became of one Pip's findings, from its retained checkpoints, oldest first."""
    from .pip_checkpoints import _load
    from .pips import PipStore
    store = PipStore(registry)
    job = store._job(pip_id)
    rows = registry.db.execute("SELECT id FROM pip_checkpoints WHERE pip_id=? ORDER BY id DESC LIMIT ?",
                               (pip_id, MAX_OUTCOME_CHECKPOINTS + 1)).fetchall()
    truncated = len(rows) > MAX_OUTCOME_CHECKPOINTS
    ids = [row[0] for row in rows[:MAX_OUTCOME_CHECKPOINTS]][::-1]
    reported, reviews, state = set(), {}, {}
    examined = 0
    for checkpoint_id in ids:
        try:
            checkpoint = _load(store, checkpoint_id, reviews=True)
        except RegistryError:
            continue
        examined += 1
        current = {item["identity"]: item for item in checkpoint["findings"]}
        compared = checkpoint.get("baseline_checkpoint_id") is not None and checkpoint["counts"].get("not_observed") is not None
        if compared:
            paths, _complete = _changed_paths(store, checkpoint["run_id"])
            for identity, last in list(state.items()):
                if last["state"] == "reported" and identity not in current:
                    last["state"] = "gone_after_change" if last["path"] in paths else "gone"
        for identity, item in current.items():
            reported.add(identity)
            state[identity] = {"state": "reported", "path": item["path"], "severity": item["severity"]}
            status = item["review"]["status"]
            if status != "open" or identity not in reviews:
                reviews[identity] = status
    counts = {"reported": len(reported),
              "accepted": sum(status == "accepted" for status in reviews.values()),
              "dismissed": sum(status == "dismissed" for status in reviews.values()),
              "still_reported": sum(item["state"] == "reported" for item in state.values()),
              "gone_after_change": sum(item["state"] == "gone_after_change" for item in state.values()),
              "gone_without_change": sum(item["state"] == "gone" for item in state.values())}
    return {"pip_id": pip_id, "name": job["name"], "pip_type": job["pip_type"],
            "checkpoints_examined": examined, "history_truncated": truncated, **counts}
