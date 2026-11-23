"""A plugin set to Always ask asks in Work too (decided 20 Nov, as Claude Code does for a connector set to ask): every
call of its tools asks, in every mode, as the user's own ask rule does. Default mode: its card, with no Always allow (an
allow rule never beats it). Auto mode: held in the chat, the user's next message is the yes. The other levels leave Work
as it was (its mode decides). One setting for Work and every Pip: the plugin's page in Settings and Pips settings →
Plugins both set it."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_subagents import Harness  # noqa: E402

from dgc.llm import ToolCall  # noqa: E402

TOOL = "mcp__acme-mail__send_message"


class Case(unittest.TestCase):
    level = "always_ask"

    def setUp(self):
        self.state = Path(tempfile.mkdtemp(prefix="dgc-plugin-ask-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.state)})
        env.start()
        self.addCleanup(env.stop)
        from dgc import auto_holds
        auto_holds.set_editor(True)
        self.addCleanup(auto_holds.set_editor, False)
        owner = patch("dgc.pip_plugins.owner", lambda server: {"name": "acme", "display_name": "Acme Mail",
                                                               "money": False, "spec": {}}
                      if server == "acme-mail" else None)
        owner.start()
        self.addCleanup(owner.stop)
        level = patch("dgc.plugins.permission", lambda name: self.level if name == "acme" else "important")
        level.start()
        self.addCleanup(level.stop)

    def harness(self, mode):
        directory = tempfile.TemporaryDirectory(prefix="dgc-plugin-ask-project-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name), mode=mode)
        self.addCleanup(harness.close)
        harness.agent._note_turn_origin(continuing=False)
        return harness

    def call(self, harness, name=TOOL, call_id="c1"):
        return harness.agent._handle_call(ToolCall(call_id, name, {"to": "a@example.com", "body": "hi"}))

    def cards(self, harness):
        return [f for f in harness.stream.frames() if f["type"] == "permission_request"]


class AlwaysAsk(Case):
    def test_default_mode_asks_with_no_always_even_with_an_allow_rule(self):
        harness = self.harness("default")
        harness.config.permissions = {"allow": ["MCPCall(mcp__acme-mail__*)"], "ask": [], "deny": []}
        harness.answer("permission_request", {"decision": "no"})
        self.assertIn("DENIED", self.call(harness))
        cards = self.cards(harness)
        self.assertEqual(len(cards), 1, "the allow rule doesn't answer it")
        self.assertEqual(cards[0]["choices"], ["once", "deny"])

    def test_an_always_answer_counts_once(self):
        harness = self.harness("default")
        harness.answer("permission_request", {"decision": "always"})
        self.call(harness)
        self.assertEqual(harness.config.permissions.get("allow"), [], "no rule saved")
        self.assertEqual(len(self.cards(harness)), 1)
        self.call(harness, call_id="c2")
        self.assertEqual(len(self.cards(harness)), 2, "it asks again")

    def test_auto_mode_holds_it_in_the_chat(self):
        harness = self.harness("auto")
        out = self.call(harness)
        self.assertIn("WAITING FOR THE USER", out)
        self.assertIn("Always ask", out)
        self.assertEqual(self.cards(harness), [])

    def test_accept_edits_mode_asks_too(self):
        harness = self.harness("acceptEdits")
        harness.answer("permission_request", {"decision": "no"})
        self.call(harness)
        self.assertEqual(len(self.cards(harness)), 1)

    def test_a_deny_rule_still_refuses(self):
        harness = self.harness("auto")
        harness.config.permissions = {"allow": [], "ask": [], "deny": ["MCPCall(mcp__acme-mail__*)"]}
        self.assertIn("PERMISSION DENIED", self.call(harness))

    def test_through_mcp_call_too(self):
        harness = self.harness("auto")
        out = harness.agent._handle_call(ToolCall("c1", "mcp_call", {"name": TOOL, "arguments": {"to": "a@b.c"}}))
        self.assertIn("WAITING FOR THE USER", out)

    def test_another_plugins_tools_are_unchanged(self):
        harness = self.harness("auto")
        out = self.call(harness, "mcp__other__read_things")
        self.assertNotIn("WAITING FOR THE USER", out)
        self.assertEqual(self.cards(harness), [])


class OtherLevels(Case):
    level = "never_ask"

    def test_work_follows_its_mode(self):
        for mode in ("auto", "default"):
            with self.subTest(mode=mode):
                harness = self.harness(mode)
                harness.answer("permission_request", {"decision": "no"})
                out = self.call(harness)
                self.assertNotIn("WAITING FOR THE USER", out)
                self.assertEqual(len(self.cards(harness)), 0 if mode == "auto" else 1)
                if mode == "default":
                    self.assertIn("always", self.cards(harness)[0]["choices"])


class SettingsPage(Case):
    """A plugin's page in Work's Settings shows and sets the same level (set_plugin_permission on the Work backend)."""

    def setUp(self):
        super().setUp()
        self.saved = []
        infos = patch("dgc.pip_plugins.installed", lambda config: {
            "acme": {"name": "acme", "display_name": "Acme Mail", "money": False},
            "paybox": {"name": "paybox", "display_name": "Paybox", "money": True}})
        infos.start()
        self.addCleanup(infos.stop)

        def save(name, level, *, money):
            if level == "never_ask" and money:
                from dgc.plugins import PluginError
                raise PluginError("This plugin can move money, so it always asks before it does anything that changes "
                                  "something.")
            self.saved.append((name, level, money))
            return level
        setter = patch("dgc.plugins.set_permission", save)
        setter.start()
        self.addCleanup(setter.stop)

    def backend(self):
        harness = self.harness("default")
        harness.backend._editor_plugins = lambda **kw: [{"name": "acme", "installed": True}]
        return harness

    def frames(self, harness, kind):
        return [f for f in harness.stream.frames() if f["type"] == kind]

    def test_it_saves_the_level_and_sends_the_rows_again(self):
        harness = self.backend()
        harness.backend._dispatch({"type": "set_plugin_permission", "request_id": "lvl", "plugin": "acme",
                                   "level": "always_ask"})
        self.assertEqual(self.saved, [("acme", "always_ask", False)])
        rows = self.frames(harness, "plugin_catalog")
        self.assertEqual([r.get("request_id") for r in rows], ["lvl"])

    def test_a_payment_plugin_is_never_never_ask_and_an_unknown_one_is_refused(self):
        harness = self.backend()
        harness.backend._dispatch({"type": "set_plugin_permission", "request_id": "a", "plugin": "paybox",
                                   "level": "never_ask"})
        harness.backend._dispatch({"type": "set_plugin_permission", "request_id": "b", "plugin": "nope",
                                   "level": "always_ask"})
        self.assertEqual(self.saved, [])
        refused = self.frames(harness, "command_rejected")
        self.assertEqual([r["request_id"] for r in refused], ["a", "b"])
        self.assertIn("move money", refused[0]["message"])
        self.assertIn("Settings", refused[1]["message"])

    def test_the_rows_say_each_plugins_level(self):
        from dgc import headless
        rows = headless.with_plugin_levels([{"name": "acme", "installed": True}, {"name": "paybox", "installed": True},
                                            {"name": "other", "installed": True}, {"name": "acme2"}], object())
        self.assertEqual(rows[0]["permission"], "always_ask")
        self.assertEqual((rows[1]["permission"], rows[1]["moves_money"]), ("important", True))
        self.assertNotIn("permission", rows[2], "no hosted server turned on: nothing for a level to act on")
        self.assertNotIn("permission", rows[3])


if __name__ == "__main__":
    unittest.main()
