"""Both capture guards must ignore the same ephemeral runtime directories.

Each capture proves it never wrote into the operator's real `~/.dgc`. Each therefore keeps a list
of paths a live FOREIGN backend churns, which must not be read as contamination. The two lists are
maintained in different languages in different files, and nothing compared them -- so when `peers`
was added to the CLI capture's list in 0.44.0, the editor capture's list was left behind and the
next editor capture aborted on a running backend's heartbeat, mid-release-train.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path
import unittest

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
CLI_CAPTURE = SCRIPTS / "render-real-cli-capture.py"
EDITOR_CAPTURE = SCRIPTS / "render-vscode-capture.mjs"


def cli_ignored() -> set[str]:
    """The directory names `render-real-cli-capture.py` skips entirely."""
    tree = ast.parse(CLI_CAPTURE.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "IGNORED_USER_STATE" for t in node.targets
        ):
            return set(ast.literal_eval(node.value))
    raise AssertionError("IGNORED_USER_STATE not found in render-real-cli-capture.py")


def editor_ephemeral_patterns() -> list[re.Pattern[str]]:
    """The FOREIGN_EPHEMERAL regexes, compiled so the test can run the real matcher."""
    source = EDITOR_CAPTURE.read_text(encoding="utf-8")
    block = re.search(r"const FOREIGN_EPHEMERAL = \[(.*?)\n\];", source, re.S)
    if not block:
        raise AssertionError("FOREIGN_EPHEMERAL not found in render-vscode-capture.mjs")
    bodies = re.findall(r"^\s*/(.+?)/,\s*(?://.*)?$", block.group(1), re.M)
    if not bodies:
        raise AssertionError("FOREIGN_EPHEMERAL is empty")
    # JS and Python regex syntax agree on everything these patterns use.
    return [re.compile(body) for body in bodies]


def editor_ephemeral() -> set[str]:
    """The top-level directories those patterns actually match, probed through the real regexes."""
    patterns = editor_ephemeral_patterns()
    covered = set()
    for name in cli_ignored() | {"peers", "locks"}:
        if any(p.search(f"./{name}/7.json") for p in patterns):
            covered.add(name)
    return covered


class CaptureUserStateGuards(unittest.TestCase):
    def test_peers_is_ignored_by_both_captures(self) -> None:
        # The concrete regression: a live `dgc serve` heartbeats ~/.dgc/peers/<pid>.json every 30s,
        # so any capture that treats that as contamination cannot run on a machine in use.
        self.assertIn("peers", cli_ignored())
        self.assertIn("peers", editor_ephemeral())

    def test_editor_capture_ignores_everything_the_cli_capture_does(self) -> None:
        missing = cli_ignored() - editor_ephemeral()
        self.assertEqual(
            missing, set(),
            f"render-vscode-capture.mjs must ignore the same runtime dirs as the CLI capture; "
            f"missing {sorted(missing)}",
        )

    def test_ephemeral_paths_are_exempt_from_appearing_and_vanishing(self) -> None:
        # A peer note is created on start and unlinked on exit, so exempting only "changed" -- the
        # rule FOREIGN_REWRITES applies -- would still abort the moment a foreign session started
        # or stopped during the recording.
        source = EDITOR_CAPTURE.read_text(encoding="utf-8")
        drift = re.search(r"function userStateDrift\(.*?\n}", source, re.S)
        self.assertIsNotNone(drift, "userStateDrift not found")
        body = drift.group(0)
        self.assertIn("if (ephemeral(path)) continue;", body,
                      "an ephemeral path must be exempt from `added` as well as `changed`")
        self.assertRegex(body, r"!after\.has\(path\) && !ephemeral\(path\)",
                         "an ephemeral path must be exempt from `removed`")

    def test_real_user_state_is_still_guarded(self) -> None:
        # The exemption must stay narrow: a session, config or credential appearing in the real
        # tree is what actually proves the capture escaped its disposable HOME. Run those paths
        # through the real patterns rather than asserting on a name.
        patterns = editor_ephemeral_patterns()
        for path in ("./sessions/abc/session.json", "./config.json", "./credentials.json",
                     "./remote.json", "./peers-of-mine.json"):
            self.assertFalse(
                any(p.search(path) for p in patterns),
                f"{path} must never be treated as ephemeral",
            )

    def test_a_peer_note_and_its_takeover_file_are_both_covered(self) -> None:
        patterns = editor_ephemeral_patterns()
        for path in ("./peers", "./peers/3923170.json", "./peers/takeover/3923170.json"):
            self.assertTrue(any(p.search(path) for p in patterns),
                            f"{path} is foreign runtime presence and must be exempt")


if __name__ == "__main__":
    unittest.main()
