"""Pips API 83 in the Python SDK: send_pip_message's optional reply_to (Reply on a Pip's message): known, refused before
API 83, checked, then sent."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk", "python"))
sys.path.insert(0, os.path.dirname(__file__))
from dgc_sdk import DGCConfigError, DGCUnsupportedError  # noqa: E402
from dgc_sdk.pips import COMMAND_FIELDS  # noqa: E402
from test_dgc_sdk_pips import CAPS, Wire, session  # noqa: E402

PIP, MESSAGE = "pip_" + "a" * 32, "message_" + "b" * 32
SEND = {"pip_id": PIP, "text": "The first one", "idempotency_key": "k1"}


class PipReplies(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_field(self):
        from dgc.pips import _COMMAND_ARGS
        self.assertEqual(COMMAND_FIELDS["send_pip_message"], _COMMAND_ARGS["send_pip_message"])
        self.assertIn("reply_to", COMMAND_FIELDS["send_pip_message"])

    def test_reply_to_is_refused_before_api83_checked_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 82})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 83"):
            old.pips.mutate("send_pip_message", {**SEND, "reply_to": MESSAGE}, approved=True)
        self.assertFalse(wire.calls)
        sent = old.pips.mutate("send_pip_message", SEND, approved=True)["request"]
        self.assertNotIn("reply_to", sent, "without one, an older runtime is asked as before")
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 83})
        sent = current.pips.mutate("send_pip_message", {**SEND, "reply_to": MESSAGE}, approved=True)["request"]
        self.assertEqual(sent["reply_to"], MESSAGE)
        for bad in ("the 9 am one", {"id": MESSAGE}, "message_" + "B" * 32):
            with self.assertRaises(DGCConfigError):
                current.pips.mutate("send_pip_message", {**SEND, "reply_to": bad}, approved=True)


if __name__ == "__main__":
    unittest.main()
