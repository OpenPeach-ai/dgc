"""A queued follow-up must carry the paste, not the chip that stands in for it.

A long paste collapses to `[Pasted text #1 +40 lines]` in the composer. Enter expanded that back
to the pasted body before sending. Tab — which queues the message behind the running turn — did
not: `_route_followup` stores the string verbatim and the next turn submits it unchanged, so the
model received the placeholder and the pasted text was silently dropped.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

from dgc.tui import TUI                                   # noqa: E402

PASTE = "def broken():\n" + "\n".join(f"    step_{n}()" for n in range(40))


class TabQueuePasteTests(unittest.TestCase):
    def tui(self):
        t = object.__new__(TUI)
        t._pastes = {1: PASTE}
        return t

    def test_the_chip_expands_to_the_pasted_text(self):
        t = self.tui()
        out = t._expand_pastes("[Pasted text #1 +40 lines] please fix this")
        self.assertIn("def broken():", out)
        self.assertNotIn("[Pasted text #1", out)

    def test_the_tab_handler_expands_before_queueing(self):
        # Structural: the queue path stores the string verbatim, so the expansion has to happen
        # at the call, not later.
        from pathlib import Path
        source = (Path(__file__).resolve().parents[1] / "dgc" / "tui.py").read_text(encoding="utf-8")
        index = source.index("queue_only=True")
        call = source[max(0, index - 300):index + 60]
        self.assertIn("_expand_pastes", call,
                      "Tab queues the composer text; without expanding, the model gets the chip")

    def test_enter_still_expands(self):
        from pathlib import Path
        source = (Path(__file__).resolve().parents[1] / "dgc" / "tui.py").read_text(encoding="utf-8")
        self.assertIn("self._dispatch_composer_text(self._expand_pastes(text))", source)

    def test_text_without_a_chip_is_untouched(self):
        t = self.tui()
        self.assertEqual(t._expand_pastes("just a normal follow-up"), "just a normal follow-up")


if __name__ == "__main__":
    unittest.main()
