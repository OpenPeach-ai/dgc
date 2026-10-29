"""Displayed Mod metadata cannot carry terminal or bidirectional controls."""
import tempfile
import unittest
from pathlib import Path

from dgc.mods.manifest import ManifestError, parse


class ModManifestTextTests(unittest.TestCase):
    def test_visible_metadata_rejects_controls(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "main.py").write_text("pass\n")
            base = {"name": "sample", "version": "1.0.0", "entry": "main.py"}
            for changed in (
                {"title": "Sample\x1b[2J"},
                {"description": "first\nsecond"},
                {"title": "Sample\u202e"},
                {"capabilities": {"commands": [{"name": "hello", "description": "go\rback"}]}},
            ):
                with self.subTest(changed=changed), self.assertRaises(ManifestError):
                    parse({**base, **changed}, root)


if __name__ == "__main__":
    unittest.main()
