"""How much of a plan's usage limits is used, as each connection reports it: the usage meter's numbers (0.52).

The usage meter sits on the prompt box in Work, ChatDGC and a Pip's chat, and shows only what a connection itself
reports. Three report here:

- ``chatgpt_plan`` (ChatGPT · your plan, dgc.chatgpt_plan): the x-codex-* usage headers, or a ``codex.rate_limits``
  stream event, when the API sends them; and the plan's own refusal when its limit is used up (kept until a request
  goes through again).
- ``codex`` (the Codex CLI): its session record's ``token_count`` events carry ``rate_limits``; DGC reads the record
  of the turn it ran (by the thread id the turn named) after the turn. The record is Codex's: only ever read.
- ``claude`` (Claude Code): its ``rate_limit_event`` in stream-json, as it comes.

OpenRouter's key limit is the editor's own read (GET /api/v1/key, with the key it already holds). Every other
connection reports nothing, and has no meter.

A window is ``{id, used_percent (0-100), window_minutes, resets_at (epoch seconds)}``; ``window_minutes`` and
``resets_at`` may be None. What was reported is kept in one small file in DGC's home, so every DGC process reads the
latest: Work's and ChatDGC's backend, and a Pip's runner (another process). Nothing here raises: a store that can't
be read or written only means the meter has nothing to show.
"""
from __future__ import annotations

import json
import math
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

SOURCES = ("chatgpt_plan", "codex", "claude")
FILE_NAME = "usage-limits.json"
MAX_FILE_BYTES = 64 * 1024
MAX_WINDOWS = 6
KEEP_S = 8 * 86400               # a report older than this (a plan's longest window and a day) is not shown
_SAME_WRITE_S = 60               # the same report again within this is not written again
_CLAUDE_WINDOWS = {"five_hour": 300, "seven_day": 10080, "seven_day_opus": 10080, "seven_day_sonnet": 10080,
                   "seven_day_overage_included": 10080}
_lock = threading.Lock()
_listeners: list[Callable[[list[dict]], None]] = []
_last: dict = {}                 # this process's last write per source (what a listener last heard)


def _reset_for_tests() -> None:
    with _lock:
        _last.clear()


def _number(value) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _whole(value, top: int = 10**12) -> int | None:
    number = _number(value)
    if number is None or number < 0 or number > top:
        return None
    return int(number)


def window(id: str, used_percent, window_minutes=None, resets_at=None) -> dict | None:
    """One window, checked: its id, the share used (kept between 0 and 100), its length and when it resets."""
    used = _number(used_percent)
    if used is None or not isinstance(id, str) or not re.fullmatch(r"[a-z0-9_]{1,40}", id):
        return None
    minutes = _whole(window_minutes)
    return {"id": id, "used_percent": round(min(100.0, max(0.0, used)), 2),
            "window_minutes": minutes if minutes else None, "resets_at": _whole(resets_at) or None}


def from_headers(headers, family: str = "codex") -> list[dict]:
    """The windows in a response's usage headers (x-codex-primary-used-percent, -window-minutes, -reset-at, and the
    secondary's), as the Codex CLI reads them; a zero with no window and no reset is no data."""
    if not headers:
        return []
    try:
        lower = {str(name).lower(): str(value) for name, value in dict(headers).items()}
    except (TypeError, ValueError):
        return []
    out = []
    for slot in ("primary", "secondary"):
        prefix = f"x-{family}-{slot}"
        used = _number(lower.get(f"{prefix}-used-percent"))
        if used is None:
            continue
        minutes, resets = _whole(lower.get(f"{prefix}-window-minutes")), _whole(lower.get(f"{prefix}-reset-at"))
        if used == 0 and not minutes and resets is None:
            continue
        found = window(slot, used, minutes, resets)
        if found:
            out.append(found)
    return out


def from_rate_limits(obj) -> list[dict]:
    """The windows in a ``rate_limits`` object: a Codex session record's token_count (``resets_at``), or the
    ``codex.rate_limits`` stream event (``reset_at``; an older one says ``resets_in_seconds``)."""
    if not isinstance(obj, dict):
        return []
    out = []
    for slot in ("primary", "secondary"):
        row = obj.get(slot)
        if not isinstance(row, dict):
            continue
        resets = row.get("resets_at", row.get("reset_at"))
        if resets is None and _number(row.get("resets_in_seconds")) is not None:
            resets = time.time() + float(row["resets_in_seconds"])
        found = window(slot, row.get("used_percent"), row.get("window_minutes"), resets)
        if found:
            out.append(found)
    return out


def from_claude(info) -> list[dict]:
    """The windows in Claude Code's rate_limit_info: each of its unified windows (utilization 0-1), else the one it
    names; a window it refused with no number is used up."""
    if not isinstance(info, dict):
        return []
    out = []
    unified = info.get("unifiedWindows")
    if isinstance(unified, dict):
        for name, row in unified.items():
            if name in _CLAUDE_WINDOWS and isinstance(row, dict):
                share = _number(row.get("utilization"))
                found = window(name, share * 100 if share is not None else None, _CLAUDE_WINDOWS[name], row.get("resetsAt"))
                if found:
                    out.append(found)
    if not out:
        name = info.get("rateLimitType")
        share = _number(info.get("utilization"))
        if name in _CLAUDE_WINDOWS and (share is not None or info.get("status") == "rejected"):
            found = window(name, share * 100 if share is not None else 100.0, _CLAUDE_WINDOWS[name], info.get("resetsAt"))
            if found:
                out.append(found)
    return out[:MAX_WINDOWS]


def resets_words(resets_at, *, now: float | None = None) -> str:
    """When a window resets, for a sentence: "at 14:05", or "on 21 Nov at 09:00" when that isn't today (this
    computer's clock); "" when it isn't known or has passed."""
    at = _whole(resets_at)
    clock = time.time() if now is None else now
    if not at or at <= clock:
        return ""
    then, today = time.localtime(at), time.localtime(clock)
    hour = time.strftime("%H:%M", then)
    if (then.tm_year, then.tm_yday) == (today.tm_year, today.tm_yday):
        return f"at {hour}"
    return f"on {then.tm_mday} {time.strftime('%b', then)} at {hour}"


# ---- the shared file ----------------------------------------------------------------------------------------------

def _path() -> Path:
    from .config import dgc_home
    return Path(dgc_home()) / FILE_NAME


def _load() -> dict:
    try:
        path = _path()
        if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return {}
    sources = data.get("sources") if isinstance(data, dict) else None
    out = {}
    for source, row in (sources.items() if isinstance(sources, dict) else []):
        if source in SOURCES and isinstance(row, dict):
            windows = [w for w in (window(r.get("id"), r.get("used_percent"), r.get("window_minutes"), r.get("resets_at"))
                                   for r in row.get("windows", []) if isinstance(r, dict)) if w][:MAX_WINDOWS]
            out[source] = {"windows": windows, "at": _whole(row.get("at"), 10**15) or 0,
                           "limited": row.get("limited") is True}
    return out


def _save(sources: dict) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".usage-limits-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"version": 1, "sources": sources}, stream, separators=(",", ":"))
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _shown(sources: dict, now: float) -> list[dict]:
    rows = []
    for source in SOURCES:
        row = sources.get(source)
        if not row or now * 1000 - row["at"] > KEEP_S * 1000:
            continue
        windows = []
        for w in row["windows"]:
            if w["resets_at"] and w["resets_at"] <= now:
                w = {**w, "used_percent": 0.0, "resets_at": None}       # it reset; the next report says when again
            windows.append(w)
        if not windows and not row["limited"]:
            continue
        rows.append({"source": source, "windows": windows, "at": row["at"], "limited": row["limited"]})
    return rows


def snapshot(*, now: float | None = None) -> list[dict]:
    """What every source last reported, newest file first: [{source, windows, at (epoch ms), limited}]."""
    return _shown(_load(), time.time() if now is None else now)


def record(source: str, windows=None, *, limited: bool | None = None, now: float | None = None) -> dict | None:
    """Keep what a source just reported. ``windows`` None keeps the windows it had; ``limited`` None keeps whether its
    limit was reached (True when a window is used up). Returns the kept row, or None when nothing was kept."""
    if source not in SOURCES:
        return None
    if windows is not None:
        if not isinstance(windows, (list, tuple)) or not all(isinstance(w, dict) for w in windows):
            return None
        windows = [w for w in (window(r.get("id"), r.get("used_percent"), r.get("window_minutes"), r.get("resets_at"))
                               for r in windows) if w][:MAX_WINDOWS]
    clock = time.time() if now is None else now
    heard = None
    with _lock:
        try:
            sources = _load()
            before = sources.get(source) or {"windows": [], "at": 0, "limited": False}
            kept_windows = before["windows"] if windows is None else windows
            # Said outright (a refusal, a request that went through) wins; else new windows say it; else as it was.
            reached = (bool(limited) if limited is not None
                       else any(w["used_percent"] >= 100 for w in kept_windows) if windows is not None
                       else before["limited"])
            row = {"windows": kept_windows, "at": int(clock * 1000), "limited": reached}
            same = (before["windows"] == row["windows"] and before["limited"] == row["limited"])
            if same and clock * 1000 - before["at"] < _SAME_WRITE_S * 1000:
                return row
            if same and not row["windows"] and not row["limited"] and source not in sources:
                return row                      # (nothing reported, nothing kept: no file for it)
            sources[source] = row
            _save(sources)
            if _last.get(source) != (row["windows"], row["limited"]):
                _last[source] = (row["windows"], row["limited"])
                heard = _shown(sources, clock)
        except OSError:
            return None
        listeners = list(_listeners)
    if heard is not None:
        for listener in listeners:
            try:
                listener(heard)
            except Exception:                    # noqa: BLE001 -- a listener never costs the request
                pass
    return row


def listen(fn: Callable[[list[dict]], None]) -> Callable[[], None]:
    """Hear every change this process records (the backend says it to the editor at once); returns the way to stop."""
    with _lock:
        _listeners.append(fn)

    def stop() -> None:
        with _lock:
            if fn in _listeners:
                _listeners.remove(fn)
    return stop


# ---- Codex's session record ---------------------------------------------------------------------------------------

_THREAD = re.compile(r"[0-9a-fA-F][0-9a-fA-F-]{7,63}")
_TAIL_BYTES = 512 * 1024


def codex_session_limits(thread_id: str, *, codex_home: Path | None = None) -> list[dict]:
    """The usage windows in the last token_count of the Codex session ``thread_id`` (its record under
    ``$CODEX_HOME/sessions``, newest folders first); [] when there is none. Only the record's end is read."""
    if not isinstance(thread_id, str) or not _THREAD.fullmatch(thread_id):
        return []
    root = Path(codex_home) if codex_home else Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    sessions = root / "sessions"
    try:
        if not sessions.is_dir():
            return []
        found = None
        for year in sorted((p for p in sessions.iterdir() if p.is_dir()), reverse=True)[:2]:
            for month in sorted((p for p in year.iterdir() if p.is_dir()), reverse=True)[:2]:
                for day in sorted((p for p in month.iterdir() if p.is_dir()), reverse=True)[:7]:
                    hits = [p for p in day.glob(f"rollout-*-{thread_id}.jsonl") if p.is_file()]
                    if hits:
                        found = hits[0]
                        break
                if found:
                    break
            if found:
                break
        if found is None:
            return []
        with open(found, "rb") as stream:
            size = stream.seek(0, os.SEEK_END)
            stream.seek(max(0, size - _TAIL_BYTES))
            lines = stream.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return []
    for line in reversed(lines):
        if '"token_count"' not in line or '"rate_limits"' not in line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        payload = obj.get("payload") if isinstance(obj, dict) else None
        if isinstance(payload, dict) and payload.get("type") == "token_count":
            windows = from_rate_limits(payload.get("rate_limits"))
            if windows:
                return windows
    return []
