"""`/artifacts` in the full-screen terminal lists everything in the store (not only page previews), opens one at an
address of its own, and asks before moving one to DGC's trash; `/artifacts open ID` (what the transcript's artifact
line suggests) opens it directly."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import dgc.artifacts as A
from dgc import artifact_service as S
from dgc.tui import TUI


class Screen:
    """The TUI's own methods on a bare object: the overlay, the flash line and the browser are recorded."""

    def __init__(self):
        self.tui = object.__new__(TUI)
        self.tui.config = SimpleNamespace(get=lambda key, default=None: default, set=lambda *a: None)
        self.overlays, self.flashes, self.opened = [], [], []
        self.tui._open_overlay = lambda rows, **kw: self.overlays.append((rows, kw))
        self.tui._flash = self.flashes.append
        self.tui._open_url = lambda url: self.opened.append(url) or True
        self.tui._invalidate = lambda *a, **k: None


class TuiArtifacts(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-tuiart-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp)
        self._state, A.STATE_FILE = A.STATE_FILE, self.tmp / "artifacts.json"
        self._srv, A._SRV = A._SRV, A._Server(persistent=False)
        self.deck = S.make("slides", "Q3 review", {"slides": [{"layout": "title", "title": "Q3"}]},
                           origin={"surface": "chat", "chat": "c"})
        self.screen = Screen()

    def tearDown(self):
        A._SRV.shutdown()
        A._SRV, A.STATE_FILE = self._srv, self._state
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def test_the_list_holds_the_store_and_a_pick_opens_it_at_its_own_address(self):
        self.screen.tui._open_artifacts()
        rows, kw = self.screen.overlays[-1]
        self.assertEqual(rows[0]["label"], "Q3 review")
        self.assertIn("Slides · v1 · from chat", rows[0]["desc"])
        kw["on_pick"](rows[0])
        self.assertTrue(self.screen.opened[-1].startswith("http://127.0.0.1:"), self.screen.opened)

    def test_open_by_id_and_a_bad_id_is_said(self):
        self.screen.tui._open_stored_artifact(self.deck["id"])
        self.assertEqual(len(self.screen.opened), 1)
        self.screen.tui._open_stored_artifact("ar_" + "0" * 16)
        self.assertTrue(self.screen.flashes[-1].startswith("couldn't open"))

    def test_removing_asks_first_and_moves_it_to_the_trash(self):
        self.screen.tui._open_artifacts()
        rows, kw = self.screen.overlays[-1]
        kw["on_action"]("x", rows[0])
        confirm_rows, confirm = self.screen.overlays[-1]
        self.assertEqual([r["value"] for r in confirm_rows], ["yes", "no"])
        self.assertEqual(len(S.listing()), 1, "nothing removed before the answer")
        confirm["on_pick"]({"value": "yes"})
        self.assertEqual(S.listing(), [])
        self.assertIn("trash", self.screen.flashes[-1])

    def test_make_sends_the_prompt_with_that_output_and_a_bad_kind_shows_the_usage(self):
        sent = []
        self.screen.tui._submit = lambda text, **kw: sent.append((text, kw.get("output")))
        self.screen.tui.input_buf = None
        self.screen.tui._handle_slash("/make slides Our Q3 in five slides")
        self.assertEqual(sent, [("Our Q3 in five slides", "slides")])
        self.screen.tui._handle_slash("/make poster Something")
        self.assertEqual(len(sent), 1)
        self.assertIn("/make document|slides|spreadsheet|page|dashboard", self.screen.flashes[-1])


if __name__ == "__main__":
    unittest.main()
