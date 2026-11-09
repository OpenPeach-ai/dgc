"""Pips API 75 in the Python SDK: whether a Pip at Do it all may pay (get_pips_payments / set_pips_payments), known,
refused before API 75, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, READ_COMMANDS, MUTATION_COMMANDS


class PipPaymentsSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in ('get_pips_payments', 'set_pips_payments'):
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
        self.assertIn('get_pips_payments', READ_COMMANDS)
        self.assertIn('set_pips_payments', MUTATION_COMMANDS)

    def test_refused_before_api75_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 74})
        for call in (lambda s: s.pips.read('get_pips_payments', {}),
                     lambda s: s.pips.mutate('set_pips_payments', {'enabled': True}, approved=True)):
            with self.assertRaisesRegex(DGCUnsupportedError, 'API 75'):
                call(old)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 75})
        self.assertEqual(current.pips.read('get_pips_payments', {})['request']['type'], 'get_pips_payments')
        self.assertIs(current.pips.mutate('set_pips_payments', {'enabled': False}, approved=True)['request']['enabled'], False)


if __name__ == '__main__':
    unittest.main()
