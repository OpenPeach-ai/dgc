"""`message_task` carries the parent MODEL's words, and they were delivered as the user's.

`message_task` -> `message_detached` -> `child.steer` -> `_drain_steer`, which wrapped every queued
item in `STEERING_PREFIX`: "The user sent this WHILE you were working." It also stamped
`_dgc_steering`, which frontends replay as user bubbles. So the parent model's note was both told to
the child as a human instruction and persisted in the transcript as one.

A child that changes course because "the user" said so, when the user said nothing, is acting on a
fabricated instruction -- and the transcript then corroborates the fabrication to anyone reading it
back, including a later compaction asking what the user wanted.
"""
from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc.workflows import (AGENT_MESSAGE_PREFIX, AGENT_MESSAGE_SUFFIX,   # noqa: E402
                           STEERING_PREFIX, STEERING_SUFFIX)


class _UI:
    def __init__(self):
        self.lines: list[str] = []

    def info(self, text):
        self.lines.append(str(text))


class Fake:
    """The parts of Agent that `steer`/`_drain_steer` touch, and nothing else."""

    def __init__(self):
        from dgc.agent import Agent
        self.messages: list[dict] = []
        self.steer_queue: list[dict] = []
        self._steer_lock = threading.RLock()
        self._accepting_steer = True
        self.cancelled = threading.Event()
        self._mcp_query_text = ""
        self.ui = _UI()
        self.steer = Agent.steer.__get__(self)
        self._drain_steer = Agent._drain_steer.__get__(self)

    _safe_text = staticmethod(lambda text: str(text))
    _activate_tool_intents = _activate_skill_intents = staticmethod(lambda text: None)
    _refresh_system = staticmethod(lambda: None)


class AParentAgentMessageIsNotTheUserTest(unittest.TestCase):
    def drain(self, *sends) -> list[dict]:
        agent = Fake()
        for text, origin in sends:
            self.assertTrue(agent.steer(text, origin=origin), f"steer rejected {text!r}")
        agent._drain_steer()
        return agent.messages

    def test_a_parent_agent_message_does_not_claim_the_user_sent_it(self) -> None:
        [message] = self.drain(("check the migration too", "agent"))
        text = message["content"]
        self.assertNotIn("The user sent this", text,
                         "this is the model writing; saying the user did is the defect")
        self.assertIn(AGENT_MESSAGE_PREFIX, text)
        self.assertIn(AGENT_MESSAGE_SUFFIX, text)
        self.assertIn("It is NOT from the user", text)
        self.assertIn("check the migration too", text)

    def test_it_is_not_rendered_as_a_user_bubble(self) -> None:
        [message] = self.drain(("check the migration too", "agent"))
        self.assertNotIn("_dgc_steering", message,
                         "_dgc_steering is what frontends replay as the human's own bubbles")
        self.assertEqual(message["_dgc_agent_message"], ["check the migration too"])

    def test_the_user_envelope_is_unchanged(self) -> None:
        [message] = self.drain(("actually use postgres", "user"))
        self.assertIn(STEERING_PREFIX, message["content"])
        self.assertIn(STEERING_SUFFIX, message["content"])
        self.assertEqual(message["_dgc_steering"], ["actually use postgres"])

    def test_both_senders_at_once_stay_separate(self) -> None:
        messages = self.drain(("actually use postgres", "user"),
                              ("check the migration too", "agent"))
        self.assertEqual(len(messages), 2, "joining them would re-attribute one to the other")
        user, agent = messages
        self.assertIn(STEERING_PREFIX, user["content"])
        self.assertNotIn("check the migration too", user["content"])
        self.assertIn(AGENT_MESSAGE_PREFIX, agent["content"])
        self.assertNotIn("actually use postgres", agent["content"])

    def test_an_unknown_origin_is_treated_as_the_user(self) -> None:
        """Fail toward the conservative envelope, never toward impersonating the human."""
        [message] = self.drain(("something", "wat"))
        self.assertIn(STEERING_PREFIX, message["content"])


class NothingElseReadsItAsTheUserTest(unittest.TestCase):
    def test_compaction_labels_it_as_not_the_user(self) -> None:
        from dgc.agent import summariser_role
        label = summariser_role({"role": "user", "content": "x", "_dgc_agent_message": ["x"]})
        self.assertIn("not the user", label)

    def test_it_is_not_quoted_as_one_of_the_users_own_turns(self) -> None:
        from dgc.agent import _real_user_turns
        self.assertEqual(_real_user_turns(
            [{"role": "user", "content": "x", "_dgc_agent_message": ["x"]}]), [])

    def test_message_detached_really_reaches_steer_with_the_agent_origin(self) -> None:
        """Behavioural, not a source grep: the first version of this test was satisfied by the
        COMMENT above the call, so reverting the call itself still passed."""
        from dgc.agent import Agent

        seen = {}

        class Child:
            _accepting_steer = True

            def steer(self, text, *, images=None, request_id="", origin="user"):
                seen["text"], seen["origin"] = text, origin
                return True

        class Parent:
            _safe_text = staticmethod(str)

            def _detached_handle(self, agent_id):
                return {"agent": Child()}

            def _knows_finished(self, agent_id):
                return False

        parent = Parent()
        delivered, reason = Agent.message_detached(parent, "sub-1", "check the migration too")
        self.assertTrue(delivered, reason)
        self.assertEqual(seen["origin"], "agent",
                         "message_task is the parent MODEL writing to its child, not the user")
        self.assertEqual(seen["text"], "check the migration too")

    def test_a_child_whose_steer_predates_the_origin_parameter_still_receives_it(self) -> None:
        from dgc.agent import Agent

        seen = {}

        class OldChild:
            _accepting_steer = True

            def steer(self, text, *, images=None, request_id=""):
                seen["text"] = text
                return True

        class Parent:
            _safe_text = staticmethod(str)

            def _detached_handle(self, agent_id):
                return {"agent": OldChild()}

            def _knows_finished(self, agent_id):
                return False

        delivered, reason = Agent.message_detached(Parent(), "sub-1", "hello")
        self.assertTrue(delivered, reason)
        self.assertEqual(seen["text"], "hello",
                         "an embedder's Agent without the parameter must not lose the message")


if __name__ == "__main__":
    unittest.main()


class TheTerminalLineNamesTheSenderTest(unittest.TestCase):
    def test_an_agent_message_is_not_announced_as_steering(self) -> None:
        agent = Fake()
        agent.steer("check the migration too", origin="agent")
        agent._drain_steer()
        self.assertTrue(agent.ui.lines, "the drain announces itself when no frontend claimed it")
        self.assertIn("parent agent", agent.ui.lines[-1])
        self.assertNotIn("steering", agent.ui.lines[-1],
                         "'steering' is what the user does; this was the model")

    def test_a_user_interjection_still_reads_as_steering(self) -> None:
        agent = Fake()
        agent.steer("actually use postgres", origin="user")
        agent._drain_steer()
        self.assertIn("steering", agent.ui.lines[-1])


class MoreWorkIsNotACorrectionTest(unittest.TestCase):
    """The same channel, saying the opposite thing.

    `message_task` was a correction by construction — "fold it in if it applies" reads as "what you
    are doing may be wrong" — so a parent with MORE work for a running child had to phrase an
    addition as a correction, and the envelope then told the child the opposite of what was meant.

    Codex draws exactly this line, with one word in its envelope (MESSAGE vs NEW_TASK) on one shared
    send path. This is DGC's half of it: same tool, same delivery, same next-tool-boundary, and the
    child told which of the two it is. It is NOT Codex's wake — DGC's children have no idle state to
    wake into and its finished ones leave nothing to resume.
    """

    def drain(self, *sends) -> list[dict]:
        agent = Fake()
        for text, origin in sends:
            self.assertTrue(agent.steer(text, origin=origin), f"steer rejected {text!r}")
        agent._drain_steer()
        return agent.messages

    def test_added_work_says_what_the_child_is_doing_still_stands(self) -> None:
        from dgc.workflows import AGENT_TASK_PREFIX, AGENT_TASK_SUFFIX
        [message] = self.drain(("also add a migration guide", "agent_task"))
        text = message["content"]
        self.assertIn(AGENT_TASK_PREFIX, text)
        self.assertIn(AGENT_TASK_SUFFIX, text)
        self.assertIn("still stands", text)
        self.assertIn("ADDITIONAL work", text)

    def test_added_work_is_still_not_the_user(self) -> None:
        """The defect the first envelope exists for must not come back through the second."""
        [message] = self.drain(("also add a migration guide", "agent_task"))
        text = message["content"]
        self.assertNotIn("The user sent this", text)
        self.assertIn("It is NOT from the user", text)
        self.assertIn("_dgc_agent_message", message,
                      "it is the agent's words, so it must not replay as a user bubble")
        self.assertNotIn("_dgc_steering", message)

    def test_a_correction_never_says_the_work_still_stands(self) -> None:
        """The two must be distinguishable by the child, or the parameter buys nothing."""
        [message] = self.drain(("you are editing the wrong file", "agent"))
        self.assertNotIn("still stands", message["content"])
        self.assertNotIn("ADDITIONAL work", message["content"])

    def test_the_three_kinds_land_in_three_separate_envelopes(self) -> None:
        messages = self.drain(("the user typed this", "user"),
                              ("you are editing the wrong file", "agent"),
                              ("also add a migration guide", "agent_task"))
        self.assertEqual(len(messages), 3, "a shared envelope would merge two different meanings")
        joined = [m["content"] for m in messages]
        self.assertTrue(any("user-interjection" in t for t in joined))
        self.assertTrue(any("parent-agent-message" in t for t in joined))
        self.assertTrue(any("parent-agent-task" in t for t in joined))

    def test_an_invented_origin_cannot_reach_the_model_bare(self) -> None:
        """Every origin must fall into one of the three groups: one that did not would be dropped
        from the drain entirely, or reach the model with no envelope at all."""
        agent = Fake()
        self.assertTrue(agent.steer("something", origin="not-a-real-origin"))
        agent._drain_steer()
        [message] = agent.messages
        self.assertIn(STEERING_PREFIX, message["content"],
                      "an unknown origin must normalise to the safest envelope, not vanish")


class TheToolSaysWhichKindItIsTest(unittest.TestCase):
    def test_the_schema_offers_the_choice_and_defaults_to_a_correction(self) -> None:
        from dgc.tools import SUPERVISION_TOOL_SCHEMAS, TOOL_SCHEMAS
        spec = next(t["function"] for t in (*TOOL_SCHEMAS, *SUPERVISION_TOOL_SCHEMAS)
                    if t.get("function", {}).get("name") == "message_task")
        properties = spec["parameters"]["properties"]
        self.assertIn("adds_work", properties)
        self.assertEqual(properties["adds_work"]["type"], "boolean")
        self.assertNotIn("adds_work", spec["parameters"].get("required", []),
                         "a correction is the default; adding work is the deliberate act")
        self.assertIn("correct", spec["description"].lower())


class TheToolActuallyPicksTheEnvelopeTest(unittest.TestCase):
    """Through `message_detached`, not by calling `steer` with the origin by hand.

    The tests above prove the two envelopes differ. They do not prove the tool reaches the right
    one — a mutation sweep showed `adds_work` could be dropped on the send and every one of them
    still passed.
    """

    def parent(self, child):
        from dgc.agent import Agent
        parent = object.__new__(Agent)
        parent._detached_jobs = {"a1": {"agent": child}}
        parent._detached_handle = lambda agent_id: parent._detached_jobs.get(agent_id)
        parent._knows_finished = lambda agent_id: False
        parent.message_detached = Agent.message_detached.__get__(parent)
        parent._message_task_result = Agent._message_task_result.__get__(parent)
        return parent

    def envelope_for(self, **args) -> str:
        child = Fake()
        parent = self.parent(child)
        result = parent._message_task_result({"id": "a1", "text": "also add a migration guide",
                                              **args})
        self.assertNotIn("error", result.lower(), result)
        child._drain_steer()
        self.assertEqual(len(child.messages), 1, child.messages)
        return child.messages[0]["content"]

    def test_adds_work_reaches_the_added_work_envelope(self) -> None:
        self.assertIn("parent-agent-task", self.envelope_for(adds_work=True))

    def test_the_default_is_still_a_correction(self) -> None:
        text = self.envelope_for()
        self.assertIn("parent-agent-message", text)
        self.assertNotIn("parent-agent-task", text)

    def test_only_a_real_true_adds_work(self) -> None:
        """A model that sends the string "false" must not get the opposite of what it asked for."""
        for value in ("false", "no", 0, None, ""):
            with self.subTest(value=value):
                self.assertIn("parent-agent-message", self.envelope_for(adds_work=value))

    def test_the_tool_result_says_which_one_it_sent(self) -> None:
        child = Fake()
        parent = self.parent(child)
        added = parent._message_task_result({"id": "a1", "text": "x", "adds_work": True})
        fixed = parent._message_task_result({"id": "a1", "text": "y"})
        self.assertIn("added to its brief", added)
        self.assertIn("still stands", added)
        self.assertIn("folded into the work", fixed)
