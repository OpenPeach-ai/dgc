"""Deterministic scheduler planning/queue tests; no sleeps or network providers."""
import json
import threading
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock, patch

from dgc import pip_schedules as schedules, pip_daemon, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class SchedulePlanningTests(unittest.TestCase):
    def test_canonical_manual_interval_and_daily_definitions(self):
        self.assertIsNone(schedules.validate_schedule(None))
        source = {"type": "interval", "minutes": 60}
        self.assertEqual(schedules.validate_schedule(source),
                         {"type": "interval", "minutes": 60, "missed_policy": "coalesce_latest"})
        self.assertNotIn("missed_policy", source)
        daily = schedules.validate_schedule({"type": "daily", "time": "02:00", "timezone": "Asia/Kolkata"})
        self.assertEqual(daily["dst_policy"], "skip_gap_first_fold")
        self.assertEqual(daily["missed_policy"], "coalesce_latest")

    def test_invalid_specs_and_capability_fields_are_refused(self):
        values = [False, [], "daily", {}, {"type": "cron", "cron": "* * * * *"},
                  {"type": "interval", "minutes": True}, {"type": "interval", "minutes": 5.0},
                  {"type": "interval", "minutes": 4}, {"type": "interval", "minutes": 10081},
                  {"type": "interval", "minutes": 5, "permissions": "auto"},
                  {"type": "interval", "minutes": 5, "missed_policy": "all"},
                  {"type": "daily", "time": "24:00", "timezone": "UTC"},
                  {"type": "daily", "time": "2:00", "timezone": "UTC"},
                  {"type": "daily", "time": "02:00"},
                  {"type": "daily", "time": "02:00", "timezone": "/etc/localtime"},
                  {"type": "daily", "time": "02:00", "timezone": "../UTC"},
                  {"type": "daily", "time": "02:00", "timezone": "No_Such/Timezone"},
                  {"type": "daily", "time": "02:00", "timezone": "UTC", "dst_policy": "both"}]
        for value in values:
            with self.subTest(value=value), self.assertRaises(RegistryError):
                schedules.validate_schedule(value)

    def test_interval_is_anchored_and_first_run_is_strictly_after_approval(self):
        spec = {"type": "interval", "minutes": 5}
        anchor = "2026-10-01T12:01:23.000Z"
        self.assertEqual(schedules.next_due(spec, anchor, anchor), "2026-10-01T12:06:23.000Z")
        self.assertEqual(schedules.next_due(spec, "2026-10-01T12:06:23.000Z", anchor), "2026-10-01T12:11:23.000Z")
        self.assertEqual(schedules.next_due(spec, "2020-01-01T00:00:00Z", anchor), "2026-10-01T12:06:23.000Z")

    def test_daily_uses_explicit_iana_timezone(self):
        spec = {"type": "daily", "time": "02:00", "timezone": "Asia/Kolkata"}
        anchor = "2026-10-01T12:00:00Z"
        self.assertEqual(schedules.next_due(spec, anchor, anchor), "2026-10-01T20:30:00.000Z")
        self.assertEqual(schedules.next_due(spec, "2026-10-01T20:30:00Z", anchor), "2026-10-02T20:30:00.000Z")

    def test_spring_gap_skips_nonexistent_time_instead_of_shifting_it(self):
        spec = {"type": "daily", "time": "02:30", "timezone": "America/New_York"}
        anchor = "2026-03-07T08:00:00Z"
        self.assertEqual(schedules.next_due(spec, anchor, anchor), "2026-03-09T06:30:00.000Z")

    def test_autumn_fold_runs_only_first_occurrence(self):
        spec = {"type": "daily", "time": "01:30", "timezone": "America/New_York"}
        anchor = "2026-10-31T08:00:00Z"
        self.assertEqual(schedules.next_due(spec, anchor, anchor), "2026-11-01T05:30:00.000Z")
        self.assertEqual(schedules.next_due(spec, "2026-11-01T05:31:00Z", anchor), "2026-11-02T06:30:00.000Z")
        plan = schedules.plan_due(spec, "2026-11-01T05:30:00Z", "2026-11-01T06:31:00Z", anchor)
        self.assertEqual(plan["scheduled_at"], "2026-11-01T05:30:00.000Z")
        self.assertEqual(plan["next_due_at"], "2026-11-02T06:30:00.000Z")

    def test_date_line_skipped_day_is_not_an_occurrence(self):
        spec = {"type": "daily", "time": "12:00", "timezone": "Pacific/Apia"}
        anchor = "2011-12-30T00:00:00Z"
        self.assertEqual(schedules.next_due(spec, anchor, anchor), "2011-12-30T22:00:00.000Z")

    def test_offline_intervals_coalesce_to_one_latest_occurrence(self):
        spec = {"type": "interval", "minutes": 5}
        plan = schedules.plan_due(spec, "2026-10-01T12:05:00Z", "2026-10-02T12:02:00Z", "2026-10-01T12:00:00Z")
        self.assertEqual(plan["scheduled_at"], "2026-10-02T12:00:00.000Z")
        self.assertEqual(plan["next_due_at"], "2026-10-02T12:05:00.000Z")
        self.assertTrue(plan["coalesced"])

    def test_offline_daily_coalesces_without_enumerating_history(self):
        spec = {"type": "daily", "time": "02:00", "timezone": "UTC"}
        with patch.object(schedules, "_daily_occurrence", wraps=schedules._daily_occurrence) as visits:
            plan = schedules.plan_due(spec, "2020-01-02T02:00:00Z", "2090-10-02T12:00:00Z", "2020-01-01T12:00:00Z")
        self.assertEqual(plan["scheduled_at"], "2090-10-02T02:00:00.000Z")
        self.assertEqual(plan["next_due_at"], "2090-10-03T02:00:00.000Z")
        self.assertTrue(plan["coalesced"])
        self.assertLessEqual(visits.call_count, 16)

    def test_backward_clock_waits_without_replaying(self):
        spec = {"type": "interval", "minutes": 5}
        self.assertIsNone(schedules.plan_due(spec, "2026-10-01T12:10:00Z", "2026-10-01T11:59:00Z", "2026-10-01T12:00:00Z"))

    def test_occurrence_key_is_stable_across_timezone_spelling(self):
        self.assertEqual(schedules.occurrence_key(3, "2026-10-01T12:00:00Z"),
                         schedules.occurrence_key(3, "2026-10-01T17:30:00+05:30"))
        self.assertNotEqual(schedules.occurrence_key(3, "2026-10-01T12:00:00Z"),
                            schedules.occurrence_key(4, "2026-10-01T12:00:00Z"))
        for version in (False, 0, 1000000, 1.0, "1"):
            with self.subTest(version=version), self.assertRaises(RegistryError):
                schedules.occurrence_key(version, "2026-10-01T12:00:00Z")

    def test_timezone_naive_or_overflow_time_is_refused(self):
        for value in ("2026-10-01T12:00:00", datetime(2026, 10, 1), None, [], True, "x"):
            with self.subTest(value=value), self.assertRaises(RegistryError):
                schedules.timestamp(value)
        with self.assertRaises(RegistryError):
            schedules.next_due({"type": "interval", "minutes": 5},
                               datetime.max.replace(tzinfo=timezone.utc), "2026-10-01T12:00:00Z")


class ScheduleStateTests(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.now = "2026-10-01T10:00:00.000Z"
        self.registry.clock = lambda: self.now
        for target, value in (("source_revision", "a" * 40), ("_require_runner_platform", None)):
            patched = patch.object(pips, target, return_value=value)
            patched.start()
            self.addCleanup(patched.stop)
        forbidden = patch.object(pips, "start_queued", side_effect=AssertionError("Scheduling does not start workers"))
        forbidden.start()
        self.addCleanup(forbidden.stop)

    def job(self, minutes=5):
        job = self.store.create(self.workspace["id"], "Auditor", "Inspect source", "user")
        proposal = self.store.propose(job["id"], 1, {"schedule": {"type": "interval", "minutes": minutes}}, "user")
        return self.store.accept(job["id"], proposal["id"], 1, "user")

    def state(self, job):
        value = self.registry.db.execute("SELECT * FROM pip_schedule_state WHERE pip_id=?", (job["id"],)).fetchone()
        return dict(value) if value else None

    def tick(self, **kwargs):
        return schedules.tick(self.registry, self.cfg, **kwargs)

    def occurrence(self, job):
        state = self.state(job)
        plan = schedules.plan_due(job["schedule"], state["next_due_at"], self.now, state["anchor_at"])
        return {"job_version": job["current_version"], **{key: plan[key] for key in
                ("expected_next_due", "scheduled_at", "next_due_at", "checked_at")}}

    def test_proposal_does_not_arm_before_user_review_and_changes_are_versioned(self):
        job = self.store.create(self.workspace["id"], "Audit", "Inspect source", "user")
        proposal = self.store.propose(job["id"], 1, {"schedule": {"type": "interval", "minutes": 5}}, "user")
        self.assertIsNone(self.state(job))
        self.now = "2026-10-01T10:10:00.000Z"
        accepted = self.store.accept(job["id"], proposal["id"], 1, "user")
        self.assertEqual(accepted["current_version"], 2)
        self.assertEqual(self.state(job)["next_due_at"], "2026-10-01T10:15:00.000Z")
        versions = self.store.versions(job["id"])["versions"]
        self.assertIsNone(versions[-1]["definition"]["schedule"])
        self.assertEqual(versions[0]["definition"]["schedule"]["minutes"], 5)
        with self.assertRaises(RegistryError):
            self.store.accept(job["id"], proposal["id"], 1, "user")

    def test_reset_requires_same_approved_definition_and_transaction(self):
        job = self.job()
        with self.assertRaises(RegistryError):
            schedules.reset_schedule(self.registry, job["id"], 2, job["schedule"], self.now)
        with self.registry.transaction():
            for version, spec in ((1, job["schedule"]), (2, {"type": "interval", "minutes": 10})):
                with self.assertRaises(RegistryError):
                    schedules.reset_schedule(self.registry, job["id"], version, spec, self.now)

    def test_text_change_preserves_cadence_but_future_run_pins_new_version(self):
        job = self.job()
        before = self.state(job)
        self.now = "2026-10-01T10:03:00.000Z"
        proposal = self.store.propose(job["id"], 2, {"goal": "Inspect authorization"}, "user")
        changed = self.store.accept(job["id"], proposal["id"], 2, "user")
        after = self.state(job)
        self.assertEqual(after["job_version"], 3)
        self.assertEqual(after["anchor_at"], before["anchor_at"])
        self.assertEqual(after["next_due_at"], before["next_due_at"])
        self.now = "2026-10-01T10:05:00.000Z"
        self.assertEqual(self.tick()["enqueued"], 1)
        run = self.store.runs(changed["id"])[0]
        self.assertEqual(run["manifest"]["job_version"], 3)

    def test_changed_schedule_rearms_and_manual_only_removes_projection(self):
        job = self.job()
        self.now = "2026-10-01T10:03:00.000Z"
        proposal = self.store.propose(job["id"], 2, {"schedule": {"type": "interval", "minutes": 10}}, "user")
        self.store.accept(job["id"], proposal["id"], 2, "user")
        self.assertEqual(self.state(job)["next_due_at"], "2026-10-01T10:13:00.000Z")
        proposal = self.store.propose(job["id"], 3, {"schedule": None}, "user")
        self.store.accept(job["id"], proposal["id"], 3, "user")
        self.assertIsNone(self.state(job))

    def test_enqueue_pins_authoritative_route_policy_context_and_schedule(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        result = self.tick()
        self.assertEqual(result["enqueued"], 1)
        run = self.store.run(self.store.runs(job["id"])[0]["id"])
        manifest = run["manifest"]
        self.assertEqual(manifest["trigger"], "schedule")
        self.assertEqual(manifest["scheduled_at"], self.now)
        self.assertEqual(manifest["model"], "fixture")
        self.assertEqual(manifest["policy"], "read_only")
        self.assertEqual(manifest["tools"], sorted(pips.READ_TOOLS))
        self.assertIn("workspace_context", manifest)
        self.assertEqual(manifest["limits"]["wall_seconds"], 0, "a Pip run keeps going: no wall clock")
        self.assertEqual(self.state(job)["next_due_at"], "2026-10-01T10:10:00.000Z")

    def test_duplicate_occurrence_is_idempotent_after_cursor_advanced(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        occurrence = self.occurrence(job)
        self.tick()
        prior = self.store.runs(job["id"])[0]
        with patch.object(pips, "source_revision", side_effect=AssertionError("Retry must not resolve source")):
            repeat = self.store.enqueue(job["id"], schedules.occurrence_key(2, self.now), "local-scheduler",
                                        self.cfg, schedule_occurrence=occurrence)
        self.assertEqual(repeat["id"], prior["id"])
        self.assertEqual(len(self.store.runs(job["id"])), 1)
        self.assertEqual(self.tick()["enqueued"], 0)

    def test_cancelled_occurrence_is_never_replayed_by_retry(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        occurrence = self.occurrence(job)
        self.tick()
        original = self.store.runs(job["id"])[0]
        self.store.cancel(original["id"], "user")
        repeat = self.store.enqueue(job["id"], schedules.occurrence_key(2, self.now), "local-scheduler",
                                    self.cfg, schedule_occurrence=occurrence)
        self.assertEqual(repeat["id"], original["id"])
        self.assertEqual(repeat["status"], "cancelled")
        self.assertEqual(len(self.store.runs(job["id"])), 1)

    def test_internal_occurrence_cannot_change_policy_or_forge_timing(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        occurrence = self.occurrence(job)
        key = schedules.occurrence_key(2, self.now)
        for invalid in ({**occurrence, "permissions": "auto"},
                        {**occurrence, "scheduled_at": "2026-10-01T10:01:00.000Z"},
                        {**occurrence, "next_due_at": "2026-10-01T10:05:01.000Z"},
                        {**occurrence, "checked_at": "2026-10-01T10:10:00.000Z"}):
            with self.subTest(invalid=invalid), self.assertRaises(RegistryError):
                self.store.enqueue(job["id"], key, "local-scheduler", self.cfg, schedule_occurrence=invalid)
        with self.assertRaises(RegistryError):
            self.store.enqueue(job["id"], key, "model", self.cfg, schedule_occurrence=occurrence)
        self.assertEqual(self.store.runs(job["id"]), [])

    def test_offline_restart_coalesces_latest_without_backlog(self):
        job = self.job()
        self.now = "2026-10-08T10:02:00.000Z"
        with WorkspaceRegistry(self.registry.directory, clock=lambda: self.now) as reopened:
            result = schedules.tick(reopened, self.cfg)
        self.assertEqual(result["enqueued"], 1)
        runs = self.store.runs(job["id"])
        self.assertEqual(len(runs), 1)
        manifest = self.store.run(runs[0]["id"])["manifest"]
        self.assertEqual(manifest["scheduled_at"], "2026-10-08T10:00:00.000Z")
        self.assertEqual(self.state(job)["next_due_at"], "2026-10-08T10:05:00.000Z")

    def test_paused_job_skips_and_global_stop_leaves_cursor_unchanged(self):
        job = self.job()
        self.store.set_paused(job["id"], True, "user")
        self.now = "2026-10-01T10:06:00.000Z"
        self.assertEqual(self.tick()["skipped"], 1)
        self.assertEqual(self.store.runs(job["id"]), [])
        self.assertEqual(self.state(job)["next_due_at"], "2026-10-01T10:10:00.000Z")
        self.store.set_paused(job["id"], False, "user")
        self.now = "2026-10-01T10:11:00.000Z"
        pip_daemon._set_paused(self.registry, True, "user")
        before = self.state(job)
        self.assertTrue(self.tick()["stopped"])
        self.assertEqual(self.state(job), before)

    def test_busy_run_is_skipped_but_cancelled_run_does_not_block_next_due(self):
        job = self.job()
        for status in ("queued", "running", "cancelling"):
            with self.subTest(status=status):
                self.now = "2026-10-01T10:05:00.000Z"
                self.registry.db.execute("DELETE FROM pip_runs WHERE pip_id=?", (job["id"],))
                self.registry.db.execute("UPDATE pip_schedule_state SET next_due_at=?,last_checked_at=NULL WHERE pip_id=?", (self.now, job["id"]))
                manual = self.store.enqueue(job["id"], status, "user", self.cfg)
                self.registry.db.execute("UPDATE pip_runs SET status=? WHERE id=?", (status, manual["id"]))
                self.assertEqual(self.tick()["skipped"], 1)
                self.assertEqual(len(self.store.runs(job["id"])), 1)
        self.store.cancel(manual["id"], "user")
        self.store.finish(manual["id"], error={"code": "stopped"})
        self.now = "2026-10-01T10:10:00.000Z"
        self.assertEqual(self.tick()["enqueued"], 1)
        self.assertEqual(self.store.run(manual["id"])["status"], "cancelled")

    def test_queue_full_defers_with_retry_spacing_without_advancing_occurrence(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        with patch.object(pips, "MAX_QUEUE", 0):
            self.assertEqual(self.tick()["deferred"], 1)
            self.assertEqual(self.state(job)["next_due_at"], self.now)
            self.assertEqual(self.tick()["examined"], 0)
            self.now = "2026-10-01T10:05:29.000Z"
            self.assertEqual(self.tick()["examined"], 0)
        self.now = "2026-10-01T10:05:30.000Z"
        self.assertEqual(self.tick()["enqueued"], 1)

    def test_tick_limit_is_bounded_and_leaves_remaining_jobs_due(self):
        for _ in range(10):
            self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        result = self.tick()
        self.assertEqual(result["examined"], 8)
        self.assertEqual(result["enqueued"], 8)
        self.assertEqual(self.tick()["enqueued"], 2)
        for invalid in (0, 9, True, 1.0):
            with self.subTest(invalid=invalid), self.assertRaises(RegistryError):
                self.tick(limit=invalid)

    def test_clock_backward_does_not_repeat_accepted_occurrence(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        self.tick()
        self.now = "2026-10-01T10:04:00.000Z"
        self.assertEqual(self.tick()["examined"], 0)
        self.assertEqual(len(self.store.runs(job["id"])), 1)

    def test_concurrent_same_occurrence_commits_only_one_run(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        occurrence = self.occurrence(job)
        key = schedules.occurrence_key(2, self.now)
        entered = False
        def competing_enqueue(*_):
            nonlocal entered
            if not entered:
                entered = True
                with WorkspaceRegistry(self.registry.directory, clock=lambda: self.now) as other:
                    pips.PipStore(other).enqueue(job["id"], key, "local-scheduler", self.cfg, schedule_occurrence=occurrence)
            return "a" * 40
        with patch.object(pips, "source_revision", side_effect=competing_enqueue):
            self.assertEqual(self.tick()["enqueued"], 1)
        self.assertEqual(len(self.store.runs(job["id"])), 1)
        self.assertEqual(self.state(job)["next_due_at"], "2026-10-01T10:10:00.000Z")

    def test_reviewed_schedule_change_during_source_resolution_wins(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        def revise(*_):
            proposal = self.store.propose(job["id"], 2, {"schedule": {"type": "interval", "minutes": 10}}, "user")
            self.store.accept(job["id"], proposal["id"], 2, "user")
            return "a" * 40
        with patch.object(pips, "source_revision", side_effect=revise):
            self.assertEqual(self.tick()["stale"], 1)
        self.assertEqual(self.store.runs(job["id"]), [])
        self.assertEqual(self.state(job)["job_version"], 3)
        self.assertEqual(self.state(job)["next_due_at"], "2026-10-01T10:15:00.000Z")

    def test_manual_run_racing_with_scheduler_skips_the_scheduled_occurrence(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        entered = False
        def add_manual_run(*_):
            nonlocal entered
            if not entered:
                entered = True
                self.store.enqueue(job["id"], "manual-race", "user", self.cfg)
            return "a" * 40
        with patch.object(pips, "source_revision", side_effect=add_manual_run):
            self.assertEqual(self.tick()["skipped"], 1)
        runs = self.store.runs(job["id"])
        self.assertEqual(len(runs), 1)
        self.assertEqual(self.store.run(runs[0]["id"])["manifest"]["trigger"], "manual")
        self.assertEqual(self.state(job)["next_due_at"], "2026-10-01T10:10:00.000Z")

    def test_global_stop_during_source_resolution_wins(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        def stop(*_):
            pip_daemon._set_paused(self.registry, True, "user")
            return "a" * 40
        with patch.object(pips, "source_revision", side_effect=stop):
            self.assertTrue(self.tick()["stopped"])
        self.assertEqual(self.store.runs(job["id"]), [])
        self.assertEqual(self.state(job)["next_due_at"], self.now)

    def test_malformed_cursor_and_error_diagnostics_fail_closed_without_secret(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        with patch.object(pips, "source_revision", side_effect=RegistryError("source_unavailable", "PRIVATE_SECRET /home/private/path")):
            self.assertEqual(self.tick()["deferred"], 1)
        events = self.registry.activity(self.workspace["id"])["events"]
        self.assertNotIn("PRIVATE_SECRET", json.dumps(events))
        self.assertNotIn("/home/private", json.dumps(events))
        self.registry.db.execute("UPDATE pip_schedule_state SET next_due_at='bad',last_checked_at=NULL WHERE pip_id=?", (job["id"],))
        self.assertEqual(self.tick()["enqueued"], 0)

    def test_disabled_and_explicit_tick_stop_never_enqueue(self):
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        self.cfg.data["pips_enabled"] = False
        self.assertTrue(self.tick()["stopped"])
        self.cfg.data["pips_enabled"] = True
        stopped = threading.Event()
        stopped.set()
        self.assertTrue(self.tick(stop_event=stopped)["stopped"])
        self.assertEqual(self.store.runs(job["id"]), [])

    def test_supervisor_heartbeats_continue_while_one_owned_tick_waits_on_git(self):
        from dgc.scheduler import named_process_lock
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        entered, release = threading.Event(), threading.Event()
        lease_checks = []
        def blocked_source(*_):
            entered.set()
            if not release.wait(5):
                raise AssertionError("Test did not release the controlled source probe")
            probe = named_process_lock("pips-supervisor", str(self.registry.directory))
            owned = probe.acquire(blocking=False)
            lease_checks.append(owned)
            if owned:
                probe.release()
            return "a" * 40
        parent = self
        class HeartbeatSteps:
            stopped = False
            waits = 0
            def is_set(self):
                return self.stopped
            def wait(self, _seconds):
                self.waits += 1
                if self.waits == 1:
                    parent.assertTrue(entered.wait(5))
                    parent.assertEqual(pip_daemon.runner_status(parent.registry)["heartbeat_at"], parent.now)
                    parent.now = "2026-10-01T10:05:02.000Z"
                    return False
                parent.assertEqual(self.waits, 2)
                parent.assertEqual(pip_daemon.runner_status(parent.registry)["heartbeat_at"], parent.now)
                parent.assertEqual(parent.store.runs(job["id"]), [])
                self.stopped = True
                release.set()
                return True
        steps = HeartbeatSteps()
        self.addCleanup(release.set)
        with patch.object(pips, "source_revision", side_effect=blocked_source) as source, \
             patch.object(pips, "start_queued"), \
             patch.object(pip_daemon, "state_directory", return_value=self.registry.directory):
            result = pip_daemon.serve(self.cfg, stop_event=steps, clock=lambda: self.now)
        self.assertEqual(source.call_count, 1)
        self.assertEqual(steps.waits, 2)
        self.assertEqual(lease_checks, [False])
        self.assertEqual(result["status"], "stopped")
        # Ctrl+C stops supervision, not the approval already represented by an
        # in-flight occurrence. This accepted request stays queued for restart.
        self.assertEqual(len(self.store.runs(job["id"])), 1)
        self.assertEqual(self.store.runs(job["id"])[0]["status"], "queued")

    def test_scheduler_thread_failure_stops_supervisor_and_releases_lease(self):
        from dgc.scheduler import named_process_lock
        self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        finished = threading.Event()
        def fail(*_args, **_kwargs):
            finished.set()
            raise OSError("PRIVATE_SECRET /private/database")
        class FinishStep:
            def is_set(self):
                return False
            def wait(self, _seconds):
                if not finished.wait(5):
                    raise AssertionError("Controlled scheduler did not finish")
                return True
        with patch.object(schedules, "tick", side_effect=fail), \
             patch.object(pips, "start_queued"), \
             patch.object(pip_daemon, "state_directory", return_value=self.registry.directory):
            with self.assertRaises(RegistryError) as failure:
                pip_daemon.serve(self.cfg, stop_event=FinishStep(), clock=lambda: self.now)
        self.assertEqual(failure.exception.code, "runner_failed")
        self.assertNotIn("PRIVATE_SECRET", str(failure.exception))
        status = pip_daemon.runner_status(self.registry)
        self.assertEqual(status["status"], "stopped")
        self.assertEqual(status["error"]["code"], "runner_failed")
        probe = named_process_lock("pips-supervisor", str(self.registry.directory))
        self.assertTrue(probe.acquire(blocking=False))
        probe.release()

    def test_scheduler_thread_start_failure_is_honestly_reported(self):
        self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        failed_thread = Mock()
        failed_thread.start.side_effect = RuntimeError("cannot create thread")
        with patch.object(schedules.threading, "Thread", return_value=failed_thread), \
             patch.object(pips, "start_queued"), \
             patch.object(pip_daemon, "state_directory", return_value=self.registry.directory):
            with self.assertRaises(RegistryError) as failure:
                pip_daemon.serve(self.cfg, stop_event=threading.Event(), clock=lambda: self.now)
        self.assertEqual(failure.exception.code, "runner_failed")
        failed_thread.join.assert_not_called()
        self.assertEqual(pip_daemon.runner_status(self.registry)["error"]["code"], "runner_failed")


if __name__ == "__main__":
    unittest.main()
