"""`/context` in the full-screen terminal lists every part of the window (as the editor's breakdown does): each part
with its tokens and share, its three biggest items, the room kept for compaction and what's free, all in one column,
and scrolls under the meter instead of running off a short terminal."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import context_breakdown as breakdown
from dgc import style as style_mod
from dgc.tui import TUI


def sample(window: int, compact_at: float) -> dict:
    tools = [("task", 657), ("make_artifact", 550), ("browser", 349), ("read_file", 120)]
    return breakdown.build(window, [
        breakdown.category("messages", "Messages", 900),
        breakdown.category("system_tools", "Tools", sum(n for _, n in tools), tools),
        breakdown.category("mcp_tools", "MCP tools", 400, [("github · create_pull_request_with_a_long_name", 400)]),
        breakdown.category("memory", "Memory", 0),
    ], compact_at=compact_at, deferred=[breakdown.category("mcp_deferred", "MCP tools found when needed", 2100)])


class Screen:
    def __init__(self, threshold=None, fails=False):
        self.tui = object.__new__(TUI)
        self.calls = []
        config = {"compact_threshold": threshold} if threshold is not None else {}
        self.tui.config = SimpleNamespace(get=lambda key, default=None: config.get(key, default), model="m")

        def counted(window, compact_at):
            self.calls.append((window, compact_at))
            if fails:
                raise RuntimeError("no client")
            return sample(window, compact_at)
        self.tui.agent = SimpleNamespace(context_breakdown=counted, estimate_tokens=lambda: 2876, messages=[],
                                         client=None)
        self.overlays = []
        self.tui._open_overlay = lambda rows, **kw: self.overlays.append((rows, kw))
        self.tui._context_window_size = lambda: 10_000
        self.tui._tool_count = 0
        self.tui._invalidate = lambda *a, **k: None

    def lines(self):
        return [ln.plain for ln in self.tui._context_parts_lines(10_000, style_mod.theme())]


class TuiContextBreakdown(unittest.TestCase):
    def test_every_part_with_its_share_and_three_biggest_items_in_one_column(self):
        screen = Screen()
        lines = screen.lines()
        self.assertEqual(screen.calls, [(10_000, 0.85)])
        tools = next(ln for ln in lines if "Tools" in ln and "MCP" not in ln)
        self.assertIn("1.7K", tools)
        self.assertIn("16.8%", tools)
        self.assertEqual([ln.split()[0] for ln in lines[lines.index(tools) + 1:lines.index(tools) + 4]],
                         ["task", "make_artifact", "browser"])
        self.assertFalse(any("read_file" in ln for ln in lines), "only the three biggest items")
        self.assertFalse(any("Memory" in ln for ln in lines), "an empty part isn't listed")
        long_name = next(ln for ln in lines if "github" in ln)
        self.assertIn("…", long_name)
        kept = next(ln for ln in lines if "Kept for compaction" in ln)
        free = next(ln for ln in lines if ln.lstrip("◇ ").startswith("Free"))
        self.assertIn("1.5K", kept)                    # past 85% of 10K
        # Every number ends in the same column.
        ends = {ln.index(num) + len(num) for ln, num in ((tools, "1.7K"), (kept, "1.5K"), (lines[lines.index(tools) + 1], "657"))}
        self.assertEqual(len(ends), 1, lines)
        self.assertTrue(free)
        self.assertTrue(any("2.1K" in ln and "search" in ln for ln in lines), "the deferred MCP tools are said")
        self.assertTrue(lines[-1].startswith("Estimated"))

    def test_the_configured_compaction_point_is_used(self):
        screen = Screen(threshold=0.6)
        screen.lines()
        self.assertEqual(screen.calls, [(10_000, 0.6)])
        bad = Screen(threshold="nonsense")
        bad.lines()
        self.assertEqual(bad.calls, [(10_000, 0.85)])

    def test_a_breakdown_that_cannot_be_counted_says_so_and_the_meter_stands(self):
        lines = Screen(fails=True).lines()
        self.assertEqual(len(lines), 1)
        self.assertIn("isn't available", lines[0])

    def test_the_popup_scrolls_the_parts_under_the_meter(self):
        screen = Screen()
        screen.tui._open_context_popup()
        rows, kw = screen.overlays[-1]
        self.assertTrue(kw["reader"])
        self.assertIn("scroll", kw["footer"])
        self.assertTrue(any("2.9K / 10K" in h.plain for h in kw["header"]))
        self.assertTrue(any("Tools" in r["label"] for r in rows))
        self.assertTrue(rows[-1]["label"].startswith("Turns 0"))


if __name__ == "__main__":
    unittest.main()
