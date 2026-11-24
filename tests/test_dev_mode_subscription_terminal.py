"""Dev Mode's "Work on a subscription uses DGC's tools" in the terminal: the full-screen app, the classic prompt and
`dgc -p` follow the same switch as Work in the editor (it is one setting in DGC's config).

On (Dev Mode on, `dev_subscription_tools` on, a session on Claude Code or Codex): the turn is the Agent's own with the
CLI as its model only (dgc/work_cli.py): the CLI starts with its own tools off and only DGC's MCP server. Off: each turn
is handed to the CLI whole, as before. Kimi Code, Qwen Code and Copilot CLI run as before and say why, once.

The stand-in CLI (tests/fake_subscription_cli.py) records every run's argv in runs.jsonl. No test reads, prints or copies
a CLI's login: install_clis writes empty marker files in a temporary HOME.
"""
from __future__ import annotations

import contextlib
import contextvars
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import cli, tui
from tests.test_pip_brain import install_clis

ROOT = Path(__file__).resolve().parents[1]


def noop(*args, **kwargs):
    return None


def settings(**data):
    return SimpleNamespace(data=data, get=data.get, project_root=Path("/unused-dev-sub-terminal"))


ON = {"dev_mode": True, "dev_subscription_tools": True}


class TerminalRouting(unittest.TestCase):
    """Which turn the full-screen app and the classic prompt run: today's delegation, or the Agent's own."""

    def setUp(self):
        self.calls = []

    def native(self, *args, **kwargs):
        self.calls.append(("dgc", args, kwargs))
        return True

    def delegated(self, *args, **kwargs):
        self.calls.append(("delegated", args, kwargs))
        return True

    def tui_facade(self, **data):
        agent = SimpleNamespace(run_turn=self.native, cancelled=threading.Event(), stopping=False, messages=[],
                                session_name="fixture", monitors=None, estimate_tokens=lambda: 0,
                                expire_open_asks=noop, take_deferred_steers=lambda: [])
        sess = SimpleNamespace(agent=agent, id="fixture", name="fixture", _closing=False, _queue=[],
                               _autotitle_pending=False, _worker_thread=None)
        facade = SimpleNamespace(agent=agent, config=settings(mode="default", suggest=False, **data), active=sess,
                                 _tls=threading.local(), _cancel=agent.cancelled, _turn=threading.Event(),
                                 _autotitled=True, blocks=[], _turn_marks=[], _prompt_history=[],
                                 _cur_session=lambda: sess, _remote_for=lambda _: None, _pop_followup=lambda _: None,
                                 _rich=lambda text: text, _append=noop, errors=[], infos=[])
        facade.error, facade.info = facade.errors.append, facade.infos.append
        facade._run_delegated_turn = self.delegated
        for name in ("_cancel_auxiliary", "_foreground_aux_barrier", "_flush_text", "_settle_running_tools",
                     "_flush_unsaved_todo_clear", "_invalidate", "_pause_pane", "_maybe_notify", "_schedule_auxiliary",
                     "_mark_turn_end"):
            setattr(facade, name, noop)
        return facade

    def submit(self, facade, text="Add a test and run it"):
        workers = []

        class Captured:
            def __init__(self, *, target, name, daemon):
                self.target = target

            def start(self):
                workers.append(self.target)
        with patch.object(tui.threading, "Thread", Captured):
            tui.TUI._submit(facade, text, expand_mentions=False)
        contextvars.Context().run(workers[0])
        return [call[0] for call in self.calls]

    def test_the_terminal_app_hands_the_turn_over_when_off(self):
        self.assertEqual(self.submit(self.tui_facade(subscription_engine="claude", dev_mode=True)), ["delegated"])
        self.assertEqual(self.calls[0][1], ("claude", "Add a test and run it"))

    def test_the_terminal_app_runs_dgcs_own_turn_when_on(self):
        for engine in ("claude", "codex"):
            with self.subTest(engine=engine):
                self.calls.clear()
                self.assertEqual(self.submit(self.tui_facade(subscription_engine=engine, **ON)), ["dgc"])
                self.assertEqual(self.calls[0][2], {"reset_cancel": False})

    def test_kimi_in_the_terminal_app_runs_as_before_and_says_why_once(self):
        facade = self.tui_facade(subscription_engine="kimi", **ON)
        self.submit(facade)
        self.submit(facade, "And another")
        self.assertEqual([call[0] for call in self.calls], ["delegated", "delegated"])
        said = [line for line in facade.infos if "Kimi Code" in line]
        self.assertEqual(len(said), 1, facade.infos)

    def classic(self, **data):
        return SimpleNamespace(config=settings(mode="default", **data),
                               agent=SimpleNamespace(run_turn=self.native),
                               ui=SimpleNamespace(info=lambda line: self.calls.append(("info", line))),
                               _run_delegated_turn=self.delegated)

    def test_the_classic_prompt_follows_the_switch(self):
        self.assertTrue(cli.CLI._run_turn_body(self.classic(subscription_engine="codex"), "Fix it"))
        self.assertTrue(cli.CLI._run_turn_body(self.classic(subscription_engine="codex", **ON), "Fix it"))
        self.assertEqual([call[0] for call in self.calls], ["delegated", "dgc"])

    def test_the_terminal_app_and_the_classic_prompt_say_they_run_these_turns(self):
        import inspect
        self.assertIn("self.cli_model_enabled = True", inspect.getsource(tui.TUI.__init__))
        self.assertIn("self.ui.cli_model_enabled = True", inspect.getsource(cli.CLI.__init__))

    def test_wake_ups_wait_only_for_a_turn_the_cli_runs_whole(self):
        import inspect
        source = inspect.getsource(tui.TUI)
        self.assertNotIn('if (str(sess.config.get("subscription_engine", "") or "").strip()\n                or sess.agent.mode == "plan")', source)


class OneShotRoute(unittest.TestCase):
    """`dgc -p`: which engine it hands the turn to, and the pass-throughs for the CLI that is only the model."""

    def config(self, **data):
        from tests.test_subagents import fixture_config
        directory = tempfile.TemporaryDirectory(prefix="dgc-dev-sub-route-")
        self.addCleanup(directory.cleanup)
        config = fixture_config(Path(directory.name), **data)
        config.mark_ephemeral = lambda key: config.__dict__.setdefault("ephemeral", set()).add(key)
        return config

    def test_off_hands_it_to_the_cli_as_before_and_changes_nothing(self):
        config = self.config(subscription_engine="claude", subscription_model="opus", dev_mode=True)
        self.assertEqual(cli._held_to_dgc_tools(config, "claude", "sonnet", "high"), "claude")
        self.assertEqual(config.data["subscription_model"], "opus")
        self.assertNotIn("ephemeral", config.__dict__)

    def test_on_runs_dgcs_turn_with_model_and_effort_for_this_run_only(self):
        config = self.config(subscription_engine="claude", subscription_model="opus", **ON)
        self.assertEqual(cli._held_to_dgc_tools(config, "claude", "sonnet", "high"), "")
        self.assertEqual((config.data["subscription_model"], config.data["subscription_effort"]), ("sonnet", "high"))
        self.assertEqual(config.ephemeral, {"subscription_model", "subscription_effort"}, "never saved as the default")

    def test_another_engine_for_this_run_takes_its_own_defaults(self):
        config = self.config(subscription_engine="claude", subscription_model="opus", subscription_effort="max", **ON)
        self.assertEqual(cli._held_to_dgc_tools(config, "codex", None, None), "")
        self.assertEqual((config.data["subscription_engine"], config.data["subscription_model"],
                          config.data["subscription_effort"]), ("codex", "", ""))
        self.assertTrue({"subscription_engine", "subscription_model", "subscription_effort"} <= config.ephemeral)

    def test_kimi_and_native_stay_as_they_were(self):
        config = self.config(subscription_engine="kimi", **ON)
        self.assertEqual(cli._held_to_dgc_tools(config, "kimi", None, None), "kimi")
        self.assertEqual(cli._held_to_dgc_tools(config, "", None, None), "")


class World(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="dgc-dev-sub-term-"))
        self.home = self.base / "home"
        self.home.mkdir()
        patcher = patch.dict(os.environ, {"HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.bin = install_clis(self)
        self.project = self.base / "project"
        self.project.mkdir()
        (self.project / "notes.txt").write_text("hello from the project\n")

    def script(self, *steps):
        (self.bin / "script.json").write_text(json.dumps(list(steps)))

    def runs(self):
        path = self.bin / "runs.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def seen(self):
        return json.loads((self.bin / "seen.json").read_text())


class DgcDashP(World):
    """`dgc -p` as a real process, in a temporary HOME whose DGC settings name the subscription and the switch."""

    def dgc_p(self, prompt, *extra, **settings_data):
        (self.home / ".dgc").mkdir(exist_ok=True)
        (self.home / ".dgc/config.json").write_text(json.dumps({"base_url": "http://127.0.0.1:9/v1", "model": "fixture",
                                                               "mode": "default", **settings_data}))
        env = {**os.environ, "HOME": str(self.home), "PYTHONPATH": f"{ROOT}{os.pathsep}{ROOT / 'sdk/python'}",
               "DGC_NO_UPDATE_CHECK": "1"}
        env.pop("CODEX_HOME", None)
        env.pop("CLAUDE_CONFIG_DIR", None)
        return subprocess.run([sys.executable, "-m", "dgc", "-p", prompt, *extra], cwd=self.project, env=env,
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180)

    def test_on_claude_code_is_the_model_only_with_its_tools_off(self):
        self.script({"call": "read_file", "args": {"path": "notes.txt"}}, {"say": "It says hello."})
        done = self.dgc_p("What does notes.txt say?", subscription_engine="claude", **ON)
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        self.assertIn("It says hello.", done.stdout)
        argv = self.seen()["argv"]
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "dontAsk")
        self.assertEqual(self.seen()["servers"], ["dgc"])
        self.assertIn("hello from the project", self.seen()["answers"][0]["text"], "DGC's own read_file answered")

    def test_on_codex_runs_without_the_users_config(self):
        self.script({"call": "read_file", "args": {"path": "notes.txt"}}, {"say": "It says hello."})
        done = self.dgc_p("What does notes.txt say?", "--engine", "codex", subscription_engine="claude", **ON)
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        argv = self.seen()["argv"]
        self.assertIn("--ignore-user-config", argv)
        self.assertEqual(self.seen()["config"].get("features.shell_tool"), "false")
        self.assertIn("hello from the project", self.seen()["answers"][0]["text"])

    def test_off_hands_the_turn_to_the_cli_as_before(self):
        self.script({"say": "Delegated answer."})
        done = self.dgc_p("What does notes.txt say?", subscription_engine="claude", dev_mode=True)
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        self.assertIn("Delegated answer.", done.stdout)
        argv = self.runs()[-1]["argv"]
        self.assertNotIn("--strict-mcp-config", argv)
        self.assertNotIn("--tools", argv)
        self.assertTrue(argv[-1].endswith("What does notes.txt say?"), "today's delegated command line: the prompt last")

    def test_kimi_says_why_it_runs_as_before(self):
        done = self.dgc_p("Hello", "--trust", subscription_engine="kimi", mode="auto", **ON)
        self.assertIn("Kimi Code always starts your own MCP servers", done.stdout + done.stderr)


class TheTerminalApp(World):
    """The real full-screen app object, on a pipe and a dummy screen, running one turn on the stand-in."""

    def app(self, **data):
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.data_structures import Size
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput
        from dgc.agent import Agent
        from dgc.config import Config

        class Output(DummyOutput):
            def get_size(self):
                return Size(rows=40, columns=140)
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        pipe = stack.enter_context(create_pipe_input())
        stack.enter_context(create_app_session(input=pipe, output=Output()))
        config = Config(project_root=self.project)
        config.data.update(mode="default", **data)
        config._persist = False
        agent = Agent(config, SimpleNamespace(**{name: noop for name in ("info", "error", "on_text", "end_stream")}))
        self.addCleanup(agent.mcp.stop_all)
        app = tui.TUI(config, agent=agent)
        app._width, app._height = 140, 40
        self.addCleanup(app._shutdown_fleet)
        self.addCleanup(lambda: app._peer_stop is not None and app._peer_stop.set())
        return app

    def turn(self, app, prompt):
        app._submit(prompt)
        deadline = time.monotonic() + 60
        while app._turn.is_set() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(app._turn.is_set(), "the turn ended")

    def test_on_its_turn_is_dgcs_own_with_the_clis_tools_off(self):
        self.script({"call": "read_file", "args": {"path": "notes.txt"}}, {"say": "It says hello."})
        app = self.app(subscription_engine="claude", **ON)
        self.turn(app, "What does notes.txt say?")
        argv = self.seen()["argv"]
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertIn("--strict-mcp-config", argv)
        self.assertIn("hello from the project", self.seen()["answers"][0]["text"])
        roles = [m.get("role") for m in app.agent.messages]
        self.assertIn("tool", roles, "the call is in DGC's own record of the turn")
        self.assertEqual(app.agent.messages[-1]["content"], "It says hello.")

    def test_off_its_turn_is_handed_to_the_cli_as_before(self):
        self.script({"say": "Delegated answer."})
        app = self.app(subscription_engine="claude", dev_mode=True)
        self.turn(app, "What does notes.txt say?")
        argv = self.runs()[-1]["argv"]
        self.assertNotIn("--strict-mcp-config", argv)
        self.assertNotIn("--tools", argv)


if __name__ == "__main__":
    unittest.main()
