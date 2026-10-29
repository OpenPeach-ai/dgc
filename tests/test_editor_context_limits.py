"""Untrusted editor resources must always become bounded, valid UTF-8 JSON."""
import json
import unittest

from dgc.editor_context import _format_editor_context


class EditorContextLimitsTests(unittest.TestCase):
    def payload(self, resources):
        framed = _format_editor_context(resources)
        self.assertTrue(framed.startswith('<editor-context-json trust="untrusted-reference-data">\n'))
        raw = framed.split('\n', 1)[1].split('\n</editor-context-json>', 1)[0]
        raw.encode('utf-8')
        return json.loads(raw, parse_constant=lambda value: self.fail(f'invalid JSON number {value}'))

    def test_nonfinite_numbers_remain_valid_json(self):
        payload = self.payload([{"type": "mcp_context", "diagnostics": [{"confidence": float("nan")},
                                                                          {"confidence": float("inf")}]}])
        self.assertEqual(payload[0]["diagnostics"], [{"confidence": None}, {"confidence": None}])

    def test_lone_surrogate_cannot_break_size_or_output_encoding(self):
        payload = self.payload([{"type": "file_attachment", "text": "normal \ud800 text"}])
        self.assertIn("normal", payload[0]["text"])


if __name__ == "__main__":
    unittest.main()
