"""Interactive answers (ChatGPT's): show_widget puts one small self-contained HTML page under the reply, which the
screen frames in a sandbox with no network. Measured with deepseek-v4.1-flash: as a ```widget block, an EMI calculator
or a stopwatch went into a canvas or a file 5 of 6 times; as a tool, a widget 9 of 9, and none for a plain question."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from dgc.chatdgc.engine import LOOK_UP, MAX_WIDGET_CHARS, ChatEngine
from dgc.chatdgc.prompt import WIDGETS, system_prompt
from dgc.chatdgc.store import ChatStore
from dgc.llm import ToolCall
from dgc.shared_memory import SharedMemory

PAGE = "<title>EMI</title><label>Amount <input id=a type=number></label><script>/* math */</script>"


class Model:
    def __init__(self, world):
        self.world, self.model, self.context_size = world, "chat-model", 0

    def prepare_model(self, **_):
        pass

    def model_context_limit(self):
        return 32768

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        if str(messages[0]["content"]).startswith(LOOK_UP[:60]):
            return SimpleNamespace(content="", tool_calls=[ToolCall("lu", "search_first", {"needs_search": False, "query": ""})],
                                   finish_reason="stop", thinking="", usage={})
        self.world["read"].append({"messages": messages, "tools": [t["function"]["name"] for t in tools or []]})
        step = self.world["script"].pop(0) if self.world["script"] else {"parts": ["OK."]}
        for part in step.get("parts", []):
            on_text(part)
        calls = [ToolCall(f"c{i}", name, args) for i, (name, args) in enumerate(step.get("calls", []))]
        return SimpleNamespace(content="".join(step.get("parts", [])), tool_calls=calls, finish_reason="stop",
                               thinking="", usage={"input_tokens": 10, "output_tokens": 5})


class Widgets(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-widgets-")
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        self.world = {"script": [], "read": []}
        config = SimpleNamespace(base_url="", api_key="", model="chat-model", project_root=str(folder),
                                 get=lambda key, default=None: default)
        self.engine = ChatEngine(config, ChatStore(folder / "chat"), searcher=lambda q: [],
                                 memory=SharedMemory(folder / "memory"), projects=lambda hidden: [],
                                 client_factory=lambda model: Model(self.world), plugins=lambda chat, said, taint: None)

    def test_a_widget_is_kept_on_the_reply_shown_as_its_made_once_a_reply_and_read_back(self):
        shown = []
        self.world["script"] += [{"parts": ["Here."], "calls": [("show_widget", {"title": "EMI  calculator", "html": PAGE})]},
                                 {"parts": [" Type the amount."]}]
        chat = self.engine.open()
        reply = self.engine.send(chat["id"], "EMI calculator please", on_widget=shown.append)
        [widget] = reply["widgets"]
        self.assertRegex(widget["id"], r"^wg_[a-f0-9]{16}$")
        self.assertEqual((widget["title"], widget["html"], widget["at"]), ("EMI calculator", PAGE, len("Here.")))
        self.assertEqual(shown, [widget])
        self.assertIn("show_widget", self.world["read"][0]["tools"])
        self.assertNotIn("show_widget", self.world["read"][1]["tools"], "one a reply")
        told = [m["content"] for m in self.world["read"][1]["messages"] if m["role"] == "tool"]
        self.assertIn("The widget EMI calculator is open in a tab beside the chat, with a card under your reply", told[0])
        self.world["script"] += [{"parts": ["Done."]}]
        self.engine.send(chat["id"], "Add a tenure slider.")
        history = "\n".join(str(m["content"]) for m in self.world["read"][-1]["messages"])
        self.assertIn(f"[You showed an interactive widget here, EMI calculator. Its page:\n<<<\n{PAGE}\n>>>]", history)

    def test_an_empty_or_huge_page_is_refused(self):
        self.world["script"] += [{"calls": [("show_widget", {"title": "x", "html": " "}), ("show_widget", {"title": "y", "html": "x" * (MAX_WIDGET_CHARS + 1)})]},
                                 {"parts": ["Sorry."]}]
        chat = self.engine.open()
        reply = self.engine.send(chat["id"], "Widget")
        self.assertNotIn("widgets", reply)
        told = [m["content"] for m in self.world["read"][-1]["messages"] if m["role"] == "tool"]
        self.assertEqual([t.split(":")[0] for t in told], ["error", "error"])

    def test_only_a_model_that_takes_tools_is_told_about_widgets(self):
        self.assertIn(WIDGETS, system_prompt())
        self.assertNotIn(WIDGETS, system_prompt(ask=False))


if __name__ == "__main__":
    unittest.main()
