"""Attachments raised for everyone (Limits for everyone, agreed 10 Nov): 20 images at up to 20 MB each, 50 files, a
document up to 100 MB, 200 MB in one message, in Work, ChatDGC and a Pip's chat (they were 8 MB an image, 16 files, a
16 MB document, 32 MB in all; ChatDGC 10 attachments, 25 MB a file). A model is still sent what its provider takes:
a big photo is shrunk to about 4.5 MB, and a message's photos together to about 24 MB."""
from __future__ import annotations

import base64
import io
import sqlite3
import unittest

from tests import test_pips_local as fixtures
from tests import test_pip_conversations as conv

MB = 1024 * 1024


class Numbers(unittest.TestCase):
    def test_work_chatdgc_and_pips_take_the_raised_numbers(self):
        from dgc import attachments, pip_chat
        from dgc.chatdgc import attachments as chat_attachments
        self.assertEqual(attachments.MAX_ATTACHMENT_MENTIONS, 50)
        self.assertEqual(attachments.MAX_DOCUMENT_FILE_BYTES, 100 * MB)
        self.assertEqual(attachments.MAX_DOCUMENT_TOTAL_BYTES, 200 * MB)
        self.assertEqual(attachments.MAX_SPOOLED_IMAGE_FILE_BYTES, 20 * MB)
        self.assertEqual(attachments.MAX_SPOOLED_IMAGE_TOTAL_BYTES, 200 * MB)
        self.assertEqual(attachments.MAX_IMAGE_FILES, 20)
        self.assertEqual(chat_attachments.MAX_ATTACHMENTS, 50)
        self.assertEqual(chat_attachments.MAX_FILE_BYTES, 100 * MB)
        self.assertEqual(chat_attachments.MAX_IMAGE_BYTES, 20 * MB)
        self.assertEqual(pip_chat.MAX_CHAT_FILES, 50)
        self.assertEqual(pip_chat.MAX_CHAT_DOCUMENT_BYTES, 100 * MB)
        self.assertEqual(pip_chat.MAX_CHAT_IMAGE_BYTES, 20 * MB)
        self.assertEqual(pip_chat.MAX_MESSAGE_ATTACHMENT_BYTES, 200 * MB)

    def test_the_editor_is_told_the_limits(self):
        from dgc import headless
        limits = headless.attachment_limits()
        self.assertEqual(limits, {"images_bytes": 200 * MB, "image_bytes": 20 * MB, "files": 50,
                                  "document_bytes": 100 * MB, "files_bytes": 200 * MB})


class PipFiles(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def test_thirty_files_on_one_message_and_an_older_registry_keeps_its_rows(self):
        from dgc import pip_chat
        job = conv.Conversations.job(self)
        message = pip_chat.send(self.store, job["id"], "Here they are", "k1", "user", self.cfg)["message"]["id"]
        db = self.registry.db
        # A registry from before: the files table's CHECK took 16 files of up to 16 MiB.
        old = pip_chat.FILES_SCHEMA.replace(f"AND {pip_chat.MAX_CHAT_FILES - 1})", "AND 15)").replace(
            f"AND {pip_chat.MAX_CHAT_DOCUMENT_BYTES})", f"AND {16 * MB})")
        with self.registry.transaction():
            db.execute("DROP TABLE IF EXISTS pip_chat_files")
            db.execute(old.strip().rstrip(";"))
        with self.registry.transaction():
            db.execute("INSERT INTO pip_chat_files(message_id,idx,name,sha256,bytes) VALUES(?,?,?,?,?)",
                       (message, 3, "kept.pdf", "b" * 64, 1000))
        with self.registry.transaction():
            pip_chat.widen_tables(db)
        self.assertEqual(db.execute("SELECT name FROM pip_chat_files").fetchall()[0][0], "kept.pdf", "every row kept")
        with self.registry.transaction():
            db.execute("INSERT INTO pip_chat_files(message_id,idx,name,sha256,bytes) VALUES(?,?,?,?,?)",
                       (message, 29, "thirtieth.pdf", "c" * 64, 90 * MB))
        self.assertEqual(db.execute("SELECT count(*) FROM pip_chat_files").fetchone()[0], 2)
        files = [{"name": f"f{n}.pdf", "sha256": f"{n:064x}", "bytes": 3 * MB} for n in range(30)]
        self.assertEqual(len(pip_chat.validate_files(files)), 30)


def _png(width, height, noisy=True):
    """A real PNG of the given size, noisy so it doesn't compress (what a photo screenshot is like)."""
    import os
    import struct
    import zlib
    rows = b"".join(b"\x00" + (os.urandom(width * 3) if noisy else b"\x80" * width * 3) for _ in range(height))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 1)) + chunk(b"IEND", b""))


class ForTheModel(unittest.TestCase):
    def setUp(self):
        from dgc import photos
        if not photos.converters()["shrink"]:
            self.skipTest("no image converter on this computer")

    def uri(self, raw):
        return "data:image/png;base64," + base64.b64encode(raw).decode()

    def size(self, uri):
        return len(base64.b64decode(uri.split(",", 1)[1]))

    def test_a_big_photo_within_its_pixels_is_still_made_small_enough_for_a_provider(self):
        from dgc import photos
        raw = _png(2000, 1500)                                   # ~9 MB: under 2,500 px, over what a provider takes
        self.assertGreater(len(raw), 6 * MB)
        sent = photos.for_model(self.uri(raw))
        self.assertLessEqual(self.size(sent), photos.MODEL_IMAGE_BYTES)

    def test_a_messages_photos_together_fit_one_request(self):
        from unittest.mock import patch
        from dgc import photos
        raws = [_png(1200, 900) for _ in range(8)]                 # ~3 MB each, 26 MB together
        with patch.object(photos, "MODEL_IMAGES_BYTES", 4 * MB):   # the request's budget, made small enough to bite here
            sent = photos.for_model_all([self.uri(r) for r in raws])
        self.assertEqual(len(sent), 8)
        self.assertLessEqual(sum(self.size(u) for u in sent), 4 * MB)

    def test_a_small_picture_goes_as_it_is(self):
        from dgc import photos
        uri = self.uri(_png(64, 64, noisy=False))
        self.assertEqual(photos.for_model(uri), uri)
        self.assertEqual(photos.for_model_all([uri, uri]), [uri, uri])


if __name__ == "__main__":
    unittest.main()
