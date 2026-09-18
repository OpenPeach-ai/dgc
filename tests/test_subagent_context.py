"""A sub-agent's context window is its own setting, exactly as context_size is the main model's."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import headless
from dgc.agent import Agent, _SubUI
from dgc.agents import AgentDef, _parse_agent
from dgc.config import Config, subagent_window_arg, subagent_window_text
from test_subagents import Harness, clone_fixture


class SubagentWindowTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-subagent-window-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def harness(self, **config):
        harness = Harness(self.root, context_size=32_768, **config)
        self.addCleanup(harness.close)
        return harness

    def child(self, harness, adef=None):
        """Run one sub-agent (its turn replaced) and report the window it was given."""
        seen = {}

        def run_child(child, prompt):
            seen["config"] = child.config.get("context_size")
            seen["client"] = child.client.context_size
            seen["model"] = child.client.model
            child.ui.on_text("Looked.")
            child.ui.end_stream()
            return True

        name = ""
        if adef is not None:
            harness.agent._agent_defs = {adef.name: adef}
            name = adef.name
        with patch.object(Config, "clone_for_root", clone_fixture), \
                patch.object(Agent, "run_turn", run_child), \
                patch.object(type(harness.agent), "agent_defs",
                             property(lambda agent: getattr(agent, "_agent_defs", {})), create=True):
            result = harness.agent._execute_prepared_subagent(
                "look", "Look around.", name, None, _SubUI(harness.ui, "look", cancel=harness.agent.cancelled))
        self.assertEqual(result, ("", "Looked.", ""))
        return seen

    def test_unset_a_sub_agent_runs_in_the_main_window(self):
        h = self.harness()
        self.assertEqual(self.child(h), {"config": 32_768, "client": 32_768, "model": "fixture"})

    def test_its_own_window_sizes_the_child_and_leaves_the_main_one_alone(self):
        h = self.harness(subagent_context_size=8_192)
        seen = self.child(h)
        self.assertEqual((seen["config"], seen["client"]), (8_192, 8_192))
        self.assertEqual(h.config.get("context_size"), 32_768, "the main window is untouched")
        self.assertEqual(h.agent.client.context_size, 32_768)

    def test_a_small_value_is_raised_to_the_floor(self):
        h = self.harness(subagent_context_size=100)
        self.assertEqual(self.child(h)["config"], 2_048)

    def test_another_route_gets_the_window_on_the_client_it_builds(self):
        h = self.harness(subagent_context_size=16_384, subagent_model="sub-model",
                         subagent_base_url="http://sub.invalid/v1")
        seen = self.child(h)
        self.assertEqual(seen["model"], "sub-model")
        self.assertEqual((seen["config"], seen["client"]), (16_384, 16_384))

    def test_an_agent_definition_picks_its_own_window(self):
        h = self.harness(subagent_context_size=8_192)
        seen = self.child(h, AgentDef(name="reviewer", description="", body="Review.", context_size="65536"))
        self.assertEqual((seen["config"], seen["client"]), (65_536, 65_536))
        bad = self.child(h, AgentDef(name="reviewer", description="", body="Review.", context_size="lots"))
        self.assertEqual(bad["config"], 8_192, "an unreadable one falls back to the default")

    def test_a_definition_file_carries_context_size(self):
        path = self.root / "reviewer.md"
        path.write_text("---\nname: reviewer\nmodel: qwen3:14b\ncontext_size: 65536\n---\nReview.\n")
        self.assertEqual(_parse_agent(path).context_size, "65536")

    def test_the_command_reads_tokens_sizes_and_zero(self):
        self.assertEqual(subagent_window_arg("65536"), 65_536)
        self.assertEqual(subagent_window_arg("64k"), 65_536)
        self.assertEqual(subagent_window_arg("32,768"), 32_768)
        self.assertEqual(subagent_window_arg("0"), 0)
        for bad in ("100", "-4096", "lots", "", "99999999999"):
            self.assertIsNone(subagent_window_arg(bad), bad)
        h = self.harness()
        self.assertEqual(subagent_window_text(h.config), "(inherit main)")
        h.config.data["subagent_context_size"] = 65_536
        self.assertEqual(subagent_window_text(h.config), "65,536 tokens")

    def test_the_editor_may_set_it_and_zero_means_the_main_window(self):
        for value in (0, 2_048, 131_072):
            values, error = headless._validated_config_values({"subagent_context_size": value}, set())
            self.assertIsNone(error, value)
            self.assertEqual(values, {"subagent_context_size": value})
        for value in (-1, "65536", True, 1.5):
            values, error = headless._validated_config_values({"subagent_context_size": value}, set())
            self.assertIsNotNone(error, value)
        self.assertIn("subagent_context_size", headless._LIVE_SAFE_CONFIG_KEYS,
                      "it shapes the next sub-agent only, so it may change mid-turn")


    def test_the_sub_agent_route_may_change_mid_turn_as_the_main_model_may(self):
        # "subagent_model cannot change while a turn is running" -- the route is read only when a
        # sub-agent starts, so a change applies from the next one, as a new main model does.
        gate = headless.Backend.__new__(headless.Backend)
        gate.config = self.harness(subagent_model="old-sub").config
        form = {"subagent_model": "glm-5.3:cloud", "subagent_base_url": "http://gpu:11434/v1",
                "subagent_api_mode": "ollama", "subagent_context_size": 65_536, "model": "fixture"}
        blocked = sorted(key for key, value in form.items()
                         if key not in headless._LIVE_SAFE_CONFIG_KEYS and not gate._config_unchanged(key, value))
        self.assertEqual(blocked, [])
        self.assertNotIn("model", headless._LIVE_SAFE_CONFIG_KEYS, "the main route still goes through set_model")


    def test_only_an_editor_that_asks_hears_the_sub_agent_window(self):
        # An editor rejects any event field it doesn't know, so 0.26.6 must never see this one.
        from dgc import editor_protocol as ep
        h = self.harness(subagent_context_size=65_536)
        h.backend._emit_config()
        first = [f for f in h.stream.frames() if f["type"] == "config"][-1]
        self.assertNotIn("subagent_context_size", first)
        h.backend._dispatch({"type": "get_config", "fields": ["subagent_context_size", "nonsense"]})
        asked = [f for f in h.stream.frames() if f["type"] == "config"][-1]
        self.assertEqual(asked["subagent_context_size"], 65_536)
        self.assertNotIn("nonsense", asked)
        self.assertIsNone(ep.event_error(asked))
        self.assertIsNone(ep.command_error({"type": "get_config", "fields": ["subagent_context_size"]}))
        h.backend._dispatch({"type": "get_config"})
        again = [f for f in h.stream.frames() if f["type"] == "config"][-1]
        self.assertIn("subagent_context_size", again, "the choice holds for the connection")


if __name__ == "__main__":
    unittest.main()
