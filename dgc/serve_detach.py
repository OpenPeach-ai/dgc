"""A `dgc serve` that keeps running when its window goes, and a window that finds it again.

An editor that opts in (``ready.capabilities.detach``, then ``set_detach``) is saying: when my
window goes away -- a reload, a closed window, a dropped connection -- keep the work running. The
backend then becomes *windowless* instead of ending: its wire points at nothing (the seq counter
keeps counting), its session lease stays held by the turn that holds it, and an owner-only Unix
socket (``dgc.session_socket``) waits for the next window. That window's own `dgc serve` finds the
socket in the peer note and relays the editor's bytes to it (``dgc.serve_relay``); this process
answers the ``attach`` with a fresh ``ready`` and one ``session_live`` per chat, and the editor
repaints from ``get_history``, which already carries the running turn's unsaved bytes and is
followed by every open approval again, with the same ids.

Old clients are unchanged: an editor that never sends ``set_detach`` -- an older extension, the
SDK, ACP -- gets exactly the old behaviour, where end-of-input or ``shutdown`` ends the process.

The Sessions home's backend carries ChatDGC, Pips, the Sessions list and Settings, and holds no session of
its own. It opts in with ``set_detach_chatdgc`` instead (offered as ``ready.capabilities.detach.chatdgc``):
the same rules, but only a ChatDGC reply is work that keeps it running with no window. With none, a window
that goes ends it, exactly as before.

Open here for a ChatDGC chat (``ready.capabilities.detach.chatdgc_open_here``) moves one chat, never the
process, which carries its window's Pips, Sessions and Settings too: one window writes to a chat at a time.
The note names the chats a process holds (``chatdgc_held``: its window shows them, or it is writing them),
and another window's process asks for one over this socket (``chatdgc_take``, dgc/chatdgc/service.py). Idle,
it is let go; mid-reply, the socket becomes that one chat's link until the reply ends. A process holds a chat
only while it holds that chat's lock (dgc/chatdgc/held.py, ``chatdgc_locks`` in its note), so two windows that
open one chat in the same instant can't both have it.

How long a windowless backend lives (the founder's decisions, 19 Oct 2026):

* no work: it saves and exits ``IDLE_EXIT_S`` (2 minutes) after its work finished -- at once when
  nothing was running as its window went;
* waiting only on you (an approval or question open, nothing else progressing): it keeps waiting
  ``WAITING_EXIT_S`` (1 hour), then saves and stops; reopening shows the turn's Continue;
* whatever is running, it stays windowless at most ``MAX_WINDOWLESS_S`` (12 hours), then the turn
  gets the usual grace to land, and it saves and stops.

One window at a time: an attach never ends anything. The window it displaces is told
``session_moved`` and turns read-only with "Open here". An automatic attach (a reload) never takes a
session from a window whose panel is on screen; only the user's own "Open here" does.
"""
from __future__ import annotations

import itertools
import json
import os
import secrets
import socket
import sys
import threading
import time
from contextlib import ExitStack
from dataclasses import dataclass, field

from . import session_socket

IDLE_EXIT_S = 120.0
WAITING_EXIT_S = 3600.0
MAX_WINDOWLESS_S = 12 * 3600.0
# headless.ABANDONED_AFTER_S: the 15 minutes after which a window that has given no sign is gone.
SILENT_WINDOW_S = 15 * 60.0
CHECK_EVERY_S = 30.0
# A chat of the process no window claimed this long after an attach is closed if idle; one that is
# working is kept until its work is done, then closed IDLE_EXIT_S later.
UNCLAIMED_CHAT_S = 60.0
# A frame the client cannot take within this long ends the connection, so a stalled window makes
# the backend windowless rather than stalling every thread that emits.
SEND_TIMEOUT_S = 30.0
HANDSHAKE_TIMEOUT_S = 5.0
SCALE_ENV = "DGC_DETACH_TEST_SCALE"
ATTACH_MODES = ("auto", "restore", "steal")


def time_scale() -> float:
    """Tests shrink every windowless clock with ``DGC_DETACH_TEST_SCALE`` (0 < scale <= 1)."""
    try:
        value = float(os.environ.get(SCALE_ENV, "") or 1.0)
    except ValueError:
        return 1.0
    return value if 0.0 < value <= 1.0 else 1.0


def offered(env=None) -> bool:
    """Whether this process may keep running windowless: a platform whose socket peer we can
    check, and not an SDK session (isolated, or pinned to one project)."""
    env = os.environ if env is None else env
    return (session_socket.supported() and env.get("DGC_SDK_ISOLATED") != "1"
            and not (env.get("DGC_PROJECT_ROOT") or "").strip())


class NullSink:
    """Where the wire points while no window is attached: every frame still takes its seq."""

    def write(self, _text: str) -> None:
        pass

    def flush(self) -> None:
        pass


class SocketSink:
    """One attached window's end of the wire. A failed or timed-out send ends the connection (its
    reader then sees end of input and the backend becomes windowless); it never raises into the
    emitter, which holds the wire's lock."""

    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.dead = False

    def write(self, text: str) -> None:
        if self.dead:
            return
        try:
            self.sock.sendall(text.encode("utf-8"))
        except OSError:
            self.dead = True
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def flush(self) -> None:
        pass


# ------------------------------------------------------------------------------------- work ---
@dataclass
class Work:
    """What keeps a windowless backend alive, by kind (§5.2 of the plan)."""

    progressing: list = field(default_factory=list)
    standing: list = field(default_factory=list)
    waiting: list = field(default_factory=list)

    def kind(self) -> str:
        if self.progressing:
            return "progressing"
        if self.standing:
            return "standing"
        if self.waiting:
            return "waiting"
        return "none"

    def reason(self) -> str:
        found = self.progressing or self.standing or self.waiting
        return "; ".join(found[:3]) if found else ""

    def merge(self, other: "Work") -> "Work":
        for name in ("progressing", "standing", "waiting"):
            for item in getattr(other, name):
                if item not in getattr(self, name):
                    getattr(self, name).append(item)
        return self


def open_human_requests(chat) -> list[str]:
    """The approvals and questions this chat is waiting on, by id."""
    ui = getattr(chat, "ui", None)
    pending = getattr(chat, "pending", None)
    opened = getattr(ui, "__dict__", {}).get("_open_requests", {}) if ui is not None else {}
    found = []
    for rid in list(opened):
        try:
            if pending is None or pending.is_open(rid):
                found.append(rid)
        except Exception:
            continue
    return found


def chat_work(chat) -> Work:
    """One chat's work. Never raises: a state read that fails counts as work (stay rather than
    guess)."""
    work = Work()
    try:
        busy = bool(chat._busy())
    except Exception:
        busy = False
    waiting = open_human_requests(chat)
    foreground = getattr(chat, "_foreground_worker", None) is not None
    if busy:
        if waiting and not foreground:
            work.waiting.append("a turn is waiting for your answer")
        else:
            work.progressing.append("an operation is running" if foreground else "a turn is running")
    elif waiting:
        work.waiting.append("a question is waiting for your answer")
    try:
        queued = len(getattr(chat, "_queue", None) or [])
        if queued:
            work.progressing.append(f"{queued} queued prompt{'s' if queued != 1 else ''}")
    except Exception:
        pass
    agent = getattr(chat, "agent", None)
    try:
        if getattr(agent, "_detached_jobs", None):
            work.progressing.append("a background sub-agent is working")
        if any(getattr(run, "state", "") == "running"
               for run in (getattr(agent, "_troupes", None) or {}).values()):
            work.progressing.append("a troupe is working")
        if getattr(agent, "_finalizing", None):
            work.progressing.append("a sub-agent's work is being applied")
    except Exception:
        work.progressing.append("sub-agent state is unreadable")
    try:
        # A Pip fix this process runs for this chat is work from the moment it is queued: while its copy is
        # made ready and its dependencies install, no sub-agent exists yet to say so.
        from . import pip_fix
        session_of = getattr(chat, "_pip_fix_session", None)
        session_id = session_of() if callable(session_of) else ""
        if session_id and any(row.get("state") in pip_fix.ACTIVE
                              and (row.get("owner") or {}).get("token") == pip_fix._TOKEN
                              for row in pip_fix.for_session(agent.config.project_root, session_id)):
            work.progressing.append("a Pip fix is working")
    except Exception:
        work.progressing.append("Pip fix state is unreadable")
    reader = getattr(chat, "_package_reader", None)
    if isinstance(reader, threading.Thread) and reader.is_alive():
        work.progressing.append("a plugin is being installed")
    try:
        monitors = getattr(agent, "monitors", None)
        if monitors is not None and (monitors.running() or monitors.pending_count()):
            work.standing.append("watchers are armed")
    except Exception:
        work.standing.append("watcher state is unreadable")
    try:
        items = chat._background_items() if hasattr(chat, "_background_items") else []
        running = sum(1 for item in items if item.get("state") == "running")
        if running:
            work.standing.append(f"{running} background command{'s' if running != 1 else ''} running")
    except Exception:
        pass
    return work


# What a backend that opted in counts as its work: everything (a session's backend), or only ChatDGC's
# replies (the Sessions home's, set_detach_chatdgc).
SCOPE_ALL, SCOPE_CHATDGC = "", "chatdgc"


def chatdgc_work(host) -> Work:
    """ChatDGC's work: a reply (or deep research, a summary, a card being sent) under way in any chat; a chat this
    window took mid-reply, still on its way here; a window of another DGC that took one of this process's chats."""
    work = Work()
    chatdgc = getattr(host, "_chatdgc", None)
    try:
        turns = len(getattr(chatdgc, "_turns", None) or {}) if chatdgc is not None else 0
        if turns:
            work.progressing.append("a ChatDGC reply is being written" if turns == 1
                                    else f"{turns} ChatDGC replies are being written")
        if chatdgc is not None and getattr(chatdgc, "_remote", None):
            work.progressing.append("a ChatDGC chat is moving here from another window")
        if chatdgc is not None and getattr(chatdgc, "_links", None):
            work.standing.append("another window is showing a ChatDGC reply written here")
    except Exception:
        work.progressing.append("ChatDGC state is unreadable")
    return work


def host_work(host, scope: str = SCOPE_ALL) -> Work:
    if scope == SCOPE_CHATDGC:
        return chatdgc_work(host)
    work = Work()
    for chat in list(getattr(host, "chats", {}).values()):
        work.merge(chat_work(chat))
    return work.merge(chatdgc_work(host))


def _forget_editor(host) -> None:
    """The wire changed hands (or no window has it): which editor named itself is no longer true (dgc/holder_note.py)."""
    forget = getattr(host, "forget_editor", None)
    if callable(forget):
        try:
            forget()
        except Exception:
            pass


def _duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds < 90:
        return f"{seconds}s"
    minutes = seconds // 60
    if minutes < 90:
        return f"{minutes}m"
    return f"{minutes // 60}h {minutes % 60}m"


# ------------------------------------------------------------------------------- connections ---
class Connection:
    _ids = itertools.count(1)

    def __init__(self, kind: str, sink, sock: socket.socket | None = None, client: str = ""):
        self.id = next(self._ids)
        self.kind = kind                   # "stdio" (the editor that started us) or "socket"
        self.sink = sink
        self.sock = sock
        self.client = client
        self.reader = sock.makefile("rb") if sock is not None else None
        self.closed = False

    def close(self) -> None:
        """Shut the socket down, which ends a read blocked on it. The reader itself is closed by its
        own thread: closing a BufferedReader from another thread waits on the lock a blocked
        ``readline`` holds."""
        if self.closed:
            return
        self.closed = True
        if self.sock is not None:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                self.sock.close()
            except OSError:
                pass


@dataclass
class Ending:
    cause: str
    grace: float
    shutdown: bool = False


class _Detached(Exception):
    """The window said it is going (`detach`): stop reading its pipe."""


class Switchboard:
    """Which connection the wire belongs to, and how long the process lives without one."""

    def __init__(self, host, *, log=None, wake=None, clock=time.monotonic, wall=time.time,
                 identity=None, home=None, scale=None, stdout=None, check_every=None,
                 stand_down_grace=8.0, shutdown_grace=20.0, new_session=False):
        self.host = host
        self.log = log or (lambda _line: None)
        self.wake = wake                    # gets the main thread out of a blocked stdin read
        self.clock, self.wall = clock, wall
        self.identity = identity or session_socket.peer_identity
        self._home = home
        scale = time_scale() if scale is None else float(scale)
        self.idle_exit_s = IDLE_EXIT_S * scale
        self.waiting_exit_s = WAITING_EXIT_S * scale
        self.max_windowless_s = MAX_WINDOWLESS_S * scale
        # A connection whose window has said nothing this long is treated as gone (the 25-hour
        # stranded session: an extension host left behind by a reload keeps pinging for ever).
        self.silent_window_s = SILENT_WINDOW_S * scale
        self.unclaimed_chat_s = UNCLAIMED_CHAT_S * scale
        self.check_every = max(0.1, CHECK_EVERY_S * scale) if check_every is None else check_every
        self.stand_down_grace, self.shutdown_grace = stand_down_grace, shutdown_grace
        self.new_session = new_session             # serve() only: leave the editor's process group
        self.instance = secrets.token_hex(8)
        self.lock = threading.RLock()
        # Every command, from whichever connection, runs under this: only one connection is current,
        # but the one being replaced may still be in the middle of one.
        self.dispatch_lock = threading.RLock()
        self.stdio = Connection("stdio", stdout if stdout is not None else sys.stdout)
        self.current: Connection | None = self.stdio
        self.opted_in = False
        self.scope = SCOPE_ALL                      # what counts as work once opted in (set_detach_chatdgc)
        self.windowless_since: float | None = None
        self.windowless_wall: float | None = None
        self.windowless_cause = ""
        self._idle_since: float | None = None
        self._waiting_since: float | None = None
        self._stopped = threading.Event()
        self.ending: Ending | None = None
        self.exit = threading.Event()
        self.listener: socket.socket | None = None
        self.socket_path = ""
        self._redirected = False
        self._attached_at: float | None = None
        self._unclaimed: dict[str, float] = {}     # chat id -> when its work was last seen
        self.attaches = 0
        self.main_in_read = lambda: False           # serve() says when a wake would interrupt a read

    # ------------------------------------------------------------------ capability / opt-in ---
    def home(self):
        if self._home is not None:
            return self._home
        from .config import dgc_home
        return dgc_home()

    def capability(self) -> dict:
        # chatdgc: set_detach_chatdgc is understood (the Sessions home's backend keeps a ChatDGC reply running).
        # chatdgc_open_here: chatdgc_shown and chatdgc_open_here are (one window writes to a chat at a time).
        return {"version": 1, "idle_exit_s": int(self.idle_exit_s),
                "waiting_exit_s": int(self.waiting_exit_s),
                "max_windowless_s": int(self.max_windowless_s), "chatdgc": 1, "chatdgc_open_here": 1}

    def work(self) -> Work:
        """This process's work, as the window that opted in counts it."""
        return host_work(self.host, self.scope)

    def opt_in(self, keep_running: bool = True, scope: str = SCOPE_ALL) -> bool:
        """``set_detach``: from now on a window that goes leaves this process running. ``set_detach_chatdgc``
        is the same with ``scope`` "chatdgc": only a ChatDGC reply keeps it running."""
        with self.lock:
            if not keep_running:
                self.opted_in = False
                self.scope = SCOPE_ALL
                self._close_listener()
                self.host.announce_peers()
                return True
            if self.opted_in:
                self.scope = scope
                return True
            if not offered():
                return False
            bound = session_socket.bind(self.home(), os.getpid(), self.instance)
            if bound is None:
                self.log("detach unavailable: no private socket could be made")
                return False
            self.listener, path = bound
            self.socket_path = str(path)
            self.opted_in = True
            self.scope = scope
        # Out of the editor's process group: a window that goes must not take us with a group kill.
        if self.new_session:
            try:
                if os.getpgid(0) != os.getpid():
                    os.setsid()
            except (OSError, AttributeError):
                pass
        threading.Thread(target=self._accept_loop, name="dgc-attach-accept", daemon=True).start()
        threading.Thread(target=self._clock_loop, name="dgc-windowless-clock", daemon=True).start()
        self.log(f"detach on: a window that goes leaves this backend running; socket {self.socket_path}")
        self.host.announce_peers()
        return True

    def close(self) -> None:
        """The process is on its way out: no new window can attach."""
        self._close_listener()

    def _close_listener(self) -> None:
        listener, self.listener = self.listener, None
        if listener is not None:
            try:
                listener.close()
            except OSError:
                pass
        if self.socket_path:
            try:
                os.unlink(self.socket_path)
            except OSError:
                pass

    def note_fields(self) -> dict:
        """What the peer note says about this, for `dgc ps` and the relay. A file, not the protocol:
        new fields here cost nothing."""
        from . import __version__
        from .editor_protocol import PROTOCOL_VERSION
        # No lock: this is called from threads that may hold a turn's lock, and an attach takes
        # this switchboard's lock before the turns'. Each read is of one reference.
        attached = self.current is not None
        since = self.windowless_wall
        fields = {"version": __version__, "protocol_version": PROTOCOL_VERSION,
                  "attached": attached, "started_at": _STARTED_AT}
        if self.opted_in and self.socket_path:
            fields.update(socket=self.socket_path, instance=self.instance)
        if not attached and since is not None:
            fields["windowless_since"] = since
        if self.opted_in and self.scope:
            fields["detach_scope"] = self.scope
        try:
            fields["work"] = self.work().reason()
        except Exception:
            fields["work"] = ""
        chatdgc = getattr(self.host, "_chatdgc", None)
        try:
            answering = chatdgc.answering() if chatdgc is not None else []
        except Exception:
            answering = []
        if answering:
            fields["chatdgc"] = answering             # the chats it is answering: dgc ps, Running sessions
        try:
            held = chatdgc.held_here() if chatdgc is not None and self.opted_in and self.socket_path else None
        except Exception:
            held = None
        if held is not None:
            # The chats it holds (Open here): another window's DGC shows them read-only and asks for one over the
            # socket (chatdgc_take). Only once its window said what it shows: an older editor holds nothing.
            fields["chatdgc_held"] = held
            fields["chatdgc_take"] = 1
            try:
                if chatdgc.locking():
                    # It holds each of them by its lock (dgc/chatdgc/held.py). A note without this is one that holds
                    # chats by the note alone (an older DGC, or none could be locked): it counts even beside a lock.
                    fields["chatdgc_locks"] = 1
            except Exception:
                pass
        return fields

    # -------------------------------------------------------------------------- the wire ---
    def is_current(self, conn: Connection) -> bool:
        return self.current is conn

    @property
    def windowless(self) -> bool:
        return self.current is None

    def keeps_running(self, shutdown_requested: bool) -> bool:
        return self.opted_in and not shutdown_requested and not self.exit.is_set()

    def _redirect_stdio(self) -> None:
        """Our stdout and stderr were the editor's pipes. Once that editor is gone, a write there --
        ours, or a child's that inherited them -- would die of SIGPIPE. Point both at serve.log."""
        if self._redirected:
            return
        self._redirected = True
        try:
            sys.stdout.flush()
        except Exception:
            pass
        try:
            sys.stderr.flush()
        except Exception:
            pass
        target = -1
        try:
            logs = self.home() / "logs"
            logs.mkdir(parents=True, exist_ok=True)
            target = os.open(str(logs / "serve.log"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        except OSError:
            try:
                target = os.open(os.devnull, os.O_WRONLY)
            except OSError:
                return
        try:
            for fd in (1, 2):
                try:
                    os.dup2(target, fd)
                except OSError:
                    pass
        finally:
            os.close(target)
        global STDERR_IS_LOG
        STDERR_IS_LOG = True

    def go_windowless(self, conn: Connection, cause: str, *, farewell: tuple | None = None) -> bool:
        """The window ``conn`` belongs to has gone. True when the process stays up for its work.

        ``farewell`` (type, fields) is the last frame that connection gets: a window that only went
        quiet, and is in fact still there, is told it was let go rather than left talking to nobody."""
        with self.lock:
            if self.current is not conn:
                return False
            self.current = None
            self.host.core.switch(NullSink(), farewell=farewell)
            _forget_editor(self.host)                  # no window names itself now
            self.windowless_since = self.clock()
            self.windowless_wall = self.wall()
            self.windowless_cause = cause
            self._idle_since = self._waiting_since = None
            self._attached_at = None
        chatdgc = getattr(self.host, "_chatdgc", None)
        if chatdgc is not None and hasattr(chatdgc, "window_gone"):
            try:
                chatdgc.window_gone()                  # its tabs show nothing now: only what it writes is held
            except Exception:
                pass
        if conn.kind == "stdio":
            self._redirect_stdio()
        else:
            conn.close()
        work = self.work()
        self.log(f"windowless: {cause}; work: {work.reason() or 'none'}")
        self.host.announce_peers()
        if work.kind() == "none":
            # Nothing was running: exactly as before, save and go. A reload reopens from disk.
            self.request_exit(f"{cause}, with nothing running", self.shutdown_grace)
            return False
        return True

    def request_exit(self, cause: str, grace: float, *, shutdown: bool = False) -> None:
        with self.lock:
            if self.exit.is_set():
                return
            self.ending = Ending(cause=cause, grace=float(grace), shutdown=shutdown)
            self.exit.set()
        self._close_listener()
        if self.wake is not None and self.main_in_read():
            try:
                self.wake()
            except Exception:
                pass

    def wait(self, liveness=None) -> Ending:
        """The main thread, once its own pipe is done: wait for the process's end."""
        while not self.exit.wait(0.5):
            if liveness is not None and getattr(liveness, "abandoned", False):
                from .headless import _liveness_end_cause
                stood = bool(getattr(liveness, "stood_down", False))
                self.request_exit(_liveness_end_cause(liveness),
                                  self.stand_down_grace if stood else self.shutdown_grace)
        return self.ending or Ending("the backend was asked to stop", self.shutdown_grace)

    # ------------------------------------------------------------------- commands -----------
    def command(self, conn: Connection, cmd: dict) -> bool:
        """The connection-level commands. True when ``cmd`` was one (and is handled)."""
        kind = cmd.get("type")
        if kind not in ("set_detach", "set_detach_chatdgc", "detach"):
            return False
        from .editor_protocol import command_error
        problem = command_error(cmd)
        if problem:
            self._reject(cmd, "invalid_command", f"invalid command: {problem}")
            return True
        if kind in ("set_detach", "set_detach_chatdgc"):
            scope = SCOPE_CHATDGC if kind == "set_detach_chatdgc" else SCOPE_ALL
            if not self.opt_in(bool(cmd.get("keep_running", True)), scope):
                self._reject(cmd, "unsupported", "this backend cannot keep running without a window here")
            return True
        if not self.opted_in:
            raise _ShutdownRequested()           # never opted in: `detach` is a plain shutdown
        self.go_windowless(conn, "the editor said its window is going")
        raise _Detached()

    def _reject(self, cmd: dict, reason: str, message: str) -> None:
        try:
            self.host._reject(cmd, reason, message)
        except Exception:
            pass

    # ------------------------------------------------------------------- accept / attach ---
    def _accept_loop(self) -> None:
        while True:
            listener = self.listener
            if listener is None:
                return
            try:
                sock, _addr = listener.accept()
            except OSError:
                if self.listener is None or self.exit.is_set():
                    return
                time.sleep(0.2)
                continue
            threading.Thread(target=self._greet, args=(sock,), name="dgc-attach-hello",
                             daemon=True).start()

    def _greet(self, sock: socket.socket) -> None:
        uid, _pid = self.identity(sock)
        if uid is None or uid != os.getuid():
            self.log(f"refused a connection to the attach socket from uid {uid}")
            try:
                sock.close()
            except OSError:
                pass
            return
        try:
            sock.settimeout(HANDSHAKE_TIMEOUT_S)
            hello = session_socket.read_line(sock)
            sock.settimeout(None)
        except OSError:
            hello = None
        if not isinstance(hello, dict):
            self._close(sock)
            return
        kind = hello.get("type")
        try:
            if kind == "attach":
                self._attach(sock, hello)
                return
            if kind == "chatdgc_take":
                self._chatdgc_take(sock, hello)     # it closes the socket itself once the chat is let go
                return
            if kind == "stop":
                self._stop(sock, hello)
            elif kind == "status":
                session_socket.send_line(sock, {"type": "status", **self.status()})
        except OSError:
            pass
        self._close(sock)

    @staticmethod
    def _close(sock: socket.socket) -> None:
        try:
            sock.close()
        except OSError:
            pass

    def status(self) -> dict:
        work = self.work()
        with self.lock:
            windowless = self.current is None
            since = self.windowless_since
        return {"pid": os.getpid(), "instance": self.instance, "attached": not windowless,
                "windowless_s": int(self.clock() - since) if windowless and since is not None else 0,
                "work": work.reason(), "work_kind": work.kind()}

    def _on_screen(self, mode: str = "restore") -> tuple[bool, float]:
        """Whether the attached window's chat panel shows this session, and how long it has been quiet.

        A reload (``restore``) judges it on two missed heartbeats, the panel's own definition of on
        screen, so the window a reload left behind is taken within 40 seconds. Any other automatic
        attach (a session opened from a list, a restart) is more careful: a window whose renderer
        spoke in the last two minutes may only be in the background, and only "Open here" takes it."""
        liveness = getattr(self.host, "_editor_liveness", None)
        if liveness is None:
            return False, 0.0
        try:
            on_screen = bool(liveness.renderer_on_screen())
        except Exception:
            on_screen = False
        last = getattr(liveness, "_last_renderer", None)
        quiet = time.monotonic() - last if isinstance(last, (int, float)) else 0.0
        if not on_screen and mode == "auto" and isinstance(last, (int, float)):
            closed = getattr(liveness, "_view_closed_at", None)
            from .headless import TAKEOVER_SILENCE_S
            on_screen = (closed is None or closed < last) and quiet < TAKEOVER_SILENCE_S
        return on_screen, quiet

    def _chatdgc_take(self, sock: socket.socket, hello: dict) -> None:
        """Another window's Open here asks for one ChatDGC chat this process holds (dgc/chatdgc/service.py)."""
        chatdgc = getattr(self.host, "_chatdgc", None)
        try:
            if hello.get("instance") != self.instance:
                session_socket.send_line(sock, {"type": "refused", "reason": "instance"})
            elif not self.opted_in or self.exit.is_set():
                session_socket.send_line(sock, {"type": "refused", "reason": "exiting"})
            elif chatdgc is None or not hasattr(chatdgc, "take"):
                session_socket.send_line(sock, {"type": "refused", "reason": "not_here"})
            else:
                session_socket.set_send_timeout(sock, SEND_TIMEOUT_S)
                chatdgc.take(sock, hello)
        except OSError:
            pass
        finally:
            self._close(sock)

    def _stop(self, sock: socket.socket, hello: dict) -> None:
        if hello.get("instance") != self.instance:
            session_socket.send_line(sock, {"type": "refused", "reason": "instance"})
            return
        if hello.get("unless_on_screen") and self.current is not None and self._on_screen()[0]:
            session_socket.send_line(sock, {"type": "refused", "reason": "on_screen"})
            return
        reason = str(hello.get("reason") or "dgc stop")[:200]
        session_socket.send_line(sock, {"type": "stopping", "pid": os.getpid()})
        self.log(f"stop asked over the socket: {reason}")
        self.request_exit(f"{reason} stopped it", self.shutdown_grace)

    def refusal(self, hello: dict) -> tuple[str, dict]:
        """Why an attach is refused ("" when it is not), and what to say with it."""
        from . import __version__
        from .editor_protocol import PROTOCOL_VERSION
        if not self.opted_in or self.exit.is_set():
            return "exiting", {}
        if hello.get("instance") != self.instance:
            return "instance", {}
        if hello.get("protocol_version") != PROTOCOL_VERSION or hello.get("version") != __version__:
            return "version", {"version": __version__}
        if self.host.chat_for_session(str(hello.get("session") or "")) is None:
            return "not_here", {}
        mode = hello.get("mode") if hello.get("mode") in ATTACH_MODES else "auto"
        if self.current is not None and mode != "steal":
            on_screen, quiet = self._on_screen(mode)
            if on_screen:
                return "on_screen", {"quiet_s": round(quiet, 1)}
        return "", {}

    def _attach(self, sock: socket.socket, hello: dict) -> None:
        with self.lock:
            reason, detail = self.refusal(hello)
            if reason:
                session_socket.send_line(sock, {"type": "refused", "reason": reason, **detail})
                self._close(sock)
                return
            session_socket.set_send_timeout(sock, SEND_TIMEOUT_S)
            session_socket.send_line(sock, {"type": "attached", "pid": os.getpid()})
            mode = hello.get("mode") if hello.get("mode") in ATTACH_MODES else "auto"
            conn = Connection("socket", SocketSink(sock), sock, client=str(hello.get("client") or "")[:64])
            previous = self.current
            windowless_s = (self.clock() - self.windowless_since
                            if previous is None and self.windowless_since is not None else 0.0)
            chat = self.host.chat_for_session(str(hello.get("session") or ""))
            self._switch_to(conn, chat, previous, windowless_s)
            self.current = conn
            self.windowless_since = self.windowless_wall = None
            self._idle_since = self._waiting_since = None
            self._attached_at = self.clock()
            self._unclaimed = {}
            self.attaches += 1
        liveness = getattr(self.host, "_editor_liveness", None)
        if liveness is not None and hasattr(liveness, "attached"):
            liveness.attached()
        if previous is not None:
            if previous.kind == "stdio":
                self._redirect_stdio()
            else:
                previous.close()
        took = "from a window that was still connected" if previous is not None else (
            f"after {_duration(windowless_s)} with no window")
        how = {"steal": "Open here", "restore": "a reload"}.get(mode, "opened from a list")
        self.log(f"attached by {conn.client or 'a window'} ({how}), {took}")
        self.host.announce_peers()
        threading.Thread(target=self._read_connection, args=(conn,), name=f"dgc-attach-{conn.id}",
                         daemon=True).start()

    def live_state(self, chat) -> dict:
        """What `session_live` says about one chat: its session, folder, running turn, queue."""
        agent = getattr(chat, "agent", None)
        session_file = getattr(agent, "session_file", None)
        live = getattr(chat, "_live_turn", None) if getattr(chat, "_running_turn_kind", "") else None
        turn = None
        if isinstance(live, dict) and live.get("id"):
            turn = {"turn_id": str(live.get("id")), "kind": str(live.get("kind") or "prompt"),
                    "prompt": str(live.get("prompt") or "")[:4000],
                    "started_at": float(live.get("started_at") or 0.0)}
        queued = []
        for item in list(getattr(chat, "_queue", None) or [])[:32]:
            request_id = item[4] if len(item) > 4 and isinstance(item[4], str) else ""
            if not request_id:
                continue
            kind = item[3] if len(item) > 3 else "prompt"
            if kind in ("monitor", "wake", "pip_setup", "resume"):
                continue
            queued.append({"request_id": request_id[:128], "text": str(item[0] or "")[:50_000]})
        return {"session_id": session_file.stem if session_file else "",
                "cwd": str(getattr(getattr(chat, "config", None), "project_root", "") or ""),
                "turn": turn, "queued": queued, "waiting": open_human_requests(chat)}

    def _switch_to(self, conn: Connection, chosen, previous, windowless_s: float) -> None:
        """Hand the wire to ``conn``: the old window hears ``session_moved``, the new one's first
        frame is ``ready``. All of it under every chat's turn-state lock and the wire's lock, so no
        turn can start or end between what `ready` says and what the new window sees next."""
        host = self.host
        chats = [chosen] + [chat for chat in list(host.chats.values()) if chat is not chosen]
        core = host.core
        with ExitStack() as stack:
            for chat in chats:
                stack.enter_context(chat._turn_state_lock())
                lock = getattr(chat.em, "history_lock", None)
                if lock is not None:
                    stack.enter_context(lock)
            states = [(chat, self.live_state(chat)) for chat in chats]
            work = self.work()
            payload = chosen._ready_payload()
            payload.update(chosen._chat_fields())
            caps = dict(payload.get("capabilities") or {})
            caps["attached"] = {
                "chats": [{"chat_id": chat.chat_id, **state} for chat, state in states],
                "windowless_s": int(windowless_s), "work": work.reason(),
                "pid": os.getpid()}
            payload["capabilities"] = caps
            tag = bool(getattr(core, "tag_chats", False))
            frames = [("ready", payload)]
            for chat, _state in states[1:]:
                opened = dict(chat._chat_fields())
                opened["request_id"] = "attached"
                if tag:
                    opened["chat_id"] = chat.chat_id
                frames.append(("chat_opened", opened))
            for chat, state in states:
                fields = dict(state)
                if tag:
                    fields["chat_id"] = chat.chat_id
                frames.append(("session_live", fields))
            farewell = ("session_moved", {"reason": "opened_elsewhere"}) if previous is not None else None
            core.switch(conn.sink, farewell=farewell, first=frames)
            host.wire_default = chosen
            # The editor that named itself was the window just let go: the new one says its own (editor_app).
            _forget_editor(host)

    # -------------------------------------------------------------------- a socket client ---
    def _read_connection(self, conn: Connection) -> None:
        from .headless import _command_lines, _Shutdown
        from .protocol import strict_json_loads
        host = self.host
        liveness = getattr(host, "_editor_liveness", None)
        cause = "the editor's connection closed"
        try:
            for line, problem in _command_lines(conn.reader):
                if not self.is_current(conn):
                    return
                if problem:
                    host.em.emit("error", message=problem)
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    cmd = strict_json_loads(line)
                except (ValueError, json.JSONDecodeError):
                    host.em.emit("error", message="invalid JSON command line")
                    continue
                if not isinstance(cmd, dict):
                    host.em.emit("error", message="command must be a JSON object")
                    continue
                if liveness is not None:
                    liveness.saw_command()
                try:
                    with self.dispatch_lock:
                        if not self.is_current(conn):
                            return
                        if not self.command(conn, cmd):
                            host.dispatch(cmd)
                except _Detached:
                    return
                except (_Shutdown, _ShutdownRequested):
                    self.request_exit("the editor asked us to shut down", 0.0, shutdown=True)
                    return
                except Exception as exc:          # one bad command must not end the connection
                    detail = str(exc).strip() or exc.__class__.__name__
                    try:
                        host.em.emit("error", message=f"Command '{cmd.get('type', '?')}' failed — {detail}")
                    except Exception:
                        pass
                    failed = getattr(host, "command_failed", None)
                    if callable(failed):
                        failed(cmd, exc)
        except (OSError, ValueError):
            cause = "the editor's connection failed"
        finally:
            if self.is_current(conn):
                self.go_windowless(conn, cause)
            else:
                conn.close()
            try:
                conn.reader.close()
            except Exception:
                pass

    # ------------------------------------------------------------------- the clock ---------
    def _clock_loop(self) -> None:
        while not self.exit.wait(self.check_every):
            try:
                self.check()
            except Exception as exc:              # the clock must never be what ends a session
                self.log(f"windowless clock failed: {exc!r}")

    def check(self) -> str:
        """One look at the lifetime rules. Returns the rule that ended the process, or ""."""
        if self.exit.is_set():
            return ""
        now = self.clock()
        with self.lock:
            since = self.windowless_since
            attached_at = self._attached_at
        if since is None:
            if attached_at is not None and now - attached_at >= self.unclaimed_chat_s:
                self._close_unclaimed(now)
            return self._check_silent_window()
        elapsed = now - since
        if elapsed >= self.max_windowless_s:
            rule = f"it ran {_duration(elapsed)} with no window open, the most a session may"
            self.log(f"windowless exit: the {_duration(self.max_windowless_s)} limit for a session with no "
                     f"window, after {_duration(elapsed)}; work: {self.work().reason() or 'none'}")
            self.request_exit(rule, self.shutdown_grace)
            return "max_windowless"
        work = self.work()
        kind = work.kind()
        if kind in ("progressing", "standing"):
            self._idle_since = self._waiting_since = None
            return ""
        if kind == "waiting":
            self._idle_since = None
            if self._waiting_since is None:
                self._waiting_since = now
            if now - self._waiting_since >= self.waiting_exit_s:
                self.log(f"windowless exit: waited {_duration(now - self._waiting_since)} for an answer, "
                         f"after {_duration(elapsed)} with no window")
                # No grace: the turn stops at the question, and the chat's Continue picks it up.
                self.request_exit(f"it waited {_duration(now - self._waiting_since)} for your answer "
                                  "with no window open", 0.0)
                return "waiting"
            return ""
        self._waiting_since = None
        if self._idle_since is None:
            self._idle_since = now
        if now - self._idle_since >= self.idle_exit_s:
            self.log(f"windowless exit: no work for {_duration(now - self._idle_since)}, "
                     f"after {_duration(elapsed)} with no window")
            self.request_exit(f"no work for {_duration(now - self._idle_since)} with no window",
                              self.shutdown_grace)
            return "idle"
        return ""

    def _check_silent_window(self) -> str:
        """A window that has given no sign for 15 minutes is gone, whatever its host still says.

        The 25-hour stranded session: an extension host a reload left behind kept pinging, so the
        backend it started kept its session for as long as that host lived. Here its connection
        becomes windowless instead, and the windowless rules decide from then on (2 minutes with no
        work, 1 hour waiting on an answer, 12 hours at most). If the window is in fact still there it
        hears ``session_moved`` and offers Open here."""
        liveness = getattr(self.host, "_editor_liveness", None)
        reader = getattr(liveness, "window_silence", None)
        conn = self.current
        if conn is None or not callable(reader):
            return ""
        try:
            silence, why = reader()
        except Exception:
            return ""
        if silence < self.silent_window_s:
            return ""
        if self.scope and self.work().kind() == "none" and host_work(self.host).kind() != "none":
            # The Sessions home's backend with work of a session's kind but no ChatDGC reply: as before it opted in,
            # a silent window does not end it while that work runs (_EditorLiveness.working); once it ends, it does.
            return ""
        self.go_windowless(conn, f"{why} for {_duration(silence)}",
                           farewell=("session_moved", {"reason": "no_window"}))
        return "silent_window"

    def _close_unclaimed(self, now: float) -> None:
        """After an attach, a chat no window took back: closed once it has nothing to do."""
        host = self.host
        touched = getattr(host, "touched", {})
        attached_at = self._attached_at or now
        default = getattr(host, "wire_default", None) or getattr(host, "default", None)
        for chat in list(host.chats.values()):
            if chat is default or chat is getattr(host, "default", None):
                continue
            if touched.get(chat.chat_id, 0.0) >= attached_at:
                self._unclaimed.pop(chat.chat_id, None)
                continue
            if chat_work(chat).kind() != "none":
                self._unclaimed[chat.chat_id] = now
                continue
            idle_since = self._unclaimed.get(chat.chat_id)
            if idle_since is not None and now - idle_since < self.idle_exit_s:
                continue
            self.log(f"closing chat {chat.chat_id}: no window took it back after an attach, and it is idle")
            try:
                host.close_unclaimed(chat.chat_id)
            except Exception:
                pass


class _ShutdownRequested(Exception):
    """`detach` from a client that never opted in: the old meaning, stop."""


_STARTED_AT = time.time()
STDERR_IS_LOG = False


# ------------------------------------------------------------ a turn stopped with no window ---
# A turn the process stopped while no window was attached (an hour waiting on an answer, the
# twelve-hour limit, `dgc stop`) never had its end seen by any editor, so no editor can know to
# offer Continue. The process says so beside the session; the next window to open it hears
# `turn_interrupted` after the replay and offers Continue. The next turn in the session clears it.
INTERRUPTED_SUFFIX = ".interrupted"


def _interrupted_path(session_file):
    path = os.fspath(session_file or "")
    return path[:-5] + INTERRUPTED_SUFFIX if path.endswith(".json") else ""


def record_interrupted(session_file, cause: str, now: float | None = None) -> None:
    path = _interrupted_path(session_file)
    if not path or not os.path.exists(os.fspath(session_file)):
        return
    try:
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"at": time.time() if now is None else now, "cause": str(cause)[:400]}, handle)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except OSError:
        pass


def interrupted(session_file) -> dict | None:
    path = _interrupted_path(session_file)
    try:
        if not path or os.path.islink(path) or os.path.getsize(path) > 4096:
            return None
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get("at"), (int, float)):
        return None
    return {"at": float(value["at"]), "cause": str(value.get("cause") or "")[:400]}


def forget_interrupted(session_file) -> None:
    path = _interrupted_path(session_file)
    if path:
        try:
            os.unlink(path)
        except OSError:
            pass


# --------------------------------------------------------------------------- dgc ps / stop ---
def live_processes(*, here: int | None = None, now: float | None = None) -> list[dict]:
    """Every DGC process that left a note (this one included when ``here`` is its pid), as rows
    for `dgc ps`, Settings -> Running sessions and the side bar."""
    from . import peers
    moment = time.time() if now is None else now
    rows = []
    records = peers.others(here=False, now=now)
    if here is not None:
        try:
            mine = json.loads((peers.peers_dir() / f"{int(here)}.json").read_text(encoding="utf-8"))
            if isinstance(mine, dict):
                mine["liveness"] = "live"
                records.insert(0, mine)
        except (OSError, ValueError):
            pass
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("pid"), int):
            continue
        sessions = []
        for place in peers._places(record)[: peers.MAX_NOTE_SESSIONS + 1]:
            path = str(place.get("session") or "")
            if not path:
                continue
            stem = os.path.splitext(os.path.basename(path))[0]
            if any(item["session_id"] == stem for item in sessions):
                continue
            sessions.append({"session_id": stem, "name": str(place.get("name") or "")[:200],
                             "cwd": str(place.get("cwd") or place.get("project_root") or ""),
                             "status": str(place.get("status") or "idle")})
        since = record.get("windowless_since")
        started = record.get("started_at")
        chats = []
        for item in (record.get("chatdgc") if isinstance(record.get("chatdgc"), list) else [])[:16]:
            if isinstance(item, dict) and str(item.get("conversation_id") or ""):
                chats.append({"conversation_id": str(item["conversation_id"])[:64],
                              "title": str(item.get("title") or "")[:200]})
        rows.append({
            "pid": record["pid"], "kind": str(record.get("kind") or ""),
            "instance": str(record.get("instance") or ""),
            "version": str(record.get("version") or ""),
            "attached": record.get("attached") is not False,
            "detachable": bool(record.get("socket")),
            "windowless_s": int(max(0.0, moment - float(since))) if isinstance(since, (int, float)) else 0,
            "uptime_s": int(max(0.0, moment - float(started))) if isinstance(started, (int, float)) else 0,
            "work": str(record.get("work") or "")[:400],
            "status": str(record.get("status") or ""),
            "liveness": str(record.get("liveness") or ""),
            "here": here is not None and record["pid"] == here,
            "sessions": sessions,
            # The Sessions home's backend ("chatdgc"): its own session holds nothing of yours; `chats` are the
            # ChatDGC chats it is answering.
            "scope": str(record.get("detach_scope") or "")[:32],
            "chats": chats,
        })
    return rows


def _process_alive(record: dict) -> bool:
    from . import peers
    return peers.liveness(record) != "gone"


def stop_process(record: dict, *, reason: str = "dgc stop", wait_s: float = 30.0,
                 force: bool = False, unless_on_screen: bool = False) -> tuple[bool, str]:
    """Stop one DGC process: over its socket when it has one (it saves first), then SIGTERM (handled,
    and it saves too), and SIGKILL only with ``force``. Returns (stopped, what happened)."""
    import signal
    pid = record.get("pid")
    if not isinstance(pid, int) or pid <= 0 or pid == os.getpid():
        return False, "not a process this can stop"
    asked = ""
    path, instance = record.get("socket"), record.get("instance")
    if path and instance:
        try:
            sock = session_socket.connect(str(path), expect_pid=pid, timeout=5.0)
            try:
                session_socket.send_line(sock, {"type": "stop", "instance": instance, "reason": reason,
                                                "unless_on_screen": bool(unless_on_screen)})
                answer = session_socket.read_line(sock) or {}
            finally:
                sock.close()
            if answer.get("type") == "refused":
                return False, ("its window is on screen" if answer.get("reason") == "on_screen"
                               else f"it refused ({answer.get('reason')})")
            if answer.get("type") == "stopping":
                asked = "asked it to stop over its socket"
        except OSError:
            asked = ""
    deadline = time.monotonic() + max(0.0, wait_s)
    if asked:
        while time.monotonic() < deadline and _process_alive(record):
            time.sleep(0.2)
        if not _process_alive(record):
            return True, asked + "; it saved and stopped"
    if not _process_alive(record):
        return True, "it had already stopped"
    from . import peers
    if peers.liveness(record) != "live":
        # A pid alone is not identity: never signal a process we cannot prove is that DGC.
        return False, "this computer cannot confirm that process is still the DGC that left the note"
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True, "it had already stopped"
    except OSError as exc:
        return False, f"could not signal it: {exc}"
    end = time.monotonic() + 25.0
    while time.monotonic() < end and _process_alive(record):
        time.sleep(0.2)
    if not _process_alive(record):
        return True, (asked + "; " if asked else "") + "sent SIGTERM; it saved and stopped"
    if force:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        time.sleep(0.3)
        return not _process_alive(record), "sent SIGKILL"
    return False, "it is still finishing; run again with --force to end it now"
