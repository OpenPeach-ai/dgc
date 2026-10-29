"""A Pip fix's copied ignored file stays inside its worktree."""

import tempfile
import unittest
from pathlib import Path

from dgc.pip_fix import copy_project_file


class PipFixCopyBoundaryTests(unittest.TestCase):
    def test_symlinked_destination_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "secret.env"
            source.write_text("secret")
            copy = root / "copy"
            copy.mkdir()
            outside = root / "outside"
            outside.mkdir()
            (copy / "config").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(OSError, "escapes through a symlink"):
                copy_project_file(source, copy, "config/secret.env")
            self.assertFalse((outside / "secret.env").exists())
