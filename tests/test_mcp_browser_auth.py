"""Only the pinned bridge can request editor forwarding for its validated OAuth callback."""
import unittest
from urllib.parse import urlencode

from dgc.mcp import bridge_callback_url, sanitize_input_request, MCPInputError


class McpBrowserAuthTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
