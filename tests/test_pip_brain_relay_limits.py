"""The isolated Pip MCP relay must bound each request before forwarding it."""
import io
import socket
import unittest

from dgc import pip_brain_relay


class Link:
    def __init__(self):
        self.sent = []
        self.shutdown_how = None

    def sendall(self, data):
        self.sent.append(data)

    def shutdown(self, how):
        self.shutdown_how = how


class PipBrainRelayLimitsTests(unittest.TestCase):
    def test_forwards_normal_lines_and_shuts_down_write_side(self):
        link = Link()
        pip_brain_relay.upstream(io.BytesIO(b'{"id":1}\n{"id":2}'), link)
        self.assertEqual(link.sent, [b'{"id":1}\n', b'{"id":2}\n'])
        self.assertEqual(link.shutdown_how, socket.SHUT_WR)

    def test_oversized_line_is_rejected_before_forwarding(self):
        link = Link()
        pip_brain_relay.upstream(io.BytesIO(b'x' * (pip_brain_relay.MAX_REQUEST + 1) + b'\n{"id":2}\n'), link)
        self.assertEqual(link.sent, [])
        self.assertEqual(link.shutdown_how, socket.SHUT_WR)


if __name__ == "__main__":
    unittest.main()
