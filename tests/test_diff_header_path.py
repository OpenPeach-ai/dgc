"""An applied edit's diff header must name the file the way its readers look it up.

The header of `_diff`'s output is not decoration. `split_diff` lifts it into the `tool_result`
event's `diff` field, the editor panel parses the `+++` line, and that one string becomes BOTH the
name on the diff card and the key of the end-of-turn "Edited N files" row. Clicking such a row
sends that key back to the extension host, which looks it up among the chat's recorded changes --
whose names are relative to the project root.

Every call site passed `str(p)`, an absolute path, so the header read `+++ b//home/you/project/
src/a.py`. The panel strips the `b/` and the leading slash and is left with
`home/you/project/src/a.py`. Nothing matches that, so every one of those rows answered a click
with "That file is no longer in the workspace change set." -- naming a file the chat had written
seconds earlier. The row looked right, the path looked odd, and the feature was dead.

These tests run the real executors in a real project and carry the real output through the real
`split_diff` and the panel's real normalisation, then require the result to be a name
`ChatChanges.report()` actually publishes. Restore `str(p)` at any call site and the first test
fails on the tool it broke.
"""
from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc.chat_changes import ChatChanges            # noqa: E402
from dgc.tools import EXECUTORS                     # noqa: E402
from dgc.ui import split_diff                       # noqa: E402

PANEL = PROJECT / "editors" / "vscode" / "media" / "main.js"


class Ctx:
    """The tool contract's two fields these executors touch, and nothing else."""

    def __init__(self, root: Path):
        self.project_root = root

        class Cfg:
            def get(self, key, default=None):
                return default
        self.config = Cfg()


def panel_normalisation(header: str) -> str:
    """Exactly what `renderDiff` does to a `+++` path, and no more.

    Kept as one function so the next test can assert the shipping code still does only this. A
    Python restatement that silently drifts from main.js would certify a spelling the panel never
    sees.
    """
    return re.sub(r"^/+", "", re.sub(r"^[ab]/", "", header, count=1))


def project() -> tuple[Path, Ctx]:
    root = Path(tempfile.mkdtemp(prefix="dgc-diff-header-"))
    subprocess.run(["git", "init", "-q", "."], cwd=root, check=True,
                   capture_output=True)
    (root / "src").mkdir()
    (root / "src" / "a.py").write_text("one\ntwo\nthree\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
                   cwd=root, check=True, capture_output=True)
    return root, Ctx(root)


def header_of(output: str) -> str:
    is_diff, diff = split_diff(output)
    if not is_diff:
        return ""
    for line in diff.splitlines():
        if line.startswith("+++ "):
            return line[4:]
    return ""


class EveryEditToolNamesTheFileTheSameWayTest(unittest.TestCase):
    """One case per tool that writes, because each one passes the path to `_diff` itself."""

    def run_tool(self, name: str, args: dict) -> tuple[str, Path, ChatChanges]:
        root, ctx = project()
        journal = ChatChanges(root)
        before = journal.begin()                      # what a turn does around a tool call
        output = EXECUTORS[name](args, ctx)
        journal.finish(before)
        self.assertNotIn("error:", output[:40].lower(), f"{name} did not run: {output[:200]}")
        return output, root, journal

    def assert_resolvable(self, name: str, args: dict, expected: str):
        output, _root, journal = self.run_tool(name, args)
        header = header_of(output)
        self.assertTrue(header, f"{name} produced no diff header: {output[:300]}")
        key = panel_normalisation(header)
        self.assertEqual(key, expected,
                         f"{name}'s header is what the panel keys the Edited-files row on")
        published = [row["path"] for row in journal.report()["files"]]
        self.assertIn(key, published,
                      f"the panel would send {key!r} and the host would look for it among "
                      f"{published!r} -- a miss is the 'no longer in the workspace change set' "
                      f"message, for a file this tool had just written")

    def test_write_file(self):
        self.assert_resolvable("write_file", {"path": "src/b.py", "content": "fresh\n"}, "src/b.py")

    def test_edit_file(self):
        self.assert_resolvable("edit_file",
                               {"path": "src/a.py", "old_string": "two", "new_string": "TWO"},
                               "src/a.py")

    def test_multi_edit(self):
        self.assert_resolvable("multi_edit", {"path": "src/a.py", "edits": [
            {"old_string": "two", "new_string": "TWO"},
            {"old_string": "three", "new_string": "THREE"}]}, "src/a.py")

    def test_apply_patch(self):
        self.assert_resolvable("apply_patch", {"path": "src/a.py", "patch":
            "--- a/src/a.py\n+++ b/src/a.py\n@@ -1,1 +1,1 @@\n-one\n+ONE\n"}, "src/a.py")

    def test_a_nested_path_keeps_its_directories(self):
        # `display_path` returning a bare basename would also "match" a single-file project while
        # silently colliding two files of the same name in different folders.
        root, ctx = project()
        (root / "src" / "deep").mkdir()
        journal = ChatChanges(root)
        before = journal.begin()
        output = EXECUTORS["write_file"]({"path": "src/deep/c.py", "content": "x = 1\n"}, ctx)
        journal.finish(before)
        self.assertEqual(panel_normalisation(header_of(output)), "src/deep/c.py")
        self.assertIn("src/deep/c.py", [row["path"] for row in journal.report()["files"]])

    def test_an_absolute_header_is_what_used_to_break_it(self):
        """The failure itself, so the assertions above are known to be able to fail.

        Without this, a `display_path` that returned the absolute path unchanged would still pass
        every test above on a project rooted at `/`.
        """
        absolute = "/home/you/project/src/a.py"
        self.assertEqual(panel_normalisation(f"b/{absolute}"), "home/you/project/src/a.py")
        self.assertNotEqual(panel_normalisation(f"b/{absolute}"), "src/a.py")


class ThePanelStillOnlyStripsThoseTwoPrefixesTest(unittest.TestCase):
    """`panel_normalisation` is a restatement, so pin it to the shipping regexes.

    If the panel starts stripping something else -- a drive letter, a `./` -- the tests above stop
    describing what the panel does, and would keep passing while the click broke again.
    """

    def test_render_diff_normalises_exactly_this_way(self):
        source = PANEL.read_text(encoding="utf-8")
        self.assertIn(r'.replace(/^[ab]\//, "").replace(/^\/+/, "")', source,
                      "renderDiff's path normalisation changed; update panel_normalisation in "
                      "this file to match it before trusting these tests")

    def test_the_row_click_sends_that_same_key(self):
        source = PANEL.read_text(encoding="utf-8")
        # `recordEdit(rendered.dataset.path, ...)` is the link between the diff card's parsed path
        # and the Edited-files row, and `wrap.dataset.path = path` is where it is set.
        self.assertIn("wrap.dataset.path = path;", source)
        self.assertIn("recordEdit(rendered.dataset.path", source)
        self.assertIn('vscode.postMessage({ type: "reviewChange", path: entry[0], scope: "chat" })',
                      source)


if __name__ == "__main__":
    unittest.main()
