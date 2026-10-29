"""The writer owns event sequence numbers, including across reattachments."""

import io
import json
import unittest

from dgc.protocol import Emitter


class ProtocolEnvelopeTests(unittest.TestCase):
    def test_caller_cannot_replace_sequence(self):
        output = io.StringIO()
        emitter = Emitter(output)
        with self.assertRaisesRegex(ValueError, "reserved"):
            emitter.emit("info", seq=99, message="spoofed")
        emitter.emit("info", message="real")
        self.assertEqual(json.loads(output.getvalue())["seq"], 0)

    def test_switch_cannot_replace_type_or_sequence(self):
        emitter = Emitter(io.StringIO())
        with self.assertRaisesRegex(ValueError, "reserved"):
            emitter.switch(io.StringIO(), first=[("info", {"type": "error", "message": "x"})])


if __name__ == "__main__":
    unittest.main()
