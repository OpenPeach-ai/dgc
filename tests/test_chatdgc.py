"""ChatDGC Phase 1: its own store and engine (founder, 2026-10-09: a chat engine of its own, chats that never
depend on the folder DGC runs in, replies as long as the model allows, the model and thinking kept per chat)."""
import json
import os
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

from dgc.chatdgc.engine import CONTINUE, ChatEngine, ChatEngineError
from dgc.chatdgc.store import ChatStore, ChatStoreError, title_from


class FakeConfig(dict):
    base_url, api_key, model = "http://127.0.0.1:11434/v1", "", "deepseek-v4.1-flash:cloud"

    def get(self, key, default=None):
        return super().get(key, default)


class FakeClient:
    """The model: streams its parts, then finishes as told."""

    def __init__(self, model, script):
        self.model, self.script, self.calls = model, script, []

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        self.calls.append({"messages": messages, "effort": reasoning_effort, "tools": tools})
        step = self.script.pop(0)
        for part in step.get("thinking", []):
            on_thinking(part)
        for part in step.get("parts", []):
            if cancel is not None and cancel.is_set():
                break
            on_text(part)
            if step.get("cancel_after") == part:
                cancel.set()
        if step.get("raise"):
            raise RuntimeError(step["raise"])
        return SimpleNamespace(content="".join(step.get("parts", [])), finish_reason=step.get("finish", "stop"),
                               usage=step.get("usage", {"input_tokens": 10, "output_tokens": 5}), thinking="")


class ChatDGCTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "chat"
        self.store = ChatStore(self.root)
        self.script, self.clients = [], []

        def factory(model):
            client = FakeClient(model or FakeConfig.model, self.script)
            self.clients.append(client)
            return client
        self.engine = ChatEngine(FakeConfig(thinking="off"), self.store, client_factory=factory)

    def test_a_chat_is_its_own_file_owner_only_and_in_the_list(self):
        chat = self.engine.open()
        self.script.append({"parts": ["Paris ", "is the capital."]})
        reply = self.engine.send(chat["id"], "What's the capital of France?\nThanks")
        self.assertEqual((reply["text"], reply["finish"], reply["role"]), ("Paris is the capital.", "stop", "assistant"))
        saved = self.store.get(chat["id"])
        self.assertEqual([m["role"] for m in saved["messages"]], ["user", "assistant"])
        self.assertEqual(saved["title"], "What's the capital of France?", "the first line names it")
        path = self.root / "chats" / f"{chat['id']}.json"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        listed = self.store.listing()
        self.assertEqual([c["id"] for c in listed["chats"]], [chat["id"]])
        self.assertEqual(listed["chats"][0]["preview"], "Paris is the capital.")
        self.assertEqual(self.store.listing(query="capital")["total"], 1)
        self.assertEqual(self.store.listing(query="berlin")["total"], 0)

    def test_the_model_reads_chatdgcs_own_instructions_and_never_old_thinking(self):
        chat = self.engine.open()
        self.script += [{"thinking": ["hmm"], "parts": ["First."]}, {"parts": ["Second."]}]
        self.engine.send(chat["id"], "one")
        self.engine.send(chat["id"], "two")
        sent = self.clients[-1].calls[0]["messages"]
        self.assertEqual(sent[0]["role"], "system")
        self.assertIn("You are ChatDGC", sent[0]["content"])
        self.assertNotIn("coding", sent[0]["content"].lower(), "not the coding agent's prompt")
        self.assertEqual([(m["role"], m["content"]) for m in sent[1:]], [("user", "one"), ("assistant", "First."), ("user", "two")])
        self.assertIsNone(self.clients[-1].calls[0]["tools"], "no tools in Phase 1")
        self.assertEqual(self.store.get(chat["id"])["messages"][1]["thinking"], "hmm", "its thinking is kept to show")

    def test_model_and_thinking_are_kept_per_chat(self):
        a, b = self.engine.open(), self.engine.open()
        self.script += [{"parts": ["x"]}, {"parts": ["y"]}, {"parts": ["z"]}]
        self.engine.send(a["id"], "hi", model="qwen3:32b", thinking="high")
        self.engine.send(b["id"], "hi")
        self.engine.send(a["id"], "again")
        self.assertEqual((self.clients[0].model, self.clients[0].calls[0]["effort"]), ("qwen3:32b", "high"))
        self.assertEqual((self.clients[1].model, self.clients[1].calls[0]["effort"]), (FakeConfig.model, "off"))
        self.assertEqual((self.clients[2].model, self.clients[2].calls[0]["effort"]), ("qwen3:32b", "high"), "reopened, it keeps them")
        self.assertEqual((self.store.get(a["id"])["model"], self.store.get(a["id"])["thinking"]), ("qwen3:32b", "high"))
        with self.assertRaises(ChatEngineError):
            self.engine.send(a["id"], "x", thinking="ultra")

    def test_a_reply_cut_at_the_models_limit_continues_in_the_same_message(self):
        chat = self.engine.open()
        self.script += [{"parts": ["Chapter one. "], "finish": "length"}, {"parts": ["Chapter two."]}]
        cut = self.engine.send(chat["id"], "Write me a long story.")
        self.assertEqual(cut["finish"], "length")
        done = self.engine.continue_reply(chat["id"], cut["id"])
        self.assertEqual((done["id"], done["text"], done["finish"]), (cut["id"], "Chapter one. Chapter two.", "stop"))
        sent = self.clients[-1].calls[0]["messages"]
        self.assertEqual(sent[-1], {"role": "user", "content": CONTINUE})
        self.assertEqual(sent[-2], {"role": "assistant", "content": "Chapter one. "})
        self.assertEqual(len(self.store.get(chat["id"])["messages"]), 2, "one reply, not two")
        with self.assertRaises(ChatEngineError):
            self.engine.continue_reply(chat["id"], cut["id"])

    def test_stop_keeps_what_was_written_and_it_can_continue(self):
        chat = self.engine.open()
        cancel = threading.Event()
        self.script.append({"parts": ["Once ", "upon ", "a time"], "cancel_after": "upon "})
        stopped = self.engine.send(chat["id"], "Tell a story", cancel=cancel)
        self.assertEqual((stopped["text"], stopped["finish"]), ("Once upon ", "cancelled"))
        self.script.append({"parts": ["a time."]})
        self.assertEqual(self.engine.continue_reply(chat["id"], stopped["id"])["text"], "Once upon a time.")

    def test_a_model_that_fails_says_so_and_the_question_stays(self):
        chat = self.engine.open()
        self.script.append({"raise": "connection refused"})
        with self.assertRaises(ChatEngineError) as raised:
            self.engine.send(chat["id"], "Hello?")
        self.assertIn("The model didn't answer: connection refused", str(raised.exception))
        self.assertEqual([m["role"] for m in self.store.get(chat["id"])["messages"]], ["user"], "your message is kept")
        self.script.append({"parts": ["Half an an"], "raise": "stream broke"})
        partial = self.engine.send(chat["id"], "Again")
        self.assertEqual((partial["finish"], partial["text"]), ("error", "Half an an"))
        self.assertIn("stream broke", partial["error"])

    def test_a_temporary_chat_is_never_written_or_listed(self):
        chat = self.engine.open(temporary=True)
        self.script.append({"parts": ["Sure."]})
        self.engine.send(chat["id"], "Just between us")
        self.assertEqual(self.store.listing()["total"], 0)
        self.assertFalse((self.root / "chats" / f"{chat['id']}.json").exists())
        self.assertEqual(len(self.engine.open(chat["id"])["messages"]), 2, "it lives while DGC runs")

    def test_rename_pin_archive_and_delete(self):
        first, second = self.engine.open(), self.engine.open()
        self.store.update(second["id"], pinned=True)
        self.assertEqual([c["id"] for c in self.store.listing()["chats"]], [second["id"], first["id"]], "pinned first")
        self.store.update(first["id"], title="  Goa   trip  ")
        self.assertEqual(self.store.get(first["id"])["title"], "Goa trip")
        self.store.update(first["id"], archived=True)
        self.assertEqual([c["id"] for c in self.store.listing()["chats"]], [second["id"]])
        self.assertEqual([c["id"] for c in self.store.listing(archived=True)["chats"]], [first["id"]])
        self.store.delete(first["id"])
        with self.assertRaises(ChatStoreError):
            self.store.get(first["id"])
        self.assertEqual(self.store.listing(archived=True)["total"], 0)
        for bad in ({"title": "   "}, {"pinned": "yes"}):
            with self.subTest(bad=bad), self.assertRaises(ChatStoreError):
                self.store.update(second["id"], **bad)
        for bad in ("chat_x", "../etc/passwd", None):
            with self.subTest(bad=bad), self.assertRaises(ChatStoreError):
                self.store.get(bad)

    def test_chats_never_depend_on_the_folder_dgc_runs_in(self):
        chat = self.engine.open()
        here = os.getcwd()
        self.addCleanup(os.chdir, here)
        os.chdir(tempfile.mkdtemp())
        self.assertEqual(ChatStore(self.root).get(chat["id"])["id"], chat["id"])
        self.assertTrue(str(ChatStore().root).endswith(os.path.join(".dgc", "chat")), "one place in your profile")

    def test_titles(self):
        self.assertEqual(title_from("\n\n  Plan   my week  \nmore"), "Plan my week")
        self.assertEqual(title_from(""), "New chat")
        self.assertTrue(title_from("x" * 200).endswith("…"))


if __name__ == "__main__":
    unittest.main()
