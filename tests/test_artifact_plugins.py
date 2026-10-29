"""A dashboard source that reads a plugin calls only tools that read, through the user's own signed-in plugin."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_dashboard, artifact_plugins

INFO = {"plugin": "shop", "display_name": "Shop", "servers": {"shop": {}}, "reads": [], "money": False}


class Manager:
    def __init__(self):
        self.calls = []

    def call(self, route, args, cancel=None, input_handler=None):
        self.calls.append((route, args))
        if route == "shop__broken":
            return json.dumps({"isError": True, "content": [{"type": "text", "text": "rate limited"}]})
        return json.dumps({"orders": [{"region": "North", "total": 120}, {"region": "South", "total": 80}]})


class FakePlugins:
    def __init__(self):
        self.manager = Manager()
        self.closed = False

    def available(self):
        return {"shop": INFO}

    def tools(self, name, info):
        row = lambda tool, read: {"name": tool, "annotations": {"readOnlyHint": read}}   # noqa: E731
        return {tool: ("shop", row(tool, read), {"_route": f"shop__{tool}"}, self.manager)
                for tool, read in (("list_orders", True), ("refund_order", False), ("broken", True))}

    def close(self):
        self.closed = True


class PluginSources(unittest.TestCase):
    def setUp(self):
        self.plugins = FakePlugins()
        self.call, self.is_read_only, self.close = artifact_plugins.hooks(None, plugins=self.plugins)

    def test_a_read_only_tool_runs_and_its_rows_come_back(self):
        names, rows, more = artifact_dashboard.run_plugin(
            {"server": "shop"}, {"tool": "list_orders", "args": {"days": 7}, "path": "orders"},
            call=self.call, is_read_only=self.is_read_only)
        self.assertEqual(names, ["region", "total"])
        self.assertEqual(len(rows), 2)
        self.assertEqual(self.plugins.manager.calls, [("shop__list_orders", {"days": 7})])

    def test_a_tool_that_changes_anything_is_never_called(self):
        with self.assertRaises(artifact_dashboard.DashboardError):
            artifact_dashboard.run_plugin({"server": "shop"}, {"tool": "refund_order", "args": {"id": 1}},
                                          call=self.call, is_read_only=self.is_read_only)
        with self.assertRaises(ValueError):
            self.call("shop", "refund_order", {"id": 1})       # asked again at the call itself
        self.assertEqual(self.plugins.manager.calls, [])

    def test_a_plugins_error_answer_is_a_failure_and_an_unknown_plugin_says_so(self):
        with self.assertRaises(artifact_dashboard.DashboardError):
            artifact_dashboard.run_plugin({"server": "shop"}, {"tool": "broken", "args": {}},
                                          call=self.call, is_read_only=self.is_read_only)
        self.assertFalse(self.is_read_only("shop", "refund_order"))
        self.assertFalse(self.is_read_only("shop", "no_such_tool"))
        with self.assertRaises(ValueError):
            self.call("github", "list_issues", {})
        self.close()
        self.assertTrue(self.plugins.closed)


if __name__ == "__main__":
    unittest.main()
