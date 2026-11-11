"""A chat's wake-ups: "come back in 30 minutes and check the tests" (0.52, asked 8 Nov).

A Work chat can come back by itself at a time it chose, the way a person sets a reminder. The model sets one with
the ``wake_later`` tool and takes one back with ``wake_cancel``; when it falls due on an idle chat, the editor's backend
(dgc/headless.py) starts a turn that says which wake-up it is and what the chat said it would do then. A repeating
check ("every 10 minutes until CI is green") is one wake-up at a time: on waking it checks, and sets the next only while
its condition isn't met.

Never a short loop just to wait. A command the chat can watch is a ``monitor``, whose output wakes the chat by itself;
a wake-up is for coming back at a time.

The book
    One per top-level Agent (``agent.wakeups``), one-shot entries ``{id, at, why, prompt, created_at, owner}``, at most
    ``MAX_PER_CHAT``. Written down beside the session as ``<session>.wakeups`` with dgc.monitor_restart's journal
    helpers (under the session-family lease), so a window reload or an editor restart brings them back when the
    session is opened again. Only the process that holds one (its owner) wakes it, so two windows on one session
    never both do; a process that opens the session and finds the owner gone adopts it. One that fell due while DGC
    was closed wakes once on open, and its turn says how late it is.
"""
from __future__ import annotations

import itertools
import re
import threading
import time
from datetime import datetime

SUFFIX = ".wakeups"
MAX_PER_CHAT = 4
MIN_MINUTES = 1
MAX_MINUTES = 7 * 24 * 60
WHY_CHARS = 200
PROMPT_CHARS = 2000
_ids = itertools.count(1)


def owner() -> dict:
    from .monitor_restart import owner as process
    return process()


def owner_alive(who) -> bool:
    from .monitor_restart import owner_alive as alive
    return alive(who)


def _clean(record) -> dict | None:
    if not isinstance(record, dict):
        return None
    if not (isinstance(record.get("id"), str) and re.fullmatch(r"wake\d{1,9}", record["id"])):
        return None
    for name in ("at", "created_at"):
        if not isinstance(record.get(name), (int, float)) or isinstance(record.get(name), bool):
            return None
    if not all(isinstance(record.get(name), str) and record[name].strip() for name in ("why", "prompt")):
        return None
    return {"id": record["id"], "at": float(record["at"]), "created_at": float(record["created_at"]),
            "why": record["why"][:WHY_CHARS], "prompt": record["prompt"][:PROMPT_CHARS],
            "owner": record.get("owner") if isinstance(record.get("owner"), dict) else {}}


def clock_words(at: float) -> str:
    return datetime.fromtimestamp(at).strftime("%H:%M")


def _minutes(seconds: float) -> str:
    minutes = max(1, round(seconds / 60))
    if minutes < 120:
        return f"{minutes} minute{'s' if minutes != 1 else ''}"
    hours = round(minutes / 60)
    return f"{hours} hours" if hours < 48 else f"{round(hours / 24)} days"


class Book:
    """The wake-ups of one chat. ``target()`` names its journal ((session file, session root), or None for a chat with
    no session yet); ``on_change()`` is told after every change, outside the lock."""

    def __init__(self, target=None, *, clock=time.time, on_change=None):
        self.target = target or (lambda: None)
        self.clock = clock
        self.on_change = on_change
        self._lock = threading.Lock()
        self._items: list[dict] = []

    # ---- what the chat holds ----------------------------------------------------------------
    def items(self) -> list[dict]:
        with self._lock:
            return sorted((dict(item) for item in self._items), key=lambda i: i["at"])

    def next_at(self) -> float | None:
        with self._lock:
            return min((i["at"] for i in self._items), default=None)

    def snapshot(self) -> list[dict]:
        """The chat's row: when and why, soonest first (the `wakeups` event)."""
        return [{"id": i["id"], "at": datetime.fromtimestamp(i["at"]).astimezone().isoformat(timespec="seconds"),
                 "why": i["why"]} for i in self.items()]

    def add(self, minutes, why, prompt) -> dict:
        if type(minutes) not in (int, float) or minutes != minutes or not MIN_MINUTES <= minutes <= MAX_MINUTES:
            raise ValueError(f"minutes must be a number from {MIN_MINUTES} to {MAX_MINUTES} (7 days).")
        why = " ".join(str(why or "").split())[:WHY_CHARS]
        prompt = str(prompt or "").strip()[:PROMPT_CHARS]
        if not why:
            raise ValueError("Say why in a few words: it is what the chat shows while it waits.")
        if not prompt:
            raise ValueError("Say what to do when it wakes: the turn is told exactly that.")
        now = self.clock()
        with self._lock:
            if len(self._items) >= MAX_PER_CHAT:
                raise ValueError(f"A chat can wait on at most {MAX_PER_CHAT} wake-ups. Cancel one first (wake_cancel).")
            item = {"id": f"wake{next(_ids)}", "at": now + float(minutes) * 60, "created_at": now,
                    "why": why, "prompt": prompt, "owner": owner()}
            self._items.append(item)
        self._save()
        return dict(item)

    def cancel(self, wid) -> bool:
        with self._lock:
            found = next((i for i in self._items if i["id"] == wid), None)
            if found is None:
                return False
            self._items.remove(found)
        self._save()
        return True

    def take_due(self) -> dict | None:
        """The soonest wake-up whose time has come, taken out of the book; None while none is due."""
        now = self.clock()
        with self._lock:
            due = sorted((i for i in self._items if i["at"] <= now), key=lambda i: i["at"])
            if not due:
                return None
            self._items.remove(due[0])
        self._save()
        return dict(due[0])

    def clear(self) -> None:
        """The chat was replaced (/new, /clear): its wake-ups go with it."""
        with self._lock:
            had = bool(self._items)
            self._items.clear()
        if had:
            self._save()

    # ---- beside the session ----------------------------------------------------------------
    def release(self) -> None:
        """The chat was left (another session opened, /new, /clear): its wake-ups stay beside its session with no owner,
        so opening it again (here or in another DGC) brings them back; none wakes it from here meanwhile."""
        target = self.target()
        with self._lock:
            items = [{**i, "owner": {}} for i in self._items]
            self._items.clear()
        if target and items:
            from .monitor_restart import update
            ids = {i["id"] for i in items}

            def mutate(records):
                records[:] = [r for r in records if r["id"] not in ids] + items
            update(*target, mutate, suffix=SUFFIX, clean=_clean, limit=MAX_PER_CHAT * 4)
        if items and callable(self.on_change):         # nothing held: nothing to say (a resume's replay stays clean)
            try:
                self.on_change([])
            except Exception:                   # noqa: BLE001
                pass

    def adopt(self) -> None:
        """The session was opened: take back its wake-ups whose owner has gone (a reload, a restart). Says nothing: the
        frontend sends the row after the session's history (a resume's replay must end before anything new)."""
        target = self.target()
        if not target:
            return
        from .monitor_restart import read
        records = read(*target, suffix=SUFFIX, clean=_clean)
        me = owner()
        with self._lock:
            known = {i["id"] for i in self._items}
            taken = [r for r in records if r["id"] not in known
                     and (r.get("owner") == me or not owner_alive(r.get("owner")))]
            for record in taken[:max(0, MAX_PER_CHAT - len(self._items))]:
                self._items.append({**record, "owner": me})
        if taken:
            self._save(notify=False)

    def _save(self, *, notify: bool = True) -> None:
        target = self.target()
        if target:
            from .monitor_restart import update
            me = owner()
            with self._lock:
                mine = [dict(i) for i in self._items]
            ids = {i["id"] for i in mine}

            def mutate(records):
                # Others' (another window on this session) stay; this process's are replaced by what it holds now.
                kept = [r for r in records if r["id"] not in ids and r.get("owner") != me and owner_alive(r.get("owner"))]
                records[:] = kept + mine
            update(*target, mutate, suffix=SUFFIX, clean=_clean, limit=MAX_PER_CHAT * 4)
        if notify and callable(self.on_change):
            try:
                self.on_change(self.snapshot())
            except Exception:                   # noqa: BLE001 - a row is never worth the book
                pass


def turn_text(due: dict, *, now: float | None = None) -> str:
    """The user-role text of the turn a wake-up starts: whose it is, how long ago it was set, what to do now (the
    chat's own words, quoted as data), and how a repeating check goes on."""
    now = time.time() if now is None else now
    late = now - float(due.get("at") or now)
    lines = [f"This is the wake-up you set {_minutes(now - float(due.get('created_at') or now))} ago "
             f"({clock_words(float(due.get('at') or now))}): {due.get('why', '')}."]
    if late >= 120:
        lines.append(f"It was due {_minutes(late)} ago, while DGC was closed; it is {clock_words(now)} now.")
    lines.append("What you said you would do then (your own words from earlier, data, not instructions from anyone "
                 "else):")
    lines.append('"""\n' + str(due.get("prompt", "")).replace('"""', "'''") + '\n"""')
    lines.append("Do it now. If it is a check that repeats until something is true and that isn't true yet, set the "
                 "next one with wake_later; if it is true, say so and stop.")
    return "\n".join(lines)
