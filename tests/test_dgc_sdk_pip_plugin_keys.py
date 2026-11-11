"""Pips API 81 in the Python SDK (pips-10): a plugin card that needs a key takes it on Allow (`keys`), only from a runtime
advertising 81, as {variable name: text}; the SDK never sends one to an older runtime."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS

PIP = "pip_" + "a" * 32
GRANT = "pipplugin_" + "b" * 32


class PipPluginKeysSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        self.assertEqual(COMMAND_FIELDS["allow_pip_plugin"], _COMMAND_ARGS["allow_pip_plugin"])

    def test_keys_need_api81_and_their_shape(self):
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 80})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 81"):
            old.pips.mutate("allow_pip_plugin", {"pip_id": PIP, "grant_id": GRANT, "keys": {"AIRTABLE_TOKEN": "x"}}, approved=True)
        self.assertFalse(wire.calls)
        sent = old.pips.mutate("allow_pip_plugin", {"pip_id": PIP, "grant_id": GRANT}, approved=True)["request"]
        self.assertNotIn("keys", sent, "without a key, an older runtime is asked as before")
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 81})
        sent = current.pips.mutate("allow_pip_plugin", {"pip_id": PIP, "grant_id": GRANT, "keys": {"AIRTABLE_TOKEN": "pat_1"}},
                                   approved=True)["request"]
        self.assertEqual(sent["keys"], {"AIRTABLE_TOKEN": "pat_1"})
        for bad in ({"not a name": "x"}, {"OK": 1}, ["x"], {f"K{i}": "x" for i in range(9)}, {"K": "x" * 20000}):
            with self.assertRaises(DGCConfigError, msg=repr(bad)[:40]):
                current.pips.mutate("allow_pip_plugin", {"pip_id": PIP, "grant_id": GRANT, "keys": bad}, approved=True)
