"""The options picker (propose_options): offered when the user asks to choose, explained when it is not.

A user who asks "propose me options to select from" gets the picker for that turn, in full-auto too.
Where the picker still cannot exist (a background wake turn, a non-interactive `dgc -p` run, a
sub-agent, a subscription CLI) the model is told why and how the user can get it, so it lists the
choices instead of claiming the tool does not exist. Nothing is added to a request that did not ask.
"""
from __future__ import annotations

import copy
import os
import pwd
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:                    # imported by another module first: verify, never assume
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_options_picker.py needs HOME redirected before dgc is imported — "
                           "run it through tests/run_tests.py or with HOME=<tmp>")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-options-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc import sessions                                   # noqa: E402  (after the redirect above)
from dgc.agent import Agent, _tool_intents                 # noqa: E402
from dgc.config import Config, DEFAULTS                    # noqa: E402
from dgc.editor_protocol import event_error                # noqa: E402
from dgc.headless import Backend, HeadlessUI               # noqa: E402
from dgc.llm import ChatResult, ToolCall                   # noqa: E402
from dgc.protocol import PendingRequests                   # noqa: E402

FOUNDER = ("I want to see how this DGC proposes options to user, can you do a test and propose me "
           "options to select from ?")

ASKS = [
    FOUNDER,
    "propose_options",
    "Give me a few options to choose from.",
    "can you give me a couple of choices so I can pick one",
    "Offer me some alternatives and I'll decide",
    "list the options for me to select",
    "Let me choose.",
    "Ask me to pick between Redis and Memcached",
    "please let me decide which approach",
    "propose me options",
    "show me the options picker",
    "can you ask me a multiple-choice question",
    "Give me a few options, I'll pick one",
    "use propose_options to let me pick",
    "Propose two approaches and let me choose",
    "Which database should we use? Propose me options to pick from.",
    "Before you start, give me options to choose from for the cache layer",
    "fix the failing test, then give me options so I can decide which refactor to do next",
    "ask me which approach to take",
    "can you call propose_options so I can see it",
    "demo the options picker",
    "can you show me a test option picker , with recomendation so i can select , i want to see how it looks and functions",
    "show me a test option picker",
    "Can't you give me some options to pick from?",
    "Couldn't you propose me options to select from?",
    "Won't you let me choose?",
    "Give me options to choose from for the title, based on @notes.md",
    "Look at @src/app.tsx and give me options to choose from",
    # A negation beside an ask is not parsed; the model reads it (test_a_take_back_is_left_to_the_model).
    "I don't know which approach is best, give me options to choose from",
    "Give me options to choose from, don't just pick one",
    "Propose me options to select from, and don't list more than three options.",
]

NOT_ASKS = [
    "add a --verbose option",
    "what are my options for caching",
    "fix the compiler options in tsconfig",
    "Don't add unrequested features, options, abstractions",
    "build a multiple-choice quiz app",
    "fix the option picker component",
    "show me the options picker component code",
    "Let me pick up where we left off",
    "list the build options and choose the fastest one",
    "add a dropdown with options to select from",
    "the settings menu should let me choose a theme",
    "choose the best option and implement it",
    "Which option should I choose?",
    "add an options menu to the navbar",
    "suggest options for the retry policy",
]

# Descriptions of software being built, and work on DGC itself, that an earlier matcher took for an
# ask (review findings, confirmed on captured requests): in full-auto each exposed the blocking picker.
BUILDING_NOT_ASKING = [
    "Show the options to select from in the dropdown component",
    "The popup should list the options for me to select a region",
    "Make the onboarding screen offer three choices so I can pick a plan",
    "write tests for propose_options in dgc/tools.py",
    "and let me select the files to upload in the form component",
    "Let me decide on the database later; for now implement the SQLite store",
    "In the settings page, show some options so we can pick the theme",
    "The select element should present the options to choose from in alphabetical order",
    "You let me choose the port in the old version, restore that",
    "Give me the options dialog. It crashes when it opens",
    "Build a quiz that will show multiple choices and I pick one",
    "just ask me to choose later, implement a default now",
    "Render a dropdown that shows a list of options to select from",
    "add a select element listing the options to choose from",
    "give the user options to select from in the settings modal",
    "Build a CLI wizard: present the options to select from, then save config",
    "the combobox should list options to select from as you type",
    "suggest alternatives to choose from when the search has no results",
    "write a function that returns a list of choices to select from",
    "Add a file input and let me select a file to upload",
    "Let me decide later, just implement A",
    "In the settings page, show some options so we can pick",
    "show me options to choose from in the dropdown",
    "When I click the gear, show me options to pick from",
    "Let me pick which columns to export in the CSV export",
    "in the TUI, let me choose which session to resume",
    "I can't pick a model; let me choose one in the model pill",
    "offer me the option to export as PDF",
    "The CLI should offer me choices so I can pick one",
    "Implement a CLI prompt that gives the user options to choose from",
    "I want the tool to propose me options to select from",
    "grep for propose_options in agent.py",
    "use propose_options in the test fixture",
    "run the propose_options tests",
    "the propose_options description is too long",
    "show me the options picker, it doesn't open",
    "Build the settings page: render a dropdown that shows a list of options to select from, with tests",
    "show me options to choose from in @src/Dropdown.tsx",
    "use propose_options in @dgc/agent.py",
    "use propose_options with @notes.md",
]

# A quoted or blockquoted ask is not in an imperative position. Unquoted reported speech and text pasted
# into the composer still read as typed (no frame tells them apart); attached files and editor context
# are framed, and never count.
QUOTED = [
    'My teammate wrote: "give me options to choose from"',
    "> give me options to choose from\nwhat does this message mean?",
]


class UI:
    """An interactive frontend that answers every question with its second option."""

    def __init__(self):
        self.infos, self.errors, self.questions = [], [], []

    def info(self, message):
        self.infos.append(message)

    def error(self, message):
        self.errors.append(message)

    def ask_questions(self, questions, call_id=None):
        """The v14 picker: record each question and its labels, answer with the second option."""
        answers = {}
        for question in questions:
            labels = [option["label"] for option in question["options"]]
            self.questions.append((question["question"], labels))
            answers[question["id"]] = {"selected": [1 if len(labels) > 1 else 0], "other": ""}
        return {"outcome": "answered", "answers": answers}

    def __getattr__(self, name):
        return lambda *a, **k: None


class OneShotUI(UI):
    """Like `dgc -p`: nobody can answer."""
    non_interactive = True

    def ask_questions(self, questions, call_id=None):
        for question in questions:
            self.questions.append((question["question"], [option["label"] for option in question["options"]]))
        return {"outcome": "unavailable", "answers": {}}


class WakeUI(UI):
    """Delivers monitor events, like the TUI and the editor backend."""

    def __init__(self):
        super().__init__()
        self.monitor_wake_enabled = True


def make_config(root: Path, **settings) -> Config:
    cfg = Config()
    cfg.project_root = root
    cfg.data.update({"model": "fixture", "base_url": "http://fixture", "mode": "default",
                     "notes": False, "suggest": False, "artifact_autostart": False})
    cfg.data.update(settings)
    return cfg


def names(tools) -> set[str]:
    return {tool["function"]["name"] for tool in tools or []}


def scripted(agent, steps):
    """Replace the model with `steps`; record each request's tools and system prompt."""
    calls = []

    def fake_chat(tools_schema, effort, *, cancel=None, read_timeout=None, defer_text=False,
                  request_reason="other"):
        index = len(calls)
        calls.append({"tools": names(tools_schema), "system": agent.messages[0]["content"],
                      "reason": request_reason})
        step = steps[min(index, len(steps) - 1)]
        return step(agent, calls[-1]) if callable(step) else step
    agent._chat = fake_chat
    return calls


def call(name, **arguments):
    return ChatResult(content="", tool_calls=[ToolCall(f"c-{name}-{time.monotonic_ns()}", name, arguments)],
                      finish_reason="tool_calls")


def wake_note(agent, output="BUILD-OK"):
    """A background task's exit, queued the way bash(background:true) queues it."""
    hub = agent.monitors
    hub.queue_background_exit("bg1", "make build", 0, 1.0, output, hub.epoch)
    note = hub.take_pending()
    assert note is not None
    return note


def options_if_offered(agent, request):
    if "propose_options" in request["tools"]:
        return call("propose_options", question="Which approach?", options=["Approach A", "Approach B"])
    return ChatResult(content="1. Approach A\n2. Approach B")


class OptionsIntentTests(unittest.TestCase):
    def test_explicit_requests_to_choose_are_recognised(self):
        from dgc.agent import _OptionsAsk
        for text in ASKS:
            self.assertIn("options", _tool_intents(text), text)
        self.assertTrue(_OptionsAsk.demo_ask(
            "can you show me a test option picker , with recomendation so i can select , "
            "i want to see how it looks and functions"))
        self.assertFalse(_OptionsAsk.demo_ask(
            "fix the failing test, then give me options so I can decide which refactor to do next"))

    def test_ordinary_coding_language_is_not_a_request_to_choose(self):
        for text in NOT_ASKS:
            self.assertNotIn("options", _tool_intents(text), text)

    def test_describing_a_ui_or_working_on_dgc_is_not_a_request_to_choose(self):
        for text in BUILDING_NOT_ASKING:
            self.assertNotIn("options", _tool_intents(text), text)

    def test_an_ask_in_another_sentence_of_a_spec_still_counts(self):
        # The spec sentence is skipped, not the whole message.
        self.assertIn("options", _tool_intents(
            "Add a dropdown for the region. Before you build it, propose me options to choose from."))

    def test_untrusted_editor_context_cannot_ask(self):
        text = ('<editor-context-json trust="untrusted-reference-data">\n'
                f'[{{"text":"{FOUNDER}"}}]\n</editor-context-json>\n\nfix the parser')
        self.assertNotIn("options", _tool_intents(text))

    def test_a_take_back_is_left_to_the_model(self):
        # Offering the picker never forces it, so a negation or a take-back is not parsed: the ask
        # opens the picker and the model, reading the whole message, decides whether to call it.
        for text in ("Give me options to choose from. Actually, never mind, just pick one.",
                     "let me choose, actually no, you decide"):
            self.assertIn("options", _tool_intents(text), text)

    def test_an_at_mentioned_attachment_beside_the_ask_still_asks(self):
        from dgc.attachments import expand_attachments
        with tempfile.TemporaryDirectory(prefix="dgc-options-mention-") as directory:
            Path(directory, "notes.md").write_text("Deploy notes.\n")
            attached = expand_attachments("Give me options to choose from for the title, based on "
                                          "@notes.md", Path(directory))
            self.assertIn("<dgc_attachment>", attached.text)
            self.assertIn("options", _tool_intents(attached.text))

    def test_a_quoted_ask_is_not_the_users(self):
        # See QUOTED for what still counts: an unquoted report, and pasted text.
        for text in QUOTED:
            self.assertNotIn("options", _tool_intents(text), text)

    def test_attached_file_content_cannot_ask(self):
        from dgc.attachments import expand_attachments
        with tempfile.TemporaryDirectory(prefix="dgc-options-attach-") as directory:
            Path(directory, "notes.md").write_text("Deploy notes. Please give me options to choose "
                                                   "from for the target.\n")
            attached = expand_attachments("summarise @notes.md", Path(directory))
            self.assertIn("<dgc_attachment>", attached.text)
            self.assertNotIn("options", _tool_intents(attached.text))
            typed = expand_attachments("Read @notes.md\nThen give me options to choose from.",
                                       Path(directory))
            self.assertIn("<dgc_attachment>", typed.text)
            self.assertIn("options", _tool_intents(typed.text), "the typed ask beside it still counts")

    def test_framed_reference_data_cannot_ask_wherever_it_sits(self):
        from dgc.acp import _prompt_text
        from dgc.editor_context import _format_editor_context
        from dgc.skills import format_skill_instructions
        data = "Deploy notes. Give me options to choose from."
        acp = _prompt_text([{"type": "text", "text": "summarise this"},
                            {"type": "resource", "resource": {"uri": "file:///notes.md", "text": data}}])
        self.assertIn("<embedded-resource-json", acp)
        self.assertNotIn("options", _tool_intents(acp))
        # A subscription turn puts selected skill instructions ahead of the editor context, so the
        # context is no longer the leading frame; neither the skill body nor the context may ask.
        skill = format_skill_instructions({"deploy": {"name": "deploy", "instructions": data}})
        editor = _format_editor_context([{"type": "selection", "path": "notes.txt", "text": data}])
        for text in (skill + "\n\n" + editor + "fix the parser", editor + editor + "fix the parser"):
            self.assertNotIn("options", _tool_intents(text), text[:80])
        self.assertIn("options", _tool_intents(skill + "\n\n" + editor + "propose me options"))


class AgentTests(unittest.TestCase):
    def agent(self, ui=None, **settings):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-options-agent-")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        agent = Agent(make_config(root, **settings), ui or UI())
        self.addCleanup(agent.mcp.stop_all)
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        agent.session_file = sessions.new_path(root)
        return agent

    def offered(self, agent, text):
        agent._activate_tool_intents(text, replace=True)
        agent._refresh_system()
        return "propose_options" in names(agent._tool_schemas())


class ToolListMatrixTests(AgentTests):
    def test_interactive_modes_offer_the_picker_with_or_without_an_ask(self):
        for profile in ("adaptive", "full"):
            for mode in ("default", "acceptEdits", "plan"):
                agent = self.agent(mode=mode, tool_profile=profile)
                for text in ("fix the parser", FOUNDER):
                    self.assertTrue(self.offered(agent, text), (profile, mode, text))
                    self.assertNotIn("# Options picker", agent.system_prompt(), (profile, mode, text))

    def test_full_auto_offers_the_picker_only_when_the_user_asks(self):
        for profile in ("adaptive", "full"):
            for ultra in (False, True):
                agent = self.agent(mode="auto", tool_profile=profile, ultra_mode=ultra)
                label = (profile, ultra)
                self.assertFalse(self.offered(agent, "fix the parser"), label)
                self.assertNotIn("# Options picker", agent.system_prompt(), label)
                self.assertTrue(self.offered(agent, FOUNDER), label)
                self.assertNotIn("# Options picker", agent.system_prompt(), label)
                self.assertIn("propose_options", agent._text_protocol_section(), label)
                self.assertFalse(self.offered(agent, "now add the tests"), f"{label}: per turn only")

    def test_full_auto_keeps_the_picker_out_of_a_turn_that_builds_a_ui(self):
        agent = self.agent(mode="auto")
        for text in BUILDING_NOT_ASKING:
            self.assertFalse(self.offered(agent, text), text)
            self.assertNotIn("# Options picker", agent.system_prompt(), text)

    def test_an_active_goal_never_carries_the_ask_to_later_turns(self):
        agent = self.agent(mode="auto")
        self.assertTrue(agent.set_goal("Refactor the parser, then propose me options to choose from"))
        for text in ("Continue the active goal.", "now fix the failing test"):
            self.assertFalse(self.offered(agent, text), text)
            self.assertNotIn("# Options picker", agent.system_prompt(), text)
        self.assertTrue(self.offered(agent, FOUNDER), "the user's own ask still counts during a goal")
        # A goal still activates its other intents (the monitor tool here).
        agent.set_goal("watch the dev server log")
        agent._activate_tool_intents("keep going", replace=True)
        self.assertIn("monitor", agent._active_tool_intents)

    def test_a_ui_whose_getattr_answers_everything_is_still_interactive(self):
        class Permissive:
            def __getattr__(self, name):
                return lambda *a, **k: None
        agent = self.agent(ui=Permissive(), mode="auto")
        self.assertTrue(self.offered(agent, FOUNDER))

    def test_a_sub_agent_in_full_auto_is_told_why_and_what_to_do(self):
        agent = self.agent(mode="auto")
        agent.depth = 1
        self.assertFalse(self.offered(agent, FOUNDER))
        prompt = agent.system_prompt()
        self.assertIn("# Options picker", prompt)
        self.assertIn("sub-agent", prompt)
        self.assertIn("numbered list", prompt)
        # The parent model wrote this prompt: the note must not claim the user asked.
        self.assertIn("Your task asks for a choice between options", prompt)
        self.assertNotIn("The user asked", prompt)
        agent._activate_tool_intents("fix the parser", replace=True)
        self.assertNotIn("# Options picker", agent.system_prompt())

    def test_a_sub_agent_note_never_speaks_for_the_user(self):
        # A sub-agent of a wake turn or of a `dgc -p` run: still the parent model's words, and the
        # sub-agent answers the parent, not the user.
        for label, ui, wake in (("wake", WakeUI(), True), ("-p", OneShotUI(), False),
                                ("interactive", UI(), False)):
            agent = self.agent(ui=ui, mode="auto")
            agent.depth, agent._monitor_turn = 1, wake
            self.assertFalse(self.offered(agent, FOUNDER), label)
            # The note is its own section; the sub-agent decision line that follows it is not the note.
            note = agent.system_prompt().split("# Options picker", 1)[1].split("\n\n", 1)[0]
            self.assertIn("Your task asks for a choice between options", note, label)
            self.assertIn("sub-agent", note, label)
            self.assertNotIn("the user", note.lower(), label)

    def test_a_non_interactive_run_in_full_auto_is_told_why_and_what_to_do(self):
        agent = self.agent(ui=OneShotUI(), mode="auto")
        self.assertFalse(self.offered(agent, FOUNDER))
        prompt = agent.system_prompt()
        self.assertIn("# Options picker", prompt)
        self.assertIn("non-interactive `dgc -p` run", prompt)
        self.assertIn("editor panel", prompt)
        # The text protocol carries the same reason: it lists the same filtered tools.
        self.assertNotIn('"propose_options"', agent._text_protocol_section())

    def test_the_note_never_reaches_a_request_that_did_not_ask(self):
        for label, ui, depth, wake in (("-p", OneShotUI(), 0, False), ("sub-agent", UI(), 1, False),
                                       ("wake", WakeUI(), 0, True)):
            agent = self.agent(ui=ui, mode="auto")
            agent.depth, agent._monitor_turn = depth, wake
            agent._activate_tool_intents("run the tests and fix the failure", replace=True)
            self.assertNotIn("propose_options", names(agent._tool_schemas()), label)
            self.assertNotIn("# Options picker", agent.system_prompt(), label)


class TurnTests(AgentTests):
    def test_full_auto_turn_raises_the_picker_and_the_choice_reaches_the_model(self):
        ui = UI()
        agent = self.agent(ui=ui, mode="auto")
        text_protocol = []

        def after_the_answer(agent, request):
            text_protocol.append(agent._text_protocol_section())
            return options_if_offered(agent, request)
        calls = scripted(agent, [options_if_offered, after_the_answer, ChatResult(content="You picked B.")])
        self.assertTrue(agent.run_turn(FOUNDER))
        self.assertIn("propose_options", calls[0]["tools"])
        # One round of questions answers the ask: the rest of the turn is full-auto again.
        self.assertNotIn("propose_options", calls[1]["tools"])
        self.assertNotIn('"propose_options"', text_protocol[0])
        self.assertNotIn("# Options picker", calls[1]["system"])
        self.assertEqual(len(ui.questions), 1)
        self.assertEqual(ui.questions, [("Which approach?", ["Approach A", "Approach B"])])
        result = next(m["content"] for m in agent.messages if m.get("role") == "tool")
        self.assertIn('chose "Approach B"', result)
        self.assertNotIn("propose_options", names(agent._tool_schemas()), "cleared with the turn")
        self.assertNotIn("# Options picker", agent.messages[0]["content"])

        calls = scripted(agent, [ChatResult(content="done")])
        self.assertTrue(agent.run_turn("now fix the parser"))
        self.assertNotIn("propose_options", calls[0]["tools"], "full-auto keeps its rule otherwise")

    def test_a_picker_demo_does_not_write_a_mock_file(self):
        ui = UI()
        agent = self.agent(ui=ui, mode="auto")
        demo = Path(agent.config.project_root) / "option-picker-demo.html"

        def mock_html(_agent, _request):
            return call("write_file", path="option-picker-demo.html",
                        content="<html>fake picker</html>")

        calls = scripted(agent, [mock_html, options_if_offered, ChatResult(content="You picked B.")])
        text = ("can you show me a test option picker , with recomendation so i can select , "
                "i want to see how it looks and functions")
        self.assertTrue(agent.run_turn(text))
        self.assertEqual(calls[1]["reason"], "options_gate")
        self.assertIn("propose_options", calls[1]["tools"])
        self.assertFalse(demo.exists(), "a mock HTML file must not land")
        self.assertEqual(len(ui.questions), 1)
        self.assertTrue(any("native options picker" in (m.get("content") or "")
                            for m in agent.messages if m.get("role") == "tool"))
        self.assertTrue(ui.questions[0][1], "the native picker opened after the mock was refused")

    def test_work_then_choose_still_runs_the_fix(self):
        ui = UI()
        agent = self.agent(ui=ui, mode="auto")
        target = Path(agent.config.project_root) / "fixed.txt"

        def write_fix(_agent, _request):
            return call("write_file", path="fixed.txt", content="ok\n")

        calls = scripted(agent, [write_fix, options_if_offered, ChatResult(content="You picked B.")])
        self.assertTrue(agent.run_turn(
            "fix the failing test, then give me options so I can decide which refactor to do next"))
        self.assertTrue(target.exists())
        self.assertNotEqual(calls[0].get("reason"), "options_gate")
        self.assertEqual(len(ui.questions), 1)

    def test_a_full_auto_goal_run_asks_once_then_runs_unattended(self):
        ui = UI()
        agent = self.agent(ui=ui, mode="auto")
        self.assertTrue(agent.set_goal("write both files"))

        def cycle_one(agent, request):
            return call("write_file", path="one.txt", content="1\n")

        def cycle_two(agent, request):
            return call("write_file", path="two.txt", content="2\n")

        def complete(agent, request):
            return call("update_goal", status="completed", summary="Both files written",
                        evidence=["one.txt and two.txt exist"])
        calls = scripted(agent, [options_if_offered, cycle_one, ChatResult(content="cycle one done"),
                                 options_if_offered, cycle_two, complete,
                                 ChatResult(content="Both files written.")])
        self.assertTrue(agent.run_turn(FOUNDER))
        self.assertEqual(agent.goal_status, "completed")
        self.assertGreaterEqual(agent.goal_snapshot()["cycles"], 2)
        self.assertIn("propose_options", calls[0]["tools"])
        self.assertTrue(all("propose_options" not in request["tools"] for request in calls[1:]),
                        [sorted(request["tools"]) for request in calls])
        self.assertEqual(len(ui.questions), 1)

    def test_a_wake_turn_after_an_ask_explains_the_missing_picker(self):
        agent = self.agent(ui=WakeUI(), mode="default")
        calls = scripted(agent, [call("bash", command="sleep 0.2; echo BUILD-OK", background=True),
                                 ChatResult(content="started")])
        self.assertTrue(agent.run_turn("run the build in the background, then give me options to "
                                       "choose from for the deploy target"))
        self.assertIn("propose_options", calls[0]["tools"])
        self.assertNotIn("# Options picker", calls[0]["system"])
        deadline = time.monotonic() + 10
        while not agent.monitors.pending_count() and time.monotonic() < deadline:
            time.sleep(0.02)
        note = agent.monitors.take_pending()
        self.assertIsNotNone(note)
        calls = scripted(agent, [ChatResult(content="1. staging\n2. production")])
        self.assertTrue(agent.run_monitor_turn(note))
        self.assertNotIn("propose_options", calls[0]["tools"])
        self.assertIn("# Options picker", calls[0]["system"])
        self.assertIn("background event", calls[0]["system"])
        self.assertNotIn("# Options picker", agent.messages[0]["content"], "gone after the wake turn")
        # That wake turn listed the options: a later event must not ask for them again.
        calls = scripted(agent, [ChatResult(content="Still waiting for your choice.")])
        self.assertTrue(agent.run_monitor_turn(wake_note(agent)))
        self.assertNotIn("# Options picker", calls[0]["system"])

    def test_steering_that_asks_opens_the_picker_mid_turn(self):
        def steer(agent, request):
            self.assertTrue(agent.steer("wait, let me choose"))
            return ChatResult(content="Here is my first thought.")
        agent = self.agent(mode="auto")
        calls = scripted(agent, [steer, ChatResult(content="done")])
        self.assertTrue(agent.run_turn("pick a deploy target"))
        self.assertNotIn("propose_options", calls[0]["tools"])
        self.assertIn("propose_options", calls[1]["tools"])

    def test_a_wake_turn_after_the_user_answered_the_picker_adds_no_note(self):
        for mode in ("default", "acceptEdits", "plan", "auto"):
            ui = WakeUI()
            agent = self.agent(ui=ui, mode=mode)
            calls = scripted(agent, [options_if_offered, ChatResult(content="Deploying to B.")])
            self.assertTrue(agent.run_turn("give me options to choose from for the deploy target"), mode)
            self.assertIn("propose_options", calls[0]["tools"], mode)
            self.assertEqual(len(ui.questions), 1, mode)
            calls = scripted(agent, [ChatResult(content="Build finished.")])
            self.assertTrue(agent.run_monitor_turn(wake_note(agent)), mode)
            self.assertNotIn("# Options picker", calls[0]["system"], mode)

    def test_a_sub_agents_forced_call_leaves_the_parents_ask_open(self):
        # Sub-agents are never offered the picker (v14): a forced call puts nothing to the user, so
        # the parent's ask is still open for the parent to answer once the sub-agent returns.
        from dgc.questions import UNAVAILABLE_RESULT
        ui = WakeUI()
        parent = self.agent(ui=ui, mode="default")
        child = self.agent(ui=ui, mode="default")
        child.depth, child._metrics_parent = 1, parent
        parent._active_tool_intents = {"options", "monitor"}
        child._active_tool_intents = {"options"}
        out = child._handle_call(ToolCall("c1", "propose_options",
                                          {"question": "Which?", "options": ["A", "B"]}))
        self.assertEqual(out, UNAVAILABLE_RESULT)
        self.assertEqual(ui.questions, [])
        self.assertEqual(parent._active_tool_intents, {"options", "monitor"})

    def test_a_non_interactive_answer_says_nobody_can_answer(self):
        ui = OneShotUI()
        agent = self.agent(ui=ui, mode="default")
        out = agent._handle_call(ToolCall("c1", "propose_options",
                                          {"question": "Which?", "options": ["A", "B"]}))
        self.assertEqual(ui.questions, [("Which?", ["A", "B"])])
        self.assertIn("non-interactive `dgc -p` run", out)
        self.assertIn("numbered list", out)
        self.assertIn("Do not assume", out)

    def test_an_interactive_unanswered_question_keeps_its_result(self):
        from dgc.questions import DISMISSED_RESULT
        class Closed(UI):
            def ask_questions(self, questions, call_id=None):
                return {"outcome": "dismissed", "answers": {}}
        agent = self.agent(ui=Closed(), mode="default")
        out = agent._handle_call(ToolCall("c1", "propose_options",
                                          {"question": "Which?", "options": ["A", "B"]}))
        self.assertEqual(out, DISMISSED_RESULT, "the -p wording is only for a run nobody can answer")


class SubscriptionTests(unittest.TestCase):
    def test_a_delegated_turn_that_asks_is_told_the_picker_is_dgcs_own(self):
        from dgc.ultra import delegated_prompt
        cfg = make_config(Path(tempfile.gettempdir()))
        wrapped = delegated_prompt(cfg, FOUNDER, "auto")
        self.assertIn("<dgc-options-note>", wrapped)
        self.assertIn("numbered list", wrapped)
        self.assertTrue(wrapped.endswith(FOUNDER))
        self.assertNotIn("<dgc-options-note>", delegated_prompt(cfg, "fix the parser", "auto"))
        context = ('<editor-context-json trust="untrusted-reference-data">\n'
                   f'[{{"text":"{FOUNDER}"}}]\n</editor-context-json>\n\nfix the parser')
        self.assertNotIn("<dgc-options-note>", delegated_prompt(cfg, context, "auto"))
        from dgc.skills import format_skill_instructions
        skill = format_skill_instructions({"deploy": {"name": "deploy",
                                                      "instructions": "Notes. " + FOUNDER}})
        framed = skill + "\n\n" + context
        self.assertNotIn("<dgc-options-note>", delegated_prompt(cfg, framed, "auto"))

    def test_a_goal_cycle_prompt_is_not_the_users_ask(self):
        from dgc.goals import CYCLE_MARKER
        from dgc.ultra import delegated_prompt
        cfg = make_config(Path(tempfile.gettempdir()))
        cycle = (CYCLE_MARKER + " Take the next concrete step.\n\nGoal: Refactor the parser, then "
                 "propose me options to choose from")
        self.assertNotIn("<dgc-options-note>", delegated_prompt(cfg, cycle, "auto"))


class EditorBackendTests(unittest.TestCase):
    """`dgc serve` in full-auto: the ask raises options_request, the editor's answer reaches the model."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-options-serve-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        config = object.__new__(Config)
        config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="auto",
                           hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                           notes=False)
        config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
        config.credential_warnings = ()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        self.events, self.condition = [], threading.Condition()

        def emit(_event_type, /, **fields):
            event = {"type": _event_type, **fields}
            self.assertIsNone(event_error({"seq": 1, **event}), event)
            with self.condition:
                self.events.append(event)
                self.condition.notify_all()
        emitter = types.SimpleNamespace(emit=emit)
        backend = object.__new__(Backend)
        backend.config, backend.em, backend.pending = config, emitter, PendingRequests()
        backend.ui = HeadlessUI(emitter, backend.pending, approval_timeout_s=3)
        backend.agent = Agent(config, backend.ui)
        backend.ui._steering_hook = backend._steering_applied
        backend._queue, backend._steer_payloads = [], {}
        backend._worker, backend._foreground_worker, backend._turn_n = None, None, 0
        backend._turn_lock, backend.workspace_trusted = threading.RLock(), True
        backend._emit_context = lambda: None
        self.backend, self.agent = backend, backend.agent
        self.addCleanup(self.agent.mcp.stop_all)

        def stop():
            backend.dispatch({"type": "cancel"})
            worker = backend._worker
            if worker and worker is not threading.current_thread():
                worker.join(5)
        self.addCleanup(stop)

    def wait(self, kind, **fields):
        with self.condition:
            self.assertTrue(self.condition.wait_for(lambda: any(
                event["type"] == kind and all(event.get(k) == v for k, v in fields.items())
                for event in self.events), timeout=5), (kind, fields, self.events))
            return next(event for event in self.events if event["type"] == kind
                        and all(event.get(k) == v for k, v in fields.items()))

    def test_the_founder_prompt_raises_the_card_and_the_choice_returns(self):
        requests = []

        def chat(messages, **kwargs):
            requests.append({"tools": names(kwargs.get("tools")), "messages": copy.deepcopy(messages)})
            if len(requests) == 1 and "propose_options" in requests[0]["tools"]:
                return ChatResult(content="", finish_reason="tool_calls", tool_calls=[
                    ToolCall("pick", "propose_options",
                             {"question": "Which approach?", "options": ["Approach A", "Approach B"]})])
            return ChatResult(content="Going with it.")
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.backend.dispatch({"type": "prompt", "text": FOUNDER, "request_id": "ask"})
            request = self.wait("options_request")
            question = request["questions"][0]
            self.assertEqual(question["question"], "Which approach?")
            self.assertEqual([option["label"] for option in question["options"]], ["Approach A", "Approach B"])
            self.backend.dispatch({"type": "options_response", "id": request["id"],
                                   "answers": {question["id"]: {"selected": [1], "other": ""}}})
            self.wait("turn_end", reason="completed")
        self.assertIn("propose_options", requests[0]["tools"])
        self.assertEqual(len(requests), 2)
        self.assertIn('chose "Approach B"', str(requests[1]["messages"]))

    def test_full_auto_ask_raises_the_structured_v14_picker(self):
        # The picker the ask opens in full-auto is the v14 one: labels with descriptions, the
        # recommendation flagged, several questions in one card, and the structured answer returns.
        requests = []
        ask = {"questions": [
            {"header": "Database", "question": "Which database?", "options": [
                {"label": "SQLite (Recommended)", "description": "One file, nothing to run."},
                {"label": "Postgres", "description": "A server to operate."}]},
            {"header": "Checks", "question": "Which checks should run?", "multi_select": True, "options": [
                {"label": "Unit tests", "description": "Fast."},
                {"label": "Browser tests", "description": "Slow but end to end."}]}]}

        def chat(messages, **kwargs):
            requests.append({"tools": names(kwargs.get("tools")), "messages": copy.deepcopy(messages)})
            if len(requests) == 1 and "propose_options" in requests[0]["tools"]:
                return ChatResult(content="", finish_reason="tool_calls",
                                  tool_calls=[ToolCall("pick", "propose_options", copy.deepcopy(ask))])
            return ChatResult(content="Going with it.")
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.backend.dispatch({"type": "prompt", "text": FOUNDER, "request_id": "ask"})
            request = self.wait("options_request")
            first, second = request["questions"]
            self.assertEqual([(o["label"], o["description"], o["recommended"]) for o in first["options"]],
                             [("SQLite", "One file, nothing to run.", True),
                              ("Postgres", "A server to operate.", False)])
            self.assertTrue(second["multi_select"])
            self.backend.dispatch({"type": "options_response", "id": request["id"], "answers": {
                first["id"]: {"selected": [1], "other": ""},
                second["id"]: {"selected": [0, 1], "other": ""}}})
            resolved = self.wait("options_resolved")
            self.assertEqual(resolved["outcome"], "answered")
            self.wait("turn_end", reason="completed")
        self.assertIn("propose_options", requests[0]["tools"])
        self.assertNotIn("propose_options", requests[1]["tools"], "one round answers the full-auto ask")
        result = next(m for m in requests[1]["messages"] if m.get("role") == "tool")["content"]
        self.assertIn('Which database? chose "Postgres" (you recommended "SQLite")', result)
        self.assertIn('chose "Unit tests", "Browser tests"', result)


if __name__ == "__main__":
    unittest.main()
