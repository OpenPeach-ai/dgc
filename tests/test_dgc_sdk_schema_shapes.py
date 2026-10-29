"""Malformed output schemas fail at configuration time in the Python SDK."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sdk" / "python"))

from dgc_sdk.errors import DGCConfigError  # noqa: E402
from dgc_sdk.schema import assert_supported, validate  # noqa: E402


class SchemaShapesTest(unittest.TestCase):
    def test_bad_shapes_are_rejected(self):
        invalid = [
            {"type": "object", "properties": []},
            {"type": "object", "properties": {"x": None}},
            {"type": "array", "items": "string"},
            {"type": "object", "additionalProperties": None},
            {"type": "object", "required": [None]},
            {"type": "object", "enum": "x"},
            {"type": "string", "minLength": None},
            {"type": "string", "maxLength": -1},
            {"type": "number", "minimum": float("nan")},
            {"type": "number", "maximum": 10 ** 1000},
            {"type": ["string", "unknown"]},
            {"type": None},
            {"description": False},
            {"default": float("nan")},
            {"enum": [object()]},
            {1: "value"},
        ]
        for schema in invalid:
            with self.subTest(schema=schema), self.assertRaises(DGCConfigError):
                assert_supported(schema)

    def test_cycle_and_depth_are_rejected(self):
        cycle = {"type": "array"}
        cycle["items"] = cycle
        with self.assertRaises(DGCConfigError):
            assert_supported(cycle)
        deep = {"type": "string"}
        for _ in range(65):
            deep = {"items": deep}
        with self.assertRaises(DGCConfigError):
            assert_supported(deep)

    def test_valid_nested_subset(self):
        schema = {"type": "object", "properties": {"x": {"type": "string", "minLength": 1}},
                  "additionalProperties": {"type": "number", "minimum": 0}}
        assert_supported(schema)
        self.assertEqual(validate({"x": "ok", "y": 2}, schema), [])


if __name__ == "__main__":
    unittest.main()
