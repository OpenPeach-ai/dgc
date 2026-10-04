"""Share a Pip: the file carries the job, never the person's accounts or the Pip's life."""
import contextlib
import io
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_cli, pip_share as share
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

WEB = {"schema_version": 1, "reads": [{"kind": "search", "query": "Infosys results"}]}
APPS = {"schema_version": 1, "server": "composio", "connection_digest": "a" * 64, "calls": [
    {"tool": "GMAIL_FETCH_EMAILS", "schema_digest": "b" * 64, "account": "ca_work_account_123",
     "arguments": {"max_results": 5, "query": "is:unread", "user_id": "me", "include_payload": False}}]}


class ExportTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def personal(self, changes):
        pip = self.store.create(self.registry.personal()["id"], "Market brief", "Brief me before the open", "local-console")
        proposal = self.store.propose(pip["id"], 1, changes, "local-console")
        self.store.accept(pip["id"], proposal["id"], 1, "local-console")
        return pip

    def test_the_file_carries_the_job_and_says_what_it_left_out(self):
        schedule = {"type": "cron", "cron": "30 8 * * 1-5", "timezone": "Asia/Kolkata"}
        pip = self.personal({"schedule": schedule, "web_plan": WEB})
        document = share.export(self.store, pip["id"])
        self.assertEqual(document["format"], "dgc-pip")
        self.assertEqual({k: document["pip"][k] for k in ("name", "goal", "scope", "web_plan")},
                         {"name": "Market brief", "goal": "Brief me before the open", "scope": "personal", "web_plan": WEB})
        self.assertEqual({k: document["pip"]["schedule"][k] for k in schedule}, schedule)
        self.assertNotIn("model_choice", document["pip"], "the default model stays the importer's own")
        self.assertEqual(document["left_out"], [share.ALWAYS_LEFT_OUT])
        text = share.dumps(document)
        self.assertNotIn(pip["id"], text, "no IDs from this machine")
        self.assertNotIn(self.registry.personal()["id"], text)

    def test_connected_account_reads_never_leave_the_machine(self):
        pip = self.personal({"app_plan": APPS})
        text = share.dumps(share.export(self.store, pip["id"]))
        self.assertNotIn("ca_work_account_123", text)
        self.assertNotIn("composio", text)
        self.assertIn("Reads from connected apps", text, "but the file says they were left out")

    def test_round_trip_becomes_an_ordinary_setup_card_request(self):
        pip = self.personal({"schedule": {"type": "daily", "time": "09:00", "timezone": "UTC"}, "web_plan": WEB})
        request = share.setup_request(share.parse(share.dumps(share.export(self.store, pip["id"]))),
                                      project_root=self.root, request_key="k")
        self.assertEqual((request["scope"], request["work_kind"], request["run_now"]), ("personal", "personal_task", False))
        self.assertEqual(request["web_plan"], WEB)
        self.assertEqual(request["reason"], "Imported from a shared Pip file.")

    def test_a_file_that_is_not_a_shared_pip_is_refused_plainly(self):
        good = {"format": "dgc-pip", "version": 1, "pip": {"name": "n", "goal": "g", "pip_type": "lens", "scope": "personal", "schedule": None}}
        share.check(good)
        for bad in ("not json", json.dumps({**good, "version": 2}), json.dumps({**good, "pip": {**good["pip"], "app_plan": APPS}}),
                    json.dumps({**good, "pip": {**good["pip"], "pip_type": "patch"}}),
                    json.dumps({**good, "pip": {**good["pip"], "pip_type": "pulse"}}),
                    json.dumps({**good, "extra": 1}), "x" * (share.MAX_BYTES + 1)):
            with self.subTest(bad=bad[:40]), self.assertRaises(RegistryError):
                share.parse(bad)


class ImportControlTests(unittest.TestCase):
    """The editor's import, through the real chat backend handler: a pending card, nothing more."""

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        fixtures.LocalPipsTests.commit(self)
        self.registry.associate_session("chat-one", self.root)
        from dgc.headless import Backend
        self.backend = Backend.__new__(Backend)
        self.backend.agent = SimpleNamespace(_pip_proposal_origin=lambda: {"session_id": "chat-one", "workspace_id": self.workspace["id"]})

    git = fixtures.LocalPipsTests.git

    def importing(self, request):
        with patch("dgc.workspace_registry.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return self.backend._pip_import(self.cfg, {"type": "import_pip_document", "request_id": "r", **request})

    def test_an_imported_file_is_a_pending_setup_card_for_this_chat(self):
        document = {"format": "dgc-pip", "version": 1, "left_out": ["Reads from connected apps: they name your accounts."],
                    "pip": {"name": "Reviewer", "goal": "Review the committed source.", "pip_type": "rook", "scope": "project",
                            "schedule": {"type": "daily", "time": "02:00", "timezone": "UTC"}, "source_ref": "HEAD"}}
        value = self.importing({"document": json.dumps(document)})
        self.assertEqual(value["setup"]["status"], "pending")
        self.assertEqual(value["left_out"], document["left_out"])
        self.assertIsNone(self.registry.db.execute("SELECT 1 FROM pips").fetchone(), "nothing is created until approved")
        with patch("dgc.redaction.secret_values", return_value=["Review the committed source."]), self.assertRaises(RegistryError) as raised:
            self.importing({"document": document})
        self.assertEqual(raised.exception.code, "secret_detected")


class CommandLineTests(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True

    def cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), patch("sys.stdin", io.StringIO()):
            code = pip_cli.handle_command(self.cfg, list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_export_to_a_private_file_then_import_after_confirming(self):
        code, text, err = self.cli("create", "Watcher", "--personal", "--goal", "Watch the pricing page", "--json")
        self.assertEqual(code, 0, err)
        pip_id = json.loads(text)["pip"]["id"]
        path = self.root / "watcher.pip.json"
        code, text, err = self.cli("export", pip_id, "--output", str(path))
        self.assertEqual(code, 0, err)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(path.read_text())["pip"]["goal"], "Watch the pricing page")
        code, _, err = self.cli("import", str(path))
        self.assertNotEqual(code, 0, "without a terminal it asks for --yes")
        self.assertIn("Job: Watch the pricing page", err, "the job is shown first")
        code, text, err = self.cli("import", str(path), "--yes", "--json")
        self.assertEqual(code, 0, err)
        code, text, _ = self.cli("list", "--personal", "--json")
        self.assertEqual([p["goal"] for p in json.loads(text)["pips"]].count("Watch the pricing page"), 2)


if __name__ == "__main__":
    unittest.main()
