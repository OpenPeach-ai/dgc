"""Historical chat similarity never reads an oversized or redirected session file."""
import json
import tempfile
import unittest
from pathlib import Path

from dgc.pip_repeat import _first_prompt, MAX_BYTES


class PipRepeatBoundsTests(unittest.TestCase):
    def test_direct_reader_rejects_oversized_session(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "session.json"
            path.write_text(json.dumps({"messages": [{"role": "user", "content": "a normal request"}],
                                        "padding": "x" * MAX_BYTES}))
            self.assertIsNone(_first_prompt(path))

    def test_direct_reader_rejects_symlink_session(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            outside = root / "outside.json"
            outside.write_text('{"messages":[{"role":"user","content":"private prompt"}]}')
            link = root / "session.json"
            link.symlink_to(outside)
            self.assertIsNone(_first_prompt(link))

    def test_malformed_content_parts_do_not_break_similarity_check(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "session.json"
            path.write_text(json.dumps({"messages": [{"role": "user", "content":
                                                       [{"text": 123}, {"text": "real prompt"}]}]}))
            self.assertEqual(_first_prompt(path), "real prompt")


if __name__ == "__main__":
    unittest.main()
