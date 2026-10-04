"""Fewer, better messages: per-Pip thresholds, one daily digest, skipped unchanged audits, outcomes."""
from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from dgc import pip_checkpoints as checkpoints, pip_digest as digest, pip_schedules as schedules, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures
from tests import test_pip_checkpoints


def changed(*paths):
    """A run's pinned source comparison naming the files that changed since its baseline."""
    return {"changes_since_checkpoint": {"status": "compared", "omitted_changes": 0,
                                         "changes": [{"status": "modified", "path": p} for p in paths]}}


class DigestTests(unittest.TestCase):
    """Real checkpoints from completed audits; only the clock moves."""
    _fixture = test_pip_checkpoints.PipCheckpointTests
    new_pip, finding, report = _fixture.new_pip, _fixture.finding, _fixture.report
    source_run, complete = _fixture.source_run, _fixture.complete

    def setUp(self):
        self._fixture.setUp(self)
        self.now = "2026-10-01T10:00:00.000Z"
        self.registry.clock = lambda: self.now
        day = patch.object(digest, "local_day", side_effect=lambda instant: self.day)
        day.start(); self.addCleanup(day.stop)
        self.day = "2026-10-01"

    def at(self, stamp):
        self.now = stamp

    def build(self):
        return digest.build(self.registry)

    def test_settings_are_the_users_and_never_part_of_the_reviewed_job(self):
        pip_id = self.job["id"]
        self.assertEqual(digest.settings(self.registry, pip_id),
                         {"pip_id": pip_id, "min_severity": "medium", "alert_severity": "high", "revision": 0, "is_default": True})
        changed_ = digest.set_settings(self.registry, pip_id, min_severity="high", alert_severity=None,
                                       expected_revision=0, actor="editor-user")
        self.assertEqual((changed_["min_severity"], changed_["alert_severity"], changed_["revision"]), ("high", None, 1))
        self.assertEqual(self.store.get(pip_id)["current_version"], self.job["current_version"], "no job version")
        for actor, kwargs, code in (("main-chat", {}, "local_only"), ("editor-user", {"expected_revision": 0}, "conflict"),
                                    ("editor-user", {"alert_severity": "low"}, "invalid_digest"),
                                    ("editor-user", {"min_severity": "urgent"}, "invalid_digest")):
            with self.subTest(actor=actor, kwargs=kwargs), self.assertRaises(RegistryError) as raised:
                digest.set_settings(self.registry, pip_id, **{"min_severity": "medium", "alert_severity": "high",
                                                              "expected_revision": 1, "actor": actor, **kwargs})
            self.assertEqual(raised.exception.code, code)

    def test_a_new_high_finding_alerts_and_lower_ones_wait_below_the_threshold(self):
        self.complete([self.finding("Unchecked user id", severity="high"), self.finding("Typo in log", severity="low", line=2)])
        self.at("2026-10-01T10:05:00.000Z")
        value = self.build()
        self.assertEqual((value["due"], value["reason"]), (True, "alert"))
        [pip] = value["pips"]
        self.assertEqual((pip["new_total"], pip["below_threshold"], pip["alert"]), (1, 1, True))
        self.assertEqual(pip["new_findings"][0]["title"], "Unchecked user id")
        self.assertIn("1 new finding from Review (worst: high)", value["headline"])
        digest.mark_seen(self.registry, value["until"], "editor-user")
        self.at("2026-10-01T11:00:00.000Z")
        later = self.build()
        self.assertFalse(later["due"], "seen today and nothing new since")
        self.assertEqual(later["since"], value["until"])
        self.assertEqual(later["pips"], [])

    def test_repeated_findings_stay_quiet_until_the_next_day(self):
        finding = self.finding("Unchecked user id", severity="high")
        self.complete([finding])
        digest.mark_seen(self.registry, self.build()["until"], "local-console")
        self.at("2026-10-01T12:00:00.000Z")
        self.complete([finding])                  # the same finding again: repeated, not new
        value = self.build()
        self.assertFalse(value["due"])
        self.assertEqual((value["pips"][0]["new_total"], value["pips"][0]["runs"]["succeeded"]), (0, 1))
        self.assertIn("Nothing new from 1 Pip · 1 run", value["headline"])
        self.day = "2026-10-02"
        self.assertEqual((self.build()["due"], self.build()["reason"]), (True, "daily"))

    def test_alerts_follow_the_pips_own_settings(self):
        digest.set_settings(self.registry, self.job["id"], min_severity="low", alert_severity=None,
                            expected_revision=0, actor="local-console")
        self.complete([self.finding("Crash on empty input", severity="critical")])
        digest.mark_seen(self.registry, "2026-10-01T09:59:00.000Z", "local-console")   # seen earlier today
        value = self.build()
        self.assertFalse(value["due"], "no alerts: a critical finding waits for tomorrow's digest")
        self.assertEqual(value["pips"][0]["new_total"], 1)

    def test_finding_text_is_redacted_and_seen_never_moves_backwards(self):
        with patch("dgc.redaction.secret_values", return_value=["hunter2-very-secret"]):
            self.complete([self.finding("Token hunter2-very-secret is logged", severity="high")])
            title = self.build()["pips"][0]["new_findings"][0]["title"]
        self.assertNotIn("hunter2", title)
        digest.mark_seen(self.registry, "2026-10-01T10:00:00.000Z", "local-console")
        self.assertEqual(digest.mark_seen(self.registry, "2026-10-01T09:00:00.000Z", "local-console")["seen_until"],
                         "2026-10-01T10:00:00.000Z")
        for until in ("2026-10-01T10:00:01.000Z", "yesterday", "2026-10-01T10:00:00Z"):
            with self.subTest(until=until), self.assertRaises(RegistryError):
                digest.mark_seen(self.registry, until, "local-console")
        with self.assertRaises(RegistryError):
            digest.mark_seen(self.registry, self.now, "main-chat")

    def test_a_reworded_finding_is_neither_new_nor_gone(self):
        """Seen in a real run: the model reworded an unchanged finding after a commit to the same
        file. Its checkpoint identity changed with the title; the issue did not."""
        sql = self.finding("SQL built from user input", severity="critical", path="shop.py", line=6, evidence="db.execute(q + name)")
        discount = self.finding("Discount is unbounded", severity="medium", path="shop.py", line=10, evidence="return price - price * percent / 100")
        self.complete([sql, discount])
        digest.mark_seen(self.registry, self.build()["until"], "local-console")
        self.at("2026-10-01T11:00:00.000Z")
        reworded = {**discount, "title": "apply_discount accepts negative and >100 percent"}
        self.complete([reworded], manifest_changes=changed("shop.py"))   # sql fixed; discount reworded
        value = self.build()
        [pip] = value["pips"]
        self.assertEqual((pip["new_total"], pip["gone_after_change"]), (0, 1), "only the SQL finding went away")
        result = digest.outcomes(self.registry, self.job["id"])
        self.assertEqual((result["reported"], result["still_reported"], result["gone_after_change"]), (2, 1, 1))

    def test_findings_that_go_away_after_their_file_changed_are_counted_never_called_fixed(self):
        a = self.finding("Unchecked user id", severity="high", path="api/users.py")
        b = self.finding("Unbounded retry", severity="medium", path="jobs/retry.py")
        c = self.finding("Silent except", severity="medium", path="jobs/queue.py")
        first, checkpoint = self.complete([a, b, c])
        checkpoints.review_finding(self.store, first, 0, "accepted", 0, "editor-user", "Real issue")
        self.at("2026-10-01T11:00:00.000Z")
        self.complete([], manifest_changes=changed("api/users.py"))   # users.py changed; all three gone
        value = self.build()
        self.assertEqual(value["pips"][0]["gone_after_change"], 1)
        self.assertIn("1 earlier finding gone after a change", value["headline"])
        result = digest.outcomes(self.registry, self.job["id"])
        self.assertEqual({k: result[k] for k in ("reported", "accepted", "dismissed", "still_reported",
                                                  "gone_after_change", "gone_without_change")},
                         {"reported": 3, "accepted": 1, "dismissed": 0, "still_reported": 0,
                          "gone_after_change": 1, "gone_without_change": 2})
        self.at("2026-10-01T12:00:00.000Z")
        self.complete([b], manifest_changes=changed())                # b is reported again
        self.assertEqual(digest.outcomes(self.registry, self.job["id"])["still_reported"], 1)


class SkipUnchangedTests(unittest.TestCase):
    """A scheduled audit that would read exactly what its last report read is skipped."""
    setUp = __import__("tests.test_pip_schedules", fromlist=["x"]).ScheduleStateTests.setUp

    def job(self):
        job = self.store.create(self.workspace["id"], "Auditor", "Inspect source", "user")
        proposal = self.store.propose(job["id"], 1, {"schedule": {"type": "interval", "minutes": 5}}, "user")
        return self.store.accept(job["id"], proposal["id"], 1, "user")

    def report(self, run_id, findings=()):
        row = self.store.claim_next()
        self.assertEqual(row["id"], run_id)
        self.store.finish(run_id, result={"summary": "Checked", "findings": list(findings),
                                          "limitations": ["Tests were not run."], "tests_executed": False,
                                          "verification": checkpoints._SOURCE_VERIFICATION})

    def test_unchanged_source_skips_the_occurrence_and_says_why(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        self.assertEqual(schedules.tick(self.registry, self.cfg)["enqueued"], 1, "no report yet: it runs")
        self.report(self.store.runs(job["id"])[0]["id"])
        self.now = "2026-10-01T10:10:00.000Z"
        result = schedules.tick(self.registry, self.cfg)
        self.assertEqual((result["enqueued"], result["skipped"]), (0, 1))
        self.assertEqual(len(self.store.runs(job["id"])), 1)
        event = self.registry.db.execute("SELECT payload FROM workspace_events WHERE event_type='pip_schedule_skipped'").fetchone()
        self.assertEqual(json.loads(event[0])["reason"], "source_unchanged")
        state = self.registry.db.execute("SELECT next_due_at FROM pip_schedule_state WHERE pip_id=?", (job["id"],)).fetchone()
        self.assertEqual(state[0], "2026-10-01T10:15:00.000Z", "the schedule moves on")
        manual = self.store.enqueue(job["id"], "manual-one", "user", self.cfg)
        self.assertEqual(manual["status"], "queued", "a manual run always runs")

    def test_a_new_commit_or_a_changed_job_runs_again(self):
        prior = {"checkpoint": {"job_version": 2, "model": "fixture", "context_digest": "c" * 64}}
        same = {"checkpoint": prior, "changes": {"status": "compared", "total_changes": 0}}
        job, model, context = {"current_version": 2}, {"model": "fixture"}, {"digest": "c" * 64}
        self.assertTrue(pips._unchanged_since_checkpoint(same, job, model, context))
        for preparation, job_, model_, context_ in (
                ({**same, "changes": {"status": "compared", "total_changes": 1}}, job, model, context),
                ({**same, "changes": {"status": "unavailable", "total_changes": None}}, job, model, context),
                ({**same, "checkpoint": {"checkpoint": None}}, job, model, context),
                (same, {"current_version": 3}, model, context),
                (same, job, {"model": "other"}, context),
                (same, job, model, {"digest": "d" * 64})):
            with self.subTest(preparation=preparation, job=job_, model=model_, context=context_):
                self.assertFalse(pips._unchanged_since_checkpoint(preparation, job_, model_, context_))


class DigestMigrationTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def test_schema33_gains_the_digest_tables_and_an_older_reader_refuses_34(self):
        from dgc import workspace_registry
        from dgc.workspace_registry import WorkspaceRegistry
        from tests.pip_test_migrations import drop_digest_schema
        pip = self.store.create(self.workspace["id"], "Kept", "Review", "local-console")
        drop_digest_schema(self.registry.db)
        self.registry.db.execute("PRAGMA user_version=33")
        with WorkspaceRegistry(self.registry.directory) as upgraded:
            self.assertEqual(upgraded.db.execute("PRAGMA user_version").fetchone()[0], 34)
            self.assertEqual(digest.settings(upgraded, pip["id"])["is_default"], True)
            self.assertIsNone(upgraded.db.execute("SELECT 1 FROM pip_digest_state").fetchone())
        with patch.object(workspace_registry, "SCHEMA_VERSION", 33), self.assertRaises(RegistryError):
            WorkspaceRegistry(self.registry.directory)


class DigestControlTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def control(self, request, actor="editor-user"):
        self.cfg.data["pips_enabled"] = True
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def test_digest_and_settings_are_local_controls(self):
        pip = self.store.create(self.workspace["id"], "Reviewer", "Review", "local-console")
        value = self.control({"type": "get_pip_digest"})
        self.assertTrue(value["ok"], value)
        self.assertFalse(value["result"]["digest"]["due"])
        seen = self.control({"type": "mark_pip_digest_seen", "until": value["result"]["digest"]["until"]})
        self.assertTrue(seen["ok"], seen)
        settings = self.control({"type": "set_pip_notify_settings", "pip_id": pip["id"], "min_severity": "low",
                                 "alert_severity": "critical", "expected_revision": 0})
        self.assertEqual(settings["result"]["settings"]["revision"], 1)
        self.assertTrue(self.control({"type": "get_pip_outcomes", "pip_id": pip["id"]})["ok"])
        refused = self.control({"type": "get_pip_digest"}, actor="device_paired")
        self.assertEqual(refused["error"]["code"], "local_only")
        extra = self.control({"type": "get_pip_digest", "workspace_id": self.workspace["id"]})
        self.assertEqual(extra["error"]["code"], "invalid_request")


if __name__ == "__main__":
    unittest.main()
