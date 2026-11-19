"""@ a Pip from ChatDGC: the tool is offered whenever Pips are on (never in a temporary chat), the job is asked from the
chat with its title, its card sits in the reply, and the Pip's answer is told to the chat once with a turn the editor
starts as it starts a wake-up's (chatdgc_wakeup_due with the job's id, then chatdgc_wake) (0.52, Pips API 111).

A real Pips registry, a scripted ChatDGC model, the real ChatService over a validated wire.
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dgc import pip_jobs, pip_levels, pips  # noqa: E402
from dgc.chatdgc.engine import ChatEngine, _named_pips_line  # noqa: E402
from dgc.chatdgc.service import ChatService  # noqa: E402
from dgc.chatdgc.store import ChatStore  # noqa: E402
from dgc.editor_protocol import command_error, event_error  # noqa: E402
from dgc.shared_memory import SharedMemory  # noqa: E402
from dgc.workspace_registry import WorkspaceRegistry  # noqa: E402
from test_chatdgc_canvas import Model  # noqa: E402


class ChatWorld(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-pipjobs-")
        self.addCleanup(temp.cleanup)
        self.base = Path(os.path.realpath(temp.name))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.base / "home")})
        env.start()
        self.addCleanup(env.stop)
        self.registry = WorkspaceRegistry(self.base / "state")
        self.addCleanup(self.registry.close)
        self.store = pips.PipStore(self.registry)
        self.pip = self.store.create(self.registry.personal()["id"], "Scout", "Look things up.", "editor-user",
                                     pip_type="scout")
        pip_levels.set_level(self.registry, self.pip["id"], pip_levels.APPROVE, "editor-user")
        directory = self.registry.directory
        self.on = {"pips": True}
        for patcher in (patch("dgc.workspace_registry.WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(directory)),
                        patch("dgc.workspace_registry.in_use", return_value=True),
                        patch("dgc.pip_jobs.ensure_runner", return_value=None),
                        patch("dgc.pip_access.tools_available", side_effect=lambda config: self.on["pips"])):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.world = {"script": [], "read": []}
        from test_pips_local import config as pips_config
        self.config = pips_config(self.base, model="chat-model", chatdgc_followups=False)
        plain = self.config.get
        self.config.get = lambda key, default=None: self.on["pips"] if key == "pips_enabled" else plain(key, default)
        self.chats = ChatStore(self.base / "chat")
        self.engine = ChatEngine(self.config, self.chats, searcher=lambda q: [], memory=SharedMemory(self.base / "memory"),
                                 projects=lambda hidden: [], client_factory=lambda model: Model(self.world),
                                 plugins=lambda chat, said, taint: None)

    def say(self, text, *steps, chat=None, **kwargs):
        self.world["script"] += list(steps)
        chat = chat or self.engine.open()
        return chat, self.engine.send(chat["id"], text, search="off", **kwargs)


class OfferedAndAsked(ChatWorld):
    def test_offered_while_pips_are_on_and_never_in_a_temporary_chat(self):
        self.say("Hello.", {"parts": ["Hi."]})
        self.assertIn("ask_pip", self.world["read"][-1]["tools"])
        self.on["pips"] = False
        self.say("Hello again.", {"parts": ["Hi."]})
        self.assertNotIn("ask_pip", self.world["read"][-1]["tools"])
        self.on["pips"] = True
        temporary = self.engine.open(temporary=True)
        self.say("Hello.", {"parts": ["Hi."]}, chat=temporary)
        self.assertNotIn("ask_pip", self.world["read"][-1]["tools"])

    def test_the_job_is_asked_from_the_chat_and_its_card_is_in_the_reply(self):
        chat, reply = self.say("@Scout what does the shop sell?",
                               {"calls": [("ask_pip", {"pip": "Scout", "job": "what does the shop sell?"})]},
                               {"parts": ["Scout has it."]})
        [row] = self.registry.db.execute("SELECT * FROM pip_jobs").fetchall()
        self.assertEqual((row["asked_kind"], row["asked_id"]), ("chatdgc", chat["id"]))
        self.assertTrue(row["asked_title"])
        self.assertIsNone(row["project_id"], "a chat with no folder: an answer only")
        [card] = [a for a in reply.get("actions") or [] if a.get("kind") == "pip_job"]
        self.assertEqual((card["job"], card["pip"]["name"], card["status"]), (row["id"], "Scout", "working"))
        self.assertRegex(card["id"], r"^act_[0-9a-f]{32}$")
        told = [m["content"] for m in self.world["read"][-1]["messages"] if m.get("role") == "tool"]
        self.assertIn("Handed to Scout", told[-1])
        kept = self.chats.get(chat["id"])["messages"][-1]
        self.assertEqual([a["job"] for a in kept["actions"] if a.get("kind") == "pip_job"], [row["id"]],
                         "the card is kept with the reply: a reload draws it again")

    def test_the_named_pip_line_says_ask_pip_hands_it_a_job(self):
        self.assertIn("ask_pip", _named_pips_line([{"name": "Scout"}], jobs=True))
        self.assertIn("rather than answering it yourself", _named_pips_line([{"name": "Scout"}], jobs=True))
        self.assertNotIn("ask_pip", _named_pips_line([{"name": "Scout"}], jobs=False))


class TheAnswerIsTold(ChatWorld):
    def setUp(self):
        super().setUp()
        self.frames, self.lock = [], threading.Lock()

        def emit(type, **fields):
            frame = {"type": type, **fields}
            problem = event_error({**frame, "seq": 0})
            if problem:
                raise AssertionError(f"invalid event: {problem}")
            with self.lock:
                self.frames.append(frame)
        self.service = ChatService(emit, self.config, engine=self.engine, wakeups=True)
        self.addCleanup(self.service.close, 2.0)

    def wait_for(self, test, what, timeout=8.0):
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                found = [f for f in self.frames if test(f)]
            if found:
                return found[-1]
            time.sleep(0.01)
        raise AssertionError(f"no {what}: {[f['type'] for f in self.frames[-10:]]}")

    def test_the_chat_is_told_once_with_a_turn_the_editor_starts(self):
        chat, _ = self.say("@Scout what does the shop sell?",
                           {"calls": [("ask_pip", {"pip": "Scout", "job": "what does the shop sell?"})]},
                           {"parts": ["Scout has it."]})
        [row] = self.registry.db.execute("SELECT id FROM pip_jobs").fetchall()
        self.service._job_check()
        with self.lock:
            self.assertFalse([f for f in self.frames if f["type"] == "chatdgc_wakeup_due"], "nothing while it works")
        run = self.store.claim_next()
        self.store.finish(run["id"], result={"text": "Tiles and grout."})
        self.service._job_check()
        due = self.wait_for(lambda f: f["type"] == "chatdgc_wakeup_due", "the answer's word to the editor")
        self.assertEqual((due["conversation_id"], due["id"]), (chat["id"], row["id"]))
        self.world["script"].append({"parts": ["Scout says: tiles and grout."]})
        cmd = {"type": "chatdgc_wake", "request_id": "w1", "conversation_id": chat["id"], "id": row["id"]}
        self.assertIsNone(command_error(cmd), cmd)
        self.service.dispatch(cmd)
        self.wait_for(lambda f: f["type"] == "chatdgc_turn" and f.get("state") == "ended", "the answer's turn")
        mine = [m for m in self.chats.get(chat["id"])["messages"] if m["role"] == "user"][-1]
        self.assertEqual(mine["wakeup"]["id"], row["id"])
        self.assertEqual(mine["wakeup"]["why"], "Scout · answered", "the screen shows it as DGC's note")
        self.assertTrue(mine["text"].startswith(pip_jobs.NOTICE_HEAD))
        self.assertIn("Tiles and grout.", mine["text"])
        self.assertIsNotNone(self.registry.db.execute("SELECT delivered_at FROM pip_jobs WHERE id=?",
                                                      (row["id"],)).fetchone()[0])
        before = len([f for f in self.frames if f["type"] == "chatdgc_wakeup_due"])
        self.service._job_check()
        self.assertEqual(len([f for f in self.frames if f["type"] == "chatdgc_wakeup_due"]), before, "told once")
        self.service.dispatch({**cmd, "request_id": "w2"})
        self.wait_for(lambda f: f["type"] == "chatdgc_error" and f.get("request_id") == "w2", "a second wake refused")


if __name__ == "__main__":
    unittest.main()
