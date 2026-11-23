"""Save to Library for a picture in a chat (0.52; asked 18 Nov: "if the pip chat gave me the image card and showed me
image, shouldn't that have also be saved and stored in the library ... or that will just flood the library ... maybe for
these images, on the card we give an option for 'Save', and that saves the image in library? or give pip tool to do so
as well, so user can ask, save this image in library?").

Nothing is kept on its own beyond what already is (a generated picture is in the Library from the start). A person keeps
one with Save to Library on its row or in its pop-up, through the ONE module (dgc.image_keep), kept by them ("kept_by":
"you") with the chat it came from; a picture already in the Library, generated or kept, is found by its bytes and says
"In Library" instead, so nothing is kept twice. Three doors, one per surface: Work's `library_picture` (a picture of
the session by its ref, or a project picture by its path), ChatDGC's `chatdgc_library_picture` (a chat's picture by its
attachment id) and Pips API 106's `library_pip_message_image` (a picture of a Pip's chat, local only). A Pip's own
keep_image takes a picture from its Files, or one it sent in the chat, besides an https address."""
import base64
import hashlib
import io
import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests.test_image_keep import Home, PNG  # noqa: E402

# A second, different picture (2x1), so "the same bytes" means something.
PNG2 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNk+M/AwMDAwAAAABMAAeAVNFMAAAAASUVORK5CYII=")


class HeldAndKeptOnce(Home):
    def test_a_generated_picture_is_found_by_its_bytes(self):
        from dgc import image_keep
        made = self.tmp / "home" / "images" / "fox.png"
        made.parent.mkdir(parents=True, exist_ok=True)
        made.write_bytes(PNG)
        # A row written before rows carried a digest: found by its size, then its bytes.
        self.images._index({"path": str(made), "surface": "pip", "prompt": "a fox", "bytes": len(PNG),
                            "created_at": "2026-11-18T00:00:00Z", "pip": "pip_x"})
        row = image_keep.held(PNG)
        self.assertIsNotNone(row, "the generated picture is in the Library already")
        self.assertEqual(row["path"], str(made))
        self.assertIsNone(image_keep.held(PNG2), "other bytes are not")
        made.unlink()
        self.assertIsNone(image_keep.held(PNG), "a row whose file is gone holds nothing")

    def test_keeping_the_same_bytes_twice_keeps_one(self):
        from dgc import image_keep
        first = image_keep.keep(PNG, title="Cafe front", why="", source="chat", surface="chat", where={"chat": "chat_1"}, by="you")
        again = image_keep.keep(PNG, title="Cafe again", why="", source="chat", surface="chat", where={"chat": "chat_1"}, by="you")
        self.assertFalse(first.get("already"))
        self.assertTrue(again["already"], "nothing is kept twice")
        self.assertEqual(again["title"], "Cafe front", "it names the one already there")
        self.assertEqual(self.images.library()["total"], 1)
        self.assertIn("already", image_keep.said(again).lower())

    def test_a_kept_row_carries_its_digest_and_who_kept_it(self):
        from dgc import image_keep
        image_keep.keep(PNG, title="Mine", why="", source="", surface="work", where={"session": "s1"}, by="you")
        image_keep.keep(PNG2, title="The model's", why="asked", source="", surface="work", where={"session": "s1"})
        rows = {r["title"]: r for r in self.images.library()["images"]}
        self.assertEqual(rows["Mine"]["sha256"], hashlib.sha256(PNG).hexdigest())
        self.assertEqual(rows["Mine"]["kept_by"], "you")
        self.assertNotIn("kept_by", rows["The model's"], "a model's keep stays as it was")

    def test_a_generated_picture_row_carries_its_digest_too(self):
        from dgc import images
        from dgc.image_providers import Picture, Request
        folder = self.tmp / "home" / "images" / "made"
        saved = images.save([Picture(data=PNG, mime="image/png")], folder=folder, root=None, prompt="a fox",
                            generator={"id": "g", "name": "G", "provider": "fal"}, model="m", cost=None,
                            surface="pip", request=Request(prompt="a fox"))
        self.assertEqual(self.images.library()["images"][0]["sha256"], hashlib.sha256(PNG).hexdigest())
        self.assertTrue(saved[0].path.is_file())


class WorkDoor(Home):
    """Work: `library_picture` {request_id, ref | path, keep} answered by one `library_picture` event."""

    def setUp(self):
        super().setUp()
        from dgc import editor_protocol as ep
        from dgc.headless import Backend
        from dgc.protocol import Emitter, PendingRequests
        from tests.test_image_views import fixture_config
        self.ep = ep
        self.session = self.tmp / "20261118-000000-abcd0003.json"
        self.project = self.tmp / "proj"
        (self.project / "assets").mkdir(parents=True)
        (self.project / "assets" / "shot.png").write_bytes(PNG2)
        self.stream = io.StringIO()
        backend = object.__new__(Backend)
        backend.em = Emitter(self.stream, validator=ep.event_error)
        backend.config = fixture_config(self.project)
        backend.pending = PendingRequests()
        backend._queue = []
        backend.agent = types.SimpleNamespace(session_file=self.session, image_views=[], cancelled=threading.Event(), monitors=None)
        backend._busy = lambda: True
        self.backend = backend

    def events(self, wait_for, timeout=10.0):
        deadline = time.monotonic() + timeout
        while True:
            frames = [json.loads(line) for line in self.stream.getvalue().splitlines() if line]
            found = [f for f in frames if f["type"] in ("library_picture", "command_rejected")]
            if len(found) >= wait_for or time.monotonic() > deadline:
                for frame in frames:
                    self.assertIsNone(self.ep.event_error(frame), frame)
                return found

    def test_a_picture_of_the_session_is_checked_then_kept_once(self):
        from dgc import image_views
        record = image_views.store(self.session, PNG, name="fox.png", source="view_image")
        self.backend.agent.image_views.append(record)
        self.backend.dispatch({"type": "library_picture", "request_id": "c1", "ref": record.ref})
        [checked] = self.events(1)
        self.assertEqual((checked["request_id"], checked["in_library"], checked["kept"]), ("c1", False, False))
        self.backend.dispatch({"type": "library_picture", "request_id": "k1", "ref": record.ref, "keep": True, "title": "Fox"})
        kept = self.events(2)[1]
        self.assertEqual((kept["in_library"], kept["kept"], kept["title"]), (True, True, "Fox"))
        row = self.images.library()["images"][0]
        self.assertEqual((row["surface"], row["kept_by"], row["session"]), ("work", "you", self.session.stem))
        self.backend.dispatch({"type": "library_picture", "request_id": "k2", "ref": record.ref, "keep": True})
        twice = self.events(3)[2]
        self.assertEqual((twice["in_library"], twice["kept"]), (True, False), "In Library: not kept twice")
        self.assertEqual(self.images.library()["total"], 1)

    def test_a_project_picture_by_its_path_and_nothing_outside_the_project(self):
        self.backend.dispatch({"type": "library_picture", "request_id": "p1", "path": "assets/shot.png", "keep": True})
        [kept] = self.events(1)
        self.assertTrue(kept["kept"], kept)
        for n, path in enumerate(("../outside.png", "/etc/hostname")):
            self.backend.dispatch({"type": "library_picture", "request_id": f"x{n}", "path": path, "keep": True})
        refused = self.events(3)[1:]
        self.assertTrue(all(not e["in_library"] and not e["kept"] and e.get("reason") for e in refused), refused)
        self.assertEqual(self.images.library()["total"], 1)

    def test_an_unknown_ref_says_so_and_the_capability_is_offered(self):
        self.backend.dispatch({"type": "library_picture", "request_id": "u1", "ref": "img_" + "f" * 32})
        [answer] = self.events(1)
        self.assertEqual(answer["reason"], "not_found")
        self.assertIn("library_picture", self.ep.COMMAND_FIELDS)
        from dgc import headless
        self.assertIn("library_picture", headless._WAKE_NEUTRAL_COMMANDS)
        self.assertNotIn("library_picture", headless._BUSY_MUTATIONS, "it doesn't touch the chat: fine while a turn runs")


class ChatDoor(Home):
    """ChatDGC: `chatdgc_library_picture` {request_id, conversation_id, attachment_id, keep}."""

    def setUp(self):
        super().setUp()
        from dgc.chatdgc.engine import ChatEngine
        from dgc.chatdgc.service import ChatService
        from dgc.chatdgc.store import ChatStore
        from dgc.shared_memory import SharedMemory
        from tests.test_chatdgc_widgets import Model, Wire
        self.world, self.wire = {"script": [], "read": []}, Wire()
        config = SimpleNamespace(base_url="", api_key="", model="chat-model", get=lambda key, default=None: default)
        self.engine = ChatEngine(config, ChatStore(self.tmp / "chat"), searcher=lambda q: [],
                                 memory=SharedMemory(self.tmp / "memory"), projects=lambda hidden: [],
                                 client_factory=lambda model: Model(self.world), plugins=lambda chat, said, taint: None)
        self.service = ChatService(self.wire.emit, config, engine=self.engine)
        self.addCleanup(self.service.close, 2.0)

    def ask(self, request_id, **fields):
        self.service.dispatch({"type": "chatdgc_library_picture", "request_id": request_id, **fields})
        return [f for f in self.wire.frames if f.get("request_id") == request_id][-1]

    def test_a_picture_you_attached_is_kept_once_with_its_chat(self):
        chat = self.engine.open()
        self.world["script"] += [{"parts": ["A nice cafe."]}]
        with mock.patch.object(self.engine, "_sees", return_value=True):      # (a model that can see: not what's tested)
            self.engine.send(chat["id"], "Look", search="off",
                             attachments=[{"kind": "image", "name": "cafe.png", "data": "data:image/png;base64," + base64.b64encode(PNG).decode()}])
        sent = [m for m in self.engine.store.get(chat["id"])["messages"] if m["role"] == "user"][0]
        att = sent["attachments"][0]["id"]
        first = self.ask("c", conversation_id=chat["id"], attachment_id=att)
        self.assertEqual((first["type"], first["in_library"], first["kept"]), ("chatdgc_library_picture", False, False))
        kept = self.ask("k", conversation_id=chat["id"], attachment_id=att, keep=True)
        self.assertEqual((kept["in_library"], kept["kept"]), (True, True))
        row = self.images.library()["images"][0]
        self.assertEqual((row["surface"], row["chat"], row["kept_by"]), ("chat", chat["id"], "you"))
        again = self.ask("k2", conversation_id=chat["id"], attachment_id=att, keep=True)
        self.assertEqual((again["in_library"], again["kept"]), (True, False))
        self.assertEqual(self.images.library()["total"], 1)

    def test_a_file_that_isnt_a_picture_is_refused_in_words(self):
        chat = self.engine.open()
        self.world["script"] += [{"parts": ["Read it."]}]
        self.engine.send(chat["id"], "Look", search="off", attachments=[{"kind": "text", "name": "notes.txt", "text": "hello"}])
        sent = [m for m in self.engine.store.get(chat["id"])["messages"] if m["role"] == "user"][0]
        answer = self.ask("t", conversation_id=chat["id"], attachment_id=sent["attachments"][0]["id"], keep=True)
        self.assertEqual(answer["type"], "chatdgc_error")
        self.assertEqual(self.images.library()["total"], 0)

    def test_known_to_the_protocol_and_offered(self):
        from dgc import headless
        from dgc.editor_protocol import COMMAND_FIELDS, EVENT_FIELDS
        self.assertIn("chatdgc_library_picture", COMMAND_FIELDS)
        self.assertIn("chatdgc_library_picture", EVENT_FIELDS)
        be = headless.Backend.__new__(headless.Backend)
        be._host = object()
        self.assertEqual(be._chatdgc_capability()["chatdgc"].get("library_picture"), 1)


if __name__ == "__main__":
    unittest.main()
