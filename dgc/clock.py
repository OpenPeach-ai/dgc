"""What time it is, for the model.

Two facts with two lifetimes, so they travel separately.

The calendar date and the machine's timezone change at most once a day (and on a DST shift).
They belong in the system prompt, whose whole value is that it is byte-identical between the
follow-up turns a provider or a local runtime caches a prefix for.

The clock — the hour and minute — changes every minute. Putting it in the system prompt would
invalidate that cache on every turn, so it rides with the user's own message instead, where
nothing was cacheable anyway. ``attach_turn_clock`` adds it and ``strip_turn_clock`` takes it
back off for anything a human reads.

Nothing here raises, blocks on a network, or asks anyone: a machine with no timezone
information still gets a truthful line ("UTC").

Every ``now`` argument is a moment in the machine's own zone — naive local time (what
``datetime.now()`` returns) or an aware datetime carrying the local offset. The zone these
functions name is the machine's, not one read out of the argument.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone

# The frame is what lets a saved transcript tell DGC's clock line from the user's own words, so
# a restored chat shows what was typed and never re-sends an old clock as if it were now.
CLOCK_OPEN = "<dgc-now>"
CLOCK_CLOSE = "</dgc-now>"

_CLOCK_RE = re.compile(r"\n*" + re.escape(CLOCK_OPEN) + r"[^\n<>]{0,160}"
                       + re.escape(CLOCK_CLOSE) + r"\s*\Z")
# An IANA zone is Area/Location, sometimes Area/Region/Location. Anything else (a POSIX rule such
# as "IST-5:30", an abbreviation, a stray path) is not a name we are willing to show the model.
_IANA_RE = re.compile(r"[A-Za-z][A-Za-z0-9_+-]{0,31}(?:/[A-Za-z0-9_+.-]{1,31}){1,2}")


def _aware(now: datetime | None) -> datetime:
    """A datetime that knows its own offset, whatever was handed in."""
    try:
        if now is None:
            now = datetime.now()
        if now.tzinfo is None or now.utcoffset() is None:
            now = now.astimezone()          # a naive datetime is local time, by definition
        return now
    except Exception:
        return datetime.now(timezone.utc)


def _iana_from_env() -> str:
    """The TZ variable, when it holds an IANA name rather than a POSIX rule."""
    try:
        value = (os.environ.get("TZ") or "").strip()
    except Exception:
        return ""
    if value.startswith(":"):
        value = value[1:]
    if value == "UTC":
        return "UTC"
    return value if _IANA_RE.fullmatch(value) else ""


def _iana_from_localtime() -> str:
    """The /etc/localtime symlink, which is how Linux and macOS record the zone by name."""
    try:
        path = os.path.realpath("/etc/localtime")
    except Exception:
        return ""
    marker = "/zoneinfo/"
    index = path.find(marker)
    if index < 0:
        return ""                           # not a symlink into the zone database
    name = path[index + len(marker):]
    for prefix in ("posix/", "right/"):     # alternate trees hold the same names
        if name.startswith(prefix):
            name = name[len(prefix):]
    return name if _IANA_RE.fullmatch(name) else ""


def _iana_zone() -> str:
    """The machine's IANA zone name, or "" when this platform does not record one."""
    try:
        return _iana_from_env() or _iana_from_localtime()
    except Exception:
        return ""


def offset_label(now: datetime | None = None) -> str:
    """``UTC+05:30``, ``UTC-08:00``, or ``UTC`` on the prime meridian."""
    try:
        offset = _aware(now).utcoffset()
        seconds = int(offset.total_seconds()) if offset is not None else 0
    except Exception:
        seconds = 0
    if not seconds:
        return "UTC"
    sign = "+" if seconds > 0 else "-"
    seconds = abs(seconds)
    return f"UTC{sign}{seconds // 3600:02d}:{seconds % 3600 // 60:02d}"


def zone_name(now: datetime | None = None) -> str:
    """The shortest honest name for the zone: IANA when the machine records one, else the offset."""
    return _iana_zone() or offset_label(now)


def zone_label(now: datetime | None = None) -> str:
    """The long form for the system prompt: ``Asia/Kolkata, UTC+05:30``, or just the offset."""
    name, offset = _iana_zone(), offset_label(now)
    return f"{name}, {offset}" if name and name != offset else offset


def environment_date(now: datetime | None = None) -> str:
    """``2026-09-20 (Asia/Kolkata, UTC+05:30)`` — the Environment line's date, stable for a day."""
    try:
        day = (now or datetime.now()).strftime("%Y-%m-%d")
    except Exception:
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"{day} ({zone_label(now)})"


def turn_clock_line(now: datetime | None = None) -> str:
    """``<dgc-now>Local time: 14:32 (Asia/Kolkata)</dgc-now>`` — one line, once per turn."""
    try:
        minute = (now or datetime.now()).strftime("%H:%M")
    except Exception:
        minute = datetime.now(timezone.utc).strftime("%H:%M")
    return f"{CLOCK_OPEN}Local time: {minute} ({zone_name(now)}){CLOCK_CLOSE}"


def strip_turn_clock(text):
    """Remove a clock line DGC appended. A ``<dgc-now>`` the user typed mid-message stays."""
    if not isinstance(text, str) or CLOCK_OPEN not in text:
        return text
    return _CLOCK_RE.sub("", text)


def attach_turn_clock(text, now: datetime | None = None) -> str:
    """Append this turn's clock to the user's prompt, replacing one that is already there."""
    body = strip_turn_clock(text if isinstance(text, str) else str(text or ""))
    line = turn_clock_line(now)
    return f"{body}\n\n{line}" if body.strip() else line
