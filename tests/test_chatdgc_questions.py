"""ChatDGC: a question in the answer, as ChatGPT asks one. The model calls ask_user mid-answer; nothing waits: the
card is shown where it asked and the answer goes on. Continue sends the message the model wrote ahead of time,
with the choice in. The question lives on the reply and the answer on the user's message, so it survives
anything a chat survives. A model that can't take tools still answers."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from dgc.chatdgc import engine as engine_module
from dgc.chatdgc.engine import ASKED, ChatEngine, ChatEngineError
from dgc.chatdgc.store import ChatStore
from dgc.shared_memory import SharedMemory
from dgc.llm import ToolCall

FUNDS = {"question": "Where is the money held now, and where did it come from?",
         "options": ["Personal savings in India", "Profits in my Indian companies", "Other source"],
         "prompt": "The funds for my London property come from: {answer}. Please analyse the FEMA routes open to me."}


def looked_up(messages) -> bool:
    """The engine's check before an answer: does this message need the web first? (dgc/chatdgc/engine.py)"""
    from dgc.chatdgc.engine import LOOK_UP
    return str(messages[0].get("content", "")).startswith(LOOK_UP[:60])


def no_look_up():
    from types import SimpleNamespace as _NS
    from dgc.llm import ToolCall as _Call
    return _NS(content="", tool_calls=[_Call("lu", "search_first", {"needs_search": False, "query": ""})],
               finish_reason="stop", thinking="", usage={})


class Config(dict):
    base_url, api_key, model = "http://127.0.0.1:11434/v1", "", "chat-model"

    def get(self, key, default=None):
        return super().get(key, default)


class Model:
    """Plays a script: each step writes `parts`, then calls `calls`. `toolless` refuses any request with tools,
    as Ollama does for a model that can't take them."""

    def __init__(self, model, world):
        self.model, self.world, self.context_size = model, world, 0

    def prepare_model(self, **_):
        pass

    def model_context_limit(self):
        return 32768

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        if looked_up(messages):                      # "does this need the web first?": no
            return no_look_up()
        self.world["requests"].append({"messages": [dict(m) for m in messages],
                                       "tools": [t["function"]["name"] for t in tools or []]})
        if self.world.get("toolless") and tools:
            raise RuntimeError('HTTP 400: {"error":"registry.ollama.ai/library/gemma3:4b does not support tools"}')
        step = self.world["script"].pop(0) if self.world["script"] else {"parts": ["ok"]}
        for part in step.get("parts", []):
            on_text(part)
        calls = [ToolCall(f"c{i}", name, args) for i, (name, args) in enumerate(step.get("calls", []))]
        return SimpleNamespace(content="".join(step.get("parts", [])), finish_reason="stop", thinking="",
                               tool_calls=calls, usage={"input_tokens": 10, "output_tokens": 5})


class QuestionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-questions-")
        self.addCleanup(temp.cleanup)
        self.store = ChatStore(Path(temp.name) / "chat")
        self.world = {"requests": [], "script": []}
        self.engine = ChatEngine(Config(), self.store, client_factory=lambda model: Model(model or "chat-model", self.world),
                                 memory=SharedMemory(Path(temp.name) / "memory"), projects=lambda hidden: [])

    def asked(self, chat, **extra):
        """A reply that answers, asks, and goes on, as ChatGPT's did."""
        self.world["script"] += [{"parts": ["Get a written opinion first.", "\n\n## My question to you"],
                                  "calls": [("ask_user", {**FUNDS, **extra})]},
                                 {"parts": ["The answer matters: the routes differ."]}]
        shown = []
        reply = self.engine.send(chat["id"], "Can I buy a London flat with my money in India?", on_question=shown.append)
        return reply, shown

    def test_a_question_is_shown_where_it_was_asked_and_the_answer_goes_on(self):
        chat = self.engine.open()
        reply, shown = self.asked(chat)
        first, second = self.world["requests"][-2:]
        self.assertEqual(first["tools"], ["ask_user", "remember", "forget"], "offered with web search off: the model decides")
        self.assertEqual(second["tools"], ["remember", "forget"], "one question per reply: not offered again")
        self.assertEqual(second["messages"][-1], {"role": "tool", "tool_call_id": "c0", "content": ASKED},
                         "it doesn't wait: told it's shown, and to carry on")
        question = reply["questions"][0]
        self.assertEqual(shown, [question], "said as it's asked, so the card shows mid-reply")
        self.assertEqual(question["options"], ["Personal savings in India", "Profits in my Indian companies"],
                         "the card's own box is the Other")
        before = "Get a written opinion first.\n\n## My question to you"
        self.assertEqual(question["at"], len(before))
        self.assertEqual(reply["text"], before + "\n\nThe answer matters: the routes differ.")
        self.assertEqual(self.store.get(chat["id"])["messages"][-1]["questions"], [question], "kept on the reply")

    def test_continue_sends_the_message_the_model_wrote_with_the_choice_in(self):
        chat = self.engine.open()
        reply, _ = self.asked(chat)
        self.engine.answer(chat["id"], reply["id"], 0, "Personal savings in India")
        mine = self.store.get(chat["id"])["messages"][-2]
        self.assertEqual(mine["text"], "The funds for my London property come from: Personal savings in India. "
                                       "Please analyse the FEMA routes open to me.")
        self.assertEqual(mine["answers"], {"message": reply["id"], "question": 0, "choice": "Personal savings in India"})
        history = self.world["requests"][-1]["messages"]
        said = next(m["content"] for m in history if m["role"] == "assistant")
        self.assertIn("## My question to you\n\n[You asked the user, as a card with choices: Where is the money held",
                      said, "the model reads its question back where it asked it")
        self.assertIn("Options: Personal savings in India; Profits in my Indian companies; or their own answer.]", said)
        with self.assertRaisesRegex(ChatEngineError, "moved on"):
            self.engine.answer(chat["id"], reply["id"], 0, "Profits in my Indian companies")

    def test_their_own_answer_and_what_isnt_an_answer(self):
        chat = self.engine.open()
        reply, _ = self.asked(chat)
        for question, choice, said in ((1, "x", "isn't in this reply"), (True, "x", "isn't in this reply"),
                                       (0, "   ", "Choose an answer")):
            with self.subTest(question=question, choice=choice), self.assertRaisesRegex(ChatEngineError, said):
                self.engine.answer(chat["id"], reply["id"], question, choice)
        mine = self.store.get(chat["id"])["messages"][0]
        with self.assertRaisesRegex(ChatEngineError, "isn't in this chat"):
            self.engine.answer(chat["id"], mine["id"], 0, "x")
        self.engine.answer(chat["id"], reply["id"], 0, "  An inheritance,   held abroad ")
        self.assertIn("come from: An inheritance, held abroad. Please", self.store.get(chat["id"])["messages"][-2]["text"])
        other = self.engine.open()
        reply, _ = self.asked(other, prompt="")
        self.engine.answer(other["id"], reply["id"], 0, "Personal savings in India")
        self.assertEqual(self.store.get(other["id"])["messages"][-2]["text"],
                         "Where is the money held now, and where did it come from? Personal savings in India.",
                         "no message written for it: the question and the choice")

    def test_one_question_per_reply_and_one_that_isnt_a_question_isnt_shown(self):
        chat = self.engine.open()
        self.world["script"] += [{"parts": ["Two at once."], "calls": [("ask_user", FUNDS), ("ask_user", FUNDS)]},
                                 {"parts": ["Done."]}]
        reply = self.engine.send(chat["id"], "hi")
        self.assertEqual(len(reply["questions"]), 1)
        told = [m["content"] for m in self.world["requests"][-1]["messages"] if m["role"] == "tool"]
        self.assertEqual(told[0], ASKED)
        self.assertIn("one question per reply", told[1])
        for bad in ({"question": "", "options": ["a", "b"]}, {"question": "Which?", "options": ["only one", "Other"]},
                    {"question": "Which?", "options": "a, b"}, {"question": "Which?", "options": ["Same", "same"]}):
            with self.subTest(bad=bad):
                self.world["script"] += [{"parts": ["Asking."], "calls": [("ask_user", bad)]}, {"parts": ["Done."]}]
                reply = self.engine.send(chat["id"], "again")
                self.assertNotIn("questions", reply)
                self.assertIn("Not shown", self.world["requests"][-1]["messages"][-1]["content"])

    def test_a_question_is_in_the_summary_the_export_and_search(self):
        chat = self.engine.open()
        reply, _ = self.asked(chat)
        self.assertIn("[You asked the user, as a card with choices: Where is the money held",
                      self.engine._plain(reply), "a summary keeps that it was asked")
        exported = self.engine.export(chat["id"], "markdown")
        self.assertIn("## My question to you\n\n> **Where is the money held now, and where did it come from?**\n>\n"
                      "> - Personal savings in India\n> - Profits in my Indian companies", exported)
        found = self.store.listing(query="Profits")
        self.assertEqual([c["id"] for c in found["chats"]], [chat["id"]], "words only the card shows are found too")

    def test_a_model_that_cant_take_tools_still_answers(self):
        chat = self.engine.open()
        self.world["toolless"] = True
        reply = self.engine.send(chat["id"], "hi")
        self.assertEqual(reply["text"], "ok")
        self.assertEqual([r["tools"] for r in self.world["requests"]], [["ask_user", "remember", "forget"], []], "asked once, then without")
        self.engine.send(chat["id"], "again", search="auto")
        self.assertEqual(self.world["requests"][-1]["tools"], [], "not offered again, web search included")
        self.assertNotIn("ask_user", self.world["requests"][-1]["messages"][0]["content"], "nor told about it")

    def test_another_failure_is_not_retried(self):
        chat = self.engine.open()
        original = Model.chat

        def broken(model, messages, tools=None, **kwargs):
            model.world["requests"].append({"tools": tools})
            raise RuntimeError("connection refused")
        Model.chat = broken
        self.addCleanup(setattr, Model, "chat", original)
        with self.assertRaises(ChatEngineError):
            self.engine.send(chat["id"], "hi")
        self.assertEqual(len(self.world["requests"]), 1)
        self.assertEqual(self.engine._toolless, set())


class AnsweredTextTests(unittest.TestCase):
    def test_the_choice_goes_where_the_model_said(self):
        self.assertEqual(engine_module.answered({"prompt": "I'm {answer}; what next?"}, "a student"),
                         "I'm a student; what next?")


if __name__ == "__main__":
    unittest.main()
