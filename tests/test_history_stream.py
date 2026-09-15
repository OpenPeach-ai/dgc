"""Reload snapshots preserve unsaved stream bytes without replaying them twice."""
import io
import json
import threading
import unittest
from types import SimpleNamespace

from dgc.agent import Agent
from dgc.editor_protocol import event_error
from dgc.headless import Backend
from dgc.history_stream import HistoryEmitter
from dgc.reasoning import saved_reasoning


class LiveHistoryTests(unittest.TestCase):
    def make(self):
        stream = io.StringIO()
        emitter = HistoryEmitter(stream, validator=event_error)
        backend = object.__new__(Backend)
        backend.em = emitter
        backend.config = None
        backend.agent = SimpleNamespace(messages=[{"role": "user", "content": "first"}], todos=[])
        backend._running_turn_kind = "prompt"
        backend._live_turn = {"id": "t1", "anchor": None}
        emitter.emit("turn_start", turn_id="t1", prompt="first", kind="prompt")
        return backend, emitter, stream

    def test_unsaved_prefix_and_saved_round_are_each_restored_once(self):
        backend, emitter, stream = self.make()
        emitter.emit("text_delta", text="Saved round.")
        emitter.emit("stream_end", message_id="t1:1", phase="commentary")
        backend.agent.messages.append({"role": "assistant", "content": "Saved round."})
        emitter.emit("text_delta", text="Unsaved ")
        emitter.emit("text_delta", text="prefix.")
        backend._emit_history("reload")
        snapshot = json.loads(stream.getvalue().splitlines()[-1])
        self.assertTrue(snapshot["complete"])
        self.assertEqual([i["text"] for i in snapshot["items"] if i.get("type") == "text_delta"],
                         ["Saved round.", "Unsaved prefix."])
        self.assertFalse(any(i.get("type") == "turn_end" for i in snapshot["items"]))
        self.assertEqual(len(backend.agent.messages), 2, "a display snapshot does not persist unfinished prose")
        emitter.emit("text_delta", text=" Later.")
        self.assertGreater(json.loads(stream.getvalue().splitlines()[-1])["seq"], snapshot["seq"])

    def test_snapshot_lock_orders_a_concurrent_delta_after_its_boundary(self):
        backend, emitter, stream = self.make()
        attempted = threading.Event()
        def write():
            attempted.set()
            emitter.emit("text_delta", text="later")
        with emitter.history_lock:
            worker = threading.Thread(target=write)
            worker.start()
            self.assertTrue(attempted.wait(2))
            backend._emit_history()
        worker.join(2)
        self.assertFalse(worker.is_alive())
        events = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual([ev["type"] for ev in events], ["turn_start", "history", "text_delta"])
        self.assertEqual([ev["seq"] for ev in events], sorted(ev["seq"] for ev in events))

    def test_overflow_is_bounded_and_does_not_claim_to_cover_unsaved_output(self):
        backend, emitter, stream = self.make()
        for _ in range(100):
            emitter.emit("text_delta", text="x" * 10_000)
        backend._emit_history()
        snapshot = json.loads(stream.getvalue().splitlines()[-1])
        self.assertFalse(snapshot["complete"])
        self.assertLess(len(json.dumps(emitter._turn_events)), 750_000)

    def test_new_chat_and_queued_turn_never_reuse_the_previous_stream(self):
        backend, emitter, stream = self.make()
        emitter.emit("text_delta", text="private first chat")
        emitter.emit("session", kind="new", message_count=0, session_id="other")
        emitter.emit("turn_start", turn_id="t2", prompt="second", kind="prompt")
        backend.agent.messages = [{"role": "user", "content": "second"}]
        backend._live_turn = {"id": "t2", "anchor": None}
        emitter.emit("text_delta", text="second chat answer")
        backend._emit_history()
        snapshot = json.loads(stream.getvalue().splitlines()[-1])
        self.assertNotIn("private first chat", json.dumps(snapshot))
        self.assertIn("second chat answer", json.dumps(snapshot))

    def test_empty_native_thinking_does_not_return_as_legacy_reasoning(self):
        agent = object.__new__(Agent)
        agent._turn_reasoning_pending = []
        message = agent._attach_reasoning({"role": "assistant", "content": "Done.",
            "_provider_message": {"provider": "ollama", "thinking": "<think>\n\n</think>"}})
        self.assertEqual(saved_reasoning(message), [])


if __name__ == "__main__":
    unittest.main()
