"""Token usage by Pip: the Pips tab of the Token Usage page.

A breakdown of what the page already counts, never an addition to it: a Pip's runs, its chat
replies included, record their model requests in the same local ledger. Per run, the totals the
runner imported when it finished (pip_usage), else what the run's own result reported; a run counts
on the local day it finished. The page's whole total for the same range comes with it, so the tab
can say how much of everything the Pips used.
"""
from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAX_PIPS = 200


def _iso(epoch: int) -> str:
    from .pip_schedules import timestamp
    return timestamp(datetime.fromtimestamp(epoch, timezone.utc))


def _split(row, imported) -> tuple[int, int]:
    if row[0] in imported:
        return imported[row[0]]
    try:
        value = json.loads(row[3]) if row[3] else None
        used = value.get("usage") if isinstance(value, dict) else None
        if isinstance(used, dict):
            return (max(0, int(used.get("input_tokens", 0) or 0)), max(0, int(used.get("output_tokens", 0) or 0)))
    except (ValueError, TypeError):
        pass
    return (0, 0)


def report(range_name: str = "7d", *, now: float | None = None) -> dict:
    from . import usage_ledger as ledger
    from .pip_usage import run_totals
    from .workspace_registry import RegistryError, WorkspaceRegistry, in_use
    range_name = ledger.normalize_range(range_name)
    stamp = time.time() if now is None else float(now)
    whole = ledger.report(range_name, now=stamp)       # also imports finished Pip runs' usage first
    out = {"range": range_name, "generated_at": whole["generated_at"], "timezone": whole["timezone"],
           "all_tokens": int(whole["totals"]["input_tokens"]) + int(whole["totals"]["output_tokens"]),
           "totals": {"input_tokens": 0, "output_tokens": 0, "runs": 0}, "by_pip": [], "omitted": 0}
    if whole.get("error"):
        out["error"] = whole["error"]
    if not in_use():
        return out                      # a profile that never used Pips gets no registry
    today, first = ledger.range_days(range_name, stamp)
    window, args = "", ()
    if first is not None:
        window = " AND finished_at>=? AND finished_at<?"
        args = (_iso(ledger._local_midnight(first)), _iso(ledger._local_midnight(today + timedelta(days=1))))
    try:
        with WorkspaceRegistry() as registry:
            rows = registry.db.execute(
                "SELECT id,pip_id,finished_at,result FROM pip_runs WHERE finished_at IS NOT NULL "
                "AND status IN ('succeeded','failed','cancelled')" + window, args).fetchall()
            imported = run_totals([r[0] for r in rows], home=Path(registry.directory).parent)
            per: dict[str, list[int]] = {}
            for row in rows:
                inp, outp = _split(row, imported)
                entry = per.setdefault(row[1], [0, 0, 0])
                entry[0] += inp
                entry[1] += outp
                entry[2] += 1
            from .pip_spend import cap
            pips = []
            for pip_id, (inp, outp, runs) in per.items():
                meta = registry.db.execute(
                    "SELECT p.status,w.kind,w.name,v.definition FROM pips p JOIN workspaces w ON w.id=p.workspace_id "
                    "JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version WHERE p.id=?", (pip_id,)).fetchone()
                try:
                    definition = json.loads(meta[3]) if meta else {}
                except ValueError:
                    definition = {}
                pips.append({"pip_id": pip_id, "name": str(definition.get("name") or "Removed Pip")[:120],
                             "pip_type": str(definition.get("pip_type") or "")[:16],
                             "scope": "personal" if meta and meta[1] == "personal" else "project",
                             "project": "" if not meta or meta[1] == "personal" else str(meta[2] or "")[:120],
                             "status": str(meta[0]) if meta else "removed",
                             "input_tokens": inp, "output_tokens": outp, "runs": runs,
                             "daily_cap": cap(registry, pip_id)})
    except (OSError, sqlite3.Error, RegistryError) as exc:
        out["error"] = f"Pip usage could not be read: {exc}"[:300]
        return out
    pips.sort(key=lambda p: (-(p["input_tokens"] + p["output_tokens"]), -p["runs"], p["name"]))
    out["totals"] = {"input_tokens": sum(p["input_tokens"] for p in pips),
                     "output_tokens": sum(p["output_tokens"] for p in pips), "runs": sum(p["runs"] for p in pips)}
    out["by_pip"], out["omitted"] = pips[:MAX_PIPS], max(0, len(pips) - MAX_PIPS)
    return out
