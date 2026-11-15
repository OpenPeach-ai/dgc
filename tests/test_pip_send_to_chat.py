"""A Pip sends pictures, videos and files in its chat, like a person (his ask, 15 Nov: "Pip should have capability to
show images, or videos or such files in the chat itself, like it happens in regular chat between 2 people"; finding 59).

Before: a reply carried only the pictures it generated, the videos it started and a long reply's document; a file it
made on its computer stayed in its Files, and the user's own files on a message could be listed but never opened. Now
its computer has `send_to_chat` {path}: the HOST (the controller, never the worker's word) reads that file from the
Pip's Files (nothing outside them, no links), keeps it in the chat's own store by its digest, and records it for this
reply; the reply shows pictures as pictures and every other file (a video, a sheet, a zip) as a file the user opens or
saves. `get_pip_message_file` (Pips API 101) gives the editor a message's file, checked against its digest, on this
computer only, for the user's own files too."""
import json
import os
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_chat, pip_chat_sends, pip_computer, pips
from dgc import pip_computer_files as desk
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures
from tests.test_pip_computer_desk import PLAN
from tests.test_pip_missed_steer import Base

PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
       b"\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82")


class Sends(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True
        self.pip = self.store.create(self.registry.personal()["id"], "Painter", "Paint", "local-console")
        proposal = self.store.propose(self.pip["id"], 1, {"computer_plan": PLAN}, "local-console")
        self.store.accept(self.pip["id"], proposal["id"], 1, "local-console")
        root = pip_computer.computer_root(self.registry.directory, self.pip["id"])
        self.files = desk.files_root(root)
        (self.files / "Pictures").mkdir(parents=True, exist_ok=True)
        self.run_dir = self.registry.directory / "runs" / ("run_" + "a" * 32)
        frames = self.run_dir / "artifacts" / "computer"
        frames.mkdir(parents=True)
        self.host = types.SimpleNamespace(root=root, files_dir=self.files, waiting=[], last_used=0,
                                          state_directory=self.registry.directory, pip_id=self.pip["id"],
                                          run_id="run_" + "a" * 32, frames_dir=frames)

    def send(self, path):
        return pip_computer.Host._desk(self.host, "send_to_chat", {"path": path})

    def record(self):
        return json.loads((self.run_dir / pip_chat_sends.RECORD).read_text())

    def test_a_picture_from_its_files_is_kept_and_recorded_for_this_reply(self):
        (self.files / "Pictures" / "cafe.png").write_bytes(PNG)
        said = self.send("Pictures/cafe.png")
        self.assertIn("cafe.png", said)
        self.assertFalse(said.startswith("error"), said)
        [item] = self.record()
        self.assertEqual((item["kind"], item["name"], item["mime"], item["bytes"]), ("image", "cafe.png", "image/png", len(PNG)))
        kept = pip_chat.image_paths(self.registry.directory, self.pip["id"], [{k: item[k] for k in ("sha256", "mime", "bytes")}])
        self.assertEqual(Path(kept[0]).read_bytes(), PNG, "kept in the chat's own store, by digest")

    def test_any_other_file_is_a_file_a_video_too(self):
        (self.files / "clip.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
        (self.files / "tides.zip").write_bytes(b"PK\x03\x04" + b"\x00" * 40)
        self.send("clip.mp4")
        self.send("tides.zip")
        kinds = [(i["kind"], i["name"], i["mime"]) for i in self.record()]
        self.assertEqual(kinds, [("file", "clip.mp4", "video/mp4"), ("file", "tides.zip", "application/zip")])

    def test_a_name_that_says_picture_but_isnt_is_a_file(self):
        (self.files / "fake.png").write_bytes(b"not a picture at all")
        self.send("fake.png")
        self.assertEqual(self.record()[0]["kind"], "file", "the bytes decide, never the name")

    def test_nothing_outside_its_files_and_no_links(self):
        outside = self.registry.directory / "secret.txt"
        outside.write_text("key")
        os.symlink(outside, self.files / "link.txt")
        for path in ("../secret.txt", "link.txt", "missing.png", ""):
            with self.subTest(path=path):
                self.assertTrue(self.send(path).startswith("error"), path)
        self.assertFalse((self.run_dir / pip_chat_sends.RECORD).exists())

    def test_bounded_per_file_and_per_reply(self):
        (self.files / "a.txt").write_text("a")
        with patch.object(pip_chat_sends, "MAX_FILE_BYTES", 0):
            self.assertTrue(self.send("a.txt").startswith("error"))
        with patch.object(pip_chat_sends, "MAX_PER_REPLY", 2):
            self.send("a.txt")
            self.send("a.txt")
            self.assertTrue(self.send("a.txt").startswith("error"), "a third one in a reply of two")

    def test_only_inside_a_reply(self):
        (self.files / "a.txt").write_text("a")
        self.host.run_id = None
        self.assertTrue(self.send("a.txt").startswith("error"))

    def test_the_pip_is_told_how_to_send_one(self):
        text = pip_computer.schema()["function"]["description"]
        self.assertIn("send_to_chat", text)
        self.assertIn("send_to_chat", pip_computer.OPS)
        self.assertIn("send_to_chat", pip_computer.DESK_OPS, "never waits on the browser")


class OnTheReply(Base):
    """The record becomes the reply's pictures and files; get_pip_message_file opens one."""

    def reply_with(self, sent):
        self.job_ready()
        first = pip_chat.send(self.store, self.job["id"], "Paint the cafe", "first", "editor-user", self.cfg)
        self.store.claim_next()
        run_dir = self.registry.directory / "runs" / first["run"]["id"]
        run_dir.mkdir(parents=True, exist_ok=True)
        records = []
        for kind, name, raw, mime in sent:
            records.append(pip_chat_sends.keep(self.registry.directory, self.job["id"], name, raw, mime))
        (run_dir / pip_chat_sends.RECORD).write_text(json.dumps(records))
        self.store.finish(first["run"]["id"], result={"text": "Here it is."})
        [reply] = [m for m in pip_chat.list_messages(self.store, self.job["id"])["messages"] if m["role"] == "assistant"]
        return reply

    def test_pictures_and_files_show_on_the_reply(self):
        reply = self.reply_with([("image", "cafe.png", PNG, "image/png"), ("file", "clip.mp4", b"x" * 10, "video/mp4")])
        self.assertEqual(reply["images"], [{"index": 0, "mime": "image/png", "bytes": len(PNG)}])
        self.assertEqual(reply["files"], [{"index": 0, "name": "clip.mp4", "bytes": 10, "mime": "video/mp4"}])

    def control(self, request, actor="editor-user"):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def test_get_pip_message_file_gives_the_kept_file_on_this_computer_only(self):
        reply = self.reply_with([("file", "clip.mp4", b"x" * 10, "video/mp4")])
        out = self.control({"type": "get_pip_message_file", "pip_id": self.job["id"], "message_id": reply["id"], "index": 0})
        self.assertTrue(out["ok"], out)
        self.assertEqual(Path(out["result"]["path"]).read_bytes(), b"x" * 10)
        self.assertEqual((out["result"]["name"], out["result"]["mime"]), ("clip.mp4", "video/mp4"))
        remote = self.control({"type": "get_pip_message_file", "pip_id": self.job["id"], "message_id": reply["id"],
                               "index": 0}, actor="device_" + "1" * 32)
        self.assertFalse(remote["ok"])
        Path(out["result"]["path"]).write_bytes(b"y" * 10)
        changed = self.control({"type": "get_pip_message_file", "pip_id": self.job["id"], "message_id": reply["id"], "index": 0})
        self.assertFalse(changed["ok"], "a kept file that changed on disk is never handed out")

    def test_it_is_in_pips_api_101_and_the_sdk_reads_it(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 101)
        from dgc_sdk import pips as sdk
        self.assertIn("get_pip_message_file", sdk.READ_COMMANDS)
        self.assertEqual(sdk.COMMAND_FIELDS["get_pip_message_file"], pips._COMMAND_ARGS["get_pip_message_file"])
        self.assertEqual(sdk.API101_READS, frozenset({"get_pip_message_file"}))


if __name__ == "__main__":
    unittest.main()
