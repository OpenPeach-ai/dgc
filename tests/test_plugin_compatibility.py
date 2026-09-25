"""Curated availability is enforced before fetching, installing or connecting."""
import json
import re
import unittest
from unittest.mock import Mock, patch

from dgc import plugins
from dgc.mcp import _runtime_server_args


class CuratedCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.entries = json.loads(plugins.CATALOG_PATH.read_text())['plugins']
        context = patch.object(plugins, 'load_catalog', return_value={'plugins': self.entries})
        context.start()
        self.addCleanup(context.stop)

    def test_blocked_packages_are_absent_from_recommendations_and_editor_catalog(self):
        blocked = {e['name'] for e in self.entries if e['install'] == 'block'}
        self.assertTrue({'figma','canva','vercel','dropbox','google-workspace','context7',
                         'feature-dev','code-review','commit-commands','code-simplifier',
                         'pr-review-toolkit'} <= blocked)
        self.assertFalse(blocked & {r['name'] for r in plugins.search()})
        self.assertEqual(plugins.search('Figma'), [])
        with patch.object(plugins, '_installed', return_value=[]), \
             patch.object(plugins, '_source', side_effect=plugins.PluginError('not cached')):
            rows = plugins.catalog_for_editor()
        self.assertFalse(blocked & {r['name'] for r in rows})
        self.assertEqual(len(rows), len(self.entries) - len(blocked))

    def test_blocked_names_and_pasted_links_refuse_before_any_fetch(self):
        with patch.object(plugins, '_source') as source, patch.object(plugins.sources, 'snapshot_github') as fetch:
            for entry in self.entries:
                if entry['install'] != 'block': continue
                with self.subTest(entry=entry['name']):
                    with self.assertRaises(plugins.PluginError): plugins.prepare_plugin(entry['name'])
                    if entry.get('upstream') and entry.get('sha'):
                        url = entry['upstream'] + '/tree/' + entry['sha'] + '/' + entry['path']
                        with self.assertRaises(plugins.PluginError): plugins.prepare_plugin(url)
            source.assert_not_called()
            fetch.assert_not_called()

    def test_stale_review_cannot_install_after_catalog_withdrawal(self):
        stale = {'name':'figma','install':'allow','license':'MIT'}
        with patch.object(plugins, '_source') as source, patch.object(plugins, '_install_tree') as install:
            with self.assertRaisesRegex(plugins.PluginError, 'approved'): plugins.install(stale)
            source.assert_not_called()
            install.assert_not_called()

    def test_existing_blocked_plugin_cannot_start_new_connection_or_write_config(self):
        config, manager = Mock(), Mock()
        with self.assertRaisesRegex(plugins.PluginError, 'approved'):
            plugins.connect(config, manager, {'name':'figma','servers':{'figma':{}}}, input_handler=None)
        self.assertEqual(config.mock_calls, [])
        self.assertEqual(manager.mock_calls, [])

    def test_installed_plugin_remains_manageable_and_metadata_cannot_override_policy(self):
        record = {'name':'figma','skills':[], 'metadata':{'display_name':'Figma',
                  'install':'allow','block_reason':'','verification':'Everything works'}}
        with patch.object(plugins, '_installed', return_value=[record]), \
             patch.object(plugins, '_source', side_effect=plugins.PluginError('not cached')):
            row = next(r for r in plugins.catalog_for_editor() if r['name']=='figma')
        self.assertTrue(row['installed'])
        self.assertEqual(row['install'], 'block')
        self.assertIn('approved', row['block_reason'])
        self.assertNotEqual(row['verification'], 'Everything works')

    def test_curated_git_sources_have_real_immutable_pins(self):
        for row in self.entries:
            if row.get('source_kind') not in ('dgc','preset'):
                with self.subTest(row=row['name']): self.assertRegex(row['sha'], re.compile(r'^[0-9a-f]{40}$'))
        dropbox = next(r for r in self.entries if r['name']=='dropbox')
        self.assertEqual(dropbox['path'], 'codex')

    def test_default_bridge_uses_dgc_identity_not_an_approved_client_name(self):
        spec = plugins.mcp_spec('https://example.invalid/mcp', '')
        args = _runtime_server_args(spec)
        metadata = json.loads(args[args.index('--static-oauth-client-metadata')+1])
        self.assertEqual(metadata, {'client_name':'DGC','client_uri':'https://vibedgc.com'})
        self.assertEqual(args.count('--static-oauth-client-metadata'), 1)


class CurrentPresetCopyTests(unittest.TestCase):
    def test_installed_composio_does_not_advertise_retired_shortcuts(self):
        entry=next(r for r in plugins.load_catalog()['plugins'] if r['name']=='composio')
        with patch.object(plugins, '_installed', return_value=[{'name':'composio','metadata':{'long_summary':'Connect each app from DGC settings'}}]), patch.object(plugins,'_source',side_effect=plugins.PluginError('preset')):
            row=next(r for r in plugins.catalog_for_editor() if r['name']=='composio')
        self.assertEqual(row['long_summary'],entry['metadata']['long_summary'])
        self.assertIn('Composio For You',row['long_summary'])


if __name__ == '__main__':
    unittest.main()
