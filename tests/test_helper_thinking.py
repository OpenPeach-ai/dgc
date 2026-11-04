"""How hard a helper (a sub-agent) thinks, and where that's set (0.51).

Which level wins, highest first: the DGC Router model's own choice (when it isn't "same as the helper"), the agent
file's effort:, Settings → Models → Sub-agents → Thinking (subagent_thinking), then the main chat's level. A model the
Router knows can't think gets none. The level used is said where the person looks: the helper's row, its lease in
router_status (the agent map's "on NAS · qwen3.5:9b · thinking low"), router_status's text and `dgc router status`."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_router_routing import RouterCase, model, system  # noqa: E402
from test_subagents import clone_fixture  # noqa: E402

from dgc import router as R  # noqa: E402
from dgc import router_state, router_tools  # noqa: E402
from dgc.agent import Agent, _SubUI  # noqa: E402
from dgc.agents import AgentDef  # noqa: E402
from dgc.config import Config, validate_router  # noqa: E402
from dgc.editor_protocol import event_error  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


class Precedence(RouterCase):
    def setUp(self):
        super().setUp()
        self.block = {"enabled": True, "when_busy": "wait", "systems": [
            system("nas", "http://nas.local:11434", [model("qwen3.5:9b", context=16384)], name="NAS")]}

    def run_helper(self, *, block=None, adef=None, thinking="high", subagent_thinking=None, thinks=True):
        """One helper run through the real path: the level its turn uses, and what its row says."""
        self.config(copy.deepcopy(block) if block is not None else None, thinking=thinking)
        if subagent_thinking is not None:
            self.harness.config.data["subagent_thinking"] = subagent_thinking
        if block is not None and thinks is not None:
            router_state.save_discovery("nas", {"models": [{"name": "qwen3.5:9b", "thinking": thinks, "tools": True}]})
        agent = self.harness.agent
        registry = agent.subagents
        seen = {}

        def run_child(child, prompt):
            seen.update(effort=child._effective_thinking(""), override=child._effort_override,
                        leases=[dict(lease) for lease in self.router.leases()])
            child.ui.on_text("Looked.")
            child.ui.end_stream()
            return True
        defs = {"reviewer": adef} if adef is not None else {}
        sub_ui = _SubUI(self.harness.ui, "look", cancel=agent.cancelled)
        handle = sub_ui.agent_id
        registry.start(id=handle, description="look", call_id="call-1")
        with patch.object(Config, "clone_for_root", clone_fixture), patch.object(Agent, "run_turn", run_child), \
                patch.object(type(agent), "agent_defs", property(lambda self: defs)):
            failure, self.result, start = agent._execute_prepared_subagent(
                "look", "Look around.", "reviewer" if adef is not None else "", None, sub_ui, "call-1")
        self.assertEqual((failure, start), ("", ""))
        row = next(i for i in registry.snapshot()["items"] if i["id"] == handle)
        return seen, row

    def test_the_main_chats_level_when_nothing_else_is_set(self):
        seen, row = self.run_helper(thinking="high")
        self.assertEqual((seen["override"], seen["effort"]), (None, "high"), "as 0.50: it inherits the main chat's")
        self.assertEqual(row["thinking"], "high")

    def test_a_helper_following_a_main_chat_that_doesnt_think_says_nothing_but_a_chosen_off_says_so(self):
        seen, row = self.run_helper(thinking="off")
        self.assertEqual(seen["effort"], "off")
        self.assertNotIn("thinking", row, "no clutter on every helper's row")
        seen, row = self.run_helper(thinking="high", subagent_thinking="off")
        self.assertEqual(row["thinking"], "off", "chosen: said")

    def test_settings_sub_agents_thinking_beats_the_main_chat(self):
        seen, row = self.run_helper(thinking="high", subagent_thinking="low")
        self.assertEqual((seen["effort"], row["thinking"]), ("low", "low"))
        seen, row = self.run_helper(thinking="high", subagent_thinking="")
        self.assertEqual(seen["effort"], "high", "empty: the main chat's again")

    def test_the_agent_files_effort_beats_settings(self):
        adef = AgentDef(name="reviewer", description="", body="", effort="medium")
        seen, row = self.run_helper(adef=adef, subagent_thinking="low")
        self.assertEqual((seen["effort"], row["thinking"]), ("medium", "medium"))

    def test_the_router_models_own_choice_beats_everything_and_same_falls_through(self):
        adef = AgentDef(name="reviewer", description="", body="", effort="medium")
        block = copy.deepcopy(self.block)
        block["systems"][0]["models"][0]["thinking"] = "off"
        seen, row = self.run_helper(block=block, adef=adef, subagent_thinking="low")
        self.assertEqual((seen["effort"], row["thinking"]), ("off", "off"))
        [lease] = seen["leases"]
        self.assertEqual(lease["thinking"], "off", "its lease says the level, for the agent map")
        block["systems"][0]["models"][0].pop("thinking")            # same as the helper
        seen, row = self.run_helper(block=block, adef=adef, subagent_thinking="low")
        self.assertEqual(seen["effort"], "medium")

    def test_a_model_that_cant_think_ignores_every_level(self):
        block = copy.deepcopy(self.block)
        block["systems"][0]["models"][0]["thinking"] = "high"
        seen, row = self.run_helper(block=block, subagent_thinking="xhigh", thinks=False)
        self.assertEqual(seen["effort"], "off")
        self.assertNotIn("thinking", row, "its row says nothing about thinking")
        self.assertNotIn("thinking", seen["leases"][0])

    def test_the_helpers_result_says_the_level_it_used_where_it_ran(self):
        # Release check, 2026-11-03: the terminal shows a helper's result, "DGC Router: ran on This box (...)", and it
        # named the system but not the level, though the notes say the helper's row says the level it used.
        seen, row = self.run_helper(block=self.block, subagent_thinking="low")
        self.assertEqual(row["thinking"], "low")
        self.assertIn("DGC Router: ran on NAS (qwen3.5:9b, thinking low).", self.result)
        seen, row = self.run_helper(block=self.block, subagent_thinking="xhigh")
        self.assertIn("DGC Router: ran on NAS (qwen3.5:9b, thinking extra high).", self.result)
        seen, row = self.run_helper(block=self.block, subagent_thinking="high", thinks=False)
        self.assertIn("DGC Router: ran on NAS (qwen3.5:9b).", self.result, "a model that can't think: nothing said")
        seen, row = self.run_helper(subagent_thinking="low")
        self.assertNotIn("DGC Router", self.result, "not on the Router: no line")

    def test_the_resolution_itself_step_by_step(self):
        self.config(None, thinking="medium")
        agent = self.harness.agent
        adef = AgentDef(name="r", description="", body="", effort="high")
        route = R.Route(lease_id="l", system_id="nas", system_name="NAS", model="m", base_url="http://x", server="ollama",
                        api_mode="", context=8192, thinking="low", thinks=True)
        for data, given, want in ((dict(), None, ("", "medium")),
                                  (dict(subagent_thinking="off"), None, ("off", "off")),
                                  (dict(subagent_thinking="off"), adef, ("high", "high")),
                                  (dict(subagent_thinking="off"), (adef, route), ("low", "low")),
                                  (dict(subagent_thinking="bogus"), None, ("", "medium"))):
            with self.subTest(data=data, given=given):
                agent.config.data.pop("subagent_thinking", None)
                agent.config.data.update(data)
                adef_now, route_now = given if isinstance(given, tuple) else (given, None)
                self.assertEqual(agent._helper_thinking(adef_now, route_now), want)


class TheModelAsks(RouterCase):
    """The `task` tool's own effort: the model's choice per helper (a quick lookup, a hard review), described in the
    schema and never inferred from the prompt's words. Used only when the user pinned no level."""

    def test_the_schema_offers_it_for_one_helper_and_each_of_a_batch(self):
        from dgc.tools import TOOL_SCHEMAS
        task = next(t for t in TOOL_SCHEMAS if t["function"]["name"] == "task")["function"]["parameters"]
        self.assertEqual(task["properties"]["effort"]["enum"], ["off", "low", "medium", "high"])
        self.assertEqual(task["properties"]["tasks"]["items"]["properties"]["effort"]["enum"], ["off", "low", "medium", "high"])
        self.assertNotIn("effort", task.get("required", []))

    def test_it_is_used_only_when_nothing_else_pins_the_level(self):
        from dgc.llm import ToolCall
        from dgc.subagents import task_batch_child_id
        self.config(None, thinking="high")
        agent = self.harness.agent
        agent._note_router_hints([
            ToolCall("one", "task", {"description": "look", "prompt": "Look.", "effort": "low"}),
            ToolCall("two", "task", {"tasks": [{"description": "a", "prompt": "A."},
                                               {"description": "b", "prompt": "B.", "effort": "high"}], "effort": "off"}),
            ToolCall("bad", "task", {"description": "x", "prompt": "X.", "effort": "max"})])
        efforts = agent._task_efforts
        self.assertEqual((efforts["one"], efforts[task_batch_child_id("two", 1)], efforts[task_batch_child_id("two", 2)]),
                         ("low", "off", "high"))
        self.assertNotIn("bad", efforts)
        self.assertNotIn("one", getattr(agent, "_router_hints", {}), "the Router's hints stay system, model and size")
        self.assertEqual(agent._helper_thinking(None, None, "low"), ("low", "low"))
        agent.config.data["subagent_thinking"] = "medium"
        self.assertEqual(agent._helper_thinking(None, None, "low"), ("medium", "medium"), "the user's setting wins")
        agent.config.data["subagent_thinking"] = ""
        self.assertEqual(agent._helper_thinking(AgentDef(name="r", description="", body="", effort="xhigh"), None, "low"),
                         ("xhigh", "xhigh"), "the agent file wins")
        self.assertEqual(agent._helper_thinking(None, None, ""), ("", "high"), "nothing asked: the main chat's")


class OnTheRouter(RouterCase):
    def test_a_model_rows_thinking_is_kept_checked_and_shown(self):
        block = {"enabled": True, "systems": [system("nas", "http://nas.local:11434", [
            model("qwen3.5:9b", thinking="low"), model("llama3.1:8b"), model("phi4:14b")], name="NAS")]}
        cleaned, problems = validate_router(block)
        self.assertEqual(problems, [])
        self.assertEqual([m.get("thinking") for m in cleaned["systems"][0]["models"]], ["low", None, None])
        self.assertTrue(validate_router({"enabled": True, "systems": [system("x", "http://x:1", [model("m", thinking="max")])]})[1])
        config = self.config(cleaned)
        router_state.save_discovery("nas", {"models": [{"name": "qwen3.5:9b", "thinking": True},
                                                       {"name": "llama3.1:8b", "thinking": False},
                                                       {"name": "phi4:14b", "thinking": True}]})
        rows = {m["name"]: m for m in R.status(config)["systems"][0]["models"]}
        self.assertEqual((rows["qwen3.5:9b"]["thinking"], rows["qwen3.5:9b"]["thinks"]), ("low", True))
        self.assertEqual((rows["llama3.1:8b"].get("thinking"), rows["llama3.1:8b"]["thinks"]), (None, False))
        text = router_tools.status_text(R.status(config))
        self.assertIn("qwen3.5:9b: ", text)
        self.assertRegex(text, r"qwen3\.5:9b: [^\n]*thinking low")
        self.assertRegex(text, r"llama3\.1:8b: [^\n]*doesn't think")
        self.assertRegex(text, r"phi4:14b: [^\n]*thinking: same as the helper")

    def test_set_model_sets_and_clears_it_and_the_cli_takes_it(self):
        config = self.config({"enabled": True, "systems": [system("nas", "http://nas.local:11434", [model("qwen3.5:9b")])]})
        plan = router_tools.plan_update(config, {"action": "set_model", "system": "nas", "model": "qwen3.5:9b",
                                                 "thinking": "low"}, detect=False)
        self.assertEqual(plan.after["systems"][0]["models"][0]["thinking"], "low")
        router_tools.apply_plan(config, plan)
        plan = router_tools.plan_update(config, {"action": "set_model", "system": "nas", "model": "qwen3.5:9b",
                                                 "thinking": ""}, detect=False)
        self.assertNotIn("thinking", plan.after["systems"][0]["models"][0], "empty: the helper's own level again")
        with self.assertRaises(router_tools.UpdateError):
            router_tools.plan_update(config, {"action": "set_model", "system": "nas", "model": "qwen3.5:9b",
                                              "thinking": "xhigh"}, detect=False)
        schema = next(s for s in router_tools.SCHEMAS if s["function"]["name"] == "router_update")
        self.assertEqual(schema["function"]["parameters"]["properties"]["thinking"]["enum"], ["", "off", "low", "medium", "high"])
        from dgc import router_cli
        parser = router_cli.build_parser() if hasattr(router_cli, "build_parser") else None
        if parser is not None:
            args = parser.parse_args(["edit", "nas", "--model", "qwen3.5:9b", "--thinking", "same"])
            self.assertEqual(args.thinking, "same")


class OnTheWire(unittest.TestCase):
    """A real `dgc serve`: the capability, the settings round trip in an event of its own (never a new field on
    `config`), a level it doesn't know refused, and router_thinking."""

    def test_settings_round_trip_and_router_thinking(self):
        home = Path(tempfile.mkdtemp(prefix="dgc-helper-thinking-"))
        project = home / "project"
        project.mkdir()
        (project / ".git").mkdir()
        (home / ".dgc").mkdir()
        (home / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": "http://127.0.0.1:9/v1", "model": "m", "pips_enabled": False,
            "router": {"enabled": False, "when_busy": "wait", "systems": [
                {"id": "nas", "name": "NAS", "base_url": "http://127.0.0.1:9", "server": "ollama",
                 "jobs": ["subagents"], "workers": 1, "models": [{"name": "qwen3.5:9b", "workers": 1, "context": 8192}]}]}}))
        env = {key: value for key, value in os.environ.items() if not key.startswith("DGC_")}
        env.update(HOME=str(home), PYTHONPATH=str(ROOT))
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=project, env=env, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        events = []

        def send(command):
            proc.stdin.write(json.dumps(command) + "\n")
            proc.stdin.flush()

        def until(predicate, timeout=60):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                line = proc.stdout.readline()
                if not line:
                    break
                event = json.loads(line)
                events.append(event)
                self.assertIsNone(event_error(event), event)
                if predicate(event):
                    return event
            self.fail(f"no matching event; saw {[e.get('type') for e in events][-12:]}")
        try:
            ready = until(lambda e: e["type"] == "ready")
            self.assertEqual(ready["capabilities"]["subagent_thinking"], 1)
            self.assertEqual(ready["capabilities"]["router"]["thinking"], 1)
            self.assertIn("router_thinking", ready["capabilities"]["router"]["commands"])
            send({"type": "get_config", "request_id": "c1", "fields": ["subagent_settings"]})
            first = until(lambda e: e.get("request_id") == "c1" and e["type"] == "subagent_settings")
            self.assertEqual(first["thinking"], "")
            config = until(lambda e: e.get("request_id") == "c1" and e["type"] == "config")
            self.assertNotIn("subagent_thinking", config, "never a new field on config")
            send({"type": "set_config", "request_id": "c2", "values": {"subagent_thinking": "low"}})
            until(lambda e: e.get("request_id") == "c2" and e["type"] == "config")
            send({"type": "get_config", "request_id": "c3", "fields": ["subagent_settings"]})
            self.assertEqual(until(lambda e: e.get("request_id") == "c3" and e["type"] == "subagent_settings")["thinking"], "low")
            send({"type": "set_config", "request_id": "c4", "values": {"subagent_thinking": "max"}})
            self.assertEqual(until(lambda e: e.get("request_id") == "c4")["type"], "command_rejected")
            send({"type": "router_thinking", "request_id": "r1", "system": "nas", "model": "qwen3.5:9b", "thinking": "off"})
            answer = until(lambda e: e.get("request_id") == "r1")
            self.assertEqual(answer["type"], "router_status", answer)
            self.assertEqual(answer["change"], "qwen3.5:9b on NAS: thinking off")
            self.assertEqual(answer["status"]["systems"][0]["models"][0]["thinking"], "off")
            saved = json.loads((home / ".dgc" / "config.json").read_text())
            self.assertEqual(saved["subagent_thinking"], "low")
            self.assertEqual(saved["router"]["systems"][0]["models"][0]["thinking"], "off")
            send({"type": "router_thinking", "request_id": "r2", "system": "nas", "model": "qwen3.5:9b", "thinking": "huge"})
            self.assertEqual(until(lambda e: e.get("request_id") == "r2")["type"], "command_rejected")
        finally:
            try:
                send({"type": "shutdown"})
                proc.wait(timeout=20)
            except Exception:                  # noqa: BLE001
                proc.kill()
                proc.wait()
            for stream in (proc.stdin, proc.stdout):
                try:
                    stream.close()
                except OSError:
                    pass


if __name__ == "__main__":
    unittest.main()
