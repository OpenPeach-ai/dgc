"""Bounded cron and one-shot regressions; controlled clocks, no providers or sleeps."""
from __future__ import annotations

import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from dgc import pip_daemon, pip_schedules as schedules, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_schedules as schedule_fixtures


def cron(expression="0 2 * * *", zone="UTC"):
    return {"type": "cron", "cron": expression, "timezone": zone}


def once(at="2026-10-01T10:05:00Z"):
    return {"type": "once", "at": at}


class CalendarPlanningTests(unittest.TestCase):
    def test_cron_canonical_and_input_unchanged(self):
        source = cron("  0,30  9-17/2 * * 1-5  ", "Asia/Kolkata")
        result = schedules.validate_schedule(source)
        self.assertEqual(result, {"type": "cron", "cron": "0,30 9-17/2 * * 1-5", "timezone": "Asia/Kolkata",
                                  "missed_policy": "coalesce_latest", "dst_policy": "skip_gap_first_fold"})
        self.assertNotIn("missed_policy", source)
        anchor = "2026-10-02T11:59:00Z"  # Friday, 17:29 in Kolkata.
        self.assertEqual(schedules.next_due(result, anchor, anchor), "2026-10-02T12:00:00.000Z")
        self.assertEqual(schedules.next_due(result, "2026-10-02T12:00:00Z", anchor), "2026-10-05T03:30:00.000Z")

    def test_calendar_day_of_month_or_weekday_and_sunday_alias(self):
        # Both constrained means the first of a month OR every Sunday.
        spec = cron("0 12 1 * 0")
        anchor = "2026-10-01T12:00:00Z"
        self.assertEqual(schedules.next_due(spec, anchor, anchor), "2026-10-04T12:00:00.000Z")
        alias = cron("0 12 1 * 7")
        self.assertEqual(schedules.next_due(alias, anchor, anchor), schedules.next_due(spec, anchor, anchor))
        # A restricted impossible DOM does not erase a valid weekday alternative.
        self.assertEqual(schedules.next_due(cron("0 12 30 2 1"), "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z"),
                         "2026-02-02T12:00:00.000Z")

    def test_numeric_cron_grammar_is_bounded_and_rejects_capability_fields(self):
        expressions = ["* * * * *", "*/1 * * * *", "*/4 * * * *", "0,4 * * * *", "0,59 * * * *",
                       "0 0 0 * *", "60 0 * * *", "0 24 * * *", "0 0 1 13 *", "0 0 * * 8",
                       "0 0 * * MON", "@daily", "0 0 * * * command", "0 0 * * *\n", "0\t0 * * *",
                       "0;id 0 * * *", "$(id) 0 * * *", "0 0 L * *", "0 0 ? * 1", "0 0 * * 1#2",
                       "0 0 * * 5-1", "0-10/0 0 * * *", "*/99 0 * * *", "0/5 0 * * *",
                       "0,,5 0 * * *", "0 0 * * * *", "0 0 * *", "0 0 * * *" + " " * 256,
                       "9" * 256 + " 0 * * *", "0," * 33 + "0 0 * * *", "０ 0 * * *", "\ud800"]
        with patch.object(schedules, "_cron_day_matches", side_effect=AssertionError("Invalid grammar must fail before calendar search")):
            for expression in expressions:
                with self.subTest(expression=repr(expression)), self.assertRaises(RegistryError):
                    schedules.validate_schedule(cron(expression))
        for extra in ({"tools": ["bash"]}, {"permissions": "auto"}, {"dst_policy": "both"}, {"missed_policy": "all"},
                      {"timezone": "../../etc/passwd"}, {"timezone": "Unavailable/Zone"}, {"timezone": []}):
            with self.subTest(extra=extra), self.assertRaises(RegistryError):
                schedules.validate_schedule({**cron(), **extra})

    def test_impossible_and_leap_only_schedules_refused_before_persistence(self):
        for expression in ("0 12 30 2 *", "0 12 31 4,6,9,11 *", "0 12 29 2 *"):
            with self.subTest(expression=expression), self.assertRaises(RegistryError):
                schedules.validate_schedule(cron(expression))
        annual = cron("0 12 1 1 *")
        self.assertEqual(schedules.next_due(annual, "2099-12-31T12:00:00Z", "2099-12-31T12:00:00Z"),
                         "2100-01-01T12:00:00.000Z")
        # Gregorian century 2100 is not a leap year, without creating a sparse cron.
        february_end = cron("0 12 28,29 2 *")
        self.assertEqual(schedules.next_due(february_end, "2100-02-28T12:00:00Z", "2099-01-01T00:00:00Z"),
                         "2101-02-28T12:00:00.000Z")

    def test_calendar_validation_work_and_cache_are_bounded(self):
        schedules._compile_cron.cache_clear()
        spec = cron("5 3 * * *")
        with patch.object(schedules, "_cron_day_matches", wraps=schedules._cron_day_matches) as visits:
            schedules.validate_schedule(spec)
            first_count = visits.call_count
            schedules.validate_schedule(spec)
        self.assertEqual(first_count, 146097)
        self.assertEqual(visits.call_count, first_count)
        self.assertEqual(schedules._compile_cron.cache_info().maxsize, 64)

    def test_cron_spring_gap_and_first_fold(self):
        zone = "America/New_York"
        anchor = "2026-03-07T08:00:00Z"
        self.assertEqual(schedules.next_due(cron("30 2 * * *", zone), anchor, anchor), "2026-03-09T06:30:00.000Z")
        spec = cron("*/5 1 * * *", zone)
        anchor = "2026-10-31T08:00:00Z"
        plan = schedules.plan_due(spec, "2026-11-01T05:00:00Z", "2026-11-01T06:31:00Z", anchor)
        self.assertEqual(plan["scheduled_at"], "2026-11-01T05:55:00.000Z")
        self.assertEqual(plan["next_due_at"], "2026-11-02T06:00:00.000Z")
        with self.assertRaisesRegex(RegistryError, "first-fold"):
            schedules.plan_due(spec, "2026-11-01T06:00:00Z", "2026-11-01T06:31:00Z", anchor)

    def test_half_hour_dst_fold_gap_and_date_line(self):
        spec = cron("45 1 * * *", "Australia/Lord_Howe")
        anchor = "2026-04-04T12:00:00Z"
        self.assertEqual(schedules.next_due(spec, anchor, anchor), "2026-04-04T14:45:00.000Z")
        self.assertEqual(schedules.next_due(spec, "2026-04-04T15:16:00Z", anchor), "2026-04-05T15:15:00.000Z")
        anchor = "2026-10-03T12:00:00Z"
        self.assertEqual(schedules.next_due(cron("15 2 * * *", "Australia/Lord_Howe"), anchor, anchor),
                         "2026-10-04T15:15:00.000Z")
        anchor = "2011-12-30T00:00:00Z"
        self.assertEqual(schedules.next_due(cron("0 12 * * *", "Pacific/Apia"), anchor, anchor),
                         "2011-12-30T22:00:00.000Z")

    def test_offline_centuries_coalesce_without_enumerating_missed_occurrences(self):
        spec = schedules.validate_schedule(cron("*/5 * * * *"))
        with patch.object(schedules, "_local_occurrence", wraps=schedules._local_occurrence) as visits:
            plan = schedules.plan_due(spec, "2000-01-01T00:05:00Z", "2399-12-30T23:52:00Z", "2000-01-01T00:00:00Z")
        self.assertEqual(plan["scheduled_at"], "2399-12-30T23:50:00.000Z")
        self.assertEqual(plan["next_due_at"], "2399-12-30T23:55:00.000Z")
        self.assertTrue(plan["coalesced"])
        self.assertLessEqual(visits.call_count, 2 * schedules.MAX_CRON_SLOTS + 1)

    def test_search_bound_and_date_overflow_fail_closed(self):
        # Annual calendar is valid, but the next year's occurrence is in a gap.
        spec = cron("30 2 8 3 *", "America/New_York")
        with self.assertRaisesRegex(RegistryError, "370"):
            schedules.next_due(spec, "2025-03-09T12:00:00Z", "2025-03-09T12:00:00Z")
        with self.assertRaises(RegistryError):
            schedules.next_due(cron(), datetime.max.replace(tzinfo=timezone.utc), "2026-01-01T00:00:00Z")

    def test_cron_forged_cursor_not_due_and_clock_rollback(self):
        spec = cron("*/5 * * * *")
        anchor = "2026-10-01T10:00:00Z"
        self.assertIsNone(schedules.plan_due(spec, "2026-10-01T10:05:00Z", "2026-10-01T09:59:00Z", anchor))
        for first in ("2026-10-01T10:01:00Z", "2026-10-01T10:05:01Z", "2026-10-01T10:00:00Z"):
            with self.subTest(first=first), self.assertRaises(RegistryError):
                schedules.plan_due(spec, first, "2026-10-01T10:06:00Z", anchor)

    def test_once_canonical_offset_and_constant_time_exhaustion(self):
        canonical = schedules.validate_schedule(once("2026-10-01T15:35:00.123+05:30"))
        self.assertEqual(canonical, {"type": "once", "at": "2026-10-01T10:05:00.123Z", "missed_policy": "coalesce_latest"})
        anchor = "2026-10-01T10:00:00Z"
        self.assertEqual(schedules.next_due(canonical, anchor, anchor), canonical["at"])
        self.assertIsNone(schedules.next_due(canonical, canonical["at"], anchor))
        plan = schedules.plan_due(canonical, canonical["at"], "2399-10-01T10:00:00Z", anchor)
        self.assertEqual(plan["scheduled_at"], canonical["at"])
        self.assertIsNone(plan["next_due_at"])
        self.assertFalse(plan["coalesced"])
        self.assertIsNone(schedules.plan_due(canonical, None, "2399-10-01T10:00:00Z", anchor))
        with self.assertRaises(RegistryError):
            schedules.plan_due(canonical, "2026-10-01T10:06:00Z", "2026-10-01T10:07:00Z", anchor)

    def test_once_explicit_offsets_disambiguate_fold_and_inputs_are_strict(self):
        first = schedules.validate_schedule(once("2026-11-01T01:30:00-04:00"))
        second = schedules.validate_schedule(once("2026-11-01T01:30:00-05:00"))
        self.assertEqual(first["at"], "2026-11-01T05:30:00.000Z")
        self.assertEqual(second["at"], "2026-11-01T06:30:00.000Z")
        for at in (None, True, [], datetime(2026, 10, 1, tzinfo=timezone.utc), "2026-10-01T10:00:00", "2026-10-01T10:00Z",
                   "2026-10-01 10:00:00Z", "2026-10-01T10:00:00.1234Z", "2026-10-01T10:00:00+05:99",
                   "2026-10-01T10:00:00+24:00", "2026-02-30T10:00:00Z", "x" * 4096, "\ud800"):
            with self.subTest(at=repr(at)), self.assertRaises(RegistryError):
                schedules.validate_schedule(once(at))
        for extra in ({"timezone": "UTC"}, {"dst_policy": "both"}, {"permissions": "auto"}, {"missed_policy": "all"}):
            with self.subTest(extra=extra), self.assertRaises(RegistryError):
                schedules.validate_schedule({**once(), **extra})


class CalendarStateTests(unittest.TestCase):
    setUp = schedule_fixtures.ScheduleStateTests.setUp
    state = schedule_fixtures.ScheduleStateTests.state
    tick = schedule_fixtures.ScheduleStateTests.tick
    occurrence = schedule_fixtures.ScheduleStateTests.occurrence

    def job(self, spec=None):
        job = self.store.create(self.workspace["id"], "Calendar reviewer", "Inspect committed source", "user")
        proposal = self.store.propose(job["id"], 1, {"schedule": spec or once()}, "user")
        return self.store.accept(job["id"], proposal["id"], 1, "user")

    def test_once_waits_for_review_then_offline_enqueues_only_once_across_restart(self):
        job = self.job()
        self.assertEqual(self.tick()["examined"], 0)
        self.now = "2026-10-08T10:00:00.000Z"
        with WorkspaceRegistry(self.registry.directory, clock=lambda: self.now) as reopened:
            self.assertEqual(schedules.tick(reopened, self.cfg)["enqueued"], 1)
        state = self.state(job)
        self.assertIsNone(state["next_due_at"])
        self.assertEqual(state["last_due_at"], "2026-10-01T10:05:00.000Z")
        self.assertFalse(schedules.has_due_schedule(self.registry, self.now))
        self.assertEqual(self.tick()["examined"], 0)
        run = self.store.run(self.store.runs(job["id"])[0]["id"])
        self.assertEqual(run["manifest"]["scheduled_at"], state["last_due_at"])
        self.assertEqual(run["manifest"]["tools"], sorted(pips.READ_TOOLS))
        self.assertEqual(run["manifest"]["policy"], "read_only")
        self.assertEqual(run["manifest"]["job_version"], 2)

    def test_once_cancellation_and_exact_retry_never_rearm(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        occurrence = self.occurrence(job)
        self.assertEqual(self.tick()["enqueued"], 1)
        original = self.store.runs(job["id"])[0]
        self.store.cancel(original["id"], "user")
        with patch.object(pips, "source_revision", side_effect=AssertionError("No source work on retry")):
            retry = self.store.enqueue(job["id"], schedules.occurrence_key(2, self.now), "local-scheduler", self.cfg,
                                       schedule_occurrence=occurrence)
        self.assertEqual(retry["id"], original["id"])
        self.assertEqual(retry["status"], "cancelled")
        self.assertIsNone(self.state(job)["next_due_at"])
        self.now = "2026-10-02T10:05:00.000Z"
        self.assertEqual(self.tick()["examined"], 0)

    def test_paused_and_busy_once_consumed_without_sneaky_resume_run(self):
        for status in ("paused", "queued", "running", "cancelling"):
            with self.subTest(status=status):
                self.now = "2026-10-01T10:00:00.000Z"
                job = self.job()
                if status == "paused":
                    self.store.set_paused(job["id"], True, "user")
                else:
                    run = self.store.enqueue(job["id"], "existing-" + status, "user", self.cfg)
                    self.registry.db.execute("UPDATE pip_runs SET status=? WHERE id=?", (status, run["id"]))
                self.now = "2026-10-01T10:05:00.000Z"
                self.assertEqual(self.tick()["skipped"], 1)
                self.assertIsNone(self.state(job)["next_due_at"])
                if status == "paused":
                    self.store.set_paused(job["id"], False, "user")
                self.assertEqual(self.tick()["examined"], 0)

    def test_global_stop_keeps_once_due_until_explicit_resume(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        before = self.state(job)
        pip_daemon._set_paused(self.registry, True, "user")
        self.assertTrue(self.tick()["stopped"])
        self.assertEqual(self.state(job), before)
        pip_daemon._set_paused(self.registry, False, "user")
        self.assertEqual(self.tick()["enqueued"], 1)
        self.assertIsNone(self.state(job)["next_due_at"])

    def test_expired_once_approval_rolls_back_and_never_arms(self):
        for at in ("2026-10-01T09:59:00Z", "2026-10-01T10:00:00Z", "2026-10-01T10:01:00Z"):
            with self.subTest(at=at):
                self.now = "2026-10-01T10:00:00.000Z"
                job = self.store.create(self.workspace["id"], "Future only", "Inspect source", "user")
                proposal = self.store.propose(job["id"], 1, {"schedule": once(at)}, "user")
                self.assertIsNone(self.state(job))
                self.now = "2026-10-01T10:02:00.000Z"
                with self.assertRaisesRegex(RegistryError, "future when approved"):
                    self.store.accept(job["id"], proposal["id"], 1, "user")
                current = self.store.get(job["id"])
                self.assertEqual(current["current_version"], 1)
                self.assertEqual(current["proposals"][0]["approval_status"], "pending")
                self.assertIsNone(self.state(job))

    def test_once_text_revision_preserves_exhaustion_and_new_time_needs_review(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        self.tick()
        state = self.state(job)
        proposal = self.store.propose(job["id"], 2, {"goal": "Inspect authorization"}, "user")
        changed = self.store.accept(job["id"], proposal["id"], 2, "user")
        self.assertIsNone(self.state(changed)["next_due_at"])
        self.assertEqual(self.state(changed)["anchor_at"], state["anchor_at"])
        self.assertEqual(self.state(changed)["last_due_at"], state["last_due_at"])
        proposal = self.store.propose(job["id"], 3, {"schedule": once("2026-10-01T11:00:00Z")}, "user")
        self.assertIsNone(self.state(job)["next_due_at"])
        self.store.accept(job["id"], proposal["id"], 3, "user")
        self.assertEqual(self.state(job)["next_due_at"], "2026-10-01T11:00:00.000Z")
        self.assertIsNone(self.state(job)["last_due_at"])

    def test_once_source_error_defers_without_consuming_and_retry_is_bounded(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        with patch.object(pips, "source_revision", side_effect=RegistryError("source_unavailable", "secret source error")):
            self.assertEqual(self.tick()["deferred"], 1)
            self.assertEqual(self.tick()["examined"], 0)
        self.assertEqual(self.state(job)["next_due_at"], self.now)
        self.now = "2026-10-01T10:05:30.000Z"
        self.assertEqual(self.tick()["enqueued"], 1)
        self.assertIsNone(self.state(job)["next_due_at"])

    def test_cron_review_and_offline_coalescing_preserve_approved_policy_and_type(self):
        job = self.job(cron("*/10 * * * *", "Asia/Kolkata"))
        self.now = "2026-10-08T10:02:00.000Z"
        self.assertEqual(self.tick()["enqueued"], 1)
        run = self.store.run(self.store.runs(job["id"])[0]["id"])
        manifest = run["manifest"]
        self.assertEqual(manifest["scheduled_at"], "2026-10-08T10:00:00.000Z")
        self.assertEqual(manifest["schedule"], job["schedule"])
        self.assertEqual(manifest["job"]["pip_type"], "rook")
        self.assertEqual(manifest["tools"], sorted(pips.READ_TOOLS))
        self.assertEqual(self.state(job)["next_due_at"], "2026-10-08T10:10:00.000Z")
        self.assertEqual(self.tick()["examined"], 0)

    def test_concurrent_once_ticks_commit_one_run_and_one_exhaustion(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        occurrence = self.occurrence(job)
        entered = False
        def competing_source(*_):
            nonlocal entered
            if not entered:
                entered = True
                with WorkspaceRegistry(self.registry.directory, clock=lambda: self.now) as other:
                    pips.PipStore(other).enqueue(job["id"], schedules.occurrence_key(2, self.now), "local-scheduler",
                                                self.cfg, schedule_occurrence=occurrence)
            return "a" * 40
        with patch.object(pips, "source_revision", side_effect=competing_source):
            self.tick()
        self.assertEqual(len(self.store.runs(job["id"])), 1)
        self.assertIsNone(self.state(job)["next_due_at"])

    def test_forged_or_malicious_cron_refused_before_source_or_queue_work(self):
        job = self.store.create(self.workspace["id"], "Auditor", "Inspect source", "user")
        with patch.object(pips, "source_revision", side_effect=AssertionError("No source work")):
            for expression in ("* * * * *", "0 0 29 2 *", "$(curl invalid) 0 * * *"):
                with self.subTest(expression=expression), self.assertRaises(RegistryError):
                    self.store.propose(job["id"], 1, {"schedule": cron(expression)}, "user")
        self.assertEqual(self.store.get(job["id"])["proposals"], [])
        self.assertIsNone(self.state(job))
        self.assertEqual(self.store.runs(job["id"]), [])


if __name__ == "__main__":
    unittest.main()
