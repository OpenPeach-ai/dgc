"""Pips API 54 in the Python SDK: a Pip computer's apps (get_pip_computer_apps / set_pip_computer_apps), known,
refused before API 54, checked, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, READ_COMMANDS, MUTATION_COMMANDS


class PipDesktopSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in ('get_pip_computer_apps', 'set_pip_computer_apps'):
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
        self.assertIn('get_pip_computer_apps', READ_COMMANDS)
        self.assertIn('set_pip_computer_apps', MUTATION_COMMANDS)

    def test_refused_before_api54_checked_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 53})
        for call in (lambda s: s.pips.read('get_pip_computer_apps', {}),
                     lambda s: s.pips.mutate('set_pip_computer_apps', {'choice': 'download'}, approved=True)):
            with self.assertRaisesRegex(DGCUnsupportedError, 'API 54'):
                call(old)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 54})
        with self.assertRaises(DGCConfigError):
            current.pips.mutate('set_pip_computer_apps', {'choice': 'always'}, approved=True)
        self.assertFalse(wire.calls)
        self.assertEqual(current.pips.read('get_pip_computer_apps', {})['request']['type'], 'get_pip_computer_apps')
        self.assertEqual(current.pips.mutate('set_pip_computer_apps', {'choice': 'not_now'}, approved=True)['request']['choice'], 'not_now')


if __name__ == '__main__':
    unittest.main()
