"""ChatDGC's custom instructions and personality (ChatGPT's): what it should know about you, how it should answer,
and its manner, set once in Settings and read by every chat from its next reply."""
import io
import json
import os
import sys
import tempfile
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
        raise RuntimeError("tests/test_shared_web_search_settings.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-search-settings-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import headless, sessions  # noqa: E402
from dgc.chatdgc.engine import ChatEngine  # noqa: E402
from dgc.chatdgc.prompt import MAX_INSTRUCTIONS, PERSONALITIES, system_prompt  # noqa: E402
from dgc.chatdgc.store import ChatStore
from dgc.shared_memory import SharedMemory  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.editor_protocol import event_error  # noqa: E402


def looked_up(messages) -> bool:
    """The engine's check before an answer: does this message need the web first? (dgc/chatdgc/engine.py)"""
    from dgc.chatdgc.engine import LOOK_UP
    return str(messages[0].get("content", "")).startswith(LOOK_UP[:60])


def no_look_up():
    from types import SimpleNamespace as _NS
    from dgc.llm import ToolCall as _Call
    return _NS(content="", tool_calls=[_Call("lu", "search_first", {"needs_search": False, "query": ""})],
               finish_reason="stop", thinking="", usage={})


class PromptTests(unittest.TestCase):
    def test_nothing_set_adds_nothing(self):
        plain = system_prompt()
        self.assertNotIn("Personality:", plain)
        self.assertNotIn("The user's own instructions", plain)

    def test_no_emoji_unless_asked_as_in_main_dgc_whatever_the_personality(self):
        for personality in PERSONALITIES:
            prompt = system_prompt(personality=personality)
            self.assertIn("no emoji or decorative symbols anywhere", prompt)
            self.assertIn("unless the user asks for them", prompt)
        self.assertLess(system_prompt(personality="warm").index("no emoji"), system_prompt(personality="warm").index("Personality: warm"),
                        "the rule comes before the personality, which doesn't undo it")

    def test_personality_and_instructions_are_framed_and_bounded(self):
        prompt = system_prompt(about="I run a bakery in Pune.", style="Answer in bullet points.", personality="candid")
        self.assertIn("- Personality: candid.", prompt)
        self.assertIn("What they want you to know about them:\n<<<\nI run a bakery in Pune.\n>>>", prompt)
        self.assertIn("How they want you to respond:\n<<<\nAnswer in bullet points.\n>>>", prompt)
        self.assertLess(prompt.index("Personality"), prompt.index("It is "), "the date stays last")
        long = system_prompt(about="x" * 5000)
        self.assertIn("x" * MAX_INSTRUCTIONS + "\n>>>", long)
        self.assertNotIn("x" * (MAX_INSTRUCTIONS + 1), long)
        self.assertEqual(set(PERSONALITIES), {"default", "concise", "warm", "candid", "nerdy"})
        self.assertEqual(system_prompt(personality="nonsense"), system_prompt())


class EngineTests(unittest.TestCase):
    def test_every_chat_reads_them_from_its_next_reply(self):
        calls = []

        class Client:
            model = "m"

            def chat(self, messages, **_):
                if looked_up(messages):                      # "does this need the web first?": no
                    return no_look_up()
                calls.append(messages[0]["content"])
                return SimpleNamespace(content="ok", finish_reason="stop", usage={}, thinking="", tool_calls=[])
        config = SimpleNamespace(base_url="", api_key="", model="m", data={})
        config.get = lambda key, default=None: config.data.get(key, default)
        engine = ChatEngine(config, ChatStore(Path(tempfile.mkdtemp())), client_factory=lambda model: Client(),
                            memory=SharedMemory(Path(tempfile.mkdtemp()) / "memory"), projects=lambda hidden: [])
        chat = engine.open()
        engine.send(chat["id"], "hi")
        self.assertNotIn("Personality", calls[-1])
        config.data.update(chatdgc_about="I'm vegetarian.", chatdgc_personality="concise")
        engine.send(chat["id"], "dinner idea?")
        self.assertIn("I'm vegetarian.", calls[-1])
        self.assertIn("Personality: concise", calls[-1])


class VoiceReplyTests(unittest.TestCase):
    """Voice mode: a spoken message is marked, and its reply is asked to sound like speech (a few sentences, nothing
    to look at), since it will be read aloud; a typed message after it gets the usual answer."""

    def test_a_spoken_message_asks_for_a_spoken_reply_and_a_typed_one_does_not(self):
        from dgc.chatdgc.prompt import VOICE
        calls = []

        class Client:
            model = "m"

            def chat(self, messages, **_):
                if looked_up(messages):
                    return no_look_up()
                calls.append(messages[0]["content"])
                return SimpleNamespace(content="ok", finish_reason="stop", usage={}, thinking="", tool_calls=[])
        config = SimpleNamespace(base_url="", api_key="", model="m", data={})
        config.get = lambda key, default=None: config.data.get(key, default)
        store = ChatStore(Path(tempfile.mkdtemp()))
        engine = ChatEngine(config, store, client_factory=lambda model: Client(),
                            memory=SharedMemory(Path(tempfile.mkdtemp()) / "memory"), projects=lambda hidden: [])
        chat = engine.open()
        engine.send(chat["id"], "Plan a weekend in Lisbon for two.", voice=True)
        self.assertIn(VOICE, calls[-1])
        self.assertIn("No headings, tables, lists", calls[-1])
        saved = [m for m in store.get(chat["id"])["messages"] if m["role"] == "user"]
        self.assertTrue(saved[-1].get("voice"), "the message keeps that it was spoken")
        engine.send(chat["id"], "Now give me the full day-by-day plan with times.")
        self.assertNotIn(VOICE, calls[-1], "typed again: the usual answer")
        self.assertNotIn("voice", [m for m in store.get(chat["id"])["messages"] if m["role"] == "user"][-1])


    def test_a_spoken_turn_is_offered_nothing_to_look_at_and_typing_brings_it_back(self):
        """As ChatGPT's voice mode: a spoken turn gets no question card, file, widget or canvas -- not offered, not
        described, and refused if a model calls one anyway -- and a typed message after it has them all again."""
        offered, told = [], []

        class Client:
            model = "m"

            def __init__(self):
                self.rounds = 0

            def chat(self, messages, tools=None, **_):
                if looked_up(messages):
                    return no_look_up()
                offered.append({t["function"]["name"] for t in tools or []})
                told.append(messages[0]["content"])
                if messages[-1].get("role") == "user":   # the first round: call a canvas, as deepseek did by voice
                    return SimpleNamespace(content="", finish_reason="tool_calls", usage={}, thinking="", tool_calls=[
                        SimpleNamespace(id="c1", name="canvas_create", arguments={"title": "Lisbon", "kind": "document", "content": "# Plan"})])
                return SimpleNamespace(content="Saturday is the beach, Sunday the museums.", finish_reason="stop",
                                       usage={}, thinking="", tool_calls=[])
        config = SimpleNamespace(base_url="", api_key="", model="m", data={})
        config.get = lambda key, default=None: config.data.get(key, default)
        store = ChatStore(Path(tempfile.mkdtemp()))
        client = Client()
        engine = ChatEngine(config, store, client_factory=lambda model: client,
                            memory=SharedMemory(Path(tempfile.mkdtemp()) / "memory"), projects=lambda hidden: [])
        chat = engine.open()
        reply = engine.send(chat["id"], "Plan a weekend in Lisbon for two.", voice=True)
        seen = {"ask_user", "make_file", "show_widget", "canvas_create", "canvas_edit"}
        self.assertFalse(offered[0] & seen, offered[0])
        for line in ("canvas_create", "show_widget", "ask_user", "```chart"):
            self.assertNotIn(line, told[0], "nor described")
        self.assertIn("Voice mode has nothing to look at", told[0])
        self.assertFalse(reply.get("canvases"), "a canvas called anyway is not made")
        self.assertEqual(engine._canvas_list(store.get(chat["id"])), [])
        offered.clear(); told.clear()
        engine.send(chat["id"], "Now put the full plan in a canvas.")
        self.assertTrue({"ask_user", "make_file", "show_widget", "canvas_create"} <= offered[0], "typed: all back")
        self.assertIn("canvas_create", told[0])

class SettingsTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-search-settings-")).resolve()
        self.user = tmp / "user-dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (self.user / "config.json").write_text(json.dumps({
            "model": "fixture", "base_url": "http://localhost.invalid/v1", "suggest": False,
            "artifact_autostart": False, "mcp_servers": {}}))
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DGC_PROJECT_ROOT", None)
        for name in ("DGC_SEARCH_API_KEY",):
            os.environ.pop(name, None)
        (tmp / "a" / ".git").mkdir(parents=True)
        self.wire = io.StringIO()
        self.host = headless.Host(Config(project_root=tmp / "a"))
        self.host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(self.host.chats.values())])

    def frames(self):
        return [json.loads(line) for line in self.wire.getvalue().splitlines()]

    def last(self, kind, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = [f for f in self.frames() if f["type"] == kind]
            if found:
                return found[-1]
            time.sleep(0.02)
        self.fail(f"no {kind} frame: {self.frames()[-3:]}")

    def test_settings_sets_them_and_reads_them_back(self):
        values = {"chatdgc_about": "I'm a founder in Bengaluru.", "chatdgc_style": "Use numbers.",
                  "chatdgc_personality": "warm"}
        self.host.dispatch({"type": "set_config", "request_id": "s", "values": values})
        self.assertEqual([f for f in self.frames() if f["type"] == "command_rejected"], [])
        saved = json.loads((self.user / "config.json").read_text())
        self.assertEqual({k: saved.get(k) for k in values}, values)
        self.host.dispatch({"type": "get_config", "request_id": "c0"})
        self.assertNotIn("chatdgc_about", self.last("config"), "only to an editor that asks")
        self.host.dispatch({"type": "get_config", "request_id": "c1",
                            "fields": ["chatdgc_about", "chatdgc_style", "chatdgc_personality"]})
        asked = self.last("config")
        self.assertEqual({k: asked[k] for k in values}, values)
        self.assertIsNone(event_error(asked))
        self.assertIn("chatdgc_personality", headless._LIVE_SAFE_CONFIG_KEYS)
        for bad in ({"chatdgc_personality": "rude"}, {"chatdgc_about": "x" * 1501}, {"chatdgc_window": "48k"}, {"chatdgc_window": "2m"}):
            with self.subTest(bad=bad):
                self.assertIsNone(headless._validated_config_values(bad, set())[0])
        for size in ("8k", "16k", "32k", "64k", "128k", "256k", "512k", "1m", "max"):
            with self.subTest(size=size):
                self.assertEqual(headless._validated_config_values({"chatdgc_window": size}, set())[0], {"chatdgc_window": size},
                                 "every size main DGC offers")


if __name__ == "__main__":
    unittest.main()
