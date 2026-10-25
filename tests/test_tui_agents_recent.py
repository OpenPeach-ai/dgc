"""`/agents` in the terminal shows what matters now, as the editor's agent map does (25 Oct): every agent
working, every agent the chat's latest turn that started any started, and any older one whose changes were
held back -- each with its parents -- then one "Earlier · N agents" line; `/agents all` lists every one.
A turn runs from one prompt to the next, by the time the chat saved on each prompt (``_dgc_at``); a chat
that cannot tell keeps the full list."""
from __future__ import annotations

import io
import re
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import glyphs, subagents
from dgc.subagents import SubagentRegistry
from tests.test_subagents import bare_tui, fixture_config, plain, sid

HELD = ("Sub-task '{}' completed but its changes were NOT integrated: conflict. Conflicts: gst.py. The isolated "
        "worktree is preserved at /w/.dgc/worktrees/x on branch dgc/x.\nSummary:\nMigrated.")
PARTLY = ("Sub-task '{}' partly integrated. Applied 1 path(s): a.py. Held back because you changed the same lines: b.py."
          " That work is preserved at /w/x on branch dgc/x; resolve it from /tasks.\nSummary:\nHalf.")


def prompt(at: float, text: str = "go") -> dict:
    return {"role": "user", "content": text, "_dgc_at": at}


def result(call_id: str, text: str) -> dict:
    return {"role": "tool", "tool_call_id": call_id, "content": text}


def item(n: int, at, state: str = "finished", parent: int | None = None, description: str | None = None) -> dict:
    return {"id": sid(n), "parent_id": sid(parent) if parent else None, "description": description or f"agent {n}",
            "state": state, "started_at": at}


class RecentIdsTests(unittest.TestCase):
    def test_the_latest_turn_that_started_any(self):
        messages = [prompt(100.5), prompt(200.5), prompt(300.5)]
        items = [item(1, 101.2), item(2, 102), item(3, 201.7), item(4, 202), item(5, 301.1)]
        self.assertEqual(subagents.recent_ids(items, messages), {sid(5)})
        # A follow-up that started none leaves the map as it was.
        self.assertEqual(subagents.recent_ids(items[:4], messages), {sid(3), sid(4)})
        # A restored record keeps its start to the second: one that began in the second its prompt was sent is that turn's.
        self.assertEqual(subagents.recent_ids([item(1, 101), item(2, 300)], messages), {sid(2)})

    def test_working_ones_and_their_parents_are_shown(self):
        messages = [prompt(100), prompt(200)]
        items = [item(1, 101), item(2, 102, parent=1), item(3, 103, state="running", parent=2), item(4, 104, parent=1),
                 item(5, 201)]
        self.assertEqual(subagents.recent_ids(items, messages), {sid(1), sid(2), sid(3), sid(5)})

    def test_held_back_work_keeps_an_older_agent_shown(self):
        messages = [prompt(100), result("c1", HELD.format("Migrate the GST tables")), result("c2", PARTLY.format("Port the rates")),
                    result("c3", "Sub-task 'Map the old tables' completed with no file changes.\nSummary:\nok"), prompt(200)]
        items = [item(1, 101, description="Migrate the GST tables"), item(2, 102, description="Port the rates"),
                 item(3, 103, description="Map the old tables"), item(4, 201)]
        self.assertEqual(subagents.recent_ids(items, messages), {sid(1), sid(2), sid(4)})
        # Only that turn's result counts: the same description started again later and integrated is not held back.
        later = [*messages, prompt(300)]
        self.assertEqual(subagents.recent_ids([item(1, 201, description="Migrate the GST tables"), item(9, 301)], later), {sid(9)})

    def test_a_chat_that_cannot_tell_keeps_the_full_list(self):
        items = [item(1, 101), item(2, 201)]
        self.assertIsNone(subagents.recent_ids(items, []), "no prompt kept its time")
        self.assertIsNone(subagents.recent_ids(items, [{"role": "user", "content": "go"}]))
        self.assertIsNone(subagents.recent_ids([item(1, None), item(2, None)], [prompt(100)]), "no agent kept its start")


def registry(starts) -> SubagentRegistry:
    reg = SubagentRegistry()
    for n, at, state, kwargs in starts:
        with patch("dgc.subagents.time.time", return_value=at):
            reg.start(id=sid(n), description=f"agent {n}", **kwargs)
        if state != "running":
            reg.end(sid(n), state, tool_calls=1)
    return reg


class TerminalListingTests(unittest.TestCase):
    def setUp(self):
        reg = registry([(1, 101, "finished", {}), (2, 102, "finished", {}), (3, 201, "finished", {}),
                        (4, 202, "finished", {}), (5, 301, "running", {})])
        self.agent = SimpleNamespace(subagents=reg, agent_defs={},
                                     messages=[prompt(100), prompt(200), prompt(300)])

    def tui(self):
        tui = bare_tui()
        tui.agent = self.agent
        tui.config = fixture_config(Path(tempfile.gettempdir()))
        return tui

    def test_recent_first_then_one_earlier_line(self):
        lines = plain(self.tui()._agents_listing()).splitlines()
        self.assertEqual(lines[0], "agents in this chat · 5 agents · 1 working · 4 finished")
        self.assertEqual(len(lines), 3, lines)
        self.assertIn(f"{glyphs.AGENT_RUN} agent 5", lines[1])
        self.assertEqual(lines[2], f"  {glyphs.ELLIPSIS_V} Earlier · 4 agents · /agents all lists them")

    def test_agents_all_lists_every_one(self):
        lines = plain(self.tui()._agents_listing(everything=True)).splitlines()
        self.assertEqual(len(lines), 6, lines)
        self.assertFalse(any("Earlier" in line for line in lines))
        # Typed, mid-turn too.
        tui = self.tui()
        appended, flashed = [], []
        tui._append, tui._flash = appended.append, flashed.append
        tui._turn.set()
        tui._sessions = []
        tui._tls = threading.local()
        self.assertTrue(tui._handle_running_local_command("/agents all"))
        shown = re.sub(r"\x1b\[[0-9;]*m", "", appended[0])
        for n in range(1, 6):
            self.assertIn(f"agent {n}", shown)
        self.assertNotIn("Earlier ·", shown)
        appended.clear()
        self.assertTrue(tui._handle_running_local_command("/agents"))
        shown = re.sub(r"\x1b\[[0-9;]*m", "", appended[0])
        self.assertNotIn("agent 1", shown)
        self.assertIn("Earlier · 4 agents · /agents all lists them", shown)

    def test_a_chat_without_prompt_times_keeps_the_full_list(self):
        self.agent.messages = [{"role": "user", "content": "go"}]
        lines = plain(self.tui()._agents_listing()).splitlines()
        self.assertEqual(len(lines), 6, lines)
        self.assertFalse(any("Earlier" in line for line in lines))

    def test_the_classic_terminal_does_the_same(self):
        from dgc import cli
        from rich.console import Console
        repl = object.__new__(cli.CLI)
        buf = io.StringIO()
        repl.console = Console(file=buf, force_terminal=False, width=120)
        repl.config = fixture_config(Path(tempfile.gettempdir()))
        repl.agent = self.agent
        repl.ui = SimpleNamespace(info=lambda *a, **k: None)
        repl.handle_slash("/agents")
        out = buf.getvalue()
        self.assertIn("agent 5", out)
        self.assertNotIn("agent 1 ", out)
        self.assertIn(f"{glyphs.ELLIPSIS_V} Earlier · 4 agents · /agents all lists them", out)
        buf.truncate(0); buf.seek(0)
        repl.handle_slash("/agents all")
        out = buf.getvalue()
        for n in range(1, 6):
            self.assertIn(f"agent {n}", out)
        self.assertNotIn("Earlier ·", out)


if __name__ == "__main__":
    unittest.main()
