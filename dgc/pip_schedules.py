"""Bounded, timezone-aware occurrence planning for approved read-only Pip jobs.

Schedules are immutable job-version data; the schedule table is only a cursor.
This module does not grant tools, choose model endpoints, or start a worker.
"""
from __future__ import annotations

import json
import re
import threading
from calendar import monthrange
from dataclasses import dataclass
from functools import lru_cache
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .workspace_registry import RegistryError, WorkspaceRegistry

MISSED_POLICY = "coalesce_latest"
DST_POLICY = "skip_gap_first_fold"
MIN_INTERVAL_MINUTES = 5
MAX_INTERVAL_MINUTES = 7 * 24 * 60
MAX_TICK_ITEMS = 8
ERROR_RETRY_SECONDS = 30
# A due occurrence that can't start is tried again after 30 s, then twice as long each time, up to an hour. It was
# put off every 30 seconds forever, silently: 43 times in 21 minutes for a Pulse whose sandbox could never start
# here (ERP session review, 2026-10-18). From the third time, it is an alert the user sees (pip_digest, pip_desktop).
MAX_RETRY_SECONDS = 3600
ALERT_AFTER = 3
DEFERRAL_KEY = "schedule_deferred:"     # metadata, per Pip: the occurrence that keeps failing to start, and since when
UTC = timezone.utc
MAX_CRON_CHARACTERS = 256
MAX_CRON_DATE_GAP = 366
MAX_CRON_SEARCH_DAYS = 370
MAX_CRON_SLOTS = 24 * 60 // MIN_INTERVAL_MINUTES

# Composed with the other schema-5 additions by WorkspaceRegistry. A null next
# cursor records a consumed one-shot; retaining the row prevents text-only job
# revisions from silently arming it again. The enclosing migration is atomic.
SCHEMA_V5 = """
CREATE TABLE pip_schedule_state_v5(
    pip_id TEXT PRIMARY KEY REFERENCES pips(id),job_version INTEGER NOT NULL,
    anchor_at TEXT NOT NULL,next_due_at TEXT,last_due_at TEXT,last_checked_at TEXT,
    FOREIGN KEY(pip_id,job_version) REFERENCES pip_versions(pip_id,version));
INSERT INTO pip_schedule_state_v5
    SELECT pip_id,job_version,anchor_at,next_due_at,last_due_at,last_checked_at
    FROM pip_schedule_state;
DROP TABLE pip_schedule_state;
ALTER TABLE pip_schedule_state_v5 RENAME TO pip_schedule_state;
CREATE INDEX pip_schedule_due ON pip_schedule_state(next_due_at,pip_id);
"""


@dataclass(frozen=True)
class _Cron:
    days: frozenset
    months: frozenset
    weekdays: frozenset
    any_day: bool
    any_weekday: bool
    slots: tuple


def _cron_field(text, lower, upper):
    values = set()
    parts = text.split(",")
    if len(parts) > 32:
        raise RegistryError("invalid_schedule", "A cron field may contain at most 32 list items.")
    for part in parts:
        match = re.fullmatch(r"(\*|[0-9]{1,2}(?:-[0-9]{1,2})?)(?:/([0-9]{1,2}))?", part)
        if not match:
            raise RegistryError("invalid_schedule", "Cron accepts numeric values, lists, ascending ranges, and steps on * or ranges.")
        span, step_text = match.groups()
        step = int(step_text) if step_text is not None else 1
        if not 1 <= step <= upper - lower + 1:
            raise RegistryError("invalid_schedule", "A cron step must be positive and fit its field's range.")
        if span == "*":
            start, end = lower, upper
        elif "-" in span:
            start, end = map(int, span.split("-"))
        else:
            if step_text is not None:
                raise RegistryError("invalid_schedule", "Use */step or start-end/step; a single value cannot have a step.")
            start = end = int(span)
        if not lower <= start <= end <= upper:
            raise RegistryError("invalid_schedule", "Cron field values must be in range and ranges must ascend.")
        # At most the field's natural domain is allocated, never the input value.
        values.update(range(start, end + 1, step))
    return frozenset(values)


def _cron_day_matches(plan, day):
    if day.month not in plan.months:
        return False
    dom = day.day in plan.days
    dow = (day.weekday() + 1) % 7 in plan.weekdays
    if plan.any_day:
        return dow
    if plan.any_weekday:
        return dom
    return dom or dow


@lru_cache(maxsize=64)
def _compile_cron(expression):
    """Bounded numeric grammar and calendar validation, independent of the clock.

    A Gregorian cycle has exactly 146097 dates. Inspecting at most this finite
    cycle once rejects impossible/leap-only calendars before a schedule is saved;
    no unbounded next-match search or user-controlled allocation is involved.
    Only successful immutable results enter the small bounded cache.
    """
    fields = expression.split(" ")
    if len(fields) != 5:
        raise RegistryError("invalid_schedule", "Cron requires five fields: minute hour day-of-month month weekday.")
    minute, hour, day, month, weekday = (
        _cron_field(field, low, high)
        for field, low, high in zip(fields, (0, 0, 1, 1, 0), (59, 23, 31, 12, 7)))
    # Reject rapid minute patterns before allocating even the bounded day grid.
    minutes = sorted(minute)
    if any(b - a < MIN_INTERVAL_MINUTES for a, b in zip(minutes, minutes[1:])):
        raise RegistryError("invalid_schedule", "Cron occurrences must be at least five nominal local minutes apart.")
    if len(minute) * len(hour) > MAX_CRON_SLOTS:
        raise RegistryError("invalid_schedule", "Cron may contain at most 288 times per local date.")
    slots = tuple(sorted(h * 60 + m for h in hour for m in minute))
    if any(b - a < MIN_INTERVAL_MINUTES for a, b in zip(slots, slots[1:] + (slots[0] + 1440,))):
        raise RegistryError("invalid_schedule", "Cron occurrences must be at least five nominal local minutes apart, including midnight.")
    plan = _Cron(day, month, frozenset(w % 7 for w in weekday),
                 fields[2] == "*", fields[4] == "*", slots)
    first = previous = None
    for year in range(2000, 2400):
        for month_number in sorted(month):
            for day_number in range(1, monthrange(year, month_number)[1] + 1):
                candidate = datetime(year, month_number, day_number).date()
                if not _cron_day_matches(plan, candidate):
                    continue
                ordinal = candidate.toordinal()
                if previous is not None and ordinal - previous > MAX_CRON_DATE_GAP:
                    raise RegistryError("invalid_schedule", "Cron must recur within 366 local dates; leap-only or sparser calendars are unsupported.")
                if first is None:
                    first = ordinal
                previous = ordinal
    if first is None:
        raise RegistryError("invalid_schedule", "Cron has no possible calendar date.")
    if first + 146097 - previous > MAX_CRON_DATE_GAP:
        raise RegistryError("invalid_schedule", "Cron must recur within 366 local dates; leap-only or sparser calendars are unsupported.")
    return plan


# Old names for zones, such as Asia/Calcutta for Asia/Kolkata: browsers still report them (VS Code's
# Chromium said Asia/Calcutta on an Indian machine), and Ubuntu 24.04+ installs them only with
# tzdata-legacy, so a routine at 09:00 was refused. An old name is accepted and saved as its current one.
_OLD_ZONES = {"Asia/Calcutta": "Asia/Kolkata", "Asia/Saigon": "Asia/Ho_Chi_Minh", "Asia/Katmandu": "Asia/Kathmandu",
              "Asia/Rangoon": "Asia/Yangon", "Asia/Dacca": "Asia/Dhaka", "Asia/Thimbu": "Asia/Thimphu",
              "Europe/Kiev": "Europe/Kyiv", "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
              "America/Godthab": "America/Nuuk", "Atlantic/Faeroe": "Atlantic/Faroe", "Pacific/Truk": "Pacific/Chuuk",
              "US/Eastern": "America/New_York", "US/Central": "America/Chicago", "US/Mountain": "America/Denver",
              "US/Pacific": "America/Los_Angeles"}


@lru_cache(maxsize=1)
def _zone_links() -> dict:
    """Every old zone name and its current one: the system's tzdata.zi link lines, then the list above."""
    import zoneinfo
    from pathlib import Path
    links = {}
    for base in zoneinfo.TZPATH:
        try:
            text = (Path(base) / "tzdata.zi").read_text(encoding="utf-8")
        except OSError:
            continue
        for line in text.splitlines():
            parts = line.split()
            if len(parts) == 3 and parts[0] == "L":
                links[parts[2]] = parts[1]
        break
    return {**_OLD_ZONES, **links}


def canonical_zone(zone: str) -> str:
    """The name of ``zone`` this runner can load: itself, or the current name of an old one."""
    for _ in range(4):
        try:
            ZoneInfo(zone)
            return zone
        except (ValueError, ZoneInfoNotFoundError, OSError):
            nxt = _zone_links().get(zone)
            if not nxt or nxt == zone:
                return zone
            zone = nxt
    return zone


def _timezone(zone):
    if (not isinstance(zone, str) or not 1 <= len(zone) <= 128
            or not re.fullmatch(r"[A-Za-z0-9_+/-]+", zone) or zone.startswith("/")
            or "//" in zone):
        raise RegistryError("invalid_schedule", "Calendar schedules require an IANA timezone such as Asia/Kolkata.")
    try:
        return ZoneInfo(canonical_zone(zone))
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise RegistryError("invalid_schedule", "Timezone unavailable. Choose an installed IANA timezone; this runner needs system timezone data.") from exc


def _instant(value, name="schedule time"):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
        if not isinstance(result, datetime) or result.tzinfo is None or result.utcoffset() is None:
            raise ValueError("timezone required")
        return result.astimezone(UTC)
    except (TypeError, ValueError, OverflowError) as exc:
        raise RegistryError("invalid_schedule", f"{name} must be a valid timezone-aware timestamp.") from exc


def timestamp(value):
    """Canonical UTC milliseconds, also the ordering format stored in SQLite."""
    return _instant(value).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_schedule(value):
    """Return a detached canonical spec; absent policies receive explicit defaults."""
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("type") not in ("interval", "daily", "cron", "once"):
        raise RegistryError("invalid_schedule", "Choose an interval, daily, cron or once schedule, or null for manual only.")
    if value.get("missed_policy", MISSED_POLICY) != MISSED_POLICY:
        raise RegistryError("invalid_schedule", "Missed occurrences must coalesce to the latest occurrence; backlog replay is unsupported.")
    if value["type"] == "interval":
        if set(value) - {"type", "minutes", "missed_policy"}:
            raise RegistryError("invalid_schedule", "An interval schedule only accepts type, minutes and missed_policy.")
        minutes = value.get("minutes")
        if type(minutes) is not int or not MIN_INTERVAL_MINUTES <= minutes <= MAX_INTERVAL_MINUTES:
            raise RegistryError("invalid_schedule", "Schedule interval must be an integer from 5 to 10080 minutes.")
        return {"type": "interval", "minutes": minutes, "missed_policy": MISSED_POLICY}
    if value["type"] == "once":
        if set(value) - {"type", "at", "missed_policy"}:
            raise RegistryError("invalid_schedule", "A once schedule only accepts type, at and missed_policy.")
        at = value.get("at")
        # Explicit offset avoids choosing a DST fold implicitly. Limit before
        # datetime parsing and reject fractional precision that would be lost.
        if (not isinstance(at, str) or not 20 <= len(at) <= 29 or not re.fullmatch(
                r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})", at)):
            raise RegistryError("invalid_schedule", "One-time schedules require an ISO timestamp with seconds and explicit Z or UTC offset, with at most millisecond precision.")
        # datetime accepts normalized offsets such as +05:99; this API does not.
        if at[-1] != "Z" and (int(at[-5:-3]) > 23 or int(at[-2:]) > 59):
            raise RegistryError("invalid_schedule", "One-time schedule UTC offsets must contain valid hours and minutes.")
        return {"type": "once", "at": timestamp(at), "missed_policy": MISSED_POLICY}
    field = "time" if value["type"] == "daily" else "cron"
    if set(value) - {"type", field, "timezone", "missed_policy", "dst_policy"}:
        raise RegistryError("invalid_schedule", f"A {value['type']} schedule only accepts {field}, timezone and the supported policies.")
    zone = value.get("timezone")
    _timezone(zone)
    zone = canonical_zone(zone)
    if value.get("dst_policy", DST_POLICY) != DST_POLICY:
        raise RegistryError("invalid_schedule", "Calendar schedules skip nonexistent local times and use the first occurrence of repeated local times.")
    if field == "time":
        content = value.get(field)
        if not isinstance(content, str) or not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", content):
            raise RegistryError("invalid_schedule", "Daily time must use 24-hour HH:MM notation.")
    else:
        content = value.get(field)
        if (not isinstance(content, str) or not 9 <= len(content) <= MAX_CRON_CHARACTERS
                or not re.fullmatch(r"[0-9*,/ -]+", content)):
            raise RegistryError("invalid_schedule", "Cron must be at most 256 ASCII characters using five numeric fields; names, macros and commands are unsupported.")
        content = " ".join(content.split())
        _compile_cron(content)
    return {"type": value["type"], field: content, "timezone": zone,
            "missed_policy": MISSED_POLICY, "dst_policy": DST_POLICY}


def _daily_occurrence(spec, day):
    hour, minute = map(int, spec["time"].split(":"))
    return _local_occurrence(day, hour * 60 + minute, ZoneInfo(spec["timezone"]))


def _local_occurrence(day, minute_of_day, zone):
    hour, minute = divmod(minute_of_day, 60)
    local = datetime(day.year, day.month, day.day, hour, minute)
    candidates = set()
    for fold in (0, 1):
        candidate = local.replace(tzinfo=zone, fold=fold).astimezone(UTC)
        if candidate.astimezone(zone).replace(tzinfo=None) == local:
            candidates.add(candidate)
    # Empty means the wall-clock minute did not occur (DST gap/date-line move).
    # Repeated minutes resolve to the first actual instant, never two runs.
    return min(candidates) if candidates else None


def _cron_find(spec, instant, *, forward):
    plan = _compile_cron(spec["cron"])
    zone = ZoneInfo(spec["timezone"])
    local_date = instant.astimezone(zone).date()
    slots = plan.slots if forward else reversed(plan.slots)
    # Materialize at most 288 integers; never a missed-occurrence backlog.
    slots = tuple(slots)
    for delta in range(MAX_CRON_SEARCH_DAYS):
        day = local_date + timedelta(days=delta if forward else -delta)
        if not _cron_day_matches(plan, day):
            continue
        for minute in slots:
            occurrence = _local_occurrence(day, minute, zone)
            if occurrence is not None and (occurrence > instant if forward else occurrence <= instant):
                return occurrence
    raise RegistryError("invalid_schedule", "No cron occurrence exists within 370 local dates; this timezone gap or calendar is unsupported.")


def _cron_cursor_valid(spec, instant):
    plan = _compile_cron(spec["cron"])
    zone = ZoneInfo(spec["timezone"])
    local = instant.astimezone(zone)
    return (not local.second and not local.microsecond and _cron_day_matches(plan, local.date())
            and local.hour * 60 + local.minute in plan.slots
            and _local_occurrence(local.date(), local.hour * 60 + local.minute, zone) == instant)


def next_due(spec, after, anchor):
    """First occurrence strictly after `after`, never before schedule approval.

    Interval and one-shot arithmetic is constant-time. Daily planning inspects
    eight dates; cron inspects 370 dates and at most 288 times per matching date.
    An exhausted one-shot returns null; only reset_schedule may arm it.
    """
    spec = validate_schedule(spec)
    if spec is None:
        return None
    after, anchor = _instant(after), _instant(anchor)
    after = max(after, anchor)
    try:
        if spec["type"] == "interval":
            interval = timedelta(minutes=spec["minutes"])
            return timestamp(anchor + interval * max(1, (after - anchor) // interval + 1))
        if spec["type"] == "once":
            at = _instant(spec["at"])
            return timestamp(at) if at > after else None
        if spec["type"] == "cron":
            return timestamp(_cron_find(spec, after, forward=True))
        local_date = after.astimezone(ZoneInfo(spec["timezone"])).date()
        for days in range(8):
            occurrence = _daily_occurrence(spec, local_date + timedelta(days=days))
            if occurrence is not None and occurrence > after:
                return timestamp(occurrence)
    except RegistryError:
        raise
    except (OverflowError, ValueError) as exc:
        raise RegistryError("invalid_schedule", "The next scheduled occurrence is outside the supported date range.") from exc
    raise RegistryError("invalid_schedule", "No valid daily occurrence was found in the next eight local dates.")


def plan_due(spec, expected_next_due, now, anchor):
    """One latest due occurrence and its next cursor; never enumerate an outage backlog."""
    spec = validate_schedule(spec)
    if spec is None or (spec["type"] == "once" and expected_next_due is None):
        return None
    first, now, anchor = _instant(expected_next_due), _instant(now), _instant(anchor)
    if first > now:
        return None
    if first <= anchor:
        raise RegistryError("invalid_schedule", "Stored schedule cursor precedes its approval anchor.")
    if spec["type"] == "interval":
        interval = timedelta(minutes=spec["minutes"])
        latest = anchor + interval * ((now - anchor) // interval)
    elif spec["type"] == "once":
        latest = _instant(spec["at"])
        if first != latest:
            raise RegistryError("invalid_schedule", "Stored one-time cursor differs from its approved instant.")
    elif spec["type"] == "cron":
        try:
            if not _cron_cursor_valid(spec, first):
                raise RegistryError("invalid_schedule", "Stored cron cursor does not match an approved first-fold occurrence.")
            latest = _cron_find(spec, now, forward=False)
        except RegistryError:
            raise
        except (OverflowError, ValueError) as exc:
            raise RegistryError("invalid_schedule", "The scheduled occurrence is outside the supported date range.") from exc
    else:
        latest = None
        local_date = now.astimezone(ZoneInfo(spec["timezone"])).date()
        try:
            for days in range(8):
                candidate = _daily_occurrence(spec, local_date - timedelta(days=days))
                if candidate is not None and candidate <= now:
                    latest = candidate
                    break
        except (OverflowError, ValueError) as exc:
            raise RegistryError("invalid_schedule", "The scheduled occurrence is outside the supported date range.") from exc
    if latest is None or latest < first:
        raise RegistryError("invalid_schedule", "Stored schedule cursor does not match an approved occurrence.")
    return {"expected_next_due": timestamp(first), "scheduled_at": timestamp(latest),
            "next_due_at": next_due(spec, now, anchor), "checked_at": timestamp(now),
            "coalesced": latest != first}


def occurrence_key(job_version, scheduled_at):
    if type(job_version) is not int or not 1 <= job_version < 1000000:
        raise RegistryError("invalid_schedule", "A scheduled occurrence needs its approved job version.")
    return f"schedule:{job_version}:{timestamp(scheduled_at)}"


def reset_schedule(registry, pip_id, job_version, spec, approved_at):
    """Reset the projection in the same transaction that approves a job version.

    A changed schedule rearms from approval time. An unchanged schedule preserves
    its cadence while future occurrences pin the newly approved job version.
    """
    if not registry.db.in_transaction:
        raise RegistryError("schedule_transaction", "Schedule changes must commit with the approved job version.")
    occurrence_key(job_version, approved_at)  # Exact version and timestamp validation.
    spec = validate_schedule(spec)
    row = registry.db.execute("""SELECT p.workspace_id,p.current_version,v.definition
        FROM pips p JOIN pip_versions v ON p.id=v.pip_id AND v.version=p.current_version
        WHERE p.id=?""", (pip_id,)).fetchone()
    if row is None or row["current_version"] != job_version:
        raise RegistryError("conflict", "The approved job version changed before its schedule was armed.")
    stored_spec = validate_schedule(json.loads(row["definition"]).get("schedule"))
    if stored_spec != spec:
        raise RegistryError("conflict", "The schedule does not match the approved job definition.")
    if spec is None:
        removed = registry.db.execute("DELETE FROM pip_schedule_state WHERE pip_id=?", (pip_id,)).rowcount
        if removed:
            registry.event(row["workspace_id"], "pip_schedule_disabled", pip_id=pip_id,
                           payload={"job_version": job_version})
        return None
    previous = registry.db.execute("""SELECT s.*,v.definition FROM pip_schedule_state s
        JOIN pip_versions v ON v.pip_id=s.pip_id AND v.version=s.job_version WHERE s.pip_id=?""",
        (pip_id,)).fetchone()
    if previous is not None and validate_schedule(json.loads(previous["definition"]).get("schedule")) == spec:
        registry.db.execute("UPDATE pip_schedule_state SET job_version=? WHERE pip_id=?", (job_version, pip_id))
        if previous["job_version"] != job_version:
            registry.event(row["workspace_id"], "pip_schedule_versioned", pip_id=pip_id,
                           payload={"job_version": job_version, "next_due_at": previous["next_due_at"]})
        return {key: job_version if key == "job_version" else previous[key] for key in
                ("pip_id", "job_version", "anchor_at", "next_due_at", "last_due_at", "last_checked_at")}
    anchor = timestamp(approved_at)
    due = next_due(spec, anchor, anchor)
    if due is None:
        raise RegistryError("invalid_schedule", "A new one-time schedule must be in the future when approved. Choose a later instant and review it again.")
    registry.db.execute("""INSERT INTO pip_schedule_state
        (pip_id,job_version,anchor_at,next_due_at,last_due_at,last_checked_at)
        VALUES(?,?,?,?,NULL,NULL) ON CONFLICT(pip_id) DO UPDATE SET
        job_version=excluded.job_version,anchor_at=excluded.anchor_at,
        next_due_at=excluded.next_due_at,last_due_at=NULL,last_checked_at=NULL""",
        (pip_id, job_version, anchor, due))
    registry.event(row["workspace_id"], "pip_schedule_armed", pip_id=pip_id,
                   payload={"job_version": job_version, "next_due_at": due})
    return {"pip_id": pip_id, "job_version": job_version, "anchor_at": anchor,
            "next_due_at": due, "last_due_at": None, "last_checked_at": None}


def _advance_skipped(registry, state, plan, reason):
    """Compare-and-swap a skipped occurrence; never clobber a reviewed revision."""
    from .pip_daemon import is_runtime_paused
    with registry.transaction():
        if is_runtime_paused(registry):
            return False
        current = registry.db.execute("SELECT current_version,status FROM pips WHERE id=?", (state["pip_id"],)).fetchone()
        if current is None or current["current_version"] != state["job_version"]:
            return False
        if reason == "job_paused" and current["status"] == "active":
            return False
        if reason == "job_busy" and not registry.db.execute(
                "SELECT 1 FROM pip_runs WHERE pip_id=? AND status IN ('queued','running','cancelling') LIMIT 1",
                (state["pip_id"],)).fetchone():
            return False
        updated = registry.db.execute("""UPDATE pip_schedule_state SET
            next_due_at=?,last_due_at=?,last_checked_at=?
            WHERE pip_id=? AND job_version=? AND next_due_at=?""",
            (plan["next_due_at"], plan["scheduled_at"], plan["checked_at"],
             state["pip_id"], state["job_version"], state["next_due_at"])).rowcount
        if updated:
            registry.event(state["workspace_id"], "pip_schedule_skipped", pip_id=state["pip_id"],
                           payload={"job_version": state["job_version"], "scheduled_at": plan["scheduled_at"],
                                    "next_due_at": plan["next_due_at"], "reason": reason,
                                    "coalesced": plan["coalesced"]})
        return bool(updated)


def retry_delay(attempts: int) -> int:
    """Seconds before a due occurrence that failed to start ATTEMPTS times in a row is tried again."""
    return min(MAX_RETRY_SECONDS, ERROR_RETRY_SECONDS * 2 ** min(max(0, int(attempts) - 1), 16))


def _deferral(registry, pip_id):
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (DEFERRAL_KEY + pip_id,)).fetchone()
    try:
        value = json.loads(row[0]) if row is not None and len(row[0]) <= 2048 else None
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) and type(value.get("attempts")) is int else None


def _current(held, state) -> bool:
    """A saved deferral still describes the occurrence the schedule is on (not an older version or occurrence)."""
    return (held is not None and held.get("job_version") == state["job_version"]
            and held.get("next_due_at") == state["next_due_at"])


def _clear_deferral(registry, pip_id) -> None:
    if _deferral(registry, pip_id) is not None:
        with registry.transaction():
            registry.db.execute("DELETE FROM metadata WHERE key=?", (DEFERRAL_KEY + pip_id,))


def deferral_status(registry, pip_id) -> dict | None:
    """How long this Pip's schedule has been unable to start its due run, or None: {code, attempts, since,
    next_try_at, alert}. For the Pip's status (the model's pips_context, the CLI) and its alert."""
    held = _deferral(registry, pip_id)
    if held is None:
        return None
    state = registry.db.execute("SELECT job_version,next_due_at FROM pip_schedule_state WHERE pip_id=?",
                                (pip_id,)).fetchone()
    if state is None or not _current(held, state):
        return None
    return {"code": str(held.get("code") or "schedule_failed"), "attempts": held["attempts"],
            "since": held.get("since"), "next_try_at": held.get("retry_at"),
            "alert": held["attempts"] >= ALERT_AFTER, "alerted_at": held.get("alerted_at")}


def blocked_schedules(registry, limit: int = 20) -> list[dict]:
    """Pips whose due run has failed to start ALERT_AFTER times or more in a row, newest alert first: {pip_id,
    workspace_id, name, code, attempts, since, alerted_at, said}. What the digest and the desktop alert say."""
    found = []
    rows = registry.db.execute("SELECT key FROM metadata WHERE key LIKE ? ESCAPE '\\' LIMIT 500",
                               (DEFERRAL_KEY.replace("_", "\\_") + "%",)).fetchall()
    for (key,) in rows:
        pip_id = key[len(DEFERRAL_KEY):]
        status = deferral_status(registry, pip_id)
        if status is None or not status["alert"]:
            continue
        row = registry.db.execute("""SELECT p.workspace_id,p.status,json_extract(v.definition,'$.name') AS name
            FROM pips p JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version WHERE p.id=?""",
                                  (pip_id,)).fetchone()
        if row is None or row["status"] == "archived":
            continue
        name = " ".join(str(row["name"] or "A Pip").split())[:80]
        said = (f"{name} can't run on this computer: its commands need the sandbox, which can't start here. "
                "Run `dgc pips execution --fix` in a terminal."
                if status["code"] == "execution_unavailable" else
                f"{name}'s scheduled run keeps failing to start ({status['code']}).")
        found.append({"pip_id": pip_id, "workspace_id": row["workspace_id"], "name": name, **status, "said": said})
    found.sort(key=lambda item: str(item.get("alerted_at") or ""), reverse=True)
    return found[:limit]


def deferral_reason(code: str) -> str:
    """Why a scheduled run keeps failing to start, in words: the sandbox's own reason when that is it."""
    if code == "execution_unavailable":
        from .pip_execution import capability
        found = capability()
        return str(found.get("reason") or "") if not found.get("available") else (
            "Its commands couldn't run in their sandbox; that works now, and the next try should start.")
    return f"Its scheduled run keeps failing to start ({code})."


def _defer_error(registry, state, checked_at, code):
    # Do not persist exception text, source paths, credentials or provider output.
    safe_code = code if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,64}", code) else "schedule_failed"
    with registry.transaction():
        updated = registry.db.execute("""UPDATE pip_schedule_state SET last_checked_at=?
            WHERE pip_id=? AND job_version=? AND next_due_at=?""",
            (checked_at, state["pip_id"], state["job_version"], state["next_due_at"])).rowcount
        if updated:
            prior = _deferral(registry, state["pip_id"])
            same = _current(prior, state) and prior.get("code") == safe_code
            attempts = prior["attempts"] + 1 if same else 1
            delay = retry_delay(attempts)
            record = {"job_version": state["job_version"], "next_due_at": state["next_due_at"], "code": safe_code,
                      "attempts": attempts, "since": prior.get("since") if same else checked_at,
                      "retry_at": timestamp(_instant(checked_at) + timedelta(seconds=delay)),
                      # Raised once per episode: the alert's time is what the digest and the desktop compare.
                      "alerted_at": (prior.get("alerted_at") if same else None)
                                    or (checked_at if attempts >= ALERT_AFTER else None)}
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                                (DEFERRAL_KEY + state["pip_id"], json.dumps(record, separators=(",", ":"))))
            registry.event(state["workspace_id"], "pip_schedule_deferred", pip_id=state["pip_id"],
                           payload={"job_version": state["job_version"], "code": safe_code,
                                    "retry_after_seconds": delay, "attempt": attempts,
                                    **({"alert": True} if attempts == ALERT_AFTER else {})})


def tick(registry, config, *, now=None, limit=MAX_TICK_ITEMS, stop_event=None):
    """Consider at most eight due jobs, enqueue at most one occurrence per job.

    Offline time coalesces to the latest occurrence. Paused or already-busy jobs
    skip that occurrence; errors leave it due with bounded retry spacing. No
    worker or network call is launched here. Source resolution uses the existing
    enqueue path, which rechecks the schedule/version/stop and commits atomically.
    """
    from .pips import PipStore
    from .pip_daemon import is_runtime_paused
    result = {"examined": 0, "enqueued": 0, "skipped": 0, "deferred": 0, "stale": 0, "stopped": False}
    if type(limit) is not int or not 1 <= limit <= MAX_TICK_ITEMS:
        raise RegistryError("invalid_schedule", "A schedule tick may inspect from one to eight jobs.")
    if config.get("pips_enabled", False) is not True or is_runtime_paused(registry):
        result["stopped"] = True
        return result
    instant = _instant(registry.clock() if now is None else now)
    checked = timestamp(instant)
    retry_before = timestamp(instant - timedelta(seconds=ERROR_RETRY_SECONDS))
    rows = registry.db.execute("""SELECT s.*,p.workspace_id,p.status,p.current_version,
        CASE WHEN length(CAST(v.definition AS BLOB))<=24576 THEN v.definition END AS definition
        FROM pip_schedule_state s JOIN pips p ON p.id=s.pip_id
        JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version
        WHERE p.status!='archived' AND s.next_due_at<=? AND (s.last_checked_at IS NULL OR s.last_checked_at<=?)
        ORDER BY s.next_due_at,s.pip_id LIMIT ?""", (checked, retry_before, limit * 8)).fetchall()
    store = PipStore(registry)
    for raw in rows:
        if (stop_event is not None and stop_event.is_set()) or is_runtime_paused(registry):
            result["stopped"] = True
            break
        state = dict(raw)
        held = _deferral(registry, state["pip_id"])
        if _current(held, state) and str(held.get("retry_at") or "") > checked:
            continue                     # backing off; it doesn't take one of this tick's places either
        if result["examined"] >= limit:
            break
        result["examined"] += 1
        try:
            if state["job_version"] != state["current_version"]:
                raise RegistryError("invalid_schedule", "Schedule cursor belongs to an older job version.")
            if state["definition"] is None:
                raise RegistryError("stored_data_limit", "Stored job exceeds the bounded schedule contract.")
            spec = validate_schedule(json.loads(state["definition"]).get("schedule"))
            if spec is None:
                raise RegistryError("invalid_schedule", "A manual-only job has a stale schedule cursor.")
            plan = plan_due(spec, state["next_due_at"], instant, state["anchor_at"])
            if plan is None:
                result["stale"] += 1
                continue
            busy = registry.db.execute("SELECT 1 FROM pip_runs WHERE pip_id=? AND status IN ('queued','running','cancelling') LIMIT 1",
                                       (state["pip_id"],)).fetchone()
            if state["status"] != "active" or busy:
                reason = "job_paused" if state["status"] != "active" else "job_busy"
                result["skipped"] += int(_advance_skipped(registry, state, plan, reason))
                _clear_deferral(registry, state["pip_id"])
                continue
            occurrence = {key: plan[key] for key in ("expected_next_due", "scheduled_at", "next_due_at", "checked_at")}
            occurrence["job_version"] = state["job_version"]
            try:
                store.enqueue(state["pip_id"], occurrence_key(state["job_version"], plan["scheduled_at"]),
                              "local-scheduler", config, schedule_occurrence=occurrence)
            except RegistryError as exc:
                if exc.code in ("paused", "schedule_busy", "source_unchanged"):
                    reason = {"paused": "job_paused", "schedule_busy": "job_busy"}.get(exc.code, exc.code)
                    result["skipped"] += int(_advance_skipped(registry, state, plan, reason))
                    _clear_deferral(registry, state["pip_id"])
                    continue
                if exc.code == "conflict":
                    result["stale"] += 1
                    continue
                if exc.code == "runner_stopped":
                    result["stopped"] = True
                    break
                raise
            result["enqueued"] += 1
            _clear_deferral(registry, state["pip_id"])
        except (RegistryError, ValueError, TypeError) as exc:
            _defer_error(registry, state, checked, getattr(exc, "code", "invalid_schedule"))
            result["deferred"] += 1
    return result


class ScheduleTick:
    """One owned scheduler thread so slow Git probes cannot delay heartbeats."""
    def __init__(self, config, directory, clock):
        self.config, self.directory, self.clock = config, directory, clock
        self.stop_event = threading.Event()
        self.error = None
        self.result = None
        self.started = False
        self.thread = threading.Thread(target=self._run, name="dgc-pips-schedule", daemon=True)

    def _run(self):
        try:
            with WorkspaceRegistry(self.directory, clock=self.clock) as registry:
                self.result = tick(registry, self.config, stop_event=self.stop_event)
        except BaseException:
            # Store no raw diagnostic that may contain a private path or key.
            self.error = RegistryError("runner_failed", "The schedule controller failed; review the local registry before restarting.")

    def start(self):
        try:
            self.thread.start()
            self.started = True
        except Exception as exc:
            self.error = RegistryError("runner_failed", "The schedule controller could not start; review local resources before restarting.")
            raise self.error from exc
        return self

    def check(self):
        if self.error is not None:
            raise self.error

    def is_alive(self):
        return self.thread.is_alive()

    def stop(self):
        self.stop_event.set()

    def join(self):
        # Existing Git source probes are timeout-bounded. Keep the supervisor
        # lease until this owned tick is finished rather than creating overlap.
        if self.started:
            self.thread.join()
        self.check()


def has_due_schedule(registry, now=None):
    instant = _instant(registry.clock() if now is None else now)
    return registry.db.execute("""SELECT 1 FROM pip_schedule_state s
        JOIN pips p ON p.id=s.pip_id
        WHERE p.status!='archived' AND s.next_due_at<=?
        AND (s.last_checked_at IS NULL OR s.last_checked_at<=?) LIMIT 1""",
        (timestamp(instant), timestamp(instant - timedelta(seconds=ERROR_RETRY_SECONDS)))).fetchone() is not None
