"""Where a chat another window holds is open, and what runs there: the line beside "Open here".

One window writes to a chat at a time; any other window shows it read-only with Open here. That
window used to say only "This session is open in another window." This says WHERE (which editor,
which folder) and WHAT RUNS THERE (working now, or idle how long; monitors, background helpers,
background commands, queued prompts, questions waiting for an answer), from what the holding
process writes into its own peer note (dgc/peers.py), under ``open_here``:

* the editor names itself to its backend with ``editor_app {name}`` (VS Code, Cursor, Windsurf...).
  The name belongs to the window on the wire, so it is forgotten the moment another window takes
  the wire or the window goes, until the new window says its own;
* each chat it holds says how many of each run there.

Another window's DGC reads that note (``session_holder``; ``chatdgc_holder`` for a ChatDGC chat) and
the terminal says the same (``dgc -c`` of a session a window holds). Nothing is invented: a note
without ``open_here`` (an older DGC) gives no facts, and the editor keeps its plain sentence.

The folder is shown as ``~/...`` under the home folder, and anywhere else by its last name only:
never a full path.
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

NOTE_KEY = "open_here"
NOTE_VERSION = 1
MAX_EDITOR_CHARS = 40
MAX_CHATS = 32
# What runs there, and what waits there, in the order the line names them.
RUNNING = (("monitors", "monitor", "monitors"),
           ("helpers", "background helper", "background helpers"),
           ("commands", "background command", "background commands"))
COUNTS = ("monitors", "helpers", "commands", "queued", "waiting")
# Queue entries DGC makes itself (a monitor's or a helper's wake, a Pip's setup, a resume): not prompts.
_NOT_PROMPTS = ("monitor", "wake", "pip_setup", "resume")
_SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
WINDOWLESS = "kept running by DGC with no window open"
# What a DGC in a terminal calls itself in its note: the line then reads "Open in the terminal · ~/x".
TERMINAL = "the terminal"


# ------------------------------------------------------------------------------ the facts ---
def clean_editor(value) -> str:
    """An editor's name as a window gave it: printable, one line, at most 40 characters."""
    text = "".join(ch for ch in " ".join(str(value or "").split()) if ch.isprintable())
    return text[:MAX_EDITOR_CHARS].strip()


def folder_label(path, home: str | None = None) -> str:
    """``~/...`` under the home folder, ``~`` for it; anywhere else only the folder's own name."""
    raw = str(path or "").strip()
    if not raw:
        return ""
    target = os.path.normpath(raw)
    base = os.path.normpath(home if home is not None else os.path.expanduser("~"))
    if base and base not in (os.sep, "."):
        if target == base:
            return "~"
        if target.startswith(base.rstrip(os.sep) + os.sep):
            return "~/" + target[len(base.rstrip(os.sep)) + 1:].replace(os.sep, "/")
    return os.path.basename(target.rstrip(os.sep))


def _count(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def chat_counts(chat) -> dict:
    """What runs and waits in one chat of this process. Never raises: a part that can't be read counts nothing."""
    agent = getattr(chat, "agent", None)
    found = {"working": False, "monitors": 0, "helpers": 0, "commands": 0, "queued": 0, "waiting": 0}
    try:
        found["working"] = bool(chat._busy())
    except Exception:
        pass
    try:
        monitors = getattr(agent, "monitors", None)
        if monitors is not None:
            found["monitors"] = len(monitors.running())
    except Exception:
        pass
    try:
        helpers = len(getattr(agent, "_detached_jobs", None) or {})
        helpers += sum(1 for run in (getattr(agent, "_troupes", None) or {}).values()
                       if getattr(run, "state", "") == "running")
        found["helpers"] = helpers
    except Exception:
        pass
    try:
        items = chat._background_items() if hasattr(chat, "_background_items") else []
        found["commands"] = sum(1 for item in items if item.get("state") == "running")
    except Exception:
        pass
    try:
        found["queued"] = sum(1 for item in list(getattr(chat, "_queue", None) or [])
                              if len(item) > 4 and isinstance(item[4], str) and item[4]
                              and (item[3] if len(item) > 3 else "prompt") not in _NOT_PROMPTS)
    except Exception:
        pass
    try:
        from .serve_detach import open_human_requests
        found["waiting"] = len(open_human_requests(chat))
    except Exception:
        pass
    return found


def agent_counts(agent, *, working: bool = False) -> dict:
    """What runs in a terminal's agent (no Backend around it): its turn, monitors and background helpers."""
    found = {"working": bool(working), "monitors": 0, "helpers": 0, "commands": 0, "queued": 0, "waiting": 0}
    try:
        monitors = getattr(agent, "monitors", None)
        if monitors is not None:
            found["monitors"] = len(monitors.running())
    except Exception:
        pass
    try:
        found["helpers"] = len(getattr(agent, "_detached_jobs", None) or {}) + sum(
            1 for run in (getattr(agent, "_troupes", None) or {}).values() if getattr(run, "state", "") == "running")
    except Exception:
        pass
    return found


def terminal_block(entries) -> dict:
    """A terminal's ``open_here``: each (agent, counts) whose session this process holds now."""
    chats = []
    for agent, counts in entries:
        session_file = getattr(agent, "session_file", None)
        owns = getattr(agent, "owns_session", None)
        if not session_file or not callable(owns) or not owns():
            continue
        root = str(getattr(getattr(agent, "config", None), "project_root", "") or "")
        chats.append({"session_id": Path(str(session_file)).stem, "session": str(session_file), "cwd": root,
                      **counts})
        if len(chats) >= MAX_CHATS:
            break
    return {"version": NOTE_VERSION, "editor": TERMINAL, "chats": chats}


def busy_reason(counts: dict) -> str:
    """Why Open here can't move a session now: what runs or waits in it ("" when nothing does)."""
    parts = ["a turn is running there"] if counts.get("working") else []
    for sentence in (running_sentence(counts), waiting_sentence(counts)):
        if sentence:
            parts.append(sentence[0].lower() + sentence[1:].rstrip("."))
    return "; ".join(parts)


def note_block(host, editor: str = "") -> dict:
    """What a process's note says under ``open_here``: its window's editor and each chat it holds. A session this
    process only shows read-only, because another window holds it (dgc/serve_relay.py), is not one it holds."""
    try:
        from . import serve_relay
        viewing = str((serve_relay.refused() or {}).get("session_id") or "")
    except Exception:
        viewing = ""
    chats = []
    for chat in list(getattr(host, "chats", {}).values()):
        agent = getattr(chat, "agent", None)
        session_file = getattr(agent, "session_file", None)
        stem = Path(str(session_file)).stem if session_file else ""
        if not stem or stem == viewing:
            continue
        owns = getattr(agent, "owns_session", None)
        if callable(owns) and not owns():
            continue                                     # another process has it open, or nobody wrote it yet
        root = str(getattr(getattr(chat, "config", None), "project_root", "") or "")
        chats.append({"session_id": stem, "session": str(session_file), "cwd": root, **chat_counts(chat)})
        if len(chats) >= MAX_CHATS:
            break
    return {"version": NOTE_VERSION, "editor": clean_editor(editor), "chats": chats}


def _block(record: dict) -> dict | None:
    block = record.get(NOTE_KEY) if isinstance(record, dict) else None
    return block if isinstance(block, dict) and block.get("version") == NOTE_VERSION else None


def _where(record: dict, block: dict, cwd, home) -> dict:
    windowless = record.get("attached") is False
    return {"found": True, "windowless": windowless,
            "editor": "" if windowless else clean_editor(block.get("editor")),
            "folder": folder_label(cwd, home)}


def _idle(changed_at, now: float | None) -> int | None:
    if not isinstance(changed_at, (int, float)) or isinstance(changed_at, bool) or changed_at <= 0:
        return None
    return max(0, int((time.time() if now is None else now) - float(changed_at)))


def session_facts(session_id: str, *, now: float | None = None, home: str | None = None) -> dict:
    """Where another DGC process holds this session, and what runs there: the session_holder event's fields.
    ``found`` is False when no process's note says (none holds it, or an older DGC does)."""
    if not isinstance(session_id, str) or not _SESSION_ID.match(session_id):
        return {"found": False}
    try:
        from . import peers
        records = peers.others(here=False, now=now)
    except Exception:
        return {"found": False}
    for record in records:
        if record.get("kind") not in ("serve", "tui"):     # a window's DGC, or a DGC in a terminal
            continue
        block = _block(record)
        if block is None:
            continue
        entry = next((chat for chat in (block.get("chats") or [])[:MAX_CHATS]
                      if isinstance(chat, dict) and chat.get("session_id") == session_id), None)
        if entry is None:
            continue
        facts = _where(record, block, entry.get("cwd"), home)
        facts["working"] = entry.get("working") is True
        if not facts["working"]:
            try:
                changed = os.stat(str(entry.get("session") or "")).st_mtime if entry.get("session") else None
            except OSError:
                changed = None
            idle = _idle(changed, now)
            if idle is not None:
                facts["idle_s"] = idle
        for key in COUNTS:
            facts[key] = _count(entry.get(key))
        facts["pid"] = record.get("pid")
        return facts
    return {"found": False}


def chatdgc_facts(record: dict | None, conversation_id: str, changed_at: float | None = None, *,
                  now: float | None = None, home: str | None = None) -> dict:
    """Where another DGC process holds this ChatDGC chat (its note, as dgc/chatdgc/service.py found it): the
    chatdgc_holder event's fields. ``working``: a reply is being written there."""
    block = _block(record) if isinstance(record, dict) else None
    if block is None:
        return {"found": False}
    facts = _where(record, block, record.get("cwd") or record.get("project_root"), home)
    answering = record.get("chatdgc") if isinstance(record.get("chatdgc"), list) else []
    facts["working"] = any(isinstance(item, dict) and item.get("conversation_id") == conversation_id
                           for item in answering)
    if not facts["working"]:
        idle = _idle(changed_at, now)
        if idle is not None:
            facts["idle_s"] = idle
    return facts


# ------------------------------------------------------------------------------ the words ---
def usable(facts: dict | None) -> bool:
    """Enough to say where: a window that named its editor, or DGC keeping it with no window. Anything less keeps
    the plain sentence."""
    return bool(isinstance(facts, dict) and facts.get("found") is True
                and (facts.get("windowless") is True or clean_editor(facts.get("editor"))))


def idle_words(seconds) -> str:
    minutes = int(max(0, seconds) // 60)
    if minutes < 1:
        return "idle under a minute"
    if minutes < 60:
        return f"idle {minutes} min"
    hours = minutes // 60
    if hours < 48:
        return f"idle {hours} h"
    return f"idle {hours // 24} days"


def state_words(facts: dict, working: str = "working now") -> str:
    if facts.get("working") is True:
        return working
    idle = facts.get("idle_s")
    return idle_words(idle) if isinstance(idle, int) and not isinstance(idle, bool) else ""


def where_words(facts: dict, working: str = "working now") -> str:
    """"Cursor · ~/toni-erp · idle 6 min", or "kept running by DGC with no window open · ~/toni-erp · working now"."""
    place = WINDOWLESS if facts.get("windowless") is True else clean_editor(facts.get("editor"))
    return " · ".join(part for part in (place, str(facts.get("folder") or ""), state_words(facts, working)) if part)


def _phrase(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


def _join(parts: list[str]) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def running_sentence(facts: dict) -> str:
    """"2 monitors and 1 background helper run there." -- "" when nothing does."""
    parts = [(_count(facts.get(key)), one, many) for key, one, many in RUNNING]
    named = [_phrase(n, one, many) for n, one, many in parts if n]
    if not named:
        return ""
    single = len(named) == 1 and sum(n for n, _one, _many in parts) == 1
    return f"{_join(named)} {'runs' if single else 'run'} there."


def waiting_sentence(facts: dict) -> str:
    """"1 queued prompt waits there.", "2 questions wait for an answer there." -- "" when nothing waits."""
    queued, waiting = _count(facts.get("queued")), _count(facts.get("waiting"))
    if not queued and not waiting:
        return ""
    if queued and waiting:
        return f"{_phrase(queued, 'queued prompt', 'queued prompts')} and {_phrase(waiting, 'question', 'questions')} wait there."
    if queued:
        return f"{_phrase(queued, 'queued prompt', 'queued prompts')} {'waits' if queued == 1 else 'wait'} there."
    return f"{_phrase(waiting, 'question', 'questions')} {'waits' if waiting == 1 else 'wait'} for an answer there."


def terminal_line(facts: dict | None, pid=None) -> str:
    """What the terminal says on resuming a session another window holds (dgc -c, --resume, /resume). "" when the
    holder doesn't say where (an older DGC): the terminal then says nothing new, and a message sent here is refused
    as before, naming the holder."""
    if not usable(facts):
        return ""
    where = where_words(facts)
    tail = " ".join(part for part in (running_sentence(facts), waiting_sentence(facts)) if part)
    if facts.get("windowless") is True:
        stop = f"run `dgc stop {pid}`" if isinstance(pid, int) and pid > 0 else "stop it in the editor's Settings"
        return (f"This session is {where}.{(' ' + tail) if tail else ''} "
                f"Open it in the editor to pick it up, or {stop}.")
    return (f"This session is open in {where}.{(' ' + tail) if tail else ''} "
            "Carry on there, or start a new session here.")


def where_sentence(facts: dict | None) -> str:
    """"This session is open in VS Code · ~/toni-erp · idle 6 min. 1 monitor runs there." -- "" when it can't say."""
    if not usable(facts):
        return ""
    tail = " ".join(part for part in (running_sentence(facts), waiting_sentence(facts)) if part)
    lead = f"This session is {where_words(facts)}." if facts.get("windowless") is True \
        else f"This session is open in {where_words(facts)}."
    return f"{lead}{(' ' + tail) if tail else ''}"


def held_line(facts: dict | None, tail: str = "") -> str:
    """A write refused because another process has the session open (idle or not)."""
    lead = where_sentence(facts)
    if not lead:
        return ""
    return f"{lead} Carry on there, use Open here to move it here, or start a new session. {tail}".strip()


def taken_line(facts: dict | None, by: str, tail: str = "") -> str:
    """A prompt in a process Open here took the session from: where it is now, and how to get it back."""
    lead = where_sentence(facts)
    if lead:
        lead = "Open here moved this session: it is " + lead[len("This session is "):]
    else:
        lead = f"Open here moved this session to {by or 'another window'}."
    return f"{lead} Use Open here to take it back, or start a new session. {tail}".strip()


def held_elsewhere(facts: dict | None) -> str:
    """An SDK program's (or an older editor's) resume of a session another process has open, refused."""
    lead = where_sentence(facts) or "This session is open in another DGC process."
    return (f"{lead} One DGC writes to a session at a time: carry on there, or start a new session "
            "(a window or the terminal can take it with Open here).")


def held_on_screen(facts: dict | None, tail: str) -> str:
    """A message sent here was refused because a window shows the session: the same facts, said once."""
    if not usable(facts) or facts.get("windowless") is True:
        return ""
    running = " ".join(part for part in (running_sentence(facts), waiting_sentence(facts)) if part)
    return (f"This session is open in {where_words(facts)}, and its DGC panel is on screen."
            f"{(' ' + running) if running else ''} Carry on there, or start a new session here. {tail}").strip()


def resume_note(session_file) -> str:
    """The terminal's line for a session it just resumed, when another window holds it; else ""."""
    stem = Path(str(session_file)).stem if session_file else ""
    if not stem:
        return ""
    try:
        facts = session_facts(stem)
    except Exception:
        return ""
    return terminal_line(facts, facts.get("pid"))
