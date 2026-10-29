"""Malformed in-process protocol values should return validation errors."""

import unittest

from dgc.editor_protocol import command_error, event_error


class ProtocolUntrustedValuesTests(unittest.TestCase):
    def test_non_string_field_names(self):
        self.assertEqual(command_error({"type": "ping", 1: "extra"}),
                         "message field names must be strings")
        self.assertEqual(event_error({"type": "ready", "seq": 0, 1: "extra"}),
                         "message field names must be strings")

    def test_giant_integer_type(self):
        self.assertIn("unknown message type", command_error({"type": 10 ** 5000}))


if __name__ == "__main__":
    unittest.main()
