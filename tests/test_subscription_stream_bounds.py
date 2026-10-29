"""Malformed vendor JSONL is discarded without ending the delegated turn."""

import unittest

from dgc.subscriptions import parse_stream_events


class SubscriptionStreamBoundsTests(unittest.TestCase):
    def test_deep_json_line_is_discarded(self):
        line = '{"x":' + '[' * 10000 + '0' + ']' * 10000 + '}'
        self.assertEqual(parse_stream_events("codex", line), [])
