"""Run in background: the person moves a helper or a command the turn is waiting on to the background.

The model chooses per helper whether the turn waits for it (foreground) or goes on (background), and a
`bash` command runs in the foreground unless it asked for `background: true`. The person can now
override that choice for what the turn is waiting on RIGHT NOW: a Run in background button on the
running row or the agent map card, Ctrl+B in the terminal, `/background` in the classic one.

What moves, and how:

- a foreground `task` helper of the main agent (alone, or one of a batch): its work goes on in its own
  thread, exactly as it was -- same worktree, same transcript, same step count -- and it is handed to
  the background-helper bookkeeping as if it had been started with `background: true`. The waiting
  `task` call returns at once with `helper_moved`; the helper's finish integrates and wakes the chat
  like any background helper's.
- a foreground `bash` command of the main agent: its process, its output so far and everything it
  prints from now on become a background shell (`bgN`), and the call returns with `command_moved`. Its
  exit wakes the chat like any background command's.

The `python` tool is not movable: its interpreter is one persistent namespace the next call needs.

A `Waiting` is the one decision point between "the work ended while the turn still waited on it" and
"the person moved it": whichever happens first under its lock wins, so a move is never acknowledged
for work whose result the turn has already taken, and never lost for work that ended at that moment.
"""
from __future__ import annotations

import contextvars
import threading

MOVED = object()          # what a Waiting.run hands the turn when the person moved the work

KINDS = ("agent", "command")


class Waiting:
    """One foreground helper or command the turn is waiting on now.

    ``kind`` "agent": a `task` helper, ``key`` its id (sub-<12 hex>); "command": a `bash` command,
    ``key`` its call id. ``call_id`` is the id the front end knows the row by. ``on_move`` runs under
    the lock when the person moves it, before the waiting turn is let go: what must hold before
    anything else can act on the moved work (a Stop on the turn no longer reaches it). It may raise
    to refuse the move.
    """

    def __init__(self, kind: str, key: str, label: str, *, call_id: str = "", on_move=None,
                 armed: bool = True):
        self.kind = kind if kind in KINDS else "agent"
        self.key = str(key or "")
        self.label = str(label or "")
        self.call_id = str(call_id or "")
        self.on_move = on_move
        # A command is armed once its process runs (tools.bash): before that there is nothing to move.
        self.armed = bool(armed)
        # A command's: does this frontend deliver its exit notice, and will that start a turn?
        self.notify_exit = False
        self.wakes = False
        self._lock = threading.Lock()
        self.state = "running"                  # running -> done | moved
        self._settled = threading.Event()       # the turn may go on: the work ended, or it moved
        self._finished = threading.Event()      # the work itself ended (a helper's run returned)
        self._value = None
        self._error: BaseException | None = None

    # ---- the person ------------------------------------------------------------------------------
    def arm(self) -> None:
        self.armed = True

    def move(self) -> bool:
        """Move it to the background. False when it had already ended (or the move was refused)."""
        with self._lock:
            if self.state != "running" or not self.armed:
                return False
            if self.on_move is not None:
                try:
                    self.on_move()
                except Exception:
                    return False
            self.state = "moved"
        self._settled.set()
        return True

    @property
    def moved(self) -> bool:
        return self.state == "moved"

    @property
    def running(self) -> bool:
        return self.state == "running" and self.armed

    # ---- the work --------------------------------------------------------------------------------
    def settle(self) -> bool:
        """The work ended while the turn still waited on it: True, or False when it was moved first."""
        with self._lock:
            if self.state == "moved":
                return False
            self.state = "done"
        self._settled.set()
        return True

    def run(self, fn):
        """Run ``fn`` on a thread of its own and wait for it: its value, or MOVED once moved.

        The thread runs in a copy of this thread's context, so whatever a contextvar says about the
        call (whose images these are, which turn this is) still holds for it. A moved run goes on, and
        its value is collected with ``result()`` by whoever adopted it.
        """
        context = contextvars.copy_context()

        def body():
            try:
                self._value = context.run(fn)
            except BaseException as exc:          # handed to whoever collects the value
                self._error = exc
            finally:
                self._finished.set()
                self.settle()

        threading.Thread(target=body, daemon=True,
                         name=f"dgc-fg-{self.key[-8:] or 'work'}").start()
        self._settled.wait()
        if self.state == "moved":
            return MOVED
        if self._error is not None:
            raise self._error
        return self._value

    def result(self):
        """A moved run's value, once its work has ended (it blocks until then)."""
        self._finished.wait()
        if self._error is not None:
            raise self._error
        return self._value

    def item(self) -> dict:
        return {"kind": self.kind, "id": self.key, "call_id": self.call_id, "label": self.label}


class WaitingList:
    """What one top-level agent's turn is waiting on now, and that the person may move."""

    def __init__(self):
        self._lock = threading.Lock()
        self._items: list[Waiting] = []

    def add(self, waiting: Waiting) -> None:
        with self._lock:
            self._items.append(waiting)

    def remove(self, waiting: Waiting) -> None:
        with self._lock:
            if waiting in self._items:
                self._items.remove(waiting)

    def running(self) -> list[Waiting]:
        with self._lock:
            return [w for w in self._items if w.running]

    def find(self, target: str, kind: str = "") -> list[Waiting]:
        """The running items ``target`` names: an agent id, a call id, or "all"; of ``kind`` if given."""
        target = str(target or "").strip()
        items = [w for w in self.running() if not kind or w.kind == kind]
        if target == "all":
            return items
        return [w for w in items if target and target in (w.key, w.call_id)]


# ---- what the model is told ------------------------------------------------------------------------
CARRY_ON = "Carry on without it: don't wait for it, and don't start it again."


def helper_moved(description: str, agent_id: str, *, isolated: bool, wakes: bool) -> str:
    """The waiting `task` call's result (or its slot in a batch) once the person moved the helper."""
    where = "in its own copy" if isolated else "in the shared checkout"
    if wakes:
        arrives = "its report will arrive on its own when it finishes"
    else:
        arrives = ("its report reaches you between tool calls while a turn is running, otherwise "
                   "with the person's next message")
    return (f"The person moved '{description}' to the background (id {agent_id}). It keeps running "
            f"{where}; {arrives}. {CARRY_ON}")


def command_moved(label: str, bid: str, *, wakes: bool) -> str:
    """The waiting `bash` call's result once the person moved the command."""
    head = f"The person moved `{label}` to the background ({bid})"
    head += "; its exit will wake this chat." if wakes else "."
    return (f"{head} {CARRY_ON} Its output so far and everything it prints from now on are kept: "
            f"read them with bash_output(id=\"{bid}\").")


def guidance() -> str:
    """One line for the system prompt: what the model does when the person moves something."""
    return ("The person can move a sub-task or command you are waiting on to the background. The "
            "result then says so: carry on without it, don't wait for it and don't start it again; "
            "its report arrives on its own when it ends.")
