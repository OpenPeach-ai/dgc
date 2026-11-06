"""Pips API 72 exposes the same bounded local workflow controls to SDK hosts."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, READ_COMMANDS, MUTATION_COMMANDS
from dgc.pips import _COMMAND_ARGS

PIPS = ['pip_' + letter * 32 for letter in 'abc']


class PipFlowSDKTests(unittest.TestCase):
    def test_fields_and_version_gate_match_runtime(self):
        for command in ('list_pip_flows', 'get_pip_flow', 'create_pip_flow', 'set_pip_flow'):
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command])
        self.assertTrue({'list_pip_flows', 'get_pip_flow'} <= READ_COMMANDS)
        self.assertTrue({'create_pip_flow', 'set_pip_flow'} <= MUTATION_COMMANDS)
        wire = Wire()
        old = session(wire, caps={**CAPS, 'pips_api_version': 71})
        with self.assertRaisesRegex(DGCUnsupportedError, 'API 72'):
            old.pips.read('list_pip_flows', {'workspace_id': 'ws_' + 'a' * 32})
        with self.assertRaisesRegex(DGCUnsupportedError, 'API 72'):
            old.pips.mutate('create_pip_flow', {'name': 'Daily', 'pip_ids': PIPS,
                'tasks': ['Write', 'Illustrate'], 'mode': 'reviewed'}, approved=True)
        self.assertFalse(wire.calls)

    def test_reviewed_and_unattended_have_exact_shapes(self):
        wire = Wire()
        current = session(wire, caps={**CAPS, 'pips_api_version': 72})
        good = {'name': 'Daily', 'pip_ids': PIPS, 'tasks': ['Write', 'Illustrate'], 'mode': 'unattended'}
        for bad in ({**good, 'pip_ids': [PIPS[0], PIPS[0]]}, {**good, 'tasks': ['Only one']},
                    {**good, 'mode': 'auto'}, {**good, 'name': ''}, {**good, 'secret': 'x'}):
            with self.assertRaises(DGCConfigError):
                current.pips.mutate('create_pip_flow', bad, approved=True)
        self.assertFalse(wire.calls)
        self.assertEqual(current.pips.mutate('create_pip_flow', good, approved=True)['request']['mode'], 'unattended')
        self.assertEqual(current.pips.mutate('set_pip_flow', {'flow_id': 'flow_x', 'expected_revision': 0,
            'status': 'paused'}, approved=True)['request']['status'], 'paused')


if __name__ == '__main__':
    unittest.main()
