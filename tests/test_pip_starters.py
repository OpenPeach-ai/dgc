"""Starter Pips: fixed templates that become ordinary setup cards; approving one is still the user's."""
from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_setup, pip_starters as starters
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class CatalogTests(unittest.TestCase):
    def test_the_catalog_is_fixed_and_says_what_each_starter_does(self):
        rows = starters.catalog()
        self.assertEqual([row["id"] for row in rows], ["commit_review", "nightly_security", "morning_brief"])
        for row in rows:
            self.assertTrue(row["title"] and row["summary"] and row["name"])
            self.assertIn(row["scope"], ("project", "personal"))
        self.assertEqual(rows[2]["params"], ["time", "timezone", "web_reads"])

    def test_choices_are_checked_before_anything_is_saved(self):
        build = lambda starter, params: starters.build(starter, params, project_root="/tmp/x", request_key="k")
        for starter, params in (("deploy_bot", {}), ("commit_review", {"time": "02:00"}),
                                ("nightly_security", {"branch": "main", "time": "25:00", "timezone": "UTC"}),
                                ("nightly_security", {"branch": "main", "time": "2:00", "timezone": "UTC"}),
                                ("nightly_security", {"branch": "main", "timezone": "Mars/Olympus"}),
                                ("nightly_security", {"branch": "main"}),
                                ("morning_brief", {"timezone": "UTC", "web_reads": "https://example.com/"})):
            with self.subTest(starter=starter, params=params), self.assertRaises(RegistryError):
                build(starter, params)

    def test_each_starter_builds_the_setup_the_chat_would(self):
        commit = starters.build("commit_review", {"branch": "main"}, project_root="/p", request_key="k")
        self.assertIsNone(commit["schedule"])
        self.assertEqual(commit["event_trigger"], {"events": ["commit_changed"], "minimum_minutes": 5})
        self.assertEqual((commit["pip_type"], commit["source_ref"], commit["run_now"]), ("rook", "main", False))
        nightly = starters.build("nightly_security", {"branch": "main", "timezone": "Asia/Kolkata"},
                                 project_root="/p", request_key="k")
        self.assertEqual(nightly["schedule"], {"type": "daily", "time": "02:00", "timezone": "Asia/Kolkata"})
        brief = starters.build("morning_brief", {"time": "08:05", "timezone": "Europe/London",
                                                 "web_reads": [{"kind": "search", "query": "UK rail strikes today"}]},
                               project_root="/p", request_key="k")
        self.assertEqual(brief["schedule"], {"type": "cron", "cron": "5 8 * * 1-5", "timezone": "Europe/London"})
        self.assertEqual(brief["web_plan"]["reads"], [{"kind": "search", "query": "UK rail strikes today"}])
        self.assertNotIn("source_ref", brief, "a Personal Pip reads no project")
        for request in (commit, nightly, brief):
            pip_setup.validate_request(request)


class SetupTriggerTests(unittest.TestCase):
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.registry.associate_session("main-chat", self.root)
        self.head = self.commit()
        self.branch = self.git("symbolic-ref", "--short", "HEAD")

    def request(self, **changes):
        return {**starters.build("commit_review", {"branch": self.branch}, project_root=self.root,
                                 request_key="starter-one"), **changes}

    def test_only_a_new_reviewer_can_trigger_on_commits_and_never_with_a_schedule(self):
        trigger = {"events": ["commit_changed"]}
        refused = [self.request(schedule={"type": "interval", "minutes": 60}),
                   self.request(pip_type="pulse", work_kind="command_verification"),
                   self.request(event_trigger={"events": ["session_turn_completed"]}),
                   self.request(event_trigger={"events": ["commit_changed", "status_changed"]}),
                   self.request(event_trigger={**trigger, "minimum_minutes": 1}),
                   self.request(pip_id="pip_" + "a" * 32, expected_version=1, expected_lifecycle_revision=0)]
        personal = starters.build("morning_brief", {"timezone": "UTC"}, project_root=self.root, request_key="k")
        refused.append({**personal, "schedule": None, "event_trigger": trigger})
        for request in refused:
            with self.subTest(request={k: request.get(k) for k in ("pip_type", "schedule", "event_trigger", "scope")}), \
                    self.assertRaises(RegistryError):
                pip_setup.validate_request(request)

    def test_an_approved_commit_reviewer_waits_for_the_next_commit(self):
        setup = pip_setup.propose(self.registry, self.request(), self.root, "main-chat")
        self.assertEqual(setup["status"], "pending")
        self.assertEqual(setup["event_trigger"]["events"], ["commit_changed"])
        self.assertIn("new local commits", setup["runner_notice"])
        self.assertIsNone(self.registry.db.execute("SELECT 1 FROM pips").fetchone(), "a card creates nothing")
        result = pip_setup.review(self.registry, setup_id=setup["id"], workspace_id=self.workspace["id"],
                                  expected_digest=setup["digest"], actor="local-user", config=self.cfg, accept=True)
        pip_id = result["receipt"]["pip_id"]
        pip = self.store.get(pip_id)
        self.assertEqual(pip["event_trigger"]["events"], ["commit_changed"])
        self.assertIsNone(pip.get("schedule"))
        state = self.registry.db.execute("SELECT job_version FROM pip_event_trigger_state WHERE pip_id=?", (pip_id,)).fetchone()
        self.assertEqual(state[0], 1, "the trigger is armed for the approved version")
        self.assertIsNone(self.registry.db.execute("SELECT 1 FROM pip_runs").fetchone(), "approval starts no run")


class StarterControlTests(unittest.TestCase):
    """The editor's starter commands, through the real chat backend handler."""
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.commit()
        self.registry.associate_session("chat-one", self.root)
        from dgc.headless import Backend
        self.backend = Backend.__new__(Backend)
        self.backend.agent = SimpleNamespace(_pip_proposal_origin=lambda: {
            "session_id": "chat-one", "workspace_id": self.workspace["id"]})

    def starter(self, request):
        with patch("dgc.workspace_registry.WorkspaceRegistry", return_value=self.registry), \
                patch.object(self.registry, "close"):
            return self.backend._pip_starter(self.cfg, {"request_id": "r", **request})

    def test_listing_and_saving_a_starter_leaves_a_pending_card_for_this_chat(self):
        self.assertEqual(self.starter({"type": "list_pip_starters"})["starters"], starters.catalog())
        setup = self.starter({"type": "propose_starter_pip", "starter": "nightly_security",
                              "params": {"branch": "HEAD", "timezone": "Asia/Kolkata", "time": "03:15"}})["setup"]
        self.assertEqual(setup["status"], "pending")
        self.assertEqual({k: setup["schedule"][k] for k in ("type", "time", "timezone")},
                         {"type": "daily", "time": "03:15", "timezone": "Asia/Kolkata"})
        row = self.registry.db.execute("SELECT session_id FROM pip_setup_proposals WHERE id=?", (setup["id"],)).fetchone()
        self.assertEqual(row[0], "chat-one")
        self.assertIsNone(self.registry.db.execute("SELECT 1 FROM pips").fetchone())

    def test_unknown_fields_and_configured_secrets_are_refused(self):
        with self.assertRaises(RegistryError):
            self.starter({"type": "list_pip_starters", "starter": "commit_review"})
        with self.assertRaises(RegistryError):
            self.starter({"type": "propose_starter_pip", "starter": "commit_review", "params": {}, "pip_id": "x"})
        with patch("dgc.redaction.secret_values", return_value=["Asia/Kolkata"]), self.assertRaises(RegistryError) as raised:
            self.starter({"type": "propose_starter_pip", "starter": "nightly_security",
                          "params": {"branch": "HEAD", "timezone": "Asia/Kolkata"}})
        self.assertEqual(raised.exception.code, "secret_detected")
        self.assertIsNone(self.registry.db.execute("SELECT 1 FROM pip_setup_proposals").fetchone())


class StarterCommandLineTests(unittest.TestCase):
    """`dgc pips starter` uses the profile's own registry, like every other Pips command."""
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.commit()
        self.cfg.data["pips_enabled"] = True

    def cli(self, *argv):
        from dgc import pip_cli
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = pip_cli.handle_command(self.cfg, list(argv))
        return code, out.getvalue(), err.getvalue()

    def rows(self, table):
        from dgc.workspace_registry import WorkspaceRegistry
        with WorkspaceRegistry() as registry:
            return registry.db.execute("SELECT count(*) FROM " + table).fetchone()[0]

    def test_the_cli_lists_starters_and_needs_yes_without_a_terminal(self):
        code, text, _ = self.cli("starters")
        self.assertEqual(code, 0)
        self.assertIn("commit-review", text)
        with patch("sys.stdin.isatty", return_value=False):
            code, text, err = self.cli("starter", "nightly-security", "--branch", "HEAD", "--timezone", "UTC")
        self.assertNotEqual(code, 0)
        self.assertIn("Runs: daily at 02:00 UTC", err, "the exact job is shown before the question")
        self.assertEqual(self.rows("pips"), 0, "nothing without --yes")

    def test_yes_creates_the_reviewed_pip_with_its_trigger(self):
        code, text, _ = self.cli("starter", "commit-review", "--branch", "HEAD", "--yes", "--json")
        self.assertEqual(code, 0, text)
        pip = json.loads(text)["pip"]
        self.assertEqual(pip["event_trigger"]["events"], ["commit_changed"])
        self.assertEqual(pip["source_ref"], "HEAD")
        self.assertEqual(self.rows("pip_runs"), 0, "no run starts")


if __name__ == "__main__":
    unittest.main()
