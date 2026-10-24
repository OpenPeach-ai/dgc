"""Pips API 53 in the Python SDK: how a Pip sees (get_pip_eyes / set_pip_eyes), where its steps acted
(list_pip_computer_frames' pointers) and the live view's cursor (use_pip_computer_view op "pointer")."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, READ_COMMANDS, MUTATION_COMMANDS


class PipEyesSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in ('get_pip_eyes', 'set_pip_eyes', 'list_pip_computer_frames', 'use_pip_computer_view'):
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
        self.assertIn('get_pip_eyes', READ_COMMANDS)
        self.assertIn('set_pip_eyes', MUTATION_COMMANDS)

    def test_refused_before_api53_checked_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 52})
        for call in (lambda s: s.pips.read('get_pip_eyes', {'pip_id': 'pip_a'}),
                     lambda s: s.pips.mutate('set_pip_eyes', {'pip_id': 'pip_a', 'choice': 'relay'}, approved=True),
                     lambda s: s.pips.read('list_pip_computer_frames', {'run_id': 'run_a', 'pointers': True}),
                     lambda s: s.pips.mutate('use_pip_computer_view', {'pip_id': 'pip_a', 'op': 'pointer'}, approved=True)):
            with self.assertRaisesRegex(DGCUnsupportedError, 'API 53'):
                call(old)
        self.assertFalse(wire.calls)
        old.pips.read('list_pip_computer_frames', {'run_id': 'run_a'})
        self.assertEqual(len(wire.calls), 1, 'what an older runtime knows still works')
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 53})
        with self.assertRaises(DGCConfigError):
            current.pips.mutate('set_pip_eyes', {'pip_id': 'pip_a', 'choice': 'always'}, approved=True)
        with self.assertRaises(DGCConfigError):
            current.pips.read('list_pip_computer_frames', {'run_id': 'run_a', 'pointers': 'yes'})
        self.assertFalse(wire.calls)
        self.assertEqual(current.pips.mutate('set_pip_eyes', {'pip_id': 'pip_a', 'choice': 'off'}, approved=True)['request']['choice'], 'off')
        self.assertIs(current.pips.read('list_pip_computer_frames', {'run_id': 'run_a', 'pointers': True})['request']['pointers'], True)
        self.assertEqual(current.pips.mutate('use_pip_computer_view', {'pip_id': 'pip_a', 'op': 'pointer'}, approved=True)['request']['op'], 'pointer')


if __name__ == '__main__':
    unittest.main()
