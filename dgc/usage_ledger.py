"""Local token usage ledger: one row per model request that finished, on this machine only.

DGC already keeps per-session totals beside each transcript. Those reset with every new chat and
carry no model, host or date, so they cannot answer "how many tokens did I use this week, and on
which model?". This ledger does, and nothing else:

* one sqlite file at ``~/.dgc/usage.sqlite`` shared by every DGC process (the TUI, several
  ``dgc serve`` editor backends, one-shot runs) — WAL mode with a busy timeout, so concurrent
  writers queue for a few milliseconds instead of overwriting each other's counts;
* one row per finished request: a UTC timestamp, the provider family, the endpoint HOST (never a
  path, query or credential), the model id, the input/output/cached token counts the provider
  reported, and which part of DGC sent it (main, subagent, fallback, compaction, other);
* a request that ended without a usage report (cancelled, interrupted, or a provider that sent
  none) is still a row, marked unmetered, so the totals never pretend it did not happen;
* never any prompt, response, tool output, file path, session name or key.

Rows older than :data:`RETENTION_DAYS` are pruned with one indexed DELETE when a process first
opens the ledger (and again once a day in a long-running backend). A ledger that cannot be opened
or written costs the caller nothing: every write is best-effort and reports its failure once.
"""
from __future__ import annotations

import datetime as _dt
import os
import re
import sqlite3
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

LEDGER_NAME = "usage.sqlite"
RETENTION_DAYS = 400
RANGES = ("today", "7d", "30d", "month", "all")
RANGE_LABELS = {"today": "Today", "7d": "Last 7 days", "30d": "Last 30 days",
                "month": "This month", "all": "All time"}
SOURCES = ("main", "subagent", "fallback", "compaction", "other")
_RANGE_ALIASES = {
    "": "7d", "today": "today", "day": "today", "1d": "today",
    "7d": "7d", "7": "7d", "week": "7d", "7days": "7d",
    "30d": "30d", "30": "30d", "30days": "30d",
    "month": "month", "this-month": "month", "thismonth": "month",
    "all": "all", "all-time": "all", "alltime": "all", "ever": "all",
}
_MAX_TOKENS = 1_000_000_000
_MAX_BY_MODEL = 100
_MAX_TEXT = {"provider": 64, "host": 255, "model": 256}
_BUSY_TIMEOUT_MS = 2_000
_PRUNE_EVERY_S = 24 * 60 * 60
_SCHEMA = """CREATE TABLE IF NOT EXISTS requests(
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    provider TEXT NOT NULL,
    host TEXT NOT NULL,
    model TEXT NOT NULL,
    source TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    metered INTEGER NOT NULL)"""

_lock = threading.RLock()
_db: sqlite3.Connection | None = None
_db_key: tuple[str, int] | None = None      # (path, pid): a forked child must open its own handle
_last_prune = 0.0
_last_error = ""
_warned = False


def ledger_path() -> Path:
    """Where the ledger lives. Read at call time so a relocated HOME is honoured."""
    from . import config
    return Path(config.USER_HOME) / LEDGER_NAME


def normalize_range(value) -> str:
    """Map a user-typed range ("week", "30", "all-time") to one of :data:`RANGES`."""
    key = re.sub(r"\s+", "", str(value or "").strip().lower())
    if key in _RANGE_ALIASES:
        return _RANGE_ALIASES[key]
    raise ValueError("range must be one of: today, 7d, 30d, month, all")


def endpoint_host(base_url) -> str:
    """The endpoint's host (and explicit port) only. No scheme, path, query or credentials."""
    try:
        parts = urlsplit(str(base_url or "").strip())
        host = (parts.hostname or "").lower()
        port = parts.port
    except (ValueError, TypeError):
        return ""
    if not host:
        return ""
    if ":" in host:                                  # IPv6 literal
        host = f"[{host}]"
    return _text(f"{host}:{port}" if port else host, _MAX_TEXT["host"])


def last_error() -> str:
    """The most recent reason the ledger could not be opened, written or read ("" when fine)."""
    return _last_error


def _text(value, limit: int) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]", " ", str(value if value is not None else "")).strip()
    return text[:limit]


def _count(value) -> int:
    if isinstance(value, bool):
        return 0
    try:
        number = int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0
    return number if 0 <= number <= _MAX_TOKENS else 0


def _fail(exc: BaseException) -> None:
    """Remember why the ledger is unavailable and say so once per process, never mid-screen."""
    global _last_error, _warned
    _last_error = f"{type(exc).__name__}: {exc}"[:300]
    if _warned:
        return
    _warned = True
    try:
        # A terminal UI owns its screen; a stray line there would corrupt it. Editor backends and
        # one-shot runs have a log channel on stderr, which is where this belongs.
        if not sys.stderr.isatty():
            sys.stderr.write(f"[dgc] token usage ledger unavailable: {_last_error}\n")
            sys.stderr.flush()
    except Exception:
        pass


def _open(path: Path, *, create: bool) -> sqlite3.Connection | None:
    """Return this process's shared connection to ``path``; None when it does not exist yet."""
    global _db, _db_key, _last_prune
    key = (str(path), os.getpid())
    if _db is not None and _db_key == key:
        return _db
    if not create and not path.exists():
        return None
    if _db is not None and _db_key is not None and _db_key[1] == os.getpid():
        try:
            _db.close()
        except sqlite3.Error:
            pass
    _db = _db_key = None
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    if not path.exists():
        # Create the file owner-only before sqlite touches it: the -wal and -shm companions
        # inherit the database file's permissions.
        fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
    db = sqlite3.connect(str(path), timeout=_BUSY_TIMEOUT_MS / 1000, isolation_level=None,
                         check_same_thread=False)
    try:
        db.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
        for attempt in range(6):
            try:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("PRAGMA synchronous=NORMAL")
                db.execute(_SCHEMA)
                db.execute("CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts)")
                break
            except sqlite3.OperationalError as exc:
                # Two processes creating the ledger at the same instant can both ask for WAL;
                # the loser sees "locked" once and simply tries again.
                if attempt == 5 or not re.search(r"locked|busy", str(exc), re.I):
                    raise
                time.sleep(0.05 * (attempt + 1))
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except BaseException:
        db.close()
        raise
    _db, _db_key = db, key
    _last_prune = 0.0
    return db


def _prune(db: sqlite3.Connection, now: float) -> None:
    global _last_prune
    if _last_prune and now - _last_prune < _PRUNE_EVERY_S:
        return
    _last_prune = now
    db.execute("DELETE FROM requests WHERE ts < ?", (int(now) - RETENTION_DAYS * 86_400,))


def record(*, provider, base_url, model, source="main", input_tokens=0, output_tokens=0,
           cached_input_tokens=0, now: float | None = None, path: Path | None = None) -> bool:
    """Append one finished request. Returns False (and never raises) when it could not be kept."""
    global _last_error
    stamp = time.time() if now is None else float(now)
    source = source if source in SOURCES else "other"
    row = (int(stamp), _text(provider, _MAX_TEXT["provider"]) or "unknown",
           endpoint_host(base_url), _text(model, _MAX_TEXT["model"]) or "unknown", source,
           _count(input_tokens), _count(output_tokens), _count(cached_input_tokens))
    metered = 1 if (row[5] or row[6]) else 0
    try:
        with _lock:
            db = _open(Path(path) if path is not None else ledger_path(), create=True)
            _prune(db, stamp)
            db.execute(
                "INSERT INTO requests(ts, provider, host, model, source, input_tokens, "
                "output_tokens, cached_input_tokens, metered) VALUES (?,?,?,?,?,?,?,?,?)",
                (*row, metered))
        _last_error = ""
        return True
    except Exception as exc:                       # the ledger must never break a turn
        _fail(exc)
        return False


def _local_midnight(day: _dt.date) -> int:
    return int(time.mktime(day.timetuple()))


def _timezone_label(now: float) -> str:
    local = time.localtime(now)
    offset = time.strftime("%z", local)
    label = f"UTC{offset[:3]}:{offset[3:]}" if re.fullmatch(r"[+-]\d{4}", offset) else "local time"
    name = time.strftime("%Z", local)
    if name and re.fullmatch(r"[A-Za-z]{2,6}", name) and name.upper() != "UTC":
        return f"{name}, {label}"
    return label


def empty_report(range_name: str = "7d", *, now: float | None = None, error: str = "") -> dict:
    stamp = time.time() if now is None else float(now)
    report = {
        "range": range_name if range_name in RANGES else "7d",
        "generated_at": _dt.datetime.fromtimestamp(stamp, _dt.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timezone": _timezone_label(stamp),
        "totals": {"input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0,
                   "requests": 0, "unmetered_requests": 0},
        "by_model": [],
        "by_day": [],
    }
    if error:
        report["error"] = error[:300]
    return report


def report(range_name: str = "7d", *, now: float | None = None, path: Path | None = None) -> dict:
    """Aggregate one range: totals, by model (provider + host), and every local day in it.

    Day boundaries are this machine's local midnights, so "today" and each bar in a day strip
    match the user's clock. A range with no data still lists its days, with zeros.
    """
    range_name = normalize_range(range_name)
    stamp = time.time() if now is None else float(now)
    report = empty_report(range_name, now=stamp)
    today = _dt.date.fromtimestamp(stamp)
    first_day = {"today": today, "7d": today - _dt.timedelta(days=6),
                 "30d": today - _dt.timedelta(days=29),
                 "month": today.replace(day=1), "all": None}[range_name]
    where, args = ("WHERE ts >= ?", (_local_midnight(first_day),)) if first_day else ("", ())
    days: dict[str, dict] = {}
    try:
        with _lock:
            db = _open(Path(path) if path is not None else ledger_path(), create=False)
            if db is not None:
                total = db.execute(
                    "SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), "
                    "COALESCE(SUM(cached_input_tokens),0), COUNT(*), "
                    f"COALESCE(SUM(1 - metered),0) FROM requests {where}", args).fetchone()
                models = db.execute(
                    "SELECT model, provider, host, COUNT(*), COALESCE(SUM(1 - metered),0), "
                    "SUM(input_tokens), SUM(output_tokens), SUM(cached_input_tokens) "
                    f"FROM requests {where} GROUP BY model, provider, host "
                    "ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC, COUNT(*) DESC, model "
                    f"LIMIT {_MAX_BY_MODEL}", args).fetchall()
                by_day = db.execute(
                    "SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day, "
                    "SUM(input_tokens), SUM(output_tokens), SUM(cached_input_tokens), COUNT(*) "
                    f"FROM requests {where} GROUP BY day", args).fetchall()
            else:
                total, models, by_day = (0, 0, 0, 0, 0), [], []
    except Exception as exc:
        _fail(exc)
        return empty_report(range_name, now=stamp, error=_last_error)
    report["totals"] = {"input_tokens": int(total[0]), "output_tokens": int(total[1]),
                        "cached_input_tokens": int(total[2]), "requests": int(total[3]),
                        "unmetered_requests": int(total[4])}
    report["by_model"] = [
        {"model": str(model), "provider": str(provider), "host": str(host),
         "requests": int(requests), "unmetered_requests": int(unmetered),
         "input_tokens": int(inp or 0), "output_tokens": int(out or 0),
         "cached_input_tokens": int(cached or 0)}
        for model, provider, host, requests, unmetered, inp, out, cached in models]
    for day, inp, out, cached, requests in by_day:
        if isinstance(day, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            days[day] = {"date": day, "input_tokens": int(inp or 0), "output_tokens": int(out or 0),
                         "cached_input_tokens": int(cached or 0), "requests": int(requests)}
    if first_day is None:
        known = sorted(days)
        first_day = _dt.date.fromisoformat(known[0]) if known else today
    first_day = max(first_day, today - _dt.timedelta(days=RETENTION_DAYS))
    last_day = today
    if days:
        last_day = max(today, min(_dt.date.fromisoformat(max(days)), today + _dt.timedelta(days=2)))
    span = []
    cursor = first_day
    while cursor <= last_day:
        key = cursor.isoformat()
        span.append(days.get(key) or {"date": key, "input_tokens": 0, "output_tokens": 0,
                                      "cached_input_tokens": 0, "requests": 0})
        cursor += _dt.timedelta(days=1)
    report["by_day"] = span
    return report


def _n(value: int) -> str:
    return f"{int(value):,}"


def format_report(report: dict) -> str:
    """Markdown for the terminal: the same aggregates the editor's Token Usage tab shows."""
    range_name = str(report.get("range") or "7d")
    totals = report.get("totals") or {}
    lines = [f"## Token usage · {RANGE_LABELS.get(range_name, range_name)}", ""]
    if report.get("error"):
        lines += [f"The usage ledger could not be read: {report['error']}", ""]
    lines.append("Counted on this machine from what each provider reports. Nothing here is sent "
                 f"anywhere. Days follow local time ({report.get('timezone') or 'local time'}).")
    lines.append("")
    if not totals.get("requests"):
        lines += ["No model requests counted in this range yet. Every request DGC finishes — "
                  "chats, goals, sub-agents, fallbacks and compaction — adds its input, output and "
                  "cached tokens here, by model and by day.", "",
                  "Turns delegated to a subscription CLI (Claude Code, Codex, …) are counted by "
                  "that CLI, not here.", "",
                  "Other ranges: `/usage today|7d|30d|month|all`"]
        return "\n".join(lines)
    lines += ["| | |", "| --- | ---: |",
              f"| Input tokens | {_n(totals.get('input_tokens', 0))} |",
              f"| Output tokens | {_n(totals.get('output_tokens', 0))} |",
              f"| Cached input tokens | {_n(totals.get('cached_input_tokens', 0))} |",
              f"| Requests | {_n(totals.get('requests', 0))} |"]
    if totals.get("unmetered_requests"):
        lines.append(f"| Unmetered requests | {_n(totals['unmetered_requests'])} |")
    lines.append("")
    if totals.get("unmetered_requests"):
        lines += [f"{_n(totals['unmetered_requests'])} request(s) ended without a usage report "
                  "(cancelled, interrupted, or the provider sent none), so their tokens are not "
                  "in these totals.", ""]
    lines += ["### By model", "",
              "| Model | Provider · host | Requests | Input | Output | Cached |",
              "| --- | --- | ---: | ---: | ---: | ---: |"]
    for row in report.get("by_model") or []:
        where = " · ".join(part for part in (row.get("provider"), row.get("host")) if part)
        model = str(row.get("model") or "").replace("|", "\\|")
        lines.append(f"| {model} | {where.replace('|', '/')} | {_n(row.get('requests', 0))} | "
                     f"{_n(row.get('input_tokens', 0))} | {_n(row.get('output_tokens', 0))} | "
                     f"{_n(row.get('cached_input_tokens', 0))} |")
    active = [day for day in report.get("by_day") or [] if day.get("requests")]
    lines += ["", "### By day", "", "| Day | Input | Output | Cached | Requests |",
              "| --- | ---: | ---: | ---: | ---: |"]
    for day in active[-62:]:
        lines.append(f"| {day['date']} | {_n(day['input_tokens'])} | {_n(day['output_tokens'])} | "
                     f"{_n(day['cached_input_tokens'])} | {_n(day['requests'])} |")
    if len(active) > 62:
        lines.append(f"\n{len(active) - 62} earlier active day(s) are in `dgc usage --json`.")
    quiet = len(report.get("by_day") or []) - len(active)
    if quiet > 0:
        lines.append(f"\n{quiet} day(s) in this range had no requests.")
    return "\n".join(lines)


def _reset_for_tests() -> None:
    """Drop the cached connection (tests relocate the ledger between cases)."""
    global _db, _db_key, _last_prune, _last_error, _warned
    with _lock:
        if _db is not None:
            try:
                _db.close()
            except sqlite3.Error:
                pass
        _db = _db_key = None
        _last_prune = 0.0
        _last_error = ""
        _warned = False
