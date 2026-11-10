"""Pips API 77 in the Python SDK: undo_pip_change, Undo on a change a Personal Pip made about itself at once in a turn
the user started. Known, refused before API 77, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS

PIP = "pip_" + "a" * 32
CHANGE = "own_" + "b" * 32


class PipOwnChangesSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        self.assertEqual(COMMAND_FIELDS['undo_pip_change'], _COMMAND_ARGS['undo_pip_change'])
        self.assertIn('undo_pip_change', MUTATION_COMMANDS)

    def test_refused_before_api77_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 76})
        with self.assertRaisesRegex(DGCUnsupportedError, 'API 77'):
            old.pips.mutate('undo_pip_change', {'pip_id': PIP, 'change_id': CHANGE}, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 77})
        sent = current.pips.mutate('undo_pip_change', {'pip_id': PIP, 'change_id': CHANGE}, approved=True)['request']
        self.assertEqual((sent['type'], sent['change_id']), ('undo_pip_change', CHANGE))


if __name__ == "__main__":
    unittest.main()
