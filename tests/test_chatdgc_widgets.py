"""Interactive answers (ChatGPT's): show_widget keeps one small self-contained HTML page on the reply, which opens in a
locked-down tab beside the chat. Measured with deepseek-v4.1-flash: as a ```widget block, an EMI calculator or a
stopwatch went into a canvas or a file 5 of 6 times; as a tool, a widget 9 of 9, and none for a plain question. The
screen tells what an open widget shows, and the model checks it with that, fixing it once if it's wrong."""
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

from dgc.chatdgc import service as chat_service
from dgc.chatdgc.engine import LOOK_UP, MAX_WIDGET_CHARS, WIDGET_CHECK, WIDGET_NOT_MADE, ChatEngine
from dgc.chatdgc.prompt import WIDGETS, system_prompt
from dgc.chatdgc.service import ChatService
from dgc.chatdgc.store import ChatStore
from dgc.editor_protocol import event_error
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
        if messages[0]["content"] == WIDGET_CHECK:
            self.world.setdefault("checked", []).append(messages[1]["content"])
            return SimpleNamespace(content=self.world.get("verdict", "EMI 43,391 is right.\nVERDICT: OK"), tool_calls=[],
                                   finish_reason="stop", thinking="", usage={"input_tokens": 100, "output_tokens": 7})
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

    def told(self, step):
        return [m["content"] for m in self.world["read"][step]["messages"] if m["role"] == "tool"]

    def test_a_widget_whose_code_failed_is_told_so_and_fixed_once_in_place(self):
        fixed = PAGE.replace("/* math */", "/* math, fixed */")
        reports = [{"shown": True, "text": "EMI Monthly payment —", "errors": ["Uncaught TypeError: Cannot set properties of undefined"]},
                   {"shown": True, "text": "EMI Monthly payment ₹43,391", "errors": []}]
        shown = []

        def on_widget(widget):
            shown.append(dict(widget))
            return reports.pop(0)
        self.world["script"] += [{"calls": [("show_widget", {"title": "EMI", "html": PAGE})]},
                                 {"calls": [("show_widget", {"title": "EMI calculator", "html": fixed})]},
                                 {"parts": ["It works out your monthly payment."]}]
        chat = self.engine.open()
        reply = self.engine.send(chat["id"], "EMI calculator please", on_widget=on_widget)
        self.assertIn("but its code failed: Uncaught TypeError: Cannot set properties of undefined. It shows: «EMI Monthly "
                      "payment —». Fix it: call show_widget again with the whole corrected page (it replaces this one).",
                      self.told(1)[0])
        self.assertIn("show_widget", self.world["read"][1]["tools"], "one fix")
        self.assertIn("The widget EMI calculator is fixed. It shows: «EMI Monthly payment ₹43,391».", self.told(2)[-1])
        self.assertNotIn("show_widget", self.world["read"][2]["tools"], "and only one")
        [widget] = reply["widgets"]
        self.assertEqual([w["id"] for w in shown], [widget["id"]] * 2, "the same widget, replaced")
        self.assertEqual((widget["html"], widget["title"]), (fixed, "EMI calculator"))

    def test_what_a_widget_shows_is_checked_in_a_call_of_its_own_never_in_the_reply(self):
        self.world["script"] += [{"calls": [("show_widget", {"title": "EMI", "html": PAGE})]},
                                 {"parts": ["It works out your monthly payment."]}]
        chat = self.engine.open()
        reply = self.engine.send(chat["id"], "EMI calculator please",
                                 on_widget=lambda w: {"shown": True, "text": "EMI\n\n ₹43,391", "errors": []})
        self.assertEqual(self.world["checked"], ["Asked for: EMI calculator please\n\nThe widget, EMI, shows:\nEMI ₹43,391"])
        self.assertEqual(self.told(1), ["The widget EMI is open in a tab beside the chat, with a card under your reply. "
                                        "Say in a sentence or two what it does and how to use it; don't paste its code."],
                         "right: nothing about the check, so nothing to narrate")
        self.assertEqual(reply["usage"]["input_tokens"], 10 * 2 + 100, "the check's tokens are the reply's")
        self.assertEqual(len(reply["widgets"]), 1)

    def test_a_check_that_finds_a_wrong_figure_has_it_fixed_once(self):
        self.world["verdict"] = "Interest ÷ principal is 108%, labelled as a share of the total.\nVERDICT: WRONG: the share of the total payment is 52%, not 108%."
        fixed = PAGE.replace("/* math */", "/* share of total */")
        self.world["script"] += [{"calls": [("show_widget", {"title": "EMI", "html": PAGE})]},
                                 {"calls": [("show_widget", {"title": "EMI", "html": fixed})]},
                                 {"parts": ["It works out your monthly payment."]}]
        chat = self.engine.open()
        reply = self.engine.send(chat["id"], "EMI calculator please",
                                 on_widget=lambda w: {"shown": True, "text": "108% of your total payment is interest", "errors": []})
        self.assertIn("but a check of what it shows found: the share of the total payment is 52%, not 108%. It shows: «108% "
                      "of your total payment is interest». Fix it: call show_widget again", self.told(1)[0])
        self.assertEqual(len(self.world["checked"]), 1, "a fixed widget isn't checked again")
        self.assertEqual(reply["widgets"][0]["html"], fixed)
        self.assertNotIn("show_widget", self.world["read"][2]["tools"])
        self.world["script"] += [{"calls": [("show_widget", {"title": "EMI", "html": PAGE})]}, {"parts": ["Done."]}]
        self.engine.send(chat["id"], "Another", on_widget=lambda w: {"shown": False})
        self.assertTrue(self.told(-1)[0].startswith("The widget EMI is open in a tab beside the chat"),
                        "no tab showed it: nothing to check")
        self.assertEqual(len(self.world["checked"]), 1)

    def test_a_reply_that_says_a_widget_is_beside_the_chat_and_made_none_is_told_once_to_make_it(self):
        shown = []
        self.world["script"] += [{"parts": ["Compound interest is interest on interest. The widget beside the chat has sliders."]},
                                 {"calls": [("show_widget", {"title": "Compound interest", "html": PAGE})]},
                                 {"parts": ["Drag the sliders."]}]
        chat = self.engine.open()
        reply = self.engine.send(chat["id"], "Explain compound interest with a slider", on_widget=shown.append)
        said = self.world["read"][1]["messages"]
        at = said.index({"role": "user", "content": WIDGET_NOT_MADE})
        self.assertEqual(said[at - 1], {"role": "assistant", "content": "Compound interest is interest on interest. The "
                                                                       "widget beside the chat has sliders."})
        self.assertEqual(len(reply["widgets"]), 1)
        self.assertTrue(reply["text"].endswith("Drag the sliders."))
        # Said again and still made none: told once only, so the reply ends.
        self.world["script"] += [{"parts": ["The widget is beside the chat."]}, {"parts": ["The widget beside the chat."]}]
        before = len(self.world["read"])
        self.engine.send(chat["id"], "And for a loan?", on_widget=shown.append)
        self.assertEqual(len(self.world["read"]) - before, 2)
        # Without the claim, or with a widget made, nothing is said.
        self.world["script"] += [{"parts": ["Compound interest is interest on interest."]}]
        before = len(self.world["read"])
        self.engine.send(chat["id"], "Just explain it", on_widget=shown.append)
        self.assertEqual(len(self.world["read"]) - before, 1)

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


class Wire:
    def __init__(self):
        self.frames, self.lock = [], threading.Lock()

    def emit(self, type, **fields):
        frame = {"type": type, "seq": len(self.frames), **fields}
        problem = event_error(frame)
        if problem:
            raise AssertionError(problem)
        with self.lock:
            self.frames.append(frame)

    def wait(self, kind, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                found = [f for f in self.frames if f["type"] == kind]
            if found:
                return found[-1]
            time.sleep(0.01)
        raise AssertionError(f"no {kind}")


class OnTheWire(unittest.TestCase):
    """The reply waits a moment to hear, from a screen that says it tells, what its widget shows."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-widgets-wire-")
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        self.world, self.wire = {"script": [], "read": []}, Wire()
        config = SimpleNamespace(base_url="", api_key="", model="chat-model", get=lambda key, default=None: default)
        self.engine = ChatEngine(config, ChatStore(folder / "chat"), searcher=lambda q: [],
                                 memory=SharedMemory(folder / "memory"), projects=lambda hidden: [],
                                 client_factory=lambda model: Model(self.world), plugins=lambda chat, said, taint: None)
        self.service = ChatService(self.wire.emit, config, engine=self.engine)
        self.addCleanup(self.service.close, 2.0)

    def turn(self, reports: bool, answer=None):
        self.service.dispatch({"type": "chatdgc_open", "request_id": "o", **({"widget_reports": True} if reports else {})})
        chat = self.wire.wait("chatdgc_opened")["conversation"]["id"]
        self.world["script"] += [{"calls": [("show_widget", {"title": "EMI", "html": PAGE})]}, {"parts": ["Done."]}]
        started = time.monotonic()
        self.service.dispatch({"type": "chatdgc_send", "request_id": "s", "conversation_id": chat, "text": "EMI please",
                               "search": "off"})
        widget = self.wire.wait("chatdgc_widget")["widget"]
        if answer is not None:
            self.service.dispatch({"type": "chatdgc_widget_report", "request_id": "w", "conversation_id": chat,
                                   "widget_id": widget["id"], **answer})
        deadline = time.monotonic() + 10
        while not [f for f in self.wire.frames if f["type"] == "chatdgc_turn" and f["state"] == "ended"]:
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)
        took = time.monotonic() - started
        # The reply's step after show_widget (the chat's naming and follow-ups ask the model too).
        told = [m["content"] for r in self.world["read"] for m in r["messages"] if m["role"] == "tool"][0]
        return told, took

    def test_what_the_widget_shows_reaches_the_model_in_the_same_reply(self):
        told, _ = self.turn(True, {"shown": True, "text": "Monthly EMI ₹43,391", "errors": [7]})
        self.assertEqual(self.world["checked"], ["Asked for: EMI please\n\nThe widget, EMI, shows:\nMonthly EMI ₹43,391"],
                         "checked, and an error that isn't text is no error")
        self.assertTrue(told.startswith("The widget EMI is open in a tab beside the chat"))
        self.assertNotIn("chatdgc_error", [f["type"] for f in self.wire.frames])

    def test_a_screen_that_doesnt_tell_is_never_waited_for(self):
        told, took = self.turn(False)
        self.assertTrue(told.startswith("The widget EMI is open in a tab beside the chat"))
        self.assertLess(took, chat_service.WIDGET_REPORT_SECONDS)

    def test_no_report_in_time_and_the_reply_goes_on(self):
        with patch.object(chat_service, "WIDGET_REPORT_SECONDS", 0.2):
            told, took = self.turn(True)
        self.assertTrue(told.startswith("The widget EMI is open in a tab beside the chat"))
        self.assertLess(took, 5)
        self.service.dispatch({"type": "chatdgc_widget_report", "request_id": "late", "conversation_id": "chat_x",
                               "widget_id": "wg_" + "0" * 16, "shown": True, "text": "late"})
        self.service.dispatch({"type": "chatdgc_widget_report", "request_id": "bad", "conversation_id": "chat_x",
                               "widget_id": "wg_" + "0" * 16})
        errors = [f for f in self.wire.frames if f["type"] == "chatdgc_error"]
        self.assertEqual([f.get("request_id") for f in errors], ["bad"], "a late one is dropped; one without shown, refused")


if __name__ == "__main__":
    unittest.main()
