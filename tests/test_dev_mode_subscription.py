"""Dev Mode: Work on a subscription uses DGC's tools (Settings > Dev Mode, `dev_subscription_tools`, off by default).

Off, or with Dev Mode off, a Work turn on Claude Code or Codex is handed to that CLI whole, as before
(subscriptions.run_cli_turn). On, the CLI is the turn's model and nothing more: launched with none of its own tools,
none of the user's settings or MCP servers, only DGC's server on a private socket with a token minted for the run
(pip_brain's ToolServer and relay, through the client ChatDGC uses). The turn is the Agent's own, so every call goes
through Work's own handlers: an Allow card in Default mode, none in auto mode, the Edited card, steering, helpers on
their own model, Stop ending the CLI's whole process group.

The stand-in CLI (tests/fake_subscription_cli.py) speaks each CLI's real output and talks MCP to the relay it was
given, as the real ones do. No test here reads, prints or copies a CLI's login: install_clis writes an empty marker
file in a temporary HOME, and DGC only checks that it exists.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import dev_mode
from dgc.config import DEFAULTS, Config
from dgc.headless import Backend
from dgc.llm import ChatResult, LLMClient
from tests.test_pip_brain import install_clis
from tests.test_subagents import Harness, Script, clone_fixture


def settings(**data):
    return SimpleNamespace(data=data, get=data.get, project_root=Path("/unused-dev-sub-fixture"))


class TheSwitch(unittest.TestCase):
    def test_off_by_default_and_only_a_true_or_false(self):
        from dgc.headless import _validated_config_values
        self.assertIs(DEFAULTS["dev_subscription_tools"], False)
        values, error = _validated_config_values({"dev_mode": True, "dev_subscription_tools": True}, ())
        self.assertIsNone(error)
        self.assertIs(values["dev_subscription_tools"], True)
        self.assertEqual(_validated_config_values({"dev_subscription_tools": "yes"}, ())[1],
                         "dev_subscription_tools must be true or false")

    def test_on_only_with_dev_mode_and_claude_code_or_codex(self):
        for data, engine in (
                ({"subscription_engine": "claude"}, ""),
                ({"subscription_engine": "claude", "dev_mode": True}, ""),
                ({"subscription_engine": "claude", "dev_subscription_tools": True}, ""),
                ({"subscription_engine": "claude", "dev_mode": True, "dev_subscription_tools": True}, "claude"),
                ({"subscription_engine": "codex", "dev_mode": True, "dev_subscription_tools": True}, "codex"),
                ({"subscription_engine": "", "dev_mode": True, "dev_subscription_tools": True}, ""),
                ({"subscription_engine": "kimi", "dev_mode": True, "dev_subscription_tools": True}, ""),
                ({"subscription_engine": "qwen", "dev_mode": True, "dev_subscription_tools": True}, ""),
                ({"subscription_engine": "copilot", "dev_mode": True, "dev_subscription_tools": True}, ""),
                ({"subscription_engine": "claude", "dev_mode": True, "dev_subscription_tools": "yes"}, "")):
            with self.subTest(data=data):
                self.assertEqual(dev_mode.subscription_tools(settings(**data)), engine)

    def test_delegated_is_todays_engine_unless_the_switch_makes_the_cli_the_model_only(self):
        self.assertEqual(dev_mode.delegated(settings(subscription_engine="")), "")
        self.assertEqual(dev_mode.delegated(settings(subscription_engine="claude")), "claude")
        self.assertEqual(dev_mode.delegated(settings(subscription_engine="codex", dev_mode=True)), "codex")
        self.assertEqual(dev_mode.delegated(settings(subscription_engine="claude", dev_mode=True,
                                                     dev_subscription_tools=True)), "")
        self.assertEqual(dev_mode.delegated(settings(subscription_engine="kimi", dev_mode=True,
                                                     dev_subscription_tools=True)), "kimi")

    def test_kimi_qwen_and_copilot_are_not_offered_and_say_why(self):
        from dgc import work_cli
        self.assertIn("your own MCP servers", work_cli.not_offered("kimi"))
        for key in ("qwen", "copilot"):
            self.assertIn("hasn't checked", work_cli.not_offered(key))
        self.assertEqual(work_cli.not_offered("claude"), "")
        self.assertEqual(work_cli.not_offered("codex"), "")

    def test_ready_says_dgc_takes_it_and_whether_it_is_on(self):
        import inspect
        from dgc import headless
        self.assertEqual(headless.dev_subscription_capability(settings()),
                         {"version": 1, "set": False, "on": False, "engines": ["claude", "codex"]})
        self.assertEqual(headless.dev_subscription_capability(settings(dev_subscription_tools=True)),
                         {"version": 1, "set": True, "on": False, "engines": ["claude", "codex"]}, "Dev Mode is off")
        self.assertEqual(headless.dev_subscription_capability(settings(dev_mode=True, dev_subscription_tools=True))["on"],
                         True)
        self.assertIn('"dev_subscription_tools": dev_subscription_capability(', inspect.getsource(headless))

    def test_dgc_itself_never_turns_it_on(self):
        from dgc import settings_tool
        self.assertIn("dev_subscription_tools", settings_tool.NEVER)
        self.assertNotIn("dev_subscription_tools", settings_tool.ORDINARY)
        self.assertIn("only you", settings_tool._never("dev_subscription_tools"))

    def test_no_released_event_gains_a_field(self):
        from dgc import editor_protocol as ep
        for event, fields in ep.EVENT_FIELDS.items():
            self.assertNotIn("dev_subscription_tools", fields, event)


def noop(*args, **kwargs):
    return None


class Routing(unittest.TestCase):
    """Which turn runs: today's delegation, or the Agent's own turn with the CLI as its model."""

    def backend(self, **data):
        self.calls = []
        backend = object.__new__(Backend)
        backend.config = settings(mode="default", suggest=False, **data)
        agent = SimpleNamespace(cancelled=threading.Event(), stopping=False, messages=[], session_name="fixture",
                                monitors=None, estimate_tokens=lambda: 0, expire_open_asks=noop,
                                take_deferred_steers=lambda: [])
        agent.run_turn = lambda *a, **k: self.calls.append(("dgc", a, k)) or True
        backend.agent = agent
        backend.infos = []
        backend.ui = SimpleNamespace(error=noop, info=backend.infos.append)
        backend.events = []
        backend.em = SimpleNamespace(emit=lambda event, **fields: backend.events.append({"type": event, **fields}))
        backend._queue = [("Add a test for parse and run it", None, [], "prompt")]
        backend._turn_n = 0
        backend._worker = threading.current_thread()
        for name in ("_finish_steering", "_maybe_auto_resume_goal", "_flush_unsaved_todo_clear", "_emit_context",
                     "_maybe_wake"):
            setattr(backend, name, noop)
        backend._start_eta_ticker = lambda _: threading.Event()
        backend._run_subscription_turn = lambda *a, **k: self.calls.append(("delegated", a, k)) or True
        return backend

    def drain(self, backend):
        with patch("dgc.headless.secret_values", return_value=()), contextlib.redirect_stderr(io.StringIO()):
            backend._run_turn_queue()
        return [call[0] for call in self.calls]

    def test_switch_off_hands_the_turn_to_the_cli_as_before(self):
        self.assertEqual(self.drain(self.backend(subscription_engine="claude", dev_mode=True)), ["delegated"])
        self.assertEqual(self.calls[0][1], ("claude", "Add a test for parse and run it"))

    def test_dev_mode_off_hands_it_over_even_with_the_switch_on(self):
        self.assertEqual(self.drain(self.backend(subscription_engine="codex", dev_subscription_tools=True)),
                         ["delegated"])

    def test_switch_on_runs_dgcs_own_turn(self):
        for engine in ("claude", "codex"):
            with self.subTest(engine=engine):
                backend = self.backend(subscription_engine=engine, dev_mode=True, dev_subscription_tools=True)
                self.assertEqual(self.drain(backend), ["dgc"])
                self.assertEqual(self.calls[0][2], {"reset_cancel": False})

    def test_kimi_with_the_switch_on_runs_as_before_and_says_why_once(self):
        backend = self.backend(subscription_engine="kimi", dev_mode=True, dev_subscription_tools=True)
        backend._queue.append(("And another", None, [], "prompt"))
        self.assertEqual(self.drain(backend), ["delegated", "delegated"])
        said = [line for line in backend.infos if "Kimi Code" in line]
        self.assertEqual(len(said), 1, backend.infos)
        self.assertIn("its own tools", said[0])


class World(unittest.TestCase):
    """A real Agent wired as `dgc serve` wires it, on a Claude Code or Codex stand-in. Any native model request fails
    the test: the parent's model is the CLI; a helper's requests go to its own (scripted) model."""

    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="dgc-dev-sub-"))
        home = self.base / "home"
        home.mkdir()
        patcher = patch.dict(os.environ, {"HOME": str(home)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.bin = install_clis(self)
        self.project = self.base / "project"
        self.project.mkdir()
        (self.project / "notes.txt").write_text("hello from the project\n")
        self.native = []

    def script(self, *steps):
        (self.bin / "script.json").write_text(json.dumps(list(steps)))

    def seen(self):
        return json.loads((self.bin / "seen.json").read_text())

    def harness(self, engine, mode="auto", **config):
        harness = Harness(self.project, mode=mode, subscription_engine=engine, dev_mode=True,
                          dev_subscription_tools=True, **config)
        self.addCleanup(harness.close)
        harness.ui.cli_model_enabled = True        # dgc serve's UI says it runs these turns itself
        harness.ui.turn_id = "t1"
        harness.ui.reset_turn_messages()
        return harness

    def native_model(self, messages, results, cancel):
        self.native.append(messages)
        if any("Count the files" in str(m.get("content")) for m in messages):     # the helper's own brief
            return ChatResult(content="Helper report: two files.")
        raise AssertionError("a native model request in a turn whose model is the CLI")

    def run_turn(self, harness, prompt):
        with patch.object(LLMClient, "chat", Script([("", self.native_model)])), \
                patch.object(Config, "clone_for_root", clone_fixture):
            return harness.agent.run_turn(prompt)


class TheCLIIsTheModelOnly(World):
    def test_claude_code_runs_with_its_tools_off_and_only_dgcs_server(self):
        self.script({"call": "read_file", "args": {"path": "notes.txt"}}, {"say": "It says hello."})
        harness = self.harness("claude")
        self.assertTrue(self.run_turn(harness, "What does notes.txt say?"))
        seen = self.seen()
        argv = seen["argv"]
        self.assertEqual(argv[argv.index("--tools") + 1], "", "none of Claude Code's own tools")
        for flag in ("--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--restricted"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "dontAsk")
        self.assertEqual(argv[argv.index("--allowedTools") + 1], "mcp__dgc")
        self.assertEqual(argv[argv.index("--setting-sources") + 1], "project")
        self.assertEqual(seen["servers"], ["dgc"], "DGC's server only: none of the user's")
        self.assertNotEqual(Path(seen["cwd"]).resolve(), self.project.resolve(), "it runs in a private folder")
        for name in ("read_file", "edit_file", "write_file", "bash", "grep", "glob", "task", "todo"):
            self.assertIn(name, seen["tools"], "Work's own tools reach it over MCP")
        self.assertIn("hello from the project", seen["answers"][0]["text"], "Work's own handler read the file")
        frames = harness.stream.frames()
        calls = [f for f in frames if f["type"] == "tool_call"]
        self.assertEqual([c["name"] for c in calls], ["read_file"], "DGC's own row, once")
        said = "".join(f.get("text", "") for f in frames if f["type"] == "text_delta")
        self.assertIn("It says hello.", said)
        self.assertEqual(self.native, [], "no native model request")
        self.assertEqual(harness.agent.messages[-1]["content"], "It says hello.")
        self.assertIsInstance(harness.agent.client, LLMClient, "the CLI is the model for the turn only")
        self.assertFalse(Path(seen["cwd"]).exists(), "nothing of the turn stays in its folder")

    def test_codex_runs_without_the_users_config_and_with_its_tools_off(self):
        self.script({"call": "read_file", "args": {"path": "notes.txt"}}, {"say": "It says hello."})
        harness = self.harness("codex")
        self.assertTrue(self.run_turn(harness, "What does notes.txt say?"))
        seen = self.seen()
        argv = seen["argv"]
        for flag in ("--ignore-user-config", "--ignore-rules", "--ephemeral"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--sandbox") + 1], "read-only")
        for feature in ("shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "browser_use"):
            self.assertEqual(seen["config"].get(f"features.{feature}"), "false", feature)
        self.assertEqual(seen["config"]["approval_policy"], '"never"')
        servers = {key.split(".")[1] for key in seen["config"] if key.startswith("mcp_servers.")}
        self.assertEqual(servers, {"dgc"})
        self.assertEqual(seen["catalog"]["models"][0]["tool_mode"], "direct_only")
        self.assertEqual(seen["catalog"]["models"][0]["shell_type"], "disabled")
        self.assertIn("hello from the project", seen["answers"][0]["text"])
        self.assertEqual([f["name"] for f in harness.stream.frames() if f["type"] == "tool_call"], ["read_file"])
        self.assertEqual(self.native, [])

    def test_the_meter_and_compaction_measure_the_clis_window(self):
        harness = self.harness("claude")
        self.assertEqual(harness.agent.context_size(), 200_000, "between turns as during them")
        harness.config.data["subscription_model"] = "opus[1m]"
        self.assertEqual(harness.agent.context_size(), 1_000_000)
        harness.config.data["subscription_engine"] = "codex"
        self.assertEqual(harness.agent.context_size(), 272_000)
        harness.config.data["dev_subscription_tools"] = False
        self.assertNotIn(harness.agent.context_size(), (200_000, 272_000, 1_000_000), "off: DGC's own setting, as before")

    def test_thinking_shows_as_thinking(self):
        self.script({"think": "The file is short."}, {"say": "Done."})
        harness = self.harness("claude")
        self.assertTrue(self.run_turn(harness, "Think, then say done"))
        kinds = [f["type"] for f in harness.stream.frames()]
        self.assertIn("thinking_delta", kinds)
        self.assertIn("thinking_end", kinds)
        self.assertLess(kinds.index("thinking_end"), kinds.index("text_delta"), "the thinking closes before the words")

    def test_usage_is_counted_where_the_cli_reports_it(self):
        self.script({"say": "Hi."})
        harness = self.harness("claude")
        self.assertTrue(self.run_turn(harness, "Hello"))
        totals = harness.agent.usage_totals
        self.assertEqual((totals.get("input_tokens"), totals.get("output_tokens")), (120, 30))


class WorksOwnHandlers(World):
    def test_an_edit_in_default_mode_raises_an_allow_card_and_lands_after_allow(self):
        for engine in ("claude", "codex"):
            with self.subTest(engine=engine):
                target = self.project / f"made-by-{engine}.txt"
                self.script({"call": "write_file", "args": {"path": target.name, "content": "made\n"}}, {"say": "Wrote it."})
                harness = self.harness(engine, mode="default")
                harness.answer("permission_request", {"decision": "once"})
                self.assertTrue(self.run_turn(harness, "Write a file"))
                cards = [f for f in harness.stream.frames() if f["type"] == "permission_request"]
                self.assertEqual(len(cards), 1, "the editor's own Allow card")
                self.assertEqual(target.read_text(), "made\n")
                files = harness.agent.last_turn_files or {}
                self.assertIn(target.name, [Path(row.get("path", "")).name for row in files.get("files", [])],
                              "the Edited card lists it")

    def test_auto_mode_asks_nothing(self):
        target = self.project / "auto.txt"
        self.script({"call": "write_file", "args": {"path": target.name, "content": "auto\n"}}, {"say": "Wrote it."})
        harness = self.harness("claude", mode="auto")
        self.assertTrue(self.run_turn(harness, "Write a file"))
        self.assertEqual([f for f in harness.stream.frames() if f["type"] == "permission_request"], [])
        self.assertEqual(target.read_text(), "auto\n")

    def test_a_denied_edit_is_the_clis_answer(self):
        target = self.project / "denied.txt"
        self.script({"call": "write_file", "args": {"path": target.name, "content": "no\n"}}, {"say": "It was refused."})
        harness = self.harness("claude", mode="default")
        harness.answer("permission_request", {"decision": "deny"})
        self.run_turn(harness, "Write a file")
        self.assertFalse(target.exists())
        answer = self.seen()["answers"][0]
        self.assertIn("DENIED", answer["text"], "the CLI reads the refusal as a model DGC calls itself would")

    def test_a_steer_reaches_the_cli_with_the_next_tool_answer(self):
        self.script({"call": "read_file", "args": {"path": "notes.txt"}}, {"say": "Read it, and checked two."})
        harness = self.harness("claude")
        handle = harness.agent._handle_call

        def handled(call, **kwargs):
            out = handle(call, **kwargs)
            self.assertTrue(harness.agent.steer("Also check two.", request_id="s1"))
            return out
        harness.agent._handle_call = handled
        self.assertTrue(self.run_turn(harness, "Read notes.txt"))
        answer = self.seen()["answers"][0]["text"]
        self.assertIn("hello from the project", answer)
        self.assertIn("Also check two.", answer, "the steer rides with the tool's answer, into the same CLI run")
        steering = [m for m in harness.agent.messages if m.get("_dgc_steering")]
        self.assertEqual([m["_dgc_steering"] for m in steering], [["Also check two."]])

    def test_a_steer_while_it_only_writes_runs_it_again_with_the_message(self):
        """No tool call to ride on: the turn reads the message at its end, as natively, and asks the CLI again."""
        self.script({"say": "First answer."})
        harness = self.harness("claude")
        shown = harness.ui.on_text
        sent = []

        def on_text(chunk):
            shown(chunk)
            if not sent:
                sent.append(harness.agent.steer("Make it shorter.", request_id="s2"))
        harness.ui.on_text = on_text
        self.assertTrue(self.run_turn(harness, "Explain the project"))
        self.assertEqual(sent, [True])
        self.assertIn("Make it shorter.", self.seen()["prompt"], "the second run reads the message")
        self.assertEqual([m["_dgc_steering"] for m in harness.agent.messages if m.get("_dgc_steering")],
                         [["Make it shorter."]])

    def test_a_task_runs_dgcs_own_helper_on_its_own_model(self):
        self.script({"call": "task", "args": {"description": "Count", "prompt": "Count the files in this folder."}},
                    {"say": "Two files."})
        harness = self.harness("claude")
        self.assertTrue(self.run_turn(harness, "How many files?"))
        self.assertIn("Helper report: two files.", self.seen()["answers"][0]["text"])
        self.assertTrue(any("Count the files" in str(m) for m in self.native), "the helper asked its own model")

    def test_a_helper_never_gets_the_cli(self):
        harness = self.harness("claude")
        self.assertIsNotNone(harness.agent._cli_model_client())
        harness.agent.depth = 1
        self.assertIsNone(harness.agent._cli_model_client())

    def test_a_side_request_gets_a_run_of_its_own_never_the_turns(self):
        """A summary for compaction or the auto-mode safety check while the CLI waits on a tool's answer."""
        harness = self.harness("claude")
        turn = harness.agent._cli_model_client()
        harness.agent.client = turn
        side = harness.agent._aux_client(max_tokens=64, source="compaction")
        self.assertIsNot(side, turn)
        self.assertEqual((type(side), side.engine, side.selected_model), (type(turn), "claude", turn.selected_model))

    def test_a_frontend_that_does_not_run_these_turns_never_gets_the_cli(self):
        harness = self.harness("claude")
        harness.ui.cli_model_enabled = False
        self.assertIsNone(harness.agent._cli_model_client())


class WhenItCantAnswer(World):
    def test_a_signed_out_cli_says_so_plainly(self):
        (Path(os.environ["HOME"]) / ".claude/.credentials.json").unlink()     # the test's own empty marker
        self.script({"say": "never"})
        harness = self.harness("claude")
        self.assertFalse(self.run_turn(harness, "Hello"))
        errors = " ".join(f.get("message", "") for f in harness.stream.frames() if f["type"] == "error")
        self.assertIn("isn't signed in", errors)
        self.assertEqual(self.native, [], "nothing else was asked")

    def test_its_other_cli_carries_the_turn_on_with_dgcs_tools_too(self):
        claude = self.bin / "claude"
        claude.write_text("#!" + os.sys.executable + "\nimport json, sys\n"
                          "if '--help' in sys.argv: print('--restricted'); sys.exit(0)\n"
                          "print(json.dumps({'type': 'result', 'subtype': 'error_during_execution', 'is_error': True,"
                          " 'error': 'You have hit your usage limit.'}), flush=True)\nsys.exit(1)\n")
        self.script({"call": "read_file", "args": {"path": "notes.txt"}}, {"say": "It says hello."})
        harness = self.harness("claude", fallback_engine="codex")
        self.assertTrue(self.run_turn(harness, "What does notes.txt say?"))
        seen = self.seen()
        self.assertEqual(seen["engine"], "codex")
        self.assertIn("--ignore-user-config", seen["argv"], "the fallback CLI is held to DGC's tools as well")
        self.assertIn("hello from the project", seen["answers"][0]["text"])
        infos = " ".join(f.get("message", "") for f in harness.stream.frames() if f["type"] == "info")
        self.assertIn("falling back to Codex", infos)

    def test_when_both_fail_no_cli_ever_runs_with_tools_of_its_own(self):
        self.script({"fail": "The subscription is rate limited."})
        harness = self.harness("claude", fallback_engine="codex")
        self.assertFalse(self.run_turn(harness, "Hello"))
        runs = [json.loads(line) for line in (self.bin / "runs.jsonl").read_text().splitlines()]
        self.assertEqual([run["engine"] for run in runs], ["claude", "codex"])
        for run in runs:
            self.assertTrue("--strict-mcp-config" in run["argv"] or "--ignore-user-config" in run["argv"], run)

    def test_the_cli_waits_on_dgcs_tools_as_long_as_dgc_does(self):
        self.script({"say": "Hi."})
        harness = self.harness("codex")
        self.assertTrue(self.run_turn(harness, "Hello"))
        self.assertEqual(self.seen()["config"]["mcp_servers.dgc.tool_timeout_sec"], str(24 * 3600))


class Stop(World):
    def test_stop_ends_the_cli_and_its_whole_process_group(self):
        for engine in ("claude", "codex"):
            with self.subTest(engine=engine):
                (self.bin / "pids.json").unlink(missing_ok=True)
                self.script({"wait": 60}, {"say": "never"})
                harness = self.harness(engine)
                done = {}
                worker = threading.Thread(target=lambda: done.setdefault("ok", self.run_turn(harness, "Wait")))
                worker.start()
                deadline = time.monotonic() + 20
                while not (self.bin / "pids.json").exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                pids = json.loads((self.bin / "pids.json").read_text())
                began = time.monotonic()
                harness.agent.cancelled.set()
                worker.join(15)
                self.assertFalse(worker.is_alive(), "the turn ended")
                self.assertLess(time.monotonic() - began, 10)
                for name, pid in pids.items():
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline and _alive(pid):
                        time.sleep(0.05)
                    self.assertFalse(_alive(pid), f"the CLI's {name} is gone")


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:                                       # a zombie is gone for this purpose
        with open(f"/proc/{pid}/stat", encoding="ascii") as handle:
            return handle.read().split(")")[-1].split()[0] != "Z"
    except OSError:
        return False


if __name__ == "__main__":
    unittest.main()
