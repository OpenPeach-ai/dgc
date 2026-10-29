"""Corrupt saved Pip context measures cannot crash the context meter."""
import json
import unittest
from types import SimpleNamespace

from dgc import pip_chat_breakdown as breakdown
from dgc.workspace_registry import RegistryError


class BreakdownInvalidTests(unittest.TestCase):
    def test_unhashable_part_id_is_a_validation_error(self):
        value = {"version": 1, "parts": [{"id": [], "label": "Tools", "tokens": 1}]}
        with self.assertRaises(RegistryError):
            breakdown.validate(value)

    def test_saved_unhashable_part_id_shows_no_stale_measure(self):
        result = json.dumps({"context": {"version": 1, "parts": [
            {"id": [], "label": "Tools", "tokens": 1}]}})
        store = SimpleNamespace(db=SimpleNamespace(execute=lambda *_: SimpleNamespace(
            fetchone=lambda: {"result": result})))
        self.assertEqual(breakdown.last_parts(store, "pip_example"), [])


if __name__ == "__main__":
    unittest.main()
