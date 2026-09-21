"""An open question the turn does not stop for.

`propose_options` blocks by construction: it is in `_WAITS_ON_USER_CALLS`, its executor parks on
the frontend, and a dismissal ends the batch. The whole point of this one is the opposite -- the
model asks something it genuinely does not know, and keeps working while the user reads it.

The answer comes back through steering, because an answer IS a mid-turn user message. That is not
a shortcut: it renders as one bubble in every frontend, survives reload and compaction, and needs
no new transcript concept. The text is the question quoted with the answer beneath it.

What these pin down, beyond "it works":
  - an answer must be TAGGED. A follow-up typed while a question happens to be open is an ordinary
    message, and recording it as an answer would corrupt the transcript unrecoverably.
  - every ending tells the model something. Codex's Skip emits nothing, leaving the model waiting
    for an answer that is not coming, or quietly guessing without saying so.
  - a question is never silently lost. Codex drops one after thirty seconds with no record; here
    an unanswered question is resolved at turn end and the model is told.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import editor_protocol as ep                      # noqa: E402
from dgc import permissions as pm                          # noqa: E402
from dgc.agent import Agent                                # noqa: E402


class _UI:
    """A frontend that can show an open question, recording what it was told."""

    def __init__(self, can_show=True):
        self.can_show = can_show
        self.shown, self.resolved, self.calls, self.results = [], [], [], []

    def tool_call(self, name, args, call_id):
        self.calls.append((name, args, call_id))

    def tool_result(self, name, out, call_id):
        self.results.append((name, out, call_id))

    def ask_open_question(self, ask_id, question, context, suggestions, call_id=None):
        if not self.can_show:
            return False
        self.shown.append({"ask_id": ask_id, "question": question, "context": context,
                           "suggestions": list(suggestions), "call_id": call_id})
        return True

    def ask_resolved(self, ask_id, outcome, question, answer="", call_id=None):
        self.resolved.append({"ask_id": ask_id, "outcome": outcome, "question": question,
                              "answer": answer})


def agent(ui=None, depth=0) -> Agent:
    """An Agent shell with only what these paths touch, so no model or workspace is needed."""
    a = object.__new__(Agent)
    a.ui = ui or _UI()
    a.depth = depth
    a.steered = []
    a.steer_calls = []
    a.steer = lambda text, **kwargs: (a.steered.append(text),
                                      a.steer_calls.append((text, kwargs)), True)[2]
    return a


def ask(a, question="Which staging host?", **extra) -> str:
    return a._ask_user("call-1", {"question": question, **extra}, set())


class DeliveryTest(unittest.TestCase):
    def test_it_returns_at_once_and_says_the_turn_did_not_stop(self):
        a = agent()
        out = ask(a)
        self.assertEqual(len(a.ui.shown), 1, "the question reached the frontend")
        self.assertIn("did NOT pause the turn", out)
        self.assertIn("carry on", out)
        self.assertIn("do not guess", out.lower())

    def test_the_question_and_its_extras_are_carried(self):
        a = agent()
        ask(a, question="Which staging host?", context="Two are configured.",
            suggestions=["staging-1", "staging-2"])
        shown = a.ui.shown[0]
        self.assertEqual(shown["question"], "Which staging host?")
        self.assertEqual(shown["context"], "Two are configured.")
        self.assertEqual(shown["suggestions"], ["staging-1", "staging-2"])
        self.assertTrue(shown["ask_id"], "every ask carries an id the answer can name")

    def test_an_empty_question_is_refused_before_anyone_sees_it(self):
        a = agent()
        self.assertIn("error:", ask(a, question="   "))
        self.assertEqual(a.ui.shown, [])

    def test_suggestions_are_bounded_and_cleaned(self):
        a = agent()
        ask(a, suggestions=["a", "", "  b  ", "c", "d", "e", "f"])
        self.assertEqual(a.ui.shown[0]["suggestions"], ["a", "b", "c", "d"],
                         "at most four, blanks dropped, trimmed")

    def test_a_subagent_has_nobody_to_ask(self):
        a = agent(depth=1)
        self.assertIn("nobody can answer", ask(a))
        self.assertEqual(a.ui.shown, [])

    def test_a_frontend_that_cannot_show_one_is_told_so(self):
        a = agent(_UI(can_show=False))
        self.assertIn("nobody can answer", ask(a))

    def test_two_open_at_once_is_the_ceiling(self):
        a = agent()
        ask(a, question="First?")
        ask(a, question="Second?")
        third = ask(a, question="Third?")
        self.assertIn("already have 2 questions open", third)
        self.assertEqual(len(a.ui.shown), 2, "the third never reached the user")


class AnswerTest(unittest.TestCase):
    def test_an_answer_arrives_as_the_question_quoted_with_the_reply_under_it(self):
        a = agent()
        ask(a, question="Which staging host?")
        ask_id = a.ui.shown[0]["ask_id"]
        self.assertTrue(a.resolve_open_ask(ask_id, "answered", "staging-2"))
        self.assertEqual(a.steered, ["> Which staging host?\n\nstaging-2"])
        self.assertEqual(a.ui.resolved[0]["outcome"], "answered")

    def test_the_answer_is_steered_under_an_id_so_the_frontend_can_mark_it(self):
        # _drain_steer only drops its own "steering:" echo for messages the frontend was told
        # about by id. Steering the answer anonymously made the editor draw the answer AND the
        # agent print the question under it, clipped at 80 characters.
        a = agent()
        ask(a, question="Which staging host?")
        ask_id = a.ui.shown[0]["ask_id"]
        a.resolve_open_ask(ask_id, "answered", "staging-2")
        self.assertEqual(a.steer_calls[0][1].get("request_id"), f"ask-{ask_id}")

    def test_only_the_answer_is_steered_under_that_id(self):
        # The skip/expiry note is the agent talking to itself, not a message of the user's, so it
        # must not arrive wearing a request id the frontend would mark as a delivered prompt.
        a = agent()
        ask(a, question="Which staging host?")
        a.resolve_open_ask(a.ui.shown[0]["ask_id"], "skipped")
        self.assertEqual([call[1].get("request_id") for call in a.steer_calls], [None])

    def test_answering_closes_it_so_a_second_answer_finds_nothing(self):
        a = agent()
        ask(a)
        ask_id = a.ui.shown[0]["ask_id"]
        a.resolve_open_ask(ask_id, "answered", "one")
        self.assertFalse(a.resolve_open_ask(ask_id, "answered", "two"),
                         "an id already resolved is not an open question")
        self.assertEqual(len(a.steered), 1)

    def test_an_unknown_id_resolves_nothing(self):
        a = agent()
        self.assertFalse(a.resolve_open_ask("ask-nobody", "answered", "x"))
        self.assertEqual(a.steered, [])

    def test_answering_frees_a_slot(self):
        a = agent()
        ask(a, question="First?")
        ask(a, question="Second?")
        a.resolve_open_ask(a.ui.shown[0]["ask_id"], "answered", "done")
        self.assertNotIn("already have", ask(a, question="Third?"))


class EndingTest(unittest.TestCase):
    """Codex tells the model nothing on Skip and nothing on expiry. Both are told here."""

    def test_skip_tells_the_model_to_decide_and_say_what_it_assumed(self):
        a = agent()
        ask(a, question="Which staging host?")
        a.resolve_open_ask(a.ui.shown[0]["ask_id"], "skipped")
        self.assertEqual(len(a.steered), 1)
        note = a.steered[0]
        self.assertIn("skipped it", note)
        self.assertIn("Decide it yourself", note)
        self.assertIn("say what you assumed", note)
        self.assertIn("Which staging host?", note, "the model is reminded what it asked")

    def test_an_unanswered_question_is_resolved_at_turn_end_not_forgotten(self):
        a = agent()
        ask(a, question="Which staging host?")
        a.expire_open_asks()
        self.assertEqual(a.ui.resolved[0]["outcome"], "expired")
        self.assertIn("never answered it", a.steered[0])
        self.assertEqual(a._open_asks(), {}, "nothing is left open after the turn")

    def test_expiry_is_a_no_op_when_everything_was_answered(self):
        a = agent()
        ask(a)
        a.resolve_open_ask(a.ui.shown[0]["ask_id"], "answered", "yes")
        a.steered.clear()
        a.expire_open_asks()
        self.assertEqual(a.steered, [], "an answered question is not expired a second time")


class ProtocolTest(unittest.TestCase):
    def test_the_frames_validate(self):
        self.assertIsNone(ep.event_error({"type": "ask_request", "seq": 1, "ask_id": "a1",
                                          "question": "Which host?"}))
        self.assertIsNone(ep.event_error({"type": "ask_resolved", "seq": 2, "ask_id": "a1",
                                          "outcome": "answered", "question": "Which host?",
                                          "answer": "staging-2"}))
        self.assertIsNone(ep.command_error({"type": "ask_skip", "ask_id": "a1"}))

    def test_an_invented_outcome_is_refused(self):
        self.assertTrue(ep.event_error({"type": "ask_resolved", "seq": 1, "ask_id": "a",
                                        "outcome": "ignored", "question": "q"}))

    def test_the_answer_tag_is_an_optional_field_on_prompt(self):
        self.assertIsNone(ep.command_error({"type": "prompt", "text": "hi"}))
        self.assertIsNone(ep.command_error({"type": "prompt", "text": "staging-2",
                                            "answers": [{"ask_id": "a1", "question": "q"}]}))

    def test_no_existing_event_grew_a_field(self):
        # The one change an un-opted-in client cannot survive is a new field on an event it
        # already knows. Both new frames are new TYPES, which are survivable.
        self.assertIn("ask_request", ep.EVENT_FIELDS)
        self.assertIn("ask_resolved", ep.EVENT_FIELDS)
        self.assertEqual(list(ep.EVENT_FIELDS["prompt_accepted"]["state"]["enum"]),
                         ["started", "queued", "steered"],
                         "prompt_accepted's states are unchanged")


class WiringTest(unittest.TestCase):
    def test_asking_a_question_never_raises_a_permission_card(self):
        self.assertIn("ask_user", pm.READ_ONLY_TOOLS)
        self.assertEqual(pm.DISPLAY.get("ask_user"), "AskUser")

    def test_the_tool_is_declared_with_one_question_and_optional_extras(self):
        from dgc.tools import TOOL_SCHEMAS
        spec = next(t for t in TOOL_SCHEMAS if t["function"]["name"] == "ask_user")
        params = spec["function"]["parameters"]
        self.assertEqual(params["required"], ["question"])
        self.assertEqual(set(params["properties"]), {"question", "context", "suggestions"})
        self.assertEqual(params["properties"]["suggestions"]["maxItems"], 4)
        described = spec["function"]["description"]
        self.assertIn("does not stop the turn", described)
        self.assertIn("propose_options", described,
                      "the description must draw the line to the tool it is not")


if __name__ == "__main__":
    unittest.main()


class DocumentedTest(unittest.TestCase):
    """The documentation gate: a feature lands in /docs with the change, not afterwards."""

    def _questions_page(self) -> str:
        from dgc import docs
        page = docs.find("Questions")
        self.assertIsNotNone(page)
        return " ".join(page[2].split())         # wrapped prose: match words, not line breaks

    def test_the_open_question_is_explained_where_the_picker_is(self):
        body = self._questions_page()
        self.assertIn("does not stop the turn", body)
        self.assertIn("Answer question", body, "the folded line is named, so it can be looked up")
        self.assertIn("Skip", body)

    def test_the_documented_limits_match_the_code(self):
        from dgc.agent import Agent
        body = self._questions_page()
        self.assertEqual(Agent.MAX_OPEN_ASKS, 2)
        self.assertIn("two open at once", body,
                      "the documented ceiling must track MAX_OPEN_ASKS")
        self.assertIn("sub-agent", body)
        self.assertIn("never raises a permission prompt", body)


class RealBackendTest(unittest.TestCase):
    """Against the real HeadlessUI, not a stub.

    The stub above returns True from ask_open_question, which is how a fatal bug survived every
    test in this file: the opt-in was written to the Backend and read from its UI -- different
    objects -- so the real ask_open_question returned False forever. The model got "nobody can
    answer questions here" on every call while `ready` advertised the capability as present, and
    no card could ever appear. Nothing that substitutes the UI can see that.
    """

    def _ui(self, opted_in: bool):
        from dgc.headless import HeadlessUI
        ui = object.__new__(HeadlessUI)
        ui.em = _Emitter()
        if opted_in:
            ui._open_asks_enabled = True
        return ui

    def test_an_opted_in_client_is_shown_the_question(self):
        ui = self._ui(True)
        self.assertTrue(ui.ask_open_question("a1", "Which host?", "", [], "c1"))
        self.assertEqual(ui.em.sent[0][0], "ask_request")
        self.assertEqual(ui.em.sent[0][1]["question"], "Which host?")

    def test_a_client_that_did_not_opt_in_is_not(self):
        ui = self._ui(False)
        self.assertFalse(ui.ask_open_question("a1", "Which host?", "", [], "c1"))
        self.assertEqual(ui.em.sent, [], "no ask_request may reach a client that cannot draw one")

    def test_the_opt_in_lands_where_the_ui_reads_it(self):
        # The bug in one assertion: Backend writes, HeadlessUI reads, and they are not the same
        # object unless the write is aimed at `self.ui`.
        import inspect
        from dgc import headless
        source = inspect.getsource(headless)
        self.assertIn("self.ui._open_asks_enabled = bool(cmd.get(\"open_asks\"))", source,
                      "the opt-in must be written to the UI that reads it, not to the Backend")
        self.assertFalse(issubclass(headless.Backend, headless.HeadlessUI),
                         "if this ever becomes true the assertion above can be relaxed")


class _Emitter:
    def __init__(self):
        self.sent = []

    def emit(self, name, **fields):
        self.sent.append((name, fields))


class AnswerMustLandTest(unittest.TestCase):
    """A question closes only when its answer actually reached the model."""

    def _refusing(self):
        a = agent()
        a.steer = lambda text, **kw: False        # the turn closed its steering window
        return a

    def test_a_refused_answer_leaves_the_question_open(self):
        a = self._refusing()
        ask(a, question="Which staging host?")
        ask_id = a.ui.shown[0]["ask_id"]
        self.assertFalse(a.resolve_open_ask(ask_id, "answered", "staging-2"),
                         "the answer did not land, so the question is not closed")
        self.assertIn(ask_id, a._open_asks(), "still open, so the card must stay")
        self.assertEqual(a.ui.resolved, [], "and no client was told it was answered")

    def test_an_empty_answer_does_not_close_it_either(self):
        a = agent()
        ask(a)
        ask_id = a.ui.shown[0]["ask_id"]
        self.assertFalse(a.resolve_open_ask(ask_id, "answered", "   "))
        self.assertIn(ask_id, a._open_asks())

    def test_skip_still_closes_it_even_if_the_note_cannot_be_steered(self):
        # Skip is the user's decision, not a delivery: it must take effect whether or not the
        # model can still be told, or the card would be un-dismissable at the end of a turn.
        a = self._refusing()
        ask(a)
        ask_id = a.ui.shown[0]["ask_id"]
        self.assertTrue(a.resolve_open_ask(ask_id, "skipped"))
        self.assertNotIn(ask_id, a._open_asks())
