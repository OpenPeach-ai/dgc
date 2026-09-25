"""Connector preset lifecycle and safe replies to retired setup controls. Offline."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from dgc import plugins
from dgc.editor_protocol import event_error
from tests import test_plugin_lifecycle as lifecycle

ENDPOINT = 'https://connect.composio.dev/mcp'

class RetiredComposioSetupTests(unittest.TestCase):
    def test_stale_setup_commands_do_not_call_tools_or_mutate_accounts(self):
        from dgc.headless import Backend
        backend = object.__new__(Backend)
        events = []
        backend.config = Mock()
        backend.agent = Mock()
        backend.em = SimpleNamespace(emit=lambda kind, **kw: events.append({'type':kind, 'seq':len(events), **kw}))
        backend._busy = lambda: True
        for action in ('connect', 'check'):
            backend._dispatch({'type':'composio_connection','action':action,'toolkit':'googlecalendar','request_id':action})
            result = events[-1]
            self.assertEqual(result['request_id'], action)
            self.assertEqual(result['status'], 'error')
            self.assertIn('Composio For You', result['message'])
            self.assertNotIn('url', result)
            self.assertIsNone(event_error(result))
        self.assertEqual(backend.agent.mock_calls, [])
        self.assertEqual(backend.config.mock_calls, [])

class ComposioInstallTests(unittest.TestCase):
    setUp=lifecycle.PluginLifecycleTests.setUp
    write=lifecycle.PluginLifecycleTests.write

    def test_review_install_and_uninstall_use_existing_config_path_without_project_credentials(self):
        with patch.object(plugins.sources,'snapshot_github',side_effect=AssertionError('network')):
            review=plugins.prepare_plugin('composio')
            self.assertEqual(set(review['server_specs']),{'composio'})
            self.assertFalse(review['skills']);self.assertEqual(review['auth'],'browser')
            with self.assertRaises(plugins.PluginError):plugins.install(review)
            record=plugins.install(review,accept_license=review['license'])
            plugins.register_mcp(self.config,record)
        self.assertEqual(self.values['mcp_servers']['composio']['url'],ENDPOINT)
        self.assertFalse(self.values['mcp_servers']['composio'].get('env_names'))
        self.assertEqual(record['skills'],[])
        row=next(r for r in plugins.catalog_for_editor(connected={'composio'}) if r['name']=='composio')
        self.assertTrue(row['connected']);self.assertEqual(row['apps'],[])
        plugins.uninstall('composio',config=self.config)
        self.assertNotIn('composio',self.values['mcp_servers'])
        self.assertFalse(plugins._installed())
