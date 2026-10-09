"""ChatDGC on the wire (chatdgc_* in one `dgc serve`): the process answers them, never a session, so a chat
is the same whatever folder is open and no frame carries the session router's chat_id. A turn always ends
on the wire; one turn per chat; Stop keeps what was written; every frame fits the wire."""
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def _real_account_home() -> Path:
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=False)
    except (ImportError, KeyError, AttributeError):
        return Path(os.path.expanduser("~")).resolve(strict=False)


if "dgc.config" in sys.modules:
    _user_home = Path(sys.modules["dgc.config"].USER_HOME).resolve(strict=False)
    _account_home = _real_account_home()
    if _user_home == _account_home or _account_home in _user_home.parents:
        raise RuntimeError("tests/test_chatdgc_wire.py needs HOME redirected before dgc is imported — run it "
                           "through tests/run_tests.py or with HOME=<tmp>")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-chatdgc-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import headless, sessions  # noqa: E402
from dgc.chatdgc import service as service_module  # noqa: E402
from dgc.chatdgc.engine import NAME_PROMPT, ChatEngine  # noqa: E402
from dgc.chatdgc.service import ChatService, fit, page  # noqa: E402
from dgc.chatdgc.store import ChatStore  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.editor_protocol import event_error  # noqa: E402
from dgc.llm import ToolCall  # noqa: E402


class Model:
    """A model the test drives: `gate` holds it mid-reply until released."""

    def __init__(self):
        self.script, self.gate, self.reached, self.named = [], threading.Event(), threading.Event(), threading.Event()
        self.gate.set()

    def factory(self, model):
        outer = self

        class Client:
            def __init__(self):
                self.model = model or "fixture"

            def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
                if messages[0]["content"] == NAME_PROMPT:          # naming a new chat, off the turn
                    outer.named.set()
                    return SimpleNamespace(content="Named by the model", finish_reason="stop", usage={}, thinking="")
                step = outer.script.pop(0)
                for part in step.get("thinking", []):
                    on_thinking(part)
                parts = step.get("parts", [])
                for index, part in enumerate(parts):
                    if index == step.get("hold_at"):
                        outer.reached.set()
                        outer.gate.wait(10)
                    if cancel is not None and cancel.is_set():
                        raise RuntimeError("cancelled")
                    on_text(part)
                if step.get("raise"):
                    raise RuntimeError(step["raise"])
                calls = [ToolCall(f"c{i}", name, args) for i, (name, args) in enumerate(step.get("calls", []))]
                return SimpleNamespace(content="".join(parts), finish_reason=step.get("finish", "stop"),
                                       usage={"input_tokens": 3, "output_tokens": 2}, thinking="", tool_calls=calls)
        return Client()


class Wire:
    """The emitter's contract, as the real Emitter checks it."""

    def __init__(self):
        self.frames, self.lock = [], threading.Lock()

    def emit(self, type, **fields):
        frame = {"type": type, "seq": len(self.frames), **fields}
        problem = event_error(frame)
        if problem:
            raise AssertionError(f"invalid event: {problem}")
        with self.lock:
            self.frames.append(frame)

    def of(self, kind):
        with self.lock:
            return [f for f in self.frames if f["type"] == kind]

    def wait(self, predicate, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                found = [f for f in self.frames if predicate(f)]
            if found:
                return found[-1]
            time.sleep(0.01)
        raise AssertionError(f"no matching frame: {self.frames[-5:]}")


class ServiceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-wire-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "chat"
        self.model, self.wire = Model(), Wire()
        config = SimpleNamespace(base_url="", api_key="", model="fixture", get=lambda key, default=None: default)
        self.engine = ChatEngine(config, ChatStore(self.root), client_factory=self.model.factory,
                                 searcher=lambda query: [{"title": "Forecast", "url": "https://weather.example/paris", "snippet": "Sunny"}])
        self.service = ChatService(self.wire.emit, config, engine=self.engine)
        self.addCleanup(self.service.close, 2.0)

    def send(self, conversation_id, text, request_id="r1", **extra):
        self.service.dispatch({"type": "chatdgc_send", "request_id": request_id, "conversation_id": conversation_id,
                               "text": text, **extra})

    def new(self):
        self.service.dispatch({"type": "chatdgc_open", "request_id": "open"})
        return self.wire.of("chatdgc_opened")[-1]["conversation"]["id"]

    def ended(self, request_id="r1"):
        return self.wire.wait(lambda f: f["type"] == "chatdgc_turn" and f["state"] == "ended"
                              and f.get("request_id") == request_id)

    def test_a_turn_on_the_wire_in_order(self):
        chat = self.new()
        self.model.script.append({"thinking": ["Let me think."], "parts": ["Paris ", "is ", "the capital."]})
        self.send(chat, "Capital of France?", thinking="high")
        self.ended()
        ours = [f for f in self.wire.frames if f.get("request_id") == "r1"]       # the turn's own frames
        kinds = [f["type"] for f in ours]
        self.assertEqual(kinds[0], "chatdgc_turn")
        self.assertEqual(kinds[1], "chatdgc_message", "your message first")
        self.assertEqual(kinds[-3:], ["chatdgc_message", "chatdgc_changed", "chatdgc_turn"])
        started = self.wire.of("chatdgc_turn")[0]
        user, reply = (f["message"] for f in self.wire.of("chatdgc_message"))
        self.assertEqual((user["role"], user["text"]), ("user", "Capital of France?"))
        self.assertEqual((reply["id"], reply["text"], reply["finish"]), (started["reply_id"], "Paris is the capital.", "stop"))
        deltas = self.wire.of("chatdgc_delta")
        self.assertEqual("".join(d.get("text", "") for d in deltas), "Paris is the capital.")
        self.assertEqual("".join(d.get("thinking", "") for d in deltas), "Let me think.")
        self.assertTrue(all(d["message_id"] == reply["id"] for d in deltas))
        self.assertEqual([f for f in ours if f["type"] == "chatdgc_changed"][0]["summary"]["title"], "Capital of France?",
                         "named by its first line at once; the model's name follows")
        self.service.dispatch({"type": "chatdgc_list", "request_id": "l"})
        listed = self.wire.of("chatdgc_chats")[-1]
        self.assertEqual(([c["id"] for c in listed["chats"]], listed["total"], listed["next_offset"]), ([chat], 1, None))

    def test_a_new_chat_gets_its_name_after_its_first_reply(self):
        chat = self.new()
        self.model.script.append({"parts": ["Paris."]})
        self.send(chat, "Capital of France?")
        self.ended()
        named = self.wire.wait(lambda f: f["type"] == "chatdgc_changed" and (f["summary"] or {}).get("title") == "Named by the model")
        self.assertNotIn("request_id", named, "nobody asked: it arrives on its own")

    def test_a_reply_that_searches_says_so_and_carries_its_sources(self):
        chat = self.new()
        self.model.script += [{"parts": ["Let me check. "], "calls": [("web_search", {"query": "paris weather"})]},
                              {"parts": ["Sunny [1]."]}]
        self.send(chat, "Weather in Paris?", search="auto")
        self.ended()
        kinds = [f["type"] for f in self.wire.frames if f["type"] in ("chatdgc_delta", "chatdgc_activity", "chatdgc_message")]
        first_search = kinds.index("chatdgc_activity")
        self.assertIn("chatdgc_delta", kinds[:first_search], "what it wrote before searching shows first")
        activity = self.wire.of("chatdgc_activity")[0]
        self.assertEqual((activity["kind"], activity["text"]), ("searching", "paris weather"))
        reply = self.wire.of("chatdgc_message")[-1]["message"]
        self.assertEqual(activity["message_id"], reply["id"])
        self.assertEqual((reply["text"], reply["sources"]), ("Let me check. \n\nSunny [1].",
                                                             [{"n": 1, "title": "Forecast", "url": "https://weather.example/paris"}]))
        self.send(chat, "again", request_id="r2", search="always")
        self.assertIn("invalid command", self.wire.of("chatdgc_error")[-1]["message"])

    def test_an_image_the_chat_keeps_can_be_shown(self):
        import base64
        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
        uri = "data:image/png;base64," + base64.b64encode(png).decode()
        chat = self.new()
        self.model.script.append({"parts": ["ok"]})
        with patch("dgc.vision.has_vision", return_value=True):
            self.send(chat, "Look", attachments=[{"kind": "image", "data": uri, "name": "shot.png"},
                                                 {"kind": "text", "text": "notes", "name": "Pasted text"}])
            self.ended()
        image, text = self.wire.of("chatdgc_message")[0]["message"]["attachments"]
        ask = lambda att, rid: self.service.dispatch({"type": "chatdgc_file", "request_id": rid, "conversation_id": chat,
                                                       "attachment_id": att})
        ask(image["id"], "f1")
        shown = self.wire.of("chatdgc_file")[-1]
        self.assertEqual((shown["attachment_id"], shown["data"]), (image["id"], uri))
        ask(text["id"], "f2")
        self.assertEqual(self.wire.of("chatdgc_file")[-1]["error"], "That image isn't in this chat.")
        ask("att_" + "0" * 32, "f3")
        self.assertIn("error", self.wire.of("chatdgc_file")[-1])
        with patch.object(service_module, "PREVIEW_BYTES", 10):
            ask(image["id"], "f4")
        self.assertEqual(self.wire.of("chatdgc_file")[-1]["error"], "That image is too large to preview here.")

    def test_one_turn_per_chat_and_two_chats_side_by_side(self):
        first, second = self.new(), self.new()
        self.model.gate.clear()
        self.model.script += [{"parts": ["slow ", "reply"], "hold_at": 1}, {"parts": ["fast"]}]
        self.send(first, "one", request_id="a")
        self.assertTrue(self.model.reached.wait(5))
        self.send(first, "again", request_id="b")
        error = self.wire.wait(lambda f: f["type"] == "chatdgc_error" and f.get("request_id") == "b")
        self.assertIn("still answering", error["message"])
        self.service.dispatch({"type": "chatdgc_open", "request_id": "peek", "conversation_id": first})
        peek = self.wire.wait(lambda f: f["type"] == "chatdgc_opened" and f["request_id"] == "peek")
        self.assertTrue(peek["busy"])
        self.assertEqual(peek["reply_id"], self.wire.of("chatdgc_turn")[0]["reply_id"], "a second view can follow it")
        self.send(second, "other", request_id="c")
        self.assertEqual(self.ended("c")["conversation_id"], second, "another chat isn't held up")
        self.model.gate.set()
        self.ended("a")

    def test_stop_keeps_what_was_written_then_continue(self):
        chat = self.new()
        self.model.gate.clear()
        self.model.script.append({"parts": ["Once ", "upon"], "hold_at": 1})
        self.send(chat, "A story")
        self.assertTrue(self.model.reached.wait(5))
        self.service.dispatch({"type": "chatdgc_cancel", "conversation_id": chat})
        self.model.gate.set()
        self.ended()
        stopped = self.wire.of("chatdgc_message")[-1]["message"]
        self.assertEqual((stopped["text"], stopped["finish"]), ("Once ", "cancelled"))
        self.model.script.append({"parts": ["upon a time."]})
        self.service.dispatch({"type": "chatdgc_continue", "request_id": "r2", "conversation_id": chat,
                               "message_id": stopped["id"]})
        self.ended("r2")
        done = self.wire.of("chatdgc_message")[-1]["message"]
        self.assertEqual((done["id"], done["text"], done["finish"]), (stopped["id"], "Once upon a time.", "stop"))
        self.assertEqual(self.wire.of("chatdgc_turn")[-1]["reply_id"], stopped["id"])

    def test_a_model_that_never_answers_still_ends_the_turn(self):
        chat = self.new()
        self.model.script.append({"raise": "connection refused"})
        self.send(chat, "Hello?")
        self.ended()
        self.assertIn("connection refused", self.wire.of("chatdgc_error")[-1]["message"])
        self.assertEqual(self.wire.of("chatdgc_error")[-1]["conversation_id"], chat)

    def test_delete_mid_reply_stops_it_and_stays_deleted(self):
        chat = self.new()
        self.model.script.append({"parts": ["first"]})
        self.send(chat, "Hi", request_id="r0")
        self.ended("r0")
        self.model.gate.clear()
        self.model.script.append({"parts": ["a ", "b"], "hold_at": 1})
        self.send(chat, "More")
        self.assertTrue(self.model.reached.wait(5))
        self.service.dispatch({"type": "chatdgc_update", "request_id": "d", "conversation_id": chat, "delete": True})
        self.model.gate.set()
        self.ended()
        self.assertIsNone(self.wire.wait(lambda f: f["type"] == "chatdgc_changed" and f.get("request_id") == "d")["summary"])
        self.assertFalse((self.root / "chats" / f"{chat}.json").exists())
        self.assertEqual([f for f in self.wire.of("chatdgc_error") if f.get("request_id") == "r1"], [], "as asked: no error")

    def test_rename_pin_archive(self):
        chat = self.new()
        self.service.dispatch({"type": "chatdgc_update", "request_id": "u0", "conversation_id": chat, "pinned": True})
        self.assertIn("Send a message first", self.wire.of("chatdgc_error")[-1]["message"])
        self.model.script.append({"parts": ["ok"]})
        self.send(chat, "Plan a trip")
        self.ended()
        self.service.dispatch({"type": "chatdgc_update", "request_id": "u1", "conversation_id": chat,
                               "title": "Goa", "pinned": True})
        summary = self.wire.of("chatdgc_changed")[-1]["summary"]
        self.assertEqual((summary["title"], summary["pinned"], summary["preview"]), ("Goa", True, "ok"))
        self.service.dispatch({"type": "chatdgc_update", "request_id": "u2", "conversation_id": chat, "archived": True})
        self.service.dispatch({"type": "chatdgc_list", "request_id": "l", "archived": True})
        self.assertEqual([c["id"] for c in self.wire.of("chatdgc_chats")[-1]["chats"]], [chat])

    def test_a_temporary_chat(self):
        self.service.dispatch({"type": "chatdgc_open", "request_id": "t", "temporary": True})
        opened = self.wire.of("chatdgc_opened")[-1]["conversation"]
        self.assertTrue(opened["temporary"])
        self.model.script.append({"parts": ["Sure."]})
        self.send(opened["id"], "Between us")
        self.ended()
        self.assertEqual(self.wire.of("chatdgc_changed"), [], "never in the list")
        self.service.dispatch({"type": "chatdgc_update", "request_id": "u", "conversation_id": opened["id"], "title": "x"})
        self.assertIn("isn't saved", self.wire.of("chatdgc_error")[-1]["message"])

    def test_wrong_commands_are_answered(self):
        self.service.dispatch({"type": "chatdgc_send", "request_id": "x", "conversation_id": "chat_" + "0" * 32,
                               "text": "hi"})
        self.assertIn("doesn't exist", self.wire.of("chatdgc_error")[-1]["message"])
        self.service.dispatch({"type": "chatdgc_send", "request_id": "y", "conversation_id": "c", "text": 3})
        self.assertIn("invalid command", self.wire.of("chatdgc_error")[-1]["message"])
        self.service.dispatch({"type": "chatdgc_send", "request_id": "z", "conversation_id": self.new(), "text": "hi",
                               "thinking": "ultra"})
        self.assertIn("invalid command", self.wire.of("chatdgc_error")[-1]["message"], "no ultra in chat")
        self.assertEqual(self.wire.of("chatdgc_turn"), [])

    def test_a_long_chat_opens_on_its_latest_and_pages_back(self):
        chat = self.engine.store.create()
        big = "x" * (900 * 1024)
        chat["messages"] = [{"id": f"msg_{i:032x}", "role": "user" if i % 2 == 0 else "assistant", "text": f"{i} {big}",
                             "created_at": "2026-10-10T00:00:00.000Z"} for i in range(8)]
        self.engine.store.save(chat)
        self.service.dispatch({"type": "chatdgc_open", "request_id": "o", "conversation_id": chat["id"]})
        opened = self.wire.of("chatdgc_opened")[-1]
        self.assertGreater(opened["earlier"], 0)
        self.assertEqual(opened["earlier"] + len(opened["messages"]), 8)
        self.assertEqual(opened["messages"][-1]["id"], f"msg_{7:032x}", "the latest")
        seen = list(opened["messages"])
        while seen[0]["id"] != f"msg_{0:032x}":
            self.service.dispatch({"type": "chatdgc_earlier", "request_id": "e", "conversation_id": chat["id"],
                                   "before": seen[0]["id"]})
            seen = self.wire.of("chatdgc_earlier")[-1]["messages"] + seen
        self.assertEqual([m["id"] for m in seen], [f"msg_{i:032x}" for i in range(8)])
        for frame in self.wire.frames:
            self.assertLess(len(json.dumps(frame).encode()), 4 * 1024 * 1024, frame["type"])

    def test_a_message_too_large_for_one_frame_is_cut_for_showing(self):
        huge = {"id": "msg_" + "a" * 32, "role": "assistant", "text": "😀" * 1_000_000, "thinking": "t" * 1000}
        shown = fit(huge)
        self.assertTrue(shown["partial"])
        self.assertLessEqual(len(json.dumps(shown, ensure_ascii=False).encode()), service_module.PAGE_BYTES)
        self.assertTrue(huge["text"].startswith(shown["text"]))
        self.assertEqual(page([huge])[0][0]["partial"], True)

    def test_deltas_are_batched(self):
        chat = self.new()
        self.model.script.append({"parts": ["a"] * 500})
        self.send(chat, "Count")
        self.ended()
        deltas = self.wire.of("chatdgc_delta")
        self.assertEqual("".join(d.get("text", "") for d in deltas), "a" * 500)
        self.assertLess(len(deltas), 50, "not one frame per token")


class HostTests(unittest.TestCase):
    """The router: chatdgc_* goes to the process, whatever session the editor has open."""

    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-chatdgc-host-")).resolve()
        user_dgc = tmp / "user-dgc"
        user_dgc.mkdir()
        for name, value in (("USER_HOME", user_dgc), ("USER_CONFIG", user_dgc / "config.json"),
                            ("USER_SECRETS", user_dgc / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (user_dgc / "config.json").write_text(json.dumps({
            "model": "fixture", "base_url": "http://localhost.invalid/v1", "suggest": False,
            "artifact_autostart": False, "mcp_servers": {}}))
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DGC_PROJECT_ROOT", None)
        for name in ("a", "b"):
            (tmp / name / ".git").mkdir(parents=True)
        self.tmp, self.wire = tmp, io.StringIO()
        self.host = headless.Host(Config(project_root=tmp / "a"))
        self.host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(self.host.chats.values())])
        self.model = Model()
        # The host makes its own service (Host.chatdgc); only the model is the test's.
        real = service_module.ChatEngine
        made = patch.object(service_module, "ChatEngine",
                            lambda config: real(config, ChatStore(user_dgc / "chat"), client_factory=self.model.factory))
        made.start()
        self.addCleanup(made.stop)

    def frames(self):
        return [json.loads(line) for line in self.wire.getvalue().splitlines()]

    def wait_for(self, predicate, timeout=20.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = [frame for frame in self.frames() if predicate(frame)]
            if found:
                return found[-1]
            time.sleep(0.02)
        self.fail(f"no matching frame: {self.frames()[-5:]}")

    def test_ready_offers_it(self):
        self.assertEqual(self.host.default._ready_payload()["capabilities"]["chatdgc"], {"version": 1})

    def test_no_frame_carries_a_sessions_chat_id_even_with_several_sessions(self):
        self.host.dispatch({"type": "open_chat", "request_id": "oc", "cwd": str(self.tmp / "b")})
        opened = self.wait_for(lambda f: f["type"] == "chat_opened")
        self.assertTrue(self.host.core.tag_chats)
        self.host.dispatch({"type": "chatdgc_open", "request_id": "o", "chat_id": opened["chat_id"]})
        conversation = self.wait_for(lambda f: f["type"] == "chatdgc_opened")["conversation"]["id"]
        self.model.script.append({"parts": ["Hello ", "there."]})
        self.host.dispatch({"type": "chatdgc_send", "request_id": "s", "conversation_id": conversation, "text": "Hi"})
        self.wait_for(lambda f: f["type"] == "chatdgc_turn" and f["state"] == "ended")
        ours = [f for f in self.frames() if f["type"].startswith("chatdgc_")]
        self.assertGreaterEqual(len(ours), 6)
        self.assertEqual([f for f in ours if "chat_id" in f], [])
        self.host.dispatch({"type": "chatdgc_list", "request_id": "l2", "chat_id": opened["chat_id"]})
        self.assertEqual(self.wait_for(lambda f: f["type"] == "chatdgc_chats")["total"], 1,
                         "the same list from any session")

    def test_close_stops_a_reply_and_keeps_what_was_written(self):
        self.host.dispatch({"type": "chatdgc_open", "request_id": "o"})
        conversation = self.wait_for(lambda f: f["type"] == "chatdgc_opened")["conversation"]["id"]
        self.model.gate.clear()
        self.model.script.append({"parts": ["Half ", "way"], "hold_at": 1})
        self.host.dispatch({"type": "chatdgc_send", "request_id": "s", "conversation_id": conversation, "text": "Go"})
        self.assertTrue(self.model.reached.wait(5))
        outcome = []
        closer = threading.Thread(target=lambda: outcome.append(self.host.close()))
        closer.start()
        time.sleep(0.2)
        self.model.gate.set()
        closer.join(30)
        self.assertEqual(len(outcome), 1, "close returned (it didn't raise)")
        saved = self.host.chatdgc().engine.store.get(conversation)
        self.assertEqual((saved["messages"][-1]["text"], saved["messages"][-1]["finish"]), ("Half ", "cancelled"))


if __name__ == "__main__":
    unittest.main()
