"""Session display projections tolerate malformed private transcript sidecars."""
import unittest
import tempfile
from pathlib import Path
from unittest import mock

from dgc import sessions


class SessionDisplayBoundsTests(unittest.TestCase):
    def test_malformed_content_parts_and_tool_calls_do_not_break_export_projection(self):
        rows = sessions.display_rows([
            {"role": "assistant", "content": [{"type": "text", "text": {"bad": 1}},
                                                {"type": "text", "text": "answer"}],
             "tool_calls": [{"function": 4}, {"function": {"name": "bash"}}]},
        ])
        self.assertEqual(rows, [{"who": "assistant", "body": "answer", "tools": "bash"}])

    def test_malformed_recall_summary_is_empty(self):
        with tempfile.TemporaryDirectory() as folder:
            with mock.patch.object(sessions, "recall_path", return_value=Path(folder) / "example.recall"):
                with mock.patch.object(sessions, "_recall_header", return_value={"rows": "invalid", "dropped": 0}):
                    with mock.patch.object(sessions, "_read_recall_lines", return_value=["header"]):
                        self.assertEqual(sessions.recall_summary("example.json", folder), {})
        self.assertEqual(sessions._recall_cap(float("inf")), sessions._DEFAULT_RECALL_BYTES)


if __name__ == "__main__":
    unittest.main()
