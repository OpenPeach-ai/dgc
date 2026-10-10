"""ChatDGC Phase 4: the context window. The model's real window, capped by a preset and sent with every request;
before a reply that would fill more than 75% of it, the older turns become a summary (said, shown, editable) and
the recent ones stay word for word; Compact now; Continue in a new chat; one file never fills the window; and a
meter that counts what the model reports."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from dgc.chatdgc import window as fit_window
from dgc.chatdgc.engine import ChatEngine, ChatEngineError
from dgc.chatdgc.store import ChatStore
from dgc.shared_memory import SharedMemory


class Config(dict):
    base_url, api_key, model = "http://127.0.0.1:11434/v1", "", "chat-model"

    def get(self, key, default=None):
        return super().get(key, default)


class Model:
    """A model with a real window limit that answers, and summarizes when asked."""
    limit = 0

    def __init__(self, model, world):
        self.model, self.world, self.context_size = model, world, 0

    def prepare_model(self, **_):
        self.world["prepared"] += 1

    def model_context_limit(self):
        return self.limit

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        self.world["sent"].append({"messages": list(messages), "window": self.context_size})
        if messages[0]["content"].startswith("You are summarizing a conversation"):
            self.world["summaries"].append(messages[1]["content"])
            if self.world.get("summary_fails"):
                raise RuntimeError("model unavailable")
            text = self.world.get("summary_text") or f"SUMMARY #{len(self.world['summaries'])}"
            return SimpleNamespace(content=text, finish_reason="stop", usage={}, thinking="", tool_calls=[])
        if messages[0]["content"].startswith("Shorten this summary"):
            self.world.setdefault("shortened", []).append(messages[1]["content"])
            return SimpleNamespace(content="SHORTER", finish_reason="stop", usage={}, thinking="", tool_calls=[])
        reply = self.world["replies"].pop(0) if self.world["replies"] else "ok"
        if on_text:
            on_text(reply)
        return SimpleNamespace(content=reply, finish_reason=self.world.get("finish", "stop"), thinking="", tool_calls=[],
                               usage=self.world.get("usage", {"input_tokens": 0, "output_tokens": 0}))


class WindowTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-window-")
        self.addCleanup(temp.cleanup)
        self.store = ChatStore(Path(temp.name) / "chat")
        self.world = {"sent": [], "summaries": [], "replies": [], "prepared": 0}
        self.config = Config(chatdgc_window="8k")
        self.engine = ChatEngine(self.config, self.store, client_factory=lambda model: Model(model or "chat-model", self.world),
                                 memory=SharedMemory(Path(temp.name) / "memory"), projects=lambda hidden: [])
        self.addCleanup(setattr, Model, "limit", 0)

    def talk(self, chat, words, reply="ok", **kwargs):
        self.world["replies"].append(reply)
        return self.engine.send(chat["id"], words, **kwargs)

    def last_request(self):
        return [s for s in self.world["sent"] if not s["messages"][0]["content"].startswith("You are summarizing")][-1]

    def test_the_window_is_the_models_real_one_capped_by_the_preset_and_sent(self):
        chat = self.engine.open()
        Model.limit = 4096
        self.talk(chat, "hi")
        self.assertEqual(self.last_request()["window"], 4096, "a model smaller than the preset: its own window")
        Model.limit = 1_048_576
        self.talk(chat, "again")
        self.assertEqual(self.last_request()["window"], 8192, "the preset caps a huge one")
        self.config["chatdgc_window"] = "max"
        self.talk(chat, "and again")
        self.assertEqual(self.last_request()["window"], 1_048_576)
        Model.limit = 0
        self.talk(chat, "unknown")
        self.assertEqual(self.last_request()["window"], fit_window.FALLBACK_WINDOW, "never a guess of 128k")

    def test_a_long_chat_is_summarized_before_it_overflows_and_says_so(self):
        chat = self.engine.open()
        long = "word " * 1200            # ~1,500 tokens each way
        for i in range(2):
            self.talk(chat, f"question {i}: {long}", f"answer {i}: {long}")
        self.assertEqual(self.world["summaries"], [], "under 75% of 8k: nothing summarized")
        said, compacted = [], []
        self.world["replies"].append("fine")
        self.engine.send(chat["id"], f"question 2: {long}", on_activity=lambda *a: said.append(a),
                         on_compacted=compacted.append)
        self.assertEqual(said, [("compacting", "")], "never silent")
        saved = self.store.get(chat["id"])
        summary = saved["summary"]
        self.assertTrue(summary["text"].startswith("SUMMARY #"))
        self.assertEqual(compacted, [summary])
        self.assertEqual(len(self.world["summaries"]), 2, "too long for one request: summarized in two rolling parts")
        kept = saved["messages"][[m["id"] for m in saved["messages"]].index(summary["upto"]) + 1:]
        self.assertTrue(kept and kept[0]["role"] in ("user", "assistant"))
        request = self.last_request()["messages"]
        self.assertIn("summarized to fit your context window", request[0]["content"])
        self.assertIn(summary["text"], request[0]["content"])
        self.assertLess(len(request) - 1, len(saved["messages"]), "only the recent turns word for word")
        self.assertEqual(len(saved["messages"]), 6, "the full transcript stays")
        self.assertIn("question 0", self.world["summaries"][0])
        for i in range(3, 6):
            self.talk(chat, f"question {i}: {long}", f"answer {i}: {long}")
        rolled = self.world["summaries"][-1]
        self.assertTrue(rolled.startswith("Summarized before (for context only):\n<<<\nSUMMARY #"), "the summary so far, as context")
        # Asked to rewrite the old summary with the new, deepseek-v4.1-flash kept only the new: 8 rolls of 8 until the
        # prompt said it replaced the old, and then still, live, every earlier answer gone in one run of about thirty.
        # Now what was summarized stays word for word, and only the new stretch is summarized after it.
        rolling = [s for s in self.world["sent"] if s["messages"][0]["content"].startswith("You are summarizing")][-1]
        self.assertIn("don't repeat it or rewrite it", rolling["messages"][0]["content"])
        kept = self.store.get(chat["id"])["summary"]["text"]
        self.assertTrue(kept.startswith("SUMMARY #1\n\nSUMMARY #2"), "the first summary, as it was written")
        self.assertTrue(kept.endswith(f"SUMMARY #{len(self.world['summaries'])}"), "and the newest part after it")
        first = next(s for s in self.world["sent"] if s["messages"][0]["content"].startswith("You are summarizing"))
        self.assertNotIn("Summarized before", first["messages"][1]["content"])
        self.assertNotIn("for context only", first["messages"][0]["content"],
                         "the first summary isn't told of one: a model wrote \"no prior context\" into it")
        self.assertNotIn("question 0", rolled, "what was summarized isn't read again")

    def test_compact_now_edit_the_summary_and_continue_in_a_new_chat(self):
        chat = self.engine.open()
        with self.assertRaises(ChatEngineError):
            self.talk(chat, "one", "1")
            self.engine.compact(chat["id"])
        for words in ("two", "three"):
            self.talk(chat, words, words.upper())
        summary = self.engine.compact(chat["id"])
        saved = self.store.get(chat["id"])
        self.assertEqual(summary["upto"], saved["messages"][-3]["id"], "everything before the last exchange")
        self.talk(chat, "four")
        self.assertEqual([m["content"] for m in self.last_request()["messages"][1:]], ["three", "THREE", "four"])
        edited = self.engine.set_summary(chat["id"], "  The user is planning a trip to Goa.  ")
        self.assertEqual((edited["text"], edited["edited"]), ("The user is planning a trip to Goa.", True))
        self.talk(chat, "five")
        self.assertIn("planning a trip to Goa", self.last_request()["messages"][0]["content"])
        for bad in ("", "x" * (fit_window.MAX_SUMMARY_CHARS + 1)):
            with self.subTest(bad=len(bad)), self.assertRaises(ChatEngineError):
                self.engine.set_summary(chat["id"], bad)
        fresh = self.engine.carry(chat["id"])
        self.assertNotEqual(fresh["id"], chat["id"])
        self.assertEqual((fresh["messages"], fresh["carried"]["from"]), ([], chat["id"]))
        self.assertTrue(fresh["carried"]["text"].startswith("The user is planning a trip to Goa.\n\nSUMMARY"),
                        "what you edited goes with it word for word, then the rest")
        self.assertIn("planning a trip to Goa", self.world["summaries"][-1], "it starts from what you edited")
        self.talk(fresh, "where were we?")
        self.assertIn("continues an earlier one", self.last_request()["messages"][0]["content"])
        self.assertEqual(len(self.store.get(chat["id"])["messages"]), 10, "the old chat is left as it was")

    def test_compact_now_is_offered_only_with_something_to_summarize(self):
        chat = self.engine.open()
        self.talk(chat, "one", "1")
        self.assertFalse(self.engine.context(chat["id"])["compactable"], "one exchange: what Compact now keeps")
        with self.assertRaisesRegex(ChatEngineError, "keeps your last exchange word for word"):
            self.engine.compact(chat["id"])
        self.talk(chat, "two", "2")
        self.assertTrue(self.engine.context(chat["id"])["compactable"])
        self.engine.compact(chat["id"])
        self.assertFalse(self.engine.context(chat["id"])["compactable"])
        asked = len(self.world["summaries"])
        # The live run: right after a summary, Compact now said "this chat is still short" of a chat at 52%.
        with self.assertRaisesRegex(ChatEngineError, "Everything before your last exchange is already summarized"):
            self.engine.compact(chat["id"])
        self.assertEqual(len(self.world["summaries"]), asked, "no model request for nothing")
        self.talk(chat, "three", "3")
        self.assertTrue(self.engine.context(chat["id"])["compactable"], "another exchange: the one before can go in")

    def test_one_file_never_fills_the_window(self):
        chat = self.engine.open()
        self.talk(chat, "Read this", attachments=[{"kind": "text", "text": "row\n" * 20_000, "name": "big.csv"}])
        sent = self.last_request()["messages"][1]["content"]
        self.assertIn("Only the first part of big.csv fits this chat's context window", sent)
        self.assertLess(len(sent), int(8192 * fit_window.FILE_SHARE) * fit_window.CHARS_PER_TOKEN + 2000)

    def test_the_meter_counts_what_the_model_reports_else_estimates(self):
        chat = self.engine.open()
        Model.limit = 32768
        self.talk(chat, "hello")
        self.world["usage"] = {"input_tokens": 1500, "output_tokens": 300}
        self.talk(chat, "again", "a reply")
        report = self.engine.context(chat["id"])
        self.assertEqual((report["window"], report["limit"], report["preset"]), (8192, 32768, "8k"))
        self.assertEqual((report["used"], report["source"]), (1800, "reported"))
        self.assertEqual(set(report["parts"]), {"instructions", "summary", "files", "conversation"})
        fresh = self.engine.open()
        self.store.create(chat_id=fresh["id"])
        estimate = self.engine.context(fresh["id"])
        self.assertEqual(estimate["source"], "estimated")
        self.assertGreater(estimate["parts"]["instructions"], 100)

    def test_the_meter_counts_the_last_request_and_a_summary_since_resets_it(self):
        chat = self.engine.open()
        Model.limit = 32768
        self.world.update(usage={"input_tokens": 1500, "output_tokens": 300}, finish="length")
        reply = self.talk(chat, "tell me a long story", "Once upon")
        self.world.update(usage={"input_tokens": 1900, "output_tokens": 200}, finish="stop")
        self.engine.continue_reply(chat["id"], reply["id"])
        self.assertEqual(self.store.get(chat["id"])["messages"][-1]["usage"]["input_tokens"], 3400, "its cost: both calls")
        self.assertEqual(self.engine.context(chat["id"])["used"], 2100, "what the window holds: the last request, not the sum")
        for words in ("two", "three"):
            self.talk(chat, words, words.upper())
        self.assertEqual(self.engine.context(chat["id"])["source"], "reported")
        self.engine.compact(chat["id"])
        after = self.engine.context(chat["id"])
        # The live run: the meter stayed at 60% after Compact now, the count of the request before the summary.
        self.assertEqual(after["source"], "estimated", "Compact now changed the next request: that count no longer stands")
        self.assertLess(after["used"], 2100)
        self.talk(chat, "four")
        self.assertEqual(self.engine.context(chat["id"])["source"], "reported", "the next reply is counted again")
        self.engine.set_summary(chat["id"], "Edited.")
        self.assertEqual(self.engine.context(chat["id"])["source"], "estimated", "so is an edited summary")

    def test_a_summary_far_past_its_length_is_shortened_once(self):
        chat = self.engine.open()
        for words in ("one", "two", "three"):
            self.talk(chat, words, words.upper())
        self.world["summary_text"] = "A fact. " * 400                  # ~800 tokens, past twice the ~490 words asked
        self.assertEqual(self.engine.compact(chat["id"])["text"], "A fact. " * 399 + "A fact.", "within reach: kept")
        self.assertNotIn("shortened", self.world)
        self.talk(chat, "four")
        self.world["summary_text"] = "A fact. " * 1200
        self.assertEqual(self.engine.compact(chat["id"])["text"], "SHORTER")
        self.assertEqual(len(self.world["shortened"]), 1, "asked once")

    def test_a_summary_belongs_to_its_version(self):
        chat = self.engine.open()
        for words in ("one", "two", "three"):
            self.talk(chat, words, words.upper())
        self.engine.compact(chat["id"])
        first = self.store.get(chat["id"])["messages"][0]
        self.world["replies"].append("ONE again")
        self.engine.edit(chat["id"], first["id"], "one, changed")
        self.assertNotIn("summarized to fit", self.last_request()["messages"][0]["content"],
                         "another version from before the summary has no summary")
        self.engine.version(chat["id"], "root", 0)
        self.talk(chat, "four")
        self.assertIn("summarized to fit", self.last_request()["messages"][0]["content"], "back again: so is its summary")

    def test_a_summary_that_cant_be_written_doesnt_stop_the_reply(self):
        chat = self.engine.open()
        long = "word " * 1200
        for i in range(2):
            self.talk(chat, f"q{i} {long}", f"a{i} {long}")
        self.world["summary_fails"] = True
        reply = self.talk(chat, f"q2 {long}", "still answered")
        self.assertEqual(reply["text"], "still answered")
        self.assertNotIn("summary", self.store.get(chat["id"]))
        with self.assertRaises(ChatEngineError):
            self.engine.compact(chat["id"])


if __name__ == "__main__":
    unittest.main()
