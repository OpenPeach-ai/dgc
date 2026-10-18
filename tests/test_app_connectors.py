"""User-owned connector configuration, ownership and runtime secrets. Offline/no sleeps."""
import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from dgc import connectors, plugins
from dgc.editor_protocol import command_error
from tests import test_plugin_lifecycle as lifecycle


OWN_APP_FILE = '@/home/user/.dgc/mcp-oauth/{name}-1a2b3c4d-0123456789abcdef.json'


def spec(name, url=None, token=None):
    definition = connectors.CATALOG[name]
    url = url or definition['url'] or next(iter((definition.get('environments') or {}).values()), {}).get('url') or {
        'n8n': 'https://team.app.n8n.cloud/mcp-server/http',
        'arcade': 'https://api.arcade.dev/mcp/fixture'}[name]
    token = name == 'zapier' if token is None else token
    own_app = [str(definition['own_app']['port']), '--static-oauth-client-info', OWN_APP_FILE.format(name=name)] \
        if definition.get('own_app') else []
    result = dict(transport='remote', command='npx', args=['-y','mcp-remote',url,*own_app], url=url,
                  env_names=['DGC_MCP_BEARER_TOKEN'] if token else [], defer_until_setup=token)
    if token: result['auth_env'] = 'DGC_MCP_BEARER_TOKEN'
    return result


class ConnectorValidationTests(unittest.TestCase):
    def test_documented_auth_methods(self):
        for name, definition in connectors.CATALOG.items():
            for auth in definition['auth']:
                with self.subTest(name=name, auth=auth):
                    clean = connectors.validate(name, spec(name, token=auth=='token'))
                    self.assertNotIn('env', clean)
                    self.assertEqual(bool(clean.get('defer_until_setup')), auth=='token')
        connectors.validate('n8n', spec('n8n','http://127.0.0.1:5678/mcp-server/http'))
        connectors.validate('n8n', spec('n8n','http://[::1]:5678/mcp-server/http'))

    def test_refuses_endpoint_and_secret_smuggling(self):
        bad = [('zapier','https://evil.example/api/v1/connect'),
               ('make','https://mcp.make.com.evil.example/'),
               ('arcade','https://api.arcade.dev:8443/mcp/fixture'),
               ('arcade','https://api.arcade.dev/mcp/'),
               ('n8n','http://192.168.1.2:5678/mcp-server/http'),
               ('n8n','https://team.example/not-mcp'),
               ('n8n','https://user:secret@team.example/mcp-server/http'),
               ('n8n','https://team.example/mcp-server/http?token=secret'),
               ('n8n','https://team.example/mcp-server/http#secret'),
               ('n8n','https://team.example:bad/mcp-server/http'),
               ('n8n','https://team.example/\n/mcp-server/http'),
               ('n8n','https://team.example\\/mcp-server/http')]
        for name,url in bad:
            with self.subTest(url=url), self.assertRaises(plugins.PluginError):
                connectors.validate(name,spec(name,url))

    def test_refuses_command_env_and_auth_substitution(self):
        variants = [dict(command='sh'), dict(args=['-y','evil-package']),
                    dict(env={'DGC_MCP_BEARER_TOKEN':'secret'}), dict(headers={'Authorization':'secret'}),
                    dict(env_names=['OTHER'],auth_env='OTHER'),dict(defer_until_setup=False)]
        for override in variants:
            with self.subTest(override=override),self.assertRaises(plugins.PluginError):
                connectors.validate('zapier',{**spec('zapier'), **override})
        with self.assertRaises(plugins.PluginError): connectors.validate('zapier',spec('zapier',token=False))
        with self.assertRaises(plugins.PluginError): connectors.validate('make',spec('make',token=True))
        with self.assertRaises(plugins.PluginError): connectors.validate('unknown',{})

    def test_command_contract_accepts_connector_metadata_without_secret_persistence(self):
        public = spec('zapier')
        runtime = {**public,'env':{'DGC_MCP_BEARER_TOKEN':'fixture-token'},
                   'args':public['args']+['--header','Authorization: Bearer ${DGC_MCP_BEARER_TOKEN}']}
        self.assertIsNone(command_error(dict(type='upsert_mcp_server',request_id='fixture',name='zapier',connector='zapier',
                          accept_license=connectors.CATALOG['zapier']['license'],runtime=runtime,persisted=public)))


    def test_your_own_app_connectors_take_the_app_and_nothing_else(self):
        # Asana, Docusign and Zoom admit only apps registered with them: the saved server names its fixed callback port
        # and the owner-only file holding the app (never the secret itself), on a published endpoint only.
        for name, port in (('asana', '3334'), ('docusign', '3335'), ('zoom', '3336')):
            with self.subTest(name=name):
                good = spec(name)
                self.assertEqual(connectors.validate(name, good)['args'][3], port)
                for broken in (good['args'][:3], good['args'][:3] + ['9999'] + good['args'][4:],
                               good['args'][:5] + ['@/home/user/notes.json'],
                               good['args'][:5] + ['{"client_id":"x","client_secret":"y"}']):
                    with self.assertRaises(plugins.PluginError):
                        connectors.validate(name, {**good, 'args': broken})
                with self.assertRaises(plugins.PluginError):
                    connectors.validate(name, {**good, 'env_names': ['DGC_MCP_BEARER_TOKEN'], 'auth_env': 'DGC_MCP_BEARER_TOKEN'})
        for url in ('https://mcp-d.docusign.com/mcp', 'https://mcp.docusign.com/mcp'):
            connectors.validate('docusign', spec('docusign', url))
        with self.assertRaisesRegex(plugins.PluginError, 'published endpoints'):
            connectors.validate('docusign', spec('docusign', 'https://mcp.docusign.com.evil.example/mcp'))
        with self.assertRaisesRegex(plugins.PluginError, 'published endpoint'):
            connectors.validate('asana', spec('asana', 'https://mcp.asana.com/sse'))
        for url in ('https://mcp.zoom.us/mcp/meeting/streamable', 'https://mcp-eu.zoom.us/mcp/zoom/streamable'):
            with self.assertRaisesRegex(plugins.PluginError, 'published endpoint'):
                connectors.validate('zoom', spec('zoom', url))

    def test_own_apps_each_sign_in_on_their_own_port_and_only_a_public_client_has_no_secret(self):
        from dgc import mcp_remote
        own = {name: d['own_app'] for name, d in connectors.CATALOG.items() if d.get('own_app')}
        self.assertEqual(sorted(own), ['asana', 'docusign', 'zoom'])
        ports = [app['port'] for app in own.values()]
        self.assertEqual(len(ports), len(set(ports)), 'one callback port per app: each is registered at its vendor')
        self.assertNotIn(mcp_remote.CLIENT_METADATA_PORT, ports)
        for name, app in own.items():
            with self.subTest(name=name):
                self.assertTrue(1024 <= app['port'] <= 65535)
                self.assertIn(app.get('redirect_host', 'localhost'), ('localhost', '127.0.0.1'))
                self.assertTrue(app['id_label'] and app['console'].startswith('https://') and app['steps'])
                self.assertEqual('{scopes}' in ' '.join(app['steps']), bool(app.get('scopes')), 'listed where shown')
        # Asana and Docusign keep requiring their secrets; Zoom's public client has none, so nothing names one.
        self.assertEqual(own['asana']['secret_label'], 'Client secret')
        self.assertEqual(own['docusign']['secret_label'], 'Secret key')
        zoom = connectors.CATALOG['zoom']
        self.assertEqual([k for k in zoom['own_app'] if 'secret' in k], [], 'no secret field for Zoom')
        self.assertEqual((zoom['own_app']['port'], zoom['own_app']['redirect_host']), (3336, '127.0.0.1'))
        self.assertEqual(zoom['url'], 'https://mcp.zoom.us/mcp/zoom/streamable', "Zoom's main MCP server")
        self.assertTrue({'meeting:read:assets', 'cloud_recording:read:list_user_recordings', 'docs:read:export',
                         'agentic_search:read:search'} <= set(zoom['own_app']['scopes']))
        row = next(r for r in plugins.load_catalog()['plugins'] if r['name'] == 'zoom')
        self.assertEqual((row['auth'], row['connector'], row['source_kind']), ('own-app', 'zoom', 'preset'))
        self.assertEqual([k for k in row if 'secret' in k], [])
        self.assertNotRegex(json.dumps([zoom, row]), r'\bAI\b', 'our own copy never says "AI"')

    def test_every_connector_is_offered_in_the_plugin_catalog(self):
        rows = {row['name']: row for row in plugins.load_catalog()['plugins']}
        for name, definition in connectors.CATALOG.items():
            with self.subTest(name=name):
                self.assertEqual(rows[name].get('connector'), name)
                self.assertEqual(rows[name]['license'], definition['license'])
                if definition.get('own_app'):
                    self.assertEqual(rows[name]['auth'], 'own-app')
                    self.assertIn('{redirect}', ' '.join(definition['own_app']['steps']), 'a step names the redirect')


class ConnectorLifecycleTests(unittest.TestCase):
    setUp = lifecycle.PluginLifecycleTests.setUp
    write = lifecycle.PluginLifecycleTests.write

    def save(self,name='zapier',**kw):
        return connectors.save(self.config,name,spec(name,**kw),connectors.CATALOG[name]['license'])

    def test_terms_are_required_and_generic_install_cannot_skip_setup(self):
        with self.assertRaises(plugins.PluginError): connectors.save(self.config,'zapier',spec('zapier'))
        with self.assertRaisesRegex(plugins.PluginError,'Open Apps'): plugins.install(plugins.prepare_plugin('zapier'),accept_license=connectors.CATALOG['zapier']['license'])
        self.assertEqual(self.values,{})
        self.assertEqual(plugins._installed(),[])

    def test_all_connectors_register_update_and_uninstall_through_existing_store(self):
        for name in connectors.CATALOG:
            with self.subTest(name=name):
                self.save(name); self.save(name)
                self.assertEqual(len(plugins._installed()),1)
                row=next(r for r in plugins.catalog_for_editor(connected={name}) if r['name']==name)
                self.assertTrue(row['installed']);self.assertTrue(row['connected'])
                self.assertEqual(row['connector'],name);self.assertEqual(row['server_names'],[name])
                self.assertEqual(row['skills'],[])
                result=plugins.uninstall(name,config=self.config)
                self.assertEqual(result['removed_servers'],[name])
                self.assertNotIn(name,self.values['mcp_servers']);self.assertEqual(plugins._installed(),[])

    def test_manual_server_collision_is_not_overwritten(self):
        self.values['mcp_servers']={'zapier':{'command':'manual'}}
        before=copy.deepcopy(self.values)
        with self.assertRaisesRegex(plugins.PluginError,'manually configured'):self.save()
        self.assertEqual(self.values,before);self.assertEqual(plugins._installed(),[])

    def test_registry_write_failure_rolls_back_public_config(self):
        self.values['mcp_servers']={'manual':{'command':'keep'}}
        before=copy.deepcopy(self.values)
        with patch.object(plugins,'_save',side_effect=OSError('disk fixture')):
            with self.assertRaises(OSError):self.save()
        self.assertEqual(self.values,before)

    def test_uninstall_retains_a_manually_changed_owned_endpoint(self):
        self.save(); self.values['mcp_servers']['zapier']={'command':'different'}
        result=plugins.uninstall('zapier',config=self.config)
        self.assertEqual(result['retained_servers'],['zapier'])
        self.assertEqual(self.values['mcp_servers']['zapier'],{'command':'different'})

    def backend(self):
        from dgc.headless import Backend
        backend=object.__new__(Backend);backend.config=self.config
        backend.agent=Mock();backend.em=Mock();backend._emit_mcp_servers=Mock()
        backend._editor_plugins=lambda: []
        backend._busy=lambda:False
        return backend

    def test_runtime_secret_is_not_in_config_registry_or_public_events(self):
        public=spec('zapier');runtime={**public,'env':{'DGC_MCP_BEARER_TOKEN':'fixture-secret'},
            'args':public['args']+['--header','Authorization: Bearer ${DGC_MCP_BEARER_TOKEN}']}
        backend=self.backend()
        backend._upsert_mcp_server('id','zapier',runtime,public,connector='zapier',
                                  accept_license=connectors.CATALOG['zapier']['license'])
        backend._emit_mcp_servers.assert_called_once_with('id',None)
        passed=backend.agent.mcp.connect_all.call_args.args[0]['zapier']
        self.assertEqual(passed['env']['DGC_MCP_BEARER_TOKEN'],'fixture-secret')
        self.assertNotIn('fixture-secret',json.dumps(self.values))
        self.assertNotIn('fixture-secret',plugins.STATE_PATH.read_text())
        self.assertNotIn('fixture-secret',str(backend.em.mock_calls))

    def test_failed_editor_secret_save_removal_also_removes_ownership(self):
        self.save();backend=self.backend()
        backend.agent.mcp=SimpleNamespace(servers={},failures={},_runtime_specs={},disabled_names=set(),_rebuild_routes=lambda:None)
        backend._dispatch({'type':'remove_mcp_server','name':'zapier','request_id':'undo'})
        self.assertEqual(plugins._installed(),[])
        self.assertNotIn('zapier',self.values['mcp_servers'])
        backend._emit_mcp_servers.assert_called_once_with('undo')

    def test_restart_token_definition_waits_for_editor_secret(self):
        self.save()
        self.assertTrue(self.values['mcp_servers']['zapier']['defer_until_setup'])
        self.assertNotIn('env',self.values['mcp_servers']['zapier'])
        self.save('n8n',token=True)
        self.assertTrue(self.values['mcp_servers']['n8n']['defer_until_setup'])

    def test_compensation_write_failure_preserves_config_and_ownership(self):
        self.save();before=copy.deepcopy(self.values)
        with patch.object(plugins,'_save',side_effect=OSError('disk fixture')):
            with self.assertRaises(OSError):connectors.forget(self.config,'zapier')
        self.assertEqual(self.values,before)
        self.assertEqual(plugins._installed()[0]['name'],'zapier')
