"""Open here between processes: one DGC writes to a session at a time, for as long as it has it open.

The process that has a session open holds its owner lock (sessions.session_owner_lock) until it lets it
go -- idle or not, an editor window, a terminal, a DGC kept running with no window, an SDK program -- and
the operating system frees it if that process dies. Every write goes through Agent._session_turn_scope,
which refuses while another process holds it, so a second process never writes behind the first.

Open here asks the holder to let it go (peers.request_release with ``open_here``). A holder lets it go when
nothing runs in it -- no turn, no monitor, no background helper or command, nothing queued or waiting for an
answer -- and keeps showing it read-only, with an Open here of its own; while something runs it says what,
and the session stays where it is: nothing running is ever lost to a move between processes. (Between two
windows of the same DGC, Open here moves the whole process instead, with everything running in it:
dgc/serve_relay.py.)
"""
from __future__ import annotations

import time

# How long Open here waits for the holder to let go and its lock to come free.
OPEN_HERE_WAIT_S = 15.0
# What the terminal says it is, to a holder it takes a session from, and the editor says.
BY_TERMINAL = "the terminal"
BY_EDITOR = "the editor"


def ask_holder(session_file: str, *, by: str) -> tuple[dict | None, bool, str]:
    """Ask the process holding ``session_file`` to let it go. (its note, granted, reason)."""
    from . import peers
    note = peers.session_holder(str(session_file))
    if note is None:
        return None, False, ""
    pid = note.get("pid")
    if not peers.request_release(note, str(session_file), open_here=True, by=by):
        return note, False, "it couldn't be asked"
    answer = None
    deadline = time.monotonic() + peers.RELEASE_ANSWER_WAIT_S
    while answer is None and time.monotonic() < deadline:
        time.sleep(0.2)
        answer = peers.release_answer(pid)
    peers.forget_release(pid)
    if answer is None:
        return note, False, "it did not answer"
    if not answer.get("granted"):
        return note, False, str(answer.get("reason") or "it kept it")
    return note, True, ""


def take(agent, *, by: str = BY_TERMINAL) -> tuple[bool, str]:
    """Open here, in this process: ask whoever has the agent's session open to let it go, then hold it.
    (True, "") once this process holds it; (False, why) when it stays where it is."""
    path = getattr(agent, "session_file", None)
    if not path or agent.own_session(take=True):
        return True, ""
    note, granted, reason = ask_holder(str(path), by=by)
    if note is None:
        # A process that leaves no note (an older DGC, an SDK program in your own DGC): it can't be asked. One that
        # just ended frees it in a moment.
        if agent.own_session(wait=2.0, take=True):
            return True, ""
        return False, "another DGC has it open and can't be asked to let it go; close it there"
    if not granted:
        return False, reason
    if agent.own_session(wait=OPEN_HERE_WAIT_S, take=True):
        return True, ""
    return False, "it let go, but another DGC took it first"


def not_now(reason: str) -> str:
    """What the person is told when the holder keeps it: what runs there, and what to do."""
    reason = str(reason or "it kept it").strip().rstrip(".")
    return (f"Not now: {reason}. Open here moves a session once nothing runs in it: stop that there or let it "
            "finish, then Open here again, or start a new session.")


def wait_free(session_file: str, wait_s: float = OPEN_HERE_WAIT_S) -> bool:
    """For a window's DGC about to open the session (dgc/serve_relay.py): wait for its owner lock to come free."""
    from . import sessions
    try:
        lock = sessions.owner_lock_for_file(session_file)
    except (OSError, TypeError, ValueError):
        return False
    deadline = time.monotonic() + max(0.0, wait_s)
    while True:
        try:
            if lock.acquire(blocking=False):
                lock.release()
                return True
        except (OSError, ValueError, RuntimeError):
            return False
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.2)
