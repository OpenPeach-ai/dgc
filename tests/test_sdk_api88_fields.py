"""Pips API 88 in the Python SDK: the two fields that came with it inside existing commands are refused before 88.

set_pip_profile's `changes.group` (a folder in the Personal list) and use_pip_computer_view's op `close` (its tab
closed): an older runtime would refuse each with its own words, so the SDK says so first, as it does for op `pointer`
before 53. start_pip_app_link's `another` is older (0.51, API 74) and still goes to such a runtime
(TypeScript: tests/test_dgc_sdk_api88_fields.mjs).
"""
import sys
import unittest

sys.path.insert(0, "sdk/python")
sys.path.insert(0, "tests")

PIP = "pip_" + "a" * 32
LINK = "piplink_" + "b" * 32
SENDS = (
    ("set_pip_profile", {"pip_id": PIP, "changes": {"group": "Home"}}),
    ("use_pip_computer_view", {"pip_id": PIP, "op": "close"}),
)


class Api88Fields(unittest.TestCase):
    def setUp(self):
        from test_dgc_sdk_pips import CAPS, Wire, session
        self.CAPS, self.Wire, self.session = CAPS, Wire, session

    def test_refused_before_88_and_nothing_sent(self):
        from dgc_sdk import DGCUnsupportedError
        wire = self.Wire(); old = self.session(wire, caps={**self.CAPS, "pips_api_version": 87})
        for command, values in SENDS:
            with self.subTest(command=command), self.assertRaisesRegex(DGCUnsupportedError, "API 88"):
                old.pips.mutate(command, values, approved=True)
        self.assertFalse(wire.calls)

    def test_sent_from_88(self):
        wire = self.Wire(); now = self.session(wire, caps={**self.CAPS, "pips_api_version": 88})
        for command, values in SENDS:
            with self.subTest(command=command):
                sent = now.pips.mutate(command, values, approved=True)["request"]
                self.assertEqual({k: sent[k] for k in values}, values)

    def test_the_same_commands_without_them_still_go_to_an_older_runtime(self):
        wire = self.Wire(); old = self.session(wire, caps={**self.CAPS, "pips_api_version": 87})
        old.pips.mutate("start_pip_app_link", {"pip_id": PIP, "link_id": LINK}, approved=True)
        old.pips.mutate("set_pip_profile", {"pip_id": PIP, "changes": {"title": "Errands"}}, approved=True)
        old.pips.mutate("use_pip_computer_view", {"pip_id": PIP, "op": "frame"}, approved=True)
        self.assertEqual(len(wire.calls), 3)

    def test_another_is_older_and_still_reaches_a_051_runtime(self):
        wire = self.Wire(); old = self.session(wire, caps={**self.CAPS, "pips_api_version": 74})
        sent = old.pips.mutate("start_pip_app_link", {"pip_id": PIP, "link_id": LINK, "another": True}, approved=True)["request"]
        self.assertIs(sent["another"], True)


if __name__ == "__main__":
    unittest.main()
