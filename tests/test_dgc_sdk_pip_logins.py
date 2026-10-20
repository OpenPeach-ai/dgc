"""Pips API 56 in the Python SDK: saved logins (list_pip_logins, save_pip_login, remove_pip_login, grant_pip_login),
known, refused before API 56, checked without ever repeating the password, then sent."""
import unittest

from tests.test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, READ_COMMANDS, MUTATION_COMMANDS

PASSWORD = "Nw-Pass-7Qx2-zz91"
PIP = "pip_" + "b" * 32
SAVE = {"pip_id": PIP, "site": "northwind-bank.example", "username": "arjun", "password": PASSWORD}


class PipLoginsSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in ('list_pip_logins', 'save_pip_login', 'remove_pip_login', 'grant_pip_login'):
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
        self.assertIn('list_pip_logins', READ_COMMANDS)
        for command in ('save_pip_login', 'remove_pip_login', 'grant_pip_login'):
            self.assertIn(command, MUTATION_COMMANDS)

    def test_refused_before_api56_checked_without_the_password_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 55})
        for call in (lambda s: s.pips.read('list_pip_logins', {'pip_id': PIP}),
                     lambda s: s.pips.mutate('save_pip_login', SAVE, approved=True),
                     lambda s: s.pips.mutate('remove_pip_login', {'login_id': 'login_' + '1' * 32}, approved=True),
                     lambda s: s.pips.mutate('grant_pip_login', {'login_id': 'login_' + '1' * 32, 'pips': 'all'}, approved=True)):
            with self.assertRaisesRegex(DGCUnsupportedError, 'API 56'):
                call(old)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 56})
        for bad in ({**SAVE, 'password': ''}, {**SAVE, 'pips': 'some'}, {k: v for k, v in SAVE.items() if k != 'site'},
                    {**SAVE, 'action_id': 'compact_' + 'd' * 32, 'expected_digest': 'e' * 64}, {**SAVE, 'totp': 7}):
            with self.assertRaises(DGCConfigError) as caught:
                current.pips.mutate('save_pip_login', bad, approved=True)
            self.assertNotIn(PASSWORD, str(caught.exception))
        with self.assertRaises(DGCConfigError):
            current.pips.mutate('grant_pip_login', {'login_id': 'login_' + '1' * 32, 'pips': 'everyone'}, approved=True)
        self.assertFalse(wire.calls)
        self.assertEqual(current.pips.read('list_pip_logins', {'pip_id': PIP})['request']['type'], 'list_pip_logins')
        sent = current.pips.mutate('save_pip_login', {**SAVE, 'totp': 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'pips': 'all'}, approved=True)
        self.assertEqual((sent['request']['password'], sent['request']['pips']), (PASSWORD, 'all'), 'sent as given, once')
        card = {k: v for k, v in SAVE.items() if k != 'site'}
        self.assertEqual(current.pips.mutate('save_pip_login', {**card, 'action_id': 'compact_' + 'd' * 32,
                                                                'expected_digest': 'e' * 64}, approved=True)['request']['action_id'],
                         'compact_' + 'd' * 32)
        self.assertEqual(current.pips.mutate('grant_pip_login', {'login_id': 'login_' + '1' * 32, 'pips': [PIP]}, approved=True)['request']['pips'], [PIP])


if __name__ == '__main__':
    unittest.main()
