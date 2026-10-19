"""iPhone photos (HEIC/HEIF) in the Work chat: pasted (spooled), dragged in or @-mentioned, each is sent
to the model as a JPEG, and a computer that can't convert one says what to do in one sentence.
"""
from __future__ import annotations

import base64
import os
import pwd
import struct
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_work_chat_heic.py needs HOME redirected before dgc is imported")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-heic-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc import photos  # noqa: E402
from dgc.attachments import editor_image_mentions, expand_attachments, read_spooled_images  # noqa: E402
from dgc.config import Config  # noqa: E402

HEIC = (struct.pack(">I", 24) + b"ftypheic\0\0\0\0mif1heic" + struct.pack(">I", 32) + b"meta\0\0\0\0"
        + struct.pack(">I", 20) + b"ispe\0\0\0\0" + struct.pack(">II", 4032, 3024) + struct.pack(">I", 16) + b"mdat" + b"\0" * 8)
JPEG = b"\xff\xd8\xff\xe0" + b"\0" * 60 + b"\xff\xd9"


def converter(source, target, kind, side, quality):
    Path(target).write_bytes(b"\xff\xd8\xff\xc0\x00\x11\x08" + struct.pack(">HH", 3024, 4032) + b"\x03" + b"\0" * 9 + b"\xff\xd9")


class WorkChatHeicTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="dgc-heic-")
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        (self.root / "IMG_4417.HEIC").write_bytes(HEIC)

    def with_converter(self):
        return patch.object(photos, "_tools", lambda heic: [("sips", converter)])

    def without_converter(self):
        return patch.object(photos, "_tools", lambda heic: [])

    def test_a_pasted_iphone_photo_reaches_the_model_as_a_jpeg(self):
        (self.root / "a.heic").write_bytes(HEIC)
        with self.with_converter():
            [image] = read_spooled_images([{"name": "a.heic", "media_type": "image/heic"}], self.root)
        self.assertTrue(image.startswith("data:image/jpeg;base64,"))
        self.assertTrue(base64.b64decode(image.split(",", 1)[1]).startswith(b"\xff\xd8\xff"))
        self.assertFalse((self.root / "a.heic").exists())

    def test_a_file_that_only_says_it_is_heic_is_refused(self):
        (self.root / "b.heic").write_bytes(JPEG)
        with self.with_converter(), self.assertRaisesRegex(ValueError, "media type does not match"):
            read_spooled_images([{"name": "b.heic", "media_type": "image/heic"}], self.root)

    def test_a_dragged_in_iphone_photo_is_attached_as_a_jpeg(self):
        mention = {"type": "file_mention", "path": str(self.root / "IMG_4417.HEIC"), "relative_path": "IMG_4417.HEIC"}
        with self.with_converter():
            result = editor_image_mentions([mention], self.root)
        self.assertEqual(len(result.images), 1)
        self.assertTrue(result.images[0].startswith("data:image/jpeg;base64,"))
        with self.without_converter():
            result = editor_image_mentions([mention], self.root)
        self.assertEqual(result.images, ())
        self.assertEqual(result.notices, (f"attachment skipped (IMG_4417.HEIC): {photos.HEIC_MISSING}",))

    def test_the_terminals_at_mention_takes_an_iphone_photo_too(self):
        with self.with_converter():
            result = expand_attachments("What is on this? @IMG_4417.HEIC", self.root)
        self.assertEqual(len(result.images), 1)
        self.assertTrue(result.images[0].startswith("data:image/jpeg;base64,"))

    def backend(self):
        from dgc.headless import Backend, PendingRequests
        cfg = Config()
        cfg.project_root = self.root
        cfg.data.update({"model": "fixture", "base_url": "http://fixture", "subscription_engine": ""})
        events, started = [], []
        backend = object.__new__(Backend)
        backend.config = cfg
        backend.agent = types.SimpleNamespace(config=cfg, monitors=None, cancelled=threading.Event())
        backend.em = types.SimpleNamespace(emit=lambda t, **d: events.append({"type": t, **d}))
        backend.pending = PendingRequests()
        backend._queue, backend._worker, backend._foreground_worker = [], None, None
        backend._turn_state_lock = lambda: threading.RLock()
        backend._busy = lambda: False
        backend._suppress_wakes = lambda on: None
        backend._image_spool = lambda: self.root
        backend._start_turn = lambda text, images=None, context=None, **kwargs: started.append(images) or ("started", 0)
        return backend, events, started

    def test_the_work_chat_takes_a_pasted_iphone_photo_and_says_one_sentence_when_it_cannot(self):
        backend, events, started = self.backend()
        (self.root / "c.heic").write_bytes(HEIC)
        with self.with_converter():
            backend.dispatch({"type": "prompt", "text": "Read the bill", "request_id": "p1",
                              "spooled_images": [{"name": "c.heic", "media_type": "image/heic"}]})
        self.assertEqual(len(started), 1, events)
        self.assertTrue(started[0][0].startswith("data:image/jpeg;base64,"))
        (self.root / "d.heic").write_bytes(HEIC)
        with self.without_converter():
            backend.dispatch({"type": "prompt", "text": "Read the bill", "request_id": "p2",
                              "spooled_images": [{"name": "d.heic", "media_type": "image/heic"}]})
        [rejected] = [e for e in events if e["type"] == "command_rejected"]
        self.assertEqual(rejected["message"], photos.HEIC_MISSING)
        self.assertEqual(len(started), 1)

    def test_the_ready_capabilities_say_heic_is_taken(self):
        import inspect
        from dgc import headless
        self.assertIn('"heic_images": True', inspect.getsource(headless.Backend._ready_payload))


if __name__ == "__main__":
    unittest.main()
