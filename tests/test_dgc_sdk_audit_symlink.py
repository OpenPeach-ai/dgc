"""Audit exports and appends must stay inside the SDK's private state directory."""
from __future__ import annotations

import tempfile
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sdk" / "python"))
from dgc_sdk.audit import AuditLog


class AuditSymlinkTests(unittest.TestCase):
    def test_planted_log_link_is_neither_read_nor_appended(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outside = root / "outside.jsonl"
            original = '{"secret":"outside"}\n'
            outside.write_text(original, encoding="utf-8")
            log = AuditLog(root / "audit")
            log.path_for("one").symlink_to(outside)
            self.assertEqual(log.export("one"), [])
            with self.assertRaises(OSError):
                log.append("one", "run", "test", {"value": "x"})
            self.assertEqual(outside.read_text(encoding="utf-8"), original)
