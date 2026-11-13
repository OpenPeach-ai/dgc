"""DGC's settings tool, its guard and Router's rule (0.52; his calls 13 Nov evening; 052-plan/settings-tool-plan.md).

"A general settings tool first, for ordinary settings" — "no we don't want any allow cards in auto mode" — "DGC can
never turn on Dev Mode itself, or its own Dev Mode tools" — Router "same rule as settings". A change goes through the
settings tool (checked, with Undo), never a raw edit of DGC's own settings file: DGC rewrites that file while it runs,
so a direct edit can be lost, break the file or allow far more than meant.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from dgc import config as dgc_config
from dgc.permissions import ALLOW, ASK, DENY, PermissionEngine


class TheGuard(unittest.TestCase):
    def setUp(self):
        self.project = Path(tempfile.mkdtemp(prefix="dgc-settings-guard-"))

    def engine(self, mode):
        return PermissionEngine(mode, {"allow": ["Write(*)", "Edit(*)"], "ask": [], "deny": []}, project_root=self.project)

    def test_file_tools_never_edit_dgcs_own_settings_files_in_any_mode(self):
        for mode in ("auto", "default", "acceptEdits"):
            for tool, args in (("write_file", {"path": str(dgc_config.USER_CONFIG), "content": "{}"}),
                               ("edit_file", {"path": str(dgc_config.USER_SECRETS), "old": "a", "new": "b"}),
                               ("multi_edit", {"path": str(dgc_config.USER_CONFIG), "edits": []}),
                               ("apply_patch", {"patch": f"*** Begin Patch\n*** Update File: {dgc_config.USER_CONFIG}\n"
                                                         "@@\n-{}\n+{\"mode\": \"auto\"}\n*** End Patch\n"})):
                action, why = self.engine(mode).decide(tool, args)
                self.assertEqual(action, DENY, (mode, tool))
                self.assertIn("dgc_settings", why, "it says where the change goes instead")

    def test_other_files_outside_the_project_follow_the_mode_as_before(self):
        other = str(self.project.parent / "notes.txt")
        self.assertEqual(PermissionEngine("auto", {}, project_root=self.project).decide("write_file", {"path": other, "content": "x"})[0], ALLOW)
        self.assertEqual(PermissionEngine("default", {}, project_root=self.project).decide("write_file", {"path": other, "content": "x"})[0], ASK)


class RouterFollowsTheSameRule(unittest.TestCase):
    def test_router_changes_go_in_auto_mode_and_ask_otherwise(self):
        args = {"action": "set_job", "job": "chat", "model": "qwen3"}
        self.assertEqual(PermissionEngine("auto", {}).decide("router_update", args)[0], ALLOW)
        self.assertEqual(PermissionEngine("default", {}).decide("router_update", args)[0], ASK)


class TheTool(unittest.TestCase):
    """The settings tool's own rules, on a Config whose settings file is a temporary one."""

    def setUp(self):
        import os
        from unittest.mock import patch
        self.home = Path(tempfile.mkdtemp(prefix="dgc-settings-tool-"))
        for name, value in (("dgc.config.USER_CONFIG", self.home / ".dgc" / "config.json"),
                            ("dgc.config.USER_SECRETS", self.home / ".dgc" / "secrets.json")):
            p = patch(name, value)
            p.start()
            self.addCleanup(p.stop)
        env = patch.dict(os.environ, {"HOME": str(self.home), "DGC_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        (self.home / ".dgc").mkdir()
        self.config = dgc_config.Config(project_root=self.home)

    def test_it_reads_what_it_may_change_and_never_a_key(self):
        from dgc import settings_tool as T
        self.config.set("api_key", "sk-never-shown-123456", persist=False)
        said = T.read(self.config)
        self.assertIn("compact_threshold", said)
        self.assertIn("Dev Mode: off", said)
        self.assertNotIn("sk-never-shown", said)

    def test_a_change_is_checked_saved_and_undone(self):
        from dgc import settings_tool as T
        said = T.change(self.config, "bash_timeout", 300, "the build takes four minutes")
        self.assertIn("120 → 300", said)
        self.assertEqual(self.config.get("bash_timeout"), 300)
        change_id = said.rsplit("Undo: ", 1)[1]
        self.assertEqual(T.undo(self.config, change_id), "Undone.")
        self.assertEqual(self.config.get("bash_timeout"), 120)
        with self.assertRaises(T.SettingsError):
            T.change(self.config, "bash_timeout", "three hundred")

    def test_never_its_keys_safety_or_dev_mode(self):
        from dgc import settings_tool as T
        for key in ("api_key", "sandbox", "session_redaction", "hooks", "mcp_servers", "base_url", "dev_mode", "dev_mode_tools"):
            with self.assertRaises(T.SettingsError, msg=key) as raised:
                T.change(self.config, key, True)
            self.assertIn("yours", str(raised.exception))
        self.assertIsNot(self.config.get("dev_mode"), True)

    def test_a_rule_in_claude_codes_form(self):
        from dgc import settings_tool as T
        said = T.rule(self.config, "allow", "Bash(npm test:*)", reason="he asked")
        self.assertIn("Added Bash(npm test:*) to allow", said)
        self.assertIn("Bash(npm test:*)", self.config.permissions["allow"])
        T.undo(self.config, said.rsplit("Undo: ", 1)[1])
        self.assertNotIn("Bash(npm test:*)", self.config.permissions["allow"])
        with self.assertRaises(T.SettingsError):
            T.rule(self.config, "allow", "not a (rule")

    def test_dev_mode_limits_only_with_both_switches_on(self):
        from dgc import settings_tool as T
        with self.assertRaises(T.SettingsError):
            T.dev_limit(self.config, "work_helpers", 12)
        self.config.set("dev_mode", True)
        with self.assertRaises(T.SettingsError, msg="Dev Mode on, but the user didn't let DGC change its limits"):
            T.dev_limit(self.config, "work_helpers", 12)
        self.config.set("dev_mode_tools", True)
        self.assertIn("→ 12", T.dev_limit(self.config, "work_helpers", 12))
        self.assertEqual(self.config.get("dev_limits")["work_helpers"], 12)

    def test_docs_answer_from_dgcs_own_pages(self):
        from dgc import settings_tool as T
        said = T.docs("slash commands")
        self.assertIn("Slash commands", said)


class TheAgentUsesThem(unittest.TestCase):
    """Through a real agent: offered to the session the user talks to; auto mode changes without a card (his call);
    another mode asks; the docs answer."""

    def setUp(self):
        import os
        import sys
        from unittest.mock import patch
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from test_subagents import Harness
        self.home = Path(tempfile.mkdtemp(prefix="dgc-settings-agent-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DGC_SESSION_POLICY", None)
        project = Path(tempfile.mkdtemp(prefix="dgc-settings-project-"))
        self.harness = Harness(project)
        self.addCleanup(self.harness.close)

    def call(self, name, args):
        from dgc.llm import ToolCall
        return self.harness.agent._handle_call(ToolCall("s1", name, args))

    def test_offered_every_turn_to_the_session_the_user_talks_to(self):
        names = {tool["function"]["name"] for tool in self.harness.agent._tool_schemas()}
        self.assertTrue({"dgc_settings_read", "dgc_settings", "dgc_docs"} <= names)

    def test_auto_mode_changes_it_without_a_card_and_says_what_changed(self):
        self.assertEqual(self.harness.config.get("mode"), "auto")
        out = self.call("dgc_settings", {"action": "setting", "key": "bash_timeout", "value": 300, "reason": "slow build"})
        self.assertIn("120 → 300", out)
        self.assertEqual(self.harness.config.get("bash_timeout"), 300)
        self.assertEqual([f for f in self.harness.stream.frames() if f["type"] == "permission_request"], [])

    def test_another_mode_asks_first(self):
        self.harness.agent.set_mode("default", persist=False)
        self.harness.answer("permission_request", {"decision": "no"})
        out = self.call("dgc_settings", {"action": "setting", "key": "bash_timeout", "value": 300})
        self.assertIn("DENIED", out)
        self.assertEqual(self.harness.config.get("bash_timeout"), 120)

    def test_reading_and_the_docs_never_ask(self):
        self.harness.agent.set_mode("default", persist=False)
        self.assertIn("bash_timeout", self.call("dgc_settings_read", {"topic": "timeout"}))
        self.assertIn("Slash commands", self.call("dgc_docs", {"query": "slash commands"}))
        self.assertEqual([f for f in self.harness.stream.frames() if f["type"] == "permission_request"], [])


if __name__ == "__main__":
    unittest.main()
