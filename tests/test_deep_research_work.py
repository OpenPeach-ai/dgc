"""A Work session's deep_research tool (0.52): the ONE research engine ChatDGC runs (dgc.deep_research), with the
session's own model, the one web search set in Settings and the public-only page reader.

- offered to the agent the user talks to; never a sub-agent (minutes of reading inside a helper) and never a session a
  launching application's policy governs (its SDK can't name the tool, as for make_artifact);
- read-only: nothing in the project changes, so no card;
- a question that carries a saved secret is never searched (leak guard);
- each step shows as the tool's progress; the reply is the report with its sources.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import deep_research, permissions
from dgc.config import Config


class Quiet:
    def __init__(self):
        self.progress = []

    def tool_progress(self, name, message, **kwargs):
        self.progress.append((name, message, kwargs.get("call_id")))

    def __getattr__(self, name):
        return lambda *a, **k: None


class WorkDeepResearch(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-research-work-")))
        patcher = mock.patch.dict(os.environ, {"DGC_HOME": str(self.tmp / "home")})
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("DGC_SESSION_POLICY", None)
        self.root = self.tmp / "proj"
        self.root.mkdir()

    def agent(self, depth=0, **config):
        from dgc.agent import Agent
        cfg = Config(self.root)
        cfg.data.update({"model": "fixture-model", "base_url": "http://fixture", "mode": "default", **config})
        ui = Quiet()
        agent = Agent(cfg, ui, depth=depth) if depth else Agent(cfg, ui)
        self.addCleanup(agent.mcp.stop_all)
        return agent, ui

    def names(self, agent):
        return {s.get("function", {}).get("name") for s in agent._tool_schemas()}

    def test_offered_to_the_session_the_user_talks_to(self):
        agent, _ = self.agent()
        self.assertIn("deep_research", self.names(agent))
        schema = next(s for s in agent._tool_schemas() if s["function"]["name"] == "deep_research")
        self.assertEqual(schema, deep_research.TOOL_SCHEMA, "the one schema every surface offers")

    def test_never_to_a_session_an_application_policy_governs(self):
        agent, _ = self.agent()
        with mock.patch("dgc.permissions.session_policy", return_value=object()):
            self.assertNotIn("deep_research", self.names(agent))

    def test_never_published_as_a_display_tool(self):
        self.assertNotIn("deep_research", permissions.DISPLAY, "an SDK's allow_tools can't name it: never in DISPLAY")
        self.assertIn("deep_research", permissions.READ_ONLY_TOOLS, "nothing in the project changes: no card")

    def test_it_runs_the_shared_engine_with_the_sessions_model_and_shows_progress(self):
        agent, ui = self.agent(context_size=65536)
        seen = {}

        def fake(question, **kwargs):
            seen.update(kwargs, question=question)
            kwargs["progress"]("Searching: home loan rates")
            client = kwargs["client_for"]()
            seen["client"] = (client.model, client.context_size)
            return {"status": "done", "report": "Rates start at 7.5% [1].", "how": "How this was researched: 1 round.",
                    "sources": [{"n": 1, "title": "Rates", "url": "https://bank.example/rates", "snippet": ""}],
                    "plan": {"title": "Rates", "steps": []}, "depth": "quick", "read": 1, "noted": 1}
        with mock.patch("dgc.deep_research.run_report", side_effect=fake):
            out = agent._deep_research_tool({"question": "Home loan rates in Pune"}, "call-1")
        self.assertEqual(seen["question"], "Home loan rates in Pune")
        self.assertEqual(seen["depth"], "quick", "a tool call waits for it: quick unless asked")
        self.assertEqual(seen["client"], ("fixture-model", 65536), "the session's model, in the session's window")
        self.assertIs(seen["cancel"], agent.cancelled, "Stop stops it")
        self.assertIn(("deep_research", "Searching: home loan rates", "call-1"), ui.progress)
        self.assertIn("Rates start at 7.5% [1].", out)
        self.assertIn("https://bank.example/rates", out)

    def test_the_depth_asked_is_passed_on(self):
        agent, _ = self.agent()
        with mock.patch("dgc.deep_research.run_report", return_value={"report": "r", "sources": [], "how": ""}) as run:
            agent._deep_research_tool({"question": "q", "depth": "thorough"}, "c")
        self.assertEqual(run.call_args.kwargs["depth"], "thorough")

    def test_a_question_that_carries_a_saved_secret_is_never_searched(self):
        agent, _ = self.agent()
        with mock.patch("dgc.leak_guard.carries_secret", return_value=True), \
                mock.patch("dgc.deep_research.run_report") as run:
            out = agent._deep_research_tool({"question": "my key sk-live-123"}, "c")
        run.assert_not_called()
        self.assertTrue(out.startswith("error") or "not sent" in out.lower() or "secret" in out.lower(), out)

    def test_each_search_it_writes_goes_through_the_leak_guard_too(self):
        agent, _ = self.agent()
        with mock.patch("dgc.deep_research.run_report", return_value={"report": "r", "sources": [], "how": ""}) as run:
            agent._deep_research_tool({"question": "q"}, "c")
        search = run.call_args.kwargs["search"]
        with mock.patch("dgc.leak_guard.carries_secret", return_value=True), \
                mock.patch("dgc.search.results") as results:
            self.assertEqual(search("a query with a secret"), [])
        results.assert_not_called()

    def test_a_failure_is_said_as_an_error_not_raised(self):
        agent, _ = self.agent()
        with mock.patch("dgc.deep_research.run_report", side_effect=deep_research.ResearchError("Stopped.")):
            out = agent._deep_research_tool({"question": "q"}, "c")
        self.assertTrue(out.startswith("error:"), out)
        self.assertIn("Stopped.", out)


if __name__ == "__main__":
    unittest.main()
