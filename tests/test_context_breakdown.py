"""What fills a context window, part by part, as Claude's Usage sheet shows it (CONTEXT_BREAKDOWN_PLAN.md): the one
shape every surface uses (dgc/context_breakdown.py), and main DGC's sessions (Agent.context_breakdown, the
context_breakdown command). ChatDGC's own is in test_chatdgc_window.py."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_tool_gating import make_agent                    # noqa: E402  (a temporary HOME, as that suite sets it)

from dgc import context_breakdown as breakdown              # noqa: E402
from dgc.editor_protocol import event_error                 # noqa: E402


class Shape(unittest.TestCase):
    def test_biggest_first_with_its_buffer_and_free_space_and_nothing_empty(self):
        got = breakdown.build(1000, [breakdown.category("system_prompt", "System prompt", 100),
                                     breakdown.category("messages", "Messages", 300),
                                     breakdown.category("memory", "Memory", 0),
                                     breakdown.category("tools", "Tools", 50, [("b", 20), ("a", 30), ("zero", 0)])],
                              compact_at=0.75)
        self.assertEqual([c["id"] for c in got["categories"]], ["messages", "system_prompt", "tools"], "an empty part has no row")
        self.assertEqual(got["categories"][2]["items"], [{"name": "a", "tokens": 30}, {"name": "b", "tokens": 20}])
        self.assertEqual((got["used"], got["source"], got["compact_at"], got["buffer"], got["free"]), (450, "estimated", 750, 250, 300))

    def test_scaled_to_the_models_count_or_to_the_meters_and_never_below_zero(self):
        parts = lambda: [breakdown.category("messages", "Messages", 300), breakdown.category("system_prompt", "System", 100)]  # noqa: E731
        reported = breakdown.build(1000, parts(), compact_at=0.75, reported=800)
        self.assertEqual((reported["source"], [c["tokens"] for c in reported["categories"]]), ("reported", [600, 200]))
        self.assertEqual((reported["buffer"], reported["free"]), (200, 0), "past where it compacts: what's left of the buffer, no free space")
        meter = breakdown.build(1000, parts(), compact_at=0.75, total=401)
        self.assertEqual((meter["source"], meter["used"]), ("estimated", 401), "adds up to exactly what the meter shows")
        over = breakdown.build(1000, parts(), compact_at=0.75, reported=1500)
        self.assertEqual((over["buffer"], over["free"]), (0, 0))


class MainDGC(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-breakdown-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / ".dgc").mkdir()
        (self.root / "DGC.md").write_text("Use pnpm, never npm. Tests live in tests/.\n" * 20)

    def test_a_sessions_window_part_by_part_adding_up_to_the_meter(self):
        agent = make_agent(self.root, tool_profile="full")
        agent.messages += [{"role": "user", "content": "Fix the failing test in tests/test_app.py, please." * 10},
                           {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function",
                            "function": {"name": "read_file", "arguments": "{\"path\": \"tests/test_app.py\"}"}}]},
                           {"role": "tool", "tool_call_id": "c1", "content": "def test_app():\n    assert add(2, 2) == 4\n" * 80}]
        got = agent.context_breakdown(32768, 0.85)
        by = {c["id"]: c for c in got["categories"]}
        self.assertEqual(got["used"], agent.estimate_tokens(), "the meter's own number")
        self.assertEqual(sum(c["tokens"] for c in got["categories"]), got["used"])
        self.assertGreater(by["tool_results"]["tokens"], by["messages"]["tokens"], "a file read is its own part, and the bigger")
        self.assertIn("read_file", [i["name"] for i in by["system_tools"]["items"]])
        items = by["system_tools"]["items"]
        self.assertLessEqual(abs(by["system_tools"]["tokens"] - sum(i["tokens"] for i in items)), len(items), "each rounded once")
        self.assertIn("Project memory", [i["name"] for i in by["memory"]["items"]], "DGC.md, named")
        self.assertNotIn("mcp_tools", by)
        self.assertNotIn("deferred", got, "nothing kept back")
        self.assertEqual(got["compact_at"], int(32768 * 0.85))
        self.assertIsNone(event_error({"type": "context_breakdown", "seq": 0, **got}), "valid on the wire")

    def test_mcp_tools_by_server_and_the_ones_kept_back_until_a_search_finds_them(self):
        agent = make_agent(self.root, tool_profile="standard")
        schema = lambda name, words: {"type": "function", "function": {"name": name, "description": "word " * words,  # noqa: E731
                                                                     "parameters": {"type": "object", "properties": {}}}}
        tools = [schema("mcp__docs__read", 40), schema("mcp__docs__export", 400)]

        class Catalog:
            _routes = {"mcp__docs__read": ("Docs", "read"), "mcp__docs__export": ("Docs", "export")}
            servers = {}

            def tool_schemas(self):
                return list(tools)

            def select_tool_schemas(self, query, budget, active=None, *, reserve_chars=0):
                return [tools[0]], True                  # one sent; the other found when needed

        agent.mcp = Catalog()
        got = agent.context_breakdown(32768, 0.85)
        by = {c["id"]: c for c in got["categories"]}
        self.assertEqual([i["name"] for i in by["mcp_tools"]["items"]], ["Docs · read"])
        self.assertEqual([d["id"] for d in got["deferred"]], ["mcp_deferred"])
        self.assertGreater(got["deferred"][0]["tokens"], by["mcp_tools"]["tokens"], "the bigger one waits")
        self.assertEqual(sum(c["tokens"] for c in got["categories"]), agent.estimate_tokens(), "what waits isn't counted")


if __name__ == "__main__":
    unittest.main()
