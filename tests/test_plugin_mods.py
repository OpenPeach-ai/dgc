"""Mods inside plugins (dgc/plugins.py, dgc/mods/catalog.py): a plugin may hold mods (dgc-mod.json at its root, or
mods/<name>/dgc-mod.json). The install review lists each with what it asks for, in /mods' words; installing is the one
Allow for exactly that. Each is copied into ~/.dgc/mods/installed/<name>, marked with its plugin, and goes when the
plugin does; an update whose mod asks for more says so and asks again; a name another mod has is refused in plain
words; a Claude plugin's hooks stay not imported. The mods list names the plugin a mod came from."""
from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import plugins
from dgc.mods import catalog, consent
from dgc.mods.host import ModHost
from dgc.mods.manifest import describe, load

CODE = "import dgc_mod as dm\nmod = dm.Mod()\nmod.run()\n"


class PluginMods(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(os.path.realpath(temp.name))
        saved = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.root / "home")
        self.addCleanup(lambda: os.environ.__setitem__("DGC_HOME", saved) if saved is not None
                        else os.environ.pop("DGC_HOME", None))
        self.home = self.root / "plugins"
        for name, value in {"PLUGIN_HOME": self.home, "SKILL_ROOT": self.home / "skills",
                            "LOGO_ROOT": self.home / "logos", "STATE_PATH": self.home / "installed.json"}.items():
            p = patch.object(plugins, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.values = {}
        self.config = SimpleNamespace(get=lambda key, default=None: self.values.get(key, default),
                                      set=lambda key, value: self.values.__setitem__(key, value))
        self.package = self.home / "authored" / "fixture"
        self.package.mkdir(parents=True)
        self.entry = {"name": "fixture", "license": "Apache-2.0", "display_name": "Fixture Tools", "install": "allow",
                      "auth": "none", "source_path": str(self.package), "marketplace": "personal"}
        self.write(".codex-plugin/plugin.json", {"name": "fixture", "license": "Apache-2.0"})
        self.mod("mods/tally2", "tally2", draws=["status"], commands=[{"name": "count", "description": "Count"}])

    def write(self, name, value):
        path = self.package / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) if isinstance(value, dict) else value)
        return path

    def mod(self, where, name, **caps):
        self.write(f"{where}/dgc-mod.json", {"name": name, "version": "1.0.0", "entry": "main.py",
                                             "title": name.title(), "capabilities": caps})
        self.write(f"{where}/main.py", CODE)

    def review(self):
        return plugins._preview(self.entry, self.package)

    def install(self, reviewed=None):
        return plugins._install_tree(reviewed if reviewed is not None else self.review(), self.package,
                                     accept_license="")

    def test_the_review_lists_each_mod_with_what_it_asks_in_the_words_mods_uses(self):
        preview = self.review()
        self.assertTrue(preview["supported"], "a plugin of mods alone installs")
        [shown] = preview["mods"]
        self.assertEqual((shown["name"], shown["title"], shown["version"], shown["state"]),
                         ("tally2", "Tally2", "1.0.0", "new"))
        self.assertEqual(shown["asks"], describe(load(self.package / "mods" / "tally2")))
        self.assertIn("It adds /count.", shown["asks"])

    def test_installing_is_the_one_allow_and_marks_the_copy_with_its_plugin(self):
        record = self.install()
        self.assertEqual(record["mods"], ["tally2"])
        copy = catalog.installed_root() / "tally2"
        m = load(copy)
        self.assertEqual(catalog.origin(m), {"plugin": "fixture", "title": "Fixture Tools"})
        self.assertTrue(consent.allowed(m), "installing allowed exactly what the review showed")
        self.assertEqual(set(consent.record("tally2")["grants"]), m.grants())
        entry = next(e for e in ModHost(project_root=None).mods() if e["name"] == "tally2")
        self.assertEqual((entry["plugin"], entry["plugin_title"], entry["state"]), ("fixture", "Fixture Tools", "stopped"))

    def test_failed_plugin_record_write_rolls_back_mod_and_consent(self):
        with patch.object(plugins, "_save", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.install()
        self.assertFalse((catalog.installed_root() / "tally2").exists())
        self.assertIsNone(consent.record("tally2"))

    def test_failed_update_keeps_a_mod_it_would_have_dropped(self):
        self.mod("mods/extra", "extra", draws=["toast"])
        self.install()
        before = consent.record("extra")
        import shutil
        shutil.rmtree(self.package / "mods" / "extra")
        with patch.object(plugins, "_save", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.install()
        self.assertTrue((catalog.installed_root() / "extra").exists())
        self.assertEqual(consent.record("extra"), before)

    def test_an_install_the_review_did_not_show_is_refused(self):
        with self.assertRaisesRegex(plugins.PluginError, "Review what they ask for"):
            plugins._install_tree(self.entry, self.package, accept_license="")
        reviewed = self.review()
        self.mod("mods/tally2", "tally2", draws=["status"], events=["tool.call"],
                 commands=[{"name": "count", "description": "Count"}])
        with self.assertRaisesRegex(plugins.PluginError, "changed since you reviewed them"):
            self.install(reviewed)
        self.assertFalse((catalog.installed_root() / "tally2").exists())
        self.assertEqual(plugins._installed(), [])

    def test_a_mod_changed_during_package_copy_is_refused_before_consent(self):
        reviewed = self.review()
        copy_tree = plugins.sources.copy_tree
        def changed_copy(source, dest):
            copy_tree(source, dest)
            manifest = dest / "mods" / "tally2" / "dgc-mod.json"
            value = json.loads(manifest.read_text())
            value["capabilities"]["events"] = ["tool.call"]
            manifest.write_text(json.dumps(value))
        with patch.object(plugins.sources, "copy_tree", side_effect=changed_copy):
            with self.assertRaisesRegex(plugins.PluginError, "changed since you reviewed them"):
                self.install(reviewed)
        self.assertFalse((catalog.installed_root() / "tally2").exists())
        self.assertIsNone(consent.record("tally2"))
        self.assertEqual(plugins._installed(), [])

    def test_uninstalling_the_plugin_removes_its_mods_and_only_its_own(self):
        self.install()
        result = plugins.uninstall("fixture", config=self.config)
        self.assertEqual(result["removed_mods"], ["tally2"])
        self.assertFalse((catalog.installed_root() / "tally2").exists())
        self.assertIsNone(consent.record("tally2"))
        # A copy the user installed over the plugin's is theirs: it stays.
        self.install()
        catalog.install_folder(self.package / "mods" / "tally2")
        self.assertEqual(plugins.uninstall("fixture", config=self.config)["removed_mods"], [])
        self.assertTrue((catalog.installed_root() / "tally2").is_dir())

    def test_failed_uninstall_record_write_leaves_plugin_intact(self):
        self.install()
        copy = catalog.installed_root() / "tally2"
        package = self.home / "packages" / "fixture"
        with patch.object(plugins, "_save", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                plugins.uninstall("fixture", config=self.config)
        self.assertTrue(copy.is_dir())
        self.assertTrue(package.is_dir())
        self.assertIsNotNone(consent.record("tally2"))
        self.assertEqual([row["name"] for row in plugins._installed()], ["fixture"])

    def test_an_update_whose_mod_asks_for_more_asks_again_and_one_that_doesnt_keeps_its_switch(self):
        self.install()
        consent.set_enabled("tally2", False)                         # the user turned it off
        same = self.review()
        self.assertEqual(same["mods"][0]["state"], "same")
        self.install(same)
        self.assertFalse(consent.record("tally2")["enabled"], "an update asking for nothing more keeps it off")
        self.mod("mods/tally2", "tally2", draws=["status", "pane"], commands=[{"name": "count", "description": "Count"}])
        more = self.review()
        self.assertEqual(more["mods"][0]["state"], "more")
        self.assertIn("It can show a line in the status bar, a panel beside the chat.", more["mods"][0]["asks"])
        self.install(more)
        self.assertTrue(consent.allowed(load(catalog.installed_root() / "tally2")))

    def test_a_mod_an_update_drops_goes_with_it(self):
        self.mod("mods/extra", "extra", draws=["toast"])
        self.assertEqual(self.install()["mods"], ["extra", "tally2"])
        import shutil
        shutil.rmtree(self.package / "mods" / "extra")
        self.assertEqual(self.install()["mods"], ["tally2"])
        self.assertFalse((catalog.installed_root() / "extra").exists())

    def test_a_name_another_mod_has_is_refused_in_plain_words(self):
        mine = self.root / "mine" / "tally2"
        mine.mkdir(parents=True)
        (mine / "dgc-mod.json").write_text(json.dumps({"name": "tally2", "version": "2.0.0", "entry": "main.py"}))
        (mine / "main.py").write_text(CODE)
        catalog.install_folder(mine)
        preview = self.review()
        self.assertFalse(preview["supported"])
        self.assertEqual(preview["compatibility_reason"], "A mod named tally2 is already installed. Remove that one "
                         "first (dgc mods remove tally2) to install this plugin's.")
        with self.assertRaisesRegex(plugins.PluginError, "already installed"):
            self.install(preview)
        self.assertEqual(load(catalog.installed_root() / "tally2").version, "2.0.0", "the user's own is untouched")

    def test_dgc_own_names_are_refused(self):
        self.mod("mods/guard", "guard", events=["tool.call"])
        preview = self.review()
        self.assertFalse(preview["supported"])
        self.assertIn("Its mod guard has the name of one of DGC's own mods", preview["compatibility_reason"])

    def test_a_mod_at_the_plugins_root_and_claude_hooks_still_not_imported(self):
        import shutil
        shutil.rmtree(self.package / "mods")
        self.mod(".", "rooted", draws=["band"])
        self.write("hooks/hooks.json", {"hooks": {}})
        preview = self.review()
        self.assertEqual([m["name"] for m in preview["mods"]], ["rooted"])
        self.assertIn("hooks: this host-specific component is not imported by DGC.", preview["warnings"])
        self.assertEqual(self.install(preview)["mods"], ["rooted"])
        self.assertFalse((catalog.installed_root() / "rooted" / catalog.PLUGIN_MARK).read_text() == "",
                         "marked")

    def test_a_folder_cant_claim_to_be_another_plugins(self):
        self.write(f"mods/tally2/{catalog.PLUGIN_MARK}", {"plugin": "someone-else"})
        catalog.install_folder(self.package / "mods" / "tally2")
        self.assertEqual(catalog.origin(load(catalog.installed_root() / "tally2")), {})

    def test_the_terminal_shows_what_each_mod_asks_and_needs_a_yes(self):
        with patch.object(plugins, "load_catalog", return_value={"plugins": [self.entry]}), \
                patch("sys.stdin", io.StringIO("")):
            with self.assertRaisesRegex(plugins.PluginError, "Run this in a terminal"):
                with redirect_stdout(io.StringIO()):
                    plugins.handle(self.config, ["install", "fixture"])
            self.assertFalse((catalog.installed_root() / "tally2").exists())
            said = io.StringIO()
            with redirect_stdout(said):
                plugins.handle(self.config, ["install", "fixture", "--allow-mods"])
        out = said.getvalue()
        self.assertIn("Fixture Tools adds 1 mod:", out)
        self.assertIn("  Tally2 1.0.0", out)
        self.assertIn("    · It adds /count.", out)
        self.assertIn("mods=1", out)
        self.assertTrue(consent.allowed(load(catalog.installed_root() / "tally2")))


if __name__ == "__main__":
    unittest.main()
