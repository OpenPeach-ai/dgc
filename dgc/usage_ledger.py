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
* never any prompt, response, tool output, file path, session name or key;
* since 0.51, the DGC Router system that sent the request (``system_id``, NULL before and for requests no
  system sent), so a system whose address changes keeps its history (dgc/usage_systems.py names each row's
  system; an older row is matched by its address).

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
SOURCES = ("main", "subagent", "fallback", "compaction", "pip", "chatdgc", "other")
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
_BUSY_TIMEOUT_MS = 2_000          # reads, and a first write that has to wait for another process
_WRITE_BACKOFF_MS = 50            # writes while a lock recently timed out (see record)
_WRITE_BACKOFF_S = 60.0
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
_locked_until = 0.0               # monotonic time until which writes wait only _WRITE_BACKOFF_MS
_CORRUPT_RE = re.compile(r"not a database|malformed|corrupt", re.I)


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
                _add_system_column(db)
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


def _add_system_column(db: sqlite3.Connection) -> None:
    """Give a ledger from before 0.51 its nullable ``system_id`` column. An older DGC still writes to it: it names
    its columns, so its rows get NULL. Two processes adding it at once: the second finds it there."""
    columns = {row[1] for row in db.execute("PRAGMA table_info(requests)")}
    if "system_id" in columns:
        return
    try:
        db.execute("ALTER TABLE requests ADD COLUMN system_id TEXT")
    except sqlite3.OperationalError as exc:
        if "duplicate column" not in str(exc).lower():
            raise


def _prune(db: sqlite3.Connection, now: float) -> None:
    global _last_prune
    if _last_prune and now - _last_prune < _PRUNE_EVERY_S:
        return
    _last_prune = now
    # Never prune relative to a moment later than this machine's clock: a row stamped in the
    # future must not delete a year of real history.
    cutoff = int(min(now, time.time())) - RETENTION_DAYS * 86_400
    db.execute("DELETE FROM requests WHERE ts < ?", (cutoff,))


def _set_aside(path: Path, exc: BaseException) -> bool:
    """Move a corrupt ledger (and its -wal/-shm) aside so counting can start again.

    Nothing is deleted: the damaged file stays next to the new one for anyone who wants it.
    Returns False when ``exc`` is not corruption or the file could not be moved.
    """
    global _db, _db_key
    if not _CORRUPT_RE.search(str(exc)) or not path.is_file():
        return False
    if _db is not None:
        try:
            _db.close()
        except sqlite3.Error:
            pass
    _db = _db_key = None
    target = path.with_name(f"{path.name}.corrupt-{int(time.time())}")
    try:
        for suffix in ("-wal", "-shm"):
            companion = path.with_name(path.name + suffix)
            if companion.exists():
                os.replace(companion, target.with_name(target.name + suffix))
        os.replace(path, target)
    except OSError:
        return False
    try:
        if not sys.stderr.isatty():
            sys.stderr.write(f"[dgc] token usage ledger was corrupt ({exc}); moved it to {target} "
                             "and started a new one\n")
            sys.stderr.flush()
    except Exception:
        pass
    return True


def record(*, provider, base_url, model, source="main", input_tokens=0, output_tokens=0,
           cached_input_tokens=0, metered: bool | None = None, system_id=None,
           now: float | None = None, path: Path | None = None) -> bool:
    """Append one finished request. Returns False (and never raises) when it could not be kept.

    ``system_id`` is the DGC Router system the request went to (its id, never its address), or None."""
    global _last_error, _locked_until
    from .usage_systems import clean_system_id
    stamp = time.time() if now is None else float(now)
    source = source if source in SOURCES else "other"
    row = (int(stamp), _text(provider, _MAX_TEXT["provider"]) or "unknown",
           endpoint_host(base_url), _text(model, _MAX_TEXT["model"]) or "unknown", source,
           _count(input_tokens), _count(output_tokens), _count(cached_input_tokens))
    metered = int(metered) if isinstance(metered, bool) else (1 if (row[5] or row[6]) else 0)
    system_id = clean_system_id(system_id)
    target = Path(path) if path is not None else ledger_path()
    try:
        with _lock:
            for attempt in range(2):
                try:
                    db = _open(target, create=True)
                    # Writes run on the request's own thread. While another process has recently
                    # held the ledger past the timeout, wait only briefly, so a stuck writer
                    # elsewhere cannot add seconds to every model request here.
                    waiting = time.monotonic() < _locked_until
                    db.execute(f"PRAGMA busy_timeout={_WRITE_BACKOFF_MS if waiting else _BUSY_TIMEOUT_MS}")
                    _prune(db, stamp)
                    db.execute(
                        "INSERT INTO requests(ts, provider, host, model, source, input_tokens, "
                        "output_tokens, cached_input_tokens, metered, system_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (*row, metered, system_id))
                    break
                except sqlite3.DatabaseError as exc:
                    if re.search(r"locked|busy", str(exc), re.I):
                        _locked_until = time.monotonic() + _WRITE_BACKOFF_S
                        raise
                    if attempt == 0 and _set_aside(target, exc):
                        continue
                    raise
        _locked_until = 0.0
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


def range_days(range_name: str, stamp: float) -> tuple[_dt.date, _dt.date | None]:
    """(today, the range's first local day) -- None for all time. Shared with the Pips tab, so
    both cut the same days."""
    today = _dt.date.fromtimestamp(stamp)
    return today, {"today": today, "7d": today - _dt.timedelta(days=6),
                   "30d": today - _dt.timedelta(days=29),
                   "month": today.replace(day=1), "all": None}[range_name]


_GROUP_COLUMNS = ("model, provider, host, system_id, COUNT(*), COALESCE(SUM(1 - metered),0), SUM(input_tokens), "
                  "SUM(output_tokens), SUM(cached_input_tokens)")


def _classifier(systems):
    from .usage_systems import Classifier, router_systems
    return Classifier(router_systems() if systems is None else systems)


def _model_rows(groups, classifier) -> list[dict]:
    """GROUP BY rows (model, provider, host, system_id, ...) as by-model rows, each with the system it ran on.
    Groups that land on the same model, provider, host and system (an older row without a stored id beside a
    newer one with it) are one row."""
    merged: dict[tuple, dict] = {}
    for model, provider, host, system_id, requests, unmetered, inp, out, cached in groups:
        where = classifier.classify(model, provider, host, system_id)
        key = (str(model), str(provider), str(host), where["system_id"])
        row = merged.get(key)
        if row is None:
            row = merged[key] = {"model": str(model), "provider": str(provider), "host": str(host),
                                 "requests": 0, "unmetered_requests": 0, "input_tokens": 0, "output_tokens": 0,
                                 "cached_input_tokens": 0, **where}
        row["requests"] += int(requests or 0)
        row["unmetered_requests"] += int(unmetered or 0)
        row["input_tokens"] += int(inp or 0)
        row["output_tokens"] += int(out or 0)
        row["cached_input_tokens"] += int(cached or 0)
    return sorted(merged.values(), key=lambda r: (-(r["input_tokens"] + r["output_tokens"]), -r["requests"],
                                                  r["model"], r["provider"], r["host"], r["system_id"]))


def _wanted(rows, system) -> str:
    """The system id a filter names among ``rows`` (an id, else a name in any case), or the text itself."""
    from .usage_systems import pick
    text = str(system or "").strip()
    return pick(rows, text) or text


def by_model_for_source(source: str, range_name: str = "7d", *, now: float | None = None,
                        path: Path | None = None, system: str | None = None, systems=None) -> list[dict]:
    """One source's requests in a range by model (provider + host), most tokens first: the Pips
    tab's "By model" (source "pip"). The same day boundaries as report(); [] when unreadable.
    Each row names its system (dgc/usage_systems.py); ``system`` keeps one system's rows only."""
    range_name = normalize_range(range_name)
    stamp = time.time() if now is None else float(now)
    today, first_day = range_days(range_name, stamp)
    where, args = "WHERE source = ?", (str(source),)
    if first_day:
        where += " AND ts >= ? AND ts < ?"
        args += (_local_midnight(first_day), _local_midnight(today + _dt.timedelta(days=1)))
    try:
        with _lock:
            db = _open(Path(path) if path is not None else ledger_path(), create=False)
            if db is None:
                return []
            db.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
            groups = db.execute(f"SELECT {_GROUP_COLUMNS} FROM requests {where} "
                                "GROUP BY model, provider, host, system_id", args).fetchall()
        rows = _model_rows(groups, _classifier(systems))
    except Exception:
        return []
    if str(system or "").strip():
        wanted = _wanted(rows, system)
        from .usage_systems import matches
        rows = [row for row in rows if matches(row, wanted)]
    return rows[:_MAX_BY_MODEL]


def report(range_name: str = "7d", *, now: float | None = None, path: Path | None = None,
           system: str | None = None, systems=None) -> dict:
    """Aggregate one range: totals, by model (provider + host), and every local day in it.

    Day boundaries are this machine's local midnights, so "today" and each bar in a day strip
    match the user's clock. A range with no data still lists its days, with zeros.

    Every by-model row names the system it ran on (``system``, ``system_id``, ``system_kind``; see
    dgc/usage_systems.py). ``system`` (an id, or a name in any case) keeps that system's requests only: the
    totals, the days and the models. ``systems`` is the Router's systems to name rows by (default: the
    user's config.json).
    """
    pip_error = ""
    if path is None:
        from .pip_usage import sync_completed
        pip_error = sync_completed()
    range_name = normalize_range(range_name)
    stamp = time.time() if now is None else float(now)
    report = empty_report(range_name, now=stamp)
    today, first_day = range_days(range_name, stamp)
    # A bounded range ends at the next local midnight, so a row stamped in the future (a clock
    # that was wrong for a while) is not counted as today.
    where, args = (("WHERE ts >= ? AND ts < ?",
                    (_local_midnight(first_day), _local_midnight(today + _dt.timedelta(days=1))))
                   if first_day else ("", ()))
    filtered = bool(str(system or "").strip())
    days: dict[str, dict] = {}
    day_groups: list = []
    try:
        with _lock:
            db = _open(Path(path) if path is not None else ledger_path(), create=False)
            if db is not None:
                db.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")   # a write may have shortened it
                # All three views must describe the same point in time, even while another
                # editor process records requests through its own SQLite connection.
                db.execute("BEGIN")
                try:
                    groups = db.execute(f"SELECT {_GROUP_COLUMNS} FROM requests {where} "
                                        "GROUP BY model, provider, host, system_id", args).fetchall()
                    if filtered:
                        total = None
                        by_day = []
                        day_groups = db.execute(
                            "SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day, model, provider, host, "
                            "system_id, SUM(input_tokens), SUM(output_tokens), SUM(cached_input_tokens), COUNT(*) "
                            f"FROM requests {where} GROUP BY day, model, provider, host, system_id", args).fetchall()
                    else:
                        total = db.execute(
                            "SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), "
                            "COALESCE(SUM(cached_input_tokens),0), COUNT(*), "
                            f"COALESCE(SUM(1 - metered),0) FROM requests {where}", args).fetchone()
                        by_day = db.execute(
                            "SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day, "
                            "SUM(input_tokens), SUM(output_tokens), SUM(cached_input_tokens), COUNT(*) "
                            f"FROM requests {where} GROUP BY day", args).fetchall()
                finally:
                    db.execute("ROLLBACK")
            else:
                groups, total, by_day = [], (0, 0, 0, 0, 0), []
        classifier = _classifier(systems)
        models = _model_rows(groups, classifier)
    except Exception as exc:
        _fail(exc)
        return empty_report(range_name, now=stamp, error=_last_error)
    if pip_error:
        report["error"] = pip_error
    if filtered:
        from .usage_systems import matches
        wanted = _wanted(models, system)
        models = [row for row in models if matches(row, wanted)]
        total = (sum(r["input_tokens"] for r in models), sum(r["output_tokens"] for r in models),
                 sum(r["cached_input_tokens"] for r in models), sum(r["requests"] for r in models),
                 sum(r["unmetered_requests"] for r in models))
        summed: dict[str, list[int]] = {}
        for day, model, provider, host, system_id, inp, out, cached, requests in day_groups:
            if not matches(classifier.classify(model, provider, host, system_id), wanted):
                continue
            entry = summed.setdefault(day, [0, 0, 0, 0])
            entry[0] += int(inp or 0)
            entry[1] += int(out or 0)
            entry[2] += int(cached or 0)
            entry[3] += int(requests or 0)
        by_day = [(day, *values) for day, values in summed.items()]
    report["totals"] = {"input_tokens": int(total[0]), "output_tokens": int(total[1]),
                        "cached_input_tokens": int(total[2]), "requests": int(total[3]),
                        "unmetered_requests": int(total[4])}
    report["by_model"] = models[:_MAX_BY_MODEL]
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


def systems_in(range_name: str = "7d", *, now: float | None = None, path: Path | None = None,
               systems=None, source: str | None = None) -> list[dict]:
    """Every system with requests in a range (all of them, not the by-model top 100), most tokens first:
    `dgc usage`'s "By system" block and the names `--system` takes. ``source`` keeps one source ("pip")."""
    from .usage_systems import by_system
    range_name = normalize_range(range_name)
    stamp = time.time() if now is None else float(now)
    today, first_day = range_days(range_name, stamp)
    clauses, args = [], []
    if source:
        clauses.append("source = ?")
        args.append(str(source))
    if first_day:
        clauses.append("ts >= ? AND ts < ?")
        args += [_local_midnight(first_day), _local_midnight(today + _dt.timedelta(days=1))]
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    try:
        with _lock:
            db = _open(Path(path) if path is not None else ledger_path(), create=False)
            if db is None:
                return []
            db.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
            groups = db.execute(f"SELECT {_GROUP_COLUMNS} FROM requests {where} "
                                "GROUP BY model, provider, host, system_id", tuple(args)).fetchall()
        return by_system(_model_rows(groups, _classifier(systems)))
    except Exception:
        return []


def _n(value: int) -> str:
    return f"{int(value):,}"


def _share(part: int, whole: int) -> str:
    if whole <= 0:
        return "0%"
    percent = part / whole * 100
    return "<1%" if 0 < percent < 1 else f"{round(percent)}%"


def format_report(report: dict, *, shell: bool = False, system: str = "",
                  by_system: list[dict] | None = None) -> str:
    """Markdown for the terminal: the same aggregates the editor's Token Usage tab shows.

    ``shell`` is `dgc usage` run from a shell, where a hint must name that command's own flag
    rather than the `/usage` slash command only the interactive UIs understand. ``system`` is the
    name of the one system the report was filtered to. ``by_system`` (systems_in) is every system
    of the range: with more than one, a "By system" block comes first and each model row names its
    system instead of its address (`--json` keeps the address).
    """
    from .usage_systems import by_system as sum_by_system
    range_name = str(report.get("range") or "7d")
    totals = report.get("totals") or {}
    title = f"## Token usage · {RANGE_LABELS.get(range_name, range_name)}"
    lines = [title + (f" · {system}" if system else ""), ""]
    if report.get("error"):
        lines += [f"The usage ledger could not be read: {report['error']}", ""]
    lines.append("Counted on this machine from what each provider reports. Nothing here is sent "
                 f"anywhere. Days follow local time ({report.get('timezone') or 'local time'}).")
    lines.append("")
    command = "dgc usage --range" if shell else "/usage"
    if not totals.get("requests"):
        if system:
            lines += [f"No model requests counted on {system} in this range.", ""]
            if range_name != "all":
                lines += [f"Try `{command} all` to see earlier requests.", ""]
            return "\n".join(lines)
        lines += ["No model requests counted in this range yet. Each request DGC finishes (chats, "
                  "goals, sub-agents, fallbacks, compaction) will appear here with the input, "
                  "output and cached tokens its provider reported, totalled by model and by day.",
                  "",
                  "Turns delegated to a subscription CLI (Claude Code, Codex, …) are counted by "
                  "that CLI, not here.", ""]
        if range_name != "all":
            lines += [f"Try `{command} all` to see earlier requests.", ""]
        lines.append(f"Other ranges: `{command} today|7d|30d|month|all`")
        return "\n".join(lines)
    lines += ["| Total | Count |", "| --- | ---: |",
              f"| Input tokens | {_n(totals.get('input_tokens', 0))} |",
              f"| Output tokens | {_n(totals.get('output_tokens', 0))} |",
              f"| Cached input tokens | {_n(totals.get('cached_input_tokens', 0))} |",
              f"| Requests | {_n(totals.get('requests', 0))} |"]
    if totals.get("unmetered_requests"):
        lines.append(f"| Unmetered requests | {_n(totals['unmetered_requests'])} |")
    lines.append("")
    unmetered = int(totals.get("unmetered_requests") or 0)
    if unmetered:
        lines += [("1 request ended without a usage report (cancelled, interrupted, or the "
                   "provider sent none), so its tokens are not in these totals.") if unmetered == 1
                  else (f"{_n(unmetered)} requests ended without a usage report (cancelled, "
                        "interrupted, or the provider sent none), so their tokens are not in "
                        "these totals."), ""]
    lines += ["Input counts every prompt token the provider reported, cached ones included; "
              "cached input is the part it served from its cache.", ""]
    systems = by_system if by_system is not None else sum_by_system(report.get("by_model") or [])
    named = len(systems) > 1 or bool(system)
    if len(systems) > 1 and not system:
        whole = sum(int(r.get("input_tokens") or 0) + int(r.get("output_tokens") or 0) for r in systems)
        lines += ["### By system", "",
                  "Each computer DGC Router sends work to, this computer, and each cloud service. An Ollama "
                  "cloud model counts as Ollama Cloud, whichever computer it was sent through.", "",
                  "| System | Requests | Input | Output | Share |",
                  "| --- | ---: | ---: | ---: | ---: |"]
        for row in systems:
            name = str(row.get("system") or "").replace("|", "/")
            requests = _n(row.get("requests", 0))
            if row.get("unmetered_requests"):
                requests += f" ({_n(row['unmetered_requests'])} unmetered)"
            tokens = int(row.get("input_tokens") or 0) + int(row.get("output_tokens") or 0)
            lines.append(f"| {name} | {requests} | {_n(row.get('input_tokens', 0))} | "
                         f"{_n(row.get('output_tokens', 0))} | {_share(tokens, whole)} |")
        flag = "dgc usage --system NAME" if shell else "/usage [range] NAME"
        lines += ["", f"One system alone: `{flag}`.", ""]
    lines += ["### By model", "",
              f"| Model | {'System · provider' if named else 'Provider · host'} | Requests | Input | Output | Cached |",
              "| --- | --- | ---: | ---: | ---: | ---: |"]
    for row in report.get("by_model") or []:
        if named:
            where = " · ".join(part for part in (row.get("system") or row.get("host"), row.get("provider")) if part)
        else:
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
        earlier = len(active) - 62
        lines.append(f"\n{earlier} earlier active day{'' if earlier == 1 else 's'} "
                     f"{'is' if earlier == 1 else 'are'} in `dgc usage --json`.")
    quiet = len(report.get("by_day") or []) - len(active)
    if quiet > 0:
        lines.append(f"\n{quiet} day{'' if quiet == 1 else 's'} in this range had no requests.")
    return "\n".join(lines)


def parse_usage_args(rest) -> tuple[str, str]:
    """`/usage [range] [system]` -> (range, system text). A first word that is a range is the range; the rest,
    or the whole text when it starts with no range, names a system. Raises ValueError for a bad range only when
    nothing is left over to be a system name."""
    text = " ".join(str(rest or "").split())
    if not text:
        return "7d", ""
    first, _, after = text.partition(" ")
    try:
        return normalize_range(first), after.strip()
    except ValueError:
        pass
    try:
        return normalize_range(text), ""
    except ValueError:
        return "7d", text


def system_report(range_name: str = "7d", system: str = "", *, now: float | None = None,
                  path: Path | None = None, systems=None) -> tuple[dict, str, list[dict]]:
    """The terminal's one call: (report, the system's name or "", every system of the range).

    Raises ValueError naming the systems there are when ``system`` names none of them and no Router system."""
    from .usage_systems import router_systems
    configured = router_systems() if systems is None else systems
    found = systems_in(range_name, now=now, path=path, systems=configured)
    text = str(system or "").strip()
    if not text:
        return report(range_name, now=now, path=path, systems=configured), "", found
    match = next((row for row in found if row["system_id"] == text), None) or next(
        (row for row in found if str(row["system"]).lower() == text.lower()), None)
    if match is None:
        router = next((s for s in configured if s["id"] == text.lower() or s["name"].lower() == text.lower()), None)
        if router is None:
            names = ", ".join(row["system"] for row in found) or "none in this range"
            raise ValueError(f"no system called {text}. Systems with usage in this range: {names}")
        return report(range_name, now=now, path=path, systems=configured, system=router["id"]), router["name"], found
    return (report(range_name, now=now, path=path, systems=configured, system=match["system_id"]),
            str(match["system"]), found)


def _reset_for_tests() -> None:
    """Drop the cached connection (tests relocate the ledger between cases)."""
    global _db, _db_key, _last_prune, _last_error, _warned, _locked_until
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
        _locked_until = 0.0
