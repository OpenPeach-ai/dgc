"""CLI routes each explicit service operation without implicit enable or start."""
import json
import unittest
from unittest.mock import patch

from dgc import pip_service
from tests import test_pip_cli as fixtures


class PipServiceCliTests(unittest.TestCase):
    setUp = fixtures.PipCliTests.setUp
    invoke = fixtures.PipCliTests.invoke
    value = fixtures.PipCliTests.value

    def test_each_operation_routes_only_to_the_named_scoped_service_operation(self):
        for name in ('preview', 'install', 'status', 'start', 'stop', 'enable', 'disable', 'uninstall'):
            with self.subTest(name=name), patch.object(pip_service, name, return_value={'operation': name}) as operation, \
                 patch.object(self.cfg, 'set', side_effect=AssertionError('No config changes')):
                result = self.value('service', name, '--unit-directory', str(self.base / 'units'))
                self.assertEqual(result, {'operation': name})
                operation.assert_called_once_with(unit_directory=str(self.base / 'units'))

    def test_service_preview_is_read_only_with_real_unit_generator(self):
        # This fixture creates registry parents directly; a service home requires
        # the same private mode as a saved production Config directory.
        (self.home / '.dgc').chmod(0o700)
        before = list(self.home.rglob('*'))
        self.cfg.set('pips_enabled', False, persist=False)
        with patch('subprocess.Popen', side_effect=AssertionError('Preview must not launch anything')):
            result = self.value('service', 'preview', '--unit-directory', str(self.base / 'staged-units'))
        self.assertEqual(result['dgc_home'], str(self.home))
        self.assertEqual(result['argv'][-2:], ['pips', 'serve'])
        self.assertNotIn('--enable', result['argv'])
        self.assertIn('Restart=no', result['content'])
        self.assertFalse((self.base / 'staged-units').exists())
        self.assertEqual(list(self.home.rglob('*')), before)

    def test_chat_cannot_mutate_services_and_unknown_action_is_rejected(self):
        for name in ('install', 'start', 'stop', 'enable', 'disable', 'uninstall'):
            with self.subTest(name=name), patch.object(pip_service, name, side_effect=AssertionError('No mutation')):
                _, err = self.invoke('service', name, '--json', in_chat=True, expected=1)
                self.assertEqual(json.loads(err)['error']['code'], 'separate_terminal')
        self.invoke('service', 'launch', expected=2)


if __name__ == '__main__': unittest.main()
