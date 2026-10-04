"""Spend control: what each Pip's runs cost in tokens, and an optional daily limit.

Tokens per run come from the usage the runner imports when the run finishes (pip_usage), which
counts every request, including those of a run that failed or timed out. A run whose usage is not
imported yet counts what its own result reported. Days are local days, like the digest's.

The limit is the user's own setting, kept in the registry, not part of the reviewed job: lowering
it needs no review and no model can change it. Once a Pip's runs today reach it, its schedules and
event triggers are skipped (`daily_cap_reached`) until the next local day; a run you start
yourself, a chat reply or a handoff you approve still runs.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .workspace_registry import RegistryError

CAP_PREFIX = "pip_daily_token_cap:"
MIN_CAP = 1_000
MAX_CAP = 1_000_000_000
WINDOW_DAYS = 30


def _instant(stamp):
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None


def cap(registry, pip_id) -> int | None:
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (CAP_PREFIX + pip_id,)).fetchone()
    try:
        value = int(row[0]) if row else None
    except (TypeError, ValueError):
        return None
    return value if value is not None and MIN_CAP <= value <= MAX_CAP else None


def set_cap(registry, pip_id, daily_tokens, actor) -> dict:
    if actor not in ("editor-user", "local-console"):
        raise RegistryError("local_only", "A Pip's daily limit is set on this computer only.")
    if registry.db.execute("SELECT 1 FROM pips WHERE id=?", (pip_id,)).fetchone() is None:
        raise RegistryError("not_found", "Pip not found on this runner.")
    if daily_tokens is not None and (type(daily_tokens) is not int or not MIN_CAP <= daily_tokens <= MAX_CAP):
        raise RegistryError("invalid_request", f"Choose a daily limit from {MIN_CAP:,} to {MAX_CAP:,} tokens, or none.")
    with registry.transaction():
        if daily_tokens is None:
            registry.db.execute("DELETE FROM metadata WHERE key=?", (CAP_PREFIX + pip_id,))
        else:
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (CAP_PREFIX + pip_id, str(daily_tokens)))
        workspace = registry.db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()[0]
        registry.event(workspace, "pip_daily_cap_changed", pip_id=pip_id, payload={"daily_tokens": daily_tokens, "actor": actor})
    return usage(registry, pip_id)


def _runs(registry, pip_id, since_stamp):
    return registry.db.execute(
        "SELECT id,finished_at,result FROM pip_runs WHERE pip_id=? AND finished_at IS NOT NULL AND finished_at>? "
        "AND status IN ('succeeded','failed','cancelled')", (pip_id, since_stamp)).fetchall()


def _tokens(row, imported):
    if row[0] in imported:
        inp, out = imported[row[0]]
        return inp + out
    try:
        value = json.loads(row[2]) if row[2] else None
        used = value.get("usage") if isinstance(value, dict) else None
        if isinstance(used, dict):
            return max(0, int(used.get("input_tokens", 0) or 0)) + max(0, int(used.get("output_tokens", 0) or 0))
    except (ValueError, TypeError):
        pass
    return 0


def usage(registry, pip_id, *, now=None) -> dict:
    """Today and the last 30 local days for one Pip, with its limit and whether today hit it."""
    from .pip_digest import local_day
    from .pip_schedules import timestamp
    from .pip_usage import run_totals
    if registry.db.execute("SELECT 1 FROM pips WHERE id=?", (pip_id,)).fetchone() is None:
        raise RegistryError("not_found", "Pip not found on this runner.")
    now = now or _instant(registry.clock())
    since = now - timedelta(days=WINDOW_DAYS + 1)
    rows = _runs(registry, pip_id, timestamp(since))
    imported = run_totals([r[0] for r in rows], home=Path(registry.directory).parent)
    today = local_day(now)
    first_day = local_day(now - timedelta(days=WINDOW_DAYS - 1))
    by_day: dict[str, list[int]] = {}
    for row in rows:
        finished = _instant(row[1])
        if finished is None:
            continue
        day = local_day(finished)
        if day < first_day:
            continue
        entry = by_day.setdefault(day, [0, 0])
        entry[0] += _tokens(row, imported)
        entry[1] += 1
    today_tokens, today_runs = by_day.get(today, [0, 0])
    limit = cap(registry, pip_id)
    return {"pip_id": pip_id, "today": {"day": today, "tokens": today_tokens, "runs": today_runs},
            "last_30_days": {"tokens": sum(v[0] for v in by_day.values()), "runs": sum(v[1] for v in by_day.values())},
            "days": [{"day": day, "tokens": v[0], "runs": v[1]} for day, v in sorted(by_day.items())][-WINDOW_DAYS:],
            "daily_cap": limit, "capped_today": limit is not None and today_tokens >= limit}


def over_daily_cap(registry, pip_id) -> bool:
    """True when the Pip's runs today already reached its limit. Never raises."""
    try:
        if cap(registry, pip_id) is None:
            return False
        return usage(registry, pip_id)["capped_today"]
    except (RegistryError, ValueError, TypeError):
        return False
