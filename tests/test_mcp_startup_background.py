"""A chat opens without waiting for hosted MCP servers (plugins), and an unsigned one says so.

Found in real VS Code on 2026-10-07: with Granola installed but not signed in, every new chat said
"DGC is reconnecting to this chat" for good. Startup connected each hosted server in turn; Granola's
bridge waited for a sign-in nobody could give until its start deadline, past the editor's
10-second session request. Hosted servers now connect on a background thread, a turn waits a
little for them, and a bridge that asks for sign-in at startup stops at once.
"""
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import mcp
from dgc.mcp import MCPManager, MCPServer

REMOTE = {"transport": "remote", "command": "npx", "args": ["-y", "mcp-remote", "https://hosted.example/mcp"],
          "url": "https://hosted.example/mcp", "env_names": [], "log_level": "warning"}


class BackgroundStartupTests(unittest.TestCase):
    def test_hosted_servers_do_not_hold_a_new_chat(self):
        release = threading.Event()
        started = []

        def slow_start(server, timeout=10.0, cancel=None):
            started.append(server.name)
            release.wait(5)
            server.tools = [{"name": "get_markets", "inputSchema": {"type": "object"}}]
            server.proc = None
            return True

        manager = MCPManager(Path(tempfile.mkdtemp()))
        with patch.object(MCPServer, "start", slow_start):
            began = time.monotonic()
            manager.connect_all({"aave": dict(REMOTE)}, startup=True)
            self.assertLess(time.monotonic() - began, 1.0, "startup returns at once")
            self.assertIn({"name": "aave", "state": "connecting"},
                          [{k: row[k] for k in ("name", "state")} for row in manager.status()])
            release.set()
            self.assertTrue(manager.wait_background(5))
        self.assertIn("aave", manager.servers)
        self.assertIn("mcp__aave__get_markets", manager._routes, "its tools are routed once it connects")
        self.assertEqual(started, ["aave"])
        manager.stop_all()

    def test_local_servers_and_editor_connections_still_connect_in_place(self):
        calls = []
        with patch.object(MCPServer, "start", lambda server, timeout=10.0, cancel=None: calls.append(server.name) or False):
            manager = MCPManager(Path(tempfile.mkdtemp()))
            manager.connect_all({"local": {"command": sys.executable, "args": ["-c", "pass"]}}, startup=True)
            self.assertEqual(calls, ["local"], "a local server is connected before startup returns")
            manager.connect_all({"aave": dict(REMOTE)}, input_handler=lambda *a, **k: {"action": "cancel"})
            self.assertEqual(calls, ["local", "aave"], "a sign-in the user asked for is not deferred")
            self.assertTrue(manager.wait_background(1))

    def test_a_bridge_that_asks_for_sign_in_with_nobody_to_answer_stops_at_once(self):
        script = Path(tempfile.mkdtemp()) / "bridge.py"
        script.write_text(textwrap.dedent("""
            import sys, time
            sys.stderr.write("Please authorize this client by visiting:\\n")
            sys.stderr.write("https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A4242%2Foauth%2Fcallback\\n")
            sys.stderr.flush()
            time.sleep(30)
        """))
        server = MCPServer("granola", sys.executable, [str(script)], remote_bridge=True)
        began = time.monotonic()
        self.assertFalse(server.start(timeout=10))
        self.assertLess(time.monotonic() - began, 5, "not held until the start deadline")
        self.assertTrue(server._needs_sign_in)
        server.stop()

    def test_an_unsigned_server_is_named_as_needing_sign_in(self):
        def needs_sign_in(server, timeout=10.0, cancel=None):
            server._needs_sign_in = True
            return False
        manager = MCPManager(Path(tempfile.mkdtemp()))
        with patch.object(MCPServer, "start", needs_sign_in):
            manager.connect_all({"granola": dict(REMOTE)}, startup=True)
            self.assertTrue(manager.wait_background(5))
        self.assertEqual(manager.failures["granola"], "Needs sign-in. Connect it in Settings → Plugins.")


if __name__ == "__main__":
    unittest.main()
