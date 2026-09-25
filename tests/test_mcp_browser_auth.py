"""Only the pinned bridge can request editor forwarding for its validated OAuth callback."""
import unittest
from urllib.parse import urlencode

from dgc.mcp import bridge_callback_url, sanitize_input_request, MCPInputError


class McpBrowserAuthTests(unittest.TestCase):
    def test_initialization_failure_keeps_redacted_stderr_after_readers_finish(self):
        from unittest.mock import patch
        from dgc.mcp import MCPServer
        server = MCPServer('fixture', 'unused', [], env={'VENDOR_TOKEN': 'private-fixture-token'},
                           remote_bridge=True)
        def finish_readers():
            server._append_diagnostic('Fatal error: registration failed; Authorization: Bearer private-fixture-token '
                                      'https://auth.example/authorize?code=private-code&state=private-state')
        with patch.object(server, '_launch', return_value=True), \
             patch.object(server, '_request', return_value=(None, 'server exited')), \
             patch.object(server, 'stop', side_effect=finish_readers):
            self.assertFalse(server.start())
        self.assertIn('server exited', server.error)
        self.assertIn('registration failed', server.error)
        for value in ('private-fixture-token', 'private-code', 'private-state'):
            self.assertNotIn(value, server.error)
        self.assertLessEqual(len(server.error), 1100)

    def test_exact_bridge_redirect_and_duplicate_rejection(self):
        for host in ("localhost", "127.0.0.1", "[::1]"):
            callback = f"http://{host}:43123/oauth/callback"
            url = "https://auth.example.invalid/authorize?" + urlencode({"redirect_uri": callback, "state": "fixture"})
            self.assertEqual(bridge_callback_url(url), callback)
            with self.assertRaises(MCPInputError):
                bridge_callback_url(url + "&" + urlencode({"redirect_uri": callback}))

    def test_external_or_malformed_callback_never_acquires_forwarding_authority(self):
        for callback in ("http://169.254.169.254:43123/oauth/callback", "https://localhost:43123/oauth/callback",
                         "http://localhost:0/oauth/callback", "http://localhost:99999/oauth/callback",
                         "http://localhost:43123/other", "http://localhost:43123/oauth/callback?token=fixture",
                         "http://user@localhost:43123/oauth/callback"):
            with self.subTest(callback=callback), self.assertRaises(MCPInputError):
                bridge_callback_url("https://auth.example.invalid/?" + urlencode({"redirect_uri": callback}))
        supplied = {"mode": "url", "message": "Open sign-in", "url": "https://auth.example.invalid/",
                    "_dgc_bridge_callback": "http://localhost:43123/oauth/callback"}
        self.assertNotIn("_dgc_bridge_callback", sanitize_input_request("elicitation/create", supplied))


class McpBrowserWaitTests(unittest.TestCase):
    def request_with_clock_jump(self, *, browser=True, method='initialize', cancelled=False):
        from unittest.mock import patch
        from dgc.mcp import MCPServer
        import threading
        server = MCPServer('fixture', 'unused', [], remote_bridge=browser)
        server.proc = object()
        server._browser_auth_generation = server._generation
        cancel = threading.Event()
        class Reply:
            calls = 0
            def wait(self, timeout):
                self.calls += 1
                if self.calls == 1:
                    if cancelled:
                        cancel.set()
                    return False
                _, holder, _ = next(iter(server._pending.values()))
                holder['result'] = {'ok': True}
                return True
        reply = Reply()
        lifecycle = threading.Event()
        with patch('dgc.mcp.threading.Event', side_effect=[reply, lifecycle]), \
             patch('dgc.mcp.time.monotonic', side_effect=[0, 0, 1000, 1000, 1000, 1000]), \
             patch.object(server, '_write_to', return_value=(True, None)):
            return server._request(method, {}, 10, cancel, modern=False)

    def test_browser_wait_outlives_startup_deadline(self):
        self.assertEqual(self.request_with_clock_jump(), ({'ok': True}, None))

    def test_browser_wait_still_cancels(self):
        self.assertEqual(self.request_with_clock_jump(cancelled=True), (None, 'cancelled by user'))

    def test_normal_mcp_and_tool_requests_keep_their_timeout(self):
        self.assertEqual(self.request_with_clock_jump(browser=False), (None, 'request timed out'))
        self.assertEqual(self.request_with_clock_jump(method='tools/call'), (None, 'request timed out'))


if __name__ == "__main__":
    unittest.main()
