"""The small known issues fixed before 0.51.0: what each surface says, not how it is drawn (editors/vscode/test has that)."""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dgc import model_errors
from dgc import pip_chat
from dgc.ui import arg_summary


class FailedTurnDetails(unittest.TestCase):
    """Details shows all of a failure (bounded), not the line's first 300 characters, and no secret."""

    def row(self, message, code="worker_failed"):
        return (json.dumps({"code": code, "message": message}),)

    def test_the_line_stays_short_and_details_has_the_rest(self):
        text = "cannot connect to http://127.0.0.1:1/v1 " + "x" * 500 + " Failed to establish a new connection"
        row = self.row(text)
        self.assertEqual(len(pip_chat.failure_text(row)), 300)
        detail = pip_chat.failure_detail(row)
        self.assertTrue(detail.endswith("Failed to establish a new connection"), detail[-60:])

    def test_a_short_failure_has_nothing_more_to_say(self):
        self.assertEqual(pip_chat.failure_detail(self.row("HTTP 401 from the provider")), "")
        self.assertEqual(pip_chat.failure_detail(self.row("x" * 400, "interrupted")), "", "its own words replaced it")
        self.assertEqual(pip_chat.failure_detail((None,)), "")
        self.assertEqual(pip_chat.failure_detail(("not json",)), "")

    def test_details_is_bounded(self):
        self.assertEqual(len(pip_chat.failure_detail(self.row("y" * 50_000))), pip_chat.FAILURE_DETAIL_CHARS)

    def test_a_secret_and_a_credentialed_url_stay_out(self):
        secret = "sk-supersecretvalue1234567890"
        text = f"HTTP 401 https://user:pw@example.com/v1?key=abc said bad key {secret} " + "z" * 400
        with mock.patch.dict(os.environ, {"SOME_API_KEY": secret}):
            detail = pip_chat.failure_detail(self.row(text))
        self.assertNotIn(secret, detail)
        self.assertNotIn("user:pw", detail)
        self.assertNotIn("key=abc", detail)

    def test_chatdgc_keeps_the_whole_failure_too(self):
        from dgc.chatdgc.engine import _failure_text
        secret = "sk-supersecretvalue1234567890"
        tail = "Failed to establish a new connection"
        with mock.patch.dict(os.environ, {"SOME_API_KEY": secret}):
            text = _failure_text(RuntimeError(f"cannot connect {secret} " + "q" * 500 + " " + tail))
        self.assertTrue(text.startswith("The model didn't answer: "))
        self.assertTrue(text.endswith(tail), text[-60:])
        self.assertNotIn(secret, text)
        self.assertLessEqual(len(_failure_text(RuntimeError("w" * 50_000))), 2100)


class PipCardsSayWhichPip(unittest.TestCase):
    """A main chat's Allow card and step name the Pip, read from DGC's records; never its id."""
    PIP = "pip_" + "a" * 32
    RUN = "run_" + "b" * 32

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        path = Path(self.tmp.name) / "registry.sqlite3"
        db = sqlite3.connect(path)
        db.executescript("CREATE TABLE pips(id TEXT, current_version INT); CREATE TABLE pip_versions(pip_id TEXT, version INT, definition TEXT);"
                         "CREATE TABLE pip_runs(id TEXT, pip_id TEXT);")
        db.execute("INSERT INTO pips VALUES(?,1)", (self.PIP,))
        db.execute("INSERT INTO pip_versions VALUES(?,1,?)", (self.PIP, json.dumps({"name": "Order Keeper"})))
        db.execute("INSERT INTO pip_runs VALUES(?,?)", (self.RUN, self.PIP))
        db.commit(); db.close()
        patcher = mock.patch("dgc.workspace_registry.state_directory", lambda: Path(self.tmp.name))
        patcher.start(); self.addCleanup(patcher.stop)

    def test_every_tool_that_asks_says_what_it_does_without_an_id(self):
        said = {
            "pause_pip": ({"pip_id": self.PIP}, "Pause Pip “Order Keeper”"),
            "resume_pip": ({"pip_id": self.PIP}, "Resume Pip “Order Keeper”"),
            "attach_pip_to_session": ({"pip_id": self.PIP}, "Attach Pip “Order Keeper” to this chat"),
            "run_pip_now": ({"pip_id": self.PIP}, "Run Pip “Order Keeper” now"),
            "handoff_to_pip": ({"target_pip_id": self.PIP}, "Hand work to Pip “Order Keeper”"),
            "pips_adapt": ({"pip_id": self.PIP, "changes": {"name": "Seeds"}}, "Change Pip “Order Keeper”: name → Seeds"),
            "draft_pip_email": ({"source_run_id": self.RUN, "message": {"recipient_email": "a@example.com"}}, "Save an email draft to a@example.com"),
            "draft_pip_calendar_event": ({"source_run_id": self.RUN, "event": {"summary": "Sow peas"}}, "Save a calendar draft: Sow peas"),
            "draft_pip_connector_action": ({"source_run_id": self.RUN, "action": {"server": "zapier", "call": {"tool": "add_row"}}}, "Save an action draft: add_row in zapier"),
        }
        for tool, (args, words) in said.items():
            with self.subTest(tool):
                self.assertEqual(arg_summary(tool, args), words)

    def test_an_unreadable_pip_is_a_pip_never_its_id(self):
        line = arg_summary("resume_pip", {"pip_id": "pip_" + "c" * 32})
        self.assertEqual(line, "Resume a Pip")

    def test_the_card_args_carry_the_name_from_dgcs_records_not_the_models(self):
        from dgc.agent import Agent, PIP_NAMED_TOOLS
        with_name = Agent._with_task_agent
        stub = mock.Mock(spec=[])
        for tool, key in PIP_NAMED_TOOLS.items():
            ident = self.RUN if key == "source_run_id" else self.PIP
            with self.subTest(tool):
                args = {key: ident, "reason": "because", "pip_name": "A name the model made up"}
                shown = with_name(stub, tool, args)
                self.assertEqual(shown["pip_name"], "Order Keeper")
                self.assertEqual(args["pip_name"], "A name the model made up", "a copy, for the screen only")
        unknown = with_name(stub, "resume_pip", {"pip_id": "pip_" + "c" * 32, "pip_name": "Made up"})
        self.assertNotIn("pip_name", unknown)

    def test_a_rule_still_names_the_pip_by_its_id(self):
        from dgc.permissions import rule_for
        self.assertEqual(rule_for("resume_pip", {"pip_id": self.PIP, "pip_name": "Order Keeper"}), f"PipsResume({self.PIP})")


class TerminalAdviceInTheEditor(unittest.TestCase):
    """markdown.ts editorAdvice replaces these exact phrases on an editor's screen; the terminal keeps them."""

    def test_the_phrases_the_editor_replaces_are_the_ones_hint_for_writes(self):
        source = (Path(__file__).resolve().parent.parent / "editors/vscode/src/markdown.ts").read_text(encoding="utf-8")
        start = source.index("const TERMINAL_ADVICE"); table = source[start:source.index("];", start)]
        hints = {kind: model_errors.hint_for(kind, model="m:1", base_url="http://127.0.0.1:1/v1")
                 for kind in ("connect", "dns", "reset", "stream_cut", "model_not_found", "auth", "http")}
        self.assertIn("`dgc --model NAME`, or run `dgc setup`", hints["model_not_found"])
        self.assertIn(", pick one with \\/model or `dgc --model NAME`, or run `dgc setup`", table)
        self.assertIn("`dgc --api-key-env NAME` or DGC_API_KEY", hints["auth"])
        self.assertIn("set it with \\/connect, `dgc --api-key-env NAME` or DGC_API_KEY", table)
        for kind in ("connect", "dns", "reset", "stream_cut"):
            self.assertRegex(hints[kind], r"; `dgc doctor` checks (both|it)$")
        self.assertIn("`dgc doctor` shows what it offers", hints["http"])
        self.assertIn("; `dgc doctor` shows what it offers", table)


if __name__ == "__main__":
    unittest.main()
