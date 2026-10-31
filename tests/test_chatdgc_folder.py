"""A folder a chat may read (dgc/chatdgc/folder.py): read-only, never outside it, never a private file; offered to the
model only while the chat has one; kept as the chat's own setting (a reply never undoes a change made meanwhile);
and Continue in Work's brief."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dgc.chatdgc import folder as F
from dgc.chatdgc.engine import ChatEngine, ChatEngineError
from dgc.chatdgc.service import ChatService
from dgc.editor_protocol import command_error
from dgc.chatdgc.store import ChatStore
from dgc.shared_memory import SharedMemory
from test_chatdgc_canvas import Model
from test_chatdgc_wire import Wire


def project(root: Path) -> Path:
    (root / "src").mkdir(parents=True)
    (root / "src" / "upload.py").write_text("def upload(path):\n    limit = 20  # per minute\n    return path\n")
    (root / "README.md").write_text("# Uploads\n\nRate limits live in src/upload.py.\n")
    (root / ".env").write_text("API_KEY=sk-live-secret\n")
    (root / ".git").mkdir()
    (root / ".git" / "config").write_text("[core]\n")
    (root / "id_rsa").write_text("-----BEGIN OPENSSH PRIVATE KEY-----\n")
    (root / "long.txt").write_text("".join(f"line {n}\n" for n in range(1, 20001)))
    return root


class FolderTools(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-folder-")
        self.addCleanup(temp.cleanup)
        self.base = Path(os.path.realpath(temp.name))
        self.root = project(self.base / "uploads")
        (self.base / "outside.txt").write_text("not yours to read\n")

    def test_a_listing_shows_what_is_there_and_never_a_private_file(self):
        got = F.call(self.root, "folder_list", {})
        self.assertIn("src/", got)
        self.assertIn("README.md", got)
        for private in (".env", ".git", "id_rsa"):
            self.assertNotIn(private, got)
        self.assertIn("3 private ones not shown", got)
        self.assertIn("upload.py", F.call(self.root, "folder_list", {"path": "src"}))

    def test_a_large_directory_lists_only_the_first_300_visible_entries(self):
        many = self.root / "many"
        many.mkdir()
        for n in range(305):
            (many / f"file{n:03}.txt").touch()
        got = F.call(self.root, "folder_list", {"path": "many"})
        self.assertIn("… and more (5 not listed)", got)
        self.assertNotIn("file304.txt", got)

    def test_a_read_has_line_numbers_and_a_long_file_comes_in_parts(self):
        got = F.call(self.root, "folder_read", {"path": "src/upload.py"})
        self.assertIn("    2      limit = 20  # per minute", got)
        first = F.call(self.root, "folder_read", {"path": "long.txt"})
        self.assertIn("read on with start_line", first)
        nxt = int(first.rsplit("start_line ", 1)[1].rstrip("."))
        self.assertIn(f"line {nxt}\n", F.call(self.root, "folder_read", {"path": "long.txt", "start_line": nxt}) + "\n")

    def test_a_folder_swapped_to_an_outside_link_before_open_is_not_read(self):
        docs = self.root / "docs"
        docs.mkdir()
        selected = docs / "selected.txt"
        outside = self.base / "outside-dir"
        outside.mkdir()
        replacement = outside / "selected.txt"
        selected.write_text("chosen", encoding="utf-8")
        replacement.write_text("unexpected", encoding="utf-8")
        original_read = F.read_regular_bytes

        def replace_before_open(path, *, maximum):
            docs.rename(self.root / "old-docs")
            docs.symlink_to(outside)
            return original_read(path, maximum=maximum)

        with patch.object(F, "read_regular_bytes", side_effect=replace_before_open):
            got = F.call(self.root, "folder_read", {"path": "docs/selected.txt"})
        self.assertTrue(got.startswith("error:"), got)
        self.assertNotIn("unexpected", got)

    def test_nothing_private_or_outside_is_ever_read(self):
        for path in (".env", ".git/config", "id_rsa", "../outside.txt", "/etc/passwd", "src/../../outside.txt"):
            got = F.call(self.root, "folder_read", {"path": path})
            self.assertTrue(got.startswith("error:"), (path, got))
            self.assertNotIn("sk-live-secret", got)
            self.assertNotIn("not yours", got)
        (self.root / "link.txt").symlink_to(self.base / "outside.txt")
        self.assertIn("outside the folder", F.call(self.root, "folder_read", {"path": "link.txt"}))

    def test_a_search_finds_lines_but_skips_private_files(self):
        got = F.call(self.root, "folder_search", {"text": "LIMIT"})
        self.assertIn("src/upload.py:2:", got)
        self.assertIn("README.md:3:", got)
        self.assertNotIn("API_KEY", F.call(self.root, "folder_search", {"text": "api_key"}))
        self.assertEqual(F.call(self.root, "folder_search", {"text": "limit", "files": "*.md"}).count("\n"), 0)

    def test_a_folder_must_be_a_real_project_folder(self):
        for bad in ("", "relative/path", str(self.base / "missing"), str(self.root / "README.md"), "/",
                    str(Path.home())):
            with self.assertRaises(F.FolderError, msg=bad):
                F.usable(bad)
        self.assertEqual(F.usable(str(self.root)), self.root)


class FolderInChat(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-folderchat-")
        self.addCleanup(temp.cleanup)
        base = Path(os.path.realpath(temp.name))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(base / "home")
        self.addCleanup(lambda: os.environ.pop("DGC_HOME", None) if self._env is None
                        else os.environ.__setitem__("DGC_HOME", self._env))
        self.root = project(base / "uploads")
        self.world = {"script": [], "read": []}
        self.config = SimpleNamespace(base_url="", api_key="", model="chat-model", project_root=str(base),
                                      get=lambda key, default=None: default)
        self.engine = ChatEngine(self.config, ChatStore(base / "chat"), searcher=lambda q: [],
                                 memory=SharedMemory(base / "memory"), projects=lambda hidden: [],
                                 client_factory=lambda model: Model(self.world), plugins=lambda chat, said, taint: None)

    def say(self, chat, text, *steps):
        self.world["script"] += list(steps)
        return self.engine.send(chat["id"], text, search="off")

    def test_the_folder_tools_are_offered_only_while_the_chat_has_a_folder(self):
        chat = self.engine.open()
        self.say(chat, "Hello.", {"parts": ["Hi."]})
        self.assertNotIn("folder_read", self.world["read"][-1]["tools"])
        self.assertNotIn("folder to read", str(self.world["read"][-1]["messages"][0]["content"]))
        self.engine.set_folder(chat["id"], str(self.root))
        reply = self.say(chat, "Where is the upload limit set?",
                         {"calls": [("folder_search", {"text": "limit"})]},
                         {"calls": [("folder_read", {"path": "src/upload.py"})]},
                         {"parts": ["In src/upload.py, line 2: 20 a minute."]})
        request = self.world["read"][-3]
        self.assertIn("folder_read", request["tools"])
        self.assertIn(f"folder to read: {self.root}", str(request["messages"][0]["content"]))
        told = [m["content"] for m in self.world["read"][-1]["messages"] if m.get("role") == "tool"]
        self.assertIn("src/upload.py:2:", told[0])
        self.assertIn("limit = 20", told[1])
        self.assertIn("src/upload.py", reply["text"])
        self.engine.set_folder(chat["id"], "")
        self.say(chat, "Thanks.", {"parts": ["You're welcome."]})
        self.assertNotIn("folder_read", self.world["read"][-1]["tools"])

    def test_a_folder_chosen_before_the_first_message_stays_and_a_reply_never_undoes_a_change(self):
        chat = self.engine.open()
        self.engine.set_folder(chat["id"], str(self.root))
        self.say(chat, "What's in the folder?", {"calls": [("folder_list", {})]}, {"parts": ["src and a README."]})
        self.assertEqual(self.engine.store.get(chat["id"])["folder"], str(self.root))
        stale = self.engine.store.get(chat["id"])
        self.engine.set_folder(chat["id"], "")                  # meanwhile, from the chat's header
        self.engine.store.save(stale)                            # a reply that started before ends now
        self.assertNotIn("folder", self.engine.store.get(chat["id"]))

    def test_a_branch_and_a_continued_chat_read_the_same_folder_while_it_is_there(self):
        chat = self.engine.open()
        self.engine.set_folder(chat["id"], str(self.root))
        reply = self.say(chat, "Where is the upload limit set?", {"parts": ["In src/upload.py."]})
        branch = self.engine.branch(chat["id"], reply["id"])
        self.assertEqual(self.engine.store.get(branch["id"])["folder"], str(self.root))
        self.engine._summarize = lambda *a, **k: "Where the upload limit is set."
        carried = self.engine.carry(chat["id"])
        self.assertEqual(self.engine.store.get(carried["id"])["folder"], str(self.root))
        # A folder that has gone since isn't carried: the new chat would only say it can't read it.
        gone = Path(tempfile.mkdtemp())
        (gone / "README.md").write_text("x\n")
        other = self.engine.open()
        self.engine.set_folder(other["id"], str(gone))
        said = self.say(other, "Hello.", {"parts": ["Hi."]})
        shutil.rmtree(gone)
        self.assertNotIn("folder", self.engine.store.get(self.engine.branch(other["id"], said["id"])["id"]))
        self.assertNotIn("folder", self.engine.store.get(self.engine.carry(other["id"])["id"]))

    def test_continue_in_work_needs_a_folder_and_brings_a_brief_for_the_user_to_send(self):
        chat = self.engine.open()
        self.say(chat, "Let's plan the rate limit change.", {"parts": ["Move the limit into settings."]})
        with self.assertRaises(ChatEngineError):
            self.engine.work_brief(chat["id"])
        self.engine.set_folder(chat["id"], str(self.root))
        summarized = []
        # The summary is carry()'s own (_summarize, a model request): here, what that request was given.
        self.engine._summarize = lambda client, earlier, messages, room, cancel, purpose="summary": (
            summarized.append((messages, purpose)) or "We agreed to move the upload limit (20 a minute) into settings.")
        got = self.engine.work_brief(chat["id"])
        self.assertEqual([m["role"] for m in summarized[0][0]], ["user", "assistant"])
        self.assertEqual(summarized[0][1], "brief", "its failures say \"brief\", not \"summary\"")
        self.assertEqual(got["folder"], str(self.root))
        self.assertIn("upload limit", got["brief"])
        self.assertTrue(got["brief"].startswith("Continuing from the chat"))
        with self.assertRaises(ChatEngineError):
            self.engine.set_folder(chat["id"], str(Path.home()))


    def test_a_brief_that_fails_says_the_brief_failed_not_the_summary(self):
        import threading
        from types import SimpleNamespace

        class Down:
            def chat(self, *args, **kwargs):
                raise ConnectionError("model unreachable")

        message = [{"role": "user", "content": "plan it"}]
        with self.assertRaises(ChatEngineError) as failed:
            self.engine._summarize(Down(), "", message, 8000, purpose="brief")
        self.assertTrue(str(failed.exception).startswith("The brief for Work couldn't be written: model unreachable"))
        stop = threading.Event()

        class Stopped:
            def chat(self, *args, **kwargs):
                stop.set()
                return SimpleNamespace(content="partial")

        with self.assertRaises(ChatEngineError) as stopped:
            self.engine._summarize(Stopped(), "", message, 8000, stop, purpose="brief")
        self.assertEqual(str(stopped.exception), "Stopped before the brief was written.")
        with self.assertRaises(ChatEngineError) as summary:
            self.engine._summarize(Down(), "", message, 8000)
        self.assertTrue(str(summary.exception).startswith("The earlier messages couldn't be summarized"))

class FolderOnTheWire(unittest.TestCase):
    """The commands and events, as the protocol checks them (the Wire raises on an invalid event)."""
    say = FolderInChat.say                    # borrowed, not inherited: a subclass would run every test above again

    def setUp(self):
        FolderInChat.setUp(self)
        self.wire = Wire()
        self.service = ChatService(self.wire.emit, self.config, engine=self.engine)
        self.addCleanup(self.service.close, 2.0)

    def run_cmd(self, **cmd):
        self.assertIsNone(command_error(cmd), cmd)
        self.service.dispatch(cmd)

    def test_set_ask_and_continue_in_work_over_the_wire(self):
        chat = self.engine.open()
        self.say(chat, "Plan the change.", {"parts": ["Move the limit into settings."]})
        self.run_cmd(type="chatdgc_set_folder", request_id="s1", conversation_id=chat["id"], folder=str(self.root))
        self.assertEqual(self.wire.of("chatdgc_folder")[-1]["folder"], str(self.root))
        self.run_cmd(type="chatdgc_folder", request_id="g1", conversation_id=chat["id"])
        self.assertEqual((self.wire.of("chatdgc_folder")[-1]["request_id"], self.wire.of("chatdgc_folder")[-1]["folder"]),
                         ("g1", str(self.root)))
        self.engine._summarize = lambda *a, **k: "Move the upload limit into settings."
        self.run_cmd(type="chatdgc_work_brief", request_id="w1", conversation_id=chat["id"])
        brief = self.wire.wait(lambda f: f["type"] == "chatdgc_work_brief")
        self.assertEqual((brief["request_id"], brief["folder"]), ("w1", str(self.root)))
        # Every window hears what the chat is busy with: a brief, not earlier messages being summarized.
        busy = [f for f in self.wire.of("chatdgc_activity") if f.get("message_id") == "w1"]
        self.assertEqual([(f["kind"], f["text"]) for f in busy], [("compacting", "brief")])
        self.assertIn("upload limit", brief["brief"])
        self.run_cmd(type="chatdgc_set_folder", request_id="s2", conversation_id=chat["id"], folder="/")
        self.assertEqual(self.wire.wait(lambda f: f["type"] == "chatdgc_error" and f.get("request_id") == "s2")["request_id"], "s2")
        self.run_cmd(type="chatdgc_set_folder", request_id="s3", conversation_id=chat["id"], folder="")
        self.assertEqual(self.wire.of("chatdgc_folder")[-1]["folder"], "")


if __name__ == "__main__":
    unittest.main()
