"""Pips API 59 in the Python SDK: borrowing your own signed-in Chrome (list_pip_borrows, allow_pip_borrow,
decline_pip_borrow, stop_pip_borrow), known, refused before API 59, the card's id checked, then sent."""
import unittest

from tests.test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, READ_COMMANDS, MUTATION_COMMANDS

PIP = "pip_" + "b" * 32
BORROW = "pipborrow_" + "c" * 32
MUTATIONS = ("allow_pip_borrow", "decline_pip_borrow", "stop_pip_borrow")


class PipBorrowSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in ("list_pip_borrows",) + MUTATIONS:
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
        self.assertIn("list_pip_borrows", READ_COMMANDS)
        for command in MUTATIONS:
            self.assertIn(command, MUTATION_COMMANDS)
        self.assertFalse([c for c in COMMAND_FIELDS if "borrow" in c and "always" in c], "no Always allow for borrowing")

    def test_refused_before_api59_checked_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 58})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 59"):
            old.pips.read("list_pip_borrows", {"pip_id": PIP})
        for command in MUTATIONS:
            with self.assertRaisesRegex(DGCUnsupportedError, "API 59"):
                old.pips.mutate(command, {"pip_id": PIP, "borrow_id": BORROW}, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 59})
        for bad in ({"pip_id": PIP}, {"pip_id": PIP, "borrow_id": "pipborrow_x"}, {"pip_id": PIP, "borrow_id": BORROW, "always": True}):
            with self.assertRaises(DGCConfigError):
                current.pips.mutate("allow_pip_borrow", bad, approved=True)
        self.assertFalse(wire.calls)
        self.assertEqual(current.pips.read("list_pip_borrows", {"pip_id": PIP})["request"]["type"], "list_pip_borrows")
        for command in MUTATIONS:
            self.assertEqual(current.pips.mutate(command, {"pip_id": PIP, "borrow_id": BORROW}, approved=True)["request"]["borrow_id"],
                             BORROW)


if __name__ == "__main__":
    unittest.main()
