"""SDK: a Pip computer's Files and Terminal need API 43, and a file added travels outside the 32 KiB budget."""
import unittest

from tests.test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError

PIP = 'pip_' + 'a' * 32
FILE = 'data:application/pdf;base64,' + 'A' * 1_900_000


class PipComputerDeskSDKTests(unittest.TestCase):
    def test_files_and_terminal_need_api43(self):
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 42})
        with self.assertRaisesRegex(DGCUnsupportedError, 'API 43'):
            old.pips.read('list_pip_computer_files', {'pip_id': PIP, 'path': ''})
        with self.assertRaisesRegex(DGCUnsupportedError, 'API 43'):
            old.pips.mutate('run_pip_computer_command', {'pip_id': PIP, 'command': 'ls'}, approved=True)
        self.assertFalse(wire.calls)
        current = session(wire, caps={**CAPS, 'pips_api_version': 43})
        current.pips.read('list_pip_computer_terminal', {'pip_id': PIP})
        current.pips.mutate('run_pip_computer_command', {'pip_id': PIP, 'command': 'ls'}, approved=True)
        self.assertEqual(len(wire.calls), 2)

    def test_a_file_of_up_to_2_mb_is_added_and_nothing_else_grows(self):
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 43})
        answer = current.pips.mutate('add_pip_computer_file', {'pip_id': PIP, 'path': '', 'name': 'scan.pdf', 'data': FILE}, approved=True)
        self.assertEqual(answer['request']['data'], FILE)
        for params in ({'pip_id': PIP, 'path': '', 'name': 'x', 'data': FILE + 'A' * 1_000_000},
                       {'pip_id': PIP, 'path': '', 'name': 'x', 'data': 'https://example.com/file'},
                       {'pip_id': PIP, 'path': '', 'name': 'x' * 40000, 'data': FILE}):
            with self.assertRaises(DGCConfigError):
                current.pips.mutate('add_pip_computer_file', params, approved=True)
        with self.assertRaises(DGCConfigError):
            current.pips.mutate('remove_pip_computer_file', {'pip_id': PIP, 'path': 'x' * 40000}, approved=True)
        self.assertEqual(len(wire.calls), 1)


if __name__ == '__main__':
    unittest.main()
