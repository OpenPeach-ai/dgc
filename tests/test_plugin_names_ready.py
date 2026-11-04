"""A plugin's name, the same on its card and on the editor's Allow card for one of its tools. The Allow card named the
plugin by its server ("Use Get time from Example?") while the card said "MCP Apps example": the editor knew the names
only once Settings had loaded the plugin list. The handshake now carries them (ready.capabilities.plugin_names, a new
key in a free-form object: no event gains a field), by the server name a tool carries (mcp__<server>__<tool>)."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sdk/python"))

from test_subagents import Harness  # noqa: E402

from dgc import editor_protocol as ep, plugins  # noqa: E402

EXAMPLE = {"transport": "remote", "command": "npx", "args": ["-y", "mcp-remote", "https://localhost:18543/mcp"],
           "url": "https://localhost:18543/mcp"}


def installed(path: Path, rows: list) -> None:
    path.write_text(json.dumps({"installed": rows, "permissions": {}}))


class PluginNames(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-plugin-names-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.state = self.root / "installed.json"
        patcher = patch.object(plugins, "STATE_PATH", self.state)
        patcher.start()
        self.addCleanup(patcher.stop)
        installed(self.state, [
            {"name": "apps-example", "display_name": "MCP Apps example", "servers": {"example": EXAMPLE},
             "registered_specs": {"example": EXAMPLE}},
            {"name": "notes-test", "display_name": "  Notes   (test) ", "servers": {"notes.local": {"command": "notes"}}},
            {"name": "plain", "servers": {"plain": {"command": "plain"}}}])

    def test_each_server_by_the_name_its_tools_carry(self):
        self.assertEqual(plugins.server_display_names(),
                         {"example": "MCP Apps example", "notes_local": "Notes (test)", "plain": "plain"})

    def test_an_unreadable_list_names_nothing(self):
        with patch.object(plugins, "_installed", side_effect=OSError("unreadable")):
            self.assertEqual(plugins.server_display_names(), {})

    def test_the_handshake_carries_them_and_still_validates(self):
        harness = Harness(self.root)
        self.addCleanup(harness.close)
        backend = harness.backend
        backend._queue, backend._steer_payloads, backend.workspace_trusted = [], {}, True
        ready = backend._ready_payload()
        self.assertEqual(ready["capabilities"]["plugin_names"]["example"], "MCP Apps example")
        self.assertIsNone(ep.event_error({"type": "ready", "seq": 0, **ready}))
        self.assertNotIn("plugin_names", ep.EVENT_FIELDS["ready"], "a capability, not a new field of the event")


if __name__ == "__main__":
    unittest.main()
