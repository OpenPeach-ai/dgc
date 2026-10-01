"""One wire per process, one history view per chat.

seq comes from ONE counter on the shared wire, so it rises strictly across every chat's events. The
live-turn cache that a reloaded panel replays is per chat: one cache, reset by whichever chat started
a turn last, restored a mixed or wiped transcript after a mid-turn switch and a reload.
"""
import io
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc.history_stream import HistoryEmitter  # noqa: E402
from dgc.protocol import Emitter  # noqa: E402


class HistoryPerChatTest(unittest.TestCase):
    def setUp(self):
        self.stream = io.StringIO()
        self.core = Emitter(self.stream)
        self.a = HistoryEmitter(core=self.core, chat_id="chat-a")
        self.b = HistoryEmitter(core=self.core, chat_id="chat-b")

    def frames(self):
        return [json.loads(line) for line in self.stream.getvalue().splitlines()]

    def test_seq_rises_strictly_across_chats(self):
        for view in (self.a, self.b, self.a, self.b, self.b):
            view.emit("info", message="x")
        seqs = [frame["seq"] for frame in self.frames()]
        self.assertEqual(seqs, sorted(set(seqs)), "two chats' events must share one strictly rising seq")

    def test_one_chats_turn_never_resets_anothers_live_cache(self):
        self.a.emit("turn_start", turn_id="t1")
        self.a.emit("text_delta", text="chat A, part one")
        self.b.emit("turn_start", turn_id="t1")      # chat B's turn ids restart at t1 too
        self.b.emit("text_delta", text="chat B")
        self.a.emit("text_delta", text=" and two")
        items, complete = self.a.include_live([], {"id": "t1"})
        texts = [item.get("text") for item in items if item.get("type") == "text_delta"]
        self.assertTrue(complete)
        self.assertEqual(texts, ["chat A, part one and two"], "B's turn wiped or mixed into A's snapshot")

    def test_chat_id_appears_only_once_the_wire_tags_chats(self):
        self.a.emit("info", message="before")
        self.core.tag_chats = True
        self.a.emit("info", message="after")
        before, after = self.frames()
        self.assertNotIn("chat_id", before, "an untagged client must never see the field")
        self.assertEqual(after["chat_id"], "chat-a")

    def test_an_oversized_frame_keeps_its_chat(self):
        self.core.tag_chats = True
        self.core.max_event_bytes = 600
        self.a.emit("tool_result", call_id="c1", content="x" * 5000)
        self.assertEqual(self.frames()[-1].get("chat_id"), "chat-a", "a shrunk frame lost its chat")
        self.core.max_event_bytes = 100              # not even the envelope fits: the error stands in
        self.a.emit("tool_result", call_id="c2", content="x" * 5000)
        frame = self.frames()[-1]
        self.assertEqual(frame["type"], "error", "premise: the last-resort replacement")
        self.assertEqual(frame.get("chat_id"), "chat-a", "the replacement lost the chat it belongs to")

    def test_a_standalone_emitter_still_writes_its_own_stream(self):
        stream = io.StringIO()
        view = HistoryEmitter(stream)
        view.emit("info", message="x")
        self.assertEqual(json.loads(stream.getvalue())["seq"], 0)
        view.fp = io.StringIO()                       # callers that swap the stream still can
        view.emit("info", message="y")
        self.assertEqual(json.loads(view.fp.getvalue())["seq"], 1)


if __name__ == "__main__":
    unittest.main()
