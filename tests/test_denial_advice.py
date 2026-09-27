"""A denial must not advise the mode the run is already using.

`dgc -p` cannot show an approval menu, so it denies and tells you how to pre-approve. That advice
was a fixed string: `rerun with --allow-tool "<rule>" or --mode acceptEdits|auto`, printed whatever
had been denied and whatever mode was in force.

For `task` that is a loop, and it cost a real testing session. A `-p --mode acceptEdits` run was
refused with "rerun with ... or --mode acceptEdits|auto" — naming the mode it was already in. The
engine returns ASK for `task` under acceptEdits; only `auto` allows it. The model read the advice,
correctly concluded it could not proceed, and stopped.

The reason string compounded it: every tool that is neither read-only nor a file edit fell into a
branch that called it a shell command, so `task`, a monitor and an MCP route all told the reader to
look for a command they had never run.

These tests ask the real engine, so they cannot drift from the real decisions.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc.cli import _rerun_advice                                    # noqa: E402
from dgc.permissions import ALLOW, ASK, MODES, PermissionEngine, modes_allowing   # noqa: E402

EMPTY = {"allow": [], "ask": [], "deny": []}
TASK_ARGS = {"description": "Add a docstring", "prompt": "..."}


class WhatTheEngineActuallySaysTest(unittest.TestCase):
    """The premise of the bug, pinned: acceptEdits does not allow `task`."""

    def test_task_is_asked_in_accept_edits_and_allowed_only_in_auto(self) -> None:
        decisions = {mode: PermissionEngine(mode, EMPTY).decide("task", TASK_ARGS)[0]
                     for mode in MODES}
        self.assertEqual(decisions["acceptEdits"], ASK,
                         "if this ever becomes ALLOW the advice below is free to name it again")
        self.assertEqual(decisions["auto"], ALLOW)
        self.assertEqual(decisions["default"], ASK)

    def test_the_accept_edits_reason_does_not_call_everything_a_shell_command(self) -> None:
        reason = PermissionEngine("acceptEdits", EMPTY).decide("task", TASK_ARGS)[1]
        self.assertIn("task", reason, "the reason must name the tool that was actually refused")
        self.assertNotIn("shell", reason,
                         "`task` is not a shell command; that wording sent people looking for a "
                         "command they had never run")


class TheAdviceNamesOnlyModesThatWouldHelpTest(unittest.TestCase):
    def test_a_mode_is_offered_only_when_it_would_allow_the_call(self) -> None:
        for mode in modes_allowing("task", TASK_ARGS):
            with self.subTest(mode=mode):
                self.assertEqual(PermissionEngine(mode, EMPTY).decide("task", TASK_ARGS)[0], ALLOW)
        self.assertEqual(modes_allowing("task", TASK_ARGS), ["auto"])

    def test_the_mode_already_in_force_is_never_suggested(self) -> None:
        # The whole bug, in one line.
        advice = _rerun_advice("Task(Add a docstring)", "task", TASK_ARGS, "acceptEdits")
        self.assertNotIn("acceptEdits", advice,
                         "a -p run already in acceptEdits was told to rerun with acceptEdits")
        self.assertIn("--mode auto", advice)

    def test_no_mode_appears_in_its_own_advice(self) -> None:
        """Whatever the tool, the advice never names the mode that just refused it."""
        for tool, args in (("task", TASK_ARGS), ("bash", {"command": "ls"}),
                           ("read_file", {"path": "a.py"}), ("edit_file", {"path": "a.py"})):
            for mode in MODES:
                with self.subTest(tool=tool, mode=mode):
                    self.assertNotIn(f"--mode {mode}", _rerun_advice("r", tool, args, mode))

    def test_the_exact_rule_is_always_offered(self) -> None:
        # A mode may not exist that helps; the rule always does, and it is the precise answer.
        for mode in MODES:
            with self.subTest(mode=mode):
                self.assertIn('--allow-tool "Task(x)"', _rerun_advice("Task(x)", "task",
                                                                      TASK_ARGS, mode))

    def test_no_mode_clause_when_no_mode_would_help(self) -> None:
        # Denied while already in the most permissive mode: there is nothing to suggest but the
        # rule, and inventing a mode clause there is how the loop started.
        advice = _rerun_advice("bash(ls)", "bash", {"command": "ls"}, "auto")
        self.assertNotIn("--mode", advice)
        self.assertIn('--allow-tool "bash(ls)"', advice)

    def test_a_read_only_tool_offers_every_mode_that_would_allow_it(self) -> None:
        advice = _rerun_advice("Read", "read_file", {"path": "a.py"}, "")
        for mode in modes_allowing("read_file", {"path": "a.py"}):
            self.assertIn(mode, advice)


class BothDenialSurfacesUseItTest(unittest.TestCase):
    """The text UI and the NDJSON one must not drift apart again."""

    def test_neither_surface_hardcodes_the_old_string(self) -> None:
        source = (PROJECT / "dgc" / "cli.py").read_text(encoding="utf-8")
        # Scoped to the permission denial. The plan message a few lines below also says
        # "--mode acceptEdits|auto" and is correct there: either mode really does let a -p run
        # build an approved plan.
        denial = source[source.index("permission needed for"):]
        denial = denial[:denial.index("plan reported, not executed")]
        self.assertNotIn("--mode acceptEdits|auto", denial,
                         "the fixed suggestion is what named a mode that does not help")
        self.assertEqual(source.count("_rerun_advice("), 3,
                         "both denial paths plus the definition; a third caller means a new "
                         "surface that also needs the active mode passed in")

    def test_the_json_one_shot_ui_has_the_attribute(self) -> None:
        # getattr(..., "") would silently disable the exclusion and let the loop back in.
        source = (PROJECT / "dgc" / "cli.py").read_text(encoding="utf-8")
        self.assertIn("permission_mode", source)
        self.assertIn('cli.ui.permission_mode = str(getattr(cli.agent, "mode", "") or "")', source)


if __name__ == "__main__":
    unittest.main()
