"""Pips tools load on demand: off the default request, on after use_pips or a turn about a Pip."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from dgc.agent import Agent, _PIPS_MUTATION_TOOL_NAMES, _PIPS_REFERENCE_FRAME, _PIPS_TOOL_NAMES
from dgc.config import Config, DEFAULTS
from dgc.llm import ChatResult, ToolCall


def offered(agent):
    return {tool["function"]["name"] for tool in agent._tool_schemas()}


class PipsToolLoadingTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-pips-loading-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        config = object.__new__(Config)
        config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                           hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                           thinking="off")
        config._stored_secrets, config._env_secret_keys = {}, set()
        config.credential_warnings = ()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        self.config = config
        self.events = []

        class UI:
            def __getattr__(_self, name):
                return lambda *args, **kwargs: self.events.append((name, args))
        self.agent = Agent(config, UI())
        self.addCleanup(self.agent.mcp.stop_all)

    def test_pips_are_on_by_default_but_only_the_loader_is_offered(self):
        self.assertIs(DEFAULTS["pips_enabled"], True)
        tools = offered(self.agent)
        self.assertIn("use_pips", tools)
        self.assertFalse(tools & _PIPS_TOOL_NAMES)
        self.assertNotIn("pips_setup", self.agent.system_prompt())

    def test_use_pips_offers_the_tools_and_their_guidance_from_the_next_request(self):
        out = self.agent._handle_call(ToolCall(id="c1", name="use_pips", arguments={}))
        self.assertTrue(out.startswith("Loaded the Pips tools"), out)
        for name in ("pips_context", "pips_setup", "run_pip_now", "draft_pip_email"):
            self.assertIn(name, out)
        tools = offered(self.agent)
        self.assertTrue(_PIPS_TOOL_NAMES <= tools)
        self.assertNotIn("use_pips", tools, "a loaded chat is not offered the loader again")
        self.assertIn("pips_setup", self.agent.system_prompt())
        self.assertIn("pips_setup", self.agent.messages[0]["content"], "the live prompt was refreshed")
        again = self.agent._load_pips_tools()
        self.assertTrue(again.startswith("The Pips tools were already loaded"), again)

    def test_loading_needs_no_approval_and_a_deny_rule_still_wins(self):
        with patch.object(self.agent.ui, "approve", side_effect=AssertionError("no approval card"), create=True):
            out = self.agent._handle_call(ToolCall(id="c1", name="use_pips", arguments={}))
        self.assertTrue(out.startswith("Loaded the Pips tools"), out)
        self.agent.reset()
        self.config.permissions = {"allow": [], "ask": [], "deny": ["UsePips"]}
        self.agent.reset()
        out = self.agent._handle_call(ToolCall(id="c2", name="use_pips", arguments={}))
        self.assertFalse(out.startswith("Loaded"), out)
        self.assertFalse(offered(self.agent) & _PIPS_TOOL_NAMES)

    def test_a_new_session_starts_without_the_tools(self):
        self.agent._load_pips_tools()
        self.agent.reset()
        self.assertFalse(offered(self.agent) & _PIPS_TOOL_NAMES)
        self.assertIn("use_pips", offered(self.agent))

    def test_pips_off_offers_neither_the_loader_nor_the_tools(self):
        self.config.data["pips_enabled"] = False
        tools = offered(self.agent)
        self.assertNotIn("use_pips", tools)
        self.assertFalse(tools & _PIPS_TOOL_NAMES)
        self.assertEqual(self.agent._load_pips_tools(), "error: Pips are off in this session")
        self.assertFalse(offered(self.agent) & _PIPS_TOOL_NAMES)

    def test_a_child_agent_loads_only_the_read_tool(self):
        self.agent._load_pips_tools()
        self.agent.depth = 1
        tools = offered(self.agent)
        self.assertIn("pips_context", tools)
        self.assertFalse(tools & _PIPS_MUTATION_TOOL_NAMES)

    def test_a_turn_that_references_a_pip_brings_the_tools(self):
        seen = []

        def answer(messages, tools=None, **kwargs):
            seen.append({tool["function"]["name"] for tool in tools or []})
            return ChatResult(content="Done.", finish_reason="stop")
        with patch.object(self.agent.client, "chat", side_effect=answer):
            self.assertTrue(self.agent.run_turn("Hello there"))
            self.assertTrue(self.agent.run_turn(
                _PIPS_REFERENCE_FRAME + '\n[{"id": "pip_1", "name": "Rook"}]\n</pip-references-json>\n\n'
                "What did Rook find?"))
        self.assertIn("use_pips", seen[0])
        self.assertFalse(seen[0] & _PIPS_TOOL_NAMES, "an ordinary turn does not carry them")
        self.assertTrue(_PIPS_TOOL_NAMES <= seen[-1])


if __name__ == "__main__":
    unittest.main()
