"""The public MCP catalog must not echo runtime or legacy argv credentials."""

import json
import unittest

from dgc.mcp_config import public_mcp_spec


class PublicMcpProjectionTests(unittest.TestCase):
    def test_secret_flag_and_value_are_hidden_together(self):
        shown = public_mcp_spec({"command": "npx", "args": ["-y", "tool", "--api-key", "private-value"]})
        self.assertEqual(shown["args"], [])
        self.assertNotIn("private-value", json.dumps(shown))

    def test_safe_argv_stays_visible(self):
        shown = public_mcp_spec({"command": "npx", "args": ["-y", "safe-mcp"]})
        self.assertEqual(shown["args"], ["-y", "safe-mcp"])


if __name__ == "__main__":
    unittest.main()
