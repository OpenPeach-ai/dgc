"""The Output chip in Work: a choice is a promise.

Picking Slides puts one plain line on that turn's prompt (never the system prompt, whose cached prefix must stay the
same between turns), the artifact tools are offered even in the adaptive profile that otherwise follows the prompt's
wording, and a reply that doesn't make slides is told so under it rather than quietly doing something else.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import sessions
from dgc.agent import Agent
from dgc.artifact_tools import missing_note
from dgc.config import Config
from dgc.llm import ChatResult, ToolCall


class QuietUI:
    def __getattr__(self, name):
        return lambda *args, **kwargs: None


DECK = {"slides": [{"layout": "title", "title": "Q3 review"},
                   {"layout": "bullets", "title": "Results", "bullets": ["Users grew 38%"]}]}


class OutputChipTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-output-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp / "home")

    def tearDown(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def agent(self, **settings):
        cfg = Config()
        cfg.project_root = self.tmp
        cfg.data.update({"model": "fixture", "base_url": "http://fixture", "mode": "default", **settings})
        agent = Agent(cfg, QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        agent.session_file = sessions.new_path(self.tmp)
        return agent

    def run_turn(self, agent, output, replies):
        seen, replies = {}, list(replies)

        def fake_chat(*a, **k):
            if "system" not in seen:
                seen["system"] = agent.messages[0]["content"]
                seen["prompt"] = next(str(m.get("content", "")) for m in reversed(agent.messages)
                                      if m.get("role") == "user")
            return replies.pop(0)
        agent._chat = fake_chat
        agent._turn_output, agent._turn_artifact_types = output, []
        agent.run_turn("Make me a deck about Q3")
        return seen

    def test_the_line_rides_on_the_prompt_and_the_deck_is_made(self):
        agent = self.agent()
        call = ToolCall(id="c1", name="make_artifact", arguments={"type": "slides", "title": "Q3", "data": DECK})
        seen = self.run_turn(agent, "slides", [ChatResult(content="", tool_calls=[call], finish_reason="tool_calls"),
                                               ChatResult(content="Here's your deck.", tool_calls=[])])
        self.assertIn("The user chose Slides for this reply", seen["prompt"])
        self.assertNotIn("The user chose Slides", seen["system"], "never in the cached system prompt")
        self.assertEqual(agent._turn_artifact_types, ["slides"])
        self.assertEqual(missing_note("slides", agent._turn_artifact_types), "")

    def test_a_reply_that_didnt_make_it_is_told_so(self):
        agent = self.agent()
        self.run_turn(agent, "slides", [ChatResult(content="Here are some ideas instead.", tool_calls=[])])
        self.assertIn("didn't make slides", missing_note("slides", agent._turn_artifact_types))

    def test_auto_adds_nothing(self):
        agent = self.agent()
        seen = self.run_turn(agent, "", [ChatResult(content="ok", tool_calls=[])])
        self.assertNotIn("# Output", seen["prompt"])

    def test_the_tools_are_offered_every_turn_and_in_adaptive_only_when_chosen(self):
        standard = self.agent()
        names = {t["function"]["name"] for t in standard._tool_schemas()}
        self.assertTrue({"make_artifact", "edit_artifact"} <= names)
        adaptive = self.agent(tool_profile="adaptive")
        adaptive._turn_output = ""
        adaptive._active_tool_intents = set()
        self.assertNotIn("make_artifact", {t["function"]["name"] for t in adaptive._tool_schemas()})
        adaptive._turn_output = "slides"
        self.assertIn("make_artifact", {t["function"]["name"] for t in adaptive._tool_schemas()})

    def test_typed_output_withholds_the_legacy_page_tool_only_for_that_turn(self):
        for profile in ("standard", "full", "adaptive"):
            agent = self.agent(tool_profile=profile)
            agent._active_tool_intents = {"artifact"}
            for output in ("document", "slides", "spreadsheet", "dashboard"):
                agent._turn_output = output
                names = {t["function"]["name"] for t in agent._tool_schemas()}
                self.assertNotIn("artifact", names, (profile, output))
                self.assertIn("make_artifact", names, (profile, output))
            if profile != "adaptive":
                agent._turn_output = ""
                self.assertIn("artifact", {t["function"]["name"] for t in agent._tool_schemas()})

    def test_follow_up_page_guidance_edits_saved_output_without_new_chip(self):
        agent = self.agent(tool_profile="full", artifact_autostart=True)
        agent._turn_output = ""
        guidance = "\n".join(agent._artifact_guidance())
        self.assertIn("edit_artifact", guidance)
        self.assertIn("even if the Output chip is Auto", guidance)
        self.assertNotIn("call the `artifact` tool", guidance)


if __name__ == "__main__":
    unittest.main()
