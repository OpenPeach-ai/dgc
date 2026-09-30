"""The liveness check the reap tests depend on, tested directly.

Without this, the fix it replaced could come back unnoticed. `assertFalse(_process_alive(pid))` is
satisfied by a function that ALWAYS returns False just as happily as by a correct one -- which is
exactly how `os.path.exists(f"/proc/{pid}")` passed on macOS for so long while proving nothing.
A helper that decides whether an assertion means anything has to be pinned itself.

Measured on macOS 26.5.1: `/proc` does not exist, so the old form reported a LIVE process dead.
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
for candidate in (str(PROJECT), str(PROJECT / "tests")):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)


def _helpers():
    """Both copies, so the two files cannot drift apart silently."""
    from test_turn_interruption import _process_alive as interruption
    from test_dgc_sdk import _process_alive as sdk
    return {"test_turn_interruption": interruption, "test_dgc_sdk": sdk}


class TheLivenessCheckIsPortableTest(unittest.TestCase):
    def test_a_running_process_is_alive(self) -> None:
        for name, alive in _helpers().items():
            with self.subTest(module=name):
                self.assertTrue(alive(os.getpid()), "this very process is running")

    def test_a_reaped_child_is_not_alive(self) -> None:
        for name, alive in _helpers().items():
            with self.subTest(module=name):
                child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
                try:
                    self.assertTrue(alive(child.pid), "a child that has not been killed yet")
                finally:
                    child.kill()
                    child.wait()
                self.assertFalse(alive(child.pid), "and not once it has been reaped")

    def test_a_pid_that_was_never_used_is_not_alive(self) -> None:
        for name, alive in _helpers().items():
            with self.subTest(module=name):
                self.assertFalse(alive(999_999))

    def test_a_process_owned_by_someone_else_is_alive(self) -> None:
        """PermissionError means "it is there and not yours", which is alive. Reading it as dead
        is the subtle way this check goes wrong, and `/proc` never had to decide."""
        if os.getuid() == 0:
            self.skipTest("running as root; every signal is permitted, so there is nothing to prove")
        for name, alive in _helpers().items():
            with self.subTest(module=name):
                self.assertTrue(alive(1), "pid 1 is running and is not ours")

    def test_it_does_not_depend_on_proc(self) -> None:
        """The whole point. `/proc` is Linux-only, and a check that reads it answers False for
        every pid on macOS -- which turns each caller's assertion into a tautology."""
        import ast
        import inspect
        import textwrap
        for name, fn in _helpers().items():
            with self.subTest(module=name):
                # Parse, then drop the docstring and comments -- this function's own prose NAMES
                # `/proc` to explain why it does not use it, and a substring search cannot tell
                # the explanation from the mistake.
                tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
                func = tree.body[0]
                if (func.body and isinstance(func.body[0], ast.Expr)
                        and isinstance(func.body[0].value, ast.Constant)
                        and isinstance(func.body[0].value.value, str)):
                    func.body = func.body[1:]
                self.assertNotIn("/proc", ast.unparse(tree),
                                 "liveness must not be decided by a Linux-only path")
                self.assertIn("os.kill", ast.unparse(tree), "signal 0 is the portable check")


if __name__ == "__main__":
    unittest.main()
