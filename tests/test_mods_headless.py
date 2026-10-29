"""Mods for the editor (dgc/headless.py, dgc/editor_protocol.py): ready offers them, mods_list says every mod and
draws what each already drew, mod_command answers with mod_result, mod_set turns one off, and every frame is one the
protocol accepts."""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import config as config_module
from dgc import headless, sandbox, sessions
from dgc.config import Config
from dgc.editor_protocol import event_error
from dgc.mods import catalog, consent

MOD = """
import dgc_mod as dm
mod = dm.Mod()
@mod.render("status")
def status():
    return dm.Text("watching")
@mod.command("hello")
def hello(args):
    return dm.Text("hello " + (args or "you"))
mod.run()
"""


class ModsForTheEditor(unittest.TestCase):
    def setUp(self):
        tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-mods-headless-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(tmp)
        self.user = tmp / ".dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (self.user / "config.json").write_text(json.dumps({"suggest": False, "artifact_autostart": False,
                                                           "mcp_servers": {}, "base_url": "http://localhost.invalid/v1",
                                                           "model": "fixture"}))
        self.root = tmp / "project"
        (self.root / ".git").mkdir(parents=True)
        src = tmp / "src" / "greeter"
        src.mkdir(parents=True)
        (src / "main.py").write_text(textwrap.dedent(MOD))
        (src / "dgc-mod.json").write_text(json.dumps({"name": "greeter", "version": "1.0.0", "entry": "main.py",
                                                      "title": "Greeter", "capabilities": {
                                                          "draws": ["status"], "commands": [{"name": "hello"}]}}))
        consent.allow(catalog.install_folder(src), unsandboxed=sandbox._backend() is None)
        self.wire = io.StringIO()
        sessions_dir = patch.object(sessions, "SESSIONS_DIR", self.user / "sessions")
        sessions_dir.start()
        self.addCleanup(sessions_dir.stop)
        self.host = headless.Host(Config(project_root=self.root))
        self.host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(self.host.chats.values())])
        self.addCleanup(lambda: [chat.close() for chat in list(self.host.chats.values())])

    def tearDown(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def frames(self, kind=""):
        out = [json.loads(line) for line in self.wire.getvalue().splitlines()]
        for frame in out:
            self.assertIsNone(event_error(frame), frame)
        return [f for f in out if not kind or f["type"] == kind]

    def wait(self, predicate, seconds=15):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            found = [f for f in self.frames() if predicate(f)]
            if found:
                return found[-1]
            time.sleep(0.05)
        raise AssertionError(f"nothing matched: {self.frames()[-5:]}")

    def test_ready_offers_mods_and_the_editor_can_list_run_and_turn_one_off(self):
        self.assertEqual(self.host.default._ready_payload()["capabilities"]["mods"], {"version": 1, "offers": 1, "consent_reviews": 1})
        self.host.dispatch({"type": "mods_list", "request_id": "m1"})
        listed = self.wait(lambda f: f["type"] == "mods" and f.get("request_id") == "m1")
        greeter = next(m for m in listed["mods"] if m["name"] == "greeter")
        self.assertEqual((greeter["state"], greeter["title"]), ("running", "Greeter"))
        self.assertIn("It can never approve anything for you.", greeter["asks"])
        self.assertTrue(listed["on"])
        drawn = self.wait(lambda f: f["type"] == "mod_ui" and f["name"] == "greeter")
        self.assertEqual((drawn["slot"], drawn["tree"], drawn["mod"]), ("status", {"type": "Text", "text": "watching"},
                                                                        "Greeter"))
        self.host.dispatch({"type": "mod_command", "request_id": "c1", "name": "hello", "args": "Mohit"})
        answered = self.wait(lambda f: f["type"] == "mod_result" and f["request_id"] == "c1")
        self.assertEqual((answered["mod"], answered["tree"]), ("Greeter", {"type": "Text", "text": "hello Mohit"}))
        self.host.dispatch({"type": "mod_command", "request_id": "c2", "name": "nobody"})
        self.wait(lambda f: f["type"] == "command_rejected" and f.get("request_id") == "c2")
        self.host.dispatch({"type": "mod_set", "request_id": "s1", "name": "greeter", "op": "off"})
        after = self.wait(lambda f: f["type"] == "mods" and f.get("request_id") == "s1")
        self.assertEqual(next(m for m in after["mods"] if m["name"] == "greeter")["state"], "off")
        self.host.dispatch({"type": "mod_set", "request_id": "missing-review", "name": "greeter", "op": "allow"})
        refused = self.wait(lambda f: f["type"] == "command_rejected" and f.get("request_id") == "missing-review")
        self.assertIn("review", refused["message"].lower())
        self.host.dispatch({"type": "mod_set", "request_id": "reviewed", "name": "greeter", "op": "allow",
                            "review": greeter["review"]})
        allowed = self.wait(lambda f: f["type"] == "mods" and f.get("request_id") == "reviewed")
        self.assertEqual(next(m for m in allowed["mods"] if m["name"] == "greeter")["state"], "running")


if __name__ == "__main__":
    unittest.main()


class ModsInChatDGC(unittest.TestCase):
    """ChatDGC's own mods: they hear each message (and may rewrite it, said as a notice) and each reply's start and
    end; their list and drawing come with surface "chat"."""

    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from test_chatdgc_canvas import Model
        from test_chatdgc_wire import Wire
        from dgc.chatdgc.engine import ChatEngine
        from dgc.chatdgc.service import ChatService
        from dgc.chatdgc.store import ChatStore
        from dgc.shared_memory import SharedMemory
        from types import SimpleNamespace
        tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-chatmods-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(tmp / "home")
        src = tmp / "src" / "polite"
        src.mkdir(parents=True)
        (src / "main.py").write_text(textwrap.dedent("""
            import dgc_mod as dm
            mod = dm.Mod()
            heard = []
            @mod.on("prompt.submit")
            def please(e):
                return dm.rewrite(e["text"] + " please", "added please")
            @mod.on("turn.start")
            def start(e):
                heard.append("start")
            @mod.on("turn.complete")
            def done(e):
                heard.append("complete")
                mod.set_ui("status", dm.Text(f"{heard.count('complete')} replies"))
            mod.run()
        """))
        (src / "dgc-mod.json").write_text(json.dumps({"name": "polite", "version": "1.0.0", "entry": "main.py",
                                                      "title": "Polite", "capabilities": {
                                                          "events": ["prompt.submit", "turn.start", "turn.complete"],
                                                          "rewrites_prompt": True, "draws": ["status"]}}))
        consent.allow(catalog.install_folder(src), unsandboxed=sandbox._backend() is None)
        self.world = {"script": [], "read": []}
        config = SimpleNamespace(base_url="", api_key="", model="chat-model", get=lambda key, default=None: default)
        engine = ChatEngine(config, ChatStore(tmp / "chat"), searcher=lambda q: [], memory=SharedMemory(tmp / "memory"),
                            projects=lambda hidden: [], client_factory=lambda model: Model(self.world),
                            plugins=lambda chat, said, taint: None)
        self.wire = Wire()
        self.service = ChatService(self.wire.emit, config, engine=engine)
        self.addCleanup(self.service.close, 2.0)
        self.service._mods()

    def tearDown(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def test_a_message_is_rewritten_said_and_the_reply_is_heard(self):
        self.service.mods_command({"type": "mods_list", "request_id": "l1", "surface": "chat"})
        listed = self.wire.wait(lambda f: f["type"] == "mods" and f.get("request_id") == "l1")
        self.assertEqual((listed["surface"], next(m for m in listed["mods"] if m["name"] == "polite")["state"]),
                         ("chat", "running"))
        self.service.dispatch({"type": "chatdgc_open", "request_id": "o1"})
        chat = self.wire.of("chatdgc_opened")[-1]["conversation"]["id"]
        self.world["script"].append({"parts": ["Here you go."]})
        self.service.dispatch({"type": "chatdgc_send", "request_id": "s1", "conversation_id": chat,
                               "text": "Make a plan"})
        self.wire.wait(lambda f: f["type"] == "chatdgc_turn" and f.get("state") == "ended")
        asked = self.world["read"][-1]["messages"][-1]["content"]
        self.assertIn("Make a plan please", str(asked))
        notice = self.wire.wait(lambda f: f["type"] == "mod_toast")
        self.assertEqual((notice["mod"], notice["surface"]), ("Polite", "chat"))
        self.assertIn("What you typed: Make a plan", notice["text"])
        drawn = self.wire.wait(lambda f: f["type"] == "mod_ui" and f["surface"] == "chat")
        self.assertEqual(drawn["tree"], {"type": "Text", "text": "1 replies"})
