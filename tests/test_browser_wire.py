"""Malformed DevTools websocket messages fail as browser errors."""

import struct
import unittest

from dgc.browser import BrowserError, _WebSocket


class _Socket:
    def __init__(self, data):
        self.data = data

    def recv(self, count):
        chunk, self.data = self.data[:count], self.data[count:]
        return chunk


def _reader(payload, opcode=1):
    size = len(payload)
    header = bytes([0x80 | opcode, 126]) + struct.pack(">H", size) if size >= 126 else bytes([0x80 | opcode, size])
    reader = object.__new__(_WebSocket)
    reader._sock = _Socket(header + payload)
    return reader


class BrowserWireTests(unittest.TestCase):
    def test_non_object_message_is_browser_error(self):
        with self.assertRaisesRegex(BrowserError, "non-object"):
            _reader(b"[]").recv()

    def test_deep_message_is_browser_error(self):
        with self.assertRaisesRegex(BrowserError, "unreadable JSON"):
            _reader(b"{\"x\":" + b"[" * 10000 + b"0" + b"]" * 10000 + b"}").recv()

    def test_oversized_ping_is_browser_error(self):
        with self.assertRaisesRegex(BrowserError, "oversized ping"):
            _reader(b"x" * 126, opcode=9).recv()
