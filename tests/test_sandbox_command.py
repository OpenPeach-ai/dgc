"""`/sandbox` must do what it is documented to do, and the same thing `--sandbox` does.

Two defects, both found by auditing this batch:

- `/sandbox read-only` has been documented since the sandbox shipped and was never implemented.
  The command fell through to the usage line and left the sandbox exactly as it was, so a review
  run someone had asked to confine went on writing.
- `--sandbox on` denies the `python` tool, because the persistent interpreter runs OUTSIDE the OS
  sandbox: bwrap wraps the shell, not the kernel, so confining the shell and leaving `python`
  available keeps exactly one tool that can write anywhere the user can and read the home
  directory the sandbox just masked. `/sandbox on` did not deny it, so the two ways of asking for
  the same thing gave different tool sets — and the hole stayed open on the more used path.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

from unittest.mock import patch                           # noqa: E402

from dgc.tui import TUI                                   # noqa: E402


class _Config:
    def __init__(self):
        self.data = {}
        self.session_permissions = {"allow": [], "ask": [], "deny": []}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value


class SandboxCommandTests(unittest.TestCase):
    def tui(self):
        t = object.__new__(TUI)
        t.config = _Config()
        t._sandbox_denies = []
        t.flashes = []
        t._flash = lambda message: t.flashes.append(str(message))
        t.app = None                       # the real slash handler repaints when it is done
        return t

    def run_cmd(self, t, rest, *, available=True):
        """`/sandbox <rest>`, through the real typed-command path."""
        with patch("dgc.sandbox.available", return_value=available), \
                patch("dgc.sandbox.describe", return_value="bubblewrap" if available else "none"):
            TUI._handle_slash(t, f"/sandbox {rest}".strip())

    def denies(self, t):
        return list(t.config.session_permissions.get("deny") or [])

    def test_read_only_turns_the_sandbox_on_and_denies_edits(self):
        t = self.tui()
        self.run_cmd(t, "read-only")
        self.assertIs(t.config.get("sandbox"), True, "the documented command must take effect")
        self.assertIs(t.config.get("sandbox_read_only"), True)
        for tool in ("Python", "Write", "Edit", "MultiEdit", "ApplyPatch"):
            self.assertIn(tool, self.denies(t))

    def test_on_denies_python_exactly_as_the_launch_flag_does(self):
        t = self.tui()
        self.run_cmd(t, "on")
        self.assertIs(t.config.get("sandbox"), True)
        self.assertIn("Python", self.denies(t),
                      "the interpreter runs outside the sandbox; --sandbox on has always denied it")
        self.assertNotIn("Write", self.denies(t), "only read-only denies the edit tools")

    def test_off_takes_back_only_what_sandbox_added(self):
        t = self.tui()
        t.config.session_permissions["deny"].append("Bash(rm *)")     # the user's own rule
        self.run_cmd(t, "read-only")
        self.run_cmd(t, "off")
        self.assertIs(t.config.get("sandbox"), False)
        self.assertIs(t.config.get("sandbox_read_only"), False)
        self.assertEqual(self.denies(t), ["Bash(rm *)"],
                         "turning the sandbox off must not strip a deny the user wrote")

    def test_switching_read_only_to_on_drops_the_edit_denials(self):
        t = self.tui()
        self.run_cmd(t, "read-only")
        self.run_cmd(t, "on")
        self.assertIn("Python", self.denies(t))
        self.assertNotIn("Write", self.denies(t), "no stale read-only rule may survive")
        self.assertIs(t.config.get("sandbox_read_only"), False)

    def test_read_only_is_reported_as_its_own_state(self):
        t = self.tui()
        self.run_cmd(t, "read-only")
        t.flashes.clear()
        self.run_cmd(t, "")
        self.assertTrue(any("read-only" in f for f in t.flashes), t.flashes)

    def test_no_backend_refuses_read_only_rather_than_pretending(self):
        t = self.tui()
        self.run_cmd(t, "read-only", available=False)
        self.assertIs(t.config.get("sandbox"), False)
        self.assertEqual(self.denies(t), [], "nothing is denied by a sandbox that is not on")
        self.assertTrue(any("remains OFF" in f for f in t.flashes), t.flashes)


if __name__ == "__main__":
    unittest.main()
