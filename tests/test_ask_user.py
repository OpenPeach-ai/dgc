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

    def ask_open_question(self, ask_id, question, context, suggestions, call_id=None, options=None):
        if not self.can_show:
            return False
        self.shown.append({"ask_id": ask_id, "question": question, "context": context,
                           "suggestions": list(suggestions), "call_id": call_id,
                           "options": list(options or [])})
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

    def test_an_unanswered_question_is_resolved_when_the_user_moves_on_not_forgotten(self):
        a = agent()
        ask(a, question="Which staging host?")
        a.expire_open_asks()
        self.assertEqual(a.ui.resolved[0]["outcome"], "expired")
        self.assertIn("Which staging host?", a.steered[0], "the model is reminded what it asked")
        self.assertIn("do not ask it again", a.steered[0])
        self.assertEqual(a._open_asks(), {}, "nothing is left open once it has expired")

    def test_expiry_never_tells_the_model_the_user_did_not_answer(self):
        """The note rides in front of the user's NEXT message, and that message is very often the
        answer -- typed into the composer. A live session shows this verbatim:

            [DGC] You asked: "..." - the user never answered it. Decide it yourself ...
            yes, proceed with A (recommended).

        DGC contradicted the user in the user's own voice. A skip is a real refusal and keeps its
        wording; an expiry must not assert something it cannot know.
        """
        a = agent()
        ask(a, question="Which staging host?")
        a.expire_open_asks()
        note = a.steered[0]
        self.assertNotIn("the user never answered", note)
        self.assertIn("If what the user says next answers it, follow that", note,
                      "the model must be told the answer may be in the very next message")

    def test_a_skip_still_says_plainly_that_they_declined(self):
        a = agent()
        ask(a, question="Which staging host?")
        a.resolve_open_ask(a.ui.shown[0]["ask_id"], "skipped")
        self.assertIn("the user skipped it", a.steered[0])

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
        self.assertEqual(params["required"], ["question"],
                         "everything but the question stays optional")
        self.assertEqual(set(params["properties"]),
                         {"question", "context", "suggestions", "options"})
        self.assertEqual(params["properties"]["suggestions"]["maxItems"], 4)
        # `options` is the picker's shape, so a model that CAN name the choices no longer has to
        # stop the turn to offer them. suggestions only prefill the box; options are real choices.
        self.assertEqual(params["properties"]["options"]["maxItems"], 6)
        self.assertEqual(params["properties"]["options"]["items"]["required"], ["label"])
        described = spec["function"]["description"]
        self.assertIn("does not stop the turn", described)
        self.assertIn("propose_options", described,
                      "the description must draw the line to the tool it is not")
        # That line MOVED: enumerable options used to be propose_options' alone, and the text said
        # so. Now they belong here too, and propose_options is only for a decision the turn
        # genuinely cannot proceed without.
        self.assertNotIn("if you can enumerate the real options, use propose_options instead",
                         described, "the old rule is now backwards")


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


class UnansweredReachesTheModelTest(unittest.TestCase):
    """A question that closes unanswered must reach the model, not just the screen.

    expire_open_asks() runs AFTER run_turn has returned, and run_turn's finally has already set
    _accepting_steer = False -- so the "nobody answered, decide it yourself" note was handed to a
    steer() that refuses it, and the model was never told. Its last instruction was still
    ASK_DELIVERED ("if they reply it arrives as an ordinary message"), so it could sit waiting for
    an answer that will never come, or quietly guess without saying it guessed.
    """

    def _agent(self, accepting: bool):
        import threading

        a = object.__new__(Agent)
        a.ui = _UI()
        a.depth = 0
        a.config = type("C", (), {"data": {}, "get": lambda s, k, d=None: d})()
        a.steer_queue = []
        a._steer_lock = threading.RLock()
        a._accepting_steer = accepting
        a.cancelled = threading.Event()
        return a

    def test_the_note_is_carried_when_steering_has_closed(self):
        a = self._agent(accepting=False)
        a._ask_user("c1", {"question": "which host?"}, set())
        a.expire_open_asks()
        self.assertEqual(a.ui.resolved[0]["outcome"], "expired")
        carried = a.take_carried_notes()
        self.assertEqual(len(carried), 1, "the note was dropped instead of carried")
        self.assertIn("which host?", carried[0], "the model is reminded what it asked")
        self.assertNotIn("this turn", carried[0],
                         "carried to the NEXT turn, so the wording must not say 'this turn'")

    def test_it_is_steered_normally_while_the_window_is_open(self):
        a = self._agent(accepting=True)
        a._ask_user("c1", {"question": "which host?"}, set())
        a.resolve_open_ask(a.ui.shown[0]["ask_id"], "skipped")
        self.assertEqual(len(a.steer_queue), 1, "a skip mid-turn still steers")
        self.assertEqual(a.take_carried_notes(), [], "and is not carried twice")

    def test_a_carried_note_is_taken_only_once(self):
        a = self._agent(accepting=False)
        a._ask_user("c1", {"question": "which host?"}, set())
        a.expire_open_asks()
        self.assertEqual(len(a.take_carried_notes()), 1)
        self.assertEqual(a.take_carried_notes(), [])

    def test_the_next_turn_puts_it_in_front_of_the_prompt(self):
        import inspect
        source = inspect.getsource(Agent.run_turn)
        self.assertIn("take_carried_notes()", source,
                      "nothing drains the carried notes into a turn")


class TheCardOutlivesTheTurnTest(unittest.TestCase):
    """The question the user was reading when the model stopped talking.

    Reported from a live session and confirmed in its transcript: three options with a line of
    description each, and the card collapsed to a one-line "Not answered" while the user was still
    hovering over the option they meant to pick. `expire_open_asks()` had exactly one caller --
    `dgc/headless.py`, three lines before `turn_end` -- so an open ask's lifetime WAS the turn's
    lifetime. Nothing about the model finishing its sentence means the person finished reading.

    It expires at the start of the NEXT turn instead: the point where the user has actually moved
    on. These pin the lifetime, not the wording.
    """

    def live(self):
        """A real Agent driven through real turns, with only the provider call stubbed."""
        import tempfile
        from dgc.config import Config
        from dgc.llm import ChatResult

        class UI(_UI):
            def __getattr__(self, _name):
                return lambda *a, **kw: None

        config = Config(project_root=Path(tempfile.mkdtemp(prefix="dgc-ask-")))
        # In memory only: constructing an Agent otherwise connects the machine's real MCP servers.
        config.data["mcp_servers"] = {}
        config.data["disabled_mcp_servers"] = []
        a = Agent(config, UI())
        a._chat = lambda *args, **kwargs: ChatResult(content="done", tool_calls=[])
        return a

    def asking(self, a, question="Which staging host?"):
        """Make the next turn's model ask the question, through the real tool call, then finish."""
        from dgc.llm import ChatResult, ToolCall
        rounds = {"n": 0}

        def chat(*_args, **_kwargs):
            rounds["n"] += 1
            if rounds["n"] == 1:
                return ChatResult(content="", tool_calls=[
                    ToolCall("c1", "ask_user", {"question": question})])
            return ChatResult(content="done", tool_calls=[])

        a._chat = chat

    def test_a_question_outlives_the_turn_that_asked_it(self) -> None:
        a = self.live()
        self.asking(a)
        a.run_turn("do the thing")                      # asks, then the turn ENDS
        self.assertEqual(len(a._open_asks()), 1,
                         "the model finishing its sentence is not the user finishing reading")
        self.assertEqual([r["outcome"] for r in a.ui.resolved], [],
                         "and no client was told to close the card")

    def test_the_next_thing_the_user_says_is_what_closes_it(self) -> None:
        a = self.live()
        self.asking(a)
        a.run_turn("do the thing")
        a._chat = lambda *args, **kwargs: __import__("dgc.llm", fromlist=["ChatResult"]).ChatResult(
            content="done", tool_calls=[])
        a.run_turn("something else entirely")
        self.assertEqual(a._open_asks(), {}, "they moved on; now it is closed")
        self.assertEqual(a.ui.resolved[-1]["outcome"], "expired")

    def test_and_the_model_is_told_inside_that_same_turn(self) -> None:
        """Not carried to a turn after next: expiry runs before `take_carried_notes()`."""
        a = self.live()
        self.asking(a)
        a.run_turn("do the thing")
        a._chat = lambda *args, **kwargs: __import__("dgc.llm", fromlist=["ChatResult"]).ChatResult(
            content="done", tool_calls=[])
        a.run_turn("something else entirely")
        prompts = [m["content"] for m in a.messages if m.get("role") == "user"]
        self.assertTrue(any("Which staging host?" in str(p) for p in prompts),
                        f"the note never reached the transcript: {prompts}")

    def test_the_note_is_not_delivered_as_words_the_user_said(self) -> None:
        """Expiry runs BEFORE the steering window opens. Through steering, `_drain_steer` wraps it
        in the envelope that says 'The user sent this WHILE you were working' — DGC's own words in
        the user's mouth, which is the defect `message_task` had."""
        a = self.live()
        self.asking(a)
        a.run_turn("do the thing")
        a._chat = lambda *args, **kwargs: __import__("dgc.llm", fromlist=["ChatResult"]).ChatResult(
            content="done", tool_calls=[])
        a.run_turn("something else entirely")
        joined = "\n".join(str(m.get("content")) for m in a.messages if m.get("role") == "user")
        self.assertIn("[DGC]", joined, "the note is marked as DGC's, not the user's")
        self.assertNotIn("The user sent this WHILE you were working", joined)

    def test_expiry_has_exactly_one_caller_and_it_is_not_the_turn_ending(self) -> None:
        """The defect was a SECOND caller: `dgc/headless.py`, three lines before `turn_end`.

        The behavioural tests above drive `Agent.run_turn` directly, so re-adding that call would
        not fail any of them — the card would simply die again. This is the tripwire for it.
        """
        import re
        callers = []
        for path in sorted((PROJECT / "dgc").glob("*.py")):
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if re.search(r"(?<!def )\bexpire_open_asks\s*\(", line):
                    callers.append(f"{path.name}:{number}")
        self.assertEqual([c.split(":")[0] for c in callers], ["agent.py"],
                         f"expire_open_asks is called from {callers}; an open question is closed "
                         "when the user moves on, never because a turn ended")

    def test_a_question_survives_until_something_expires_it(self) -> None:
        a = agent()
        ask(a, question="Which staging host?")
        self.assertEqual(len(a._open_asks()), 1)
        a.expire_open_asks()
        self.assertEqual(a._open_asks(), {}, "and then it is gone, once")


class AnAnswerAfterTheTurnEndsIsNotThrownAwayTest(unittest.TestCase):
    """A click a moment after the model stopped talking.

    `resolve_open_ask` steers the answer into a RUNNING turn and refuses once that turn's steering
    window has shut — which is now the ordinary state of a card, because the card outlives its
    turn. The backend answered that refusal with `command_rejected{unknown_ask}` and returned
    without queueing anything, so the option the user chose was discarded.
    """

    def setUp(self) -> None:
        self.a = agent()
        self.a.steer = lambda text, **kwargs: False        # the turn has ended; steering refuses
        ask(self.a, question="Which staging host?")
        self.ask_id = self.a.ui.shown[0]["ask_id"]

    def test_the_premise_steering_really_does_refuse(self) -> None:
        self.assertFalse(self.a.resolve_open_ask(self.ask_id, "answered", "the blue one"),
                         "without this the deferral below is never reached")
        self.assertIn(self.ask_id, self.a._open_asks(), "a refused answer leaves it open")

    def test_the_answer_becomes_a_prompt_quoting_its_question(self) -> None:
        text = self.a.defer_open_ask(self.ask_id, "the blue one")
        self.assertEqual(text, "> Which staging host?\n\nthe blue one")

    def test_deferring_closes_the_question_and_tells_every_client(self) -> None:
        self.a.defer_open_ask(self.ask_id, "the blue one")
        self.assertEqual(self.a._open_asks(), {})
        self.assertEqual(self.a.ui.resolved[-1]["outcome"], "answered")
        self.assertEqual(self.a.ui.resolved[-1]["answer"], "the blue one")

    def test_an_id_nobody_is_waiting_on_is_still_refused(self) -> None:
        """So the backend can keep telling a client its id was unknown, rather than inventing a
        prompt out of a stale click."""
        self.assertEqual(self.a.defer_open_ask("ask-nobody", "the blue one"), "")
        self.assertEqual(self.a.defer_open_ask(self.ask_id, "   "), "",
                         "an empty answer is not an answer")
        self.assertIn(self.ask_id, self.a._open_asks(), "and it stays open")


class TheRealBackendQueuesALateAnswerTest(unittest.TestCase):
    """Through `Backend._dispatch` itself, because the drop happened in the backend, not the Agent.

    Driven against the real dispatch with only `_start_turn` and the emitter stubbed: a stub of the
    path under test would prove nothing, which is the lesson `RealBackendTest` above records.
    """

    def backend(self, open_asks: dict):
        from dgc.headless import Backend

        class Em:
            def __init__(self): self.sent = []
            def emit(self, name, **fields): self.sent.append((name, fields))

        a = agent()
        a.steer = lambda text, **kwargs: False          # the turn has ended; steering refuses
        a._open_ask_table = dict(open_asks)
        b = object.__new__(Backend)
        b.agent = a
        b.em = Em()
        b.started = []
        b._start_turn = lambda *args, **kwargs: (b.started.append(args[0]), ("started", None))[1]
        return b

    OPEN = {"ask-1": {"question": "Which staging host?", "call_id": "c1", "options": []}}

    def test_a_click_after_the_turn_ended_starts_a_turn_with_the_answer(self) -> None:
        b = self.backend(self.OPEN)
        b._dispatch({"type": "prompt", "text": "the blue one",
                     "answers": [{"ask_id": "ask-1"}], "request_id": "r1"})
        self.assertEqual(b.started, ["> Which staging host?\n\nthe blue one"],
                         "the answer used to be discarded here")
        self.assertEqual([name for name, _ in b.em.sent], ["prompt_accepted"])

    def test_the_client_is_told_the_question_was_answered(self) -> None:
        b = self.backend(self.OPEN)
        b._dispatch({"type": "prompt", "text": "the blue one",
                     "answers": [{"ask_id": "ask-1"}], "request_id": "r1"})
        self.assertEqual(b.agent.ui.resolved[-1]["outcome"], "answered")
        self.assertEqual(b.agent._open_asks(), {})

    def test_an_id_nobody_is_waiting_on_is_still_rejected(self) -> None:
        b = self.backend(self.OPEN)
        b._dispatch({"type": "prompt", "text": "the blue one",
                     "answers": [{"ask_id": "ask-gone"}], "request_id": "r1"})
        self.assertEqual(b.started, [], "a stale click must not invent a turn")
        self.assertEqual([name for name, _ in b.em.sent], ["command_rejected"])
        self.assertEqual(b.em.sent[0][1]["reason"], "unknown_ask")

    def test_a_running_turn_still_takes_the_answer_by_steering(self) -> None:
        """The unchanged path: while the turn IS running, the answer goes in as steering and no
        new turn is started."""
        b = self.backend(self.OPEN)
        b.agent.steer = lambda text, **kwargs: True
        b._dispatch({"type": "prompt", "text": "the blue one",
                     "answers": [{"ask_id": "ask-1"}], "request_id": "r1"})
        self.assertEqual(b.started, [])
        self.assertEqual(b.em.sent, [], "ask_resolved already told every client")


class TheReplyCarriesTheOptionsTest(unittest.TestCase):
    """The second half of the same report: "it did give me its recommendation, but completely
    slipped to list out all options."

    The model was obeying DGC. `ASK_DELIVERED` said "repeat the question" and never mentioned the
    options, and because the user's own prompt had asked to be offered choices, the requested-picker
    block was live and said a prose list "is not the selector — do not write one". So the reply
    said "the picker above has the full descriptions" and the picker was then erased.
    """

    def test_the_tool_result_asks_for_the_options_too(self) -> None:
        delivered = Agent.ASK_DELIVERED
        self.assertIn("option", delivered.lower(),
                      "the word never appeared, which is why B and C were dropped")
        self.assertIn("card is not part of your reply", delivered,
                      "and it has to say why: the reply outlives the card")

    def test_the_picker_block_no_longer_bans_writing_the_choices_down(self) -> None:
        a = object.__new__(Agent)
        a._active_tool_intents = {"options"}
        a.depth = 0
        a._picker_offered = lambda: True
        block = Agent._options_unavailable_note(a)
        self.assertIn("do not write one INSTEAD of calling the tool", block,
                      "the ban stays, but only against replacing the tool with prose")
        self.assertIn("writing the choices out in your final reply is expected", block)

    def test_it_still_refuses_a_prose_list_as_a_substitute_for_the_picker(self) -> None:
        a = object.__new__(Agent)
        a._active_tool_intents = {"options"}
        a.depth = 0
        a._picker_offered = lambda: True
        block = Agent._options_unavailable_note(a)
        self.assertIn("is not the selector", block)
        self.assertIn("Call propose_options", block)
