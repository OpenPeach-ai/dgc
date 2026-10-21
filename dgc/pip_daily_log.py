"""A Personal Pip's daily log: what it did, a few lines a day, written by DGC from its runs, for you to read.

One file a day (``pips/daily-log/<pip>/<YYYY-MM-DD>.md``, in your own clock's days, only you can read them): each
finished run is one line, its time, what it was (a chat reply, a routine by its title, a task) and how it ended (its
reply's first words, Failed and why, Stopped). At most MAX_DAY_LINES lines a day (the rest are counted) and the last
KEEP_DAYS days. The Pip's page shows it (``list_pip_daily_log``, Pips API 57).

It is the user's to read and nothing else: no run of the Pip is ever given it, so what a reply said yesterday
never becomes something a model reads as fact today. Every line is redacted of the credentials DGC holds.
"""
from __future__ import annotations

import contextlib
import os
import re
from datetime import datetime, timedelta
from pathlib import Path

from .workspace_registry import RegistryError

MAX_DAY_LINES = 30
KEEP_DAYS = 30
MAX_SAID = 120                  # characters of what a run said, in its line
MAX_DAYS_PAGE = 14
_PIP = re.compile(r"pip_[0-9a-f]{32}\Z")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
_MORE = re.compile(r"^- … and (\d+) more runs?$")


def _folder(directory, pip_id) -> Path:
    if not isinstance(pip_id, str) or not _PIP.match(pip_id):
        raise RegistryError("invalid_request", "Choose one Pip.")
    return Path(directory) / "daily-log" / pip_id


def _first_words(text, limit: int = MAX_SAID) -> str:
    text = " ".join(str(text or "").replace("*", "").replace("#", "").split())
    if len(text) <= limit:
        return text
    cut = text[:limit]
    return (cut.rsplit(" ", 1)[0] if " " in cut[limit // 2:] else cut).rstrip(",;:") + "…"


def line_for(*, when: datetime, what: str, status: str, said: str = "", error: str = "", secrets=()) -> str:
    """One run's line: its time, what it was, how it ended."""
    from .redaction import redact_text
    if status == "failed":
        ended = "Failed" + (f": {_first_words(error, 100)}" if error else "")
    elif status == "cancelled":
        ended = "Stopped"
    else:
        ended = f"“{_first_words(said)}”" if str(said or "").strip() else "Done"
    return redact_text(f"- {when.strftime('%H:%M')} · {what} · {ended}", tuple(secrets)).replace("\n", " ")


@contextlib.contextmanager
def _locked(folder: Path):
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        import fcntl
    except ImportError:
        yield
        return
    fd = os.open(str(folder / ".lock"), os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0), 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def record(directory, pip_id, line: str, *, now: datetime | None = None) -> None:
    """Add one run's line to today's file (and forget days past KEEP_DAYS). Never raises: a log is for reading."""
    try:
        now = now or datetime.now().astimezone()
        folder = _folder(directory, pip_id)
        with _locked(folder):
            day = folder / f"{now.date().isoformat()}.md"
            try:
                rows = day.read_text(encoding="utf-8").splitlines()
            except FileNotFoundError:
                rows = [f"# {now.date().isoformat()}"]
            entries = [r for r in rows[1:] if r.startswith("- ")]
            more = 0
            if entries and _MORE.match(entries[-1]):
                more = int(_MORE.match(entries.pop()).group(1))
            if len(entries) >= MAX_DAY_LINES:
                more += 1
            else:
                entries.append(line)
            if more:
                entries.append(f"- … and {more} more run{'s' if more != 1 else ''}")
            temp = day.with_name(f".{day.name}.{os.getpid()}.tmp")
            fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_CLOEXEC", 0), 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write("\n".join([rows[0], *entries]) + "\n")
            os.replace(temp, day)
            oldest = (now.date() - timedelta(days=KEEP_DAYS)).isoformat()
            for old in folder.glob("*.md"):
                if _DAY.match(old.stem) and old.stem < oldest:
                    old.unlink(missing_ok=True)
    except (OSError, RegistryError, ValueError):
        pass


def days(directory, pip_id, *, before: str | None = None, limit: int = 7) -> dict:
    """``list_pip_daily_log``: the newest days first (before `before`, a YYYY-MM-DD, when given)."""
    if before is not None and (not isinstance(before, str) or not _DAY.match(before)):
        raise RegistryError("invalid_request", "before is a day, YYYY-MM-DD.")
    if type(limit) is not int or not 1 <= limit <= MAX_DAYS_PAGE:
        raise RegistryError("invalid_request", f"limit is 1 to {MAX_DAYS_PAGE} days.")
    folder = _folder(directory, pip_id)
    try:
        names = sorted((p.stem for p in folder.glob("*.md") if _DAY.match(p.stem)), reverse=True)
    except OSError:
        names = []
    if before is not None:
        names = [n for n in names if n < before]
    out = []
    for name in names[:limit]:
        try:
            rows = (folder / f"{name}.md").read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError):
            continue
        lines, more = [], 0
        for row in rows[1:]:
            if not row.startswith("- "):
                continue
            found = _MORE.match(row)
            if found:
                more = int(found.group(1))
            else:
                lines.append(row[2:])
        out.append({"day": name, "lines": lines, "more": more})
    return {"pip_id": pip_id, "days": out, "next_before": names[limit - 1] if len(names) > limit else None}


def after_run(directory, db, run: dict, *, status: str, result=None, error=None, secrets=()) -> None:
    """From PipStore.finish (and recover): this run's line, for a Personal Pip's chat reply, routine or task."""
    try:
        manifest = run.get("manifest") if isinstance(run.get("manifest"), dict) else {}
        kind = manifest.get("run_kind")
        if kind not in ("conversation", "personal_task"):
            return
        personal = db.execute("SELECT 1 FROM pips p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=? AND "
                              "w.kind='personal'", (run["pip_id"],)).fetchone()
        if personal is None:
            return
        what = "Task"
        if kind == "conversation":
            asked = db.execute("SELECT text,request_key FROM pip_chat_messages WHERE run_id=? AND role='user' LIMIT 1",
                               (run["id"],)).fetchone()
            key = str(asked["request_key"] or "") if asked is not None else ""
            from .pip_chat import DGC_KEYS
            from .pip_routines import KEY as ROUTINE_KEY
            if key.startswith(ROUTINE_KEY):
                routine = db.execute("SELECT title FROM pip_routines WHERE pip_id=? AND substr(id,-16)=?",
                                     (run["pip_id"], key[len(ROUTINE_KEY):len(ROUTINE_KEY) + 16])).fetchone()
                what = f"Routine “{_first_words(routine['title'], 60)}”" if routine is not None else "Routine"
            elif key.startswith(DGC_KEYS):
                what = "Chat (DGC carried on)"
            else:
                what = f"Chat: you asked “{_first_words(asked['text'] if asked is not None else '', 60)}”"
        said = result.get("text") if isinstance(result, dict) else ""
        message = error.get("message") if isinstance(error, dict) else ""
        record(directory, run["pip_id"], line_for(when=datetime.now().astimezone(), what=what, status=status,
                                                  said=said, error=message, secrets=secrets))
    except Exception:                              # noqa: BLE001 -- a log line is never worth a run
        pass
