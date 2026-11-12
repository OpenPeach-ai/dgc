"""DGC's plugins in Work on a subscription (pips-23): "Work on a subscription gets DGC's plugins through the same tool
bridge ChatDGC and Pips use, so @Composio works there. It's the CLI's normal, documented way of adding tools, so it
needs no warning."

A Work turn on Claude Code or Codex gets one more MCP server, dgc, beside the user's own: the plugin tools Work's own
model would be offered, served by pip_brain's ToolServer and relay; each call is answered by Work's own handler (DGC's
rules, approvals and rows), and the CLI's own row for it is left out so it shows once. The stand-in CLI
(tests/fake_subscription_cli.py) starts the relay it was given and talks MCP to it, as the real ones do.
"""
import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import subscription_bridge as bridge_mod, subscriptions
from tests.test_pip_brain import install_clis

GMAIL = {"type": "function", "function": {"name": "mcp__composio__GMAIL_FETCH_EMAILS", "description": "Fetch emails",
                                          "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}}}
OWN = {"type": "function", "function": {"name": "read_file", "description": "Read a file",
                                        "parameters": {"type": "object", "properties": {}}}}


class FakeAgent:
    def __init__(self, schemas):
        self.schemas, self.calls = schemas, []

    def _tool_schemas(self):
        return self.schemas

    def _handle_call(self, call):
        self.calls.append((call.name, call.arguments))
        return "3 new emails: an invoice from Acme, a note from Asha, a receipt."

    def _safe_text(self, text):
        return text


class World(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="dgc-plugins-"))
        home = self.base / "home"
        home.mkdir()
        patcher = patch.dict(os.environ, {"HOME": str(home)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.bin = install_clis(self)
        (self.bin / "script.json").write_text(json.dumps([
            {"call": "composio__GMAIL_FETCH_EMAILS", "args": {"query": "is:unread"}},
            {"say": "You have 3 new emails."}]))
        self.work = self.base / "project"
        self.work.mkdir()

    def turn(self, engine_key, agent):
        engine = subscriptions.get_engine(engine_key)
        with bridge_mod.Bridge(agent, engine_key) as bridge:
            result = subscriptions.run_turn(engine, "check my mail", self.work, env=bridge.env or None,
                                            extra_argv=bridge.argv, timeout=60)
            argv = list(bridge.argv)
        return result, argv, json.loads((self.bin / "seen.json").read_text())


class TheBridge(World):
    def test_claude_code_gets_dgcs_plugins_and_each_call_is_works_own(self):
        agent = FakeAgent([GMAIL, OWN])
        result, argv, seen = self.turn("claude", agent)
        self.assertTrue(result.get("ok"), result)
        self.assertIn("--mcp-config", argv)
        self.assertNotIn("--strict-mcp-config", seen["argv"], "added to the user's own servers, never instead of them")
        self.assertEqual(seen["servers"], ["dgc"])
        self.assertEqual(seen["tools"], ["composio__GMAIL_FETCH_EMAILS"], "plugin tools only; its own tools are its own")
        self.assertEqual(agent.calls, [("mcp__composio__GMAIL_FETCH_EMAILS", {"query": "is:unread"})])
        self.assertIn("3 new emails", seen["answers"][0]["text"])
        self.assertLess(seen["argv"].index("--mcp-config"), seen["argv"].index("--"), "its flags come before the prompt")
        self.assertEqual(seen["prompt"], "check my mail")

    def test_codex_gets_them_too(self):
        agent = FakeAgent([GMAIL])
        result, argv, seen = self.turn("codex", agent)
        self.assertTrue(result.get("ok"), result)
        self.assertIn("mcp_servers.dgc.command", seen["config"])
        self.assertEqual(seen["tools"], ["composio__GMAIL_FETCH_EMAILS"])
        self.assertEqual(agent.calls, [("mcp__composio__GMAIL_FETCH_EMAILS", {"query": "is:unread"})])

    def test_nothing_is_added_without_a_plugin_or_for_another_cli(self):
        with bridge_mod.Bridge(FakeAgent([OWN]), "claude") as bridge:
            self.assertEqual((bridge.argv, bridge.env), ([], {}))
        with bridge_mod.Bridge(FakeAgent([GMAIL]), "qwen") as bridge:
            self.assertEqual((bridge.argv, bridge.env), ([], {}))

    def test_the_socket_is_gone_after_the_turn(self):
        with bridge_mod.Bridge(FakeAgent([GMAIL]), "claude") as bridge:
            socket_path = Path(bridge.env["DGC_PIP_MCP_SOCKET"])
            self.assertTrue(socket_path.exists())
        self.assertFalse(socket_path.exists())


class OneRowEach(unittest.TestCase):
    def test_the_clis_own_row_for_a_plugin_call_is_left_out(self):
        drawn = []
        ui = types.SimpleNamespace(tool_call=lambda name, args, cid: drawn.append(("call", name)),
                                   tool_result=lambda name, out, cid: drawn.append(("result", name)),
                                   on_text=lambda t: None, info=lambda t: None)
        relay = subscriptions._Relay(types.SimpleNamespace(), ui, subscriptions.get_engine("claude"), "m")
        relay.on_event({"kind": "tool_call", "name": "mcp__dgc__composio__GMAIL_FETCH_EMAILS", "id": "u1", "args": {}})
        relay.on_event({"kind": "tool_result", "id": "u1", "output": "3 new emails"})
        relay.on_event({"kind": "tool_call", "name": "Bash", "id": "u2", "args": {"command": "ls"}})
        self.assertEqual(drawn, [("call", "Bash")], "Work's own handler draws the plugin call's row")
        self.assertEqual(len(relay.steps), 2, "both stay in the steps DGC keeps with its answer")


if __name__ == "__main__":
    unittest.main()
