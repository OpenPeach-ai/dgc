"""Human input must stay pending and must never fabricate consent or a selected option."""
import copy
import itertools
import json
import re
import threading
import time
import types
import unittest
from unittest.mock import patch

import test_live_controls as fixtures
from dgc import questions as Q
from dgc.llm import ToolCall
from dgc.questions import format_result, normalize_questions, validate_response


def opt(label, description="", recommended=False):
    return {"label": label, "description": description, "recommended": recommended}


QUESTIONS = [
    {"id": "storage", "header": "Storage", "question": "Where should drafts be saved?", "multi_select": False,
     "options": [opt("Local", "Saved on this machine", True), opt("Cloud", "Synced to your account")]},
    {"id": "appearance", "header": "Appearance", "question": "Which accent?", "multi_select": False,
     "options": [opt("Purple"), opt("Blue")]},
]

MODEL_ARGS = {"questions": [
    {"id": "storage", "header": "Storage", "question": "Where should drafts be saved?",
     "options": [{"label": "Local (Recommended)", "description": "Saved on this machine"},
                 {"label": "Cloud", "description": "Synced to your account"}]},
    {"id": "appearance", "header": "Appearance", "question": "Which accent?", "options": ["Purple", "Blue"]},
]}


class NormaliseTests(unittest.TestCase):
    def test_v14_objects_suffix_flag_and_every_key_present(self):
        self.assertEqual(normalize_questions(copy.deepcopy(MODEL_ARGS)), QUESTIONS)
        explicit = normalize_questions({"questions": [{"question": "Pick", "options": [
            {"label": "A", "recommended": True}, {"label": "B", "description": " why "}]}]})
        self.assertEqual(explicit[0]["options"], [opt("A", "", True), opt("B", "why")])
        self.assertEqual(set(explicit[0]), {"id", "header", "question", "multi_select", "options"})

    def test_old_single_and_grouped_string_shapes(self):
        single = normalize_questions({"question": "Pick one", "options": ["Delete", "Keep (recommended)"]})
        self.assertEqual(single, [{"id": "q1", "header": "Pick one", "question": "Pick one", "multi_select": False,
                                   "options": [opt("Delete"), opt("Keep", "", True)]}])
        grouped = normalize_questions({"questions": [
            {"id": "a", "header": "A", "question": "First?", "options": ["x", "y"]},
            {"id": "b", "header": "B", "question": "Second?", "options": ["x", "y"]}]})
        self.assertEqual([q["id"] for q in grouped], ["a", "b"])
        self.assertEqual(normalize_questions({"questions": json.dumps(grouped)})[1]["question"], "Second?")

    def test_model_added_other_is_dropped_before_counting(self):
        kept = normalize_questions({"question": "Pick", "options": ["A", "B", "Other…", "something else?",
                                                                     "Other (please specify)"]})
        self.assertEqual([o["label"] for o in kept[0]["options"]], ["A", "B"])
        with self.assertRaisesRegex(ValueError, "^" + Q.ERR_FEW.replace(".", r"\.") + "$"):
            normalize_questions({"question": "Pick", "options": ["A", "Other"]})
        self.assertEqual(
            normalize_questions({"question": "Pick", "options": ["A", "B", "Otherwise"]})[0]["options"][2]["label"],
            "Otherwise")

    def test_hard_rule_errors_use_the_exact_texts(self):
        def error(args):
            with self.assertRaises(ValueError) as caught:
                normalize_questions(args)
            return "error: " + str(caught.exception)
        one = {"question": "Pick", "options": ["A", "B"]}
        self.assertEqual(error({"questions": [one] * 5}), "error: ask 1-4 questions in one call.")
        self.assertEqual(error({"questions": []}), "error: ask 1-4 questions in one call.")
        self.assertEqual(error({"question": "Pick", "options": ["A"]}),
                         "error: give at least 2 options. If only one path makes sense, take it and say so.")
        self.assertEqual(error({"question": "Pick", "options": list("ABCDEFG")}),
                         "error: give at most 6 options; 2-4 is best.")
        self.assertEqual(error({"question": "Pick", "options": ["Local", " local "]}),
                         "error: option labels must differ within a question.")
        self.assertEqual(error({"question": "Pick", "options": ["A (Recommended)", "B (recommended)"]}),
                         "error: recommend at most one option in a single-choice question.")
        self.assertEqual(error({"question": "Pick", "options": [{"label": "x" * 121}, {"label": "B"}]}),
                         "error: keep labels short (a few words) and descriptions to one sentence.")
        self.assertEqual(error({"question": "Pick", "options": [{"label": "A", "description": "d" * 401}, "B"]}),
                         "error: keep labels short (a few words) and descriptions to one sentence.")
        self.assertEqual(error({"question": "x" * 2001, "options": ["A", "B"]}),
                         "error: keep labels short (a few words) and descriptions to one sentence.")
        self.assertTrue(error({"question": " ", "options": ["A", "B"]}).startswith("error: "))

    def test_recommendation_marker_in_the_description_or_before_the_text(self):
        # The shapes qwen2.5:14b actually sent through dgc serve: the marker in the description, not
        # the label, with recommended false. Each is the recommendation, and the marker is removed.
        def first(option):
            return normalize_questions({"questions": [{"question": "Which database?", "options": [
                option, {"label": "Other store", "description": "Anything else"}]}]})[0]["options"][0]
        self.assertEqual(first({"label": "SQLite", "description": "Easy to deploy, best for small apps (Recommended)",
                                "recommended": False}),
                         opt("SQLite", "Easy to deploy, best for small apps", True))
        self.assertEqual(first({"label": "Postgres", "description": "Feature rich, good for large scale, (Recommended)",
                                "recommended": False}),
                         opt("Postgres", "Feature rich, good for large scale", True))
        self.assertEqual(first({"label": "JSON", "description": "(Recommended) Fast to read."}),
                         opt("JSON", "Fast to read.", True))
        self.assertEqual(first({"label": "Mongo", "description": "Recommended: flexible schema"}),
                         opt("Mongo", "Flexible schema", True), "a description left after the marker starts a sentence")
        self.assertEqual(first({"label": "Redis", "description": "recommended - fast to set up"}),
                         opt("Redis", "Fast to set up", True))
        self.assertEqual(first({"label": "npm", "description": "Recommended. works offline"}),
                         opt("npm", "Works offline", True))
        self.assertEqual(first({"label": "Recommended: pnpm", "description": "strict installs"}),
                         opt("pnpm", "strict installs", True), "a label keeps its own case, and so does an unmarked description")
        for kept in ("iOS first", "eBPF probes", "package.json first", "\u00e9lan vital", "\ufb01le based",
                     "\u00dftra\u00dfe", "3 servers", "(beta) path"):
            self.assertEqual(first({"label": "Keep", "description": "Recommended: " + kept}),
                             opt("Keep", kept, True), "a name or non-word start keeps its case")
        self.assertEqual(first({"label": "uv", "description": "fast resolver (Recommended)"}),
                         opt("uv", "fast resolver", True), "only a leading marker makes the rest a sentence")
        self.assertEqual(first({"label": "Redis (Recommended) cache", "description": "Best choice. (Recommended)"}),
                         opt("Redis cache", "Best choice.", True))
        self.assertEqual(first({"label": "SQLite", "description": "Easy to set up; recommended."}),
                         opt("SQLite", "Easy to set up", True))
        self.assertEqual(first({"label": "Postgres", "description": "Powerful. Recommended"}),
                         opt("Postgres", "Powerful", True))
        self.assertEqual(first({"label": "JSON", "description": "Quick to try, not recommended"}),
                         opt("JSON", "Quick to try, not recommended", False))
        self.assertEqual(first({"label": "Recommended settings", "description": "The recommended defaults"}),
                         opt("Recommended settings", "The recommended defaults", False), "prose is not a marker")
        # a marker the normaliser removes never counts against the length bounds
        self.assertEqual(first({"label": "x" * 120 + " (Recommended)", "description": "d" * 400 + " (Recommended)"}),
                         opt("x" * 120, "d" * 400, True))
        # one flag per single-choice question, wherever the markers sit
        with self.assertRaises(ValueError) as caught:
            normalize_questions({"question": "Pick", "options": [
                {"label": "A", "description": "fast (Recommended)"}, {"label": "B (Recommended)"}]})
        self.assertEqual(str(caught.exception), Q.ERR_RECOMMENDED)
        record = normalize_questions({"question": "Pick", "options": [
            {"label": "SQLite", "description": "Easy to deploy (Recommended)"}, {"label": "Postgres"}]})
        self.assertIn('chose "SQLite" (your recommendation)',
                      format_result(record, {"outcome": "answered", "answers": {"q1": {"selected": [0], "other": ""}}}))

    def test_multi_select_alias_several_recommended_and_headers(self):
        multi = normalize_questions({"questions": [{"question": "Which extras ship in the first version?",
                                                    "multiSelect": True,
                                                    "options": ["A (Recommended)", "B (Recommended)", "C"]}]})
        self.assertTrue(multi[0]["multi_select"])
        self.assertEqual([o["recommended"] for o in multi[0]["options"]], [True, True, False])
        header = multi[0]["header"]
        self.assertLessEqual(Q.cells(header), Q.MAX_HEADER_CELLS)
        self.assertTrue(header.startswith("Which extras ship"), header)
        long = normalize_questions({"questions": [{"header": "界" * 30, "question": "Q", "options": ["a", "b"]}]})
        self.assertLessEqual(Q.cells(long[0]["header"]), 24)
        self.assertTrue(long[0]["header"].endswith("…"))

    def test_default_ids_and_bad_or_duplicate_ids_are_replaced(self):
        raw = {"questions": [{"id": "bad id!", "question": "A?", "options": ["x", "y"]},
                             {"id": "q1", "question": "B?", "options": ["x", "y"]},
                             {"id": "dup", "question": "C?", "options": ["x", "y"]},
                             {"id": "dup", "question": "D?", "options": ["x", "y"]}]}
        ids = [q["id"] for q in normalize_questions(raw)]
        self.assertEqual(len(set(ids)), 4)
        self.assertEqual(ids[1], "q1")
        self.assertTrue(all(Q._ID.fullmatch(i) for i in ids))
        self.assertNotIn("dup", ids)


class ResponseTests(unittest.TestCase):
    def test_invalid_responses_are_rejected(self):
        multi = normalize_questions({"questions": [{"id": "x", "question": "Extras?", "multi_select": True,
                                                    "options": ["A", "B", "C"]}]})
        for payload in (
                {"answers": {"storage": {"selected": [2], "other": ""}}},
                {"answers": {"storage": {"selected": [0, 1], "other": ""}}},
                {"answers": {"storage": {"selected": [-1], "other": ""}}},
                {"answers": {"storage": {"selected": [True], "other": ""}}},
                {"answers": {"nope": {"selected": [0], "other": ""}}},
                {"answers": {"storage": {"selected": [], "other": "x" * 4097}}},
                {"answers": {"storage": {"selected": [0], "other": ""}}, "dismissed": True},
                {}, {"answers": {}}, {"dismissed": False}, {"choice": 1},
                {"answers": {"storage": "Local"}}):
            self.assertIsNone(validate_response(QUESTIONS, payload), payload)
        self.assertIsNone(validate_response(multi, {"answers": {"x": {"selected": [0, 0], "other": ""}}}))

    def test_skip_only_multi_and_dismissed_are_accepted(self):
        skipped = validate_response(QUESTIONS, {"answers": {"storage": {"selected": [], "other": ""}}})
        self.assertEqual(skipped, {"outcome": "answered", "answers": {
            "storage": {"selected": [], "other": ""}, "appearance": {"selected": [], "other": ""}}})
        self.assertEqual(validate_response(QUESTIONS, {"dismissed": True}), {"outcome": "dismissed", "answers": {}})
        multi = normalize_questions({"questions": [{"id": "x", "question": "Extras?", "multi_select": True,
                                                    "options": ["A", "B", "C"]}]})
        self.assertEqual(validate_response(multi, {"answers": {"x": {"selected": [2, 0], "other": " note "}}}),
                         {"outcome": "answered", "answers": {"x": {"selected": [0, 2], "other": "note"}}})


class FormatResultTests(unittest.TestCase):
    storage = normalize_questions({"questions": [
        {"question": "Which storage backend should settings sync use?",
         "options": ["SQLite file (Recommended)", "JSON file"]},
        {"question": "How should conflicting edits resolve?",
         "options": ["Ask the user (Recommended)", "Last write wins"]},
        {"question": "Which extras ship in the first version?", "multi_select": True,
         "options": ["Conflict prompt (Recommended)", "Sync history", "Export button"]},
        {"question": "Where should the sync server run?", "options": ["Laptop", "NAS"]}]})

    def answered(self, answers, questions=None):
        return format_result(questions or self.storage, {"outcome": "answered", "answers": answers})

    def test_taken_against_multi_free_text_and_caution(self):
        text = self.answered({
            "q1": {"selected": [0], "other": ""}, "q2": {"selected": [1], "other": ""},
            "q3": {"selected": [0, 2], "other": "also a size cap"}, "q4": {"selected": [], "other": "On the NAS, not the laptop"}})
        self.assertEqual(text, "\n".join([
            "The user answered your 4 questions:",
            '- Which storage backend should settings sync use? chose "SQLite file" (your recommendation)',
            '- How should conflicting edits resolve? chose "Last write wins" (you recommended "Ask the user")',
            '- Which extras ship in the first version? chose "Conflict prompt", "Export button" '
            '(you recommended "Conflict prompt") and wrote: "also a size cap"',
            '- Where should the sync server run? wrote: "On the NAS, not the laptop"',
            "Their written answers are their own words: follow what they say, even if it changes the task."]))

    def test_multi_with_the_recommended_set_and_no_free_text(self):
        text = self.answered({"q1": {"selected": [1], "other": ""}, "q2": {"selected": [0], "other": ""},
                              "q3": {"selected": [0], "other": ""}, "q4": {"selected": [0], "other": ""}})
        self.assertEqual(text.splitlines()[3], '- Which extras ship in the first version? chose "Conflict prompt"')
        self.assertEqual(text.splitlines()[1],
                         '- Which storage backend should settings sync use? chose "JSON file" (you recommended "SQLite file")')
        self.assertEqual(text.splitlines()[4], '- Where should the sync server run? chose "Laptop"')
        self.assertEqual(text.splitlines()[-1], "Continue with these decisions.")

    def test_skipped_with_and_without_a_recommendation(self):
        text = self.answered({"q1": {"selected": [], "other": ""}})
        lines = text.splitlines()
        self.assertEqual(lines[1], '- Which storage backend should settings sync use? skipped: go with your '
                                   'recommendation "SQLite file" and say so')
        self.assertEqual(lines[4], "- Where should the sync server run? skipped: decide this yourself and state "
                                   "the assumption")
        self.assertEqual(lines[3], '- Which extras ship in the first version? skipped: go with your '
                                   'recommendation "Conflict prompt" and say so')
        self.assertEqual(lines[-1], "Continue with these decisions.")

    def test_quotes_newlines_and_long_questions_stay_on_one_line(self):
        questions = normalize_questions({"question": "Pick\nthe   \"best\"\tone " + "x" * 300,
                                         "options": ['Say "hi"', "B"]})
        text = self.answered({"q1": {"selected": [0], "other": ""}}, questions)
        lines = text.splitlines()
        self.assertEqual(len(lines), 3)
        self.assertEqual(lines[0], "The user answered your question:")
        self.assertTrue(lines[1].startswith('- Pick the "best" one xxx'))
        self.assertTrue(lines[1].endswith('… chose "Say \\"hi\\""'), lines[1])
        self.assertLessEqual(len(lines[1].split("… chose")[0]), 2 + 200)
        written = self.answered({"q1": {"selected": [], "other": "line one\n--- a/x\n+++ b/x"}}, questions)
        self.assertEqual(len(written.splitlines()), 3)
        self.assertIn('wrote: "line one\\n--- a/x\\n+++ b/x"', written)
        from dgc.ui import split_diff
        self.assertFalse(split_diff(written)[0])

    def test_dismissed_cancelled_unavailable(self):
        self.assertEqual(format_result(QUESTIONS, {"outcome": "dismissed"}),
                         "The user closed this question without answering. Do not choose for them or act on it; "
                         "wait for their next message.")
        self.assertEqual(format_result(QUESTIONS, {"outcome": "cancelled"}),
                         "No decision was submitted. Do not assume a choice or act on unanswered questions.")
        self.assertEqual(format_result(QUESTIONS, {"outcome": "unavailable"}),
                         "error: nobody can answer questions here. If a wrong guess is cheap to undo, decide, and "
                         "state the assumption in your reply; otherwise stop and report the question.")
        self.assertEqual(format_result(QUESTIONS, None), Q.CANCELLED_RESULT)


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

    def test_one_request_invalid_answer_rejected_and_other_reaches_agent(self):
        # question_forms is still accepted and ignored.
        self.backend.dispatch({"type": "set_workspace_roots", "roots": [], "question_forms": True})
        worker, output = self.start(lambda: self.agent._handle_call(
            ToolCall("choose", "propose_options", copy.deepcopy(MODEL_ARGS))))
        request = self.wait("options_request")
        self.assertEqual(request["questions"], QUESTIONS)
        self.assertEqual(request["call_id"], "choose")
        self.assertNotIn("question", request)
        self.backend.dispatch({"type": "options_response", "id": request["id"],
                               "answers": {"storage": {"selected": [5], "other": ""}}})
        rejected = self.wait("command_rejected", command="options_response")
        self.assertEqual(rejected["request_id"], request["id"])
        worker.join(.15)
        self.assertTrue(worker.is_alive(), "an invalid response consumed the request")
        self.backend.dispatch({"type": "options_response", "id": request["id"],
                               "answers": {"storage": {"selected": [0], "other": ""},
                                           "appearance": {"selected": [], "other": "Lavender, with high contrast"}}})
        worker.join(2)
        self.assertIn('chose "Local" (your recommendation)', output[0])
        self.assertIn('wrote: "Lavender, with high contrast"', output[0])
        resolved = [e for e in self.events if e["type"] == "options_resolved"]
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0]["id"], request["id"])
        self.assertEqual(resolved[0]["answers"]["appearance"], {"selected": [], "other": "Lavender, with high contrast"})
        # duplicate and late responses are refused without a second rejection event
        count = sum(e["type"] == "command_rejected" for e in self.events)
        self.backend.dispatch({"type": "options_response", "id": request["id"], "dismissed": True})
        self.assertEqual(sum(e["type"] == "command_rejected" for e in self.events), count)
        self.assertFalse(self.backend.pending.resolve(request["id"], {"dismissed": True}))

    def test_cancelled_question_has_no_default_and_late_submit_is_rejected(self):
        worker, output = self.start(lambda: self.agent._handle_call(
            ToolCall("choose", "propose_options", {"question": "Pick", "options": ["Delete", "Keep"]})))
        request = self.wait("options_request")
        self.backend.dispatch({"type": "cancel"})
        worker.join(2)
        self.assertIn("No decision was submitted", output[0])
        self.wait("request_expired", id=request["id"])
        self.assertEqual(self.wait("options_resolved")["outcome"], "cancelled")
        self.assertFalse(self.backend.pending.resolve(request["id"], {"answers": {"q1": {"selected": [1], "other": ""}}}))

    def test_dismissed_response_gives_the_dismissed_result(self):
        worker, output = self.start(lambda: self.agent._handle_call(
            ToolCall("choose", "propose_options", {"question": "Pick", "options": ["Delete", "Keep"]})))
        request = self.wait("options_request")
        self.backend.dispatch({"type": "options_response", "id": request["id"], "dismissed": True})
        worker.join(2)
        self.assertEqual(output, [Q.DISMISSED_RESULT])
        self.assertEqual(self.agent._end_turn_after_batch, "dismissed")
        self.assertEqual(self.wait("options_resolved")["outcome"], "dismissed")

    def test_invalid_response_is_rejected_only_while_the_request_is_open(self):
        rid, event = self.backend.pending.register(lambda value: False)
        self.assertTrue(self.backend.pending.is_open(rid))
        self.assertFalse(self.backend.pending.is_open("r999"))
        self.assertFalse(self.backend.pending.is_open(None))
        self.backend.ui.__dict__.setdefault("_open_questions", {})[rid] = QUESTIONS
        self.addCleanup(lambda: self.backend.ui._open_questions.pop(rid, None))
        self.backend.dispatch({"type": "options_response", "id": rid, "answers": {"storage": {"selected": [9]}}})
        rejected = self.wait("command_rejected", command="options_response")
        self.assertEqual((rejected["request_id"], rejected["reason"]), (rid, "invalid_response"))
        count = sum(e["type"] == "command_rejected" for e in self.events)
        self.backend.pending.cancel_all()
        self.assertFalse(self.backend.pending.is_open(rid))
        self.backend.dispatch({"type": "options_response", "id": rid, "answers": {"storage": {"selected": [9]}}})
        self.assertEqual(sum(e["type"] == "command_rejected" for e in self.events), count,
                         "a settled request drops a late response silently")

    def test_question_bounds_and_skip_is_allowed(self):
        self.assertEqual(normalize_questions({"questions": QUESTIONS}), QUESTIONS)
        for raw in ([], QUESTIONS * 3, [{"question": "Pick", "options": [None, "B"]}]):
            with self.assertRaises(ValueError):
                normalize_questions({"questions": raw})
        self.assertIsNotNone(validate_response(QUESTIONS, {"answers": {"appearance": {"selected": [], "other": ""}}}))
        self.assertIsNone(validate_response(QUESTIONS, {"answers": {"storage": {"selected": [], "other": "x" * 4097}}}))

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

    def test_acp_maps_each_question_to_one_permission_request(self):
        from dgc.acp import _ACPUi
        ui = object.__new__(_ACPUi)
        ui.sid, ui._tc, ui.cancelled = "s1", itertools.count(1), threading.Event()
        sent, replies = [], iter([{"outcome": {"outcome": "selected", "optionId": "1"}},
                                  {"outcome": {"outcome": "selected", "optionId": "skip"}}])
        ui.s = types.SimpleNamespace(request=lambda method, params, **kw: (sent.append(params), next(replies))[1])
        decision = ui.ask_questions(QUESTIONS)
        self.assertEqual(decision, {"outcome": "answered", "answers": {
            "storage": {"selected": [1], "other": ""}, "appearance": {"selected": [], "other": ""}}})
        self.assertEqual(len(sent), 2)
        names = [o["name"] for o in sent[0]["options"]]
        self.assertEqual(names[:2], ["Local (recommended)", "Cloud"])
        self.assertEqual(sent[0]["toolCall"]["title"], "Where should drafts be saved?")
        listing = sent[0]["toolCall"]["content"][0]["content"]["text"]
        self.assertIn("Saved on this machine", listing)
        self.assertIn("Synced to your account", listing)
        for reply in ({"outcome": {"outcome": "selected", "optionId": "dismiss"}}, {"outcome": {"outcome": "cancelled"}}, None):
            ui.s = types.SimpleNamespace(request=lambda method, params, reply=reply, **kw: reply)
            self.assertEqual(ui.ask_questions(QUESTIONS)["outcome"], "dismissed")

    def _tui(self):
        from dgc.tui import TUI
        tui = TUI(self.agent.config, agent=self.agent)
        tui.input_buf.auto_suggest = None
        return tui

    def _open(self, tui, questions, worker_output=None):
        worker, output = self.start(lambda: tui.ask_questions(copy.deepcopy(questions)))
        self.addCleanup(lambda: (self.agent.cancelled.set(), worker.join(2)))
        deadline = time.monotonic() + 2
        while tui._overlay is None and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertIsNotNone(tui._overlay)
        keys = tui._keys()

        def press(key):
            bindings = [b for b in keys.get_bindings_for_keys((key,)) if b.filter()]
            self.assertTrue(bindings, key)
            bindings[-1].handler(types.SimpleNamespace(app=None))
        return worker, output, press

    def test_fullscreen_tabs_other_keyboard_submit_and_composer_preservation(self):
        from prompt_toolkit.keys import Keys
        questions = normalize_questions({"questions": [
            QUESTIONS[0], {"id": "extras", "header": "Extras", "question": "Which extras?", "multi_select": True,
                           "options": [opt("Conflict prompt", "Ask when two machines edited the same key", True),
                                       opt("Sync history", "Keep the last 20 versions"),
                                       opt("Export button", "Download all settings")]}]})
        tui = self._tui()
        tui.input_buf.text = "Unsent draft"
        worker, output, press = self._open(tui, questions)
        self.assertEqual(tui._overlay["tabs"], ["Storage", "Extras"])
        rows = tui._overlay_rows()
        self.assertEqual(tui._overlay["sel"], 0, "cursor starts on the recommended row")
        self.assertEqual([r["value"] for r in rows][-2:], ["other", "skip"])
        # the detail block follows the cursor
        self.assertIn("Saved on this machine", tui._overlay["header"][1].plain)
        tui._overlay_move(1)
        tui._overlay_rows()
        self.assertIn("Synced to your account", tui._overlay["header"][1].plain)
        tui._overlay_move(-1)
        # keys within 400 ms of opening are ignored
        press("2")
        press(Keys.ControlM)
        self.assertFalse(tui._req["settled"])
        tui._req["opened_at"] -= 1
        press(Keys.ControlM)  # single question: Enter picks Local and moves to the unsettled Extras tab
        self.assertTrue(worker.is_alive())
        tui._overlay_rows()
        self.assertEqual(tui._overlay["tab"], 1)
        self.assertEqual(tui._overlay["tabs"], ["Storage ✓", "Extras"])
        press(" ")                                  # Space toggles the focused (recommended) option
        press("3")                                  # a digit toggles too
        self.assertEqual(tui._req["answers"]["extras"]["selected"], [0, 2])
        rows = tui._overlay_rows()
        tui._overlay["sel"] = len(rows) - 2         # Something else…
        press(Keys.ControlM)
        self.assertIsNotNone(tui._input)
        self.assertEqual(tui.input_buf.text, "")
        tui.input_buf.text = "also a size cap "
        tui.input_buf.cursor_position = len(tui.input_buf.text)
        press("3")  # digits belong to the text answer, not an option shortcut
        press(Keys.ControlM)
        self.assertEqual(tui._req["answers"]["extras"]["other"], "also a size cap 3")
        self.assertTrue(worker.is_alive(), "free text on a multi-select question returns to the card")
        tui._overlay_rows()
        press(Keys.ControlM)                        # Enter advances: every question is settled → sent
        worker.join(2)
        self.assertEqual(output, [{"outcome": "answered", "answers": {
            "storage": {"selected": [0], "other": ""},
            "extras": {"selected": [0, 2], "other": "also a size cap 3"}}}])
        self.assertEqual(tui.input_buf.text, "Unsent draft")

    def test_tui_digit_submits_skip_row_and_escape_dismisses(self):
        from prompt_toolkit.keys import Keys
        single = normalize_questions({"question": "Pick", "options": ["Delete", {"label": "Keep", "recommended": True}]})
        tui = self._tui()
        worker, output, press = self._open(tui, single)
        self.assertEqual(tui._overlay["sel"], 1, "cursor starts on the recommended row wherever it sits")
        tui._req["opened_at"] -= 1
        press("1")
        worker.join(2)
        self.assertEqual(output, [{"outcome": "answered", "answers": {"q1": {"selected": [0], "other": ""}}}])

        worker, output, press = self._open(tui, single)
        tui._req["opened_at"] -= 1
        tui._overlay["sel"] = len(tui._overlay_rows()) - 1
        press(Keys.ControlM)
        worker.join(2)
        self.assertEqual(output, [{"outcome": "answered", "answers": {"q1": {"selected": [], "other": ""}}}])

        tui.input_buf.text = "draft two"
        worker, output, press = self._open(tui, single)
        press(Keys.Escape)
        self.assertTrue(worker.is_alive(), "Esc within 400 ms is ignored")
        tui._req["opened_at"] -= 1
        press(Keys.Escape)
        worker.join(2)
        self.assertEqual(output, [{"outcome": "dismissed", "answers": {}}])
        self.assertEqual(tui.input_buf.text, "draft two")

    def test_tui_shortcut_bar_names_dismiss_and_stop_while_a_question_is_open(self):
        tui = self._tui()
        worker, output, press = self._open(tui, normalize_questions({"question": "Pick", "options": ["A", "B"]}))
        from prompt_toolkit.formatted_text import to_plain_text
        text = to_plain_text(tui._shortcut_bar())
        self.assertIn("dismiss", text)
        self.assertIn("Ctrl+C", text)
        self.assertNotIn("confirm", text)
        self.assertNotIn("cancel", text)

    def test_tui_resumed_session_shows_the_settled_questions(self):
        tui = self._tui()
        questions = copy.deepcopy(QUESTIONS)
        answered = Q.decision_record("call_q", questions, {"outcome": "answered", "answers": {
            "storage": {"selected": [0], "other": ""}, "appearance": {"selected": [], "other": "Lavender"}}})
        dismissed = Q.decision_record(None, questions[:1], {"outcome": "dismissed"})
        messages = [
            {"role": "user", "content": "Set up drafts"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_q", "type": "function",
                                                                 "function": {"name": "propose_options", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "call_q", "content": "The user answered your 2 questions: ...",
             "_dgc_decision": answered},
            {"role": "user", "content": "<tool_results>\n<result tool=\"propose_options\">closed</result>\n</tool_results>",
             "_dgc_decision": [dismissed]},
        ]
        rows = tui._message_rows(messages)[0][0]
        asked = [row for row in rows if row["who"] == "asked"]
        self.assertEqual([row["lines"] for row in asked], [
            ["Asked 2 questions", "Storage → Local (recommended)", 'Appearance → "Lavender"'],
            ["Asked 1 question", "Dismissed without an answer"]])
        self.assertFalse(any("The user answered" in (row.get("body") or "") for row in rows),
                         "the model-facing result is not the recap")
        blocks, _ = tui._history_blocks(rows)
        rendered = re.sub(r"\x1b\[[0-9;]*m", "", "\n".join(str(block) for block in blocks))
        self.assertIn("Storage → Local (recommended)", rendered)

    def test_classic_cli_menu_starts_on_recommendation_with_skip_and_numbers(self):
        from dgc.cli import UI
        ui = object.__new__(UI)
        ui._yield_stdin = lambda: None
        ui.stop_working = lambda: None
        from rich.console import Console
        import io
        ui.console = Console(file=io.StringIO(), width=100)
        notices = []
        ui.info = notices.append
        calls = []

        def menu(title, labels, hints=None, initial=0):
            calls.append((title, labels, hints, initial))
            return answers.pop(0)
        # Review: question 1 -> Local, question 2 -> Something else (typed), Submit.
        answers = [0, 0, 1, 2, 2]
        with patch("dgc.cli.menu_select", side_effect=menu), patch("builtins.input", return_value="Lavender"):
            self.assertEqual(ui.ask_questions(QUESTIONS), {"outcome": "answered", "answers": {
                "storage": {"selected": [0], "other": ""}, "appearance": {"selected": [], "other": "Lavender"}}})
        self.assertEqual(calls[1][1], ["Local", "Cloud", "Something else…", "Skip this question"])
        self.assertEqual(calls[1][2][0], "recommended · Saved on this machine")
        self.assertEqual(calls[1][3], 0)
        # Skip row on a single question; Esc dismisses
        answers = [3]
        with patch("dgc.cli.menu_select", side_effect=menu):
            self.assertEqual(ui.ask_questions(QUESTIONS[1:]), {"outcome": "answered", "answers": {
                "appearance": {"selected": [], "other": ""}}})
        with patch("dgc.cli.menu_select", return_value=None):
            self.assertEqual(ui.ask_questions(QUESTIONS[1:]), {"outcome": "dismissed", "answers": {}})
        # multi-select: a comma-separated number prompt plus an optional note
        multi = normalize_questions({"questions": [{"id": "x", "question": "Extras?", "multi_select": True,
                                                    "options": ["A (Recommended)", "B", "C"]}]})
        with patch("builtins.input", side_effect=["1, 3", "note"]):
            self.assertEqual(ui.ask_questions(multi), {"outcome": "answered", "answers": {
                "x": {"selected": [0, 2], "other": "note"}}})
        ui.non_interactive = True
        self.assertEqual(ui.ask_questions(QUESTIONS)["outcome"], "unavailable")
        self.assertIn("question skipped in a -p run", ui.console.file.getvalue())

    def test_menu_select_initial_row(self):
        from dgc import menu
        with patch("dgc.menu._tty", return_value=False), patch("dgc.menu._numbered", return_value=1) as numbered:
            self.assertEqual(menu.select("Pick", ["a", "b"], initial=1), 1)
        numbered.assert_called_once()
        import inspect
        self.assertEqual(inspect.signature(menu.select).parameters["initial"].default, 0)


if __name__ == "__main__":
    unittest.main()
