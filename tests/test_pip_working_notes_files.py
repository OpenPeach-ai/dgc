"""Untrusted saved working-note files stay bounded and cannot redirect the reader."""
import tempfile
import unittest
import os
from pathlib import Path


class WorkingNoteFileTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "posix", "POSIX no-follow file descriptors")
    def test_oversized_and_linked_notes_are_not_read(self):
        from dgc import pip_working_notes as notes

        pip_id = "pip_" + "a" * 32
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "working-notes"
            folder.mkdir()
            saved = folder / f"{pip_id}.md"
            saved.write_bytes(b"x" * (notes.MAX_STORED_BYTES + 1))
            self.assertEqual(notes.read(root, pip_id), [])

            outside = Path(root) / "outside.md"
            outside.write_text("- secret from elsewhere\n")
            saved.unlink()
            saved.symlink_to(outside)
            self.assertEqual(notes.read(root, pip_id), [])
            self.assertNotIn("secret", notes.view(root, pip_id)["text"])

    @unittest.skipUnless(os.name == "posix", "POSIX no-follow lock descriptors")
    def test_linked_lock_does_not_write_elsewhere(self):
        from dgc import pip_working_notes as notes

        pip_id = "pip_" + "a" * 32
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "working-notes"
            folder.mkdir()
            outside = Path(root) / "outside.lock"
            outside.write_text("untouched")
            (folder / f"{pip_id}.lock").symlink_to(outside)
            with self.assertRaises(OSError):
                notes.set_text(root, pip_id, "a note", notes.revision([]), "editor-user")
            self.assertEqual(outside.read_text(), "untouched")
