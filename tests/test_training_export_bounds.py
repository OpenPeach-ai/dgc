"""Training export only loads bounded regular session transcripts."""

import tempfile
import unittest
from pathlib import Path


class TrainingExportBoundsTests(unittest.TestCase):
    def test_large_or_linked_session_is_skipped(self):
        from dgc import training_export
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            small = root / "small.json"
            small.write_text('{"messages": [{"role": "user", "content": "hi"}]}', encoding="utf-8")
            self.assertEqual(len(training_export._load_session_file(small)["messages"]), 1)
            large = root / "large.json"
            with large.open("wb") as target:
                target.truncate(training_export.MAX_TRAINING_SESSION_BYTES + 1)
            self.assertIsNone(training_export._load_session_file(large))
            linked = root / "linked.json"
            linked.symlink_to(small)
            self.assertIsNone(training_export._load_session_file(linked))


if __name__ == "__main__":
    unittest.main()
