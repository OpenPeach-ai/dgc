"""pips-12: export or import a whole team as one file. The team file is the Pips' shared files, one per Pip (the job,
never the person's accounts, memory or results), with each Pip's folder in the list. Importing makes one pending setup
card per Pip, nothing created until each is approved; a file carrying a configured secret saves nothing."""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_share as share
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures
from tests import test_pip_share as share_tests


class TeamExportTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def pip(self, name, goal):
        return self.store.create(self.registry.personal()["id"], name, goal, "local-console")

    def test_five_pips_export_as_one_file_and_read_back(self):
        pips = [self.pip(f"Pip {n}", f"Job number {n} for the team.") for n in range(5)]
        document = share.export_team(self.store, [p["id"] for p in pips], name="Launch")
        self.assertEqual((document["format"], document["version"], document["name"]), (share.TEAM_FORMAT, 1, "Launch"))
        self.assertEqual([p["pip"]["name"] for p in document["pips"]], [f"Pip {n}" for n in range(5)])
        text = share.dumps(document)
        self.assertEqual(share.parse_team(text), document)
        import re
        self.assertIsNone(re.search(r"pip_[0-9a-f]{32}|ws_[0-9a-f]{32}", text), "no ids from this computer")
        for bad in ([], ["pip_missing"], [pips[0]["id"]] * 2):
            with self.subTest(ids=bad), self.assertRaises(RegistryError):
                share.export_team(self.store, bad)

    def test_the_export_command_is_the_users_on_this_computer(self):
        from dgc import pips
        from dgc.workspace_registry import WorkspaceRegistry
        a, b = self.pip("Scout", "Find things."), self.pip("Quill", "Write things.")
        def control(actor):
            with patch.object(pips, "WorkspaceRegistry", lambda *x, **k: WorkspaceRegistry(self.registry.directory)):
                return pips.handle_control(self.cfg, {"type": "export_pip_team", "request_id": "r", "pip_ids": [a["id"], b["id"]],
                                                      "name": "Ops"}, actor, start_worker=False)
        done = control("editor-user")
        self.assertTrue(done["ok"], done)
        self.assertEqual(share.parse_team(done["result"]["text"])["name"], "Ops")
        self.assertFalse(control("device_1")["ok"])

    def test_a_file_that_is_not_a_team_is_refused_plainly(self):
        for text in ("{}", "[]", "not json", json.dumps({"format": "dgc-pip", "version": 1}),
                     json.dumps({"format": share.TEAM_FORMAT, "version": 1, "name": "x", "pips": []}),
                     json.dumps({"format": share.TEAM_FORMAT, "version": 1, "name": "x", "pips": [{"format": "dgc-pip"}]})):
            with self.subTest(text=text[:40]), self.assertRaises(RegistryError):
                share.parse_team(text)


class TeamImportTests(unittest.TestCase):
    setUp = share_tests.ImportControlTests.setUp
    git = fixtures.LocalPipsTests.git

    def importing(self, document):
        with patch("dgc.workspace_registry.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return self.backend._pip_team_import(self.cfg, {"type": "import_pip_team", "request_id": "r", "document": document})

    def test_a_team_file_becomes_one_pending_card_per_pip(self):
        one = {"name": "Researcher", "goal": "Research the market each morning.", "pip_type": "lens", "scope": "personal", "schedule": None}
        two = {"name": "Writer", "goal": "Write the weekly post.", "pip_type": "quill", "scope": "personal", "schedule": None}
        team = {"format": share.TEAM_FORMAT, "version": 1, "name": "Launch",
                "pips": [{"format": "dgc-pip", "version": 1, "pip": one, "left_out": []},
                         {"format": "dgc-pip", "version": 1, "pip": two, "left_out": []}]}
        value = self.importing(json.dumps(team))
        self.assertEqual([card["status"] for card in value["setups"]], ["pending", "pending"])
        self.assertIsNone(self.registry.db.execute("SELECT 1 FROM pips").fetchone(), "nothing created until approved")
        with patch("dgc.redaction.secret_values", return_value=["Write the weekly post."]), self.assertRaises(RegistryError) as raised:
            self.importing(team)
        self.assertEqual(raised.exception.code, "secret_detected")
        self.assertEqual(len(value["setups"]), 2, "and the refused file saved nothing more")


if __name__ == "__main__":
    unittest.main()
