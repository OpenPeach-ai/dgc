"""Notice when the user starts a chat with work they have asked for before, so the chat can offer
to make it a Pip.

Checked once per chat, on its first prompt, against how the user's recent chats in this project
began: the newest 40 within 30 days, each read whole but skipped above 2 MB. Two or more alike
(word overlap, not an exact match) give the model one line of guidance: offer once, and prepare a
setup card only if the user agrees. A hint, never a gate: no tool appears or disappears on it.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

WINDOW_DAYS = 30
MAX_SESSIONS = 40
MAX_BYTES = 2 * 1024 * 1024
MIN_WORDS = 4
SIMILAR = 0.6
_STOP = frozenset("the a an and or to of for in on at by with from me my our your this that these those it is are "
                  "be can could would should please pls do does did what how about into over just now then also "
                  "i you we they them their there here".split())


def words(text: str) -> frozenset:
    return frozenset(w for w in re.findall(r"[a-z0-9]{3,}", str(text).lower()) if w not in _STOP)


def _first_prompt(path: Path) -> str | None:
    from .clock import strip_turn_clock
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    for message in data.get("messages", []) if isinstance(data, dict) else []:
        if isinstance(message, dict) and message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, list):
                content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
            return str(strip_turn_clock(content or ""))
    return None


def similar_chats(project_root, text: str, *, current=None, now=None) -> list[float]:
    """When earlier chats in this project began with work like ``text``: their timestamps."""
    from .sessions import project_dir
    mine = words(text)
    if len(mine) < MIN_WORDS:
        return []
    now = time.time() if now is None else now
    try:
        files = [p for p in project_dir(project_root).glob("*.json") if p.is_file() and not p.is_symlink()]
    except OSError:
        return []
    current = Path(current).resolve() if current else None
    recent = []
    for path in files:
        try:
            info = path.stat()
        except OSError:
            continue
        if info.st_mtime < now - WINDOW_DAYS * 86400 or info.st_size > MAX_BYTES:
            continue
        if current is not None and path.resolve() == current:
            continue
        recent.append((info.st_mtime, path))
    recent.sort(reverse=True)
    found = []
    for mtime, path in recent[:MAX_SESSIONS]:
        first = _first_prompt(path)
        if not first:
            continue
        theirs = words(first)
        if len(theirs) >= MIN_WORDS and len(mine & theirs) / len(mine | theirs) >= SIMILAR:
            found.append(mtime)
    return found


def hint(project_root, text: str, *, current=None, now=None) -> str:
    """One line of guidance for the system prompt, or "" when nothing repeats."""
    found = similar_chats(project_root, text, current=current, now=now)
    if len(found) < 2:
        return ""
    days = sorted({time.strftime("%d %b", time.localtime(ts)) for ts in found})
    return ("- The user started " + str(len(found)) + " earlier chats in this project with work like this one ("
            + ", ".join(days[-4:]) + "). Once in this chat, when it fits, offer to make it a Pip that does it on a "
            "schedule; prepare a setup card with pips_setup only if they agree, and do not ask again if they decline.")
