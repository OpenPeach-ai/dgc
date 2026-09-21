"""DGC tells the model what day it is, where it is, and what time it is.

The split under test: the date and the timezone sit in the system prompt, which must stay
byte-identical between two turns a minute apart so a cached prefix survives; the hour and minute
ride with each user prompt, where nothing was cacheable. No model is contacted.
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from dgc import agent as agent_mod
from dgc import clock
from dgc.agent import Agent
from dgc.llm import ChatResult
from dgc.workflows import display_prompt
from test_monitors import FrontendUI, make_config, scripted   # HOME is already redirected there


def frozen(*args) -> type:
    """A drop-in for ``dgc.agent.datetime`` whose ``now()`` the test moves by hand."""

    class Clock(datetime):
        current = datetime(*args)

        @classmethod
        def now(cls, tz=None):
            return cls.current

    return Clock


def clock_lines(agent) -> list[str]:
    """Every clock line DGC put in this transcript, in order."""
    found = []
    for message in agent.messages:
        content = message.get("content")
        parts = content if isinstance(content, list) else [{"type": "text", "text": content}]
        for part in parts:
            text = part.get("text") if isinstance(part, dict) else None
            if isinstance(text, str):
                for piece in text.split(clock.CLOCK_OPEN)[1:]:
                    found.append(clock.CLOCK_OPEN + piece.split(clock.CLOCK_CLOSE)[0]
                                 + clock.CLOCK_CLOSE)
    return found


class ZoneTests(unittest.TestCase):
    """Reading the machine's zone: name when it records one, offset when it does not, never a raise."""

    def test_the_named_zone_reaches_both_lines(self):
        with mock.patch.object(clock, "_iana_zone", lambda: "Asia/Kolkata"):
            now = datetime(2026, 9, 20, 14, 32, tzinfo=timezone(timedelta(hours=5, minutes=30)))
            self.assertEqual(clock.environment_date(now), "2026-09-20 (Asia/Kolkata, UTC+05:30)")
            self.assertEqual(clock.turn_clock_line(now),
                             "<dgc-now>Local time: 14:32 (Asia/Kolkata)</dgc-now>")

    def test_the_tz_variable_names_the_zone_when_it_holds_a_name(self):
        for value, expected in (("Asia/Kolkata", "Asia/Kolkata"), (":Europe/Paris", "Europe/Paris"),
                                ("UTC", "UTC"), ("America/Argentina/Salta",
                                                 "America/Argentina/Salta")):
            with mock.patch.dict("os.environ", {"TZ": value}, clear=False):
                self.assertEqual(clock._iana_from_env(), expected, value)

    def test_a_posix_rule_or_an_abbreviation_is_not_a_name(self):
        for value in ("IST-5:30", "EST5EDT", "", "   ", "/etc/localtime", "Asia/"):
            with mock.patch.dict("os.environ", {"TZ": value}, clear=False), \
                    mock.patch.object(clock, "_iana_from_localtime", lambda: ""):
                now = datetime(2026, 9, 20, 14, 32, tzinfo=timezone(timedelta(hours=-8)))
                self.assertEqual(clock.environment_date(now), "2026-09-20 (UTC-08:00)", value)
                self.assertEqual(clock.turn_clock_line(now),
                                 "<dgc-now>Local time: 14:32 (UTC-08:00)</dgc-now>", value)

    def test_no_zone_information_at_all_still_says_something_true(self):
        with mock.patch.object(clock, "_iana_zone", lambda: ""):
            now = datetime(2026, 9, 20, 14, 32, tzinfo=timezone.utc)
            self.assertEqual(clock.environment_date(now), "2026-09-20 (UTC)")
            self.assertEqual(clock.turn_clock_line(now),
                             "<dgc-now>Local time: 14:32 (UTC)</dgc-now>")

    def test_a_zone_lookup_that_explodes_is_not_the_turn_s_problem(self):
        def boom():
            raise OSError("no /etc here")

        with mock.patch.object(clock, "_iana_from_env", boom), \
                mock.patch.object(clock, "_iana_from_localtime", boom):
            line = clock.turn_clock_line(datetime(2026, 9, 20, 14, 32, tzinfo=timezone.utc))
        self.assertEqual(line, "<dgc-now>Local time: 14:32 (UTC)</dgc-now>")

    def test_a_symlink_into_the_zone_database_names_the_zone(self):
        for target, expected in (("/usr/share/zoneinfo/Europe/Paris", "Europe/Paris"),
                                 ("/usr/share/zoneinfo/posix/America/New_York", "America/New_York"),
                                 ("/usr/share/zoneinfo/America/Argentina/Salta",
                                  "America/Argentina/Salta"),
                                 ("/etc/localtime", "")):
            with mock.patch("os.path.realpath", lambda _p, t=target: t):
                self.assertEqual(clock._iana_from_localtime(), expected, target)


class AttachTests(unittest.TestCase):
    """The clock line goes on, comes off for humans, and never stacks."""

    def setUp(self):
        # A fixed zone, so every expectation below is the same string on any machine.
        patch = mock.patch.object(clock, "_iana_zone", lambda: "Asia/Kolkata")
        patch.start()
        self.addCleanup(patch.stop)
        self.now = datetime(2026, 9, 20, 14, 32, tzinfo=timezone(timedelta(hours=5, minutes=30)))

    def test_it_is_appended_and_stripped_again(self):
        attached = clock.attach_turn_clock("fix the failing test", self.now)
        self.assertEqual(
            attached,
            "fix the failing test\n\n<dgc-now>Local time: 14:32 (Asia/Kolkata)</dgc-now>")
        self.assertEqual(clock.strip_turn_clock(attached), "fix the failing test")
        self.assertEqual(display_prompt(attached), "fix the failing test")

    def test_re_sending_a_recovered_prompt_replaces_the_clock_instead_of_stacking_it(self):
        first = clock.attach_turn_clock("ship it", self.now)
        second = clock.attach_turn_clock(first, self.now.replace(day=21, hour=9, minute=5))
        self.assertEqual(second.count(clock.CLOCK_OPEN), 1)
        self.assertEqual(second, "ship it\n\n<dgc-now>Local time: 09:05 (Asia/Kolkata)</dgc-now>")

    def test_what_the_user_typed_is_left_alone(self):
        typed = "explain <dgc-now>Local time: 01:00 (UTC)</dgc-now> in the middle, then stop"
        self.assertEqual(clock.strip_turn_clock(typed), typed)
        self.assertEqual(clock.strip_turn_clock("no clock here"), "no clock here")
        self.assertEqual(clock.attach_turn_clock("", self.now),
                         "<dgc-now>Local time: 14:32 (Asia/Kolkata)</dgc-now>")

    def test_the_resume_list_previews_the_prompt_not_the_clock(self):
        import json
        from dgc import sessions
        directory = tempfile.TemporaryDirectory(prefix="dgc-clock-listing-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        store = sessions.project_dir(root)
        store.mkdir(parents=True, exist_ok=True)
        (store / "s1.json").write_text(json.dumps({
            "project": str(root), "updated": 1.0,
            "messages": [{"role": "user",
                          "content": clock.attach_turn_clock("fix the bug", self.now)}]}))
        self.addCleanup(lambda: (store / "s1.json").unlink(missing_ok=True))
        preview = sessions.listing(root)[0][2]
        self.assertEqual(preview, "fix the bug")

    def test_a_steered_or_workflow_prompt_still_renders_as_it_was_typed(self):
        from dgc.workflows import STEERING_PREFIX, STEERING_SUFFIX
        steered = STEERING_PREFIX + "also run the linter" + STEERING_SUFFIX
        self.assertEqual(display_prompt(steered), "also run the linter")
        workflow = ("<dgc-workflow-json>\n"
                    + '{"name":"plan","request":"add a flag"}'
                    + "\n</dgc-workflow-json>\n\nPlan the following task.")
        self.assertEqual(display_prompt(clock.attach_turn_clock(workflow, self.now)),
                         "/plan add a flag")


class TurnTests(unittest.TestCase):
    """Real turns: where the clock lands, how often, and what the system prompt does meanwhile."""

    def agent(self, **settings):
        directory = tempfile.TemporaryDirectory(prefix="dgc-clock-agent-")
        self.addCleanup(directory.cleanup)
        agent = Agent(make_config(Path(directory.name), mode="auto", **settings), FrontendUI())
        self.addCleanup(agent.mcp.stop_all)
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        return agent

    def at(self, *args):
        """Freeze DGC's clock; the agent reads it for both the date line and the turn's clock."""
        fake = frozen(*args)
        patch = mock.patch.object(agent_mod, "datetime", fake)
        patch.start()
        self.addCleanup(patch.stop)
        return fake

    @staticmethod
    def expect(*args) -> str:
        """The clock line DGC must produce at that wall-clock moment, on this machine's zone."""
        return clock.turn_clock_line(datetime(*args))

    def test_the_system_prompt_carries_the_zone_and_never_the_hour(self):
        agent = self.agent()
        fake = self.at(2026, 9, 20, 14, 32)
        prompt = agent.system_prompt()
        line = next(row for row in prompt.splitlines() if row.startswith("- Date: "))
        self.assertTrue(line.startswith("- Date: 2026-09-20 ("), line)
        self.assertTrue(line.endswith(")"), line)
        self.assertNotIn("14:32", prompt)
        self.assertNotIn(clock.CLOCK_OPEN, prompt)
        self.assertIn(clock.zone_label(fake.current), line)

    def test_two_turns_a_minute_apart_leave_the_system_prompt_byte_identical(self):
        agent = self.agent()
        fake = self.at(2026, 9, 20, 14, 32)
        calls = scripted(agent, [ChatResult(content="one"), ChatResult(content="two")])
        self.assertTrue(agent.run_turn("first"))
        first_prompt = agent.messages[0]["content"]
        fake.current = datetime(2026, 9, 20, 14, 33)
        self.assertTrue(agent.run_turn("second"))
        self.assertEqual(agent.messages[0]["content"], first_prompt,
                         "a cached prefix must survive the minute changing")
        self.assertEqual(len(calls), 2)
        self.assertEqual(clock_lines(agent), [self.expect(2026, 9, 20, 14, 32),
                                              self.expect(2026, 9, 20, 14, 33)])

    def test_one_clock_line_per_turn_not_per_model_round(self):
        agent = self.agent()
        self.at(2026, 9, 20, 9, 7)
        from dgc.llm import ToolCall
        steps = [ChatResult(content="", tool_calls=[ToolCall("c1", "bash", {"command": "echo hi"})],
                            finish_reason="tool_calls"),
                 ChatResult(content="", tool_calls=[ToolCall("c2", "bash", {"command": "echo ho"})],
                            finish_reason="tool_calls"),
                 ChatResult(content="done")]
        calls = scripted(agent, steps)
        self.assertTrue(agent.run_turn("run the two commands"))
        self.assertGreaterEqual(len(calls), 3, "several model rounds in one turn")
        self.assertEqual(clock_lines(agent), [self.expect(2026, 9, 20, 9, 7)])
        prompts = [m for m in agent.messages if m.get("role") == "user"
                   and clock.CLOCK_OPEN in str(m.get("content", ""))]
        self.assertEqual(len(prompts), 1)
        self.assertTrue(str(prompts[0]["content"]).startswith("run the two commands\n\n"))
        self.assertFalse(any(clock.CLOCK_OPEN in str(m.get("content", ""))
                             for m in agent.messages if m.get("role") == "tool"),
                         "never inside a tool-results message")

    def test_a_session_that_crosses_midnight_updates_the_date_and_the_clock(self):
        agent = self.agent()
        fake = self.at(2026, 9, 20, 23, 59)
        scripted(agent, [ChatResult(content="still today"), ChatResult(content="new day")])
        self.assertTrue(agent.run_turn("before midnight"))
        self.assertIn("- Date: 2026-09-20 (", agent.messages[0]["content"])
        fake.current = datetime(2026, 9, 21, 0, 1)
        self.assertTrue(agent.run_turn("after midnight"))
        self.assertIn("- Date: 2026-09-21 (", agent.messages[0]["content"])
        self.assertNotIn("- Date: 2026-09-20 (", agent.messages[0]["content"])
        self.assertEqual([line.split("Local time: ")[1].split(" ")[0] for line in clock_lines(agent)],
                         ["23:59", "00:01"])

    def test_a_prompt_with_images_keeps_its_clock_in_the_text_part(self):
        agent = self.agent()
        self.at(2026, 9, 20, 16, 45)
        agent._pending_images = ["data:image/png;base64,AAAA"]
        scripted(agent, [ChatResult(content="looked")])
        self.assertTrue(agent.run_turn("what is in this screenshot"))
        prompt = next(m for m in agent.messages
                      if m.get("role") == "user" and isinstance(m.get("content"), list))
        texts = [p["text"] for p in prompt["content"] if p.get("type") == "text"]
        self.assertEqual(len(texts), 1)
        self.assertTrue(texts[0].startswith("what is in this screenshot\n\n"))
        self.assertIn("Local time: 16:45", texts[0])
        self.assertEqual(clock_lines(agent), [self.expect(2026, 9, 20, 16, 45)])

    def test_a_sub_agent_is_told_the_time_too(self):
        """A child reasoning about "today" has the parent's problem, so it gets the same answer."""
        from dgc.agent import _SubUI
        agent = self.agent()
        self.at(2026, 9, 20, 11, 11)
        seen: list[dict] = []

        def record(self_agent, tools, effort, **kwargs):
            if self_agent.depth:
                seen.append({"depth": self_agent.depth,
                             "lines": clock_lines(self_agent),
                             "system": self_agent.messages[0]["content"]})
            self_agent.ui.on_text("It is Sunday.")
            self_agent.ui.end_stream()
            return ChatResult(content="It is Sunday.")

        with mock.patch.object(Agent, "_chat", record):
            failure, summary, start_error = agent._execute_prepared_subagent(
                "look", "What day is it?", "", None,
                _SubUI(agent.ui, "look", cancel=agent.cancelled))
        self.assertEqual((failure, start_error), ("", ""), summary)
        self.assertEqual(summary, "It is Sunday.")
        self.assertTrue(seen, "the child never reached the model")
        self.assertEqual(seen[0]["depth"], 1)
        self.assertEqual(seen[0]["lines"], [self.expect(2026, 9, 20, 11, 11)])
        self.assertIn("- Date: 2026-09-20 (", seen[0]["system"])
        self.assertNotIn(clock.CLOCK_OPEN, seen[0]["system"])

    def test_a_restored_transcript_shows_the_prompt_without_the_clock(self):
        """Resume is a display of what happened; DGC's clock line was never something anyone typed."""
        from dgc.sessions import display_rows
        agent = self.agent()
        self.at(2026, 9, 20, 7, 30)
        scripted(agent, [ChatResult(content="morning")])
        self.assertTrue(agent.run_turn("what is on today"))
        rows = display_rows([m for m in agent.messages if m.get("role") != "system"])
        self.assertEqual([row["body"] for row in rows if row["who"] == "user"], ["what is on today"])
        self.assertFalse(any(clock.CLOCK_OPEN in row["body"] for row in rows), rows)

    def test_a_monitor_wake_turn_gets_no_second_clock(self):
        agent = self.agent()
        self.at(2026, 9, 20, 18, 20)
        scripted(agent, [ChatResult(content="noted"), ChatResult(content="seen")])
        self.assertTrue(agent.run_turn("keep an eye on the build"))
        self.assertEqual(len(clock_lines(agent)), 1)
        hub = agent.monitors
        hub.queue_background_exit("bg1", "make build", 0, 2.0, "built ok", hub.epoch)
        self.assertTrue(agent.run_monitor_turn(hub.take_pending()))
        self.assertEqual(clock_lines(agent), [self.expect(2026, 9, 20, 18, 20)],
                         "a wake notice already stamps its own events with the time")


if __name__ == "__main__":
    unittest.main()
