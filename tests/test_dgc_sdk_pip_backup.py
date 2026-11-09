"""Pips API 76 in the Python SDK: a Pip's fallback model (provider and model) (get_/set_pips_backup, get_/set_pip_backup), known, refused
before API 76, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, READ_COMMANDS, MUTATION_COMMANDS

PIP = "pip_" + "a" * 32


class PipBackupSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in ('get_pips_backup', 'set_pips_backup', 'get_pip_backup', 'set_pip_backup'):
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
        self.assertLessEqual({'get_pips_backup', 'get_pip_backup'}, READ_COMMANDS)
        self.assertLessEqual({'set_pips_backup', 'set_pip_backup'}, MUTATION_COMMANDS)

    def test_refused_before_api76_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 75})
        for call in (lambda s: s.pips.read('get_pips_backup', {}),
                     lambda s: s.pips.mutate('set_pip_backup', {'pip_id': PIP, 'model': None}, approved=True)):
            with self.assertRaisesRegex(DGCUnsupportedError, 'API 76'):
                call(old)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 76})
        self.assertEqual(current.pips.read('get_pip_backup', {'pip_id': PIP})['request']['type'], 'get_pip_backup')
        self.assertEqual(current.pips.mutate('set_pips_backup', {'model': 'qwen3:8b'}, approved=True)['request']['model'], 'qwen3:8b')
        provider = 'provider_' + 'c' * 32
        self.assertEqual(current.pips.mutate('set_pip_backup', {'pip_id': PIP, 'model': 'gpt-oss:120b', 'provider': provider},
                                             approved=True)['request']['provider'], provider)


if __name__ == '__main__':
    unittest.main()
