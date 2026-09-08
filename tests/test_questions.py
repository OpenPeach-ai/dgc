"""Human input must stay pending and must never fabricate consent or a selected option."""
import copy
import itertools
import threading
import time
import types
import unittest
from unittest.mock import patch

import test_live_controls as fixtures
from dgc.llm import ToolCall
from dgc.questions import normalize_questions, valid_answers


QUESTIONS = [
    {"id": "storage", "header": "Storage", "question": "Where should drafts be saved?", "options": ["Local", "Cloud"]},
    {"id": "appearance", "header": "Appearance", "question": "Which accent?", "options": ["Purple", "Blue"]},
]


class QuestionTests(unittest.TestCase):
    setUp = fixtures.LiveControlTests.setUp
    wait = fixtures.LiveControlTests.wait

    def start(self, fn):
        output = []
        worker = threading.Thread(target=lambda: output.append(fn()), daemon=True)
        worker.start()
        self.addCleanup(lambda: (self.backend.pending.cancel_all(), worker.join(2)))
        return worker, output

    def test_plan_and_permissions_survive_timeout_and_late_human_reply(self):
        self.backend.ui.approval_timeout_s = .01
        for kind, fn, payload, expected in [
            ("plan_proposal", lambda: self.backend.ui.present_plan("Review this plan"), {"decision": "default"}, "default"),
            ("permission_request", lambda: self.backend.ui.approve("write", {"path": "draft.txt"}), {"decision": "once"}, "once"),
        ]:
            worker, output = self.start(fn)
            request = self.wait(kind)
            worker.join(.25)  # exceeds the configured timeout by 25x
            self.assertTrue(worker.is_alive())
            self.assertFalse(any(e["type"] == "request_expired" for e in self.events))
            self.assertTrue(self.backend.pending.resolve(request["id"], payload))
            worker.join(2)
            self.assertEqual(output, [expected])
            self.assertFalse(self.backend.pending.resolve(request["id"], payload))

    def test_group_answers_are_atomic_validated_and_other_reaches_agent(self):
        self.backend.dispatch({"type": "set_workspace_roots", "roots": [], "question_forms": True})
        worker, output = self.start(lambda: self.agent._handle_call(
            ToolCall("choose", "propose_options", {"questions": copy.deepcopy(QUESTIONS)})))
        request = self.wait("options_request")
        self.assertEqual(request["questions"], QUESTIONS)
        self.backend.dispatch({"type": "options_response", "id": request["id"], "answers": {"storage": "Local"}})
        worker.join(.15)
        self.assertTrue(worker.is_alive(), "partial response consumed the form")
        self.backend.dispatch({"type": "options_response", "id": request["id"],
                               "answers": {"storage": "Local", "appearance": "Lavender, with high contrast"}})
        worker.join(2)
        self.assertIn("Lavender, with high contrast", output[0])
        self.assertIn('"storage": "Local"', output[0])

    def test_cancelled_question_has_no_default_and_late_submit_is_rejected(self):
        worker, output = self.start(lambda: self.agent._handle_call(
            ToolCall("choose", "propose_options", {"question": "Pick", "options": ["Delete", "Keep"]})))
        request = self.wait("options_request")
        self.backend.dispatch({"type": "cancel"})
        worker.join(2)
        self.assertIn("No decision was submitted", output[0])
        self.assertFalse(self.backend.pending.resolve(request["id"], {"choice": 1}))

    def test_old_client_receives_separate_compatible_questions(self):
        worker, output = self.start(lambda: self.backend.ui.propose_questions(QUESTIONS))
        first = self.wait("options_request", question=QUESTIONS[0]["question"])
        self.assertNotIn("questions", first)
        self.backend.dispatch({"type": "options_response", "id": first["id"], "choice": 1})
        second = self.wait("options_request", question=QUESTIONS[1]["question"])
        self.backend.dispatch({"type": "options_response", "id": second["id"], "choice": "Custom accent"})
        worker.join(2)
        self.assertEqual(output, [{"storage": "Local", "appearance": "Custom accent"}])

    def test_question_bounds_and_no_missing_or_blank_answers(self):
        self.assertEqual(normalize_questions({"questions": QUESTIONS}), QUESTIONS)
        for raw in ([], QUESTIONS * 4, [QUESTIONS[0], QUESTIONS[0]], [{"question": "Pick", "options": [None]}]):
            with self.assertRaises(ValueError):
                normalize_questions({"questions": raw})
        for answers in ({}, {"storage": "Local", "appearance": " "}, {"storage": "Local", "appearance": "x" * 4097}):
            self.assertFalse(valid_answers(QUESTIONS, answers))

    def test_acp_human_wait_is_cancellable_without_a_timeout(self):
        from dgc.acp import ACPServer
        server = object.__new__(ACPServer)
        server._rid, server._pending_lock, server._pending = itertools.count(1), threading.Lock(), {}
        sent = threading.Event()
        server._write = lambda msg: sent.set()
        cancelled = threading.Event()
        worker, output = self.start(lambda: server.request("session/request_permission", {"sessionId": "fixture"},
                                                           timeout=None, cancel=cancelled))
        self.addCleanup(lambda: (cancelled.set(), worker.join(2)))
        self.assertTrue(sent.wait(2))
        worker.join(.15)
        self.assertTrue(worker.is_alive())
        cancelled.set()
        worker.join(2)
        self.assertEqual(output, [None])
        self.assertEqual(server._pending, {})

    def test_fullscreen_tabs_other_keyboard_submit_and_composer_preservation(self):
        from dgc.tui import TUI
        from prompt_toolkit.keys import Keys
        tui = TUI(self.agent.config, agent=self.agent)
        tui.input_buf.auto_suggest = None
        tui.input_buf.text = "Unsent draft"
        worker, output = self.start(lambda: tui.propose_questions(QUESTIONS))
        self.addCleanup(lambda: (self.agent.cancelled.set(), worker.join(2)))
        deadline = time.monotonic() + 2
        while tui._overlay is None and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(tui._overlay["tabs"], ["Storage", "Appearance"])
        keys = tui._keys()
        def press(key):
            bindings = [b for b in keys.get_bindings_for_keys((key,)) if b.filter()]
            self.assertTrue(bindings)
            bindings[-1].handler(types.SimpleNamespace())
        press(Keys.ControlM)  # select Local; do not submit
        self.assertTrue(worker.is_alive())
        press(Keys.ControlI)  # Tab -> Appearance
        tui._overlay_rows()
        self.assertEqual(tui._overlay["tab"], 1)
        tui._overlay["sel"] = 2  # Other
        press(Keys.ControlM)
        self.assertIsNotNone(tui._input)
        self.assertEqual(tui.input_buf.text, "")
        tui.input_buf.text = "Lavender "
        tui.input_buf.cursor_position = len(tui.input_buf.text)
        press("3")  # digits belong to the text answer, not an option shortcut
        press(Keys.ControlM)
        self.assertEqual(tui._req["answers"]["appearance"], "Lavender 3")
        self.assertTrue(worker.is_alive())
        tui._overlay["sel"] = len(tui._overlay_rows()) - 1
        press(Keys.ControlM)
        worker.join(2)
        self.assertEqual(output, [{"storage": "Local", "appearance": "Lavender 3"}])
        self.assertEqual(tui.input_buf.text, "Unsent draft")

    def test_classic_cli_other_and_batch_review_submit(self):
        from dgc.cli import UI
        ui = object.__new__(UI)
        ui._yield_stdin = lambda: None
        notices = []
        ui.info = notices.append
        # Premature Submit -> question 1 -> Local -> question 2 -> Other -> Submit.
        with patch("dgc.cli.menu_select", side_effect=[2, 0, 0, 1, 2, 2]), patch("builtins.input", return_value="Lavender"):
            self.assertEqual(ui.propose_questions(QUESTIONS), {"storage": "Local", "appearance": "Lavender"})
        self.assertEqual(len(notices), 1)
        with patch("dgc.cli.menu_select", return_value=None):
            self.assertEqual(ui.propose_options("Pick", ["Delete", "Keep"]), "")
