"""Pips API 55 in the Python SDK: a Personal Pip on the user's own Claude Code or Codex. A subscription model_choice
(create_pip, propose_pip_update, revise_pip_setup) is refused before API 55, checked, then sent."""
import unittest

from tests.test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError

CODEX = {'mode': 'subscription', 'engine': 'codex'}


class PipBrainSDKTests(unittest.TestCase):
    def calls(self):
        return (lambda s, c: s.pips.mutate('create_pip', {'workspace_id': 'ws', 'name': 'Tees', 'goal': 'Help',
                                                          'model_choice': c}, approved=True),
                lambda s, c: s.pips.mutate('propose_pip_update', {'pip_id': 'pip_a', 'expected_version': 1,
                                                                  'changes': {'model_choice': c}, 'reason': 'Chosen.'}, approved=True),
                lambda s, c: s.pips.mutate('revise_pip_setup', {'setup_id': 'setup_a', 'expected_digest': 'a' * 64,
                                                                'model_choice': c}, approved=True))

    def test_refused_before_api55_checked_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 54})
        for call in self.calls():
            with self.assertRaisesRegex(DGCUnsupportedError, 'API 55'):
                call(old, CODEX)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 55})
        for bad in ({'mode': 'subscription', 'engine': 'kimi'}, {'mode': 'subscription', 'engine': 'codex', 'model': 'x'}):
            for call in self.calls():
                with self.assertRaises(DGCConfigError):
                    call(current, bad)
        self.assertFalse(wire.calls)
        sent = [call(current, CODEX)['request'] for call in self.calls()]
        self.assertEqual(sent[0]['model_choice'], CODEX)
        self.assertEqual(sent[1]['changes']['model_choice'], CODEX)
        self.assertEqual(sent[2]['model_choice'], CODEX)
        # A native choice is as before, on any version.
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 54})
        self.calls()[0](old, {'mode': 'model', 'model': 'gpt-oss:20b'})
        self.assertEqual(len(wire.calls), 1)


if __name__ == '__main__':
    unittest.main()
