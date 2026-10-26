"""A finished goal's record is dated and short (0.48.3, founder-approved 26 Oct).

Found on .111 (session 20260930-050447-c62af3b6): the system prompt's "# Goal record" quoted the founder's raw
prompt, cut mid-sentence and undated --
  'The session goal is completed: the "Improvements, ranked by impact for staff", i agree with your 8 points, lets
   build these. I am going to sleep now, so do this unnatended, overnight as your'
-- and the model read "overnight" as now, opening a 15:38 answer two days later with "Done overnight".

The record stays (it is what stops a finished goal being restarted after a compaction), but it now names the goal
in a few words, says the day it stopped and how long ago, and keeps the rule. No model is contacted.
"""
from __future__ import annotations

import copy
import os
import re
import tempfile
import time
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from dgc import sessions
from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.goals import goal_name, goal_record
from dgc.llm import ChatResult, LLMClient

# The founder's objective, as the record quoted it (cut where the record cut it), and whole.
FOUNDER_CUT = ('the "Improvements, ranked by impact for staff", i agree with your 8 points, lets build these. '
               'I am going to sleep now, so do this unnatended, overnight as your')
FOUNDER = ('"Improvements, ranked by impact for staff", i agree with your 8 points, lets build these. I am going '
           'to sleep now, so do this unnatended, overnight as your judgement says is best.')
# Words that placed the request in time or were about the person, never the goal.
TIME_WORDS = re.compile(r"tonight|overnight|over night|sleep|unn?att?ended|i'?m going|i am going|as your|"
                        r"right now|today|tomorrow|this morning|in the morning|be back|off to bed", re.I)
VARIANTS = (
    FOUNDER_CUT, FOUNDER,
    "Tonight, fix the flaky tests and ship 0.48. I'm going to sleep.",
    "Work overnight on the parser rewrite, I'll be back in the morning",
    "ok great, now refactor billing.py so totals round once. Don't wait for me, just keep going until it's done",
    "Build the right-align option for tables while I'm asleep",
    "Port the CLI to Rust today—I’m off to bed, do it unattended",
)
DAY = 86_400
RULE = "Don't restart it unless the user asks."
OLD_RULE = "Do not resume work on it unless the user reactivates or replaces it."


def fixture_config(root: Path, **data) -> Config:
    config = object.__new__(Config)
    config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                       hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False)
    config.data.update(data)
    config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
    config.credential_warnings = ()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


class QuietUI:
    def __getattr__(self, name):
        return lambda *args, **kwargs: None


def record_of(prompt: str) -> str:
    """The "# Goal record" section of a system prompt: its heading's next line."""
    lines = prompt.splitlines()
    if "# Goal record" not in lines:
        return ""
    return lines[lines.index("# Goal record") + 1]


def day_label(at: float) -> str:
    day = datetime.fromtimestamp(at)
    month = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")[day.month - 1]
    return f"{day.day} {month}" + ("" if day.year == datetime.now().year else f" {day.year}")


class AgentCase(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.TemporaryDirectory(prefix="dgc-goal-record-home-")
        self.root = tempfile.TemporaryDirectory(prefix="dgc-goal-record-root-")
        self.addCleanup(self.root.cleanup)
        self.addCleanup(self.home.cleanup)
        env = patch.dict(os.environ, {"HOME": self.home.name})
        env.start()
        self.addCleanup(env.stop)

    def agent(self, **data) -> Agent:
        class _Client(LLMClient):
            def compact_responses(self, *args, **kwargs):
                return None
        with patch.object(Agent, "_new_client",
                          lambda self, *a, **k: _Client("http://localhost.invalid/v1", "", "fixture")):
            agent = Agent(fixture_config(Path(self.root.name), **data), QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        agent.session_file = sessions.new_path(Path(self.root.name))
        return agent

    def finished(self, agent: Agent, objective: str, *, days_ago: float = 2, status: str = "completed") -> float:
        """A goal set, then finished `days_ago` days ago, as its transition history records it."""
        self.assertTrue(agent.set_goal(objective))
        self.assertTrue(agent.update_goal(status, reason="All eight are built and tested.",
                                          evidence=["tests pass"]))
        at = time.time() - days_ago * DAY
        agent._goal_details["history"][-1]["at"] = at
        agent._refresh_system()
        return at


class TheRecordIsDatedTests(AgentCase):
    def test_the_record_carries_the_day_the_goal_finished_and_its_age(self) -> None:
        agent = self.agent()
        at = self.finished(agent, FOUNDER_CUT, days_ago=2)
        record = record_of(agent.system_prompt())
        self.assertTrue(record.startswith(f"A goal finished on {day_label(at)} (2 days ago): \""), record)
        self.assertTrue(record.endswith(RULE), record)

    def test_the_age_reads_today_yesterday_and_in_days(self) -> None:
        now = datetime(2026, 10, 26, 15, 38)
        def at(**delta):
            return {"history": [{"status": "completed", "at": (now - timedelta(**delta)).timestamp(), "reason": ""}]}
        self.assertIn("on 26 Oct (today)", goal_record("ship it", "completed", at(hours=3), now))
        self.assertIn("on 25 Oct (yesterday)", goal_record("ship it", "completed", at(days=1), now))
        self.assertIn("on 24 Oct (2 days ago)", goal_record("ship it", "completed", at(days=2), now))
        self.assertIn("on 24 Oct 2025 (367 days ago)", goal_record("ship it", "completed", at(days=367), now))
        # The day, never the hour: the same line all day, so the cached prompt prefix survives.
        self.assertEqual(goal_record("ship it", "completed", at(days=1), now),
                         goal_record("ship it", "completed", at(days=1), now.replace(hour=23, minute=59)))

    def test_the_founders_example_reads_as_agreed(self) -> None:
        details = {"history": [{"status": "completed", "at": datetime(2026, 10, 24, 6, 10).timestamp(), "reason": ""}]}
        self.assertEqual(
            goal_record(FOUNDER, "completed", details, datetime(2026, 10, 26, 15, 38)),
            "A goal finished on 24 Oct (2 days ago): \"'Improvements, ranked by impact for staff', "
            "lets build these\". Don't restart it unless the user asks.")

    def test_a_blocked_or_paused_goal_is_dated_the_same_way(self) -> None:
        for status, lead, rule in (("blocked", "A goal stopped, blocked, on", RULE),
                                   ("paused", "A goal was paused on", "Don't resume it unless the user asks.")):
            with self.subTest(status=status):
                agent = self.agent()
                at = self.finished(agent, FOUNDER_CUT, days_ago=1, status=status)
                record = record_of(agent.system_prompt())
                self.assertTrue(record.startswith(f"{lead} {day_label(at)} (yesterday): \""), record)
                self.assertTrue(record.endswith(rule), record)
                self.assertIsNone(TIME_WORDS.search(record), record)

    def test_a_reopened_session_keeps_the_day_it_finished(self) -> None:
        agent = self.agent()
        at = self.finished(agent, FOUNDER_CUT, days_ago=3)
        agent.messages.append({"role": "user", "content": "x"})
        self.assertTrue(agent._persist())
        reopened = self.agent()
        reopened.load_session(agent.session_file)
        self.assertEqual(reopened.goal_status, "completed")
        record = record_of(reopened.system_prompt())
        self.assertTrue(record.startswith(f"A goal finished on {day_label(at)} (3 days ago): "), record)

    def test_a_record_with_no_recorded_day_says_so_and_keeps_the_rule(self) -> None:
        record = goal_record(FOUNDER_CUT, "completed", {"history": []})
        self.assertTrue(record.startswith("A goal finished earlier (DGC didn't record when): \""), record)
        self.assertTrue(record.endswith(RULE), record)
        self.assertIsNone(TIME_WORDS.search(record), record)


class TheRecordIsShortTests(AgentCase):
    def test_none_of_the_original_time_words_survive(self) -> None:
        agent = self.agent()
        self.finished(agent, FOUNDER_CUT)
        prompt = agent.system_prompt()
        record = record_of(prompt)
        self.assertIn("Improvements, ranked by impact for staff", record)
        self.assertIsNone(TIME_WORDS.search(record), record)
        # Nowhere else in the prompt either: the record was the only copy of the objective in it.
        for words in ("overnight", "unnatended", "going to sleep", "I am going to sleep"):
            self.assertNotIn(words, prompt)

    def test_the_name_drops_the_conversation_around_the_goal(self) -> None:
        expected = {
            FOUNDER_CUT: "the 'Improvements, ranked by impact for staff', lets build these",
            "Tonight, fix the flaky tests and ship 0.48. I'm going to sleep.": "fix the flaky tests and ship 0.48",
            "Work overnight on the parser rewrite, I'll be back in the morning": "Work on the parser rewrite",
            VARIANTS[4]: "refactor billing.py so totals round once",
            "Build the right-align option for tables while I'm asleep": "Build the right-align option for tables",
            VARIANTS[6]: "Port the CLI to Rust",
        }
        for objective, name in expected.items():
            with self.subTest(objective=objective[:40]):
                self.assertEqual(goal_name(objective), name)
        for objective in VARIANTS:
            with self.subTest(objective=objective[:40]):
                record = goal_record(objective, "completed", {"history": [{"status": "completed",
                                                                           "at": time.time() - 2 * DAY, "reason": ""}]})
                self.assertIsNone(TIME_WORDS.search(record), record)

    def test_a_word_that_names_the_work_is_kept(self) -> None:
        # "overnight" and "unattended" can be what the work is, not when it was asked for.
        self.assertEqual(goal_name("add an overnight backup job for the NAS"), "add an overnight backup job for the NAS")
        self.assertEqual(goal_name("run the unattended install script and fix whatever fails"),
                         "run the unattended install script and fix whatever fails")
        self.assertEqual(goal_name("ship the release"), "ship the release")

    def test_two_words_of_time_together_both_go(self) -> None:
        # The founder's 0.48 release goal: "unattended" was kept as if it named the work ("unattended overnight"),
        # so "do this all unattended" survived and the cut ended the name on a dangling "do…".
        objective = ("build and push the 0.48.0 version live, on the website, on extension marketplace and on github, "
                     "do this all unattended overnight")
        self.assertEqual(goal_name(objective), "build and push the 0.48.0 version live, on the website, "
                                               "on extension marketplace and on github")
        self.assertEqual(goal_name("fix the parser overnight unattended"), "fix the parser")

    def test_a_long_objective_is_cut_at_a_word(self) -> None:
        name = goal_name("Rewrite " + "the billing module carefully " * 20)
        self.assertLessEqual(len(name), 100)
        self.assertTrue(name.endswith("carefully…") or name.endswith("module…")
                        or name.endswith("the…") or name.endswith("billing…"), name)

    def test_a_goal_that_was_only_conversation_keeps_the_rule_without_a_name(self) -> None:
        record = goal_record("Do this overnight, I'm off to bed", "completed",
                             {"history": [{"status": "completed", "at": time.time() - 2 * DAY, "reason": ""}]})
        self.assertNotIn('"', record)
        self.assertTrue(record.endswith(". " + RULE), record)
        self.assertIsNone(TIME_WORDS.search(record), record)


class TheRuleHoldsAfterCompactionTests(AgentCase):
    def test_after_a_compaction_the_next_request_still_carries_the_dated_rule(self) -> None:
        agent = self.agent(compact_threshold=0.0, context_size=65_536)
        at = self.finished(agent, FOUNDER_CUT, days_ago=2)
        for n in range(30):
            agent.messages += [{"role": "user", "content": f"question {n}: " + "detail " * 60},
                               {"role": "assistant", "content": f"answer {n}: " + "words " * 60}]
        self.assertTrue(agent._persist())
        before = len(agent.messages)
        # An expired deadline: the mechanical path, no provider call (as a resumed session compacts).
        self.assertTrue(agent.maybe_compact(force=True, deadline=time.monotonic(), notify=False))
        self.assertLess(len(agent.messages), before, "the conversation was compacted")
        self.assertEqual(agent.goal_status, "completed")
        sent = []
        def chat(messages, *args, **kwargs):
            sent.append(copy.deepcopy(messages))
            return ChatResult(content="Here is where things stand.")
        agent._aux_client = lambda *a, **k: types.SimpleNamespace(
            chat=lambda *a, **k: ChatResult(content="Status"))
        with patch.object(agent.client, "chat", side_effect=chat):
            self.assertTrue(agent.run_turn("where are we?"))
        self.assertTrue(sent, "the turn reached the model")
        system = sent[0][0]
        self.assertEqual(system["role"], "system")
        record = record_of(system["content"])
        self.assertTrue(record.startswith(f"A goal finished on {day_label(at)} (2 days ago): "), record)
        self.assertTrue(record.endswith(RULE), record)
        self.assertNotIn("# Standing goal", system["content"])
        self.assertEqual(agent.goal_status, "completed", "a question after compaction did not restart the goal")
        self.assertFalse(any("Standing goal for this session" in str(m.get("content")) for m in sent[0]))


class AnActiveGoalIsUnaffectedTests(AgentCase):
    def test_a_standing_goal_is_stated_in_full_and_has_no_record(self) -> None:
        # A guard rather than a change: the standing goal is the person's words, every one of them.
        agent = self.agent()
        self.assertTrue(agent.set_goal(FOUNDER))
        prompt = agent.system_prompt()
        self.assertIn("# Standing goal", prompt)
        self.assertIn(FOUNDER, prompt)
        self.assertNotIn("# Goal record", prompt)
        self.assertNotIn(OLD_RULE, prompt)


if __name__ == "__main__":
    unittest.main()
