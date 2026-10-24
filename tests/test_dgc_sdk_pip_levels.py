"""Pips API 58 in the Python SDK: how much a Personal Pip asks (get_pip_level, set_pip_level), known, refused before
API 58, its level checked, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, READ_COMMANDS, MUTATION_COMMANDS

PIP = "pip_" + "b" * 32


class PipLevelSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in ('get_pip_level', 'set_pip_level'):
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
        self.assertIn('get_pip_level', READ_COMMANDS)
        self.assertIn('set_pip_level', MUTATION_COMMANDS)

    def test_refused_before_api58_checked_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 57})
        for call in (lambda s: s.pips.read('get_pip_level', {'pip_id': PIP}),
                     lambda s: s.pips.mutate('set_pip_level', {'pip_id': PIP, 'level': 'full'}, approved=True)):
            with self.assertRaisesRegex(DGCUnsupportedError, 'API 58'):
                call(old)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 58})
        for bad in ({'pip_id': PIP, 'level': 'yolo'}, {'pip_id': PIP}, {'pip_id': PIP, 'level': 'full', 'why': 'x'}):
            with self.assertRaises(DGCConfigError):
                current.pips.mutate('set_pip_level', bad, approved=True)
        self.assertFalse(wire.calls)
        self.assertEqual(current.pips.read('get_pip_level', {'pip_id': PIP})['request']['type'], 'get_pip_level')
        self.assertEqual(current.pips.mutate('set_pip_level', {'pip_id': PIP, 'level': 'approve'}, approved=True)['request']['level'],
                         'approve')


if __name__ == '__main__':
    unittest.main()
