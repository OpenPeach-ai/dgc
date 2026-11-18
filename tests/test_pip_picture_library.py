"""A Pip's chat and the Library (0.52; his ask, 18 Nov: "maybe for these images, on the card we give an option for 'Save',
and that saves the image in library? or give pip tool to do so as well, so user can ask, save this image in library?").

Pips API 108: `library_pip_message_image {pip_id, message_id, index, keep}` says whether a picture of the chat is in the
Library (a generated one is, from the start) and, with keep, keeps it there through dgc.image_keep, kept by the person
with this Pip's chat as where it came from. Local only, and never twice. A Pip's keep_image also takes a picture from its
own Files (read by DGC inside Files, an image by its bytes, size-capped) or one it sent in this chat by its name."""
import base64
import json
import os
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import image_keep, images, pip_chat, pip_chat_sends, pip_computer, pips
from dgc import pip_computer_files as desk
from tests import test_pips_local as fixtures
from tests.test_pip_computer_desk import PLAN
from tests.test_pip_missed_steer import Base
from tests.test_pip_send_to_chat import PNG

JPEG_LIKE_TEXT = b"this is not a picture"


class FromItsChat(Base):
    def reply_with(self, sent):
        self.job_ready()
        first = pip_chat.send(self.store, self.job["id"], "Paint the cafe", "first", "editor-user", self.cfg)
        self.store.claim_next()
        run_dir = self.registry.directory / "runs" / first["run"]["id"]
        run_dir.mkdir(parents=True, exist_ok=True)
        records = [pip_chat_sends.keep(self.registry.directory, self.job["id"], name, raw) for name, raw in sent]
        (run_dir / pip_chat_sends.RECORD).write_text(json.dumps(records))
        self.store.finish(first["run"]["id"], result={"text": "Here it is."})
        [reply] = [m for m in pip_chat.list_messages(self.store, self.job["id"])["messages"] if m["role"] == "assistant"]
        return reply

    def control(self, request, actor="editor-user"):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def test_a_sent_picture_is_checked_then_kept_once_with_its_chat(self):
        reply = self.reply_with([("cafe.png", PNG)])
        ask = {"type": "library_pip_message_image", "pip_id": self.job["id"], "message_id": reply["id"], "index": 0}
        checked = self.control(ask)
        self.assertTrue(checked["ok"], checked)
        self.assertEqual((checked["result"]["in_library"], checked["result"]["kept"]), (False, False))
        kept = self.control({**ask, "keep": True})
        self.assertEqual((kept["result"]["in_library"], kept["result"]["kept"]), (True, True))
        row = images.library()["images"][0]
        self.assertEqual((row["surface"], row["pip"], row["kept_by"]), ("pip", self.job["id"], "you"))
        again = self.control({**ask, "keep": True})
        self.assertEqual((again["result"]["in_library"], again["result"]["kept"]), (True, False), "In Library, never twice")
        self.assertEqual(images.library()["total"], 1)

    def test_a_generated_picture_is_in_the_library_already(self):
        reply = self.reply_with([("cafe.png", PNG)])
        made = images.directory() / "made" / "cafe.png"
        made.parent.mkdir(parents=True, exist_ok=True)
        made.write_bytes(PNG)
        images._index({"path": str(made), "surface": "pip", "pip": self.job["id"], "prompt": "a cafe", "bytes": len(PNG)})
        out = self.control({"type": "library_pip_message_image", "pip_id": self.job["id"], "message_id": reply["id"], "index": 0})
        self.assertEqual((out["result"]["in_library"], out["result"]["kept"]), (True, False))

    def test_only_on_this_computer_and_only_a_picture_of_this_chat(self):
        reply = self.reply_with([("cafe.png", PNG)])
        remote = self.control({"type": "library_pip_message_image", "pip_id": self.job["id"], "message_id": reply["id"],
                               "index": 0, "keep": True}, actor="device_" + "1" * 32)
        self.assertFalse(remote["ok"])
        missing = self.control({"type": "library_pip_message_image", "pip_id": self.job["id"], "message_id": reply["id"], "index": 5})
        self.assertFalse(missing["ok"])
        bad = self.control({"type": "library_pip_message_image", "pip_id": self.job["id"], "message_id": reply["id"], "index": 0, "keep": "yes"})
        self.assertFalse(bad["ok"])
        self.assertEqual(images.library()["total"], 0)

    def test_in_pips_api_106_and_both_sdks(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 106)
        self.assertIn("library_pip_message_image", pips.CONTROL_COMMANDS)
        from dgc_sdk import pips as sdk
        self.assertIn("library_pip_message_image", sdk.MUTATION_COMMANDS)
        self.assertEqual(sdk.COMMAND_FIELDS["library_pip_message_image"], pips._COMMAND_ARGS["library_pip_message_image"])
        ts = (Path(__file__).resolve().parent.parent / "sdk" / "typescript" / "src" / "pips.ts").read_text()
        self.assertIn("library_pip_message_image", ts)


class ItsOwnTool(unittest.TestCase):
    """keep_image in a Pip's run: from its Files, or a picture it sent in this chat."""
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True
        self.pip = self.store.create(self.registry.personal()["id"], "Painter", "Paint", "local-console")
        proposal = self.store.propose(self.pip["id"], 1, {"computer_plan": PLAN}, "local-console")
        self.store.accept(self.pip["id"], proposal["id"], 1, "local-console")
        self.files = desk.files_root(pip_computer.computer_root(self.registry.directory, self.pip["id"]))
        (self.files / "Pictures").mkdir(parents=True, exist_ok=True)
        from dgc import pip_app_links
        run = pip_app_links.RunSocket.__new__(pip_app_links.RunSocket)
        run.taint, run.said, run.config, run.pip_id, run.run_id = None, "", self.cfg, self.pip["id"], "run_" + "b" * 32
        run.directory = self.registry.directory
        self.run = run

    def keep(self, source, title="Cafe"):
        return self.run._keep_image({"source": source, "title": title})

    def test_a_picture_in_its_files_is_kept_with_this_pip(self):
        (self.files / "Pictures" / "cafe.png").write_bytes(PNG)
        said = self.keep("Pictures/cafe.png")
        self.assertFalse(said.startswith("error"), said)
        row = images.library()["images"][0]
        self.assertEqual((row["surface"], row["pip"], row["kept"]), ("pip", self.pip["id"], True))
        self.assertIn("already", self.keep("Pictures/cafe.png").lower(), "the same picture again is not kept twice")
        self.assertEqual(images.library()["total"], 1)

    def test_files_also_by_its_files_name_with_the_folder_word(self):
        (self.files / "cafe.png").write_bytes(PNG)
        self.assertFalse(self.keep("Files/cafe.png").startswith("error"))

    def test_not_a_picture_nothing_outside_files_and_size_capped(self):
        (self.files / "fake.png").write_bytes(JPEG_LIKE_TEXT)
        outside = self.registry.directory / "secret.png"
        outside.write_bytes(PNG)
        os.symlink(outside, self.files / "link.png")
        for source in ("fake.png", "../secret.png", "link.png", "missing.png", "/etc/hostname"):
            with self.subTest(source=source):
                self.assertTrue(self.keep(source).startswith("error"), source)
        (self.files / "big.png").write_bytes(PNG)
        with patch.object(image_keep, "MAX_BYTES", 10):
            self.assertTrue(self.keep("big.png").startswith("error"))
        self.assertEqual(images.library()["total"], 0)

    def test_one_it_sent_in_this_chat_by_its_name_when_its_files_no_longer_have_it(self):
        run_dir = self.registry.directory / "runs" / ("run_" + "c" * 32)
        run_dir.mkdir(parents=True)
        item = pip_chat_sends.keep(self.registry.directory, self.pip["id"], "cafe.png", PNG)
        (run_dir / pip_chat_sends.RECORD).write_text(json.dumps([item]))
        said = self.keep("cafe.png")
        self.assertFalse(said.startswith("error"), said)
        self.assertEqual(images.library()["total"], 1)

    def test_another_pips_sent_picture_is_not_this_ones(self):
        other = self.store.create(self.registry.personal()["id"], "Other", "Other", "local-console")
        run_dir = self.registry.directory / "runs" / ("run_" + "d" * 32)
        run_dir.mkdir(parents=True)
        item = pip_chat_sends.keep(self.registry.directory, other["id"], "theirs.png", PNG)
        (run_dir / pip_chat_sends.RECORD).write_text(json.dumps([item]))
        self.assertTrue(self.keep("theirs.png").startswith("error"))

    def test_an_https_address_still_works_and_the_pip_is_told_of_files(self):
        with patch("dgc.image_keep.from_url", return_value=(PNG, "https://a.example/p.png")):
            self.assertFalse(self.keep("https://a.example/p.png").startswith("error"))
        text = image_keep.PIP_SCHEMA["function"]["description"] + image_keep.PIP_SCHEMA["function"]["parameters"]["properties"]["source"]["description"]
        self.assertIn("Files", text)
        self.assertIn("sent", text)
        self.assertEqual(image_keep.PIP_SCHEMA["function"]["name"], "keep_image")


if __name__ == "__main__":
    unittest.main()
