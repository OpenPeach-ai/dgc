"""Package metadata for editor settings, without vendor or filesystem side effects."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from dgc import plugins


class PluginSettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.package = self.root / 'package'
        self.package.mkdir()

    def write(self, path, data):
        target = self.package / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data) if isinstance(data, dict) else data)
        return target

    def test_interface_and_declared_app_names_are_used(self):
        self.write('.codex-plugin/plugin.json', {'interface': {
            'displayName': 'Declared name', 'shortDescription': 'Short',
            'longDescription': 'Long', 'developerName': 'Publisher',
            'category': 'Tools', 'privacyPolicyURL': 'https://publisher.test/privacy',
            'termsOfServiceURL': 'https://publisher.test/terms',
            'defaultPrompt': ['One', 'Two'], 'brandColor': '#123456',
        }})
        self.write('.app.json', {'apps': {'connector-id': {'displayName': 'Declared service'}}})
        meta = plugins._package_metadata(self.package)
        self.assertEqual(meta['display_name'], 'Declared name')
        self.assertEqual(meta['developer'], 'Publisher')
        self.assertEqual(meta['long_summary'], 'Long')
        self.assertEqual(meta['apps'][0]['name'], 'Declared service')
        self.assertEqual(meta['default_prompt'], ['One', 'Two'])
        self.assertEqual(meta['terms_url'], 'https://publisher.test/terms')

    def test_single_app_opaque_id_uses_package_display_name(self):
        self.write('.claude-plugin/plugin.json', {'interface': {'displayName': 'Service'}})
        self.write('.app.json', {'apps': {'app-opaque-id': {'id': 'opaque'}}})
        self.assertEqual(plugins._package_metadata(self.package)['apps'],
                         [{'id': 'app-opaque-id', 'name': 'Service'}])

    def test_mcp_declarations_do_not_expose_secrets(self):
        self.write('.mcp.json', {'mcpServers': {
            'remote': {'url': 'https://service.test/mcp?token=secret', 'headers': {'Authorization': 'secret'}},
            'local': {'command': 'node', 'args': ['--secret', 'secret'], 'env': {'TOKEN': 'secret'}},
            'unsafe': {'url': 'https://user:secret@service.test/mcp'},
        }})
        result = plugins._package_metadata(self.package)['mcps']
        self.assertNotIn('secret', json.dumps(result))
        self.assertEqual(result[0]['url'], 'https://service.test/mcp')
        self.assertEqual(result[1]['transport'], 'stdio')
        self.assertEqual(result[2]['url'], '')

    def test_frontmatter_folded_description_not_body(self):
        skill = self.write('skills/a/SKILL.md', '---\nname: first\ndescription: >-\n  First line\n  and second line.\n---\nBODY MUST NOT BE A DESCRIPTION\n')
        self.assertEqual(plugins._frontmatter_field(skill, 'description'), 'First line and second line.')
        self.assertEqual(plugins._frontmatter_field(skill, 'name'), 'first')

    def test_malformed_and_oversize_metadata_fail_closed(self):
        for text in ['---\ndescription: !!python/object malicious\n---\nBody', 'x'*65537]:
            skill = self.write('skills/a/SKILL.md', text)
            self.assertEqual(plugins._frontmatter_field(skill, 'description'), '')
        self.write('.codex-plugin/plugin.json', '{"interface":' + ' '*65537)
        self.assertEqual(plugins._package_json(self.package, '.codex-plugin/plugin.json'), {})

    def test_package_metadata_cannot_read_outside_package(self):
        (self.root / 'outside.json').write_text('{"apps":{"private":{"name":"secret"}}}')
        self.write('.codex-plugin/plugin.json', {'apps': '../outside.json'})
        self.assertEqual(plugins._package_metadata(self.package)['apps'], [])
        (self.package / 'linked.json').symlink_to(self.root / 'outside.json')
        self.assertEqual(plugins._package_json(self.package, 'linked.json'), {})

    def test_catalog_prefers_manifest_and_keeps_installed_link_packages(self):
        self.write('.claude-plugin/plugin.json', {'interface': {'displayName': 'Manifest name', 'developerName': 'Publisher'}})
        records = [{'name': 'from-link', 'metadata': {'display_name': 'Linked plugin', 'apps': [], 'mcps': []}, 'skills': []}]
        with patch.object(plugins, 'load_catalog', return_value={'plugins': [{'name': 'curated', 'display_name': 'Fallback'}]}), \
             patch.object(plugins, '_installed', return_value=records), \
             patch.object(plugins, '_source', side_effect=lambda e: self.package if e['name']=='curated' else (_ for _ in ()).throw(plugins.PluginError('gone'))):
            rows = plugins.catalog_for_editor()
        self.assertEqual(rows[0]['display_name'], 'Manifest name')
        self.assertEqual(rows[0]['developer'], 'Publisher')
        self.assertEqual(rows[1]['display_name'], 'Linked plugin')
        self.assertTrue(rows[1]['installed'])

    def test_a_skill_toggle_survives_an_unreadable_plugin_store(self):
        # The catalog read used to sit inside set_skill_enabled's own try, and PluginError is a
        # ValueError -- so a truncated installed.json or one dead marketplace root reported a toggle
        # that had already committed to disk and to the live agent as reason="invalid_skill",
        # naming a file the skill has nothing to do with.
        from types import SimpleNamespace
        from dgc.headless import Backend
        from dgc.skills import Skill
        loaded = Skill("fixture", "Description", "Current", self.package / "SKILL.md")
        values, events = {}, []
        backend = object.__new__(Backend)
        backend.config = SimpleNamespace(project_root=self.package, get=lambda k, d=None: values.get(k, d),
                                         set=lambda k, v: values.__setitem__(k, v))
        backend.agent = SimpleNamespace(skills={"fixture": loaded}, ctx=None)
        backend.em = SimpleNamespace(emit=lambda kind, **kw: events.append({"type": kind, **kw}))
        backend._busy = lambda: True
        backend._emit_skill_catalog = lambda request: events.append({"type": "skill_catalog"})
        backend._editor_plugins = lambda: (_ for _ in ()).throw(plugins.PluginError('installed.json is not valid JSON'))
        with patch('dgc.skills.discover_skills',
                   return_value={"fixture": Skill("fixture", "Description", "Next", self.package / "SKILL.md")}):
            backend._dispatch({"type": "set_skill_enabled", "name": "fixture", "enabled": False, "request_id": "t"})
        self.assertEqual(values['disabled_skills'], ['fixture'])
        self.assertNotIn('command_rejected', [e['type'] for e in events])
        self.assertIn('skill_catalog', [e['type'] for e in events])

    def test_a_skill_toggle_rebinds_rather_than_emptying_the_live_catalog(self):
        # _dispatch runs on the stdin reader thread while a turn reads agent.skills on the worker.
        # clear() then update() emptied the dict under a reader mid-iteration -- a real
        # "dictionary changed size during iteration" shown to a user who clicked a switch.
        from types import SimpleNamespace
        from dgc.headless import Backend
        from dgc.skills import Skill
        names = ('fixture', 'alpha', 'beta', 'gamma')
        live = {n: Skill(n, "Description", "Current turn", self.package / "SKILL.md") for n in names}
        reader = live                      # what a turn already holds
        ctx = SimpleNamespace(skills=live)
        values, events = {}, []
        backend = object.__new__(Backend)
        backend.config = SimpleNamespace(project_root=self.package, get=lambda k, d=None: values.get(k, d),
                                         set=lambda k, v: values.__setitem__(k, v))
        backend.agent = SimpleNamespace(skills=live, ctx=ctx)
        backend.em = SimpleNamespace(emit=lambda kind, **kw: events.append({"type": kind, **kw}))
        backend._busy = lambda: True
        backend._emit_skill_catalog = lambda request: None
        # Freshly constructed Skill objects, and one MORE of them: a reader iterating the old dict
        # must neither see it change size nor have its own objects mutated underneath it.
        nxt = {n: Skill(n, "Description", "Next turn", self.package / "SKILL.md")
               for n in names + ('delta',)}
        with patch('dgc.skills.discover_skills', return_value=nxt):
            backend._dispatch({"type": "set_skill_enabled", "name": "fixture", "enabled": False, "request_id": "t"})
        self.assertEqual(len(reader), 4, "the dict a turn is iterating never changes size")
        self.assertTrue(reader['fixture'].enabled, "nor is the turn's own Skill object flipped")
        self.assertEqual(len(backend.agent.skills), 5, "the next request takes the new dict whole")
        self.assertFalse(backend.agent.skills['fixture'].enabled)
        self.assertIs(backend.agent.ctx.skills, backend.agent.skills,
                      "the skill tool reads ctx.skills, so it has to move with it")

    def test_a_committed_uninstall_is_reported_even_when_the_catalog_cannot_be_reread(self):
        # plugins.uninstall() commits before the catalog is read back, and one unreadable
        # marketplace cache is enough to make that read raise. Reporting it as command_rejected
        # told the editor the uninstall had not happened: it gates clearUninstalledPluginServers on
        # plugin_operation, so it kept the connector's ownership row and its bearer in
        # SecretStorage and put the server back on the next backend generation, while the retry
        # answered "Plugin is not installed".
        from types import SimpleNamespace
        from dgc.headless import Backend
        values, events = {}, []
        backend = object.__new__(Backend)
        backend.config = SimpleNamespace(project_root=self.package, get=lambda k, d=None: values.get(k, d),
                                         set=lambda k, v: values.__setitem__(k, v))
        backend.agent = SimpleNamespace(mcp=None, reload_skills=lambda: None)
        backend.em = SimpleNamespace(emit=lambda kind, **kw: events.append({"type": kind, **kw}))
        backend._emit_skill_catalog = lambda request: None
        backend._emit_mcp_servers = lambda request: None
        backend._editor_plugins = lambda: (_ for _ in ()).throw(plugins.PluginError('marketplace cache is unreadable'))
        with patch.object(plugins, 'uninstall',
                          return_value={'removed_servers': ['zapier'], 'retained_servers': []}) as uninstall:
            terminal = backend._plugin_operation(
                {"type": "uninstall_plugin", "name": "zapier", "request_id": "rm"})
            terminal()
        uninstall.assert_called_once()
        kinds = [e['type'] for e in events]
        self.assertIn('plugin_operation', kinds)
        self.assertNotIn('command_rejected', kinds)
        operation = next(e for e in events if e['type'] == 'plugin_operation')
        self.assertEqual(operation['removed_servers'], ['zapier'])
        self.assertIn('could not be re-read', operation['message'])
        self.assertNotIn('plugin_catalog', kinds)

    def test_skill_toggle_during_a_turn_keeps_the_loaded_skill(self):
        from types import SimpleNamespace
        from dgc.headless import Backend
        from dgc.skills import Skill
        loaded = Skill("fixture", "Description", "Current turn instructions", self.package / "SKILL.md")
        next_skill = Skill("fixture", "Description", "Next turn instructions", self.package / "SKILL.md")
        values, events = {}, []
        backend = object.__new__(Backend)
        backend.config = SimpleNamespace(project_root=self.package, get=lambda k, d=None: values.get(k, d),
                                         set=lambda k, v: values.__setitem__(k, v))
        backend.agent = SimpleNamespace(skills={"fixture": loaded})
        backend.em = SimpleNamespace(emit=lambda kind, **kw: events.append({"type": kind, **kw}))
        backend._busy = lambda: True
        backend._emit_skill_catalog = lambda request: None
        backend._editor_plugins = lambda: []
        with patch('dgc.skills.discover_skills', return_value={"fixture": next_skill}):
            backend._dispatch({"type": "set_skill_enabled", "name": "fixture", "enabled": False, "request_id": "toggle"})
        self.assertEqual(values['disabled_skills'], ['fixture'])
        self.assertFalse(backend.agent.skills['fixture'].enabled)
        self.assertTrue(loaded.enabled)
        self.assertEqual(loaded.body, "Current turn instructions")
        # A skill toggle answers with skill_catalog and nothing else. plugin_catalog does not
        # exist before 0.45.0 while set_skill_enabled does, so answering this command with one made
        # a 0.44.1 panel print "skipped a backend event it does not handle yet" -- a red alert, read
        # aloud, next to a switch that had worked. The settings tab asks for the catalog itself.
        self.assertNotIn('plugin_catalog', [e['type'] for e in events])


if __name__ == '__main__':
    unittest.main()
