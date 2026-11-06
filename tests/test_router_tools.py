"""DGC Router's tools for the main model: router_status, router_probe, router_update (always an Allow card with the
exact diff, never a key) and router_find (asks first). Offered every turn, Router on or off."""
from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from router_fakes import FakeServer  # noqa: E402
from test_subagents import Harness  # noqa: E402

from dgc import router as R  # noqa: E402
from dgc import router_probe, router_state, router_tools as T  # noqa: E402
from dgc.llm import ToolCall  # noqa: E402
from dgc.tools import TOOL_SCHEMAS  # noqa: E402
from dgc.ui import edit_preview  # noqa: E402

NAMES = {"router_status", "router_probe", "router_update", "router_find"}


class ToolsCase(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-router-tools-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DGC_SESSION_POLICY", None)
        self.router = R.Router()
        for item in (patch.object(R, "ROUTER", self.router),
                     patch.object(R.Router, "ensure_health", lambda self, config: None)):
            item.start()
            self.addCleanup(item.stop)

    def harness(self, block=None, **data):
        directory = tempfile.TemporaryDirectory(prefix="dgc-router-tools-project-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name), **data)
        self.addCleanup(harness.close)
        if block is not None:
            harness.config.data["router"] = block
        return harness

    def names(self, agent):
        return {tool["function"]["name"] for tool in agent._tool_schemas()}


class Offered(ToolsCase):
    def test_every_turn_router_on_or_off_whatever_the_prompt_says(self):
        harness = self.harness()
        agent = harness.agent
        self.assertTrue(NAMES <= self.names(agent), "offered with the Router never set up")
        agent._activate_tool_intents("fix the typo in README", replace=True)
        self.assertTrue(NAMES <= self.names(agent), "the wording of a prompt never takes them away")
        harness.config.data["router"] = {"enabled": True, "systems": []}
        self.assertTrue(NAMES <= self.names(agent))

    def test_not_to_a_sub_agent_a_policy_session_or_a_wake_turn_change(self):
        agent = self.harness().agent
        agent.depth = 1
        self.assertFalse(NAMES & self.names(agent))
        agent.depth = 0
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": json.dumps({"version": 1})}):
            self.assertFalse(NAMES & self.names(agent), "an SDK policy can't name them; it has session.router")
        agent._monitor_turn = True
        self.assertEqual(NAMES & self.names(agent), {"router_status", "router_probe"})

    def test_ready_tools_and_the_static_catalog_stay_as_they_were(self):
        self.assertFalse(NAMES & {tool["function"]["name"] for tool in TOOL_SCHEMAS},
                         "an installed SDK with allow_tools would refuse a runtime that lists them in ready.tools")


class Status(ToolsCase):
    def test_off_and_empty_says_what_to_do(self):
        agent = self.harness().agent
        text = T.run(agent, "router_status", {})
        self.assertIn("DGC Router is off and has no systems", text)

    def test_systems_models_workers_and_health(self):
        block = {"enabled": True, "systems": [
            {"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434", "server": "ollama", "workers": 2,
             "models": [{"name": "qwen3.5:9b", "workers": 2, "context": 16384, "note": "search"}]},
            {"id": "mac", "name": "Mac", "base_url": "http://mac.local:11434", "server": "ollama",
             "jobs": ["pips"], "models": [{"name": "qwen3.6:35b-a3b-mlx", "context": 32768}]}]}
        agent = self.harness(block).agent
        router_state.save_discovery("nas", {"models": [{"name": "qwen3.5:9b", "params_b": 9.7, "quant": "Q4_K_M",
                                                        "tools": True}]})
        router_state.save_probe("nas", "qwen3.5:9b", {"speed": {"ok": True, "tokens_per_s": 47.5, "ttft_ms": 700},
                                                       "parallel": {"ok": True, "runs": 2}})
        for _ in range(R.OFFLINE_AFTER):
            self.router.record_health("mac", False, 0, "connection refused")
        held, _ = self.router.acquire(agent.config, "subagents", wait=False)
        text = T.run(agent, "router_status", {})
        self.assertIn("1 of 2 workers free", text)
        self.assertIn("qwen3.5:9b: 9.7B · Q4_K_M · context 16K · 1/2 free · tools ✓ · 47.5 tok/s · runs 2 at once"
                      " · note: search", text)
        self.assertIn('mac "Mac"', text)
        self.assertIn("OFFLINE", text)
        self.assertIn("busy: qwen3.5:9b", text)
        self.router.release(held)

    def test_speed_is_in_tokens_never_words(self):
        """A model server counts tokens, not words: every speed DGC Router says is tok/s and "first token"."""
        probed = T.probe_text({"system": "nas", "results": {"qwen3.5:9b": {
            "speed": {"ok": True, "tokens_per_s": 82.0, "ttft_ms": 340}, "parallel": {"ok": True, "runs": 2}}}})
        self.assertIn("82 tok/s, first token in 340 ms", probed)
        status = {"enabled": True, "when_busy": "wait", "workers": {"total": 2, "free": 2, "busy": 0}, "systems": [
            {"id": "gpu", "name": "GPU", "server": "llamacpp", "base_url": "http://gpu-box.local:8080", "enabled": True,
             "jobs": ["subagents"], "workers": 2, "busy": 0, "free": 2, "one_model_at_a_time": False,
             "health": {"state": "online", "latency_ms": 3}, "has_key": False, "leases": [],
             "server_load": {"running": 1, "tokens_per_s": 42.5},
             "models": [{"name": "qwen3:8b", "workers": 2, "busy": 0, "free": 2, "context": 32768,
                         "tokens_per_s": 61.0}]}]}
        text = T.status_text(status)
        self.assertIn("42.5 tok/s", text)
        self.assertIn("61 tok/s", text)
        described = json.dumps([tool["function"]["description"] for tool in T.SCHEMAS])
        for said in (probed, text, described):
            self.assertNotRegex(said, r"\bwords?/s\b|first word|words a second")
        self.assertIn("time to first token, tokens a second", described)


class Update(ToolsCase):
    def test_untrusted_discovery_hints_cannot_break_model_suggestions(self):
        found = {"models": [{"name": "good", "loaded": True, "loaded_context": "NaN",
                             "context_max": "Infinity", "params_b": "NaN"},
                            {"name": "small", "loaded": True, "loaded_context": -1,
                             "context_max": 1024, "params_b": "Infinity"},
                            {"name": ["invalid"], "loaded": True}]}
        self.assertEqual(T.model_choices(found), ["good", "small"])
        suggested = T.suggest_models(found)
        self.assertEqual([row["context"] for row in suggested], [T.ROUTER_DEFAULT_CONTEXT, 2048])
        self.assertTrue(all("params_b" not in row for row in suggested))
        self.assertEqual(T._ago(float("inf")), "")
        with self.assertRaises(T.UpdateError):
            T.context_tokens("9" * 300)

    def test_every_action_plans_a_valid_change_with_its_diff(self):
        harness = self.harness({"enabled": False, "systems": [
            {"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434", "server": "ollama",
             "models": [{"name": "qwen3.5:9b", "context": 16384}]}]})
        config = harness.config
        steps = [({"action": "turn_on"}, lambda b: b["enabled"] is True),
                 ({"action": "set_when_busy", "when_busy": "default"}, lambda b: b["when_busy"] == "default"),
                 ({"action": "set_jobs", "system": "NAS", "jobs": ["pips"]}, lambda b: b["systems"][0]["jobs"] == ["pips"]),
                 ({"action": "disable_system", "system": "nas"}, lambda b: b["systems"][0]["enabled"] is False),
                 ({"action": "enable_system", "system": "nas"}, lambda b: b["systems"][0]["enabled"] is True),
                 ({"action": "set_model", "system": "nas", "model": "qwen3.5:9b", "workers": 2, "note": "search"},
                  lambda b: b["systems"][0]["models"][0]["workers"] == 2
                  and b["systems"][0]["models"][0]["note"] == "search"),
                 ({"action": "set_model", "system": "nas", "model": "qwen3:4b", "context": 8192},
                  lambda b: b["systems"][0]["models"][1] == {"name": "qwen3:4b", "workers": 1, "context": 8192}),
                 ({"action": "edit_system", "system": "nas", "name": "Basement NAS", "workers": 3,
                   "one_model_at_a_time": True},
                  lambda b: (b["systems"][0]["name"], b["systems"][0]["workers"]) == ("Basement NAS", 3)),
                 ({"action": "remove_system", "system": "nas"}, lambda b: b["systems"] == [])]
        for args, check in steps:
            with self.subTest(action=args["action"]):
                plan = T.plan_update(config, args)
                self.assertTrue(check(plan.after), plan.after)
                self.assertTrue(plan.diff.startswith("--- a/~/.dgc/config.json"), plan.diff)
                self.assertIn(plan.summary, plan.card()["change"])
                T.apply_plan(config, plan)
                self.assertEqual(config.data["router"], plan.after)

    def test_it_never_reads_or_writes_a_key(self):
        config = self.harness().config
        for args in ({"action": "add_system", "base_url": "nas.local", "api_key": "sk-1"},
                     {"action": "edit_system", "system": "nas", "key": "sk-2"},
                     {"action": "turn_on", "token": "x"}):
            with self.subTest(args=args), self.assertRaises(T.UpdateError) as raised:
                T.plan_update(config, args)
            self.assertIn("never reads or sets a key", str(raised.exception))
        self.assertNotIn("key", json.dumps(T.SCHEMAS[2]["function"]["parameters"]["properties"]).lower()
                         .replace("keyword", ""))

    def test_add_system_detects_the_server_and_keeps_its_loaded_context(self):
        config = self.harness().config
        with FakeServer("ollama") as fake:
            plan = T.plan_update(config, {"action": "add_system", "name": "GPU box", "base_url": fake.url})
        system = plan.after["systems"][0]
        self.assertEqual((system["id"], system["server"], system["base_url"]), ("gpu-box", "ollama", fake.url))
        models = {m["name"]: m for m in system["models"]}
        self.assertEqual(set(models), {"qwen3:8b"},
                         "the model it has loaded (QA 2026-11-02): never one it would load, a cloud or embedding one")
        self.assertEqual(models["qwen3:8b"]["context"], 16384, "the context it is loaded with: no reload")
        T.apply_plan(config, plan)
        self.assertEqual(router_state.discovery("gpu-box")["models"][0]["name"], "qwen3:8b")

    def test_a_server_that_wants_a_key_is_added_and_the_user_pastes_it(self):
        config = self.harness().config
        with FakeServer("openai", key="sk-secret-1") as fake:
            plan = T.plan_update(config, {"action": "add_system", "system": "cloud", "base_url": fake.url})
        self.assertEqual(plan.needs_key, "cloud")
        self.assertTrue(any("paste it in Settings" in note for note in plan.notes))
        self.assertNotIn("sk-secret-1", json.dumps(plan.after))

    def test_an_unreachable_address_is_refused_before_any_card(self):
        harness = self.harness()
        out = harness.agent._handle_call(ToolCall("u1", "router_update", {"action": "add_system",
                                                                          "base_url": "http://127.0.0.1:9"}))
        self.assertTrue(out.startswith("error: no model server answered"), out)
        self.assertFalse([f for f in harness.stream.frames() if f["type"] == "permission_request"])

    def test_the_card_shows_the_exact_diff_in_auto_mode_and_nothing_changes_until_allowed(self):
        harness = self.harness({"enabled": False, "systems": []})
        self.assertEqual(harness.config.get("mode"), "auto")
        harness.answer("permission_request", {"decision": "no"})
        out = harness.agent._handle_call(ToolCall("u1", "router_update", {"action": "turn_on"}))
        self.assertIn("DENIED", out)
        self.assertFalse(harness.config.data["router"]["enabled"])
        card = [f for f in harness.stream.frames() if f["type"] == "permission_request"][-1]
        self.assertIn('-    "enabled": false,', card["diff"])
        self.assertIn('+    "enabled": true,', card["diff"])
        self.assertEqual(card["args"]["change"], "Turn DGC Router on")

    def test_allowed_it_applies_that_plan_and_always_still_asks_next_time(self):
        harness = self.harness({"enabled": False, "systems": []})
        harness.answer("permission_request", {"decision": "always"})
        out = harness.agent._handle_call(ToolCall("u1", "router_update", {"action": "turn_on"}))
        self.assertTrue(out.startswith("Done: Turn DGC Router on."), out)
        self.assertTrue(harness.config.data["router"]["enabled"])
        self.assertEqual(harness.config.permissions["allow"], [], "no rule was saved")
        harness.agent._handle_call(ToolCall("u2", "router_update", {"action": "turn_off"}))
        asks = [f for f in harness.stream.frames() if f["type"] == "permission_request"]
        self.assertEqual(len(asks), 2, "the second change asked again")

    def test_edit_preview_is_the_diff(self):
        self.assertEqual(edit_preview("router_update", {"diff": "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n"}, "/"),
                         "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y")


class ProbeAndFind(ToolsCase):
    def test_probe_tests_a_system_and_saves_the_results(self):
        with FakeServer("ollama") as fake:
            agent = self.harness({"enabled": False, "systems": [
                {"id": "gpu", "name": "GPU box", "base_url": fake.url, "server": "ollama",
                 "models": [{"name": "qwen3:8b", "context": 16384}]}]}).agent
            text = T.run(agent, "router_probe", {"system": "gpu"})
            sent = [r["json"] for r in fake.chats()]
        self.assertIn("Tested gpu:", text)
        self.assertIn("it serves 4 models", text)
        self.assertIn("tool calls ✓", text)
        self.assertIn("runs", text)
        self.assertTrue(all(body["options"]["num_ctx"] == 16384 for body in sent), "always its fixed context")
        saved = router_state.probes("gpu")["qwen3:8b"]
        self.assertEqual(set(saved), {"speed", "parallel", "tools"})
        self.assertEqual(self.router.leases(), [], "the probe gave its worker back")

    def test_find_asks_first_and_a_no_means_no_scan(self):
        harness = self.harness()
        harness.answer("permission_request", {"decision": "no"})
        with patch.object(router_probe, "find", side_effect=AssertionError("scanned without asking")):
            out = harness.agent._handle_call(ToolCall("f1", "router_find", {}))
        self.assertIn("DENIED", out)

    def test_find_lists_what_answered(self):
        agent = self.harness().agent
        fake_result = {"network": "10.9.8.0/24", "ports": [11434], "took_ms": 5,
                       "found": [{"base_url": "http://10.9.8.7:11434", "server": "ollama", "version": "0.32.13"}]}
        with patch.object(router_probe, "find", return_value=fake_result):
            text = T.run(agent, "router_find", {})
        self.assertIn("http://10.9.8.7:11434: ollama 0.32.13", text)


if __name__ == "__main__":
    unittest.main()
