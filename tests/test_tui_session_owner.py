"""The full-screen terminal follows the one-writer rule (dgc/session_owner.py), with a real window's `dgc serve`.

* `dgc -c` of a session a window holds idle: the line says where it is open and what runs there, and Open here, Start
  a new session and Quit are offered, the new session highlighted (Enter alone never takes it). A prompt typed meanwhile
  brings the choices back and writes nothing.
* Open here takes it: the window hears session_held, and its bar says "Open in the terminal".
* Open here in a window takes it back from this terminal, which says so and takes no more prompts for it.
* Start a new session leaves the window's untouched.
"""
import contextlib
import json
import os
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


def _real_account_home() -> Path:
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=False)
    except (ImportError, KeyError, AttributeError):
        return Path(os.path.expanduser("~")).resolve(strict=False)


if "dgc.config" in sys.modules:
    _user_home = Path(sys.modules["dgc.config"].USER_HOME).resolve(strict=False)
    _account_home = _real_account_home()
    if _user_home == _account_home or _account_home in _user_home.parents:
        raise RuntimeError("tests/test_tui_session_owner.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-tui-owner-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_session_detach import POSIX_SOCKETS, Serve, World    # noqa: E402
from waiting import wait_until                                 # noqa: E402

from dgc import config as config_module                        # noqa: E402
from dgc import sessions                                       # noqa: E402
from dgc import tui as tui_mod                                 # noqa: E402
from dgc.agent import Agent                                    # noqa: E402
from dgc.config import Config                                  # noqa: E402

_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


class _QuietUI:
    non_interactive = False

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


@unittest.skipUnless(POSIX_SOCKETS, "a window's DGC keeps a session with an attach socket on Linux and macOS")
class TuiSessionOwnerTests(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.world = World(self, scale=1.0)
        old = os.environ.get("HOME")
        os.environ["HOME"] = str(self.world.home)             # the same peer notes and locks as the window's DGC
        self.addCleanup(lambda: os.environ.__setitem__("HOME", old) if old else os.environ.pop("HOME", None))
        user = self.world.home / ".dgc"
        for name, value in (("USER_HOME", user), ("USER_CONFIG", user / "config.json"),
                            ("USER_SECRETS", user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        scoped = patch.object(sessions, "SESSIONS_DIR", user / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)

    def window(self, name="window-a", editor="Cursor", env=None):
        serve = Serve(self.world, env, name=name)
        ready = serve.wait(lambda e: e.get("type") == "ready", 90)
        for command in ({"type": "set_detach", "keep_running": True}, {"type": "editor_app", "name": editor},
                        {"type": "watch_session_owner"}, {"type": "editor_state", "source": "renderer", "view": "open"}):
            serve.send(command)
        return serve, ready

    def held_session(self):
        a, ready = self.window()
        a.send({"type": "prompt", "text": "TURN_SHORT go", "request_id": "p1"})
        a.wait(lambda e: e.get("type") == "turn_end", 90)
        session_id = ready["session_id"]
        wait_until(lambda: any(c.get("session_id") == session_id for c in
                               (((self.world.note(a.proc.pid) or {}).get("open_here") or {}).get("chats") or [])),
                   timeout=20, what="the window's note")
        return a, session_id, self.world.session_file(session_id)

    def tui(self, path, width=140, height=40):
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.data_structures import Size
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput

        class Output(DummyOutput):
            def get_size(self):
                return Size(rows=height, columns=width)

        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        pipe = stack.enter_context(create_pipe_input())
        stack.enter_context(create_app_session(input=pipe, output=Output()))
        config = Config(project_root=self.world.work)
        agent = Agent(config, _QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        agent.load_session(path)                                # what `dgc -c` did before the screen came up
        ui = tui_mod.TUI(config, agent=agent)
        ui._width, ui._height = width, height
        self.addCleanup(ui._shutdown_fleet)
        self.addCleanup(lambda: ui._peer_stop is not None and ui._peer_stop.set())
        return ui

    @staticmethod
    def said(ui) -> str:
        return " ".join(_ANSI.sub("", str(getattr(block, "value", block))) for block in ui.blocks
                        if isinstance(block, str))

    def labels(self, ui):
        return [f"{row['label']} — {row['desc']}" for row in ui._overlay["rows"]]

    def test_resuming_a_held_session_offers_the_choices_and_a_prompt_writes_nothing(self):
        a, session_id, path = self.held_session()
        before = path.read_bytes()
        ui = self.tui(path)
        self.assertIn(f"This session is open in Cursor · {self.world.work.name} · idle", " ".join(self.said(ui).split()))
        self.assertEqual(self.labels(ui), ["Open here — move it into this terminal; Cursor shows it read-only",
                                           "Start a new session — this one stays open in Cursor",
                                           "Quit — leave it as it is"])
        self.assertEqual(ui._overlay["sel"], 1, "Enter alone starts a new session; it never takes the window's")
        ui._overlay = None
        self.assertEqual(ui._dispatch_composer_text("hello from the terminal"), "held")
        self.assertIsNotNone(ui._overlay, "the choices again")
        self.assertFalse(ui.agent.owns_session())
        self.assertEqual(path.read_bytes(), before)
        # Start a new session: its own; the window's stays as it was.
        ui._overlay["on_pick"](ui._overlay["rows"][1])
        self.assertNotEqual(Path(str(ui.agent.session_file)).stem, session_id)
        self.assertTrue(ui._may_write())
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(any(e.get("type") == "session_held" for e in a.events))

    def test_a_prompt_that_brings_the_choices_back_does_not_repeat_where_it_is_open(self):
        _a, _session_id, path = self.held_session()
        ui = self.tui(path)
        ui._overlay = None
        self.assertEqual(ui._dispatch_composer_text("hello from the terminal"), "held")
        self.assertIsNotNone(ui._overlay, "the choices again")
        said = " ".join(self.said(ui).split())
        self.assertEqual(said.count("This session is open in Cursor"), 1, said[-600:])

    def test_open_here_takes_it_and_a_window_open_here_takes_it_back(self):
        a, session_id, path = self.held_session()
        ui = self.tui(path)
        ui._start_peer_heartbeat()
        ui._overlay["on_pick"](ui._overlay["rows"][0])                  # Open here
        wait_until(lambda: ui.agent.owns_session(), timeout=40, what="the terminal to hold it")
        held = a.wait(lambda e: e.get("type") == "session_held", 30)
        self.assertEqual(held["session_id"], session_id)
        wait_until(lambda: "this session is in this terminal now" in self.said(ui), timeout=20, what="the terminal's line")
        ui._announce_peer("idle")
        a.send({"type": "session_holder", "request_id": "h", "session_id": session_id})
        told = a.wait(lambda e: e.get("type") == "session_holder" and e.get("request_id") == "h", 30)
        self.assertEqual((told["found"], told["editor"]), (True, "the terminal"))
        # A window's Open here takes it back: this terminal says so, and takes no more prompts for it.
        c, c_ready = self.window("window-c", "VS Code", env={"DGC_ATTACH_SESSION": session_id, "DGC_ATTACH": "steal"})
        self.assertNotIn("elsewhere", c_ready["capabilities"].get("detach", {}))
        wait_until(lambda: ui.agent.session_taken, timeout=30, what="the terminal to let it go")
        self.assertIn("This session is open in the editor now (Open here)", " ".join(self.said(ui).split()))
        c.send({"type": "resume_session", "path": f"{session_id}.json", "request_id": "r"})
        c.wait(lambda e: e.get("type") == "session" and e.get("request_id") == "r", 60)
        wait_until(lambda: any(chat.get("session_id") == session_id for chat in
                               (((self.world.note(c.proc.pid) or {}).get("open_here") or {}).get("chats") or [])),
                   timeout=20, what="the window's note to say it holds it now")
        ui._overlay = None
        before = path.read_bytes()
        self.assertEqual(ui._dispatch_composer_text("one more"), "held")
        self.assertEqual(self.labels(ui)[0], "Open here — move it into this terminal; VS Code shows it read-only")
        self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
