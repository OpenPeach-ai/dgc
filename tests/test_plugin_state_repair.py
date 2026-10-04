"""An unreadable installed-plugins record is repaired, never left to empty Plugins and Apps."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import plugins

# The real file that emptied a profile's Plugins and Apps: `installed` overwritten by a sentence.
CORRUPT = {"installed": "Recipe proven. Now the build: checking the backend image/requirements "
                        "and the peer's compose changes before touching them.",
           "removed_defaults": ["figma"]}


class PluginStateRepairTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.home = Path(temp.name) / "plugins"; self.home.mkdir()
        for name, value in {"PLUGIN_HOME": self.home, "SKILL_ROOT": self.home / "skills",
                            "LOGO_ROOT": self.home / "logos", "STATE_PATH": self.home / "installed.json"}.items():
            p = patch.object(plugins, name, value); p.start(); self.addCleanup(p.stop)

    def write(self, value):
        plugins.STATE_PATH.write_text(json.dumps(value) if not isinstance(value, str) else value)

    def test_a_sentence_over_the_installed_list_no_longer_empties_the_catalog(self):
        self.write(CORRUPT)
        with contextlib.redirect_stderr(io.StringIO()) as err:
            plugins.ensure_first_party()
            rows = plugins.catalog_for_editor(connected=set())
        names = [row["name"] for row in rows]
        self.assertIn("composio", names)
        self.assertIn("dgc-templates", names)
        state = json.loads(plugins.STATE_PATH.read_text())
        self.assertIsInstance(state["installed"], list)
        self.assertEqual(state["removed_defaults"], ["figma"], "the user's removed defaults are kept")
        [aside] = list(self.home.glob("installed.json.invalid-*"))
        self.assertEqual(json.loads(aside.read_text()), CORRUPT, "the unreadable original is kept for inspection")
        self.assertIn("kept it as", err.getvalue())

    def test_valid_records_survive_and_bad_ones_are_dropped(self):
        good = {"name": "fixture", "metadata": {}}
        self.write({"installed": [good, "not a record", {"no": "name"}], "removed_defaults": ["figma", 3]})
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(plugins._installed(), [good])
        self.assertEqual(json.loads(plugins.STATE_PATH.read_text())["removed_defaults"], ["figma"])

    def test_unparseable_json_and_a_valid_file_are_handled_without_surprises(self):
        self.write("{not json")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(plugins._installed(), [])
        valid = {"installed": [{"name": "fixture"}], "removed_defaults": []}
        self.write(valid)
        before = sorted(p.name for p in self.home.iterdir())
        self.assertEqual(plugins._installed(), [{"name": "fixture"}])
        self.assertEqual(sorted(p.name for p in self.home.iterdir()), before, "a valid file is never rewritten")


if __name__ == "__main__":
    unittest.main()
