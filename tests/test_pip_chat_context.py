"""The Pip prompt box's context meter: how much of the window its chat takes in the next reply."""
import unittest
from unittest.mock import patch

from dgc import pip_chat, pips
from dgc.pip_chat_options import context_estimate
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class ChatContextTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def chat(self, pip, words, key):
        run = pip_chat.send(self.store, pip["id"], words, key, "editor-user", self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(run["id"], result={"text": "Noted: " + words})

    def test_the_meter_counts_what_the_next_reply_carries(self):
        pip = self.store.create(self.registry.personal()["id"], "Ava", "Keep my plans", "local-console")
        empty = context_estimate(self.store, pip["id"], self.cfg)
        self.assertEqual((empty["used_tokens"], empty["recent_messages"]), (0, 0))
        self.chat(pip, "Plan a 5k run every Tuesday. " * 40, "first")
        one = context_estimate(self.store, pip["id"], self.cfg)
        self.assertEqual(one["recent_messages"], 2)
        self.assertGreater(one["used_tokens"], 500, "about four bytes a token of what it sends")
        self.assertEqual(one["context_size"], empty["context_size"])
        small = context_estimate(self.store, pip["id"], self.cfg, 2048)
        self.assertEqual(small["context_size"], 2048)
        for bad in (100, 2_000_000, "32768", True):
            with self.subTest(size=bad), self.assertRaises(RegistryError):
                context_estimate(self.store, pip["id"], self.cfg, bad)

    def test_only_on_this_computer_and_only_for_personal_pips(self):
        pip = self.store.create(self.registry.personal()["id"], "Ava", "Keep my plans", "local-console")
        def control(actor="editor-user", **fields):
            with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)):
                return pips.handle_control(self.cfg, {"type": "get_pip_chat_context", "request_id": "r", **fields},
                                           actor, start_worker=False)
        ok = control(pip_id=pip["id"])
        self.assertTrue(ok["ok"], ok)
        self.assertEqual(ok["result"]["used_tokens"], 0)
        self.assertFalse(control(actor="device_1", pip_id=pip["id"])["ok"])


if __name__ == "__main__":
    unittest.main()


class ReplyActivityTests(unittest.TestCase):
    """A Pip's reply says what it is doing, as DGC's chat does, and reads as it is written."""

    def ui(self):
        from dgc.pips import _ConversationUI
        events = []
        cfg = type("Cfg", (), {"get": lambda self, key, default=None: default})()
        return _ConversationUI(events.append, cfg), events

    def test_thinking_writing_and_tools_each_said_once_per_change(self):
        ui, events = self.ui()
        ui.on_thinking("weighing it")
        ui.on_thinking("still weighing")
        ui.tool_call("read_app", {})
        ui.on_text("Here")
        ui.on_text(" it is.")
        states = [(e["state"], e["message"]) for e in events if e["kind"] == "progress"]
        self.assertEqual([s for s, _ in states], ["thinking", "tool", "responding"])
        self.assertEqual(states[-1][1], "Writing")
        self.assertTrue(states[1][1], "the tool has a verb")

    def test_a_short_reply_streams_within_a_quarter_second(self):
        ui, events = self.ui()
        clock = [100.0]
        with patch("dgc.pips.time.monotonic", lambda: clock[0]):
            ui.stream_at = clock[0]
            ui.on_text("Hello there")
            self.assertEqual([e for e in events if e["kind"] == "text_delta"], [], "not yet")
            clock[0] += 0.3
            ui.on_text(", Ava")
        deltas = "".join(e["text"] for e in events if e["kind"] == "text_delta")
        self.assertTrue(deltas.startswith("Hello there"), deltas)


class ReplyStatsTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def test_each_reply_says_how_long_it_took_and_its_tokens(self):
        from dgc.pip_chat import reply_stats
        pip = self.store.create(self.registry.personal()["id"], "Ava", "Keep my plans", "local-console")
        run = pip_chat.send(self.store, pip["id"], "Plan my week", "first", "editor-user", self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(run["id"], result={"text": "Done.", "usage": {"input_tokens": 1200, "output_tokens": 340, "requests": 2,
                                                                       "cached_input_tokens": 0, "reasoning_tokens": 0}})
        [one] = reply_stats(self.store, pip["id"], [run["id"]])["stats"]
        self.assertEqual((one["input_tokens"], one["output_tokens"], one["requests"], one["status"]), (1200, 340, 2, "succeeded"))
        self.assertIsInstance(one["seconds"], float)
        for bad in ([], ["run_x"], ["run_" + "a" * 32] * 51, "run_" + "a" * 32):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                reply_stats(self.store, pip["id"], bad)
        self.assertEqual(reply_stats(self.store, pip["id"], ["run_" + "f" * 32])["stats"], [], "another run is not this Pip's")
