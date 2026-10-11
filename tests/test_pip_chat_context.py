"""The Pip prompt box's context meter: how much of the window its chat takes in the next reply, and part by part
(dgc/pip_chat_breakdown.py): what its last reply measured besides the chat, then its brief and its messages."""
import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_chat_breakdown, pip_notes, pips
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


class BreakdownTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def reply_measured(self, pip, words, key):
        """One reply through the real worker (a fake model), as the runner runs it; its result as it's saved."""
        from dgc.llm import ChatResult, LLMClient
        run = pip_chat.send(self.store, pip["id"], words, key, "editor-user", self.cfg)["run"]
        raw = pip_notes.runtime(self.registry, run, json.loads(self.registry.db.execute(
            "SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0]))
        from dgc import shared_memory
        memory = shared_memory.SharedMemory(self.base / "shared-memory")
        memory.add("Lives in Pune")
        raw = {**raw, "about_you": shared_memory.for_run(self.cfg, memory=memory)}
        sent = []

        def chat(client, messages, tools=None, **kwargs):
            sent.append((json.dumps(messages), json.dumps(tools or [])))
            return ChatResult(content="Done: " + words[:40])
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            result = pips.execute_native(self.cfg, self.root, raw, lambda e: None)
        self.store.claim_next()
        self.store.finish(run["id"], result=result)
        return result, sent[0]

    def test_a_reply_measures_what_fills_its_window_and_the_meter_adds_the_chat(self):
        pip = self.store.create(self.registry.personal()["id"], "Ava", "Help plan my day", "editor-user", pip_type="rook")
        with self.registry.transaction():
            pip_notes._insert(self.registry, pip["id"], pip["workspace_id"], "Sam is their sister", "you")
        result, (messages, tools) = self.reply_measured(pip, "Plan a 5k run every Tuesday. " * 30, "first")
        parts = {p["id"]: p for p in result["context"]["parts"]}
        self.assertEqual(set(parts) - {"plugins", "skills"}, {"system_prompt", "tools", "instructions", "memory", "data"})
        self.assertIn("remember", [i["name"] for i in parts["tools"]["items"]], "each tool it was offered, named")
        self.assertEqual({i["name"] for i in parts["memory"]["items"]}, {"What it remembers", "Your memory in DGC"})
        measured = sum(p["tokens"] for p in parts.values()) + pip_chat_breakdown.tokens("Plan a 5k run every Tuesday. " * 30)
        sent = pip_chat_breakdown.tokens(messages) + pip_chat_breakdown.tokens(tools)
        self.assertTrue(0.8 < measured / sent < 1.25, (measured, sent))

        ctx = context_estimate(self.store, pip["id"], self.cfg)
        shown = ctx["breakdown"]
        by = {c["id"]: c for c in shown["categories"]}
        self.assertEqual(by["tools"]["tokens"], parts["tools"]["tokens"], "the last reply's own measure")
        self.assertEqual(ctx["used_tokens"], shown["used"])
        self.assertEqual(shown["used"], sum(c["tokens"] for c in shown["categories"]))
        self.assertGreater(by["messages"]["tokens"], 225, "the chat as the next reply sends it: the message and its reply")
        self.assertEqual((shown["window"], shown["source"]), (ctx["context_size"], "estimated"))
        self.assertEqual(shown["compact_at"], int(ctx["context_size"] * 0.85))

    def test_no_reply_yet_or_a_measure_from_before_shows_the_chat_alone_and_a_bad_one_is_refused(self):
        pip = self.store.create(self.registry.personal()["id"], "Ava", "Keep my plans", "local-console")
        self.assertEqual(context_estimate(self.store, pip["id"], self.cfg)["breakdown"]["categories"], [])
        run = pip_chat.send(self.store, pip["id"], "Plan my week", "first", "editor-user", self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(run["id"], result={"text": "Done."})
        self.assertEqual([c["id"] for c in context_estimate(self.store, pip["id"], self.cfg)["breakdown"]["categories"]],
                         ["messages"], "a reply from before measured nothing")
        good = pip_chat_breakdown.measure("You are a Pip.", [], "Reference data", job={"goal": "x"})
        for bad in ({**good, "version": 2}, {"version": 1, "parts": [{"id": "evil", "label": "Evil", "tokens": 1}]},
                    {"version": 1, "parts": [{"id": "tools", "label": "Tools", "tokens": -1}]},
                    {"version": 1, "parts": [{"id": "tools", "label": "Tools", "tokens": 3, "items": [{"name": "<b>", "tokens": "3"}]}]}):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                pip_chat_breakdown.validate(bad)
        self.registry.db.execute("UPDATE pip_runs SET result=? WHERE id=?",
                                 (json.dumps({"text": "Done.", "context": {"version": 1, "parts": "x"}}), run["id"]))
        self.assertEqual(pip_chat_breakdown.last_parts(self.store, pip["id"]), [], "a damaged measure shows nothing")

    def test_measure_leaves_out_what_changes_with_each_message_and_the_rest_is_references(self):
        brief, message = "B" * 400, "M" * 800
        prompt = json.dumps({"job": "J" * 40, "notes": "N" * 80, "brief": brief, "report": "R" * 1200}) + message
        got = pip_chat_breakdown.measure("S" * 400, [{"type": "function", "function": {"name": "remember"}}], prompt,
                                         job="J" * 40, memory=[("What it remembers", "N" * 80), ("Pip memory", None)],
                                         skills=[("trip", "- trip: plan a trip")], skills_text="Your skills\n- trip: plan a trip",
                                         changing=[brief, message])
        by = {p["id"]: p for p in got["parts"]}
        self.assertEqual(by["system_prompt"]["tokens"], 100)
        self.assertEqual([i["name"] for i in by["memory"]["items"]], ["What it remembers"], "nothing kept, no row")
        self.assertEqual(by["skills"]["items"][0]["name"], "trip")
        self.assertTrue(300 <= by["data"]["tokens"] <= 320, by["data"])
        self.assertNotIn("plugins", by)


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
