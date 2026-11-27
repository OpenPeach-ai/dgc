"""A wake-up the chat set itself is DGC's turn, also after the chat is opened again (27 Nov).

Live, a wake-up's turn is drawn as "Woke up as planned · <why>". Its turn text (what the model is told when it wakes) is
saved as the turn's user-role message, and a chat opened again drew that text as a prompt the person sent: an overnight
goal's wake-up came back in the morning as a "you" bubble holding the model's own plan. Now every reader of a saved
chat knows that text is DGC's: the editor's replay draws it as it was drawn live, the terminal draws its marker, the
transcript rows and compaction's "the user's own words" leave it out, and the summary labels it as DGC's. A person's
own message that merely starts the same way stays theirs.
"""
from __future__ import annotations

import time
from datetime import datetime
from unittest.mock import patch

from dgc import editor_protocol as ep, sessions, tools, wakeups
from dgc.agent import _real_user_turns, summariser_role
from dgc.clock import turn_clock_line
from dgc.headless import outline_prompts
from dgc.llm import ChatResult
from tests.test_agent_reports import BackendCase

WHY = "Cross-check the October totals when the office PCs are on"
PLAN = ("Office-hours step for the standing reports goal: the office PCs should be back on. Pull October's sales "
        "from the live books and compare them with the mirror's totals; if they match, close the issue, else log it.")


def saved_wake_up(why=WHY, *, hours_ago=7, late_hours=0.0):
    """The user-role message a wake-up's turn saved, as a real session holds it: turn_text plus the turn's clock."""
    at = time.time() - late_hours * 3600
    due = {"id": "w1", "at": at, "why": why, "prompt": PLAN, "created_at": at - hours_ago * 3600}
    text = wakeups.turn_text(due, now=at + late_hours * 3600)
    return {"role": "user", "content": text + "\n\n" + turn_clock_line(datetime.now()), "_dgc_at": at}


class Clock:
    def __init__(self):
        self.now = time.time()

    def __call__(self):
        return self.now


class WakeUpReplay(BackendCase):
    def setUp(self):
        super().setUp()
        self.backend.ui.wakeups_supported = True
        self.clock = Clock()
        self.agent.wakeups.clock = self.clock
        self.agent.wakeups.on_change = self.backend._on_wakeups
        self.addCleanup(self.backend._cancel_wakeup_timer)

    def starts(self, items):
        return [(i["kind"], i["prompt"]) for i in items if i.get("type") == "turn_start"]

    def test_a_reopened_chat_draws_a_wake_up_as_it_was_drawn_live(self):
        tools.execute("wake_later", {"minutes": 30, "why": "Check the tests", "prompt": "Run the suite and say what failed."},
                      self.agent.ctx)
        self.clock.now += 30 * 60
        with patch.object(self.agent.client, "chat", side_effect=lambda *a, **k: ChatResult(content="All 12 pass.")):
            self.backend._wakeup_due()
            self.ends(1)
            self.join()
        live = next(e for e in self.events if e["type"] == "turn_start")
        self.assertEqual((live["kind"], live["prompt"]), ("monitor", "wake-up: Check the tests"))
        items = self.backend._history()
        for item in items:
            if item.get("type"):
                self.assertIsNone(ep.event_error({"seq": 0, **item}), item)
        self.assertEqual(self.starts(items), [("monitor", "wake-up: Check the tests")],
                         "drawn as it was live, never as a prompt the person sent")
        self.assertFalse(any("This is the wake-up you set" in str(i.get("prompt") or i.get("text") or "") for i in items))
        self.assertEqual(outline_prompts(self.backend._history(bounded=False)), [], "not in the list of the person's prompts")
        self.assertEqual([r["body"] for r in sessions.display_rows(self.agent.messages) if r["who"] == "user"], [])

    def test_an_overnight_goal_s_wake_up_comes_back_as_dgc_s_in_the_morning(self):
        # The shape of the real one: set 7 hours earlier, the plan quoted as data, the turn's clock line at the end.
        woke = saved_wake_up()
        self.agent.messages += [{"role": "user", "content": "Keep the monthly reports current."},
                                {"role": "assistant", "content": "Set a wake-up for office hours."},
                                woke, {"role": "assistant", "content": "The October totals match."}]
        self.assertTrue(woke["content"].startswith("This is the wake-up you set 7 hours ago ("))
        items = self.backend._history()
        self.assertEqual(self.starts(items), [("prompt", "Keep the monthly reports current."),
                                              ("monitor", f"wake-up: {WHY}")])
        self.assertFalse(any(PLAN[:40] in str(i.get("prompt") or "") for i in items))
        self.assertEqual([m["content"] for m in _real_user_turns(self.agent.messages)],
                         ["Keep the monthly reports current."], "compaction never re-installs it as the person's words")
        self.assertEqual(summariser_role(woke), "dgc-generated (not the user)")
        rows = sessions.display_rows(self.agent.messages)
        self.assertEqual([r["body"] for r in rows if r["who"] == "user"], ["Keep the monthly reports current."])

    def test_the_terminal_draws_its_marker_not_a_typed_band(self):
        from dgc.tui import TUI
        self.agent.messages += [saved_wake_up(), {"role": "assistant", "content": "Done."}]
        tui = object.__new__(TUI)
        rows = [row for chunk, _ in tui._message_rows(self.agent.messages) for row in chunk]
        self.assertEqual([r for r in rows if r["who"] == "user"], [])
        [mark] = [r for r in rows if r["who"] == "monitor"]
        self.assertEqual(mark["body"], f"Woke up as planned · {WHY}")
        self.assertTrue(mark["planned"])

    def test_a_wake_up_that_fell_due_while_dgc_was_closed_is_dgc_s_too(self):
        woke = saved_wake_up(hours_ago=9, late_hours=3)
        self.assertIn("while DGC was closed", woke["content"])
        self.assertEqual(wakeups.turn_why(woke["content"]), WHY)

    def test_a_why_with_its_own_full_stop_and_brackets_keeps_them(self):
        why = "Check the build (again) after the deploy."
        self.assertEqual(wakeups.turn_why(saved_wake_up(why)["content"]), why)

    def test_a_person_s_message_that_starts_the_same_way_stays_theirs(self):
        typed = "This is the wake-up you set for me yesterday: did it run?"
        self.assertIsNone(wakeups.turn_why(typed))
        half = "This is the wake-up you set 3 hours ago (09:00): check the logs.\nI turned it off, did it still fire?"
        self.assertIsNone(wakeups.turn_why(half), "without DGC's quoted-plan line it is the person's own message")
        self.agent.messages += [{"role": "user", "content": typed}, {"role": "assistant", "content": "It did."}]
        self.assertEqual(self.starts(self.backend._history()), [("prompt", typed)])
        self.assertIsNone(wakeups.turn_why(None))
        self.assertIsNone(wakeups.turn_why([{"type": "text", "text": typed}]))


if __name__ == "__main__":
    import unittest
    unittest.main()
