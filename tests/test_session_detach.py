"""A `dgc serve` keeps running when its window goes, and a new window reattaches to it.

Unit tests drive dgc/serve_detach.py with a fake clock and a fake host: the lifetime rules (2
minutes after the work ends, 1 hour waiting on an answer, 12 hours at most), what counts as work,
the wire switch, and the socket's permissions. The integration tests start real `python -m dgc
serve` processes against a scripted model on 127.0.0.1, in a throwaway HOME: a turn that keeps
streaming across two reattaches with nothing lost or doubled, an approval re-sent with its id, the
idle exit, the hour's wait and the 12-hour cap with the clock shrunk (DGC_DETACH_TEST_SCALE),
`dgc ps` / `dgc stop`, two windows at once ("Open here"), an older version stopped and saved, and
an editor that never opts in getting exactly the old behaviour.
"""
from __future__ import annotations

import io
import json
import os
import queue
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from waiting import wait_until                              # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dgc import editor_protocol as ep                        # noqa: E402
from dgc import serve_detach, serve_relay, session_socket    # noqa: E402
from dgc.protocol import Emitter                             # noqa: E402

POSIX_SOCKETS = session_socket.supported()


# ------------------------------------------------------------------------------- fakes -------
class FakePending:
    def __init__(self):
        self.open = set()

    def is_open(self, rid):
        return rid in self.open


class FakeChat:
    def __init__(self, chat_id="c0", session="s-one"):
        self.chat_id = chat_id
        self.busy = False
        self.pending = FakePending()
        self.ui = SimpleNamespace()
        self.ui._open_requests = {}
        self._queue = []
        self._foreground_worker = None
        self._package_reader = None
        self.shells = []
        monitors = SimpleNamespace(running=lambda: self.monitors_running, pending_count=lambda: 0)
        self.monitors_running = 0
        self.agent = SimpleNamespace(_detached_jobs={}, _troupes={}, _finalizing={}, monitors=monitors,
                                     goal="", goal_status="none", session_file=Path(f"/x/{session}.json"))
        self.config = SimpleNamespace(project_root="/work")
        self._turn_lock = threading.RLock()
        self.em = SimpleNamespace(history_lock=threading.RLock())

    def _busy(self):
        return self.busy

    def _background_items(self):
        return self.shells

    def _turn_state_lock(self):
        return self._turn_lock

    def ask(self, rid="r1"):
        self.ui._open_requests[rid] = ("permission_request", {})
        self.pending.open.add(rid)


class FakeCore:
    def __init__(self):
        self.fp = io.StringIO()
        self.switched = []
        self.tag_chats = False

    def switch(self, fp, *, farewell=None, first=()):
        self.switched.append((fp, farewell, list(first)))
        old, self.fp = self.fp, fp
        return old


class FakeHost:
    def __init__(self, *chats):
        self.chats = {chat.chat_id: chat for chat in chats}
        self.core = FakeCore()
        self.announced = 0
        self._editor_liveness = None
        self._chatdgc = None
        self.rejected = []

    def announce_peers(self):
        self.announced += 1

    def _reject(self, cmd, reason, message):
        self.rejected.append((cmd.get("type"), reason))

    def chat_for_session(self, session_id):
        return next((c for c in self.chats.values() if c.agent.session_file.stem == session_id), None)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def board_for(host, clock, **kw):
    home = Path(tempfile.mkdtemp(prefix="dgc-detach-unit-"))
    board = serve_detach.Switchboard(host, clock=clock, home=home / ".dgc", scale=1.0,
                                     stdout=io.StringIO(), **kw)
    board._redirect_stdio = lambda: None          # never touch the test runner's own fds
    board.opted_in = True
    return board, home


# ----------------------------------------------------------------------- lifetime rules ---
class LifetimeRuleTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.chat = FakeChat()
        self.host = FakeHost(self.chat)
        self.board, home = board_for(self.host, self.clock)
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)

    def windowless(self):
        return self.board.go_windowless(self.board.stdio, "test window went")

    def test_nothing_running_when_the_window_goes_exits_at_once(self):
        self.assertFalse(self.windowless())
        self.assertTrue(self.board.exit.is_set())
        self.assertIn("nothing running", self.board.ending.cause)
        self.assertIsInstance(self.host.core.fp, serve_detach.NullSink)

    def test_two_minutes_after_the_work_finishes_it_exits_and_not_before(self):
        self.chat.busy = True
        self.assertTrue(self.windowless())
        self.clock.now += 3600
        self.assertEqual(self.board.check(), "")              # a running turn: no idle clock at all
        self.chat.busy = False                                # the turn ends
        self.assertEqual(self.board.check(), "")              # the idle clock starts here
        self.clock.now += serve_detach.IDLE_EXIT_S - 1
        self.assertEqual(self.board.check(), "")
        self.assertFalse(self.board.exit.is_set())
        self.clock.now += 2
        self.assertEqual(self.board.check(), "idle")
        self.assertTrue(self.board.exit.is_set())
        self.assertEqual(self.board.ending.grace, self.board.shutdown_grace)

    def test_new_work_resets_the_idle_clock(self):
        self.chat.busy = True
        self.windowless()
        self.chat.busy = False
        self.board.check()
        self.clock.now += serve_detach.IDLE_EXIT_S - 5
        self.chat._queue.append(("next", None, None, "prompt", "p2"))   # a queued prompt is work
        self.assertEqual(self.board.check(), "")
        self.chat._queue.clear()
        self.board.check()
        self.clock.now += serve_detach.IDLE_EXIT_S - 5
        self.assertEqual(self.board.check(), "")

    def test_an_open_approval_waits_an_hour_then_stops_with_no_grace(self):
        self.chat.busy = True
        self.chat.ask("r7")                                   # the turn is blocked on the user
        self.assertTrue(self.windowless())
        self.assertEqual(serve_detach.chat_work(self.chat).kind(), "waiting")
        self.board.check()
        self.clock.now += serve_detach.IDLE_EXIT_S * 10       # far past the idle rule: not idle
        self.assertEqual(self.board.check(), "")
        self.clock.now += serve_detach.WAITING_EXIT_S - serve_detach.IDLE_EXIT_S * 10 - 1
        self.assertEqual(self.board.check(), "")
        self.clock.now += 2
        self.assertEqual(self.board.check(), "waiting")
        self.assertEqual(self.board.ending.grace, 0.0)

    def test_an_approval_beside_progressing_work_is_not_waiting(self):
        self.chat.busy = True
        self.chat.ask("r1")
        self.chat.agent._detached_jobs = {"a1": object()}     # a background sub-agent still works
        self.assertEqual(serve_detach.chat_work(self.chat).kind(), "progressing")

    def test_twelve_hours_is_the_most_whatever_runs(self):
        for setup in (lambda: setattr(self.chat, "busy", True),
                      lambda: setattr(self.chat, "monitors_running", 1),
                      lambda: self.chat.shells.append({"state": "running"})):
            with self.subTest(setup=setup):
                self.chat.busy, self.chat.monitors_running, self.chat.shells = False, 0, []
                self.board.exit.clear()
                self.board.ending = None
                self.board.current = self.board.stdio
                setup()
                self.assertTrue(self.windowless())
                self.clock.now += serve_detach.MAX_WINDOWLESS_S - 1
                self.assertEqual(self.board.check(), "")
                self.clock.now += 2
                self.assertEqual(self.board.check(), "max_windowless")
                self.assertEqual(self.board.ending.grace, self.board.shutdown_grace)

    def test_what_counts_as_work(self):
        chat = FakeChat()
        self.assertEqual(serve_detach.chat_work(chat).kind(), "none")
        chat.agent.goal, chat.agent.goal_status = "ship it", "active"
        self.assertEqual(serve_detach.chat_work(chat).kind(), "none",
                         "a goal between turns runs nothing: it must not keep a windowless process up")
        chat.monitors_running = 1
        self.assertEqual(serve_detach.chat_work(chat).kind(), "standing")
        chat.monitors_running = 0
        chat.shells = [{"state": "ended"}, {"state": "running"}]
        self.assertEqual(serve_detach.chat_work(chat).kind(), "standing")
        chat.shells = []
        chat.agent._troupes = {"t": SimpleNamespace(state="running")}
        self.assertEqual(serve_detach.chat_work(chat).kind(), "progressing")
        chat.agent._troupes = {}
        chat._foreground_worker = object()
        chat.busy = True
        chat.ask()
        self.assertEqual(serve_detach.chat_work(chat).kind(), "progressing",
                         "a compact or rewind is running, not waiting")

    def test_a_chatdgc_reply_is_work(self):
        self.host._chatdgc = SimpleNamespace(_turns={"chat_1": {}})
        self.assertEqual(serve_detach.host_work(self.host).kind(), "progressing")


# ------------------------------------------------- a window that only went quiet (25-hour hole) ---
class SilentWindowTests(unittest.TestCase):
    """An extension host a reload left behind keeps pinging for ever: its window is judged on what the
    chat panel itself says, and 15 minutes of silence makes the connection windowless (the windowless
    rules then decide), with session_moved to a window that is in fact still there."""

    def setUp(self):
        self.clock = Clock()
        self.chat = FakeChat()
        self.host = FakeHost(self.chat)
        self.board, home = board_for(self.host, self.clock)
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        self.silence = (0.0, "")
        self.host._editor_liveness = SimpleNamespace(window_silence=lambda: self.silence)

    def test_fifteen_silent_minutes_make_the_connection_windowless_and_say_so(self):
        self.chat.busy = True
        self.silence = (serve_detach.SILENT_WINDOW_S - 1, "its window's chat panel stopped answering")
        self.assertEqual(self.board.check(), "")
        self.assertIs(self.board.current, self.board.stdio)
        self.silence = (serve_detach.SILENT_WINDOW_S + 1, "its window's chat panel stopped answering")
        self.assertEqual(self.board.check(), "silent_window")
        self.assertTrue(self.board.windowless)
        self.assertFalse(self.board.exit.is_set(), "a running turn keeps it up, now by the windowless rules")
        _fp, farewell, _first = self.host.core.switched[-1]
        self.assertEqual(farewell, ("session_moved", {"reason": "no_window"}))
        self.assertIn("stopped answering", self.board.windowless_cause)
        # From here the windowless rules apply: 12 hours at most.
        self.clock.now += serve_detach.MAX_WINDOWLESS_S + 1
        self.assertEqual(self.board.check(), "max_windowless")

    def test_a_silent_window_with_nothing_running_ends_as_before(self):
        self.silence = (serve_detach.SILENT_WINDOW_S + 1, "its editor stopped answering")
        self.assertEqual(self.board.check(), "silent_window")
        self.assertTrue(self.board.exit.is_set())
        self.assertIn("nothing running", self.board.ending.cause)

    def test_the_panels_word_counts_not_the_hosts_pings_unless_the_view_was_closed(self):
        from dgc import headless
        watch = headless._EditorLiveness(SimpleNamespace(), io.StringIO())
        self.assertEqual(watch.window_silence(), (0.0, ""), "an editor that never pinged is never judged")
        watch.pinged()
        watch.editor_state(source="renderer", view="open")
        watch._last_renderer -= 1000                        # the panel last spoke 1000s ago...
        watch.pinged()                                      # ...while its host keeps pinging
        quiet, why = watch.window_silence()
        self.assertGreaterEqual(quiet, 999)
        self.assertIn("chat panel", why)
        watch.editor_state(source="host", view="closed")    # the user hid the view: its host says so
        quiet, why = watch.window_silence()
        self.assertLess(quiet, 5, "a hidden view is judged on the host's traffic, which is fresh")
        self.assertIn("editor", why)

    def test_the_watchdog_leaves_an_opted_in_backend_to_the_switchboard(self):
        from dgc import headless
        ended = []
        for opted in (False, True):
            backend = SimpleNamespace(switchboard=SimpleNamespace(opted_in=opted), keepalive_reason=lambda: "")
            watch = headless._EditorLiveness(backend, io.StringIO(), after=0.0, wake=lambda: ended.append(opted))
            watch.pinged()
            watch._last -= 10
            result = watch.check()
            self.assertEqual(result, not opted, f"opted in: {opted}")
        self.assertEqual(ended, [False], "only the editor that never opted in is ended by the watchdog")


class AttachModeTests(unittest.TestCase):
    def setUp(self):
        self.board, home = board_for(FakeHost(FakeChat()), Clock())
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)

    def liveness(self, quiet, closed=None):
        last = time.monotonic() - quiet
        self.board.host._editor_liveness = SimpleNamespace(
            renderer_on_screen=lambda: quiet < 40, _last_renderer=last,
            _view_closed_at=None if closed is None else last + closed)

    def test_a_reload_judges_on_two_heartbeats_anything_else_on_two_minutes(self):
        self.liveness(60)
        self.assertFalse(self.board._on_screen("restore")[0], "a reload takes it from a panel quiet 40s")
        self.assertTrue(self.board._on_screen("auto")[0], "opened from a list: a background window is not taken")
        self.liveness(130)
        self.assertFalse(self.board._on_screen("auto")[0])
        self.liveness(60, closed=1)
        self.assertFalse(self.board._on_screen("auto")[0], "a view its host closed shows nothing")


# ------------------------------------------------ the Sessions home's backend: ChatDGC only ---
class FakeChatDGC:
    """ChatDGC's service as the switchboard reads it: its turns, and the chats it is answering."""

    def __init__(self):
        self._turns = {}

    def answering(self):
        return [{"conversation_id": cid, "title": f"Chat {cid[-1]}"} for cid in self._turns]


class ChatDGCScopeTests(unittest.TestCase):
    """set_detach_chatdgc: the Sessions home's backend keeps running with no window for a ChatDGC reply, and for
    nothing else -- with no ChatDGC work, a window that goes ends it exactly as before."""

    def setUp(self):
        self.clock = Clock()
        self.chat = FakeChat()
        self.host = FakeHost(self.chat)
        self.host._chatdgc = FakeChatDGC()
        self.board, home = board_for(self.host, self.clock)
        self.board.opted_in = False
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        self.addCleanup(self.board.close)
        if POSIX_SOCKETS:
            self.board.new_session = False
            self.assertTrue(self.board.command(self.board.stdio, {"type": "set_detach_chatdgc", "keep_running": True}))
        else:
            self.board.opted_in, self.board.scope = True, serve_detach.SCOPE_CHATDGC

    def windowless(self):
        return self.board.go_windowless(self.board.stdio, "test window went")

    def test_it_is_offered_and_opting_in_says_what_counts(self):
        self.assertEqual(self.board.capability()["chatdgc"], 1)
        self.assertTrue(self.board.opted_in)
        self.assertEqual(self.board.scope, "chatdgc")
        self.assertIsNone(ep.command_error({"type": "set_detach_chatdgc", "keep_running": True}))
        self.assertIsNotNone(ep.command_error({"type": "set_detach_chatdgc", "keep_running": "yes"}))

    def test_only_a_chatdgc_reply_is_work(self):
        self.chat.busy = True                                 # a turn in the home's own chat...
        self.chat.monitors_running = 1
        self.assertEqual(self.board.work().kind(), "none", "...is not the home's to keep running")
        self.assertEqual(serve_detach.host_work(self.host).kind(), "progressing", "a session's backend counts it")
        self.host._chatdgc._turns["chat_1"] = {}
        self.assertEqual(self.board.work().kind(), "progressing")
        self.assertEqual(self.board.work().reason(), "a ChatDGC reply is being written")
        self.host._chatdgc._turns["chat_2"] = {}
        self.assertEqual(self.board.work().reason(), "2 ChatDGC replies are being written")

    def test_with_no_chatdgc_reply_the_window_going_ends_it_as_before(self):
        self.chat.busy = True
        self.assertFalse(self.windowless())
        self.assertTrue(self.board.exit.is_set())
        self.assertIn("nothing running", self.board.ending.cause)

    def test_a_reply_keeps_it_then_the_same_rules_as_a_session(self):
        self.host._chatdgc._turns["chat_1"] = {}
        self.assertTrue(self.windowless())
        self.clock.now += 3600
        self.assertEqual(self.board.check(), "", "a reply being written: no idle clock")
        del self.host._chatdgc._turns["chat_1"]               # it finished, with no window
        self.chat.busy = True                                 # the home's own chat is no reason to stay
        self.assertEqual(self.board.check(), "")
        self.clock.now += serve_detach.IDLE_EXIT_S + 1
        self.assertEqual(self.board.check(), "idle", "2 minutes after the reply, saved and gone")
        self.board.exit.clear()
        self.board.ending = None
        self.board.current = self.board.stdio
        self.host._chatdgc._turns["chat_1"] = {}
        self.assertTrue(self.windowless())
        self.clock.now += serve_detach.MAX_WINDOWLESS_S + 1
        self.assertEqual(self.board.check(), "max_windowless", "12 hours at most")

    def test_the_note_names_the_chats_it_is_answering(self):
        self.assertNotIn("chatdgc", self.board.note_fields())
        self.host._chatdgc._turns["chat_1"] = {}
        fields = self.board.note_fields()
        self.assertEqual(fields["chatdgc"], [{"conversation_id": "chat_1", "title": "Chat 1"}])
        self.assertEqual(fields["detach_scope"], "chatdgc")
        self.assertEqual(fields["work"], "a ChatDGC reply is being written")

    def test_a_silent_window_leaves_work_of_a_sessions_kind_as_the_watchdog_did(self):
        self.silence = (serve_detach.SILENT_WINDOW_S + 1, "its editor stopped answering")
        self.host._editor_liveness = SimpleNamespace(window_silence=lambda: self.silence)
        self.chat.busy = True
        self.assertEqual(self.board.check(), "", "the watchdog never ended a backend whose chat works")
        self.chat.busy = False
        self.assertEqual(self.board.check(), "silent_window")
        self.assertTrue(self.board.exit.is_set())

    def test_dgc_ps_and_running_sessions_read_it_from_the_note(self):
        from dgc import peers
        home = Path(tempfile.mkdtemp(prefix="dgc-detach-ps-"))
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        record = {"pid": os.getpid(), "kind": "serve", "session": "/x/s-home.json", "attached": False,
                  "socket": "/x/s.sock", "instance": "ab", "detach_scope": "chatdgc", "windowless_since": time.time() - 60,
                  "work": "a ChatDGC reply is being written",
                  "chatdgc": [{"conversation_id": "chat_" + "a" * 32, "title": "Count to 400"}, "junk"]}
        with unittest.mock.patch.object(peers, "peers_dir", lambda: home):
            (home / f"{os.getpid()}.json").write_text(json.dumps(record))
            rows = serve_detach.live_processes(here=os.getpid())
        self.assertEqual(rows[0]["scope"], "chatdgc")
        self.assertEqual(rows[0]["chats"], [{"conversation_id": "chat_" + "a" * 32, "title": "Count to 400"}])
        from dgc import ps_cli
        text = ps_cli.format_rows(rows)
        self.assertIn('chat "Count to 400"  (answering)', text)


class _FakeSocket:
    def __init__(self):
        self.closed = False

    def settimeout(self, _value):
        pass

    def close(self):
        self.closed = True


class RelayWaitTests(unittest.TestCase):
    """A reload asks again while the old window's panel falls quiet, but a panel that speaks while it
    waits is a window in use: the wait ends there, and the session is shown read-only."""

    def run_relay(self, answers):
        from dgc import __version__
        asked = []
        holder = {"pid": 4321, "socket": "/nonexistent", "instance": "abcd", "version": __version__,
                  "protocol_version": ep.PROTOCOL_VERSION}
        replies = iter(answers)
        patches = {
            (serve_relay, "find_holder"): lambda session: holder,
            (serve_relay, "pump"): lambda sock: 0,
            (serve_relay, "RETRY_EVERY_S"): 0.0,
            (session_socket, "connect"): lambda *a, **k: _FakeSocket(),
            (session_socket, "send_line"): lambda sock, value: asked.append(value),
            (session_socket, "read_line"): lambda sock: next(replies),
        }
        saved = {key: getattr(*key) for key in patches}
        for (module, name), value in patches.items():
            setattr(module, name, value)
        serve_relay._refused = None
        try:
            return serve_relay._attach("s-one", "restore"), asked, serve_relay.refused()
        finally:
            for (module, name), value in saved.items():
                setattr(module, name, value)
            serve_relay._refused = None

    def test_a_panel_that_speaks_while_it_waits_ends_the_wait(self):
        result, asked, refused = self.run_relay([{"type": "refused", "reason": "on_screen", "quiet_s": 12.0},
                                                 {"type": "refused", "reason": "on_screen", "quiet_s": 1.0}])
        self.assertIsNone(result, "a normal serve, showing it read-only")
        self.assertEqual(len(asked), 2)
        self.assertEqual(refused["reason"], "on_screen")

    def test_a_panel_that_stays_quiet_is_waited_for_and_then_taken(self):
        result, asked, refused = self.run_relay([{"type": "refused", "reason": "on_screen", "quiet_s": 20.0},
                                                 {"type": "refused", "reason": "on_screen", "quiet_s": 30.0},
                                                 {"type": "attached", "pid": 4321}])
        self.assertEqual(result, 0, "relayed")
        self.assertEqual(len(asked), 3)
        self.assertEqual(asked[0]["mode"], "restore")
        self.assertIsNone(refused)


class ReleaseWhileWorkingTests(unittest.TestCase):
    """The peer-file stand-down: a backend that keeps work running without a window never stands down
    mid-work, whether it has a window or not; a window of the same DGC reattaches instead."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-release-"))
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self._prior = os.environ.get("HOME")
        os.environ["HOME"] = str(self.home)
        self.addCleanup(lambda: os.environ.__setitem__("HOME", self._prior) if self._prior else None)

    def backend(self, *, windowless, busy, on_screen=False):
        from dgc import headless
        chat = FakeChat(session="one")
        chat.agent.session_file = "/s/one.json"
        chat.busy = busy
        host = SimpleNamespace(chats={"c0": chat})
        host.switchboard = SimpleNamespace(opted_in=True, windowless=windowless,
                                           work=lambda: serve_detach.host_work(host))
        watch = SimpleNamespace(stood_down=False, renderer_on_screen=lambda: on_screen,
                                editor_gone_for_takeover=lambda: (True, 0.0))

        def stand_down():
            watch.stood_down = True
            return True
        watch.stand_down = stand_down
        backend = SimpleNamespace(_host=host, agent=chat.agent, _editor_liveness=watch,
                                  _announce_peer=lambda status="idle": None)
        backend._consider_release = headless.Backend._consider_release.__get__(backend)
        return backend, watch

    def ask(self):
        from dgc import peers
        note = {"pid": os.getpid(), "proc_start": "", "kind": "serve", "session": "/s/one.json", "cwd": "/w",
                "project_root": "/w", "git_common_dir": "", "status": "working", "takeover": True,
                "heartbeat": time.time()}
        peers.request_release(note, "/s/one.json")
        return peers

    def test_an_orphaned_window_with_a_turn_running_keeps_it(self):
        peers = self.ask()
        backend, watch = self.backend(windowless=False, busy=True)
        self.assertFalse(backend._consider_release())
        self.assertFalse(watch.stood_down, "standing down mid-turn is what lost the turn before")
        answer = peers.release_answer(os.getpid())
        self.assertFalse(answer["granted"])
        self.assertIn("dgc stop", answer["reason"])

    def test_nothing_running_hands_it_over(self):
        self.ask()
        backend, watch = self.backend(windowless=True, busy=False)
        self.assertTrue(backend._consider_release())
        self.assertTrue(watch.stood_down)


# ---------------------------------------------------------------- the wire and attaching ---
class WireSwitchTests(unittest.TestCase):
    def test_switch_keeps_one_strictly_increasing_seq_and_never_tears_a_frame(self):
        sinks = [io.StringIO() for _ in range(6)]
        core = Emitter(sinks[0], validator=ep.event_error)
        stop = threading.Event()

        def emitter(n):
            i = 0
            while not stop.is_set():
                core.emit("info", message=f"t{n}-{i}")
                i += 1
        threads = [threading.Thread(target=emitter, args=(n,)) for n in range(4)]
        for thread in threads:
            thread.start()
        for index, sink in enumerate(sinks[1:], 1):
            time.sleep(0.02)
            core.switch(sink, farewell=("session_moved", {"reason": "opened_elsewhere"}),
                        first=[("session_live", {"session_id": f"s{index}", "cwd": "/w", "turn": None,
                                                 "queued": [], "waiting": []})])
        time.sleep(0.02)
        stop.set()
        for thread in threads:
            thread.join()
        seqs = []
        for index, sink in enumerate(sinks):
            frames = [json.loads(line) for line in sink.getvalue().splitlines()]   # a torn frame fails here
            self.assertTrue(frames, f"sink {index} got nothing")
            if index:
                self.assertEqual(frames[0]["type"], "session_live", "the new end's first frame comes first")
            if index < len(sinks) - 1:
                self.assertEqual(frames[-1]["type"], "session_moved", "the old end's last frame is the farewell")
            seqs.extend(frame["seq"] for frame in frames)
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(seqs), len(set(seqs)))
        self.assertEqual(seqs, list(range(len(seqs))), "every seq lands on exactly one end")

    def test_an_automatic_attach_never_takes_a_window_that_is_on_screen(self):
        clock = Clock()
        chat = FakeChat(session="s-one")
        host = FakeHost(chat)
        board, home = board_for(host, clock)
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        from dgc import __version__
        hello = {"type": "attach", "instance": board.instance, "session": "s-one", "mode": "auto",
                 "version": __version__, "protocol_version": ep.PROTOCOL_VERSION}
        host._editor_liveness = SimpleNamespace(renderer_on_screen=lambda: True, _last_renderer=time.monotonic())
        self.assertEqual(board.refusal(hello)[0], "on_screen")
        self.assertEqual(board.refusal({**hello, "mode": "restore"})[0], "on_screen")
        self.assertEqual(board.refusal({**hello, "mode": "steal"})[0], "", "Open here takes it")
        host._editor_liveness = SimpleNamespace(renderer_on_screen=lambda: False, _last_renderer=None)
        self.assertEqual(board.refusal(hello)[0], "", "a silent panel (an orphaned host) is taken at once")
        board.current = None
        host._editor_liveness = SimpleNamespace(renderer_on_screen=lambda: True, _last_renderer=time.monotonic())
        self.assertEqual(board.refusal(hello)[0], "", "a windowless process is always attached to")
        self.assertEqual(board.refusal({**hello, "instance": "0" * 16})[0], "instance")
        self.assertEqual(board.refusal({**hello, "version": "0.0.1"})[0], "version")
        self.assertEqual(board.refusal({**hello, "session": "s-other"})[0], "not_here")
        board.opted_in = False
        self.assertEqual(board.refusal(hello)[0], "exiting")

    def test_detach_from_a_client_that_never_opted_in_is_a_shutdown(self):
        host = FakeHost(FakeChat())
        board, home = board_for(host, Clock())
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        board.opted_in = False
        with self.assertRaises(serve_detach._ShutdownRequested):
            board.command(board.stdio, {"type": "detach"})
        self.assertFalse(board.command(board.stdio, {"type": "prompt", "text": "x"}))


@unittest.skipUnless(POSIX_SOCKETS, "the attach socket is Linux and macOS only")
class SocketTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="dgc-sock-", dir="/tmp"))
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)

    def test_the_directory_is_0700_and_the_socket_0600(self):
        bound = session_socket.bind(self.base / ".dgc", os.getpid(), "abcdef0123456789")
        self.assertIsNotNone(bound)
        server, path = bound
        self.addCleanup(server.close)
        self.assertEqual(stat.S_IMODE(os.lstat(path.parent).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.lstat(path).st_mode), 0o600)
        self.assertTrue(stat.S_ISSOCK(os.lstat(path).st_mode))

    def test_a_wider_directory_is_narrowed_and_a_symlink_refused(self):
        wide = self.base / "wide"
        wide.mkdir(mode=0o755)
        os.chmod(wide, 0o755)
        self.assertEqual(session_socket.private_dir(wide), wide)
        self.assertEqual(stat.S_IMODE(os.lstat(wide).st_mode), 0o700)
        target = self.base / "elsewhere"
        target.mkdir()
        link = self.base / "link"
        link.symlink_to(target)
        self.assertIsNone(session_socket.private_dir(link))

    def test_a_home_too_long_for_a_socket_path_falls_back(self):
        deep = self.base / ("d" * 120) / ".dgc"
        old = os.environ.pop("XDG_RUNTIME_DIR", None)
        try:
            bound = session_socket.bind(deep, os.getpid(), "abcdef0123456789")
        finally:
            if old is not None:
                os.environ["XDG_RUNTIME_DIR"] = old
        self.assertIsNotNone(bound)
        server, path = bound
        self.addCleanup(server.close)
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))
        self.assertEqual(path.parent, Path("/tmp") / f"dgc-{os.getuid()}")
        self.assertLess(len(os.fsencode(str(path))), session_socket.MAX_SOCKET_PATH)

    def test_the_peer_is_this_user_and_this_process(self):
        a, b = socket.socketpair(socket.AF_UNIX)
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        uid, pid = session_socket.peer_identity(a)
        self.assertEqual(uid, os.getuid())
        self.assertEqual(pid, os.getpid())

    def test_a_connection_from_another_user_is_refused_without_a_word(self):
        chat = FakeChat()
        host = FakeHost(chat)
        logs = []
        board, home = board_for(host, Clock(), identity=lambda sock: (os.getuid() + 1, 4242),
                                log=logs.append)
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        a, b = socket.socketpair(socket.AF_UNIX)
        self.addCleanup(b.close)
        board._greet(a)
        b.settimeout(2)
        self.assertEqual(b.recv(100), b"", "closed, with nothing said")
        self.assertTrue(any("refused a connection" in line for line in logs))
        self.assertIs(board.current, board.stdio, "nothing was attached")

    def test_the_client_refuses_a_socket_that_is_not_private(self):
        bound = session_socket.bind(self.base / ".dgc", os.getpid(), "abcdef0123456789")
        server, path = bound
        self.addCleanup(server.close)
        os.chmod(path, 0o666)
        with self.assertRaises(PermissionError):
            session_socket.connect(str(path))

    def test_the_relay_pumps_both_ways_and_stops_when_either_side_closes(self):
        for closing in ("editor", "backend"):
            with self.subTest(closing=closing):
                relay_end, backend_end = socket.socketpair(socket.AF_UNIX)
                editor_in_r, editor_in_w = os.pipe()
                editor_out_r, editor_out_w = os.pipe()
                result = {}
                thread = threading.Thread(target=lambda: result.setdefault(
                    "code", serve_relay.pump(relay_end, editor_in_r, editor_out_w)))
                thread.start()
                os.write(editor_in_w, b'{"type":"ping"}\n')
                backend_end.settimeout(5)
                self.assertEqual(backend_end.recv(100), b'{"type":"ping"}\n')
                backend_end.sendall(b'{"type":"info","seq":0}\n')
                self.assertEqual(os.read(editor_out_r, 100), b'{"type":"info","seq":0}\n')
                if closing == "editor":
                    os.close(editor_in_w)
                    self.assertEqual(backend_end.recv(100), b"", "the editor's end closing ends the backend's read")
                else:
                    backend_end.shutdown(socket.SHUT_RDWR)
                thread.join(5)
                self.assertFalse(thread.is_alive())
                self.assertEqual(result["code"], 0)
                for fd in (editor_in_r, editor_out_r, editor_out_w):
                    os.close(fd)
                if closing == "backend":
                    os.close(editor_in_w)
                backend_end.close()

    def test_the_request_is_taken_out_of_the_environment(self):
        env = {serve_relay.ATTACH_SESSION_ENV: "20261019-1-abc", serve_relay.ATTACH_MODE_ENV: "steal"}
        self.assertEqual(serve_relay.take_request(env), ("20261019-1-abc", "steal"))
        self.assertEqual(env, {}, "nothing a normal serve starts may inherit them")
        self.assertIsNone(serve_relay.take_request({serve_relay.ATTACH_SESSION_ENV: "../etc"}))
        self.assertEqual(serve_relay.take_request({serve_relay.ATTACH_SESSION_ENV: "abc",
                                                    serve_relay.ATTACH_MODE_ENV: "bogus"}), ("abc", "auto"))


# ------------------------------------------------------------------------ integration -------
def sse(delta, finish=None):
    return "data: " + json.dumps({"id": "m", "object": "chat.completion.chunk", "model": "mock-model",
                                  "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"


ROUND_A = [f"a{i}." for i in range(50)]
ROUND_B = [f"b{i}." for i in range(30)]


class Model(BaseHTTPRequestHandler):
    """TURN_LONG streams round A slowly, then asks to run bash; after the result, round B slowly.
    TURN_RUN asks to run bash at once. TURN_FOREVER streams until DGC hangs up."""

    delay = 0.08

    def log_message(self, *a):
        pass

    def _start(self, kind="text/event-stream"):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Connection", "close")
        self.end_headers()

    def _write(self, text):
        self.wfile.write(text.encode())
        self.wfile.flush()

    def do_GET(self):
        body = json.dumps({"data": [{"id": "mock-model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        msgs = body.get("messages") or []
        prompts = [m for m in msgs if m.get("role") == "user" and isinstance(m.get("content"), str)
                   and "TURN_" in m["content"]]
        self._start()
        try:
            if not body.get("tools") or not prompts:
                return self._write(sse({"content": "Title"}) + sse({}, "stop") + "data: [DONE]\n\n")
            last = prompts[-1]["content"]
            answered = any(m.get("role") == "tool" for m in msgs[msgs.index(prompts[-1]) + 1:])
            if "TURN_SHORT" in last:
                for i in range(20):
                    self._write(sse({"content": f"s{i}."}))
                    time.sleep(self.delay)
                return self._write(sse({}, "stop") + "data: [DONE]\n\n")
            if "TURN_FOREVER" in last:
                i = 0
                while True:
                    self._write(sse({"content": f"f{i}."}))
                    i += 1
                    time.sleep(0.2)
            if "TURN_LONG" in last and answered:
                for piece in ROUND_B:
                    self._write(sse({"content": piece}))
                    time.sleep(self.delay)
                return self._write(sse({}, "stop") + "data: [DONE]\n\n")
            if "TURN_LONG" in last:
                for piece in ROUND_A:
                    self._write(sse({"content": piece}))
                    time.sleep(self.delay)
            if answered:
                return self._write(sse({"content": "Done."}) + sse({}, "stop") + "data: [DONE]\n\n")
            self._write(sse({"tool_calls": [{"index": 0, "id": "call_bash_1", "type": "function",
                                             "function": {"name": "bash",
                                                          "arguments": json.dumps({"command": "echo detach-probe"})}}]})
                        + sse({}, "tool_calls") + "data: [DONE]\n\n")
        except OSError:
            return


class Serve:
    """One `python -m dgc serve` with its events on a thread: an editor window, or its relay."""

    def __init__(self, world, extra_env=None, name="serve"):
        self.world = world
        env = dict(world.env, **(extra_env or {}))
        self.stderr_path = world.base / f"{name}-{len(world.serves)}.stderr"
        self._stderr = open(self.stderr_path, "w")
        self.proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=str(world.work), env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._stderr,
                                     text=True)
        world.serves.append(self)
        self.events: list[dict] = []
        self._arrived: "queue.Queue[dict]" = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                event = {"type": "__bad__", "line": line}
            self.events.append(event)
            self._arrived.put(event)

    def send(self, command):
        self.proc.stdin.write(json.dumps(command) + "\n")
        self.proc.stdin.flush()

    def close_stdin(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass

    def wait(self, predicate, timeout=60.0, after=0):
        deadline = time.monotonic() + timeout
        seen = 0
        while time.monotonic() < deadline:
            for event in self.events[seen:]:
                seen += 1
                if event.get("seq", 0) >= after and predicate(event):
                    return event
            try:
                self._arrived.get(timeout=0.1)
            except queue.Empty:
                pass
        raise AssertionError(f"timed out; last events: {[e.get('type') for e in self.events[-12:]]}\n"
                             f"stderr: {self.stderr_path.read_text()[-3000:]}")

    def stderr(self):
        self._stderr.flush()
        return self.stderr_path.read_text()

    def stop(self):
        if self.proc.poll() is None:
            try:
                self.send({"type": "shutdown"})
            except (OSError, ValueError):
                pass
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        for stream in (self.proc.stdin, self.proc.stdout):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        self._stderr.close()


class World:
    def __init__(self, test, scale, handler=None):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler or Model)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = Path(tempfile.mkdtemp(prefix="dgc-detach-", dir="/tmp"))
        self.home, self.work = self.base / "home", self.base / "work"
        self.home.mkdir()
        self.work.mkdir()
        (self.home / ".dgc").mkdir()
        (self.home / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": f"http://127.0.0.1:{self.server.server_address[1]}/v1", "model": "mock-model",
            "api_key": "sk-fixture-0123456789abcdef", "api_mode": "chat_completions", "suggest": False,
            "notes": False, "mode": "default", "artifact_autostart": False, "eta": False}))
        self.env = dict(os.environ, HOME=str(self.home), PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE="1",
                        NO_COLOR="1")
        self.env[serve_detach.SCALE_ENV] = str(scale)
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
            self.env[var] = str(self.home)
        for var in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XDG_RUNTIME_DIR", "DGC_SDK_ISOLATED",
                    "DGC_PROJECT_ROOT", "DGC_ATTACH_SESSION", "DGC_ATTACH", "DGC_HOME"):
            self.env.pop(var, None)
        self.serves: list[Serve] = []
        test.addCleanup(self.close)

    def close(self):
        for serve in reversed(self.serves):
            serve.stop()
        # the windowless process this test made, by pid, after checking its command line
        for pid in self.note_pids():
            try:
                cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if Path("/proc").exists() else []
            except OSError:
                cmdline = []
            if b"serve" in cmdline and b"-m" in cmdline:
                try:
                    os.kill(pid, 9)
                except OSError:
                    pass
        self.server.shutdown()
        shutil.rmtree(self.base, ignore_errors=True)

    def note_pids(self):
        pids = []
        for path in (self.home / ".dgc" / "peers").glob("*.json"):
            try:
                pids.append(json.loads(path.read_text())["pid"])
            except (OSError, ValueError, KeyError):
                continue
        return pids

    def note(self, pid):
        try:
            return json.loads((self.home / ".dgc" / "peers" / f"{pid}.json").read_text())
        except (OSError, ValueError):
            return None

    def dgc(self, *args, timeout=90):
        return subprocess.run([sys.executable, "-m", "dgc", *args], cwd=str(self.work), env=self.env,
                              capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)

    def session_file(self, session_id):
        found = list((self.home / ".dgc" / "sessions").rglob(f"{session_id}.json"))
        return found[0] if found else None

    def serve_log(self):
        path = self.home / ".dgc" / "logs" / "serve.log"
        return path.read_text() if path.exists() else ""


def alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
        return state != "Z"
    except (OSError, IndexError):
        return True


def turn_text(events, after_seq, snapshot=None):
    """The running turn's text: what the snapshot holds of it, then every live delta after it."""
    text = ""
    if snapshot is not None:
        items = snapshot["items"]
        start = max((i for i, item in enumerate(items) if item.get("type") == "turn_start"), default=0)
        text = "".join(item.get("text", "") for item in items[start:] if item.get("type") == "text_delta")
    return text + "".join(e.get("text", "") for e in events
                          if e.get("type") == "text_delta" and e.get("seq", -1) > after_seq)


@unittest.skipUnless(POSIX_SOCKETS, "a session runs without a window on Linux and macOS")
class DetachIntegrationTests(unittest.TestCase):
    maxDiff = None

    def opened(self, world, **kw):
        serve = Serve(world, **kw)
        ready = serve.wait(lambda e: e.get("type") == "ready", 90)
        return serve, ready

    def assert_valid(self, serve):
        for event in serve.events:
            self.assertIsNone(ep.event_error(event), event)

    def test_a_turn_keeps_streaming_across_two_reattaches_with_its_approval_re_sent(self):
        world = World(self, scale=0.01)                       # idle exit 1.2s, an answer's wait 36s
        a, ready = self.opened(world, name="window-a")
        self.assertEqual(ready["capabilities"]["detach"]["version"], 1)
        session_id = ready["session_id"]
        a.send({"type": "set_detach", "keep_running": True})
        a.send({"type": "prompt", "text": "TURN_LONG please", "request_id": "p1"})
        a.wait(lambda e: e.get("type") == "text_delta" and "a3." in e.get("text", ""), 60)
        backend_pid = a.proc.pid
        a.send({"type": "detach"})
        a.close_stdin()
        wait_until(lambda: (world.note(backend_pid) or {}).get("attached") is False, timeout=20,
                   what="the note to say the backend has no window")
        self.assertTrue(alive(backend_pid), "the backend outlived its window")
        rows = json.loads(world.dgc("ps", "--json").stdout)
        row = next(r for r in rows if r["pid"] == backend_pid)
        self.assertFalse(row["attached"])
        self.assertIn("turn", row["work"])
        self.assertEqual(row["sessions"][0]["session_id"], session_id)
        sock_path = Path(world.note(backend_pid)["socket"])
        self.assertEqual(stat.S_IMODE(os.lstat(sock_path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.lstat(sock_path.parent).st_mode), 0o700)

        # Window B reloads onto it, mid-stream.
        b = Serve(world, {"DGC_ATTACH_SESSION": session_id, "DGC_ATTACH": "restore"}, name="window-b")
        first = b.wait(lambda e: True, 60)
        self.assertEqual(first["type"], "ready", "the first frame an attaching window gets is ready")
        attached = first["capabilities"]["attached"]
        self.assertEqual(attached["chats"][0]["session_id"], session_id)
        self.assertEqual(attached["chats"][0]["turn"]["prompt"], "TURN_LONG please")
        live = b.wait(lambda e: e.get("type") == "session_live")
        self.assertEqual(live["turn"]["turn_id"], attached["chats"][0]["turn"]["turn_id"])
        self.assertEqual(b.proc.pid != backend_pid, True)
        b.send({"type": "set_detach", "keep_running": True})
        b.send({"type": "get_history", "request_id": "h-b"})
        snap_b = b.wait(lambda e: e.get("type") == "history")
        self.assertTrue(snap_b["complete"])
        self.assertTrue(turn_text([], 0, snap_b).startswith("a0.a1.a2.a3."))
        # The newer per-chat state comes back with the repaint too, exactly once: the prompt cache's
        # clock, as the last word before the snapshot (0.48), for this session.
        clocks = [e for e in b.events if e.get("type") == "cache_clock"]
        self.assertEqual(len(clocks), 1, [e.get("type") for e in b.events])
        self.assertEqual(clocks[0]["session_id"], session_id)
        self.assertLess(clocks[0]["seq"], snap_b["seq"])
        self.assertEqual(sum(1 for e in b.events if e.get("type") == "ready"), 1)
        self.assertEqual(sum(1 for e in b.events if e.get("type") == "session_live"), 1)
        ask_b = b.wait(lambda e: e.get("type") == "permission_request", 60)
        # B goes too, with the approval open.
        b.send({"type": "detach"})
        b.close_stdin()
        b.proc.wait(timeout=20)
        wait_until(lambda: (world.note(backend_pid) or {}).get("attached") is False, timeout=20,
                   what="windowless again")
        self.assertTrue(alive(backend_pid))

        # Window C reattaches; the same approval comes back with the same id; answering finishes it.
        c = Serve(world, {"DGC_ATTACH_SESSION": session_id, "DGC_ATTACH": "restore"}, name="window-c")
        c.wait(lambda e: e.get("type") == "ready", 60)
        c.send({"type": "set_detach", "keep_running": True})
        c.send({"type": "get_history", "request_id": "h-c"})
        snap_c = c.wait(lambda e: e.get("type") == "history")
        again = c.wait(lambda e: e.get("type") == "permission_request" and e["seq"] > snap_c["seq"])
        self.assertEqual(again["id"], ask_b["id"], "re-sent with the id it was first asked with")
        c.send({"type": "permission_response", "id": again["id"], "decision": "once"})
        c.wait(lambda e: e.get("type") == "turn_end", 90)
        expected = "".join(ROUND_A) + "".join(ROUND_B)
        self.assertEqual(turn_text(c.events, snap_c["seq"], snap_c), expected,
                         "the snapshot and the live stream after it: nothing lost, nothing twice")
        seqs = [e["seq"] for e in c.events]
        self.assertEqual(seqs, sorted(set(seqs)))
        for serve in (a, b, c):
            self.assert_valid(serve)

        # The work is done: a window that goes now leaves nothing running, so it saves and exits.
        c.send({"type": "detach"})
        c.close_stdin()
        wait_until(lambda: not alive(backend_pid), timeout=40, what="the exit")
        saved = world.session_file(session_id)
        self.assertIsNotNone(saved)
        self.assertIn("b29.", saved.read_text())
        log = world.serve_log()
        self.assertIn("windowless: the editor said its window is going", log)
        self.assertIn("attached by relay pid", log)
        self.assertIn("with nothing running", log)
        self.assertFalse(sock_path.exists(), "the socket goes with the process")

    def test_two_minutes_after_its_work_finishes_with_no_window_it_saves_and_exits(self):
        world = World(self, scale=0.05)                       # the two minutes are 6s
        a, ready = self.opened(world, name="window")
        session_id = ready["session_id"]
        a.send({"type": "set_detach", "keep_running": True})
        a.send({"type": "prompt", "text": "TURN_SHORT go", "request_id": "p1"})
        a.wait(lambda e: e.get("type") == "text_delta", 60)
        pid = a.proc.pid
        a.send({"type": "detach"})
        a.close_stdin()
        finished = wait_until(lambda: (world.session_file(session_id) or Path("/nonexistent")).exists()
                              and "s19." in world.session_file(session_id).read_text() and time.monotonic(),
                              timeout=60, what="the turn to finish with no window")
        time.sleep(3.0)
        self.assertTrue(alive(pid), "kept for the two minutes after its work, in case a window comes back")
        wait_until(lambda: not alive(pid), timeout=30, what="the idle exit")
        self.assertGreaterEqual(time.monotonic() - finished, 5.0)
        self.assertIn("windowless exit: no work for", world.serve_log())

    def test_an_answer_is_waited_for_an_hour_then_the_session_saves_and_stops(self):
        scale = 6.0 / serve_detach.WAITING_EXIT_S             # the hour is 6s; the idle rule 0.2s
        world = World(self, scale=scale)
        a, ready = self.opened(world, name="window")
        session_id = ready["session_id"]
        a.send({"type": "set_detach", "keep_running": True})
        a.send({"type": "prompt", "text": "TURN_RUN now", "request_id": "p1"})
        a.wait(lambda e: e.get("type") == "permission_request", 60)
        pid = a.proc.pid
        started = time.monotonic()
        a.send({"type": "detach"})
        a.close_stdin()
        time.sleep(3.0)
        self.assertTrue(alive(pid), "an open approval is not idle: the 2-minute rule does not apply")
        wait_until(lambda: not alive(pid), timeout=40, what="the hour's wait to end")
        self.assertGreaterEqual(time.monotonic() - started, 5.0)
        self.assertIn("windowless exit: waited", world.serve_log())
        saved = world.session_file(session_id)
        self.assertIsNotNone(saved)
        self.assertIn("TURN_RUN now", saved.read_text())
        # Reopening it: the question replays unanswered, the turn as stopped, and Continue is offered.
        b, _ = self.opened(world, extra_env={"DGC_ATTACH_SESSION": session_id, "DGC_ATTACH": "restore"},
                           name="reopened")
        b.send({"type": "set_detach", "keep_running": True})
        b.send({"type": "resume_session", "path": f"{session_id}.json", "request_id": "r"})
        history = b.wait(lambda e: e.get("type") == "history", 60)
        ends = [item for item in history["items"] if item.get("type") == "turn_end"]
        self.assertEqual(ends[-1]["reason"], "cancelled")
        offer = b.wait(lambda e: e.get("type") == "turn_interrupted", 30)
        self.assertEqual(offer["session_id"], session_id)
        self.assertIn("answer", offer["cause"])
        self.assertGreater(offer["seq"], history["seq"], "after the replay")
        # Continue clears it: the next turn of the session has nothing left to offer.
        b.send({"type": "resume_turn", "request_id": "c"})
        b.wait(lambda e: e.get("type") == "turn_start", 60)
        wait_until(lambda: not saved.with_suffix(".interrupted").exists(), timeout=20,
                   what="the record to go once the session works again")

    def test_twelve_hours_with_no_window_is_the_most(self):
        scale = 6.0 / serve_detach.MAX_WINDOWLESS_S
        world = World(self, scale=scale)
        a, ready = self.opened(world, name="window")
        session_id = ready["session_id"]
        a.send({"type": "set_detach", "keep_running": True})
        a.send({"type": "prompt", "text": "TURN_FOREVER go", "request_id": "p1"})
        a.wait(lambda e: e.get("type") == "text_delta", 60)
        pid = a.proc.pid
        a.send({"type": "detach"})
        a.close_stdin()
        time.sleep(3.0)
        self.assertTrue(alive(pid), "still within its (shrunk) twelve hours")
        wait_until(lambda: not alive(pid), timeout=60, what="the twelve-hour limit")
        self.assertIn("limit for a session with no window", world.serve_log())
        self.assertIn("TURN_FOREVER go", world.session_file(session_id).read_text())

    def test_dgc_stop_saves_and_stops_a_windowless_session(self):
        world = World(self, scale=1.0)
        a, ready = self.opened(world, name="window")
        session_id = ready["session_id"]
        a.send({"type": "set_detach", "keep_running": True})
        a.send({"type": "prompt", "text": "TURN_FOREVER go", "request_id": "p1"})
        a.wait(lambda e: e.get("type") == "text_delta", 60)
        pid = a.proc.pid
        a.send({"type": "detach"})
        a.close_stdin()
        wait_until(lambda: (world.note(pid) or {}).get("attached") is False, timeout=20, what="windowless")
        listing = world.dgc("ps")
        self.assertIn(str(pid), listing.stdout)
        self.assertIn("no window for", listing.stdout)
        stopped = world.dgc("stop", "--windowless")
        self.assertEqual(stopped.returncode, 0, stopped.stdout + stopped.stderr)
        self.assertIn("stopped", stopped.stdout)
        wait_until(lambda: not alive(pid), timeout=30, what="the stop")
        self.assertIn("TURN_FOREVER go", world.session_file(session_id).read_text())
        self.assertIn("stop asked over the socket", world.serve_log())
        self.assertEqual(world.dgc("ps").stdout.strip(), "No DGC is running on this computer.")

    def test_a_window_on_screen_is_never_taken_automatically_and_open_here_takes_it(self):
        world = World(self, scale=1.0)
        a, ready = self.opened(world, name="window-a")
        session_id = ready["session_id"]
        a.send({"type": "set_detach", "keep_running": True})
        a.send({"type": "editor_state", "source": "renderer", "view": "open"})
        a.send({"type": "prompt", "text": "TURN_FOREVER go", "request_id": "p1"})
        a.wait(lambda e: e.get("type") == "text_delta", 60)
        wait_until(lambda: (world.note(a.proc.pid) or {}).get("socket"), timeout=20, what="the socket")
        # Another window asks for the same session automatically: refused, shown read-only there.
        b, b_ready = self.opened(world, extra_env={"DGC_ATTACH_SESSION": session_id, "DGC_ATTACH": "auto"},
                                 name="window-b")
        self.assertNotIn("attached", b_ready["capabilities"])
        self.assertEqual(b_ready["capabilities"]["detach"]["elsewhere"],
                         {"session_id": session_id, "pid": a.proc.pid, "reason": "on_screen"})
        self.assertTrue(alive(a.proc.pid))
        b.stop()
        # "Open here": the user takes it. A is told and closed; the turn goes on in C.
        c = Serve(world, {"DGC_ATTACH_SESSION": session_id, "DGC_ATTACH": "steal"}, name="window-c")
        c_ready = c.wait(lambda e: e.get("type") == "ready", 60)
        self.assertEqual(c_ready["capabilities"]["attached"]["chats"][0]["session_id"], session_id)
        moved = a.wait(lambda e: e.get("type") == "session_moved", 30)
        self.assertEqual(moved["reason"], "opened_elsewhere")
        c.wait(lambda e: e.get("type") == "text_delta", 30)
        # What the displaced window says is no longer heard.
        a.send({"type": "cancel"})
        time.sleep(1.0)
        self.assertFalse(any(e.get("type") == "turn_end" for e in c.events), "A's Stop did not reach the turn")
        c.send({"type": "shutdown"})
        wait_until(lambda: not alive(a.proc.pid), timeout=30, what="the shutdown through C")
        for serve in (a, c):
            self.assert_valid(serve)

    def test_an_older_version_still_running_the_session_is_saved_stopped_and_reopened_here(self):
        world = World(self, scale=1.0)
        a, ready = self.opened(world, name="old-window")
        session_id = ready["session_id"]
        a.send({"type": "set_detach", "keep_running": True})
        a.send({"type": "prompt", "text": "TURN_FOREVER go", "request_id": "p1"})
        a.wait(lambda e: e.get("type") == "text_delta", 60)
        pid = a.proc.pid
        a.send({"type": "detach"})
        a.close_stdin()
        wait_until(lambda: (world.note(pid) or {}).get("attached") is False, timeout=20, what="windowless")
        # The note is what a newer DGC reads the holder's version from.
        path = world.home / ".dgc" / "peers" / f"{pid}.json"
        note = json.loads(path.read_text())
        note["version"] = "0.47.1"
        path.write_text(json.dumps(note))
        b, b_ready = self.opened(world, extra_env={"DGC_ATTACH_SESSION": session_id, "DGC_ATTACH": "restore"},
                                 name="new-window")
        self.assertNotIn("attached", b_ready["capabilities"], "never attached across versions")
        self.assertFalse(alive(pid), "the older one saved and stopped before this one started")
        self.assertIn("was still running this session", b.stderr())
        self.assertIn("TURN_FOREVER go", world.session_file(session_id).read_text())
        b.send({"type": "resume_session", "path": f"{session_id}.json", "request_id": "r"})
        resumed = b.wait(lambda e: e.get("type") == "session" and e.get("request_id") == "r", 60)
        self.assertEqual(resumed["session_id"], session_id)

    def test_an_editor_that_never_opts_in_gets_the_old_behaviour(self):
        world = World(self, scale=1.0)
        a, ready = self.opened(world, name="old-editor")
        a.send({"type": "prompt", "text": "TURN_FOREVER go", "request_id": "p1"})
        a.wait(lambda e: e.get("type") == "text_delta", 60)
        pid = a.proc.pid
        self.assertNotIn("socket", world.note(pid) or {}, "no socket until set_detach")
        a.close_stdin()                                       # the pipe ends: the process ends
        a.proc.wait(timeout=45)
        self.assertFalse((world.home / ".dgc" / "run").exists() and any((world.home / ".dgc" / "run").iterdir()))
        # `detach` from a client that never opted in is the old shutdown.
        b, _ = self.opened(world, name="old-editor-2")
        b.send({"type": "detach"})
        b.proc.wait(timeout=30)
        self.assertNotIn("windowless", world.serve_log())


# ------------------------------------------------- a ChatDGC reply through a reload (the home) ---
class ChatModel(Model):
    """Model's Work turns, and ChatDGC's: a reply to "CHAT_COUNT n" counts from 1 to n, a line a number, slowly;
    the calls around a reply (does it need the web, its name, follow-ups) are answered at once with nothing."""

    delay = 0.04

    def do_POST(self):
        from dgc.chatdgc.engine import FOLLOW_UP, LOOK_UP, NAME_PROMPT
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}"
        body = json.loads(raw)
        msgs = body.get("messages") or []
        last = msgs[-1] if msgs else {}
        asked = str(last.get("content") or "") if last.get("role") == "user" else ""
        if "CHAT_COUNT" not in asked:
            self.rfile = io.BytesIO(raw)
            return super().do_POST()
        first = str((msgs[0] or {}).get("content") or "")
        self._start()
        try:
            if first.startswith((LOOK_UP[:60], FOLLOW_UP[:60], NAME_PROMPT[:40])):
                answer = "Counting" if first.startswith(NAME_PROMPT[:40]) else "{}"
                return self._write(sse({"content": answer}) + sse({}, "stop") + "data: [DONE]\n\n")
            count = int(asked.split("CHAT_COUNT", 1)[1].split()[0])
            for number in range(1, count + 1):
                self._write(sse({"content": f"{number}\n"}))
                time.sleep(self.delay)
            self._write(sse({}, "stop") + "data: [DONE]\n\n")
        except OSError:
            return


def chat_lines(text):
    return [line for line in text.split("\n") if line]


@unittest.skipUnless(POSIX_SOCKETS, "a backend runs without a window on Linux and macOS")
class ChatDGCReloadIntegrationTests(unittest.TestCase):
    """The Sessions home's backend (it carries ChatDGC) opts in with set_detach_chatdgc: a ChatDGC reply keeps
    going through a reload, in the same backend, and the reopened chat shows every line of it once."""

    maxDiff = None

    def home(self, world, name, extra_env=None):
        serve = Serve(world, extra_env, name=name)
        ready = serve.wait(lambda e: e.get("type") == "ready", 90)
        serve.send({"type": "set_detach_chatdgc", "keep_running": True})
        return serve, ready

    def open_chat(self, serve, request_id, conversation_id=None):
        serve.send({"type": "chatdgc_open", "request_id": request_id,
                    **({"conversation_id": conversation_id} if conversation_id else {})})
        return serve.wait(lambda e: e.get("type") == "chatdgc_opened" and e.get("request_id") == request_id, 60)

    def test_a_reply_keeps_streaming_through_a_reload_and_every_line_shows_once(self):
        world = World(self, scale=0.01, handler=ChatModel)
        a, ready = self.home(world, "home-a")
        self.assertEqual(ready["capabilities"]["detach"]["chatdgc"], 1)
        home_session = ready["session_id"]
        chat = self.open_chat(a, "o1")["conversation"]["id"]
        a.send({"type": "chatdgc_send", "request_id": "s1", "conversation_id": chat, "text": "CHAT_COUNT 150"})
        a.wait(lambda e: e.get("type") == "chatdgc_delta" and "12\n" in e.get("text", ""), 60)
        backend = a.proc.pid
        a.send({"type": "detach"})
        a.close_stdin()
        wait_until(lambda: (world.note(backend) or {}).get("attached") is False, timeout=20,
                   what="the note to say the home's backend has no window")
        self.assertTrue(alive(backend), "the reply kept its backend running")
        note = world.note(backend)
        self.assertEqual(note["detach_scope"], "chatdgc")
        self.assertEqual([c["conversation_id"] for c in note["chatdgc"]], [chat])
        row = next(r for r in json.loads(world.dgc("ps", "--json").stdout) if r["pid"] == backend)
        self.assertEqual((row["scope"], [c["conversation_id"] for c in row["chats"]]), ("chatdgc", [chat]))
        self.assertIn("ChatDGC", row["work"])
        self.assertIn('chat "CHAT_COUNT 150"  (answering)', world.dgc("ps").stdout)

        # The window reloads: its home asks for its own backend back, and gets the same one.
        b, ready_b = self.home(world, "home-b", {"DGC_ATTACH_SESSION": home_session, "DGC_ATTACH": "restore"})
        self.assertEqual(b.events[0]["type"], "ready")
        self.assertEqual(ready_b["capabilities"]["attached"]["pid"], backend, "the same backend")
        self.assertNotEqual(b.proc.pid, backend)
        opened = self.open_chat(b, "o2", chat)
        self.assertTrue(opened["busy"])
        reply_id = opened["reply_id"]
        shown = opened["messages"][-1]
        self.assertEqual((shown["id"], shown["role"]), (reply_id, "assistant"), "the reply so far is in the chat")
        self.assertEqual(chat_lines(shown["text"])[:12], [str(n) for n in range(1, 13)])
        b.wait(lambda e: e.get("type") == "chatdgc_turn" and e.get("state") == "ended", 90)
        after = "".join(e.get("text", "") for e in b.events
                        if e.get("type") == "chatdgc_delta" and e.get("message_id") == reply_id
                        and e["seq"] > opened["seq"])
        lines = chat_lines(shown["text"] + after)
        self.assertEqual(lines, [str(n) for n in range(1, 151)], "every line once: what it opened with, then the rest")
        final = [e["message"] for e in b.events if e.get("type") == "chatdgc_message"
                 and e["message"]["id"] == reply_id][-1]
        self.assertEqual(chat_lines(final["text"]), lines, "the screen equals the saved chat")
        for serve in (a, b):
            for event in serve.events:
                self.assertIsNone(ep.event_error(event), event)
        # Its work done, the window going now ends it at once, as it always did.
        b.send({"type": "detach"})
        b.close_stdin()
        wait_until(lambda: not alive(backend), timeout=40, what="the exit")
        saved = json.loads(next((world.home / ".dgc" / "chat").rglob(f"{chat}.json")).read_text())
        self.assertEqual(chat_lines(saved["messages"][-1]["text"]), lines)

    def test_a_window_closed_mid_reply_finds_it_finished_and_saved(self):
        world = World(self, scale=0.05, handler=ChatModel)                # 2 minutes are 6s
        a, ready = self.home(world, "home-a")
        chat = self.open_chat(a, "o1")["conversation"]["id"]
        a.send({"type": "chatdgc_send", "request_id": "s1", "conversation_id": chat, "text": "CHAT_COUNT 60"})
        a.wait(lambda e: e.get("type") == "chatdgc_delta", 60)
        backend = a.proc.pid
        a.send({"type": "detach"})
        a.close_stdin()
        wait_until(lambda: not alive(backend), timeout=60, what="the reply to finish, then the idle exit")
        self.assertIn("windowless exit: no work for", world.serve_log())
        b = Serve(world, {"DGC_ATTACH_SESSION": ready["session_id"], "DGC_ATTACH": "restore"}, name="reopened")
        ready_b = b.wait(lambda e: e.get("type") == "ready", 90)
        self.assertNotIn("attached", ready_b["capabilities"], "nothing to attach to: a normal start")
        opened = self.open_chat(b, "o2", chat)
        self.assertFalse(opened["busy"])
        reply = opened["messages"][-1]
        self.assertEqual((chat_lines(reply["text"]), reply["finish"]), ([str(n) for n in range(1, 61)], "stop"))

    def test_with_no_chatdgc_reply_the_homes_window_going_ends_it_as_before(self):
        world = World(self, scale=1.0, handler=ChatModel)
        a, _ready = self.home(world, "home-a")
        a.send({"type": "prompt", "text": "TURN_FOREVER go", "request_id": "p1"})   # the home's own chat works
        a.wait(lambda e: e.get("type") == "text_delta", 60)
        backend = a.proc.pid
        a.send({"type": "detach"})
        a.close_stdin()
        wait_until(lambda: not alive(backend), timeout=40, what="the exit")
        self.assertIn("with nothing running", world.serve_log())

    def test_an_older_dgc_still_answering_is_saved_stopped_and_opened_here(self):
        world = World(self, scale=1.0, handler=ChatModel)
        a, ready = self.home(world, "home-old")
        chat = self.open_chat(a, "o1")["conversation"]["id"]
        a.send({"type": "chatdgc_send", "request_id": "s1", "conversation_id": chat, "text": "CHAT_COUNT 2000"})
        a.wait(lambda e: e.get("type") == "chatdgc_delta" and "5\n" in e.get("text", ""), 60)
        backend = a.proc.pid
        a.send({"type": "detach"})
        a.close_stdin()
        wait_until(lambda: (world.note(backend) or {}).get("attached") is False, timeout=20, what="windowless")
        path = world.home / ".dgc" / "peers" / f"{backend}.json"
        note = json.loads(path.read_text())
        note["version"] = "0.47.1"
        path.write_text(json.dumps(note))
        b, ready_b = self.home(world, "home-new", {"DGC_ATTACH_SESSION": ready["session_id"], "DGC_ATTACH": "restore"})
        self.assertNotIn("attached", ready_b["capabilities"], "never attached across versions")
        self.assertFalse(alive(backend), "the older one saved and stopped first")
        reply = self.open_chat(b, "o2", chat)["messages"][-1]
        self.assertEqual(reply["finish"], "cancelled", "stopped where it was, saved, and Continue is offered")
        self.assertEqual(chat_lines(reply["text"])[:5], ["1", "2", "3", "4", "5"])


if __name__ == "__main__":
    unittest.main()
