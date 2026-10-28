"""What each Pip's runs cost in tokens: today and over the last 30 local days. Nothing here limits a Pip.

Tokens per run come from the usage the runner imports when the run finishes (pip_usage), which
counts every request, including those of a run that failed or timed out. A run whose usage is not
imported yet counts what its own result reported. Days are local days, like the digest's.

Pips have no daily token limit (reported 2026-10-14: no daily budgets). Older registries may still
hold a limit a user once set (`pip_daily_token_cap:<pip>`): it is ignored. The usage answer keeps its
`daily_cap` (always null) and `capped_today` (always false), which editors since API 41 expect.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .workspace_registry import RegistryError

WINDOW_DAYS = 30


def _instant(stamp):
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None


def set_cap(registry, pip_id, daily_tokens, actor) -> dict:
    """An older editor's or SDK's set_pip_daily_cap: removing a limit is answered with the usage (there is none);
    setting one is refused, in words."""
    if registry.db.execute("SELECT 1 FROM pips WHERE id=?", (pip_id,)).fetchone() is None:
        raise RegistryError("not_found", "Pip not found on this runner.")
    if daily_tokens is not None:
        raise RegistryError("invalid_request", "Pips have no daily token limit: each one runs until its work is done.")
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
    for day, tokens in _external(registry, pip_id):
        if day >= first_day:
            by_day.setdefault(day, [0, 0])[0] += tokens
    today_tokens, today_runs = by_day.get(today, [0, 0])
    return {"pip_id": pip_id, "today": {"day": today, "tokens": today_tokens, "runs": today_runs},
            "last_30_days": {"tokens": sum(v[0] for v in by_day.values()), "runs": sum(v[1] for v in by_day.values())},
            "days": [{"day": day, "tokens": v[0], "runs": v[1]} for day, v in sorted(by_day.items())][-WINDOW_DAYS:],
            "daily_cap": None, "capped_today": False}


EXTERNAL_PREFIX = "pip_troupe_tokens:"   # + pip id + ":" + local day: a troupe routine's tokens (troupe_routines)


def _external(registry, pip_id):
    prefix = f"{EXTERNAL_PREFIX}{pip_id}:"
    for key, value in registry.db.execute("SELECT key,value FROM metadata WHERE substr(key,1,?)=?",
                                          (len(prefix), prefix)).fetchall():
        try:
            yield key[len(prefix):], max(0, int(value))
        except (TypeError, ValueError):
            continue


def add_external(registry, pip_id, tokens: int, *, now=None) -> None:
    """Count work the Pip started outside its runs (a troupe routine) in its day's usage."""
    from .pip_digest import local_day
    if type(tokens) is not int or tokens <= 0:
        return
    now = now or _instant(registry.clock())
    day = local_day(now)
    oldest = local_day(now - timedelta(days=WINDOW_DAYS + 1))
    prefix = f"{EXTERNAL_PREFIX}{pip_id}:"
    with registry.transaction():
        row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (prefix + day,)).fetchone()
        try:
            before = int(row[0]) if row else 0
        except (TypeError, ValueError):
            before = 0
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (prefix + day, str(before + tokens)))
        registry.db.execute("DELETE FROM metadata WHERE substr(key,1,?)=? AND substr(key,?)<?",
                            (len(prefix), prefix, len(prefix) + 1, oldest))
