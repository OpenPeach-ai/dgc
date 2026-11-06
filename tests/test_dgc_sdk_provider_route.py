"""SDK 0.9.0 against what CLI 0.51.0 added: one session's provider and model, a follow-up taken out of the queue, Trace,
ChatDGC's @ list and marks, a Router model's thinking, cards per surface, and Pips API 74. A real `dgc serve` and a local
mock model where the behaviour is the CLI's; an offline wire where it is the SDK's own check."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_dgc_sdk as harness                               # noqa: E402  (its mock model and HOME handling)
from test_dgc_sdk_pips import CAPS, Wire, session as pips_session   # noqa: E402

from dgc_sdk import DGC, DGCConfigError, DGCUnsupportedError  # noqa: E402
from dgc_sdk.session import Session                           # noqa: E402
from dgc_sdk.wire.editor_protocol import command_error        # noqa: E402

PROVIDER = "provider_" + "a" * 32


class _Second(harness._Model):
    """Another provider: says who it is, and what key it was given."""

    auth: list = []
    models: list = []

    def do_POST(self):
        _Second.auth.append(self.headers.get("Authorization") or "")
        length = int(self.headers.get("Content-Length", 0))
        request = json.loads(self.rfile.read(length) or b"{}")
        _Second.models.append(str(request.get("model") or ""))
        self._send(harness._answer("SECOND-PROVIDER answered."))


class _Slow(harness._Model):
    """Holds the first request, so a follow-up is still waiting behind it."""

    release = threading.Event()
    said: list = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        request = json.loads(self.rfile.read(length) or b"{}")
        users = [m for m in request.get("messages") or [] if m.get("role") == "user"]
        text = str(users[-1].get("content") or "") if users else ""
        _Slow.said.append(text)
        if "first task" in text:
            _Slow.release.wait(30)
        self._send(harness._answer("ANSWERED."))


def _serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/v1"


class LiveTests(unittest.TestCase):
    setUp = harness.SdkTests.setUp
    tearDown = harness.SdkTests.tearDown
    _client = harness.SdkTests._client

    def _session(self, dgc):
        return dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})

    def _config(self):
        found = sorted(self.state.rglob("config.json"))
        return {str(path): path.read_text(encoding="utf-8") for path in found}

    def test_set_model_moves_this_session_only_and_never_writes_the_settings(self):
        _Second.auth, _Second.models = [], []
        server, second = _serve(_Second)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with self._client() as dgc:
            moved = self._session(dgc)
            self.assertTrue(moved.capabilities.get("session_model_route"))
            before = moved.run("Summarize README. Do not edit files.", timeout=60)
            self.assertEqual(before.status, "completed", before.error)
            saved = self._config()
            answer = moved.set_model("second-model", base_url=second, api_key="sk-second", api_mode="chat_completions")
            self.assertEqual(answer, {"model": "second-model", "base_url": second})
            self.assertEqual(moved.set_thinking("low"), "low")
            result = moved.run("Say who you are.", timeout=60)
            self.assertEqual(result.status, "completed", result.error)
            self.assertIn("SECOND-PROVIDER", result.final_text)
            self.assertIn("second-model", _Second.models)
            self.assertEqual(set(_Second.auth), {"Bearer sk-second"}, "the new key goes to the new address")
            self.assertEqual(self._config(), saved, "nothing went into the client's settings")
            other = self._session(dgc)
            self.assertEqual(other.get_config().get("model"), "sdk-model", "another session keeps its own")

    def test_moving_without_a_key_sends_the_old_key_nowhere(self):
        _Second.auth, _Second.models = [], []
        server, second = _serve(_Second)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with self._client() as dgc:
            session = self._session(dgc)
            session.set_model("second-model", base_url=second)
            result = session.run("Say who you are.", timeout=60)
            self.assertEqual(result.status, "completed", result.error)
        self.assertTrue(_Second.auth)
        self.assertFalse([value for value in _Second.auth if "sk-local" in value], _Second.auth)

    def test_a_reopened_session_comes_back_on_its_model(self):
        with self._client() as dgc:
            session = self._session(dgc)
            session.set_model("other-model")
            result = session.run("Summarize README. Do not edit files.", timeout=60)
            self.assertEqual(result.status, "completed", result.error)
            session.bind_identity()
            path = session.session_path
            self.assertTrue(path)
            session.close()
            reopened = dgc.resume(path, cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            self.assertEqual(reopened.get_config().get("model"), "other-model")

    def test_set_model_refuses_what_it_cannot_do(self):
        with self._client() as dgc:
            session = self._session(dgc)
            with self.assertRaisesRegex(DGCConfigError, "needs a model or a base_url"):
                session.set_model()
            with self.assertRaisesRegex(DGCConfigError, "api_mode must be"):
                session.set_model("m", api_mode="smoke")
            with self.assertRaisesRegex(DGCConfigError, "thinking must be"):
                session.set_thinking("huge")

    def test_cancelling_a_waiting_followup_takes_it_out_so_it_never_starts(self):
        _Slow.release = threading.Event()
        _Slow.said = []
        server, url = _serve(_Slow)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with DGC(state_dir=self.state, model="sdk-model", base_url=url, api_key="sk-local") as dgc:
            session = self._session(dgc)
            self.assertTrue(session.capabilities.get("queue_edit"))
            first = session.stream("first task", timeout=60)
            taken = session.followup("taken out", timeout=60)
            kept = session.followup("kept", timeout=60)
            seen = []
            deadline = time.monotonic() + 20
            for event in first:
                seen.append(event.type)
                if event.type == "turn_start":
                    taken.cancel()
                if event.type == "queue_changed":
                    self.assertEqual(event.data.get("removed"), taken._run.request_id)
                    self.assertEqual(event.data.get("order"), [kept._run.request_id])
                    _Slow.release.set()
                self.assertLess(time.monotonic(), deadline)
            self.assertEqual(first.result().status, "completed")
            gone, done = taken.result(timeout=60), kept.result(timeout=60)
            after = session.run("Summarize README. Do not edit files.", timeout=60)
        self.assertIn("queue_changed", seen)
        self.assertEqual(gone.status, "cancelled")
        self.assertIsNone(gone.error, "the app asked for it: no failure to report")
        self.assertEqual(gone.tools, [])
        self.assertEqual(done.status, "completed", done.error)
        self.assertEqual(after.status, "completed", after.error)
        self.assertFalse([text for text in _Slow.said if "taken out" in text], "the model never saw it")
        self.assertTrue([text for text in _Slow.said if "kept" in text], "the one behind it still ran")

    def test_trace_reaches_a_stream_and_history_and_a_chat_reply(self):
        with self._client() as dgc:
            session = self._session(dgc)
            events = [event for event in session.stream("Summarize README. Do not edit files.", timeout=60)]
            kinds = [event.type for event in events]
            history = session.history()
        self.assertIn("turn_end", kinds)
        marks = [item for item in history.get("items") or [] if item.get("role") == "time" and item.get("of") == "trace"]
        self.assertTrue(marks, "a saved turn carries its Trace marks")
        with self._client() as dgc, dgc.chat() as chats:
            reply = chats.ask("What does the checkout do?", search="off")
        self.assertEqual(reply.trace["v"], 1)
        self.assertEqual(reply.trace["steps"][0]["kind"], "model")

    def test_chat_mentions_and_marks_come_back_with_the_sent_message(self):
        mark = {"start": 0, "kind": "file", "label": "app.py", "identity": "app.py"}
        with self._client() as dgc, dgc.chat() as chats:
            named = chats.mentions()
            self.assertIn("plugins", named)
            self.assertIn("pips", named)
            chat = chats.new()
            events = list(chat.stream("what does it do?", search="off", display_mentions=[mark]))
            self.assertEqual(events[-1].kind, "reply")
            sent = next(message for message in chat.messages if message.get("role") == "user")
        self.assertEqual(sent.get("display_mentions"), [mark], sent)


class OfflineTests(unittest.TestCase):
    def _session(self, caps, wire=None):
        return Session(wire or Wire(), {"capabilities": caps}, unhandled="deny", on_permission=None, on_plan=None,
                       on_question=None, isolated=False)

    def test_an_older_cli_is_told_before_anything_is_sent(self):
        wire = Wire()
        session = self._session({}, wire)
        with self.assertRaisesRegex(DGCUnsupportedError, "update it"):
            session.set_model("m")
        with self.assertRaisesRegex(DGCUnsupportedError, "update it"):
            session.set_thinking("low")
        self.assertFalse(wire.calls)

    def test_a_router_models_thinking(self):
        class RouterWire:
            def __init__(self):
                self.sent = []

            def request(self, payload, response, **_kw):
                assert command_error(payload) is None, command_error(payload)
                self.sent.append(dict(payload))
                return {"type": response, "request_id": payload["request_id"], "status": {"systems": []},
                        "change": "NAS thinks low."}

        wire = RouterWire()
        session = self._session({"router": {"commands": ["router_status", "router_thinking"]}}, wire)
        self.assertEqual(session.router.set_thinking("nas", "qwen", "low")["change"], "NAS thinks low.")
        self.assertEqual(wire.sent[0]["thinking"], "low")
        with self.assertRaisesRegex(DGCConfigError, "thinking is"):
            session.router.set_thinking("nas", "qwen", "xhigh")
        older = self._session({"router": {"commands": ["router_status"]}}, RouterWire())
        with self.assertRaisesRegex(DGCUnsupportedError, "router_thinking"):
            older.router.set_thinking("nas", "qwen", "low")

    def test_cards_watch_says_whose(self):
        class CardWire:
            def __init__(self):
                self.sent = []

            def send(self, payload):
                assert command_error(payload) is None, command_error(payload)
                self.sent.append(dict(payload))

        wire = CardWire()
        session = self._session({"mcp_apps": {"version": 1}}, wire)
        session.cards.watch()
        session.cards.watch("pip")
        self.assertEqual(wire.sent, [{"type": "watch_mcp_apps"}, {"type": "watch_mcp_apps", "surface": "pip"}])
        with self.assertRaisesRegex(DGCConfigError, "surface"):
            session.cards.watch("home")

    def test_a_pip_on_a_saved_provider_needs_api_74_and_the_whole_choice(self):
        choice = {"mode": "provider", "provider": PROVIDER, "model": "m"}
        create = {"workspace_id": "personal", "name": "A", "goal": "b", "model_choice": choice}
        wire = Wire()
        old = pips_session(wire, caps={**CAPS, "pips_api_version": 73})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 74"):
            old.pips.mutate("create_pip", create, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire()
        now = pips_session(wire, caps={**CAPS, "pips_api_version": 74})
        now.pips.mutate("create_pip", create, approved=True)
        self.assertEqual(wire.calls[0][0]["request"]["model_choice"], choice)
        for bad in ({**choice, "provider": "openai"}, {"mode": "provider", "provider": PROVIDER},
                    {**choice, "api_key": "sk"}):
            with self.subTest(bad=bad), self.assertRaisesRegex(DGCConfigError, "saved provider"):
                now.pips.mutate("create_pip", {**create, "model_choice": bad}, approved=True)

    def test_marks_in_a_pips_chat_need_the_cli_that_keeps_them(self):
        message = {"pip_id": "pip_rook", "text": "hello", "idempotency_key": "one",
                   "display_mentions": [{"start": 0, "kind": "file", "label": "a.py", "identity": "a.py"}]}
        wire = Wire()
        old = pips_session(wire, caps={**CAPS, "pips_api_version": 74})
        with self.assertRaisesRegex(DGCUnsupportedError, "pip_display_mentions"):
            old.pips.mutate("send_pip_message", message, approved=True)
        self.assertFalse(wire.calls)
        now = pips_session(wire, caps={**CAPS, "pips_api_version": 74, "pip_display_mentions": 1})
        now.pips.mutate("send_pip_message", message, approved=True)
        self.assertEqual(len(wire.calls), 1)


if __name__ == "__main__":
    unittest.main()
