"""Background monitors in the full-screen TUI: callbacks only queue, the UI loop renders and wakes,
a wake turn is a monitor band (never a typed prompt), and typing during one takes over."""
from __future__ import annotations

import contextlib
import copy
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path


def _real_account_home() -> str:
    """The real account's home, never the one this suite redirected.

    Windows has no passwd database, and expanduser("~") reads the USERPROFILE the suite
    redirects, which would make a correctly isolated run look like a contaminating one.
    HOMEDRIVE/HOMEPATH are set by the OS at logon and nothing here rewrites them.
    """
    try:
        import pwd
        return pwd.getpwuid(os.getuid()).pw_dir
    except (ImportError, KeyError, AttributeError):
        drive, tail = os.environ.get("HOMEDRIVE", ""), os.environ.get("HOMEPATH", "")
        return (drive + tail) if drive and tail else os.path.expanduser("~")


_REAL_HOME = _real_account_home()
if "dgc.config" in sys.modules:                    # imported by another module first: verify, never assume
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_monitors_tui.py needs HOME redirected before dgc is imported — "
                           "run it through tests/run_tests.py or with HOME=<tmp>")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-monitors-tui-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc.agent import Agent                                        # noqa: E402
from dgc.config import Config, DEFAULTS                            # noqa: E402
from dgc.llm import ChatResult                                     # noqa: E402
from dgc.monitors import Batch, Notification, render_notification  # noqa: E402


def make_config(root: Path) -> Config:
    cfg = object.__new__(Config)
    cfg.project_root, cfg.project_dir, cfg._persist = root, root / ".dgc", False
    cfg.data = copy.deepcopy(DEFAULTS)
    cfg.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="auto",
                    hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                    thinking="off", notes=False)
    cfg._stored_secrets, cfg._env_secret_keys, cfg._explicit_keys = {}, set(), set()
    cfg.permissions = {"allow": [], "ask": [], "deny": []}
    return cfg


class _SilentUI:
    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


def group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # macOS answers EPERM, not ESRCH, while the group's only member is a zombie its reader
        # thread has not reaped yet: still there, so poll again (as tests/test_monitors.py does).
        return True


def wait_for(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return bool(predicate())


class TuiMonitorTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-monitors-tui-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.config = make_config(self.root)
        self.agent = Agent(self.config, _SilentUI())
        self.addCleanup(self.agent.mcp.stop_all)
        self.addCleanup(lambda: self.agent.monitors.shutdown(wait=3.0))

    def tui(self):
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.data_structures import Size
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput
        from dgc.tui import TUI

        class Output(DummyOutput):
            def get_size(self):
                return Size(rows=30, columns=160)

        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        pipe = stack.enter_context(create_pipe_input())
        stack.enter_context(create_app_session(input=pipe, output=Output()))
        return TUI(self.config, agent=self.agent)

    @staticmethod
    def plain(formatted) -> str:
        from prompt_toolkit.formatted_text import fragment_list_to_text, to_formatted_text
        return fragment_list_to_text(to_formatted_text(formatted))

    def block_text(self, ui, block) -> str:
        if isinstance(block, dict) and block.get("kind") == "tool":
            return self.plain(ui._tool_frags(block))
        if isinstance(block, dict):
            return str(block.get("text", ""))
        return str(block)

    def second_session(self, ui):
        from dgc.tui import AgentSession
        root = Path(tempfile.mkdtemp(prefix="dgc-monitors-tui-second-"))
        config = make_config(root)
        agent = Agent(config, ui)
        self.addCleanup(agent.mcp.stop_all)
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        session = AgentSession(config, ui, agent=agent)
        ui._sessions.append(session)
        return session

    def test_the_tui_declares_itself_a_monitor_frontend(self):
        ui = self.tui()
        self.assertIs(ui.monitor_wake_enabled, True)
        self.agent._activate_tool_intents("watch the log", replace=True)
        self.assertIn("monitor", {t["function"]["name"] for t in self.agent._tool_schemas()})

    def test_a_reader_thread_only_queues_and_the_ui_tick_renders_into_its_own_session(self):
        ui = self.tui()
        second = self.second_session(ui)
        active_before = list(ui.active.blocks)
        batch = Batch("mon7", "deploy \x1b[31mred", "output", lines=["line \x1b]8;;evil\x07one"],
                      event_index=1)
        note = Notification([batch], render_notification([batch]), "deploy · 1 event")
        hub = second.agent.monitors
        worker = threading.Thread(target=lambda: (
            hub._notify("started", {"id": "mon7", "description": "deploy"}),
            hub._notify("delivered", {"notification": note, "delivery": "inline"})))
        worker.start()
        worker.join(5)
        self.assertEqual(len(second._monitor_inbox), 2)
        self.assertEqual(second.blocks, [], "nothing is rendered from the reader thread")
        self.assertTrue(ui._service_monitors())
        self.assertEqual(ui.active.blocks, active_before, "the active session is untouched")
        rendered = "\n".join(self.block_text(ui, block) for block in second.blocks)
        self.assertIn("mon7", rendered)
        self.assertIn("Monitor event", rendered)
        self.assertNotIn("\x1b[31m", rendered, "command text cannot style the terminal")
        self.assertNotIn("\x1b]8", rendered, "nor inject a link")
        self.assertIn("\\u001b", rendered, "it is shown, escaped")
        self.assertEqual(len(second._monitor_inbox), 0)

    def test_idle_wake_waits_for_every_reason_to_hold_off(self):
        ui = self.tui()
        sess = ui.active
        hub = sess.agent.monitors
        calls = []
        ui._submit_monitor_wake = lambda s, n: calls.append((s, n, getattr(ui._tls, "session", None)))
        hub.queue_background_exit("bg1", "build", 0, 1.0, "ok", hub.epoch)
        hub.policy.note_turn_end()
        ui._service_monitors()
        self.assertEqual(calls, [], "within the wake delay")
        hub.policy.last_turn_end = time.monotonic() - 60
        for hold, undo in (
                (lambda: sess._turn.set(), lambda: sess._turn.clear()),
                (lambda: setattr(sess, "_req", {"kind": "approve"}), lambda: setattr(sess, "_req", None)),
                (lambda: hub.policy.pause("test"), lambda: hub.policy.resume()),
                (lambda: self.config.data.update(mode="plan"), lambda: self.config.data.update(mode="auto")),
                (lambda: self.config.data.update(monitor_wake=False),
                 lambda: self.config.data.update(monitor_wake=True)),
                (lambda: setattr(ui.input_buf, "text", "a draft"), lambda: ui.input_buf.reset())):
            hold()
            ui._service_monitors()
            self.assertEqual(calls, [])
            undo()
        ui._draft_changed_at = 0.0
        ui._service_monitors()
        self.assertEqual(len(calls), 1)
        self.assertIs(calls[0][0], sess)
        self.assertIs(calls[0][2], sess, "routed with the thread-local session set to that session")
        self.assertIsNone(getattr(ui._tls, "session", None), "and restored after")
        ui._service_monitors()
        self.assertEqual(len(calls), 1, "the events were taken once")

    def test_status_line_and_the_monitors_command(self):
        ui = self.tui()
        hub = self.agent.monitors
        out = hub.start({"command": "sleep 20", "description": "deploy log", "persistent": True},
                        self.agent.ctx)
        self.assertTrue(out.startswith("started"), out)
        mid = hub.running()[0].id
        status = self.plain(ui._status())
        self.assertIn("1 monitor", status)
        self.assertIn(mid, status)
        self.assertIn("deploy log", status)
        ui._turn.set()
        ui._turn_t0 = time.monotonic()
        self.assertIn("◉1", self.plain(ui._status()))
        ui._turn.clear()
        ui._handle_slash("/monitors")
        self.assertIn("background monitors", str(ui.blocks[-1]))
        ui._handle_slash("/monitors wake off")
        self.assertIs(self.config.data["monitor_wake"], False)
        hub.policy.pause("x")
        ui._handle_slash("/monitors wake on")
        self.assertIs(self.config.data["monitor_wake"], True)
        self.assertFalse(hub.policy.paused)
        ui._handle_slash(f"/monitors show {mid}")
        self.assertEqual(ui.blocks[-1]["route_name"], "bash_output")
        pgid = hub.running()[0].pgid
        ui._handle_slash("/monitors stop all")
        self.assertTrue(wait_for(lambda: not hub.running() and not group_alive(pgid), 8))

    def test_a_wake_turn_is_a_monitor_band_and_skips_turn_end_side_effects(self):
        ui = self.tui()
        sess = ui.active
        self.agent._chat = lambda *a, **k: ChatResult(content="noted")
        ui._notify_armed = True
        paused, scheduled = [], []
        ui._pause_pane = lambda reason: paused.append(reason)
        ui._schedule_auxiliary = lambda *a, **k: scheduled.append(a)
        hub = self.agent.monitors
        hub.queue_background_exit("bg2", "make build", 0, 3.0, "built", hub.epoch)
        ui._submit_monitor_wake(sess, hub.take_pending())
        worker = sess._worker_thread
        worker.join(10)
        self.assertFalse(worker.is_alive())
        bands = [b for b in sess.blocks if isinstance(b, dict) and b.get("kind") == "user"]
        # A background command's exit woke this turn, and a background command is not a monitor.
        self.assertEqual([b.get("tag") for b in bands], ["background command · woke on its exit"])
        self.assertEqual(ui._prompt_history, [], "a wake is not prompt history")
        self.assertTrue(ui._notify_armed, "the user's /notify stays armed for their own turn")
        self.assertEqual(paused, [])
        self.assertEqual(scheduled, [])
        self.assertEqual(hub.policy.consecutive, 1)
        from dgc.workflows import notice_kind
        self.assertEqual([m["_dgc_notice"]["delivery"] for m in self.agent.messages if notice_kind(m)],
                         ["wake"])

    def test_typing_during_a_wake_turn_takes_over_without_pausing_wakes(self):
        ui = self.tui()
        sess = ui.active
        entered = threading.Event()
        requests = []

        def chat(*args, **kwargs):
            requests.append(kwargs.get("request_reason"))
            if len(requests) == 1:
                entered.set()
                while not self.agent.cancelled.is_set():
                    time.sleep(0.02)
                return ChatResult(content="", finish_reason="cancelled")
            return ChatResult(content="answered")
        self.agent._chat = chat
        hub = self.agent.monitors
        hub.queue_background_exit("bg3", "deploy", 1, 3.0, "failed", hub.epoch)
        ui._submit_monitor_wake(sess, hub.take_pending())
        self.assertTrue(entered.wait(10))
        self.assertEqual(ui._route_followup("what happened?"), "queued")
        self.assertTrue(wait_for(lambda: any(
            isinstance(b, dict) and b.get("kind") == "user" and b.get("text") == "what happened?"
            for b in sess.blocks), 10), "the message runs as the next turn")
        self.assertTrue(wait_for(lambda: not sess._turn.is_set() and "user_turn" in requests, 10))
        self.assertFalse(hub.policy.paused, "yielding is not a stop")

    def test_history_shows_a_wake_as_a_monitor_band_not_a_prompt(self):
        batch = Batch("mon1", "deploy", "output", lines=["DEPLOYED"], event_index=1)
        note = Notification([batch], render_notification([batch]), "deploy · 1 event")
        self.agent.messages += [{"role": "user", "content": "deploy it"},
                                {"role": "assistant", "content": "deploying"},
                                self.agent._notice_message(note, "wake"),
                                {"role": "assistant", "content": "deployed"}]
        ui = self.tui()
        users = [b for b in ui.blocks if isinstance(b, dict) and b.get("kind") == "user"]
        self.assertEqual([(b["text"], b.get("tag")) for b in users],
                         [("deploy it", None), ("deploy · 1 event", "monitor · woke on an event")])
        self.assertFalse(any("DEPLOYED" in str(b) for b in ui.blocks if not isinstance(b, dict)
                             or b.get("kind") == "user"))

    def test_history_names_a_background_command_wake_as_one(self):
        batch = Batch("bg1", "sleep 20 && echo done", "background_exit", lines=["exited 0 after 20.0s", "done"])
        note = Notification([batch], render_notification([batch]), "sleep 20 && echo done · exited")
        self.agent.messages += [{"role": "user", "content": "run it in the background"},
                                {"role": "assistant", "content": "started"},
                                self.agent._notice_message(note, "wake"),
                                {"role": "assistant", "content": "it finished"}]
        ui = self.tui()
        tags = [b.get("tag") for b in ui.blocks if isinstance(b, dict) and b.get("kind") == "user"]
        self.assertEqual(tags, [None, "background command · woke on its exit"])

    def test_closing_a_session_stops_its_monitors(self):
        ui = self.tui()
        second = self.second_session(ui)
        out = second.agent.monitors.start({"command": "sleep 30", "description": "x", "persistent": True},
                                          second.agent.ctx)
        self.assertTrue(out.startswith("started"), out)
        pgid = second.agent.monitors.running()[0].pgid
        ui._close_session(1)
        self.assertTrue(wait_for(lambda: not group_alive(pgid), 8))

    def test_a_command_typed_during_a_wake_turn_runs_when_the_turn_has_yielded(self):
        ui = self.tui()
        sess = ui.active
        entered = threading.Event()

        def chat(*args, **kwargs):
            entered.set()
            while not self.agent.cancelled.is_set():
                time.sleep(0.02)
            return ChatResult(content="", finish_reason="cancelled")
        self.agent._chat = chat
        ran = []
        original = ui._handle_slash
        ui._handle_slash = lambda text: (ran.append(text), original(text))[1]
        hub = self.agent.monitors
        hub.queue_background_exit("bg5", "deploy", 0, 1.0, "ok", hub.epoch)
        ui._submit_monitor_wake(sess, hub.take_pending())
        self.assertTrue(entered.wait(10))
        self.assertEqual(ui._dispatch_composer_text("/rewind"), "local-command")
        self.assertEqual(ran, [], "not while the wake turn still runs")
        self.assertTrue(wait_for(lambda: not sess._turn.is_set()
                                 and not (sess._worker_thread and sess._worker_thread.is_alive()), 10))
        ui._service_monitors()
        self.assertEqual(ran, ["/rewind"])
        self.assertFalse(hub.policy.paused)


    def test_new_in_the_terminal_says_the_previous_agent_keeps_its_monitors(self):
        # /new in the TUI opens another fleet agent; it does not replace the chat, so the earlier
        # chat's monitors keep running (and can wake it). That is now said, not hidden.
        ui = self.tui()
        out = self.agent.monitors.start({"command": "sleep 30", "description": "keepalive",
                                         "persistent": True}, self.agent.ctx)
        self.assertTrue(out.startswith("started"), out)
        self.assertNotIn("on /new", out, "the tool result no longer promises /new stops it")
        created = ui._new_session()
        self.assertIsNotNone(created, ui._flash_msg)
        self.addCleanup(created.agent.mcp.stop_all)
        self.addCleanup(lambda: created.agent.monitors.shutdown(wait=3.0))
        self.assertIn("the previous agent still runs 1 monitor", ui._flash_msg)
        # The status row is a single line: at 130 columns the flash was cut before it said how to
        # stop the monitor. The instruction now comes before the branch name, and stays up to read.
        self.assertIn("/monitors stop", ui._flash_msg[:120], ui._flash_msg)
        self.assertLess(ui._flash_msg.index("/monitors stop"), ui._flash_msg.index(created.workspace_branch or "shared"))
        self.assertIn("Ctrl+\\ back to it", ui._flash_msg)
        self.assertGreater(ui._flash_until - time.monotonic(), 4.0)
        # Wider than the terminal, it stays on the status row's one line and ends in an ellipsis.
        import re
        ui._width = 90
        shown = re.sub(r"\x1b\[[0-9;]*m", "", ui._status().value).rstrip("\n")
        self.assertNotIn("\n", shown)
        self.assertTrue(shown.rstrip().endswith("…"), shown)
        self.assertEqual(len(self.agent.monitors.running()), 1)

    def test_the_monitor_docs_match_the_terminal_and_the_gating(self):
        from dgc import docs
        pages = {title: " ".join(body.split()) for title, _summary, body in docs.DOCS}
        monitors = pages["Background monitors"]
        self.assertNotIn("They stop on `/new`", monitors)
        self.assertIn("In the terminal `/new` opens another agent", monitors)
        self.assertIn("watch or wait for something", monitors)
        self.assertIn("`tool_profile` is `full`", monitors)
        usage = pages["Token usage"]
        self.assertNotIn("for the rest of the session", usage)
        self.assertIn("until DGC restarts", usage)

    def test_a_long_card_row_wraps_inside_the_rail_and_a_big_event_has_one_hint(self):
        from dgc.monitors import Batch
        from dgc import glyphs
        ui = self.tui()
        ui._width = 60
        long_line = "); stop it with monitor_stop(id=\"mon1\") and read it with bash_output " * 2
        block = {"kind": "tool", "name": "monitor", "route_name": "monitor", "call_id": None,
                 "summary": "watch", "running": False, "error": False, "diff": None, "exp": False,
                 "out": "started monitor mon1\n" + long_line, "lines": 2}
        rows = self.plain(ui._tool_frags(block)).split("\n")
        self.assertGreater(len(rows), 3, "the long row is wrapped into several rows")
        for row in rows:
            self.assertTrue(row.startswith(glyphs.RAIL), repr(row))
            self.assertLessEqual(len(row), 60, repr(row))
        batch = Batch("mon1", "burst", "output", lines=[f"line {i}" for i in range(40)],
                      event_index=1, omitted_lines=20)
        event = ui._monitor_event_block(batch)
        self.assertEqual(event["lines"], 40, "the hint is not a body line")
        text = self.plain(ui._tool_frags(event))
        hint_rows = [row for row in text.split("\n") if "more line" in row]
        self.assertEqual(len(hint_rows), 1, text)
        self.assertIn("20 more lines — /monitors show mon1", hint_rows[0])
        event["exp"] = True
        expanded = self.plain(ui._tool_frags(event))
        self.assertIn("line 39", expanded)
        self.assertEqual(expanded.count("/monitors show mon1"), 1, expanded)

    def test_monitor_and_background_cards_wrap_at_word_boundaries_inside_the_rail(self):
        # Before: body rows were cut at exactly the room left beside the rail, mid-word, and a long
        # header ran past the terminal edge, where the window wrapped it mid-word at column 0.
        from dgc.monitors import Batch
        from dgc import glyphs
        from prompt_toolkit.utils import get_cwidth
        ui = self.tui()
        ui._width = 64
        prose = ("the deployment finished uploading every bundle and invalidated the content "
                 "delivery cache for production")
        cards = [
            ui._monitor_event_block(Batch("mon7", "watch the deployment pipeline for the release branch",
                                          "output", lines=[prose, "short"], event_index=3)),
            ui._monitor_event_block(Batch(
                "b2", "npm run build && npm run test -- --reporter=dot", "background_exit",
                lines=["background task b2 exited 0 after 41s", prose])),
        ]
        for card in cards:
            text = self.plain(ui._tool_frags(card))
            rows = text.split("\n")
            for row in rows:
                self.assertTrue(row.startswith(glyphs.RAIL), repr(row))
                self.assertLessEqual(get_cwidth(row), 64, repr(row))
            words = [word for row in rows for word in row[len(glyphs.RAIL):].split()]
            for word in prose.split() + card["summary"].split():
                self.assertIn(word, words, f"{word!r} was cut across rows:\n{text}")
        # A token longer than the room still has to be cut somewhere, and stays inside the rail.
        long_token = {"kind": "tool", "name": "monitor_event", "route_name": "monitor_event", "call_id": None,
                      "summary": "x", "running": False, "error": False, "diff": None, "exp": False,
                      "out": "https://example.test/" + "a" * 150, "lines": 1}
        for row in self.plain(ui._tool_frags(long_token)).split("\n"):
            self.assertTrue(row.startswith(glyphs.RAIL), repr(row))
            self.assertLessEqual(get_cwidth(row), 64, repr(row))

    def test_the_phase_clock_never_exceeds_the_turn_or_survives_an_approval(self):
        ui = self.tui()
        now = time.monotonic()
        ui._turn.set()
        try:
            ui._turn_t0 = now - 44
            ui._phase_act, ui._phase_t0 = "Waiting", now - 72     # left over from before
            status = self.plain(ui._status())
            self.assertNotIn("1m12s", status)
            self.assertIn("Waiting… 44", status)
            ui._req = {"hint": "1 allow · 3 deny"}
            self.plain(ui._status())
            self.assertIsNone(ui._phase_act, "an approval card ends the phase")
            ui._req = None
            self.assertRegex(self.plain(ui._status()), r"Waiting… 0\.\ds")
        finally:
            ui._turn.clear()

    def _blocked_wake(self, ui, sess):
        entered = threading.Event()

        def chat(*args, **kwargs):
            entered.set()
            while not self.agent.cancelled.is_set():
                time.sleep(0.02)
            return ChatResult(content="", finish_reason="cancelled")
        self.agent._chat = chat
        hub = self.agent.monitors
        hub.queue_background_exit("bg6", "deploy", 0, 1.0, "ok", hub.epoch)
        ui._submit_monitor_wake(sess, hub.take_pending())
        self.assertTrue(entered.wait(10))

    def _wait_idle(self, sess):
        self.assertTrue(wait_for(lambda: not sess._turn.is_set()
                                 and not (sess._worker_thread and sess._worker_thread.is_alive()), 10))

    def test_a_command_run_from_the_palette_during_a_wake_turn_makes_it_yield(self):
        for picked in (False, True):
            with self.subTest(picked=picked):
                ui = self.tui()
                sess = ui.active
                self._blocked_wake(ui, sess)
                ran = []
                original = ui._handle_slash
                ui._handle_slash = lambda text, _o=original: (ran.append(text), _o(text))[1]
                ui._open_command_palette()
                if picked:                      # a row chosen from the menu
                    ui.input_buf.text = "/rewin"
                    ui.input_buf.cursor_position = len(ui.input_buf.text)
                    ui._overlay["on_submit"]({"kind": "command", "value": "rewind"}, "/rewin")
                else:                           # typed in full, then Enter
                    ui._overlay["on_submit"](None, "/rewind")
                self.assertNotIn("waits for this turn", str(ui._flash_msg))
                self.assertTrue(sess._wake_yield or not sess._turn.is_set())
                self._wait_idle(sess)
                ui._service_monitors()
                self.assertEqual(ran, ["/rewind"])
                self.assertFalse(self.agent.monitors.policy.paused, "yielding is not a stop")

    def test_a_prompt_sent_after_a_waiting_command_runs_after_it(self):
        ui = self.tui()
        sess = ui.active
        self._blocked_wake(ui, sess)
        order = []
        original = ui._handle_slash
        ui._handle_slash = lambda text: (order.append(("command", text)), original(text))[1]
        ui._submit = lambda text, **kwargs: order.append(("prompt", text))
        self.assertEqual(ui._dispatch_composer_text("/rewind"), "local-command")
        self.assertEqual(ui._dispatch_composer_text("now do this"), "follow-up")
        self._wait_idle(sess)
        self.assertEqual(order, [], "nothing jumps ahead into the chat the command is about to change")
        ui._service_monitors()
        self.assertEqual(order, [("command", "/rewind"), ("prompt", "now do this")])

    def test_esc_after_a_typed_command_with_arguments_leaves_an_empty_composer(self):
        ui = self.tui()
        ui.input_buf.auto_suggest = None        # no application loop runs in this test

        def esc():
            back = ui._overlay.get("back")
            back() if back else ui._close_overlay()
        ui.input_buf.text = "/usage today"
        ui._open_command_palette()
        ui._overlay["on_submit"](None, "/usage today")
        self.assertIsNotNone(ui._overlay, "the usage reader opened")
        esc()
        self.assertIsNone(ui._overlay, "one Esc closes the reader")
        self.assertEqual(ui.input_buf.text, "")
        # A menu that does step back to the palette leaves no stray "/" once that palette closes.
        ui._open_command_palette()
        ui._overlay["on_submit"](None, "/settings")
        self.assertIs(ui._overlay.get("back").__func__, type(ui)._palette_back)
        esc()
        self.assertTrue(ui._overlay.get("composer_palette"))
        esc()
        self.assertIsNone(ui._overlay)
        self.assertEqual(ui.input_buf.text, "", "no '/' left to turn /usage into //usage")


if __name__ == "__main__":
    unittest.main()
