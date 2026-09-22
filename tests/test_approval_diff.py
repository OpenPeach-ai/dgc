"""The terminal must show WHAT an edit does before asking whether to allow it.

The editor's approval card has always carried the unified diff, built by `ui.edit_preview`. Both
terminals asked blind: the card was the tool name plus one truncated argument, so a `write_file`
that replaces a 3,000-line file looked exactly like a one-character fix. This is the parity gap
against Claude Code and Codex, which both show the diff at the prompt.
"""
from __future__ import annotations

import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

from dgc import cli as cli_mod                            # noqa: E402
from dgc import ui as ui_mod                              # noqa: E402

ORIGINAL = "\n".join(f"line {n}" for n in range(1, 41)) + "\n"
REPLACEMENT = "print('gone')\n"


class ClassicCliApprovalTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory(prefix="dgc-approval-")
        self.root = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)
        self.target = self.root / "app.py"
        self.target.write_text(ORIGINAL, encoding="utf-8")

    def _approve(self, name: str, args: dict) -> str:
        """Drive the real approval prompt, capturing everything it prints."""
        ui = cli_mod.UI()
        ui.project_root = self.root
        printed: list[str] = []
        def text_of(x):
            # rich renderables carry their content on different attributes: Text.plain,
            # Syntax.code. Stringifying instead would capture "<rich.syntax.Syntax object …>".
            return getattr(x, "plain", None) or getattr(x, "code", None) or str(x)
        ui.console = type("C", (), {
            "print": lambda _self, *a, **k: printed.append(" ".join(text_of(x) for x in a)),
        })()
        ui._yield_stdin = lambda: None
        with patch.object(cli_mod, "menu_select", lambda *a, **k: 0), \
                patch.object(cli_mod, "section", lambda *a, **k: None):
            ui.approve(name, args)
        return "\n".join(printed)

    def test_a_whole_file_rewrite_shows_what_it_removes(self):
        shown = self._approve("write_file", {"path": str(self.target), "content": REPLACEMENT})
        self.assertIn("line 1", shown, "the prompt never showed the lines being destroyed")
        self.assertIn("print('gone')", shown)

    def test_an_edit_shows_only_what_changes(self):
        shown = self._approve("edit_file", {
            "path": str(self.target), "old_string": "line 7", "new_string": "line seven"})
        self.assertIn("line seven", shown)
        self.assertNotIn("line 39", shown, "an unchanged tail is collapsed, not printed")

    def test_a_shell_command_is_unchanged(self):
        # bash already showed its command; the diff path must not touch it.
        shown = self._approve("bash", {"command": "rm -rf build && make"})
        self.assertIn("rm -rf build", shown)

    def test_a_tool_with_no_preview_still_asks(self):
        shown = self._approve("read_file", {"path": str(self.target)})
        self.assertNotIn("@@", shown)


class TuiApprovalTests(unittest.TestCase):
    """The full-screen terminal renders the same preview into the transcript."""

    def test_the_tui_builds_the_preview_before_it_asks(self):
        source = (Path(__file__).resolve().parents[1] / "dgc" / "tui.py").read_text(encoding="utf-8")
        start = source.index("def approve_live(")
        card = source[start:source.index('"kind": "approve"', start)]
        self.assertIn("edit_preview(", card,
                      "approve_live must build the diff before it asks")
        self.assertIn("render_diff(", card, "and render it")

    def test_the_preview_helper_produces_a_real_diff(self):
        with tempfile.TemporaryDirectory(prefix="dgc-preview-") as tmp:
            root = Path(tmp)
            target = root / "app.py"
            target.write_text(ORIGINAL, encoding="utf-8")
            diff = ui_mod.edit_preview("write_file", {"path": str(target), "content": REPLACEMENT}, root)
            self.assertIn("-line 1", diff)
            self.assertIn("+print('gone')", diff)

    def test_a_file_too_large_to_preview_still_gets_approved(self):
        # The preview is bounded: over 256 KB it returns "" rather than diffing a huge file.
        # The approval must still be asked -- an unpreviewable edit is not an auto-denied one.
        with tempfile.TemporaryDirectory(prefix="dgc-preview-") as tmp:
            root = Path(tmp)
            big = root / "big.txt"
            big.write_text("x" * 300_000, encoding="utf-8")
            self.assertEqual(ui_mod.edit_preview("write_file", {"path": str(big), "content": "y"}, root), "")

            ui = cli_mod.UI()
            ui.project_root = root
            ui._yield_stdin = lambda: None
            ui.console = type("C", (), {"print": lambda *a, **k: None})()
            with patch.object(cli_mod, "menu_select", lambda *a, **k: 0), \
                    patch.object(cli_mod, "section", lambda *a, **k: None):
                self.assertEqual(ui.approve("write_file", {"path": str(big), "content": "y"}), "once")


if __name__ == "__main__":
    unittest.main()
