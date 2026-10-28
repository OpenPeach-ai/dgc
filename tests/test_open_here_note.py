"""The line beside Open here says where a chat is open and what runs there (dgc/holder_note.py).

One window writes to a chat at a time; another shows it read-only with Open here. That window, the
window a chat was taken from, and the terminal resuming the session now say WHERE it is open (the
holding window's editor, its folder shown with "~") and WHAT RUNS THERE (working now or idle how
long; monitors, background helpers, background commands, queued prompts, questions waiting for an
answer), from the holding process's own peer note. Nothing is invented: a note without those facts
(an older DGC) gives none, and the editor keeps its plain sentence.

Unit tests cover the words, the facts a process writes and reads, the protocol and the terminal's
lines; the integration test starts real `python -m dgc serve` processes in a throwaway HOME: window A
(Cursor) runs a turn, window B is refused and asks, B takes it with Open here (VS Code), and the
window it came from asks again and is told about B; `dgc -c` in a terminal says the same.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dgc import editor_protocol as ep                        # noqa: E402
from dgc import holder_note, peers, serve_detach, serve_relay  # noqa: E402

SESSION = "20261025-101500-abc123"


def facts(**over) -> dict:
    base = {"found": True, "editor": "Cursor", "windowless": False, "folder": "~/shop-api", "working": False,
            "idle_s": 6 * 60 + 20, "monitors": 0, "helpers": 0, "commands": 0, "queued": 0, "waiting": 0}
    base.update(over)
    return base


# --------------------------------------------------------------------------------- words ---
class WordsTests(unittest.TestCase):
    def test_where_and_idle(self):
        self.assertEqual(holder_note.where_words(facts()), "Cursor · ~/shop-api · idle 6 min")
        self.assertEqual(holder_note.terminal_line(facts()),
                         "This session is open in Cursor · ~/shop-api · idle 6 min. "
                         "Carry on there, or start a new session here.")

    def test_idle_rounds_down_and_grows_into_hours_and_days(self):
        self.assertEqual([holder_note.idle_words(s) for s in (0, 59, 60, 3599, 3600, 47 * 3600, 49 * 3600)],
                         ["idle under a minute", "idle under a minute", "idle 1 min", "idle 59 min", "idle 1 h",
                          "idle 47 h", "idle 2 days"])

    def test_working_now(self):
        self.assertEqual(holder_note.where_words(facts(working=True, idle_s=None)), "Cursor · ~/shop-api · working now")

    def test_windowless(self):
        line = holder_note.terminal_line(facts(windowless=True, editor="", working=True), pid=4242)
        self.assertEqual(line, "This session is kept running by DGC with no window open · ~/shop-api · working now. "
                               "Open it in the editor to pick it up, or run `dgc stop 4242`.")

    def test_each_running_thing_is_counted_and_none_named_when_none(self):
        self.assertEqual(holder_note.running_sentence(facts()), "")
        self.assertEqual(holder_note.waiting_sentence(facts()), "")
        self.assertEqual(holder_note.running_sentence(facts(monitors=1)), "1 monitor runs there.")
        self.assertEqual(holder_note.running_sentence(facts(monitors=2)), "2 monitors run there.")
        self.assertEqual(holder_note.running_sentence(facts(monitors=2, helpers=1)),
                         "2 monitors and 1 background helper run there.")
        self.assertEqual(holder_note.running_sentence(facts(helpers=3, commands=1)),
                         "3 background helpers and 1 background command run there.")
        self.assertEqual(holder_note.running_sentence(facts(monitors=1, helpers=1, commands=2)),
                         "1 monitor, 1 background helper and 2 background commands run there.")
        self.assertEqual(holder_note.waiting_sentence(facts(queued=1)), "1 queued prompt waits there.")
        self.assertEqual(holder_note.waiting_sentence(facts(queued=2)), "2 queued prompts wait there.")
        self.assertEqual(holder_note.waiting_sentence(facts(waiting=1)), "1 question waits for an answer there.")
        self.assertEqual(holder_note.waiting_sentence(facts(waiting=2, queued=1)),
                         "1 queued prompt and 2 questions wait there.")
        line = holder_note.terminal_line(facts(monitors=2, helpers=1, waiting=1))
        self.assertIn("idle 6 min. 2 monitors and 1 background helper run there. 1 question waits for an answer "
                      "there. Carry on there", line)

    def test_nothing_invented_when_the_holder_does_not_say_where(self):
        for unknown in (None, {"found": False}, facts(editor=""), facts(found=False), facts(editor="   ")):
            self.assertFalse(holder_note.usable(unknown))
            self.assertEqual(holder_note.terminal_line(unknown), "")
        self.assertTrue(holder_note.usable(facts(editor="", windowless=True)))
        # A part it can't tell is left out, never guessed.
        self.assertEqual(holder_note.where_words(facts(idle_s=None, folder="")), "Cursor")

    def test_the_folder_is_shown_with_a_tilde_never_another_users_path(self):
        home = "/home/ana"
        self.assertEqual(holder_note.folder_label("/home/ana/shop-api", home), "~/shop-api")
        self.assertEqual(holder_note.folder_label("/home/ana/work/app/", home), "~/work/app")
        self.assertEqual(holder_note.folder_label("/home/ana", home), "~")
        self.assertEqual(holder_note.folder_label("/home/bob/secret/proj", home), "proj")
        self.assertEqual(holder_note.folder_label("/home/anabel/x", home), "x", "a longer name is not inside it")
        self.assertEqual(holder_note.folder_label("/srv/build/app", home), "app")
        self.assertEqual(holder_note.folder_label("", home), "")

    def test_an_editor_name_is_one_short_printable_line(self):
        self.assertEqual(holder_note.clean_editor("  Cursor\n"), "Cursor")
        self.assertEqual(holder_note.clean_editor("Wind\x1b[31msurf"), "Wind[31msurf")
        self.assertEqual(len(holder_note.clean_editor("x" * 200)), holder_note.MAX_EDITOR_CHARS)


# ------------------------------------------------------------------- what a process writes ---
class _Chat:
    def __init__(self, session, root="/home/ana/app"):
        self.busy = False
        self.pending = SimpleNamespace(is_open=lambda rid: True)
        self.ui = SimpleNamespace(_open_requests={})
        self._queue = []
        self._foreground_worker = None
        self.shells = []
        self.running_monitors = []
        self.agent = SimpleNamespace(_detached_jobs={}, _troupes={},
                                     monitors=SimpleNamespace(running=lambda: self.running_monitors),
                                     session_file=Path(f"/x/{session}.json"))
        self.config = SimpleNamespace(project_root=root)

    def _busy(self):
        return self.busy

    def _background_items(self):
        return self.shells


class NoteTests(unittest.TestCase):
    def test_each_chat_says_how_many_of_each_run_there(self):
        chat = _Chat(SESSION)
        self.assertEqual(holder_note.chat_counts(chat), {"working": False, "monitors": 0, "helpers": 0,
                                                         "commands": 0, "queued": 0, "waiting": 0})
        chat.busy = True
        chat.running_monitors = ["m1", "m2"]
        chat.agent._detached_jobs = {"a1": object()}
        chat.agent._troupes = {"t": SimpleNamespace(state="running"), "u": SimpleNamespace(state="finished")}
        chat.shells = [{"state": "running"}, {"state": "exited"}, {"state": "running"}]
        chat._queue = [("next", None, None, "prompt", "q1"), ("woke", None, None, "monitor", "w1"),
                       ("slash", None, None, "prompt", None)]
        chat.ui._open_requests = {"perm-1": ("permission_request", {})}
        self.assertEqual(holder_note.chat_counts(chat), {"working": True, "monitors": 2, "helpers": 2,
                                                         "commands": 2, "queued": 1, "waiting": 1})

    def test_the_note_names_the_editor_and_never_a_session_it_only_shows_read_only(self):
        host = SimpleNamespace(chats={"c0": _Chat(SESSION), "c1": _Chat("viewed-only")})
        with patch.object(serve_relay, "_refused", {"session_id": "viewed-only", "pid": 1, "reason": "on_screen"}):
            block = holder_note.note_block(host, "Cursor")
        self.assertEqual(block["version"], 1)
        self.assertEqual(block["editor"], "Cursor")
        self.assertEqual([chat["session_id"] for chat in block["chats"]], [SESSION])
        self.assertEqual(block["chats"][0]["cwd"], "/home/ana/app")


# --------------------------------------------------------------------- what another reads ---
class ReadTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-open-here-"))
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        directory = self.home / "peers"
        directory.mkdir()
        self.directory = directory
        for patcher in (patch.object(peers, "peers_dir", lambda: directory),
                        patch.object(peers, "liveness", lambda record, now=None: "live")):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.session_file = self.home / f"{SESSION}.json"
        self.session_file.write_text("{}")
        changed = time.time() - 6 * 60 - 5
        os.utime(self.session_file, (changed, changed))

    def write(self, pid=4242, block=None, **over):
        record = {"pid": pid, "kind": "serve", "session": str(self.session_file), "cwd": "/home/ana/shop-api",
                  "project_root": "/home/ana/shop-api", "status": "idle", "heartbeat": time.time(), "attached": True}
        if block is not False:
            record["open_here"] = block or {"version": 1, "editor": "Cursor", "chats": [
                {"session_id": SESSION, "session": str(self.session_file), "cwd": "/home/ana/shop-api",
                 "working": False, "monitors": 2, "helpers": 1, "commands": 0, "queued": 0, "waiting": 0}]}
        record.update(over)
        (self.directory / f"{pid}.json").write_text(json.dumps(record))

    def test_where_it_is_open_and_how_long_idle(self):
        self.write()
        got = holder_note.session_facts(SESSION, home="/home/ana")
        self.assertEqual({k: got[k] for k in ("found", "editor", "windowless", "folder", "working", "monitors",
                                               "helpers", "commands", "queued", "waiting", "pid")},
                         {"found": True, "editor": "Cursor", "windowless": False, "folder": "~/shop-api",
                          "working": False, "monitors": 2, "helpers": 1, "commands": 0, "queued": 0, "waiting": 0,
                          "pid": 4242})
        self.assertGreaterEqual(got["idle_s"], 6 * 60)
        self.assertLess(got["idle_s"], 8 * 60)
        self.assertEqual(holder_note.where_words(got), "Cursor · ~/shop-api · idle 6 min")

    def test_working_now_has_no_idle_time(self):
        self.write(block={"version": 1, "editor": "Cursor", "chats": [
            {"session_id": SESSION, "session": str(self.session_file), "cwd": "/home/ana/shop-api", "working": True}]})
        got = holder_note.session_facts(SESSION, home="/home/ana")
        self.assertTrue(got["working"])
        self.assertNotIn("idle_s", got)

    def test_windowless_names_no_editor(self):
        self.write(attached=False)
        got = holder_note.session_facts(SESSION, home="/home/ana")
        self.assertTrue(got["windowless"])
        self.assertEqual(got["editor"], "")
        self.assertTrue(holder_note.usable(got))

    def test_an_older_dgcs_note_says_nothing(self):
        self.write(block=False)
        self.assertEqual(holder_note.session_facts(SESSION), {"found": False})
        self.write(block={"version": 2, "editor": "Cursor", "chats": []})
        self.assertEqual(holder_note.session_facts(SESSION), {"found": False})

    def test_a_window_that_has_not_named_its_editor_yet_is_not_guessed(self):
        self.write(block={"version": 1, "editor": "", "chats": [
            {"session_id": SESSION, "session": str(self.session_file), "cwd": "/w", "working": False}]})
        got = holder_note.session_facts(SESSION)
        self.assertTrue(got["found"])
        self.assertFalse(holder_note.usable(got))

    def test_nobody_holding_it_and_a_bad_id(self):
        self.assertEqual(holder_note.session_facts(SESSION), {"found": False})
        self.write()
        self.assertEqual(holder_note.session_facts("../x"), {"found": False})
        self.assertEqual(holder_note.session_facts("20261025-other"), {"found": False})

    def test_a_chatdgc_chat(self):
        chat = "chat_" + "a" * 32
        record = {"pid": 7, "kind": "serve", "cwd": "/home/ana/shop-api", "attached": True,
                  "open_here": {"version": 1, "editor": "VS Code", "chats": []},
                  "chatdgc": [{"conversation_id": chat, "title": "x"}]}
        got = holder_note.chatdgc_facts(record, chat, time.time() - 600, home="/home/ana")
        self.assertEqual({k: got[k] for k in ("found", "editor", "folder", "working")},
                         {"found": True, "editor": "VS Code", "folder": "~/shop-api", "working": True})
        self.assertNotIn("idle_s", got)
        record["chatdgc"] = []
        got = holder_note.chatdgc_facts(record, chat, time.time() - 600, home="/home/ana")
        self.assertFalse(got["working"])
        self.assertGreaterEqual(got["idle_s"], 600)
        self.assertEqual(holder_note.chatdgc_facts({"pid": 7, "kind": "serve"}, chat), {"found": False})
        self.assertEqual(holder_note.chatdgc_facts(None, chat), {"found": False})


# ------------------------------------------------------------------------------- protocol ---
class ProtocolTests(unittest.TestCase):
    def test_new_commands_and_events_only(self):
        self.assertIsNone(ep.command_error({"type": "editor_app", "name": "Cursor"}))
        self.assertIsNone(ep.command_error({"type": "session_holder", "request_id": "h1", "session_id": SESSION}))
        self.assertIsNone(ep.command_error({"type": "chatdgc_holder", "request_id": "h1",
                                            "conversation_id": "chat_" + "a" * 32}))
        self.assertIsNone(ep.event_error({"type": "session_holder", "seq": 1, "request_id": "h1",
                                          "session_id": SESSION, **facts()}))
        self.assertIsNone(ep.event_error({"type": "session_holder", "seq": 1, "request_id": "h1",
                                          "session_id": SESSION, "found": False}))
        self.assertIsNone(ep.event_error({"type": "chatdgc_holder", "seq": 1, "request_id": "h1",
                                          "conversation_id": "chat_" + "a" * 32, "found": True, "editor": "Cursor",
                                          "windowless": False, "folder": "~", "working": True}))
        # Nothing was added to an existing event: session_moved and chatdgc_held are as they were.
        self.assertEqual(set(ep.EVENT_FIELDS["session_moved"]), {"reason"})
        self.assertEqual(set(ep.EVENT_FIELDS["chatdgc_held"]), {"conversation_id", "state", "pid", "request_id"})


# --------------------------------------------------------------------------------- Host ---
class _FakeBoardHost:
    def __init__(self, chat):
        self.chats = {"c0": chat}
        self.core = SimpleNamespace(switch=lambda *a, **k: None, emit=lambda *a, **k: None)
        self.announced = 0
        self._editor_liveness = None
        self._chatdgc = None
        self.editor_app = "Cursor"
        self.wire_default = None

    def announce_peers(self):
        self.announced += 1

    def forget_editor(self):
        self.editor_app = ""

    def chat_for_session(self, session_id):
        return next(iter(self.chats.values()))


class SwitchboardTests(unittest.TestCase):
    def test_the_editors_name_goes_with_the_window_that_said_it(self):
        chat = _Chat(SESSION)
        chat._turn_state_lock = lambda: __import__("threading").RLock()
        chat.em = SimpleNamespace(history_lock=None)
        chat.chat_id = "c0"
        chat._ready_payload = lambda: {"capabilities": {}}
        chat._chat_fields = lambda: {}
        host = _FakeBoardHost(chat)
        home = Path(tempfile.mkdtemp(prefix="dgc-open-here-board-"))
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        board = serve_detach.Switchboard(host, home=home / ".dgc", scale=1.0, stdout=io.StringIO())
        board._redirect_stdio = lambda: None
        board.opted_in = True
        conn = serve_detach.Connection("socket", io.StringIO(), None, client="relay")
        board._switch_to(conn, chat, board.current, 0.0)
        self.assertEqual(host.editor_app, "", "Open here elsewhere: the new window says its own")
        host.editor_app = "VS Code"
        board.current = conn
        board.go_windowless(conn, "the editor's connection closed")
        self.assertEqual(host.editor_app, "", "no window: no editor")


class HostTests(unittest.TestCase):
    """A real Host: the capability, editor_app in its note, and session_holder's answer."""

    def setUp(self):
        from dgc import config as config_module, headless, sessions
        from dgc.config import Config
        tmp = Path(tempfile.mkdtemp(prefix="dgc-open-here-host-")).resolve()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        user_dgc = tmp / "user-dgc"
        user_dgc.mkdir()
        for name, value in (("USER_HOME", user_dgc), ("USER_CONFIG", user_dgc / "config.json"),
                            ("USER_SECRETS", user_dgc / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (user_dgc / "config.json").write_text(json.dumps({
            "model": "fixture", "base_url": "http://localhost.invalid/v1", "suggest": False,
            "artifact_autostart": False, "mcp_servers": {}}))
        for patcher in (patch.object(sessions, "SESSIONS_DIR", tmp / "sessions"),
                        patch.object(peers, "peers_dir", lambda: tmp / "peers")):
            patcher.start()
            self.addCleanup(patcher.stop)
        (tmp / "a").mkdir()
        self.tmp = tmp
        self.host = headless.Host(Config(project_root=tmp / "a"))
        self.wire = io.StringIO()
        self.host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(self.host.chats.values())])
        self.addCleanup(peers.withdraw)

    def frames(self):
        return [json.loads(line) for line in self.wire.getvalue().splitlines()]

    def test_ready_offers_it_and_editor_app_is_said_in_the_note(self):
        caps = self.host.default._ready_payload()["capabilities"]
        self.assertEqual(caps["session_holder"], 1)
        self.assertEqual(caps["chatdgc"]["holder"], 1)
        self.assertTrue(self.host.default.agent.own_session(), "a chat holds its session once it opens or writes it")
        self.host.dispatch({"type": "editor_app", "name": "Cursor"})
        self.assertEqual(self.host.editor_app, "Cursor")
        note = json.loads((self.tmp / "peers" / f"{os.getpid()}.json").read_text())
        self.assertEqual(note["open_here"]["editor"], "Cursor")
        stem = Path(str(self.host.default.agent.session_file)).stem
        self.assertEqual([c["session_id"] for c in note["open_here"]["chats"]], [stem])
        self.assertEqual(self.frames(), [], "nothing answers editor_app")

    def test_a_turn_starting_while_the_last_one_refreshes_its_note_keeps_its_live_state(self):
        """The note is refreshed at each turn's end, after the worker let the next prompt start a worker of its own.
        The retiring worker used to clear the turn state on its way out, the NEW turn's: a reload's snapshot then
        replayed the running turn closed (its open question answered "not answered"). A slow refresh makes it
        certain."""
        import threading
        from dgc import headless
        from waiting import wait_until
        backend = self.host.default
        started, release = threading.Event(), threading.Event()
        refreshed = threading.Event()

        def run_turn(text, reset_cancel=False, **_kw):
            if "second" in text:
                started.set()
                release.wait(10)
            return True

        def slow_refresh(chat, status="idle"):
            if status == "idle":
                time.sleep(0.8)                          # the retiring worker, still busy with the note
                refreshed.set()

        backend.agent.run_turn = run_turn
        with patch.object(headless.Backend, "_announce_peer", slow_refresh):
            self.host.dispatch({"type": "prompt", "text": "first", "request_id": "p1"})
            wait_until(lambda: any(f.get("type") == "turn_end" for f in self.frames()), timeout=10, what="the first turn")
            self.host.dispatch({"type": "prompt", "text": "second", "request_id": "p2"})
            self.assertTrue(started.wait(10), "the second turn started")
            self.assertTrue(refreshed.wait(10))
            time.sleep(0.2)                              # past the first worker's way out
            with backend._turn_state_lock():
                live, kind = backend._live_turn, backend._running_turn_kind
            release.set()
        self.assertEqual(kind, "prompt", "the running turn is still the running turn")
        self.assertIsInstance(live, dict)
        self.assertIsNotNone(live.get("id"))

    def test_session_holder_answers_from_the_other_process_note(self):
        other = {"pid": 4242, "kind": "serve", "cwd": str(self.tmp), "heartbeat": time.time(), "attached": True,
                 "open_here": {"version": 1, "editor": "Windsurf", "chats": [
                     {"session_id": SESSION, "session": "", "cwd": str(self.tmp / "a"), "working": True,
                      "monitors": 1, "helpers": 0, "commands": 0, "queued": 2, "waiting": 0}]}}
        (self.tmp / "peers").mkdir(exist_ok=True)
        (self.tmp / "peers" / "4242.json").write_text(json.dumps(other))
        with patch.object(peers, "liveness", lambda record, now=None: "live"):
            self.host.dispatch({"type": "session_holder", "request_id": "h1", "session_id": SESSION})
            self.host.dispatch({"type": "session_holder", "request_id": "h2", "session_id": "20261025-nobody"})
        answers = [f for f in self.frames() if f["type"] == "session_holder"]
        for frame in answers:
            self.assertIsNone(ep.event_error(frame), frame)
        self.assertEqual(answers[0]["request_id"], "h1")
        self.assertEqual({k: answers[0][k] for k in ("found", "editor", "working", "monitors", "queued")},
                         {"found": True, "editor": "Windsurf", "working": True, "monitors": 1, "queued": 2})
        self.assertNotIn("pid", answers[0])
        self.assertEqual(answers[0]["folder"], "a", "outside the home folder: only its name")
        self.assertEqual({k: answers[1][k] for k in ("request_id", "found")}, {"request_id": "h2", "found": False})


# ------------------------------------------------------------------------------ terminal ---
class TerminalTests(unittest.TestCase):
    def test_resuming_a_session_a_window_holds_says_where_and_what_runs(self):
        with patch.object(holder_note, "session_facts", lambda stem, **kw: facts(monitors=2, helpers=1, pid=99)):
            line = holder_note.resume_note(Path(f"/x/{SESSION}.json"))
        self.assertEqual(line, "This session is open in Cursor · ~/shop-api · idle 6 min. 2 monitors and 1 "
                               "background helper run there. Carry on there, or start a new session here.")
        with patch.object(holder_note, "session_facts", lambda stem, **kw: {"found": False}):
            self.assertEqual(holder_note.resume_note(Path(f"/x/{SESSION}.json")), "")

    def test_the_classic_terminal_says_it_after_resuming(self):
        from dgc import cli
        said = []
        fake = SimpleNamespace(agent=SimpleNamespace(session_file=Path(f"/x/{SESSION}.json")),
                               ui=SimpleNamespace(info=said.append))
        with patch.object(holder_note, "session_facts", lambda stem, **kw: facts(working=True, waiting=1, pid=9)):
            cli.CLI._say_holder(fake)
        self.assertEqual(said, ["This session is open in Cursor · ~/shop-api · working now. 1 question waits for "
                                "an answer there. Carry on there, or start a new session here."])

    def test_a_message_refused_because_its_panel_is_on_screen_names_the_same_facts(self):
        from dgc import agent as agent_module
        fake = SimpleNamespace(session_file=Path(f"/x/{SESSION}.json"), _held_session_note={"pid": 9, "kind": "serve"},
                               _held_session_reason=peers.REFUSED_ON_SCREEN, _sibling_holding=None)
        with patch.object(holder_note, "session_facts", lambda stem: facts(monitors=1)):
            text = agent_module.Agent._held_session_message(fake, "No model request or workspace action was started.")
        self.assertEqual(text, "This session is open in Cursor · ~/shop-api · idle 6 min, and its DGC panel is on "
                               "screen. 1 monitor runs there. Carry on there, or start a new session here. No model "
                               "request or workspace action was started.")
        # An older DGC's note: named as before.
        with patch.object(holder_note, "session_facts", lambda stem: {"found": False}):
            text = agent_module.Agent._held_session_message(fake, "tail.")
        self.assertIn("its DGC panel is on screen", text)
        self.assertIn("pid 9", text)


# --------------------------------------------------------- real windows, Open here, a terminal ---
try:
    from test_session_detach import POSIX_SOCKETS, ChatModel, Serve, World, alive   # noqa: E402
except Exception:                                            # noqa: BLE001
    POSIX_SOCKETS = False


@unittest.skipUnless(POSIX_SOCKETS, "a session runs without a window on Linux and macOS")
class OpenHereIntegrationTests(unittest.TestCase):
    maxDiff = None

    def ask(self, serve, session_id, request_id):
        serve.send({"type": "session_holder", "request_id": request_id, "session_id": session_id})
        return serve.wait(lambda e: e.get("type") == "session_holder" and e.get("request_id") == request_id, 30)

    def test_two_windows_open_here_and_a_terminal(self):
        from waiting import wait_until
        world = World(self, scale=1.0)
        a = Serve(world, name="window-a")
        ready = a.wait(lambda e: e.get("type") == "ready", 90)
        self.assertEqual(ready["capabilities"]["session_holder"], 1)
        session_id = ready["session_id"]
        a.send({"type": "set_detach", "keep_running": True})
        a.send({"type": "editor_app", "name": "Cursor"})
        a.send({"type": "editor_state", "source": "renderer", "view": "open"})
        a.send({"type": "prompt", "text": "TURN_FOREVER go", "request_id": "p1"})
        a.wait(lambda e: e.get("type") == "text_delta", 60)
        wait_until(lambda: ((world.note(a.proc.pid) or {}).get("open_here") or {}).get("editor") == "Cursor"
                   and (world.note(a.proc.pid) or {}).get("socket"), timeout=20, what="A's note")
        # Window B opens the same session: refused, read-only, and it asks where it is open.
        b = Serve(world, {"DGC_ATTACH_SESSION": session_id, "DGC_ATTACH": "auto"}, name="window-b")
        b_ready = b.wait(lambda e: e.get("type") == "ready", 90)
        self.assertEqual(b_ready["capabilities"]["detach"]["elsewhere"]["pid"], a.proc.pid)
        b.send({"type": "editor_app", "name": "VS Code"})
        b.send({"type": "watch_session_owner"})            # as the editor does: it shows a held session read-only
        b.send({"type": "resume_session", "path": f"{session_id}.json", "request_id": "r"})
        b.wait(lambda e: e.get("type") == "session" and e.get("request_id") == "r", 60)
        b.wait(lambda e: e.get("type") == "session_held" and e.get("session_id") == session_id, 30)
        told = self.ask(b, session_id, "h-b")
        self.assertEqual({k: told.get(k) for k in ("found", "editor", "windowless", "folder", "working")},
                         {"found": True, "editor": "Cursor", "windowless": False, "folder": world.work.name,
                          "working": True})
        self.assertNotIn(str(world.base), json.dumps(told), "never a full path")
        b.stop()
        # The terminal resuming it says the same, and a message sent there is refused naming it.
        out = world.dgc("-c", "-p", "TURN_SHORT hello", timeout=120)
        said = " ".join((out.stdout + out.stderr).split())              # the terminal wraps long lines
        self.assertIn(f"This session is open in Cursor · {world.work.name} · working now.", said)
        self.assertIn("its DGC panel is on screen", said)
        # Open here in C (VS Code): A is told it moved, and asks again -- from the window's other backend -- and is
        # told about C.
        c = Serve(world, {"DGC_ATTACH_SESSION": session_id, "DGC_ATTACH": "steal"}, name="window-c")
        c.wait(lambda e: e.get("type") == "ready", 60)
        c.send({"type": "editor_app", "name": "VS Code"})
        a.wait(lambda e: e.get("type") == "session_moved", 30)
        home = Serve(world, name="window-a-home")
        home.wait(lambda e: e.get("type") == "ready", 90)
        wait_until(lambda: ((world.note(a.proc.pid) or {}).get("open_here") or {}).get("editor") == "VS Code",
                   timeout=20, what="the note to name the new window's editor")
        told = self.ask(home, session_id, "h-a")
        self.assertEqual({k: told.get(k) for k in ("found", "editor", "windowless", "working")},
                         {"found": True, "editor": "VS Code", "windowless": False, "working": True})
        for serve in (a, b, c, home):
            for event in serve.events:
                self.assertIsNone(ep.event_error(event), event)
        c.send({"type": "shutdown"})
        wait_until(lambda: not alive(a.proc.pid), timeout=30, what="the shutdown through C")

    def test_a_chatdgc_chat_another_window_writes_and_after_open_here(self):
        from waiting import wait_until
        world = World(self, scale=0.05, handler=ChatModel)

        def home(name, editor):
            serve = Serve(world, name=name)
            ready = serve.wait(lambda e: e.get("type") == "ready", 90)
            self.assertEqual(ready["capabilities"]["chatdgc"]["holder"], 1)
            serve.send({"type": "set_detach_chatdgc", "keep_running": True})
            serve.send({"type": "chatdgc_shown", "conversation_ids": []})
            serve.send({"type": "editor_app", "name": editor})
            return serve

        def ask(serve, chat, request_id):
            serve.send({"type": "chatdgc_holder", "request_id": request_id, "conversation_id": chat})
            return serve.wait(lambda e: e.get("type") == "chatdgc_holder" and e.get("request_id") == request_id, 30)

        a, b = home("home-a", "Cursor"), home("home-b", "VS Code")
        a.send({"type": "chatdgc_open", "request_id": "o1"})
        chat = a.wait(lambda e: e.get("type") == "chatdgc_opened" and e.get("request_id") == "o1", 60)["conversation"]["id"]
        a.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        a.send({"type": "chatdgc_send", "request_id": "s1", "conversation_id": chat, "text": "CHAT_COUNT 400"})
        a.wait(lambda e: e.get("type") == "chatdgc_delta" and "12\n" in e.get("text", ""), 60)
        wait_until(lambda: chat in ((world.note(a.proc.pid) or {}).get("chatdgc_held") or []), timeout=20,
                   what="A's note to hold the chat")
        b.send({"type": "chatdgc_open", "request_id": "o2", "conversation_id": chat})
        b.wait(lambda e: e.get("type") == "chatdgc_held" and e.get("state") == "elsewhere", 30)
        told = ask(b, chat, "q1")
        self.assertEqual({k: told.get(k) for k in ("found", "editor", "windowless", "folder", "working")},
                         {"found": True, "editor": "Cursor", "windowless": False, "folder": world.work.name,
                          "working": True})
        # Open here in B mid-reply: the window it came from is told about B, and the reply still being written.
        b.send({"type": "chatdgc_open_here", "request_id": "h1", "conversation_id": chat})
        a.wait(lambda e: e.get("type") == "chatdgc_held" and e.get("state") == "moved", 40)
        wait_until(lambda: chat in ((world.note(b.proc.pid) or {}).get("chatdgc_held") or []), timeout=20,
                   what="B's note to hold it")
        told = ask(a, chat, "q2")
        self.assertEqual({k: told.get(k) for k in ("found", "editor", "working")},
                         {"found": True, "editor": "VS Code", "working": True})
        b.wait(lambda e: e.get("type") == "chatdgc_turn" and e.get("state") == "ended", 120)
        wait_until(lambda: not ((world.note(a.proc.pid) or {}).get("chatdgc") or []), timeout=30,
                   what="the reply to end")
        told = ask(a, chat, "q3")
        self.assertEqual({k: told.get(k) for k in ("found", "editor", "working")},
                         {"found": True, "editor": "VS Code", "working": False})
        self.assertLess(told["idle_s"], 120)
        for serve in (a, b):
            for event in serve.events:
                self.assertIsNone(ep.event_error(event), event)


if __name__ == "__main__":
    unittest.main()
