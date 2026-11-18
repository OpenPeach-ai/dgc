"""Pips API 108 in the Python SDK: Save to Library on a picture in a Pip's chat (library_pip_message_image), known with
the runtime's own fields, refused before API 108, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS

FIELDS = {"pip_id": "pip_" + "b" * 32, "message_id": "msg_" + "c" * 32, "index": 0, "keep": True}


class PictureLibrarySDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        self.assertEqual(COMMAND_FIELDS["library_pip_message_image"], _COMMAND_ARGS["library_pip_message_image"])
        self.assertIn("library_pip_message_image", MUTATION_COMMANDS)

    def test_refused_before_api106_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 107})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 108"):
            old.pips.mutate("library_pip_message_image", FIELDS, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 108})
        sent = current.pips.mutate("library_pip_message_image", FIELDS, approved=True)
        self.assertEqual(sent["request"]["type"], "library_pip_message_image")


if __name__ == "__main__":
    unittest.main()
