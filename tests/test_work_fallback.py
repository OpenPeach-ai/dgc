"""A Work session's fallback model (D14, 9 Nov; fallback on every surface, part C): one per session, chosen in its model
menu, a new session starting from the one in Settings; when its own model fails the turn carries on with it, each turn
tries its own model first, the "falling back" line is said once an outage, the editor is told while the fallback answers
(model_fallback), and the turn's Trace keeps the change."""
import json
import unittest
from unittest.mock import patch

from dgc import headless, sessions
from dgc.editor_protocol import EVENT_FIELDS, event_error
from tests import test_model_retry as retry
from tests import test_server_window as window

closed_port, stall = retry.closed_port, retry.stall


class _Told(retry._Recorder):
    def __init__(self):
        super().__init__()
        self.fallbacks, self.handed = [], []

    def model_fallback(self, model, active):
        self.fallbacks.append((model, active))

    def trace_handed_over(self, why, to):
        self.handed.append((why, to))


class FallbackTurns(retry.RetryTestCase):
    def test_its_own_model_out_the_turn_carries_on_each_turn_tries_it_first_and_says_so_once(self):
        self.server.behaviours["/chat/completions"] = stall.chat_answer("hello")
        agent, ui = self.agent(_Told(), base_url=f"http://127.0.0.1:{closed_port()}/v1", fallback_model="backup",
                               fallback_base_url=self.server.url + "/v1")
        self.assertTrue(agent.run_turn("hi", reset_cancel=False))
        said = [line for line in ui.infos if "⤳" in line]
        self.assertEqual(len(said), 1)
        self.assertEqual(ui.fallbacks, [("backup", True)], "the editor is told which model answers now")
        self.assertEqual(len(ui.handed), 1)
        self.assertTrue(ui.handed[0][0].startswith("retry-model didn't answer: "), ui.handed)
        self.assertEqual(ui.handed[0][1], "backup")
        gave_up = sum(1 for state, _ in ui.frames if state == "gave_up")
        # Still out: the next turn tries its own model first, then the fallback, and says nothing more.
        self.assertTrue(agent.run_turn("again", reset_cancel=False))
        self.assertGreater(sum(1 for state, _ in ui.frames if state == "gave_up"), gave_up, "its own model was tried first")
        self.assertEqual(len([line for line in ui.infos if "⤳" in line]), 1, "said once an outage")
        self.assertEqual(len(ui.handed), 2, "but its Trace keeps every change")
        # Its own model back: the turn is its own model's, and the editor is told the fallback stopped answering.
        agent.config.data["base_url"] = self.server.url + "/v1"
        self.assertTrue(agent.run_turn("and now", reset_cancel=False))
        self.assertEqual(agent.client.model, "retry-model")
        self.assertEqual(ui.fallbacks[-1], ("", False))


class SessionFallback(window.IsolatedHome):
    host = window.TheEditorIsTold.host
    frames = window.TheEditorIsTold.frames

    def test_a_sessions_fallback_is_its_own_and_a_new_session_starts_from_settings(self):
        host = self.host(model="qwen2.5-0.5b", base_url=self.server.url + "/v1", fallback_model="glm-default")
        ready = self.frames("ready")[-1] if self.frames("ready") else None
        caps = host.default._ready_payload()["capabilities"] if hasattr(host.default, "_ready_payload") else ready["capabilities"]
        self.assertEqual(caps.get("model_fallback"), 1, "the editor sends a session's fallback only when offered")
        settings = json.loads((self.user / "config.json").read_text())
        host.dispatch({"type": "set_config", "scope": "session", "request_id": "fb", "values": {
            "fallback_model": "spare", "fallback_base_url": "https://spare.example/v1",
            "fallback_api_mode": "chat_completions", "fallback_api_key": "sk-spare"}})
        self.assertFalse([f for f in self.frames("command_rejected") if f.get("request_id") == "fb"], self.frames("command_rejected"))
        config = host.default.config
        self.assertEqual((config.get("fallback_model"), config.get("fallback_base_url")), ("spare", "https://spare.example/v1"))
        kept = json.loads((self.user / "config.json").read_text())
        self.assertEqual({k: kept.get(k) for k in kept if k.startswith("fallback_")},
                         {k: settings.get(k) for k in settings if k.startswith("fallback_")}, "Settings' fallback stays as it was")
        saved = host.default.agent.session_file
        host.default.agent._persist()
        record = json.loads(saved.read_text())
        self.assertEqual(record["fallback_route"], {"model": "spare", "base_url": "https://spare.example/v1",
                                                    "api_mode": "chat_completions"})
        self.assertNotIn("sk-spare", saved.read_text(), "a session file never holds a key")
        host.dispatch({"type": "new_session", "request_id": "fresh"})
        self.assertEqual((config.get("fallback_model"), config.get("fallback_base_url")), ("glm-default", ""),
                         "a new session starts from the one in Settings")
        host.dispatch({"type": "resume_session", "path": str(saved), "saved_mode": True, "request_id": "back"})
        self.assertEqual((config.get("fallback_model"), config.get("fallback_base_url")), ("spare", "https://spare.example/v1"))
        self.assertEqual(config.get("fallback_api_key"), "", "the editor supplies its key again")
        for bad in ({"base_url": "https://user:private@spare.example/v1", "model": "m", "api_mode": "auto"},
                    {"base_url": "", "model": "m"}):
            with self.subTest(bad=bad):
                self.assertIsNone(sessions._clean_fallback_route(bad))


class EditorIsTold(unittest.TestCase):
    def test_model_fallback_is_a_declared_event_and_the_turn_trace_keeps_the_change(self):
        import io
        from dgc.protocol import Emitter
        self.assertEqual(set(EVENT_FIELDS["model_fallback"]), {"model", "active"})
        wire = io.StringIO()
        ui = headless.HeadlessUI(Emitter(wire), None)
        ui.turn_id = "t1"
        ui.begin_turn_trace()
        ui.model_fallback("backup", True)
        ui.trace_handed_over("retry-model didn't answer: unavailable (503)", "backup")
        ui.trace_model_start()
        ui.trace_usage(42)
        ui.end_stream()
        frames = [json.loads(line) for line in wire.getvalue().splitlines()]
        told = [f for f in frames if f["type"] == "model_fallback"]
        self.assertEqual(told[0]["model"], "backup")
        self.assertIs(told[0]["active"], True)
        self.assertTrue(all(event_error({**f, "seq": 0}) is None for f in told))
        trace = ui.take_turn_trace("retry-model")
        failed = [s for s in trace["steps"] if s.get("error")]
        self.assertEqual((failed[0]["to"], failed[0]["detail"]), ("backup", "retry-model didn't answer: unavailable (503)"))


if __name__ == "__main__":
    unittest.main()
