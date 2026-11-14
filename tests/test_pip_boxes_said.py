"""Whether this machine gives Pips their own computer, said to the editor (0.52; pips-sandbox-design §6, the Mac dialog).

"Once, only on a Mac whose Pips can't have a box: Pips' own computers need a Mac with Apple silicon on macOS 26..."
The editor shows that dialog from get_pip_runner's `boxes` {available, why}; the backend never decides to show it.
"""
import unittest
from unittest.mock import patch

from tests import test_pips_local as fixtures
from dgc import pips


class BoxesSaid(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def runner(self):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            answer = pips.handle_control(self.cfg, {"type": "get_pip_runner", "request_id": "r"}, "editor-user", start_worker=False)
        self.assertTrue(answer["ok"], answer)
        return answer["result"]["runner"]

    def test_a_machine_that_runs_boxes_says_so(self):
        with patch("dgc.pip_screen_setup.supported", return_value=(True, "")):
            self.assertEqual(self.runner()["boxes"], {"available": True, "why": ""})

    def test_one_that_cant_says_why(self):
        why = "Pips' own computers need a Mac with Apple silicon on macOS 26."
        with patch("dgc.pip_screen_setup.supported", return_value=(False, why)):
            self.assertEqual(self.runner()["boxes"], {"available": False, "why": why})


if __name__ == "__main__":
    unittest.main()
