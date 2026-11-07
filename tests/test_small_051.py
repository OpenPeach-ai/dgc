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


class ProviderAnswers(unittest.TestCase):
    """Details gets all of a provider's answer; the sentence the terminal, logs and a Pip's report read does not change."""
    BODY = '{"error": "' + "This request was refused by the gateway. " * 40 + 'End of the refusal."}'
    SECRET_URL = "see https://user:pw@example.com/v1?key=abc for help "

    def serve(self, status, body):
        import http.server
        import threading

        class Handler(http.server.BaseHTTPRequestHandler):
            def _answer(self):
                size = int(self.headers.get("content-length") or 0)
                if size:
                    self.rfile.read(size)
                data = body.encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            do_GET = do_POST = _answer

            def log_message(self, *args):
                pass
        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}/v1"

    def fail(self, status, body=None, *, mode="chat_completions"):
        from dgc.llm import LLMClient, LLMError
        client = LLMClient(self.serve(status, self.BODY if body is None else body), "k", "m:1", api_mode=mode)
        with mock.patch("dgc.llm._wait_for_retry", lambda *a, **k: True):
            with self.assertRaises(LLMError) as caught:
                client.chat([{"role": "user", "content": "hi"}], [])
        return caught.exception

    def test_the_sentence_stays_short_and_the_long_form_is_beside_it(self):
        for status, words, keep in ((401, "HTTP 401 from ", 400), (404, "HTTP 404 from ", 400), (500, " after 4 tries: ", 400),
                                    (429, "429 rate limited: ", 200), (400, "400 from server: ", 600)):
            with self.subTest(status=status):
                exc = self.fail(status)
                said = str(exc)
                self.assertIn(words, said)
                self.assertTrue(said.endswith(self.BODY[:keep]), said[-60:])
                self.assertEqual(model_errors.plain_failure(said), model_errors.plain_failure(said[:len(said) - keep] + self.BODY[:keep]))
                self.assertTrue(exc.full_text.endswith("End of the refusal.\"}"), exc.full_text[-40:])
                self.assertEqual(exc.full_text[:len(said)], said, "the same sentence, carried on")
                self.assertEqual(exc.cause.full, exc.full_text)
                self.assertLessEqual(len(exc.cause.detail), 700, "detail is what it was: the retry row and the terminal's blocks read it")
                self.assertNotIn("End of the refusal", exc.cause.detail)
                self.assertEqual(exc.cause.as_dict()["full"], exc.full_text)

    def test_a_short_answer_has_no_long_form(self):
        exc = self.fail(401, "bad key")
        self.assertFalse(hasattr(exc, "full_text"))
        self.assertNotIn("full", exc.cause.as_dict())

    def test_the_long_form_is_scrubbed_and_bounded(self):
        from dgc.llm import ERROR_DETAIL_CHARS
        exc = self.fail(401, "x" * 500 + self.SECRET_URL + "y" * 5000)
        self.assertNotIn("user:pw", exc.full_text)
        self.assertNotIn("key=abc", exc.full_text)
        self.assertLessEqual(len(str(exc)), 480)
        self.assertLessEqual(len(exc.full_text), ERROR_DETAIL_CHARS + 100)

    def test_chatdgc_reads_the_long_form_and_its_terminal_keeps_its_line(self):
        from dgc.chat_cli import _terminal_line
        from dgc.chatdgc.engine import _failure_text
        text = _failure_text(self.fail(401))
        self.assertIn("End of the refusal", text)
        line = _terminal_line(text)
        self.assertEqual(len(line), len("The model didn't answer: ") + 300)
        self.assertEqual(_terminal_line("Something else " * 50), "Something else " * 50)

    def test_a_pip_details_reads_the_long_form_and_its_line_stays(self):
        whole = "HTTP 401 from x: " + "z" * 1500 + " End of the refusal.\n  → hint"
        short = whole[:417] + "\n  → hint"
        row = (json.dumps({"code": "model_failed", "message": short, "full_message": whole}),)
        self.assertEqual(pip_chat.failure_text(row), short[:300])
        self.assertTrue(pip_chat.failure_detail(row).endswith("End of the refusal.\n  → hint"))
        self.assertEqual(pip_chat.failure_detail((json.dumps({"code": "model_failed", "message": "HTTP 401 short", "full_message": whole}),)).count("End of the refusal"), 1,
                         "a short line with a long answer behind it still has Details")


class FailedTurnReopened(unittest.TestCase):
    """A failed Work chat reopened reads as the failure it was (`_dgc_turn_failed` on its last message)."""

    def items(self, messages):
        import tempfile as _tempfile
        from dgc.config import Config
        from dgc.headless import Host
        import io
        import os as _os
        with _tempfile.TemporaryDirectory() as root:
            with mock.patch.dict(_os.environ, {"HOME": root}):
                host = Host(Config(project_root=Path(root)))
                host.core.fp = io.StringIO()
                chat = host.default
                chat.agent.messages = [chat.agent.messages[0], *messages]
                try:
                    return chat._history()
                finally:
                    chat.agent.mcp.stop_all()
                    chat.close(process=False)

    NOTE = {"message": "HTTP 401 from x: no\n  → the endpoint rejected the key",
            "cause": {"kind": "auth", "summary": "HTTP 401 from x", "hint": "the endpoint rejected the key", "http_status": 401, "full": "HTTP 401 from x: no, and more"}}

    def end(self, items):
        return next(i for i in reversed(items) if i.get("type") == "turn_end")

    def test_a_failed_turn_replays_its_failure_and_ends_in_error(self):
        items = self.items([{"role": "user", "content": "hello", "_dgc_turn_failed": self.NOTE}])
        marker = next(i for i in items if i.get("role") == "turn_failure")
        self.assertEqual(marker["message"], self.NOTE["message"])
        self.assertEqual(marker["cause"]["kind"], "auth")
        self.assertEqual(marker["cause"]["full"], "HTTP 401 from x: no, and more")
        self.assertEqual(self.end(items)["reason"], "error")
        self.assertLess(items.index(marker), items.index(self.end(items)))

    def test_an_old_session_with_no_note_opens_as_it_did(self):
        items = self.items([{"role": "user", "content": "hello"}])
        self.assertFalse([i for i in items if i.get("role") == "turn_failure"])
        self.assertEqual(self.end(items)["reason"], "cancelled", "the file says no more than that")

    def test_the_note_belongs_to_the_turn_it_is_in_and_a_later_answer_means_it_went_on(self):
        items = self.items([{"role": "user", "content": "first", "_dgc_turn_failed": self.NOTE},
                            {"role": "user", "content": "second"}, {"role": "assistant", "content": "Hello."}])
        ends = [i for i in items if i.get("type") == "turn_end"]
        self.assertEqual([e["reason"] for e in ends], ["error", "completed"])
        items = self.items([{"role": "user", "content": "first"},
                            {"role": "assistant", "content": "half", "tool_calls": [], "_dgc_turn_failed": self.NOTE},
                            {"role": "assistant", "content": "All done."}])
        self.assertEqual(self.end(items)["reason"], "completed")
        self.assertFalse([i for i in items if i.get("role") == "turn_failure"])

    def test_partial_words_then_a_failure_do_not_read_as_worked(self):
        items = self.items([{"role": "user", "content": "first"}, {"role": "assistant", "content": "half", "_dgc_turn_failed": self.NOTE}])
        self.assertEqual(self.end(items)["reason"], "error")
        self.assertIsNone(self.end(items)["final_message_id"])

    def test_the_agent_saves_the_note_and_no_transport_sends_it(self):
        from dgc.agent import Agent
        agent = Agent.__new__(Agent)
        agent.messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}]
        agent._safe_value = lambda value: value
        agent._safe_text = lambda value: value
        saved = []
        agent._persist = lambda *a, **k: saved.append(1) or True
        agent._note_turn_failure("HTTP 401: no\n  → hint", {"kind": "auth", "summary": "s", "full": "HTTP 401: no, whole", "run_n": 3, "retryable": False})
        note = agent.messages[-1]["_dgc_turn_failed"]
        self.assertEqual(note["message"], "HTTP 401: no\n  → hint")
        self.assertNotIn("run_n", note["cause"], "a retry row's id means nothing after a reload")
        self.assertEqual(saved, [1])
        self.assertEqual(agent._last_turn_full, "HTTP 401: no, whole\n  → hint")
        wire = [{k: v for k, v in m.items() if not str(k).startswith("_")} for m in agent.messages]
        self.assertNotIn("_dgc_turn_failed", json.dumps(wire))
        only_system = Agent.__new__(Agent)
        only_system.messages = [{"role": "system", "content": "s"}]
        only_system._safe_text = lambda value: value
        only_system._note_turn_failure("blocked", None)
        self.assertNotIn("_dgc_turn_failed", only_system.messages[0])


if __name__ == "__main__":
    unittest.main()
