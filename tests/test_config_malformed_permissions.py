import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import config


class MalformedConfigTests(unittest.TestCase):
    def test_malformed_saved_permissions_do_not_break_load_or_save(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config_file = root / "config.json"
            config_file.write_text(json.dumps({"permissions": {"allow": 3, "ask": ["ask me", 4],
                                                               "deny": None}}))
            with patch.object(config, "USER_CONFIG", config_file), \
                 patch.object(config, "USER_SECRETS", root / "secrets.json"):
                instance = config.Config(project_root=root)
                self.assertEqual(instance.permissions, {"allow": [], "ask": ["ask me"], "deny": []})
                instance.set("theme", "dark")
            self.assertEqual(json.loads(config_file.read_text())["permissions"],
                             {"allow": [], "ask": ["ask me"], "deny": []})

    def test_nonfinite_subagent_window_is_rejected(self):
        self.assertIsNone(config.subagent_window_arg("inf"))
