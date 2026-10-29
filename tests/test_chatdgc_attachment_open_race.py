"""ChatDGC must read the file that was checked, within the attachment limit."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class AttachmentOpenRaceTests(unittest.TestCase):
    def test_replaced_file_is_refused(self):
        from dgc.chatdgc import attachments
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected = root / "selected.txt"
            replacement = root / "replacement.txt"
            selected.write_text("chosen", encoding="utf-8")
            replacement.write_text("other", encoding="utf-8")
            original_open = os.open

            def replace_before_open(path, flags):
                selected.rename(root / "old.txt")
                replacement.rename(selected)
                return original_open(path, flags)

            with patch.object(attachments.os, "open", side_effect=replace_before_open):
                with self.assertRaisesRegex(attachments.AttachmentError, "changed while opening"):
                    attachments.prepare([{"kind": "file", "path": str(selected)}])

    def test_normal_file_is_kept(self):
        from dgc.chatdgc import attachments
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "selected.txt"
            path.write_text("chosen", encoding="utf-8")
            self.assertEqual(attachments.prepare([{"kind": "file", "path": str(path)}])[0]["raw"],
                             b"chosen")


if __name__ == "__main__":
    unittest.main()
