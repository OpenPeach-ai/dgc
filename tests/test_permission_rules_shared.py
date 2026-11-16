"""Permission rules are one set across every DGC window (his call, 16 Nov: "Rules shared across windows" into 0.52).

Each `dgc serve` kept its own copy of the user's rules and only adopted the file's when it saved something itself. So
a rule added in one window wasn't listed in another, Remove on a rule this window had never loaded changed nothing on
disk (save() writes only this process's own additions and removals), and a rule removed elsewhere kept applying here.
Now a window re-reads the user's rules when the file has changed (a stat when it hasn't): before listing them, before
adding or removing one, and before each permission decision; a trusted project's rules and this run's own session rules
are kept as they were."""
from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

RULE = "Bash(npm test)"


class Shared(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        (self.home / ".dgc").mkdir(parents=True, exist_ok=True)
        self.path = self.home / ".dgc" / "config.json"
        self.path.write_text(json.dumps({"model": "start", "permissions": {"allow": [], "ask": [], "deny": []}}))
        self._home = os.environ.get("HOME")
        os.environ["HOME"] = str(self.home)
        from dgc import config as C
        self.C = importlib.reload(C)

    def tearDown(self):
        if self._home is not None:
            os.environ["HOME"] = self._home
        from dgc import config as C
        importlib.reload(C)

    def disk(self) -> dict:
        return json.loads(self.path.read_text())["permissions"]

    def test_a_rule_another_window_saved_is_seen_here_without_a_save(self):
        a, b = self.C.Config(), self.C.Config()
        a.add_permission_rule("allow", RULE)
        self.assertNotIn(RULE, b.permissions["allow"], "before: B's own stale copy")
        self.assertTrue(b.refresh_permissions())
        self.assertIn(RULE, b.permissions["allow"])

    def test_remove_takes_a_rule_off_the_file_even_if_this_window_never_loaded_it(self):
        a, b = self.C.Config(), self.C.Config()
        a.add_permission_rule("allow", RULE)
        b.remove_permission_rule("allow", RULE)
        self.assertNotIn(RULE, self.disk()["allow"])

    def test_a_rule_removed_elsewhere_stops_applying_here(self):
        a, b = self.C.Config(), self.C.Config()
        a.add_permission_rule("allow", RULE)
        b.refresh_permissions()
        self.assertIn(RULE, b.permissions["allow"])
        a.remove_permission_rule("allow", RULE)
        b.refresh_permissions()
        self.assertNotIn(RULE, b.permissions["allow"])

    def test_no_read_while_the_file_is_unchanged(self):
        b = self.C.Config()
        b.refresh_permissions(force=True)
        with patch.object(self.C, "_read_config_payload", side_effect=AssertionError("read again")):
            self.assertFalse(b.refresh_permissions())

    def test_a_trusted_projects_rules_stay_live(self):
        a, b = self.C.Config(), self.C.Config()
        b._project_rules = {"deny": ["Bash(rm *)"]}
        b.permissions["deny"].append("Bash(rm *)")
        a.add_permission_rule("ask", "Bash(git push *)")
        b.refresh_permissions()
        self.assertIn("Bash(rm *)", b.permissions["deny"], "a project's deny never drops on a refresh")
        self.assertIn("Bash(git push *)", b.permissions["ask"])
        self.assertNotIn("Bash(rm *)", self.disk()["deny"], "and it is never written to the user's file")

    def test_the_live_dict_is_updated_in_place(self):
        # Sub-agents hold this same dict (clone_for_root): a refresh never rebinds it.
        a, b = self.C.Config(), self.C.Config()
        held = b.permissions
        a.add_permission_rule("allow", RULE)
        b.refresh_permissions()
        self.assertIs(b.permissions, held)
        self.assertIn(RULE, held["allow"])


class TheAgentAsksTheRulesAsSavedNow(unittest.TestCase):
    def test_a_decision_refreshes_the_rules_first(self):
        from tests.test_goal_turns import agent_in
        directory = tempfile.TemporaryDirectory(prefix="dgc-perm-shared-")
        self.addCleanup(directory.cleanup)
        agent = agent_in(Path(directory.name))
        self.addCleanup(agent.mcp.stop_all)
        calls = []
        agent.config.refresh_permissions = lambda **k: calls.append(1) or False
        agent._monitor_permission("bash", {"command": "ls"})
        self.assertEqual(calls, [1])


class TheEditorLists(unittest.TestCase):
    def test_list_permissions_reads_the_rules_as_saved_now(self):
        from dgc import headless
        be = headless.Backend.__new__(headless.Backend)
        calls = []
        be.config = type("C", (), {"permissions": {"allow": [RULE], "ask": [], "deny": []},
                                   "refresh_permissions": lambda self, **k: calls.append(1) or False})()
        be.em = type("E", (), {"emit": lambda self, *a, **k: None})()
        be._emit_permissions("r1")
        self.assertEqual(calls, [1])


if __name__ == "__main__":
    unittest.main()
