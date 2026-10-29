"""Damaged Pip artifact settings must not hide the Pip control page."""

import sqlite3
import unittest
from unittest.mock import patch


class PipArtifactSettingsTests(unittest.TestCase):
    def test_damaged_dashboard_json_falls_back_to_empty_list(self):
        from dgc import artifact_pips
        with sqlite3.connect(":memory:") as db, patch.object(artifact_pips, "_report", return_value=None):
            db.execute(artifact_pips.SCHEMA)
            for raw in ("{broken", '{"dashboard": "wrong shape"}'):
                db.execute("INSERT OR REPLACE INTO pip_artifact_settings VALUES(?,?,?)",
                           ("pip_1", "doc", raw))
                self.assertEqual(artifact_pips.settings(db, "pip_1")["dashboards"], [])


if __name__ == "__main__":
    unittest.main()
