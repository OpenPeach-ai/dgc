"""Ctrl+C in `dgc setup` ends it with a sentence and exit status 130, never a Python traceback."""
import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from dgc import cli


class SetupCancelTests(unittest.TestCase):
    def test_ctrl_c_in_setup_says_cancelled_and_exits_130(self):
        err = io.StringIO()
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {"HOME": home}), \
                patch.object(cli, "run_setup", side_effect=KeyboardInterrupt), redirect_stderr(err):
            with self.assertRaises(SystemExit) as stopped:
                cli.main(["setup"])
        self.assertEqual(stopped.exception.code, 130)
        self.assertIn("Setup cancelled", err.getvalue())
        self.assertNotIn("Traceback", err.getvalue())


if __name__ == "__main__":
    unittest.main()
