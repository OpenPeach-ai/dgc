"""Pips API 75 in the Python SDK: paying by itself, a rule per Pip (set_pip_paying, ask or allow) and the day's count
(get_pips_payments / set_pips_payments {limit}): known, checked, refused before API 75, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, READ_COMMANDS, MUTATION_COMMANDS


class PipPaymentsSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in ('get_pips_payments', 'set_pips_payments', 'set_pip_paying'):
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
        self.assertIn('get_pips_payments', READ_COMMANDS)
        self.assertEqual({'set_pips_payments', 'set_pip_paying'} & MUTATION_COMMANDS, {'set_pips_payments', 'set_pip_paying'})

    def test_refused_before_api75_checked_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 74})
        for call in (lambda s: s.pips.read('get_pips_payments', {}),
                     lambda s: s.pips.mutate('set_pips_payments', {'limit': 3}, approved=True),
                     lambda s: s.pips.mutate('set_pip_paying', {'pip_id': 'pip_1', 'rule': 'allow'}, approved=True)):
            with self.assertRaisesRegex(DGCUnsupportedError, 'API 75'):
                call(old)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 75})
        for fields in ({'pip_id': 'pip_1', 'rule': 'yes'}, {'pip_id': 'pip_1', 'rule': True}):
            with self.assertRaisesRegex(DGCConfigError, 'ask or allow'):
                current.pips.mutate('set_pip_paying', fields, approved=True)
        for limit in (True, '3', 2.5):
            with self.assertRaisesRegex(DGCConfigError, 'whole number'):
                current.pips.mutate('set_pips_payments', {'limit': limit}, approved=True)
        self.assertFalse(wire.calls)
        self.assertEqual(current.pips.read('get_pips_payments', {})['request']['type'], 'get_pips_payments')
        self.assertEqual(current.pips.mutate('set_pips_payments', {'limit': 5}, approved=True)['request']['limit'], 5)
        self.assertEqual(current.pips.mutate('set_pip_paying', {'pip_id': 'pip_1', 'rule': 'allow'}, approved=True)['request']['rule'], 'allow')


if __name__ == '__main__':
    unittest.main()
