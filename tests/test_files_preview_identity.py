"""A file preview keeps its bounded regular-file and no-link contract."""

import tempfile
import unittest
from pathlib import Path

from dgc.files.preview import PREVIEW_BYTES, read_head


class FilePreviewIdentityTests(unittest.TestCase):
    def test_regular_head_and_link_refusal(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "large.txt"
            path.write_bytes(b"a" * (PREVIEW_BYTES + 20))
            self.assertEqual(read_head(path), (b"a" * PREVIEW_BYTES, PREVIEW_BYTES + 20))
            link = Path(temp) / "link.txt"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                read_head(link)
            with self.assertRaises(ValueError):
                read_head(path, PREVIEW_BYTES + 1)


if __name__ == "__main__":
    unittest.main()
