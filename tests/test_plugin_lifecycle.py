"""Install/discover/remove real packages in private fixtures, without network or sleeps."""
import gzip
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import plugins, plugin_registry, plugin_sources


class PluginLifecycleTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name); self.home = self.root / 'plugins'; self.package = self.root / 'package'
        self.package.mkdir()
        for name, value in {'PLUGIN_HOME':self.home,'SKILL_ROOT':self.home/'skills','LOGO_ROOT':self.home/'logos','STATE_PATH':self.home/'installed.json'}.items():
            p = patch.object(plugins,name,value); p.start(); self.addCleanup(p.stop)
        self.values = {}
        self.config = SimpleNamespace(get=lambda key,default=None:self.values.get(key,default),set=lambda key,value:self.values.__setitem__(key,value))
        self.entry = {'name':'fixture','license':'Apache-2.0','display_name':'Fixture','install':'allow','auth':'none'}
        self.write('.codex-plugin/plugin.json',{'name':'fixture','license':'Apache-2.0','interface':{'displayName':'Fixture'}})
        self.write('skills/example/SKILL.md','---\nname: example\ndescription: Read the fixture\n---\nUse the fixture tool.\n')

    def write(self,name,value):
        path = self.package / name; path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(value) if isinstance(value,dict) else value)
        return path

    def install(self,**kw):
        return plugins._install_tree(self.entry,self.package,accept_license='',**kw)

    def test_skill_install_reinstall_has_stable_ownership(self):
        first=self.install(); second=self.install()
        self.assertEqual(first['skills'],second['skills'])
        self.assertEqual(first['skills'],['fixture--example'])
        self.assertEqual(len(plugins._installed()),1)

    def test_uninstall_removes_only_owned_files(self):
        self.install(); unrelated=plugins.SKILL_ROOT/'unrelated'; unrelated.mkdir(); (unrelated/'keep').write_text('keep')
        result=plugins.uninstall('fixture',config=self.config)
        self.assertEqual(result['retained_servers'],[])
        self.assertTrue((unrelated/'keep').exists()); self.assertFalse((plugins.SKILL_ROOT/'fixture--example').exists())
        self.assertEqual(plugins._installed(),[])

    def test_uninstalled_default_stays_removed(self):
        self.install(); plugins.uninstall('fixture',config=self.config)
        with patch.object(plugins,'load_catalog',return_value={'plugins':[{**self.entry,'source_kind':'dgc'}]}),patch.object(plugins,'install') as install:
            plugins.ensure_first_party(); install.assert_not_called()

    def test_skill_name_collision_does_not_replace_other_package(self):
        self.install(); self.entry['name']='another'
        with self.assertRaisesRegex(plugins.PluginError,'already owns'): self.install()
        self.assertEqual([r['name'] for r in plugins._installed()],['fixture'])

    def test_multiple_servers_are_selected_and_registered_independently(self):
        self.write('.mcp.json',{'mcpServers':{'one':{'url':'https://one.example/mcp'},'two':{'url':'https://two.example/mcp'}}})
        preview=plugins._preview(self.entry,self.package)
        self.assertEqual(set(preview['server_specs']),{'fixture--one','fixture--two'})
        record=self.install(selected_servers=['fixture--two'])
        plugins.register_mcp(self.config,record)
        self.assertEqual(set(self.values['mcp_servers']),{'fixture--two'})

    def test_selection_cannot_inject_a_server(self):
        with self.assertRaisesRegex(plugins.PluginError,'do not belong'): self.install(selected_servers=['foreign'])
        self.assertFalse(plugins.STATE_PATH.exists())

    def test_server_conflict_is_not_overwritten(self):
        self.write('.mcp.json',{'mcpServers':{'one':{'url':'https://one.example/mcp'}}})
        record=self.install(); self.values['mcp_servers']={'fixture':{'command':'user-server'}}
        with self.assertRaisesRegex(plugins.PluginError,'not overwrite'): plugins.register_mcp(self.config,record)
        self.assertEqual(self.values['mcp_servers']['fixture']['command'],'user-server')

    def test_uninstall_keeps_modified_server_and_removes_original(self):
        self.write('.mcp.json',{'mcpServers':{'one':{'url':'https://one.example/mcp'},'two':{'url':'https://two.example/mcp'}}})
        record=self.install(); plugins.register_mcp(self.config,record)
        self.values['mcp_servers']['fixture--two']={'command':'edited'}
        calls=[]; manager=SimpleNamespace(disconnect=calls.append,_runtime_specs={'fixture--one':{}})
        result=plugins.uninstall('fixture',config=self.config,manager=manager)
        self.assertEqual(calls,['fixture--one']);self.assertEqual(manager._runtime_specs,{})
        self.assertEqual(result['retained_servers'],['fixture--two'])
        self.assertEqual(self.values['mcp_servers'],{'fixture--two':{'command':'edited'}})

    def test_stdio_package_root_is_relocated(self):
        self.write('server.py','print("fixture")')
        self.write('.mcp.json',{'mcpServers':{'local':{'command':'python3','args':['${CLAUDE_PLUGIN_ROOT}/server.py']}}})
        record=self.install()
        self.assertEqual(record['servers']['fixture']['args'],[str(self.home/'packages/fixture/server.py')])
        self.assertTrue(Path(record['servers']['fixture']['args'][0]).is_file())

    def test_inline_secrets_are_refused_before_skills_are_copied(self):
        self.write('.mcp.json',{'mcpServers':{'one':{'url':'https://one.example/mcp','headers':{'Authorization':'Bearer secret'}}}})
        with self.assertRaisesRegex(plugins.PluginError,'Inline MCP headers'): self.install()
        self.assertFalse(plugins.SKILL_ROOT.exists())

    def test_missing_token_does_not_open_browser(self):
        self.write('.mcp.json',{'mcpServers':{'one':{'url':'https://one.example/mcp','bearer_token_env_var':'DGC_TEST_MISSING_TOKEN'}}})
        record=self.install(); calls=[]
        manager=SimpleNamespace(failures={},connect_all=lambda *a,**kw:calls.append(a))
        with patch.dict('os.environ',{},clear=True): plugins.connect(self.config,manager,record,input_handler=None)
        self.assertEqual(calls,[]);self.assertIn('DGC_TEST_MISSING_TOKEN',manager.failures['fixture'])

    def test_google_setup_only_never_starts_servers(self):
        entry={**next(e for e in plugins.load_catalog()['plugins'] if e['name']=='google-workspace'), 'name':'setup-fixture', 'install':'accept'}
        record=plugins.install(entry,accept_license=entry['license'],selected_servers=['setup-fixture--gmail','setup-fixture--drive'])
        manager=SimpleNamespace(connect_all=lambda *a,**kw:self.fail('setup-only server launched'))
        plugins.connect(self.config,manager,record,input_handler=None)
        self.assertEqual(set(self.values['mcp_servers']),{'setup-fixture--gmail','setup-fixture--drive'})
        self.assertTrue(all(v['defer_until_setup'] for v in self.values['mcp_servers'].values()))

    def test_commands_only_is_refused_not_falsely_installed(self):
        import shutil
        shutil.rmtree(self.package/'skills');self.write('commands/review.md','Only a host-specific command')
        with self.assertRaisesRegex(plugins.PluginError,'No supported'): self.install()
        self.assertFalse(plugins.STATE_PATH.exists())

    def test_unsupported_hooks_are_explicit(self):
        self.write('hooks/hooks.json',{'hooks':{}})
        self.assertIn('hooks:',self.install()['warnings'][0])

    def test_apps_without_mcp_are_not_called_connected(self):
        self.write('.app.json',{'apps':{'service':{'displayName':'Service'}}})
        record=self.install()
        self.assertTrue(any('without a standalone MCP' in w for w in record['warnings']))
        with patch.object(plugins,'load_catalog',return_value={'plugins':[self.entry]}),patch.object(plugins,'_source',return_value=self.package):
            row=plugins.catalog_for_editor(connected={'fixture'})[0]
        self.assertFalse(row['connected'])

    def test_symlink_and_oversize_fail_before_install(self):
        (self.package/'bad').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(plugins.PluginError,'symbolic'): self.install()
        (self.package/'bad').unlink()
        with patch.object(plugin_sources,'MAX_FILE',10):
            with self.assertRaisesRegex(plugins.PluginError,'size limit'): self.install()
        self.assertFalse(plugins.STATE_PATH.exists())

    def test_marketplace_add_search_install_remove_keeps_package(self):
        market=self.root/'market';target=market/'plugins/fixture';target.parent.mkdir(parents=True)
        import shutil
        shutil.copytree(self.package,target)
        manifest=market/'.claude-plugin/marketplace.json';manifest.parent.mkdir();manifest.write_text(json.dumps({'name':'team','plugins':[{'name':'fixture','source':'./plugins/fixture'}]}))
        row=plugin_registry.add_marketplace(self.home,str(market))
        self.assertTrue(row['pin']);self.assertEqual(row['count'],1)
        entry=next(e for e in plugins.search('Fixture') if e['name']=='team--fixture')
        plugins.install(entry)
        plugin_registry.remove_marketplace(self.home,'team')
        self.assertEqual(plugin_registry.list_marketplaces(self.home),[])
        self.assertTrue(any(r['name']=='team--fixture' for r in plugins.catalog_for_editor()))

    def test_marketplace_traversal_and_duplicate_names_fail(self):
        m=self.root/'market';m.mkdir();f=m/'marketplace.json'
        for entries in [[{'name':'bad','source':'../package'}],[{'name':'same','source':'.'},{'name':'same','source':'.'}]]:
            f.write_text(json.dumps({'name':'team','plugins':entries}))
            with self.assertRaises(plugins.PluginError):plugin_registry.add_marketplace(self.home,str(m))
        self.assertFalse((self.home/'marketplaces.json').exists())

    def test_create_does_not_install_and_can_be_found(self):
        path=plugin_registry.create_plugin(self.home,'my-tool','My tool','Use for a fixture')
        self.assertTrue((path/'skills/my-tool/SKILL.md').is_file());self.assertEqual(plugins._installed(),[])
        self.assertTrue(any(r['name']=='personal--my-tool' for r in plugins.search('My tool')))
        with self.assertRaises(plugins.PluginError):plugin_registry.create_plugin(self.home,'../escape','Bad','Bad')
        with self.assertRaises(plugins.PluginError):plugin_registry.create_plugin(self.home,'my-tool','Again','Again')

    def test_archive_links_traversal_and_bomb_are_refused(self):
        for name,link in [('root/../../escape',False),('root/link',True)]:
            buf=io.BytesIO()
            with tarfile.open(fileobj=buf,mode='w:gz') as tar:
                item=tarfile.TarInfo(name)
                if link:item.type=tarfile.SYMTYPE;item.linkname='/etc/passwd'
                tar.addfile(item)
            with self.assertRaises(plugins.PluginError):plugin_sources.extract_archive(buf.getvalue(),self.root/'out')
        with patch.object(plugin_sources,'MAX_TREE',1024):
            with self.assertRaisesRegex(plugins.PluginError,'Expanded'):plugin_sources.extract_archive(gzip.compress(b'0'*2000),self.root/'out')
        self.assertFalse((self.root/'escape').exists())

    def test_state_write_failure_restores_previous_package_and_skills(self):
        original = self.install()
        before = plugins.STATE_PATH.read_bytes()
        text = (plugins.SKILL_ROOT/'fixture--example/SKILL.md').read_text()
        self.write('skills/example/SKILL.md', text + 'Changed after installation.\n')
        with patch.object(plugins, '_save', side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError, 'disk full'): self.install()
        self.assertEqual(plugins.STATE_PATH.read_bytes(), before)
        self.assertEqual((plugins.SKILL_ROOT/'fixture--example/SKILL.md').read_text(), text)
        self.assertEqual((Path(original['package_path'])/'skills/example/SKILL.md').read_text(), text)

    def test_external_marketplace_pins_and_checks_package_license(self):
        entry = plugin_registry._entries({'name':'team', 'plugins':[{
            'name':'remote', 'source':{'source':'git-subdir', 'url':'https://github.com/owner/repo.git',
                                     'path':'plugins/fixture', 'sha':'a'*40}}]}, self.root, 'https://github.com/owner/market', 'b'*40)[0]
        self.assertEqual(entry['sha'], 'a'*40)
        self.assertEqual(entry['path'], 'plugins/fixture')
        self.assertEqual(entry['install'], 'review')
        with patch.object(plugins, 'load_catalog', return_value={'plugins':[entry]}), patch.object(plugins, '_source', return_value=self.package):
            preview = plugins.prepare_plugin(entry['name'])
        self.assertEqual(preview['license'], 'Apache-2.0')
        self.assertEqual(preview['install'], 'allow')
        self.write('.codex-plugin/plugin.json', {'name':'fixture','license':'Proprietary'})
        with self.assertRaisesRegex(plugins.PluginError, 'no reviewed'):
            plugins._review_external_license(entry, self.package)

    def test_personal_review_freezes_contents_before_install(self):
        authored = plugin_registry.create_plugin(self.home, 'local-tool', 'Local tool', 'Use the fixture')
        reviewed = plugins.prepare_plugin('personal--local-tool')
        self.assertEqual(len(reviewed['sha']), 64)
        (authored/'.mcp.json').write_text('{"mcpServers":{"late":{"command":"unreviewed"}}}')
        record = plugins.install(reviewed)
        self.assertEqual(record['servers'], {})
        self.assertFalse((Path(record['package_path'])/'.mcp.json').exists())

    def test_google_metadata_contains_only_selected_services(self):
        entry = {**next(e for e in plugins.load_catalog()['plugins'] if e['name']=='google-workspace'), 'name':'setup-fixture', 'install':'accept'}
        record = plugins.install(entry, accept_license=entry['license'], selected_servers=['setup-fixture--gmail'])
        self.assertEqual([a['id'] for a in record['metadata']['apps']], ['gmail'])

    def test_uninstall_clears_only_removed_server_secrets(self):
        self.write('.mcp.json', {'mcpServers':{'one':{'url':'https://one.example/mcp'},'two':{'url':'https://two.example/mcp'}}})
        record = self.install(); plugins.register_mcp(self.config, record)
        self.values['mcp_servers']['fixture--two'] = {'command':'edited'}
        removed = []; self.config.drop_mcp_secrets = removed.append
        result = plugins.uninstall('fixture', config=self.config)
        self.assertEqual(removed, ['fixture--one'])
        self.assertEqual(result['removed_servers'], ['fixture--one'])

    def test_preview_completion_is_emitted_after_worker_release(self):
        from dgc.headless import Backend
        events = []
        backend = object.__new__(Backend)
        backend.em = SimpleNamespace(emit=lambda kind, **fields: events.append((kind, fields)))
        item = {'name':'fixture'}
        with patch.object(plugins, 'prepare_plugin', return_value=item):
            terminal = backend._plugin_operation({'type':'inspect_plugin','name':'fixture','request_id':'review'})
        self.assertEqual(events, [])
        self.assertTrue(callable(terminal)); terminal()
        self.assertEqual(events[0][0], 'plugin_preview')
        self.assertEqual(backend._prepared_plugins['fixture'], item)

    def test_install_without_current_review_refuses_before_fetch_or_write(self):
        from dgc.headless import Backend
        backend = object.__new__(Backend); events=[]
        backend.em=SimpleNamespace(emit=lambda kind,**fields:events.append((kind,fields)))
        with patch.object(plugins,'install') as install:
            terminal=backend._install_plugin({'name':'fixture','request_id':'test'})
            install.assert_not_called()
        self.assertEqual(events,[]); terminal()
        self.assertIn('review again',events[0][1]['message'])
        self.assertFalse(plugins.STATE_PATH.exists())

    def test_connect_reuses_existing_selection_without_refetch_or_reinstall(self):
        from dgc.headless import Backend
        import threading
        self.write('.mcp.json',{'mcpServers':{'one':{'url':'https://one.example/mcp'},'two':{'url':'https://two.example/mcp'}}})
        self.install(selected_servers=['fixture--two'])
        backend=object.__new__(Backend); backend.config=self.config
        backend.agent=SimpleNamespace(reload_skills=lambda:None,mcp=SimpleNamespace(failures={},servers={}),
                                      _handle_mcp_input=None,cancelled=threading.Event())
        backend.em=SimpleNamespace(emit=lambda *a,**kw:None);backend._editor_plugins=lambda **kw:[]
        with patch.object(plugins,'install') as install,patch.object(plugins,'connect') as connect:
            terminal=backend._install_plugin({'name':'fixture','request_id':'connect'})
            install.assert_not_called()
            self.assertEqual(set(connect.call_args.args[2]['servers']),{'fixture--two'})
            terminal()

    def test_sources_are_not_machine_specific(self):
        self.assertNotIn('/home/fungigb10',Path(plugins.__file__).read_text())

    def test_figma_timeout_is_not_reported_as_a_vendor_approval_rejection(self):
        from dgc.headless import Backend
        import threading
        backend = object.__new__(Backend)
        backend.config = self.config
        backend.agent = SimpleNamespace(reload_skills=lambda: None,
            mcp=SimpleNamespace(failures={'figma': 'initialize failed: request timed out'}, servers={}),
            _handle_mcp_input=None, cancelled=threading.Event())
        events = []
        backend.em = SimpleNamespace(emit=lambda kind, **fields: events.append((kind, fields)))
        backend._editor_plugins = lambda **kw: []
        record = {'name': 'figma', 'servers': {'figma': {'url': 'https://mcp.figma.com/mcp'}}}
        with patch.object(plugins, '_installed', return_value=[record]), patch.object(plugins, 'connect'):
            terminal = backend._install_plugin({'name': 'figma', 'request_id': 'connect'})
            terminal()
        message = next(fields['message'] for kind, fields in events if kind == 'command_rejected')
        self.assertIn('request timed out', message)
        self.assertNotIn('approves', message)
        self.assertNotIn('no browser link', message)


if __name__=='__main__':unittest.main()
