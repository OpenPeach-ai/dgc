"""Dev Mode: DGC's capacity limits, lifted for a big machine (0.52, asked 7 and 10 Nov).

Off by default. Off, every limit is today's default with today's ceiling. On (Settings → Dev Mode, `dev_mode` in DGC's
settings), each limit below is the whole number you set in `dev_limits` (1 or more, no ceiling); one you didn't set
stays at its default. Only CAPACITY moves here: how many at once, how much one turn holds, how many are kept. Safety
limits never do: the sandbox, redaction, approvals and a Pip's level, sizes of what arrives from outside, parser depth.

`value(name, config)` is the one reader. Pass the running config where there is one; with none it reads DGC's own
settings file (cached until the file changes), so `dgc serve`, the Pips runner, the TUI and the SDK agree.
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass


@dataclass(frozen=True)
class Limit:
    name: str
    default: int
    ceiling: int | None      # the most you can set without Dev Mode (None: not settable without it)
    label: str               # what it is, in a few words
    cost: str                # what raising it costs, in one line
    where: str               # the code that reads it


LIMITS = (
    # How many at once
    Limit("pips_parallel_runs", 4, 32, "Pip runs at once (all Pips)",
          "Each run is a model call and, with a computer, its sandbox: memory and model load add up.", "pips.parallel_runs"),
    Limit("pip_computers", 3, 3, "Computers per Pip",
          "Each running computer: about 0.5 to 1 GB of memory and a browser.", "pip_computer.computers_limit"),
    Limit("monitors_per_chat", 4, 4, "Monitors per chat",
          "Each is a process DGC watches; its output can wake the chat.", "monitors.MAX_MONITORS_PER_OWNER"),
    Limit("monitors_per_dgc", 16, 16, "Monitors per DGC",
          "Each is a process DGC watches, across every chat.", "monitors.MAX_MONITORS_PROCESS"),
    Limit("pip_queue", 20, 20, "Pip runs waiting at once",
          "Each waiting run holds its inputs in the Pips registry until it starts.", "pips.max_queue"),
    # How many are kept
    Limit("pip_routines", 10, 10, "Routines per Pip",
          "Each routine can start a run on its schedule: more model calls.", "pip_routines.max_routines"),
    Limit("pip_conversations", 500, 500, "Conversations per Pip (archived included)",
          "Each keeps its messages in the Pips registry on disk.", "pip_conversations.MAX_CONVERSATIONS"),
    # Money: a safeguard you can change, never dropped
    Limit("payments_a_day", 3, 20, "Payments a day by Pips you let pay",
          "Money: each is a payment a Pip makes without asking you.", "pip_levels.pay_limit"),
)
_BY_NAME = {limit.name: limit for limit in LIMITS}
_lock = threading.Lock()
_cache: dict = {"mtime": None, "data": {}}


def _settings():
    """DGC's own settings as on disk, re-read only when the file changed."""
    from .config import USER_CONFIG
    try:
        mtime = USER_CONFIG.stat().st_mtime_ns
    except OSError:
        return {}
    with _lock:
        if _cache["mtime"] != mtime:
            try:
                data = json.loads(USER_CONFIG.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
            _cache.update(mtime=mtime, data=data if isinstance(data, dict) else {})
        return _cache["data"]


def _get(config, key, default=None):
    if config is None:
        return _settings().get(key, default)
    get = getattr(config, "get", None)
    return get(key, default) if callable(get) else default


def on(config=None) -> bool:
    return _get(config, "dev_mode", False) is True


def _whole(value) -> bool:
    return type(value) is int and value >= 1


def value(name: str, config=None) -> int:
    """The limit in force: yours in Dev Mode (a whole number, 1 or more), else today's default. KeyError for a name
    that is not a capacity limit (a safety limit is never one)."""
    limit = _BY_NAME[name]
    if not on(config):
        return limit.default
    mine = _get(config, "dev_limits", {})
    chosen = mine.get(name) if isinstance(mine, dict) else None
    return chosen if _whole(chosen) else limit.default


def ceiling(name: str, config=None) -> int | None:
    """The most a setting may hold: today's ceiling, or none in Dev Mode."""
    return None if on(config) else _BY_NAME[name].ceiling


def clean_limits(values) -> tuple[dict, list[str]]:
    """What may be saved as `dev_limits`, and why the rest may not, in plain words."""
    kept, refused = {}, []
    for name, chosen in (values.items() if isinstance(values, dict) else []):
        if name not in _BY_NAME:
            refused.append(f"{name}: not a Dev Mode limit")
        elif not _whole(chosen):
            refused.append(f"{name}: a whole number, 1 or more")
        else:
            kept[name] = chosen
    return kept, refused


def listing(config=None) -> list[dict]:
    """Settings' Limits group: each limit with its default, the value in force and its cost line."""
    return [{"name": limit.name, "label": limit.label, "default": limit.default, "ceiling": limit.ceiling,
             "value": value(limit.name, config), "cost": limit.cost} for limit in LIMITS]
