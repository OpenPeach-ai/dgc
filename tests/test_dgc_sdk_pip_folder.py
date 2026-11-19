"""Pips API 110 in the Python SDK: give a Pip a folder later, and remove its folder (give_pip_folder, remove_pip_folder),
known with the runtime's own fields, refused before API 110, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS

GIVE = {"pip_id": "pip_" + "b" * 32, "folder": "/home/me/shop", "dry_run": True}
REMOVE = {"pip_id": "pip_" + "b" * 32}


class PipFolderSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in ("give_pip_folder", "remove_pip_folder"):
            with self.subTest(command=command):
                self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command])
                self.assertIn(command, MUTATION_COMMANDS)

    def test_refused_before_api110_then_sent(self):
        for command, fields in (("give_pip_folder", GIVE), ("remove_pip_folder", REMOVE)):
            with self.subTest(command=command):
                wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 109})
                with self.assertRaisesRegex(DGCUnsupportedError, "API 110"):
                    old.pips.mutate(command, fields, approved=True)
                self.assertFalse(wire.calls)
                wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 110})
                sent = current.pips.mutate(command, fields, approved=True)
                self.assertEqual(sent["request"]["type"], command)


if __name__ == "__main__":
    unittest.main()
