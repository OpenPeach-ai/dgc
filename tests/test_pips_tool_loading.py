"""Pips tools load on demand: off the default request, on after use_pips or a turn about a Pip."""
import copy
import os
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


    def test_deny_use_pips_also_keeps_a_turn_about_a_pip_without_the_tools(self):
        self.config.permissions = {"allow": [], "ask": [], "deny": ["UsePips"]}
        seen = []

        def answer(messages, tools=None, **kwargs):
            seen.append({tool["function"]["name"] for tool in tools or []})
            return ChatResult(content="Done.", finish_reason="stop")
        with patch.object(self.agent.client, "chat", side_effect=answer):
            self.assertTrue(self.agent.run_turn(
                _PIPS_REFERENCE_FRAME + '\n[{"id": "pip_1", "name": "Rook"}]\n</pip-references-json>\n\nWhat did Rook find?'))
        self.assertFalse(seen[-1] & _PIPS_TOOL_NAMES)

    def private_profile(self):
        from dgc import sessions
        from dgc.workspace_registry import state_directory
        home = Path(tempfile.mkdtemp(prefix="dgc-pips-profile-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(home, ignore_errors=True))
        env = patch.dict(os.environ, {"DGC_HOME": str(home)})
        env.start()
        self.addCleanup(env.stop)
        files = patch.object(sessions, "SESSIONS_DIR", home / "sessions")
        files.start()
        self.addCleanup(files.stop)
        self.agent.session_file = sessions.new_path(self.config.project_root)
        self.agent.session_root = self.config.project_root
        return state_directory() / "registry.sqlite3"

    def test_ordinary_turns_leave_no_pips_state_behind(self):
        from dgc.session_turn_events import foreground_turn
        registry = self.private_profile()
        with patch.object(self.agent.client, "chat", return_value=ChatResult(content="Done.", finish_reason="stop")), \
                foreground_turn("foreground_prompt"):
            self.assertTrue(self.agent.run_turn("Rename the helper"))
        self.assertFalse(registry.exists(), "a profile that never used Pips gets no Pips registry")
        self.assertFalse([event for event in self.events if "Pips" in str(event)], self.events)

    def test_the_first_use_of_pips_binds_the_chat_to_its_workspace(self):
        registry = self.private_profile()
        self.agent._load_pips_tools()
        self.assertTrue(registry.exists())
        self.assertTrue(self.agent.workspace_identity, "the Pips tools can act for this chat")


if __name__ == "__main__":
    unittest.main()


class PipsRepeatHintTests(PipsToolLoadingTests):
    """A chat that begins with familiar work carries one line offering a Pip; plan mode does not."""

    def test_the_repeat_line_is_in_the_real_system_prompt_only_when_pips_can_be_offered(self):
        with patch("dgc.pip_repeat.hint", return_value="- REPEAT_HINT_LINE"):
            self.agent._check_pips_repeat("Summarise the overnight sales numbers and email the team")
        self.assertIn("REPEAT_HINT_LINE", self.agent.system_prompt())
        self.config.data["mode"] = "plan"
        self.assertNotIn("REPEAT_HINT_LINE", self.agent.system_prompt())
        self.config.data["mode"] = "default"
        self.config.data["pips_enabled"] = False
        self.assertNotIn("REPEAT_HINT_LINE", self.agent.system_prompt(), "Pips off: nothing to offer")

    def test_the_loader_tells_the_model_when_to_offer_a_pip_and_what_pips_cannot_do(self):
        loader = next(t for t in self.agent._tool_schemas() if t["function"]["name"] == "use_pips")
        text = loader["function"]["description"]
        self.assertIn("offer once to make it a Pip", text)
        self.assertIn("no Pip buys, sells, trades or pays", text)
        self.assertIn("refuses changes from your shell", text)
