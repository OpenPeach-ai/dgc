"""Pips say plainly where they run: nothing offers them on a platform that cannot run them."""
import contextlib
import io
import unittest
from unittest.mock import patch

from dgc import pip_access, pip_cli


class PlatformTests(unittest.TestCase):
    def test_windows_gets_no_chat_tools_and_a_plain_cli_answer(self):
        config = type("C", (), {"get": lambda self, key, default=None: True if key == "pips_enabled" else default})()
        with patch.object(pip_access, "restricted", return_value=False):
            self.assertTrue(pip_access.tools_available(config) or not pip_access.PLATFORM_SUPPORTED)
            with patch.object(pip_access, "PLATFORM_SUPPORTED", False):
                self.assertFalse(pip_access.tools_available(config), "no Pips tools in the main chat")
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    self.assertEqual(pip_cli.handle_command(config, ["list"]), 2)
                self.assertIn("On Windows, Pips run in DGC inside WSL", err.getvalue())

    def test_the_editor_is_told_whether_this_platform_runs_pips(self):
        from dgc import headless
        self.assertIs(headless._pips_platform_supported(), pip_access.PLATFORM_SUPPORTED)
        with patch.object(pip_access, "PLATFORM_SUPPORTED", False):
            self.assertIs(headless._pips_platform_supported(), False)


if __name__ == "__main__":
    unittest.main()
