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

    def test_every_open_chat_polls_but_the_digest_is_rebuilt_only_when_something_changed(self):
        self.complete([self.finding("Unchecked user id", severity="high")])
        with patch.object(digest, "_build", wraps=digest._build) as built:
            first = self.build()
            self.assertEqual(self.build(), first)
            self.assertEqual(built.call_count, 1, "nothing changed: the cached digest")
            digest.mark_seen(self.registry, first["until"], "editor-user")
            self.assertFalse(self.build()["due"], "seeing it changes the answer at once")
            self.at("2026-10-01T10:30:00.000Z")
            self.complete([self.finding("Unchecked user id", severity="high"), self.finding("Leak", severity="critical", line=3)])
            self.assertTrue(self.build()["due"], "a new run is never hidden by the cache")
            self.assertEqual(built.call_count, 3)

    def fail_run(self, job=None):
        run_id, _ = self.source_run(job=job)
        self.store.finish(run_id, error={"code": "fixture_failure", "message": "The model could not be reached"})
        return run_id

    def test_dismissing_one_pips_news_hides_only_its_news_until_it_does_something_new(self):
        """The Sessions home's dismiss (founder, 2026-10-18: "3 Pips ran and failed ... a dismiss option")."""
        other = self.store.create(self.workspace["id"], "Second", "Inspect source evidence", "HEAD", "fixture")
        self.fail_run()
        self.complete([self.finding("Unchecked user id", severity="high")], job=other)
        self.at("2026-10-01T10:05:00.000Z")
        value = self.build()
        self.assertEqual({p["name"]: (p["runs"]["failed"], p["new_total"]) for p in value["pips"]},
                         {"Review": (1, 0), "Second": (0, 1)})
        seen = digest.mark_news_seen(self.registry, [self.job["id"]], value["until"], "editor-user")
        self.assertEqual(seen, {"seen": [{"pip_id": self.job["id"], "seen_until": value["until"]}]})
        later = self.build()
        self.assertEqual([p["name"] for p in later["pips"]], ["Second"], "only the dismissed Pip's news is gone")
        self.assertEqual((later["failed_runs"], later["since"]), (0, value["since"]), "the digest itself is not marked seen")
        self.assertNotIn("failed run", later["headline"])
        # It stays dismissed for a new registry (a reload, the next poll), with no cached copy.
        from dgc.workspace_registry import WorkspaceRegistry
        digest._CACHE.clear()
        with WorkspaceRegistry(self.registry.directory, clock=lambda: self.now) as reopened:
            self.assertEqual([p["name"] for p in digest.build(reopened)["pips"]], ["Second"])
        # Something new brings it back, counting only the new run.
        self.at("2026-10-01T10:30:00.000Z")
        self.fail_run()
        back = {p["name"]: p for p in self.build()["pips"]}
        self.assertEqual(back["Review"]["runs"], {"succeeded": 0, "failed": 1, "cancelled": 0})
        self.assertEqual(back["Second"]["new_total"], 1)

    def test_marking_news_seen_is_checked_whole_and_never_moves_backwards(self):
        other = self.store.create(self.workspace["id"], "Second", "Inspect source evidence", "HEAD", "fixture")
        self.fail_run()
        until = self.build()["until"]
        self.assertEqual(len(digest.mark_news_seen(self.registry, [self.job["id"], other["id"]], until, "local-console")["seen"]), 2)
        earlier = digest.mark_news_seen(self.registry, [self.job["id"]], "2026-10-01T09:00:00.000Z", "editor-user")
        self.assertEqual(earlier["seen"][0]["seen_until"], until, "an older digest never brings news back")
        missing = "pip_" + "f" * 32
        for pip_ids, stamp, actor, code in (
                ([self.job["id"], missing], until, "editor-user", "not_found"),
                ([], until, "editor-user", "invalid_digest"),
                ([self.job["id"], self.job["id"]], until, "editor-user", "invalid_digest"),
                ([f"pip_{i:032x}" for i in range(digest.MAX_NEWS_SEEN + 1)], until, "editor-user", "invalid_digest"),
                (self.job["id"], until, "editor-user", "invalid_digest"),
                ([self.job["id"]], "2026-10-01T10:00:01.000Z", "editor-user", "invalid_digest"),
                ([self.job["id"]], "2026-10-01T10:00:00Z", "editor-user", "invalid_digest"),
                ([self.job["id"]], until, "main-chat", "local_only")):
            with self.subTest(pip_ids=pip_ids, stamp=stamp, actor=actor), self.assertRaises(RegistryError) as raised:
                digest.mark_news_seen(self.registry, pip_ids, stamp, actor)
            self.assertEqual(raised.exception.code, code)
        rows = self.registry.db.execute("SELECT pip_id FROM pip_news_seen ORDER BY pip_id").fetchall()
        self.assertEqual(sorted(r[0] for r in rows), sorted([self.job["id"], other["id"]]), "a refused request keeps nothing")

    def test_dismissing_changes_the_cached_digest_at_once(self):
        self.fail_run()
        with patch.object(digest, "_build", wraps=digest._build) as built:
            first = self.build()
            self.assertEqual(self.build(), first)
            digest.mark_news_seen(self.registry, [self.job["id"]], first["until"], "editor-user")
            self.assertEqual(self.build()["pips"], [], "the next poll does not bring it back from the cache")
            self.assertEqual(built.call_count, 2)

    def hold(self, created, expires="2026-10-02T10:00:00.000Z"):
        """A submit a Pip's computer is holding for the user, as the supervisor records it."""
        import secrets
        action_id = "compact_" + secrets.token_hex(16)
        with self.registry.transaction():
            self.registry.db.execute(
                "INSERT INTO pip_computer_actions VALUES(?,?,?,?,?,?,?,?,NULL,'pending',?,?,NULL,NULL,NULL)",
                (action_id, self.job["id"], self.job["workspace_id"], None, "host", "request",
                 json.dumps({"method": "POST"}), "a" * 64, created, expires))
        return action_id

    def test_a_held_submit_is_said_at_once_and_counts_until_decided_or_expired(self):
        digest.mark_seen(self.registry, self.build()["until"], "editor-user")
        self.at("2026-10-01T10:05:00.000Z")
        action_id = self.hold("2026-10-01T10:04:00.000Z")
        value = self.build()
        self.assertEqual((value["due"], value["reason"], value["pending_reviews"]), (True, "alert", 1))
        self.assertTrue(value["headline"].startswith(self.job["name"] + " is waiting for your approval to send something"),
                        value["headline"])
        digest.mark_seen(self.registry, value["until"], "editor-user")
        later = self.build()
        self.assertFalse(later["due"], "seen: it is not raised again")
        self.assertEqual(later["pending_reviews"], 1, "but it still waits")
        with self.registry.transaction():           # expiry writes no event; the digest still follows it
            self.registry.db.execute("UPDATE pip_computer_actions SET status='expired',resolved_at=? WHERE id=?",
                                     (self.now, action_id))
        self.assertEqual(self.build()["pending_reviews"], 0)

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

    def test_a_second_issue_on_a_line_still_reported_is_new_not_a_rewording(self):
        line = self.finding("Query built from user input", severity="high", evidence="db.execute(q + name)")
        self.complete([line])
        digest.mark_seen(self.registry, self.build()["until"], "local-console")
        self.at("2026-10-01T11:00:00.000Z")
        second = self.finding("Database errors are swallowed", severity="high", evidence="db.execute(q + name)")
        self.complete([line, second])
        [pip] = self.build()["pips"]
        self.assertEqual([f["title"] for f in pip["new_findings"]], ["Database errors are swallowed"])

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
            self.assertEqual(upgraded.db.execute("PRAGMA user_version").fetchone()[0], workspace_registry.SCHEMA_VERSION)
            self.assertEqual(digest.settings(upgraded, pip["id"])["is_default"], True)
            self.assertIsNone(upgraded.db.execute("SELECT 1 FROM pip_digest_state").fetchone())
        with patch.object(workspace_registry, "SCHEMA_VERSION", 33), self.assertRaises(RegistryError):
            WorkspaceRegistry(self.registry.directory)

    def test_schema45_gains_the_news_seen_table_and_an_older_reader_refuses_46(self):
        from dgc import workspace_registry
        from dgc.workspace_registry import WorkspaceRegistry
        pip = self.store.create(self.workspace["id"], "Kept", "Review", "local-console")
        self.registry.db.execute("DROP TABLE pip_news_seen")
        self.registry.db.execute("PRAGMA user_version=45")
        with WorkspaceRegistry(self.registry.directory) as upgraded:
            self.assertEqual(upgraded.db.execute("PRAGMA user_version").fetchone()[0], 46)
            self.assertEqual(upgraded.db.execute("SELECT count(*) FROM pip_news_seen").fetchone()[0], 0)
            self.assertIsNotNone(upgraded.db.execute("SELECT 1 FROM pips WHERE id=?", (pip["id"],)).fetchone(), "its Pips kept")
        with patch.object(workspace_registry, "SCHEMA_VERSION", 45), self.assertRaises(RegistryError):
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

    def test_one_pips_news_is_marked_seen_by_a_local_control(self):
        pip = self.store.create(self.workspace["id"], "Reviewer", "Review", "local-console")
        until = self.control({"type": "get_pip_digest"})["result"]["digest"]["until"]
        seen = self.control({"type": "mark_pip_news_seen", "pip_ids": [pip["id"]], "until": until})
        self.assertTrue(seen["ok"], seen)
        self.assertEqual(seen["result"], {"seen": [{"pip_id": pip["id"], "seen_until": until}]})
        refused = self.control({"type": "mark_pip_news_seen", "pip_ids": [pip["id"]], "until": until}, actor="device_paired")
        self.assertEqual(refused["error"]["code"], "local_only")
        extra = self.control({"type": "mark_pip_news_seen", "pip_ids": [pip["id"]], "until": until, "pip_id": pip["id"]})
        self.assertEqual(extra["error"]["code"], "invalid_request")


if __name__ == "__main__":
    unittest.main()
