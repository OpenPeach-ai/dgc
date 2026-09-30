"""A sandbox refusal has to read as a decision, not as a broken machine.

Measured on macOS 26.5.1 before this existed: a delegated sub-agent's git failed with

    fatal: Invalid path '/Users/<me>': Operation not permitted

and nothing in that text says DGC denied it. A model reading it looks for a fault that is not
there -- a missing file, a corrupt checkout, a disk permission -- and retries. The sandbox is off
by default, so the people who meet this are exactly the ones who turned it on deliberately.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc.tools import _explain_sandbox_denial                          # noqa: E402

DENIED = "exit code: 128\nfatal: Invalid path '/Users/me': Operation not permitted"


class ASandboxRefusalIsNamedTest(unittest.TestCase):
    def test_it_is_named_when_the_sandbox_denied_it(self) -> None:
        out = _explain_sandbox_denial(DENIED, 128, True)
        self.assertIn("[dgc]", out)
        self.assertIn("sandbox refused", out)
        self.assertIn(DENIED, out, "the original output is kept, never replaced")

    def test_it_says_what_to_do_instead_of_retrying(self) -> None:
        out = _explain_sandbox_denial(DENIED, 128, True)
        self.assertIn("do not retry", out.lower())
        self.assertIn("sandbox", out.lower())

    def test_nothing_is_added_when_the_sandbox_is_off(self) -> None:
        """The same text without the sandbox means a real permissions problem, and saying
        otherwise would send the reader after DGC instead of after the cause."""
        self.assertEqual(_explain_sandbox_denial(DENIED, 128, False), DENIED)

    def test_success_is_left_alone(self) -> None:
        ok = "exit code: 0\nfine"
        self.assertEqual(_explain_sandbox_denial(ok, 0, True), ok)

    def test_an_unrelated_failure_is_left_alone(self) -> None:
        other = "exit code: 1\nAssertionError: 2 != 3"
        self.assertEqual(_explain_sandbox_denial(other, 1, True), other)

    def test_shell_misuse_and_command_not_found_keep_their_own_meaning(self) -> None:
        """127 is "no such command" and 126 is "not executable"; both can carry the words
        `permission denied` for a reason that has nothing to do with the sandbox."""
        for code in (2, 126, 127):
            with self.subTest(code=code):
                text = f"exit code: {code}\nbash: ./x: Permission denied"
                self.assertEqual(_explain_sandbox_denial(text, code, True), text)

    def test_every_denial_wording_the_two_backends_produce_is_matched(self) -> None:
        for text in ("Operation not permitted", "operation not permitted",
                     "Permission denied", "Read-only file system"):
            with self.subTest(text=text):
                rendered = f"exit code: 1\nsomething: {text}"
                self.assertIn("[dgc]", _explain_sandbox_denial(rendered, 1, True))


if __name__ == "__main__":
    unittest.main()
