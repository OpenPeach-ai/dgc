"""A completed plugin sign-in reaches chats that tried before credentials existed."""
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from dgc import plugins, headless
from tests import test_host as host_fixture


class PluginConnectRefresh(unittest.TestCase):
    setUp = host_fixture.HostTest.setUp
    second_chat = host_fixture.HostTest.second_chat

    def test_open_chat_retries_after_sign_in_finishes_without_restarting_other_servers(self):
        owner = self.host.default
        owner.config.set("mcp_servers", {"existing": {"command": "fixture"}})
        with patch("dgc.mcp.MCPManager.connect_all"):
            peer = self.second_chat()
        authorized = threading.Event()
        initial_attempt = threading.Event()
        refreshed = threading.Event()
        calls = []
        spec = {"transport": "remote", "command": "npx", "args": ["-y", "mcp-remote", "https://plugin.invalid/mcp"],
                "url": "https://plugin.invalid/mcp", "env_names": []}
        record = {"name": "demo"}
        class Manager:
            def __init__(self):
                self.servers = {"existing": object()}
                self.failures = {}
                self.disabled_names = set()
                self._runtime_specs = {"existing": {"command": "fixture"}}
            def stop_all(self):
                self.servers.clear()
            def disconnect(self, name):
                raise AssertionError("an unrelated connected server must not restart")
            def unchanged(self, name, saved, runtime):
                return name in self.servers
            def connect_all(self, specs, **kwargs):
                calls.append(set(specs))
                if authorized.is_set():
                    self.servers["demo"] = object()
                    self.failures.pop("demo", None)
                    refreshed.set()
                else:
                    self.failures["demo"] = "Needs sign-in"
                    initial_attempt.set()
        peer.agent.mcp.stop_all()
        peer.agent.mcp = Manager()
        peer.agent._mode_prompt_dirty = False
        owner.agent.mcp.stop_all()
        owner.agent.mcp = SimpleNamespace(servers={}, failures={}, stop_all=lambda: None)
        existing = peer.agent.mcp.servers["existing"]
        def connect(config, manager, _record, **kwargs):
            config.set("mcp_servers", {"existing": {"command": "fixture"}, "demo": spec})
            self.assertTrue(initial_attempt.wait(3), "the peer tried while sign-in was pending")
            authorized.set()
            manager.servers["demo"] = object()
        with patch.object(plugins, "_installed", return_value=[record]), \
                patch.object(plugins, "record_servers", return_value={"demo": spec}), \
                patch.object(plugins, "connect", side_effect=connect), \
                patch.object(owner, "_editor_plugins", return_value=[]):
            terminal = owner._install_plugin({"name": "demo", "request_id": "connect-demo"})
            terminal()
            self.assertTrue(refreshed.wait(3), "successful sign-in must refresh the already-open peer chat")
        self.assertEqual(calls, [{"demo"}, {"demo"}])
        self.assertIs(peer.agent.mcp.servers["existing"], existing)
        with peer._catalog_refresh_lock:
            self.assertTrue(peer.agent._mode_prompt_dirty, "the next model request must see the connected state")

    def test_completed_sign_in_does_not_enable_disabled_or_setup_only_servers(self):
        specs = {"disabled": {"command": "fixture"}, "setup": {"command": "fixture", "defer_until_setup": True},
                 "private": {"command": "fixture", "env_names": ["DGC_TEST_EDITOR_ONLY_SECRET"]},
                 "unrelated": {"command": "fixture"}}
        data = {"mcp_servers": specs, "disabled_mcp_servers": ["disabled"]}
        manager = SimpleNamespace(servers={}, disabled_names=set(), _runtime_specs={},
                                  connect_all=Mock(), disconnect=Mock())
        chat = SimpleNamespace(config=SimpleNamespace(get=data.get), agent=SimpleNamespace(mcp=manager))
        with patch.dict("os.environ", {}, clear=True):
            headless.Host._refresh_catalogs(chat, {"mcp_servers"}, frozenset({"disabled", "setup", "private"}))
        manager.connect_all.assert_not_called()
        manager.disconnect.assert_not_called()
        self.assertEqual(manager.disabled_names, {"disabled"})

    def test_only_successfully_connected_servers_are_announced(self):
        backend = object.__new__(headless.Backend)
        backend.agent = SimpleNamespace(mcp=SimpleNamespace(servers={"ready": object()}), _mode_prompt_dirty=False)
        backend._host = SimpleNamespace(mcp_connected=Mock())
        backend._mcp_connections_changed({"failed"})
        backend._host.mcp_connected.assert_not_called()
        self.assertFalse(backend.agent._mode_prompt_dirty)
        backend._mcp_connections_changed({"ready", "failed"})
        backend._host.mcp_connected.assert_called_once_with(backend, {"ready"})
        self.assertTrue(backend.agent._mode_prompt_dirty)


if __name__ == "__main__":
    unittest.main()
