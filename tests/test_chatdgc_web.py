"""ChatDGC and the web, as ChatGPT has it: search is always there, and a message that turns on facts (rules, rates,
prices, news, people) is looked up before it's answered, not left to a model that's sure of itself. The box's Search
makes it search first for one message; only Settings -> Web search turns it off, and then nothing goes online."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from dgc.chatdgc.engine import LOOK_UP, ChatEngine, ChatEngineError
from dgc.chatdgc.store import ChatStore
from dgc.llm import ToolCall
from dgc.shared_memory import SharedMemory


class Config(dict):
    base_url, api_key, model = "http://127.0.0.1:11434/v1", "", "chat-model"

    def get(self, key, default=None):
        return super().get(key, default)


class Model:
    def __init__(self, model, world):
        self.model, self.world, self.context_size = model, world, 0

    def prepare_model(self, **_):
        pass

    def model_context_limit(self):
        return 32768

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        system = messages[0]["content"]
        if system.startswith(LOOK_UP[:60]):
            self.world["looked"].append(messages[-1]["content"])
            decided = self.world["decide"]
            if isinstance(decided, Exception):
                raise decided
            return SimpleNamespace(content="", tool_calls=[ToolCall("lu", "search_first", decided)], finish_reason="stop",
                                   thinking="", usage={})
        self.world["answers"].append({"system": system, "tools": [t["function"]["name"] for t in tools or []]})
        on_text("An answer [1].")
        return SimpleNamespace(content="An answer [1].", tool_calls=[], finish_reason="stop", thinking="", usage={})


class WebTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-web-")
        self.addCleanup(temp.cleanup)
        self.world = {"looked": [], "answers": [], "searched": [], "decide": {"needs_search": False, "query": ""}}
        self.config = Config()

        def searcher(query):
            self.world["searched"].append(query)
            return [{"title": "LRS FAQ", "url": "https://rbi.org.in/lrs", "snippet": "Up to USD 250,000 a year."}]
        self.engine = ChatEngine(self.config, ChatStore(Path(temp.name) / "chat"), searcher=searcher,
                                 memory=SharedMemory(Path(temp.name) / "memory"), projects=lambda hidden: [],
                                 client_factory=lambda model: Model(model or "chat-model", self.world))

    def test_a_question_that_turns_on_facts_is_looked_up_before_its_answered(self):
        self.world["decide"] = {"needs_search": True, "query": "LRS property abroad limit"}
        chat = self.engine.open()
        said = []
        reply = self.engine.send(chat["id"], "Can I use the LRS to buy a flat in London?", search="auto",
                                 on_activity=lambda *a: said.append(a))
        self.assertEqual(self.world["searched"], ["LRS property abroad limit"])
        self.assertEqual(said, [("searching", "LRS property abroad limit")], "said on screen while it looks")
        answer = self.world["answers"][-1]
        self.assertIn("Searched the web before you answer", answer["system"])
        self.assertIn("[1] LRS FAQ\nhttps://rbi.org.in/lrs\nUp to USD 250,000 a year.", answer["system"])
        self.assertIn("web_search", answer["tools"], "it can still search again")
        self.assertEqual((reply["searches"], reply["sources"]),
                         (["LRS property abroad limit"], [{"n": 1, "title": "LRS FAQ", "url": "https://rbi.org.in/lrs"}]))
        self.assertIn("Can I use the LRS", self.world["looked"][0], "the check reads the message")

    def test_what_needs_no_web_isnt_searched_and_a_failed_check_never_stops_the_reply(self):
        chat = self.engine.open()
        self.engine.send(chat["id"], "Write a haiku about rain", search="auto")
        self.assertEqual(self.world["searched"], [])
        self.assertNotIn("Searched the web", self.world["answers"][-1]["system"])
        self.world["decide"] = RuntimeError("model hiccup")
        reply = self.engine.send(chat["id"], "And one about sun", search="auto")
        self.assertEqual(reply["text"], "An answer [1].")

    def test_no_check_for_search_first_a_continued_reply_or_a_model_without_tools(self):
        chat = self.engine.open()
        self.engine.send(chat["id"], "Search this", search="on")
        self.assertEqual(self.world["looked"], [], "Search in the box: told to search, no need to ask")
        self.engine._toolless.add("chat-model")
        self.engine.send(chat["id"], "again", search="auto")
        self.assertEqual(self.world["looked"], [])

    def test_search_is_always_there_unless_settings_turns_it_off(self):
        chat = self.engine.open()
        self.engine.send(chat["id"], "hi", search="auto")
        self.assertIn("web_search", self.world["answers"][-1]["tools"])
        self.config["chatdgc_web"] = False
        self.engine.send(chat["id"], "hi again", search="on")
        last = self.world["answers"][-1]
        self.assertNotIn("web_search", last["tools"], "off in Settings: nothing goes online, whatever the box says")
        self.assertIn("can't browse the web", last["system"])
        self.assertEqual(len(self.world["looked"]), 1, "and no check either")
        with self.assertRaisesRegex(ChatEngineError, "web search is off in Settings"):
            self.engine.research_plan(chat["id"], "Research this")


if __name__ == "__main__":
    unittest.main()
