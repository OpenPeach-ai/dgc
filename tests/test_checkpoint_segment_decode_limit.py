import unittest
from unittest.mock import patch

from dgc import checkpoints


class SegmentDecodeLimitTests(unittest.TestCase):
    def test_saved_segment_checks_encoded_size_before_decoding(self):
        manager = checkpoints.CheckpointManager()
        value = {"kind": "file", "mode": 0o644, "data": "A" * 100, "sha256": "0" * 64}
        with patch.object(checkpoints, "_MAX_SNAPSHOT_BYTES", 16), \
             patch.object(checkpoints.base64, "b64decode") as decode:
            self.assertIsNone(manager._load_snapshot("file.txt", value))
        decode.assert_not_called()
