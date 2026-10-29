"""A malformed LSP message must not strand a later valid response."""

import io
import json
import threading
import types
import unittest
from pathlib import Path

from dgc.codeintel import _LSPClient


def _frame(body):
    return f"Content-Length: {len(body)}\r\n\r\n".encode() + body


class LSPWireTests(unittest.TestCase):
    def test_bad_id_and_deep_json_do_not_stop_reader(self):
        wire = b"".join((
            _frame(json.dumps({"id": [], "result": 1}).encode()),
            _frame(b"{\"x\":" + b"[" * 10000 + b"0" + b"]" * 10000 + b"}"),
            _frame(json.dumps({"id": 1, "result": {"ok": True}}).encode()),
        ))
        client = _LSPClient({}, Path.cwd(), 1)
        client.proc = types.SimpleNamespace(stdout=io.BytesIO(wire))
        event, holder = threading.Event(), {}
        client._pending[1] = (event, holder)
        client._reader()
        self.assertTrue(event.is_set())
        self.assertEqual(holder["result"], {"ok": True})
