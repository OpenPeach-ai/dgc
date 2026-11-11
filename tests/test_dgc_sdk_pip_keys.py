"""Pips API 82 in the Python SDK (pips-10): a Personal Pip's own API keys. list_pip_keys reads its cards (never a value);
save_pip_key, decline_pip_key and remove_pip_key answer one, only from a runtime advertising 82."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS, READ_COMMANDS

PIP = "pip_" + "a" * 32
KEY = "pipkey_" + "b" * 32


class PipKeysSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_commands_and_fields(self):
        from dgc.pips import _COMMAND_ARGS
        self.assertIn("list_pip_keys", READ_COMMANDS)
        for name in ("list_pip_keys", "save_pip_key", "decline_pip_key", "remove_pip_key"):
            self.assertEqual(COMMAND_FIELDS[name], _COMMAND_ARGS[name], name)
            if name != "list_pip_keys":
                self.assertIn(name, MUTATION_COMMANDS)

    def test_they_need_api82_and_a_key_id(self):
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 81})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 82"):
            old.pips.read("list_pip_keys", {"pip_id": PIP})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 82"):
            old.pips.mutate("save_pip_key", {"pip_id": PIP, "key_id": KEY, "value": "k"}, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 82})
        sent = current.pips.mutate("save_pip_key", {"pip_id": PIP, "key_id": KEY, "value": "inv_1"}, approved=True)["request"]
        self.assertEqual((sent["key_id"], sent["value"]), (KEY, "inv_1"))
        for bad in ({"key_id": "pipkey_x", "value": "k"}, {"key_id": KEY, "value": 1}, {"key_id": KEY, "value": "x" * 20000}):
            with self.assertRaises(DGCConfigError, msg=repr(bad)[:40]):
                current.pips.mutate("save_pip_key", {"pip_id": PIP, **bad}, approved=True)
        with self.assertRaises(DGCConfigError):
            current.pips.mutate("remove_pip_key", {"pip_id": PIP, "key_id": "nope"}, approved=True)
