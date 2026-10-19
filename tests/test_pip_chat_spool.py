"""Photos and files in a Pip's chat handed over the Work chat's way (Pips API 52).

Inline, a message's images rode inside the request as data URIs, and the 4 MiB command frame capped
them at four and 2 MB together: one phone photo of a medical bill could be over that. From API 52 the
editor writes them into the backend's spool and sends their names (`spooled_images`, `spooled_files`),
and a Pip chat takes what the Work chat takes: 8 MB a photo, 32 MB a message, no four-photo cap, and
documents up to 16 MB. An iPhone photo (HEIC) is kept as the JPEG it becomes.
"""
import base64
import json
import os
import struct
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import photos, pip_chat, pips
from dgc.attachments import spool_root
from dgc.image_views import parse_dimensions
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

MB = 1024 * 1024


def jpeg(width=4032, height=3024, size=0):
    """A phone-photo-sized JPEG as DGC sees it: its markers, and enough bytes to weigh what a photo does."""
    sof = struct.pack(">BHHB", 8, height, width, 3) + b"\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    head = b"\xff\xd8\xff\xe0" + struct.pack(">H", 16) + b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0"
    head += b"\xff\xc0" + struct.pack(">H", len(sof) + 2) + sof
    return head + b"\x5a" * max(0, size - len(head) - 2) + b"\xff\xd9"


def heic():
    ftyp = struct.pack(">I", 24) + b"ftypheic" + b"\0\0\0\0" + b"mif1heic"
    ispe = struct.pack(">I", 20) + b"ispe" + b"\0\0\0\0" + struct.pack(">II", 4032, 3024)
    return ftyp + struct.pack(">I", 32) + b"meta" + b"\0\0\0\0" + ispe + struct.pack(">I", 16) + b"mdat" + b"\0" * 8


def convert_like_sips(source, target, kind, side, quality):
    Path(target).write_bytes(jpeg(4032, 3024, size=3 * MB))


class SpooledPhotoTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def pip(self):
        return self.store.create(self.registry.personal()["id"], "Bills", None, "editor-user", pip_type="lens")

    def control(self, request, actor="editor-user"):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def spool(self, raw, suffix=".jpg"):
        folder = spool_root("")
        name = os.urandom(8).hex() + suffix
        (folder / name).write_bytes(raw)
        return name

    def spooled(self):
        return sorted(p.name for p in spool_root("").iterdir())

    def send(self, pip, **fields):
        return self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "What do I owe?",
                             "idempotency_key": "k-" + os.urandom(4).hex(), **fields})

    def test_five_phone_photos_of_a_bill_go_in_one_message(self):
        pip = self.pip()
        photos_sent = [jpeg(size=(4 + i % 2) * MB) for i in range(5)]           # 22 MB: far over 4 and 2 MB
        sent = self.send(pip, spooled_images=[{"name": self.spool(raw), "media_type": "image/jpeg"} for raw in photos_sent])
        self.assertTrue(sent["ok"], sent.get("error"))
        self.assertEqual([i["bytes"] for i in sent["result"]["message"]["images"]], [len(raw) for raw in photos_sent])
        self.assertEqual(self.spooled(), [], "the spool is a hand-over, not a store")
        kept = sorted(pip_chat.image_directory(self.registry.directory, pip["id"]).iterdir())
        self.assertEqual(len(kept), 2, "kept once by digest: two different photos")
        self.assertTrue(all(oct(p.stat().st_mode & 0o777) == "0o600" for p in kept))
        [message] = pip_chat.list_messages(self.store, pip["id"])["messages"]
        self.assertEqual([i["index"] for i in message["images"]], [0, 1, 2, 3, 4])

    def test_the_original_is_read_back_as_its_kept_file(self):
        pip = self.pip()
        raw = jpeg(size=6 * MB)
        self.send(pip, spooled_images=[{"name": self.spool(raw), "media_type": "image/jpeg"}])
        [message] = pip_chat.list_messages(self.store, pip["id"])["messages"]
        got = self.control({"type": "get_pip_message_image", "pip_id": pip["id"], "message_id": message["id"],
                            "index": 0, "as_file": True})
        self.assertTrue(got["ok"], got.get("error"))
        self.assertEqual(Path(got["result"]["path"]).read_bytes(), raw, "the original, not a shrunk copy")
        self.assertEqual((got["result"]["mime"], got["result"]["bytes"]), ("image/jpeg", len(raw)))
        self.assertNotIn("image", got["result"])
        with open(got["result"]["path"], "ab") as tamper:
            tamper.write(b"x")
        changed = self.control({"type": "get_pip_message_image", "pip_id": pip["id"], "message_id": message["id"],
                                "index": 0, "as_file": True})
        self.assertFalse(changed["ok"], "a kept file that changed is never handed out")
        refused = self.control({"type": "get_pip_message_image", "pip_id": pip["id"], "message_id": message["id"],
                                "index": 0, "as_file": "yes"})
        self.assertFalse(refused["ok"])

    def test_the_limits_are_the_work_chats_and_say_so(self):
        pip = self.pip()
        for name, images in (
                ("a photo over 8 MB", [jpeg(size=8 * MB + 1)]),
                ("over 32 MB in all", [jpeg(size=7 * MB + i) for i in range(5)]),
                ("not what it says", [b"not a jpeg at all"]),
        ):
            with self.subTest(name):
                refused = self.send(pip, spooled_images=[{"name": self.spool(raw), "media_type": "image/jpeg"} for raw in images])
                self.assertFalse(refused["ok"])
                self.assertEqual(refused["error"]["code"], "invalid_images")
                self.assertEqual(self.spooled(), [], "a refused send leaves nothing in the spool")
        too_many = [{"name": self.spool(jpeg(size=100)), "media_type": "image/jpeg"} for _ in range(65)]
        refused = self.send(pip, spooled_images=too_many)
        self.assertFalse(refused["ok"])
        self.assertEqual(refused["error"]["message"], "Send up to 64 photos, 32 MB in all.")
        self.assertEqual(self.spooled(), [])
        self.assertEqual(pip_chat.list_messages(self.store, pip["id"])["messages"], [])

    def test_only_a_file_in_the_spool_by_its_bare_name(self):
        pip = self.pip()
        outside = self.base / "secret.jpg"
        outside.write_bytes(jpeg(size=100))
        for name in ("../secret.jpg", str(outside), "a/b.jpg", "..", ""):
            with self.subTest(name):
                refused = self.send(pip, spooled_images=[{"name": name, "media_type": "image/jpeg"}])
                self.assertFalse(refused["ok"])
        self.assertTrue(outside.exists(), "never read, never removed")
        for shape in ([{"name": self.spool(jpeg(size=100)), "media_type": "image/svg+xml"}],
                      [{"name": "x.jpg"}], "x.jpg", []):
            refused = self.send(pip, spooled_images=shape)
            self.assertFalse(refused["ok"])

    def test_only_this_computers_own_editor_names_spool_files(self):
        pip = self.pip()
        name = self.spool(jpeg(size=100))
        refused = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "hi", "idempotency_key": "k1",
                                "spooled_images": [{"name": name, "media_type": "image/jpeg"}]}, actor="device_phone")
        self.assertFalse(refused["ok"])
        self.assertEqual(refused["error"]["code"], "local_only")

    def test_an_iphone_photo_is_kept_as_a_jpeg(self):
        pip = self.pip()
        with patch.object(photos, "_tools", lambda heic: [("sips", convert_like_sips)]):
            sent = self.send(pip, spooled_images=[{"name": self.spool(heic(), ".heic"), "media_type": "image/heic"}])
        self.assertTrue(sent["ok"], sent.get("error"))
        self.assertEqual(sent["result"]["message"]["images"], [{"index": 0, "mime": "image/jpeg", "bytes": 3 * MB}])
        self.assertEqual(self.spooled(), [])

    def test_an_iphone_photo_this_computer_cannot_convert_says_what_to_do(self):
        pip = self.pip()
        with patch.object(photos, "_tools", lambda heic: []):
            refused = self.send(pip, spooled_images=[{"name": self.spool(heic(), ".heic"), "media_type": "image/heic"},
                                                     {"name": self.spool(jpeg(size=100)), "media_type": "image/jpeg"}])
        self.assertFalse(refused["ok"])
        self.assertEqual(refused["error"]["message"], photos.HEIC_MISSING, "one plain sentence, never a silent drop")
        self.assertEqual(self.spooled(), [])
        self.assertEqual(pip_chat.list_messages(self.store, pip["id"])["messages"], [])

    def test_the_model_is_sent_a_very_large_photo_at_2500_pixels_and_the_chat_keeps_the_original(self):
        from dgc.llm import LLMClient, ChatResult
        pip = self.pip()
        raw = jpeg(4032, 3024, size=5 * MB)
        run = pip_chat.send(self.store, pip["id"], "What is the claim reference?", "k1", "user", self.cfg,
                            spooled_images=[{"name": self.spool(raw), "media_type": "image/jpeg"}])["run"]
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        paths = [str(p) for p in pip_chat.image_paths(self.registry.directory, pip["id"], manifest["conversation"]["images"])]
        seen = []

        def chat(client, messages, tools=None, **kwargs):
            seen.append(messages)
            return ChatResult(content="CLM-7Q4-2291-K")

        def shrink(source, target, kind, side, quality):
            Path(target).write_bytes(jpeg(2500, 1875, size=600_000))
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")), \
                patch.object(photos, "_tools", lambda heic: [("sips", shrink)]):
            pips.execute_native(self.cfg, self.root, {**manifest, "conversation_image_paths": paths}, lambda e: None)
        user = [m for m in seen[0] if m["role"] == "user"][-1]
        [part] = [p for p in user["content"] if p.get("type") == "image_url"]
        shown = base64.b64decode(part["image_url"]["url"].split(",", 1)[1])
        self.assertEqual(parse_dimensions(shown), (2500, 1875))
        self.assertEqual(Path(paths[0]).read_bytes(), raw, "the chat's copy is the original")


class SpooledFileTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    pip = SpooledPhotoTests.pip
    control = SpooledPhotoTests.control
    spool = SpooledPhotoTests.spool
    spooled = SpooledPhotoTests.spooled
    send = SpooledPhotoTests.send

    def pdf(self, size):
        head, tail = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", b"\n%%EOF\n"
        return head + b"0" * (size - len(head) - len(tail)) + tail

    def test_a_bill_as_a_big_pdf_and_its_notes_go_with_a_message(self):
        pip = self.pip()
        pdf, notes = self.pdf(12 * MB), b"Claim CLM-7Q4-2291-K\n"
        sent = self.send(pip, spooled_files=[{"name": "hospital bill.pdf", "spool": self.spool(pdf, ".bin")},
                                             {"name": "notes.txt", "spool": self.spool(notes, ".bin")}])
        self.assertTrue(sent["ok"], sent.get("error"))
        self.assertEqual(sent["result"]["message"]["files"],
                         [{"index": 0, "name": "hospital bill.pdf", "bytes": len(pdf)}, {"index": 1, "name": "notes.txt", "bytes": len(notes)}])
        self.assertEqual(self.spooled(), [])
        [path, _] = pip_chat.file_paths(self.registry.directory, pip["id"], [
            {"name": "hospital bill.pdf", "sha256": __import__("hashlib").sha256(pdf).hexdigest(), "bytes": len(pdf)},
            {"name": "notes.txt", "sha256": __import__("hashlib").sha256(notes).hexdigest(), "bytes": len(notes)}])
        self.assertEqual(path.read_bytes(), pdf)

    def test_the_work_chats_document_limits(self):
        pip = self.pip()
        for name, files, says in (
                ("a document over 16 MB", [("big.pdf", self.pdf(16 * MB + 1))], "big.pdf is over 16 MB"),
                ("a text file over 1 MB", [("log.txt", b"x" * (MB + 1))], "log.txt is over 1 MB"),
                ("over 32 MB in all", [(f"part{i}.pdf", self.pdf(11 * MB)) for i in range(3)], "32 MB"),
                ("seventeen files", [(f"n{i}.txt", b"hi") for i in range(17)], "16 files"),
                ("a program", [("setup.exe", b"MZ")], "send text, code"),
        ):
            with self.subTest(name):
                refused = self.send(pip, spooled_files=[{"name": n, "spool": self.spool(raw, ".bin")} for n, raw in files])
                self.assertFalse(refused["ok"])
                self.assertIn(says, refused["error"]["message"])
                self.assertEqual(self.spooled(), [])
        self.assertEqual(pip_chat.list_messages(self.store, pip["id"])["messages"], [])

    def test_a_pip_with_a_computer_gets_a_big_file_in_its_files_too(self):
        from dgc.pip_computer import computer_root
        from dgc.pip_computer_files import files_root
        pip, pdf = self.pip(), self.pdf(5 * MB)
        kept = pip_chat.store_files(self.registry.directory, pip["id"],
                                    spooled=[{"name": "hospital bill.pdf", "spool": self.spool(pdf, ".bin")}])
        pip_chat._copy_to_computer(self.registry.directory, pip["id"], kept)
        landed = files_root(computer_root(self.registry.directory, pip["id"])) / "From chat" / "hospital bill.pdf"
        self.assertEqual(landed.read_bytes(), pdf, "over the 2 MB an editor adds, still in its Files")


class OlderRegistryTests(unittest.TestCase):
    """A registry made before API 52 holds the inline limits in its tables' CHECKs; it is widened once."""
    setUp = fixtures.LocalPipsTests.setUp
    pip = SpooledPhotoTests.pip
    spool = SpooledPhotoTests.spool
    send = SpooledPhotoTests.send
    control = SpooledPhotoTests.control

    OLD_IMAGES = """CREATE TABLE pip_chat_images (
 message_id TEXT NOT NULL REFERENCES pip_chat_messages(id),
 idx INTEGER NOT NULL CHECK(typeof(idx)='integer' AND idx BETWEEN 0 AND 3),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 mime TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 1 AND 2097152),
 PRIMARY KEY(message_id, idx)
)"""
    OLD_FILES = """CREATE TABLE pip_chat_files (
 message_id TEXT NOT NULL REFERENCES pip_chat_messages(id),
 idx INTEGER NOT NULL CHECK(typeof(idx)='integer' AND idx BETWEEN 0 AND 3),
 name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 255),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 1 AND 2097152),
 PRIMARY KEY(message_id, idx)
)"""

    def test_the_first_big_message_widens_the_tables_and_keeps_what_was_there(self):
        db = self.registry.db
        db.execute("DROP TABLE pip_chat_images")
        db.execute("DROP TABLE pip_chat_files")
        db.execute(self.OLD_IMAGES)
        db.execute(self.OLD_FILES)
        pip = self.pip()
        dot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        earlier = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "old", "idempotency_key": "k0",
                                "images": [dot]})
        self.assertTrue(earlier["ok"], earlier.get("error"))
        self.registry.db.execute("UPDATE pip_runs SET status='failed'")
        sent = self.send(pip, spooled_images=[{"name": self.spool(jpeg(size=3 * MB)), "media_type": "image/jpeg"} for _ in range(6)])
        self.assertTrue(sent["ok"], sent.get("error"))
        sql = db.execute("SELECT sql FROM sqlite_master WHERE name='pip_chat_images'").fetchone()[0]
        self.assertNotIn("2097152", sql)
        self.assertNotIn("2097152", db.execute("SELECT sql FROM sqlite_master WHERE name='pip_chat_files'").fetchone()[0])
        self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 46, "an older DGC still opens it")
        messages = pip_chat.list_messages(self.store, pip["id"])["messages"]
        self.assertEqual([len(m.get("images", [])) for m in messages], [1, 6])
        self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_a_new_registry_has_the_new_bounds_from_the_start(self):
        sql = self.registry.db.execute("SELECT sql FROM sqlite_master WHERE name='pip_chat_images'").fetchone()[0]
        self.assertIn(f"BETWEEN 1 AND {8 * MB}", sql)
        self.assertIn("BETWEEN 0 AND 63", sql)


class TransportTests(unittest.TestCase):
    def test_spooled_names_ride_in_the_small_request_and_inline_images_keep_their_own_bound(self):
        from dgc.headless import _bounded_pips_command
        request = {"type": "send_pip_message", "pip_id": "pip_" + "a" * 32, "text": "hi", "idempotency_key": "k",
                   "request_id": "r", "spooled_images": [{"name": f"{i:032x}.jpg", "media_type": "image/jpeg"} for i in range(64)],
                   "spooled_files": [{"name": f"bill {i}.pdf", "spool": f"{i:032x}.bin"} for i in range(16)]}
        bounded = _bounded_pips_command({"type": "pips_control", "request": request})
        self.assertEqual(len(bounded["request"]["spooled_images"]), 64)
        with self.assertRaises(RegistryError):
            _bounded_pips_command({"type": "pips_control", "request": {**request, "spooled_images": request["spooled_images"] * 2}})

    def test_the_runtime_says_api_52(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 52)
        self.assertLessEqual({"spooled_images", "spooled_files"}, pips._COMMAND_ARGS["send_pip_message"])
        self.assertIn("as_file", pips._COMMAND_ARGS["get_pip_message_image"])


class SDKGateTests(unittest.TestCase):
    """Both SDKs know the API 52 fields and refuse them before API 52, without a request."""

    def test_python_sdk_refuses_them_before_api_52_and_sends_them_from_it(self):
        from tests.test_dgc_sdk_pips import CAPS, Wire, session      # puts sdk/python on the path first
        from dgc_sdk import DGCConfigError, DGCUnsupportedError
        from dgc_sdk.pips import COMMAND_FIELDS
        self.assertEqual(COMMAND_FIELDS["send_pip_message"], pips._COMMAND_ARGS["send_pip_message"])
        self.assertEqual(COMMAND_FIELDS["get_pip_message_image"], pips._COMMAND_ARGS["get_pip_message_image"])
        message = {"pip_id": "pip_rook", "text": "", "idempotency_key": "k",
                   "spooled_images": [{"name": "a" * 32 + ".jpg", "media_type": "image/heic"}],
                   "spooled_files": [{"name": "bill.pdf", "spool": "b" * 32}]}
        wire = Wire()
        old = session(wire, caps={**CAPS, "pips_api_version": 51})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 52"):
            old.pips.mutate("send_pip_message", message, approved=True)
        with self.assertRaisesRegex(DGCUnsupportedError, "API 52"):
            old.pips.read("get_pip_message_image", {"pip_id": "pip_rook", "message_id": "m", "index": 0, "as_file": True})
        self.assertFalse(wire.calls)
        current = session(wire, caps={**CAPS, "pips_api_version": 52})
        for bad in ({"spooled_images": [{"name": "../x.jpg", "media_type": "image/jpeg"}]},
                    {"spooled_images": [{"name": "x.jpg", "media_type": "image/svg+xml"}]},
                    {"spooled_files": [{"name": "a/b.pdf", "spool": "x"}]}):
            with self.assertRaises(DGCConfigError):
                current.pips.mutate("send_pip_message", {**message, **bad}, approved=True)
        self.assertFalse(wire.calls)
        answer = current.pips.mutate("send_pip_message", message, approved=True)
        self.assertEqual(answer["request"]["spooled_images"], message["spooled_images"])
        self.assertEqual(answer["request"]["spooled_files"], message["spooled_files"])

    def test_python_sdk_spools_a_file_where_the_runtime_reads_it(self):
        import tempfile
        from tests.test_dgc_sdk_pips import CAPS, Wire, session
        from dgc_sdk import DGCUnsupportedError
        folder = tempfile.mkdtemp()
        current = session(Wire(), caps={**CAPS, "pips_api_version": 52, "image_spool": True, "image_spool_dir": folder})
        name = current.pips.spool(b"\xff\xd8\xff photo", suffix=".jpg")
        self.assertRegex(name, r"\A[0-9a-f]{32}\.jpg\Z")
        self.assertEqual((Path(folder) / name).read_bytes(), b"\xff\xd8\xff photo")
        self.assertEqual(oct((Path(folder) / name).stat().st_mode & 0o777), "0o600")
        old = session(Wire(), caps={**CAPS, "pips_api_version": 51, "image_spool": True, "image_spool_dir": folder})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 52"):
            old.pips.spool(b"x")


if __name__ == "__main__":
    unittest.main()
