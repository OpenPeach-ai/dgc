"""Corrupted per-mod state must not stop the bundled Tally panel."""
import runpy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc.mods.py import dgc_mod


class ModTallyStateTests(unittest.TestCase):
    def test_bad_saved_counts_do_not_break_status_or_panel(self):
        source = Path(__file__).resolve().parents[1] / "dgc/mods/builtin/tally/main.py"
        original_stdout = sys.stdout
        try:
            with patch.dict(sys.modules, {"dgc_mod": dgc_mod}), patch.object(dgc_mod.Mod, "run"):
                loaded = runpy.run_path(str(source))
        finally:
            sys.stdout = original_stdout
        loaded["mod"].state_get = lambda key, default: {"bash": "not-a-number", "edit": -4, "read": 3,
                                                           "bad\nname": 5} if key == "counts" else ["bad"]
        status = loaded["draw_status"]()
        pane = loaded["draw_pane"]()
        self.assertEqual(status["text"], "3 steps")
        self.assertEqual(pane["children"][0]["rows"], [["read", 3, 0]])


if __name__ == "__main__":
    unittest.main()
