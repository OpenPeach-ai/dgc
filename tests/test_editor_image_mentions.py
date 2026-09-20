"""An image the editor attaches by @-mention, drag or Add File to Chat reaches the model as pixels.

The editor sends a file attachment as a typed ``file_mention`` resource: a path. That is enough for a
text file, which the model can read, but a model cannot see an image through its path. The TUI's
``@file.png`` attaches the pixels; the editor's mention sent only the path, with no warning, and a
vision model answered from nothing (or described an earlier pasted image instead).
"""
from __future__ import annotations

import base64
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path


def _real_account_home() -> str:
    """The real account's home, never the one this suite redirected.

    Windows has no passwd database, and expanduser("~") reads the USERPROFILE the suite
    redirects, which would make a correctly isolated run look like a contaminating one.
    HOMEDRIVE/HOMEPATH are set by the OS at logon and nothing here rewrites them.
    """
    try:
        import pwd
        return pwd.getpwuid(os.getuid()).pw_dir
    except (ImportError, KeyError, AttributeError):
        drive, tail = os.environ.get("HOMEDRIVE", ""), os.environ.get("HOMEPATH", "")
        return (drive + tail) if drive and tail else os.path.expanduser("~")


_REAL_HOME = _real_account_home()
if "dgc.config" in sys.modules:                    # imported by another module first: verify, never assume
    import dgc.config as _config
    # Equality, not "is under": on Windows the isolated temporary home lives inside the
    # account's own profile (%TEMP% is under %USERPROFILE%), so "under the account home"
    # describes every correctly isolated run there.
    if Path(_config.USER_HOME) in (Path(_REAL_HOME), Path(_REAL_HOME) / ".dgc"):
        raise RuntimeError("tests/test_editor_image_mentions.py needs HOME redirected before dgc is "
                           "imported — run it through tests/run_tests.py or with HOME=<tmp>")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-image-mention-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc.attachments import MAX_EDITOR_IMAGE_TOTAL_BYTES, editor_image_mentions  # noqa: E402
from dgc.config import Config                                                    # noqa: E402

# A 1x1 PNG.
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


class EditorImageMentionTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-image-mention-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "shot.png").write_bytes(PNG)
        (self.root / "notes.txt").write_text("plain text")
        (self.root / "fake.png").write_text("not really a png")

    def mention(self, name):
        return {"type": "file_mention", "uri": f"file://{self.root / name}", "path": str(self.root / name),
                "relative_path": name, "workspace": "w"}

    def test_an_image_mention_becomes_an_image_and_a_text_mention_stays_a_path(self):
        result = editor_image_mentions([self.mention("shot.png"), self.mention("notes.txt")], self.root)
        self.assertEqual(result.images, ("data:image/png;base64," + base64.b64encode(PNG).decode(),))
        self.assertEqual(result.notices, ("attached 1 image",))

    def test_an_image_that_cannot_be_attached_says_why_instead_of_going_silent(self):
        big = self.root / "big.png"
        big.write_bytes(PNG + b"\0" * MAX_EDITOR_IMAGE_TOTAL_BYTES)
        result = editor_image_mentions([self.mention("big.png"), self.mention("fake.png"),
                                        self.mention("gone.png")], self.root)
        self.assertEqual(result.images, ())
        self.assertEqual(result.notices, (
            "attachment skipped (big.png): the editor's images are limited to 2 MiB in total",
            "attachment skipped (fake.png): extension does not match image data",
            "attachment skipped (gone.png): file not found"))

    def test_pasted_images_count_toward_the_same_limits(self):
        pasted = ["data:image/png;base64," + base64.b64encode(PNG).decode()] * 4
        result = editor_image_mentions([self.mention("shot.png")], self.root, pasted)
        self.assertEqual(result.images, ())
        self.assertEqual(result.notices, ("attachment skipped (shot.png): image count limit reached",))

    def backend(self, engine=""):
        from dgc.headless import Backend, PendingRequests
        cfg = Config()
        cfg.project_root = self.root
        cfg.data.update({"model": "fixture", "base_url": "http://fixture", "subscription_engine": engine})
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

        def start(text, images=None, context=None, **kwargs):
            started.append((text, images, context))
            return "started", 0
        backend._start_turn = start
        return backend, events, started

    def test_a_prompt_with_an_image_mention_carries_the_pixels_into_the_turn(self):
        backend, events, started = self.backend()
        backend.dispatch({"type": "prompt", "text": "What big text is in the attached image?",
                          "request_id": "web-1", "context": [self.mention("shot.png")]})
        self.assertEqual(len(started), 1, events)
        text, images, context = started[0]
        self.assertEqual(len(images), 1)
        self.assertTrue(images[0].startswith("data:image/png;base64,"))
        self.assertEqual(context[0]["path"], str(self.root / "shot.png"), "the path still travels with it")
        self.assertIn({"type": "info", "message": "attached 1 image"}, events)

    def test_a_subscription_turn_keeps_the_path_for_its_own_cli(self):
        backend, events, started = self.backend(engine="claude")
        backend.dispatch({"type": "prompt", "text": "look", "request_id": "web-2",
                          "context": [self.mention("shot.png")]})
        self.assertEqual(started[0][1], (), "no DGC image attachment, which delegation cannot carry")

    def test_a_goal_started_with_an_image_mention_keeps_the_pixels_with_the_goal(self):
        backend, events, started = self.backend()
        kept = []
        backend.agent.set_goal = lambda text, **kwargs: kept.append(kwargs["inputs"]) or True
        backend.dispatch({"type": "start_goal", "text": "Match the mockup", "request_id": "goal-1",
                          "context": [self.mention("shot.png")]})
        self.assertEqual(len(kept), 1, events)
        self.assertEqual(len(kept[0]["images"]), 1)
        self.assertTrue(kept[0]["images"][0].startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()
