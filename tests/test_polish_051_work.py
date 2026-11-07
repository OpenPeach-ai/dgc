"""The morning live check's fixes on the Work side of 0.51.0: the backend half (the editor's are in editors/vscode/test)."""
from __future__ import annotations

import json
import os
import tempfile
import threading
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dgc import editor_protocol as ep
from dgc.config import Config, DEFAULTS

def refusal(*args, **kwargs):
    from dgc.tool_precheck import refusal as check
    return check(*args, **kwargs)



class _Home(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        root = Path(self.home.name)
        patches = [mock.patch("dgc.config.USER_HOME", root), mock.patch("dgc.config.USER_CONFIG", root / "config.json"),
                   mock.patch("dgc.config.USER_SECRETS", root / "secrets.json")]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        for key in ("DGC_MODEL", "DGC_BASE_URL", "DGC_API_KEY"):
            patch = mock.patch.dict(os.environ)
            patch.start()
            self.addCleanup(patch.stop)
            os.environ.pop(key, None)
        self.root = root
        self.work = root / "work"
        self.work.mkdir()

    def config(self):
        return Config(project_root=self.work)


class NothingChosenTests(_Home):
    """A default written down isn't a choice: the first provider's window, and 'No provider'."""

    def test_a_fresh_home_has_chosen_no_model(self):
        self.assertFalse(self.config().model_chosen())

    def test_a_first_save_of_something_else_chooses_nothing(self):
        config = self.config()
        config.set("thinking", "low")
        saved = json.loads((self.root / "config.json").read_text())
        for key in ("model", "base_url", "api_mode", "context_size"):
            self.assertNotIn(key, saved, f"{key} only states its default")
        self.assertEqual(saved["thinking"], "low")
        again = self.config()
        self.assertFalse(again.model_chosen())
        self.assertFalse(again.is_explicit("context_size"), "a 32K nobody chose never pins the window")
        self.assertEqual(again.model, DEFAULTS["model"], "the default still reads as the default")
        self.assertEqual(again.get("context_size"), DEFAULTS["context_size"])

    def test_a_saved_model_or_host_or_subscription_is_chosen(self):
        for key, value in (("model", "mine:latest"), ("base_url", "http://gpu.local:11434/v1"), ("subscription_engine", "claude")):
            (self.root / "config.json").unlink(missing_ok=True)
            config = self.config()
            config.set(key, value)
            self.assertTrue(self.config().model_chosen(), key)

    def test_the_default_model_set_by_hand_on_a_fresh_home_is_chosen(self):
        config = self.config()
        config.set("model", DEFAULTS["model"])         # dgc setup, /model: someone chose it, whatever it equals
        self.assertIn("model", json.loads((self.root / "config.json").read_text()))
        self.assertTrue(self.config().model_chosen())

    def test_the_default_model_chosen_on_purpose_stays_chosen(self):
        (self.root / "config.json").write_text(json.dumps({"model": DEFAULTS["model"]}))
        self.assertTrue(self.config().model_chosen(), "someone wrote it there, or an older first save did")


class PrecheckTests(unittest.TestCase):
    GOOD = {"scope": "personal", "name": "Seed to news", "pip_ids": ["pip_a", "pip_b"], "pip_names": ["A", "B"],
            "tasks": ["List it"], "mode": "reviewed",
            "expected_pins": [{"pip_id": "pip_a", "job_version": 1, "lifecycle_revision": 0},
                              {"pip_id": "pip_b", "job_version": 1, "lifecycle_revision": 0}]}

    def test_a_bad_workflow_call_is_refused_in_the_tools_own_words(self):
        self.assertEqual(refusal("pips_workflow", {**self.GOOD, "tasks": ["one", "two"]}),
                         "RegistryError: Choose two to four Pip IDs and one task for each handoff.")
        self.assertIn("Choose scope", refusal("pips_workflow", {"name": "x"}))

    def test_a_good_workflow_call_goes_on_to_ask(self):
        self.assertEqual(refusal("pips_workflow", self.GOOD), "")

    def test_the_other_asking_pip_tools_share_it(self):
        self.assertIn("Supply only pip_id", refusal("pips_propose", {"pip_id": "x"}))
        self.assertIn("Supply only default_model", refusal("pips_settings", {}))
        self.assertIn("Supply pip_id", refusal("run_pip_now", {"pip_id": "x"}))
        self.assertTrue(refusal("handoff_to_pip", {}))

    def test_a_plugin_call_missing_what_its_schema_requires(self):
        class Mcp:
            @staticmethod
            def tool_schemas():
                return [{"function": {"name": "mcp__notes__find", "parameters": {"required": ["query"]}}}]
        self.assertEqual(refusal("mcp__notes__find", {}, Mcp), "mcp__notes__find needs query.")
        self.assertEqual(refusal("mcp__notes__find", {"query": "x"}, Mcp), "")
        self.assertEqual(refusal("mcp_call", {"name": "mcp__notes__find", "arguments": {}}, Mcp), "mcp__notes__find needs query.")
        self.assertEqual(refusal("mcp__other__tool", {}, Mcp), "", "a tool it doesn't know is the plugin's to refuse")

    def test_other_tools_are_not_its_business(self):
        self.assertEqual(refusal("write_file", {}), "")
        self.assertEqual(refusal("bash", {}), "")


class AskOrderTests(_Home):
    """The agent itself: a malformed call raises no card and reaches the model; a good one still asks."""

    def agent(self):
        from dgc.agent import Agent

        class UI:
            def __init__(self):
                self.asked, self.calls, self.results, self.denied = [], [], [], []
                self.deny_reason = ""

            def approve(self, name, args, call_id=None):
                self.asked.append(name)
                return "no"

            def tool_call(self, name, args, call_id=None):
                self.calls.append(name)

            def tool_result(self, name, out, call_id=None):
                self.results.append(out)

            def tool_denied(self, name, args, reason, call_id=None):
                self.denied.append(reason)

            def __getattr__(self, name):
                return lambda *a, **k: None
        config = self.config()
        config.set("pips_enabled", True, persist=False)
        agent = Agent(config, UI())
        self.addCleanup(lambda: getattr(agent, "close", lambda: None)())
        agent._tool_offered = lambda *a, **k: True
        return agent

    def call(self, agent, arguments):
        from dgc.llm import ToolCall
        agent._active_tool_names = {"pips_workflow"}
        return agent._handle_call(ToolCall("wf-1", "pips_workflow", arguments))

    def test_bad_arguments_go_back_with_no_card(self):
        agent = self.agent()
        with mock.patch.object(type(agent), "_tool_schemas", lambda self: [{"function": {"name": "pips_workflow"}}]):
            out = self.call(agent, {**PrecheckTests.GOOD, "tasks": ["one", "two"]})
        self.assertEqual(agent.ui.asked, [], "no Allow card for a call that can't run")
        self.assertIn("Choose two to four Pip IDs", out)
        self.assertEqual(agent.ui.calls, ["pips_workflow"], "its row still shows, and fails")
        self.assertEqual(len(agent.ui.results), 1)

    def test_good_arguments_still_ask(self):
        agent = self.agent()
        with mock.patch.object(type(agent), "_tool_schemas", lambda self: [{"function": {"name": "pips_workflow"}}]):
            self.call(agent, PrecheckTests.GOOD)
        self.assertEqual(agent.ui.asked, ["pips_workflow"])


class TraceRecordTests(unittest.TestCase):
    def ui(self):
        from dgc.headless import HeadlessUI
        ui = HeadlessUI.__new__(HeadlessUI)
        events = []
        ui.em = mock.Mock()
        ui.em.emit = lambda kind, **fields: events.append({"type": kind, **fields})
        ui.pending = None
        ui.turn_id = "t3"
        ui.turn_activity = lambda *a, **k: None
        ui._close_reasoning_fallback = lambda: None
        return ui, events

    def test_a_turn_keeps_its_steps_with_its_id_and_model(self):
        ui, _ = self.ui()
        ui.begin_turn_trace()
        ui.trace_usage(13722)
        ui.tool_call("grep", {"pattern": "subtotal"}, "c1")
        ui.tool_call("read_file", {"path": "billing.py"}, "c2")
        ui.tool_call("read_file", {"path": "no_such_file.py"}, "c3")
        ui.tool_result("grep", "a.py:1\nb.py:2\nc.py:3\nd.py:4", "c1")
        ui.tool_result("read_file", "1 text", "c2")
        ui.tool_result("read_file", "error: no such file", "c3")
        ui.trace_model_start()
        ui.trace_usage(14065)
        ui.__dict__["_stream_open"] = True
        ui._turn_trace.model_end()
        saved = ui.take_turn_trace("deepseek-v4.1-flash:cloud")
        self.assertEqual((saved["id"], saved["model"]), ("t3", "deepseek-v4.1-flash:cloud"))
        rows = [(s["kind"], s["label"]) for s in saved["steps"]]
        self.assertEqual(rows, [("model", "model.response"), ("tool", "grep"), ("tool", "read_file"), ("tool", "read_file"), ("model", "model.response")])
        self.assertEqual(saved["steps"][0]["tokens"], 13722)
        self.assertEqual(saved["steps"][1]["hits"], 4)
        self.assertEqual(saved["steps"][2]["detail"], "billing.py")
        self.assertTrue(saved["steps"][3]["error"])
        self.assertEqual(saved["steps"][4]["tokens"], 14065)
        self.assertEqual(ep.event_error({"seq": 1, "type": "reply_trace", "turn_id": "t3", "trace": saved}), None)

    def test_a_helpers_steps_are_on_its_own_page(self):
        ui, _ = self.ui()
        ui.begin_turn_trace()
        ui.tool_call("read_file", {"path": "x"}, "sub-a1:c1")
        self.assertEqual(ui._turn_trace._rows, [], "and the model's round stays open")

    def test_a_step_never_closed_gives_no_trace(self):
        ui, _ = self.ui()
        ui.begin_turn_trace()
        ui.tool_call("bash", {"command": "sleep 9"}, "c1")
        self.assertIsNone(ui.take_turn_trace("m"))

    def test_history_checks_what_it_replays(self):
        from dgc.headless import _history_turn_trace
        good = {"v": 1, "ms": 5, "steps": [{"kind": "model", "label": "model.response", "start": 0, "end": 5}], "id": "t1", "model": "m"}
        self.assertEqual(_history_turn_trace(good)["id"], "t1")
        self.assertIsNone(_history_turn_trace({"v": 1, "ms": 5, "steps": "no"}))
        self.assertIsNone(_history_turn_trace("nope"))


class HeldRootsTests(unittest.TestCase):
    """A folder grant that arrives while a turn runs waits for its end, and nothing is said in the chat."""

    def run_with(self, busy: bool):
        from dgc.headless import Backend
        events, applied = [], []
        fake = mock.Mock(spec=[])
        fake._busy = lambda: busy
        fake._turn_state_lock = lambda: threading.RLock()
        fake._set_workspace_roots = lambda cmd, rid: applied.append((cmd, rid))
        return fake, events, applied, Backend

    def test_held_while_busy_applied_at_the_end_newest_wins(self):
        fake, _, applied, Backend = self.run_with(True)
        self.assertTrue(Backend._hold_workspace_roots(fake, {"roots": ["a"]}, "r1"))
        self.assertTrue(Backend._hold_workspace_roots(fake, {"roots": ["b"]}, "r2"))
        self.assertEqual(applied, [])
        Backend._flush_held_workspace_roots(fake)
        self.assertEqual(applied, [({"roots": ["b"]}, "r2")], "one acknowledgement, for the newest")
        Backend._flush_held_workspace_roots(fake)
        self.assertEqual(len(applied), 1, "once")

    def test_not_held_when_the_turn_already_ended(self):
        fake, _, applied, Backend = self.run_with(False)
        self.assertFalse(Backend._hold_workspace_roots(fake, {"roots": []}, None))
        self.assertEqual(applied, [])


class OverRealServe(unittest.TestCase):
    """A real ``dgc serve`` over stdio, with a fake Ollama whose first model never answers its second request, so a turn is
    certainly running when the commands arrive."""

    def serve(self):
        import queue
        import shutil
        import subprocess
        import sys
        import time
        from test_midturn_model_switch import PROJECT, _FakeOllama
        fake = _FakeOllama(stuck={"model-a"})
        self.addCleanup(fake.close)
        home, work = Path(tempfile.mkdtemp(prefix="dgc-polish-home-")), Path(tempfile.mkdtemp(prefix="dgc-polish-work-"))
        (work / "notes.txt").write_text("The warehouse opens at 9am.\n")
        (home / ".dgc").mkdir()
        (home / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": f"http://127.0.0.1:{fake.port}/v1", "api_mode": "ollama", "model": "model-a", "thinking": "off",
            "suggest": False, "notes": False, "artifact_autostart": False}))
        env = dict(os.environ, HOME=str(home), USERPROFILE=str(home), PYTHONPATH=str(PROJECT), PYTHONDONTWRITEBYTECODE="1")
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=str(work), env=env, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        events: list[dict] = []
        arrived: queue.Queue = queue.Queue()

        def read():
            for line in proc.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                events.append(event)
                arrived.put(event)
        threading.Thread(target=read, daemon=True).start()

        def send(command):
            proc.stdin.write(json.dumps(command) + "\n")
            proc.stdin.flush()

        def wait(predicate, timeout=30):
            for event in list(events):
                if predicate(event):
                    return event
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    event = arrived.get(timeout=max(0.01, deadline - time.monotonic()))
                except queue.Empty:
                    break
                if predicate(event):
                    return event
            return None

        def cleanup():
            try:
                send({"type": "cancel"})
                proc.stdin.close()
                proc.wait(timeout=30)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                proc.kill()
                proc.wait(timeout=10)
            proc.stdout.close()
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(work, ignore_errors=True)
        self.addCleanup(cleanup)
        self.assertIsNotNone(wait(lambda e: e["type"] == "ready", 60), "serve never became ready")
        send({"type": "set_workspace_roots", "roots": [str(work)], "request_id": "roots-0"})
        self.assertIsNotNone(wait(lambda e: e["type"] == "workspace_roots"))
        return fake, work, events, send, wait

    def busy_on_model_a(self, fake, send, wait):
        import time
        send({"type": "prompt", "text": "Read notes.txt and tell me when the warehouse opens.", "request_id": "p1"})
        self.assertIsNotNone(wait(lambda e: e["type"] == "tool_result", 60), "no tool round ran")
        deadline = time.monotonic() + 30
        while fake.models().count("model-a") < 2 and time.monotonic() < deadline:
            time.sleep(0.05)

    def test_a_folder_grant_mid_turn_waits_for_the_turns_end_and_is_never_refused(self):
        import time
        fake, work, events, send, wait = self.serve()
        self.busy_on_model_a(fake, send, wait)
        send({"type": "prompt", "text": "And when does it close?", "request_id": "p2", "delivery": "queue"})
        self.assertIsNotNone(wait(lambda e: e["type"] == "prompt_accepted" and e.get("request_id") == "p2"))
        send({"type": "set_workspace_roots", "roots": [str(work)], "request_id": "roots-1"})
        time.sleep(0.5)
        self.assertFalse([e for e in events if e["type"] == "workspace_roots" and e.get("request_id") == "roots-1"],
                         "a running turn keeps the folders it started with")
        send({"type": "set_model", "route": "native", "model": "model-b", "request_id": "move"})
        self.assertIsNotNone(wait(lambda e: e["type"] == "turn_end" and e.get("turn_id") != "", 30))
        self.assertIsNotNone(wait(lambda e: e["type"] == "workspace_roots" and e.get("request_id") == "roots-1", 30))
        self.assertIsNotNone(wait(lambda e: e["type"] == "turn_start" and e.get("request_id") == "p2", 30))
        self.assertEqual([e for e in events if e["type"] == "command_rejected"], [], "nothing to show the person")
        kinds = [(e["type"], e.get("request_id")) for e in events]
        self.assertLess(kinds.index(("workspace_roots", "roots-1")), kinds.index(("turn_start", "p2")),
                        "the queue's next turn already runs on the new grant")
        first_end = next(i for i, e in enumerate(events) if e["type"] == "turn_end")
        self.assertLess(first_end, kinds.index(("workspace_roots", "roots-1")))

    def test_any_other_command_refused_mid_turn_names_no_method(self):
        fake, _, events, send, wait = self.serve()
        self.busy_on_model_a(fake, send, wait)
        send({"type": "reload_skills", "request_id": "skills"})
        refused = wait(lambda e: e["type"] == "command_rejected" and e.get("command") == "reload_skills")
        self.assertEqual(refused["reason"], "turn_in_progress")
        self.assertNotIn("reload_skills", refused["message"])
        send({"type": "set_model", "route": "native", "model": "model-b", "request_id": "move"})

    def test_a_turns_trace_is_the_same_record_live_and_in_its_history(self):
        fake, _, events, send, wait = self.serve()
        self.busy_on_model_a(fake, send, wait)
        send({"type": "set_model", "route": "native", "model": "model-b", "request_id": "move"})
        self.assertIsNotNone(wait(lambda e: e["type"] == "turn_end", 30))
        live = next(e for e in events if e["type"] == "reply_trace")
        self.assertLess(events.index(live), next(i for i, e in enumerate(events) if e["type"] == "turn_end"))
        self.assertEqual(live["trace"]["id"], live["turn_id"])
        self.assertTrue(live["trace"]["model"], "the title names the model")
        self.assertEqual([s["kind"] for s in live["trace"]["steps"]], ["model", "tool", "model"])
        send({"type": "get_history", "request_id": "h"})
        history = wait(lambda e: e["type"] == "history" and e.get("request_id") == "h")
        marks = [i for i in history["items"] if i.get("role") == "time" and i.get("of") == "reply_trace"]
        self.assertEqual([m["trace"] for m in marks], [live["trace"]], "a reload draws what the turn's end drew")


class PlainFailureTests(unittest.TestCase):
    def test_a_run_failures_line_names_no_url_and_no_json(self):
        from dgc.model_errors import plain_failure
        from dgc.pip_report_delivery import summary_line
        raw = ("HTTP 404 from http://localhost:11434/v1/chat/completions: "
               "{\"error\":{\"message\":\"model 'qwen3:8b' not found\"}}")
        line = summary_line({"name": "Core", "outcome": "failed", "reason": raw})
        self.assertEqual(line, "Pip 'Core' failed: the model qwen3:8b isn't available")
        self.assertEqual(plain_failure("HTTP 401 from x: no"), "the model provider turned down the API key")
        self.assertEqual(plain_failure("HTTP 500 from x: boom"), "the model provider had a problem on its side")
        for said in ("cannot connect to http://127.0.0.1:1/v1 (HTTPConnectionPool(host='127.0.0.1', port=1))",
                     "The model didn't answer: cannot connect to http://127.0.0.1:1/v1"):
            self.assertEqual(plain_failure(said), "DGC can't reach the model provider")
        self.assertEqual(plain_failure("cannot connect to http://h:1/v1 — is your local LLM server running?"), "DGC can't reach the model provider")
        self.assertEqual(plain_failure("Not run: this Pip's plan"), "Not run: this Pip's plan", "someone else's sentence stays")


class ProtocolStaysOpenTests(unittest.TestCase):
    def test_commands_lists_pips_for_the_editor(self):
        from dgc.commands import command_specs, resolve_command
        spec = resolve_command("pips", "editor")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.editor_action, "pips")
        self.assertIn("pips", [s.name for s in command_specs("editor")], "so it's in the slash menu")

    def test_every_terminal_command_says_something_in_the_editor(self):
        from dgc.commands import BUILTIN_COMMANDS
        panel = (Path(__file__).resolve().parents[1] / "editors/vscode/src/panel.ts").read_text()
        table = panel[panel.index("const TERMINAL_COMMANDS"):panel.index("// The web search providers this editor can offer")]
        handled_elsewhere = {"todo", "usage", "bored", "pips", "mods"}     # /mods is answered in the page, before this
        missing = []
        for spec in BUILTIN_COMMANDS:
            if "editor" in spec.surfaces or spec.name in handled_elsewhere:
                continue
            for name in (spec.name, *spec.aliases):
                if f"{name}:" not in table and f'"{name}":' not in table:
                    missing.append(name)
        self.assertEqual(missing, [], "these would print 'unknown command' in a Work tab")


if __name__ == "__main__":
    unittest.main()
