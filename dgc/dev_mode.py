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
    Limit("work_helpers", 4, 32, "Work helpers at once",
          "Each helper is its own checkout of the project and its own stream of model requests: disk and rate limits "
          "add up.", "ultra.worker_limit"),
    Limit("helper_depth", 1, 8, "How deep Work helpers may nest",
          "Each level can start helpers of its own: the number of agents multiplies with each level.",
          "agent.max_subagent_depth"),
    Limit("troupe_agents", 400, 400, "Agents one troupe may start",
          "Each agent is a model call, often with its own worktree: model load and disk add up.", "troupe.MAX_AGENTS"),
    Limit("troupe_items", 200, 200, "Items one troupe may take",
          "Each item is at least one agent's work.", "troupe.MAX_ITEMS"),
    Limit("monitors_per_chat", 4, 4, "Monitors per chat",
          "Each is a process DGC watches; its output can wake the chat.", "monitors.MAX_MONITORS_PER_OWNER"),
    Limit("monitors_per_dgc", 16, 16, "Monitors per DGC",
          "Each is a process DGC watches, across every chat.", "monitors.MAX_MONITORS_PROCESS"),
    Limit("pip_agent_slots", 4, 4, "The most sub-agents one Pip runs at once",
          "Each sub-agent is a model run in its Pip's computer: memory, processor and tokens add up.",
          "pip_agents.set_slots"),
    Limit("pip_background_jobs", 3, 3, "Background commands at once on a Pip's computer",
          "Each is a command running in the computer's box: memory, processor and network add up.",
          "pip_computer_files.background_limits"),
    Limit("pip_background_minutes", 60, 60, "Minutes one background command may run",
          "A longer build or download holds its share of the machine for longer.", "pip_computer_files.background_limits"),
    Limit("pip_files_gb", 1, 1, "Files on each Pip's computer (GB)",
          "Each computer's Files can hold this much of this machine's disk, and one file can be as big; a full disk "
          "stops every Pip.", "pip_computer_files.folder_limit"),
    Limit("pip_project_copy_mb", 200, 200, "A project's copy on a Pip's computer (MB)",
          "A bigger copy takes longer to make and holds more of this machine's disk.", "pip_project_copies.copy_limit"),
    Limit("pip_queue", 20, 20, "Pip runs waiting at once",
          "Each waiting run holds its inputs in the Pips registry until it starts.", "pips.max_queue"),
    # How much one turn holds
    Limit("tool_shell_output", 30000, 30000, "Shell output the model sees (characters)",
          "Every character goes into the model's context: more tokens each turn.", "tools.MAX_BASH_OUT"),
    Limit("tool_read_lines", 2000, 2000, "Lines one file read shows",
          "More lines a read: more tokens each turn.", "tools.MAX_READ_LINES"),
    Limit("tool_fetch_chars", 8000, 8000, "Characters a web fetch shows",
          "More of each page: more tokens each turn, and more a page can say to the model.", "tools.MAX_FETCH_CHARS"),
    Limit("tool_grep_matches", 200, 200, "Matches one search shows",
          "More matches a search: more tokens each turn.", "tools.max_grep_matches"),
    Limit("tool_glob_results", 100, 100, "Files one file search lists",
          "More files a listing: more tokens each turn.", "tools.max_glob_results"),
    Limit("research_fetchers", 4, 4, "Pages deep research reads at once",
          "Each is a page fetched and read by the model at the same time: model load and network add up.",
          "chatdgc.research.workers"),
    Limit("research_searches", 4, 4, "Searches deep research runs at once",
          "Each is a request to your search provider: its rate limits and costs apply.",
          "chatdgc.research.search_workers"),
    # How many are kept
    Limit("pip_routines", 10, 10, "Routines per Pip",
          "Each routine can start a run on its schedule: more model calls.", "pip_routines.max_routines"),
    Limit("pip_conversations", 500, 500, "Conversations per Pip (archived included)",
          "Each keeps its messages in the Pips registry on disk.", "pip_conversations.MAX_CONVERSATIONS"),
    # (Money: each Pip's daily dollar limit is yours to set on its page; the 3-a-day count is retired, 13 Nov.)
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


def chosen(name: str, config=None) -> int | None:
    """The number you set for this limit in Dev Mode, or None (Dev Mode off, or left at its default)."""
    _BY_NAME[name]
    if not on(config):
        return None
    mine = _get(config, "dev_limits", {})
    value = mine.get(name) if isinstance(mine, dict) else None
    return value if _whole(value) else None


def helpers_ceiling(config=None) -> int:
    """The most Work helpers one `task` call may start and that may run at once: config.MAX_PARALLEL_TASKS, or more
    when Dev Mode sets more."""
    from .config import MAX_PARALLEL_TASKS
    mine = chosen("work_helpers", config)
    return max(MAX_PARALLEL_TASKS, mine) if mine is not None else MAX_PARALLEL_TASKS


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
