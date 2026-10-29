"""Timed-out and failed host requests must not accumulate pending SDK state."""
import unittest
from unittest.mock import patch

from dgc.mods.py.dgc_mod import Mod, ModError


class ModCallCleanupTests(unittest.TestCase):
    def test_timeout_removes_pending_request(self):
        with patch("sys.stdout"):
            mod = Mod()
        mod._send = lambda message: None
        for _ in range(3):
            with self.assertRaises(ModError):
                mod.call("no.reply", timeout=.001)
            self.assertEqual(mod._pending, {})

    def test_write_failure_removes_pending_request(self):
        with patch("sys.stdout"):
            mod = Mod()
        def fail(message):
            raise OSError("pipe closed")
        mod._send = fail
        with self.assertRaises(OSError):
            mod.call("no.pipe")
        self.assertEqual(mod._pending, {})


if __name__ == "__main__":
    unittest.main()
