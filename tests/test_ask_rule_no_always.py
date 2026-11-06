"""A call the user's own ask rule asks about is asked every time: an allow rule never beats an ask rule (deny, then ask,
then allow), so the rule an "Always allow" would save could never stop the next ask. No Allow box offers it for such a
call: not the editor's card (permission_request.choices), not the TUI, not the classic terminal, not ACP. An "always"
sent anyway (an older editor) counts as once and saves no rule. A plugin's call in Work under MCPCall(...) is one such
call; the card bridge already did this for a card's own calls (mcp_apps.CardCalls.decide, "a rule")."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sdk/python"))

from test_subagents import Harness, fixture_config  # noqa: E402

from dgc import mcp_apps  # noqa: E402
from dgc.agent import Agent, asked_by_rule  # noqa: E402
from dgc.llm import ToolCall  # noqa: E402
from dgc.mcp import MCPManager  # noqa: E402


class AgentCard(unittest.TestCase):
    def harness(self, **config):
        directory = tempfile.TemporaryDirectory(prefix="dgc-ask-rule-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name), **config)
        self.addCleanup(harness.close)
        return harness

    def card(self, harness):
        return [f for f in harness.stream.frames() if f["type"] == "permission_request"][-1]

    def test_an_ask_rule_card_has_no_always_and_an_always_answer_counts_once(self):
        harness = self.harness(mode="auto")
        harness.config.permissions = {"allow": [], "ask": ["Bash(echo*)"], "deny": []}
        harness.answer("permission_request", {"decision": "always"})        # an older editor's Always
        out = harness.agent._handle_call(ToolCall("u1", "bash", {"command": "echo asked-by-rule"}))
        self.assertIn("asked-by-rule", out, "it ran once")
        self.assertEqual(self.card(harness)["choices"], ["once", "deny"])
        self.assertEqual(harness.config.permissions["allow"], [], "no rule that could never take effect was saved")

    def test_a_call_no_rule_asks_about_keeps_always(self):
        harness = self.harness(mode="default")
        harness.answer("permission_request", {"decision": "once"})
        harness.agent._handle_call(ToolCall("u1", "bash", {"command": "echo default-mode"}))
        self.assertEqual(self.card(harness)["choices"], ["once", "always", "deny"])
        harness.config.permissions = {"allow": [], "ask": ["Bash(rm*)"], "deny": []}
        harness.agent._handle_call(ToolCall("u2", "bash", {"command": "echo another"}))
        self.assertEqual(self.card(harness)["choices"], ["once", "always", "deny"], "a rule for something else")


class PluginCallInWork(unittest.TestCase):
    """The model's own call of a plugin's tool in Work, under MCPCall(mcp__<server>__<tool>)."""

    def setUp(self):
        from test_mcp_apps import CSP, PAGE, SERVER
        directory = tempfile.TemporaryDirectory(prefix="dgc-ask-rule-mcp-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name).resolve()
        home = patch.object(mcp_apps, "home", lambda: root / "mcp-apps")
        home.start()
        self.addCleanup(home.stop)
        script = root / "server.py"
        script.write_text(SERVER % (PAGE, CSP))
        self.manager = MCPManager(root)
        self.addCleanup(self.manager.stop_all)
        self.manager.connect_all({"board": {"command": sys.executable, "args": [str(script)]}})
        self.assertIn("board", self.manager.servers, self.manager.failures)
        self.harness = Harness(root, mode="default")
        self.addCleanup(self.harness.close)
        self.harness.agent = self.harness.backend.agent = Agent(self.harness.config, self.harness.ui, mcp=self.manager)
        self.harness.ui.cancelled = self.harness.agent.cancelled

    def ask(self, rules, answer):
        self.harness.config.permissions = rules
        self.harness.answer("permission_request", {"decision": answer})
        out = self.harness.agent._handle_call(ToolCall("u1", "mcp__board__move", {"to": "a1"}))
        card = [f for f in self.harness.stream.frames() if f["type"] == "permission_request"][-1]
        return card, out

    def test_its_card_has_no_always_under_an_ask_rule(self):
        card, out = self.ask({"allow": [], "ask": ["MCPCall(mcp__board__move)"], "deny": []}, "always")
        self.assertEqual(card["name"], "mcp__board__move")
        self.assertEqual(card["choices"], ["once", "deny"])
        self.assertIn("board move", out, "it ran once")
        self.assertEqual(self.harness.config.permissions["allow"], [])

    def test_with_the_rule_removed_always_is_back(self):
        card, _out = self.ask({"allow": [], "ask": [], "deny": []}, "once")
        self.assertEqual(card["choices"], ["once", "always", "deny"])


class TerminalBoxes(unittest.TestCase):
    """The terminal's Allow boxes read the same answer the agent gives the editor's card."""

    def tui(self, pick):
        from dgc.tui import TUI
        asked = []
        root = Path(tempfile.mkdtemp(prefix="dgc-ask-rule-"))
        stub = types.SimpleNamespace(
            config=fixture_config(root), deny_reason="", _flush_text=lambda: None, _append=lambda *_: None,
            _rich=lambda value: value, _cur_session=lambda: types.SimpleNamespace(workspace_path=root),
            _ask=lambda req, cancel=None, recheck=None: (asked.append(req), pick)[1],
            _ask_text=lambda prompt, cancel=None: "not now")
        verdict = TUI.approve_live(stub, "mcp__example__get-time", {}, "c1")
        return asked[0], verdict

    def test_the_tui_box(self):
        with asked_by_rule(True):
            req, verdict = self.tui(0)
            self.assertEqual(req["options"], ["Allow once", "Deny", "Deny with a reason"])
            self.assertNotIn("always", req["footer"].lower())
            self.assertEqual(verdict, "once")
            _, verdict = self.tui(1)
            self.assertEqual(verdict, "no", "the second row is Deny, never Always")
        req, verdict = self.tui(1)
        self.assertEqual(req["options"], ["Allow once", "Always allow this", "Deny", "Deny with a reason"])
        self.assertEqual(verdict, "always")

    def test_the_classic_terminal_menu(self):
        from dgc import cli
        shown = []
        ui = cli.UI.__new__(cli.UI)
        ui.console = types.SimpleNamespace(print=lambda *a, **k: None)
        ui.non_interactive = False
        ui.project_root = Path(tempfile.mkdtemp(prefix="dgc-ask-rule-"))
        ui.redact = lambda text: text
        ui._arg_summary = lambda name, args: ""
        ui._yield_stdin = lambda: None
        menu = lambda title, labels, hints=None, initial=0: (shown.append(labels), 1)[1]      # the second row
        with patch.object(cli, "menu_select", menu), patch.object(cli, "section", lambda *a, **k: None), \
                patch("builtins.input", lambda *_: ""):
            with asked_by_rule(True):
                self.assertEqual(ui.approve("mcp__example__get-time", {}), "no", "row two is deny")
            self.assertEqual(ui.approve("mcp__example__get-time", {}), "always")
        self.assertEqual(shown, [["allow once", "deny"], ["allow once", "always allow", "deny"]])

    def test_acp(self):
        from dgc.acp import _ACPUi
        sent = []
        server = types.SimpleNamespace(
            notify=lambda *a, **k: None,
            request=lambda method, params, **k: (sent.append(params), {"outcome": {"outcome": "selected",
                                                                                    "optionId": "once"}})[1])
        ui = _ACPUi(server, "s1", Path(tempfile.mkdtemp(prefix="dgc-ask-rule-")))
        with asked_by_rule(True):
            ui.approve("mcp__example__get-time", {})
        ui.approve("mcp__example__get-time", {})
        self.assertEqual([[o["optionId"] for o in params["options"]] for params in sent],
                         [["once", "deny"], ["once", "always", "deny"]])

    def test_the_terminal_card_page_says_money_only_for_a_payment_plugin(self):
        """The browser page a terminal opens for a card: under an ask rule its Allow box has no Always too, and it
        must not say the plugin can move money when the rule, not money, is why."""
        source = Path(mcp_apps.__file__).read_text(encoding="utf-8")
        self.assertIn('if (ask.money) {{ const n = document.createElement("p"); n.className = "note"; '
                      'n.textContent = "This plugin can move money, so it asks every time."', source)
        self.assertNotIn("if (!ask.always) {{ const n", source)


if __name__ == "__main__":
    unittest.main()
