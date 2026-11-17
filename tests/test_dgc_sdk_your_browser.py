"""Pips API 105 in the Python SDK: Your Browser (get_your_browser; set_your_browser_site, sign_out_your_browser_site,
open_your_browser, use_your_browser_view), known with the runtime's own fields, refused before API 105, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS, READ_COMMANDS

READS = {"get_your_browser": {}}
MUTATIONS = {"set_your_browser_site": {"site": "example.com", "mode": "chosen", "pips": ["pip_" + "b" * 32]},
             "sign_out_your_browser_site": {"site": "example.com"},
             "open_your_browser": {"url": "example.com"},
             "use_your_browser_view": {"op": "click", "x": 10, "y": 20}}


class YourBrowserSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in (*READS, *MUTATIONS):
            with self.subTest(command=command):
                self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command])
        self.assertLessEqual(set(READS), READ_COMMANDS)
        self.assertLessEqual(set(MUTATIONS), MUTATION_COMMANDS)

    def test_refused_before_api105_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 104})
        for command, fields in READS.items():
            with self.assertRaisesRegex(DGCUnsupportedError, "API 105"):
                old.pips.read(command, fields)
        for command, fields in MUTATIONS.items():
            with self.assertRaisesRegex(DGCUnsupportedError, "API 105"):
                old.pips.mutate(command, fields, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 105})
        self.assertEqual(current.pips.read("get_your_browser", {})["request"]["type"], "get_your_browser")
        for command, fields in MUTATIONS.items():
            with self.subTest(command=command):
                self.assertEqual(current.pips.mutate(command, fields, approved=True)["request"]["type"], command)


if __name__ == "__main__":
    unittest.main()
