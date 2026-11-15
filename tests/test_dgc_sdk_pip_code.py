"""Pips API 98 in the Python SDK: the code card (fill_pip_code), known with the runtime's own fields, refused before
API 98, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS

PIP = "pip_" + "b" * 32
ACTION = "compact_" + "c" * 32
REQUEST = {"pip_id": PIP, "action_id": ACTION, "expected_digest": "d" * 64, "code": "482913"}


class PipCodeSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        self.assertEqual(COMMAND_FIELDS["fill_pip_code"], _COMMAND_ARGS["fill_pip_code"])
        self.assertIn("fill_pip_code", MUTATION_COMMANDS)

    def test_refused_before_api98_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 97})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 98"):
            old.pips.mutate("fill_pip_code", REQUEST, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 98})
        self.assertEqual(current.pips.mutate("fill_pip_code", REQUEST, approved=True)["request"]["type"], "fill_pip_code")


if __name__ == "__main__":
    unittest.main()
