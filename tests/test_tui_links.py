"""Exercise actual Rich → prompt_toolkit conversion for assistant file/web links."""
import io
import os
import unittest
from unittest.mock import patch

from prompt_toolkit.formatted_text import ANSI, to_formatted_text
from rich.console import Console

from dgc import render
from dgc.tui import TUI, _tui_ansi


class TuiLinkTests(unittest.TestCase):
    def setUp(self):
        terminal = patch.dict(os.environ, {**os.environ, "TERM": "xterm-256color",
                                          "COLORTERM": "truecolor"})
        terminal.start()
        self.addCleanup(terminal.stop)
        os.environ.pop("NO_COLOR", None)

    def test_final_and_streaming_markdown_keeps_labels_without_control_payloads(self):
        tui = object.__new__(TUI)
        tui._width = 100
        for text in (
            "Fixed [clamp.py:3](clamp.py). All **3 tests pass**.",
            "See [docs](https://example.invalid/guide) and `code`.",
            "[file](clamp.py)\n\n```python\nreturn True",
        ):
            with self.subTest(text=text):
                value = tui._rich(tui._md(text))
                fragments = to_formatted_text(ANSI(value))
                plain = "".join(fragment[1] for fragment in fragments)
                self.assertNotIn("\x1b]", value)
                self.assertNotIn("8;id=", plain)
                self.assertNotIn("8;;", plain)
                self.assertIn("clamp.py:3" if text.startswith("Fixed") else
                              "docs" if text.startswith("See") else "file", plain)
                self.assertTrue(any(style for style, *_rest in fragments))

    def test_classic_links_remain_clickable_and_both_osc_terminators_are_supported(self):
        output = io.StringIO()
        console = Console(file=output, force_terminal=True, legacy_windows=False)
        console.print(render.render_markdown("[file](clamp.py)"))
        self.assertIn("\x1b]8;", output.getvalue())
        for terminator in ("\x1b\\", "\x07"):
            value = f"\x1b]8;id=123;clamp.py{terminator}file\x1b]8;;{terminator}"
            self.assertEqual(_tui_ansi(value), "file")


if __name__ == "__main__":
    unittest.main()
