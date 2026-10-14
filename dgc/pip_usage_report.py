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
MAX_PIP_MODELS = 5          # a Pip's own models, most tokens first


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
           "totals": {"input_tokens": 0, "output_tokens": 0, "runs": 0}, "by_pip": [], "omitted": 0,
           # Which models the Pips used, from their own requests in the ledger (each Pip request is
           # recorded with its model, source "pip"): complete for the range, older runs included.
           "by_model": ledger.by_model_for_source("pip", range_name, now=stamp)}
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
            from .pip_usage import run_models
            by_run = run_models([r[0] for r in rows], home=Path(registry.directory).parent)
            per: dict[str, list[int]] = {}
            models: dict[str, dict[tuple, list[int]]] = {}
            for row in rows:
                inp, outp = _split(row, imported)
                entry = per.setdefault(row[1], [0, 0, 0])
                entry[0] += inp
                entry[1] += outp
                entry[2] += 1
                for model, provider, host, m_in, m_out, requests in by_run.get(row[0], ()):
                    used = models.setdefault(row[1], {}).setdefault((model, provider, host), [0, 0, 0])
                    used[0] += m_in
                    used[1] += m_out
                    used[2] += requests
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
                             "daily_cap": None,      # Pips have no daily limit; kept for editors since API 41
                             # Its runs since runs recorded their models; [] for a Pip whose runs
                             # all predate that (its totals above still count them).
                             "models": [{"model": str(m)[:256], "provider": str(pv)[:64], "host": str(h)[:255],
                                         "input_tokens": u[0], "output_tokens": u[1], "requests": u[2]}
                                        for (m, pv, h), u in sorted(models.get(pip_id, {}).items(),
                                                                    key=lambda kv: (-(kv[1][0] + kv[1][1]), kv[0][0]))[:MAX_PIP_MODELS]]})
    except (OSError, sqlite3.Error, RegistryError) as exc:
        out["error"] = f"Pip usage could not be read: {exc}"[:300]
        return out
    pips.sort(key=lambda p: (-(p["input_tokens"] + p["output_tokens"]), -p["runs"], p["name"]))
    out["totals"] = {"input_tokens": sum(p["input_tokens"] for p in pips),
                     "output_tokens": sum(p["output_tokens"] for p in pips), "runs": sum(p["runs"] for p in pips)}
    out["by_pip"], out["omitted"] = pips[:MAX_PIPS], max(0, len(pips) - MAX_PIPS)
    return out
