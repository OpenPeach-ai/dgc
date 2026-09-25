"""User-owned connector configuration, ownership and runtime secrets. Offline/no sleeps."""
import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from dgc import connectors, plugins
from dgc.editor_protocol import command_error
from tests import test_plugin_lifecycle as lifecycle


def spec(name, url=None, token=None):
    url = url or connectors.CATALOG[name]['url'] or {
        'n8n': 'https://team.app.n8n.cloud/mcp-server/http',
        'arcade': 'https://api.arcade.dev/mcp/fixture'}[name]
    token = name == 'zapier' if token is None else token
    result = dict(transport='remote', command='npx', args=['-y','mcp-remote',url], url=url,
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
