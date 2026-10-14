"""Offline lifecycle tests: controlled Event.wait/clock, no sleeps or model calls."""
from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from dgc import pip_daemon as daemon, pips
from dgc.scheduler import named_process_lock
from dgc.workspace_registry import RegistryError, WorkspaceRegistry, state_directory


class ConfigFixture:
    def __init__(self, root, enabled=True):
        self.project_root = root
        self.data = {"pips_enabled": enabled}
        self.writes = []

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value, *, persist=True):
        self.data[key] = value
        self.writes.append((key, value, persist))

    def clone_for_root(self, root):
        value = ConfigFixture(root)
        value.data = copy.deepcopy(self.data)
        return value


class ScriptedEvent:
    def __init__(self, steps):
        self.steps = iter(steps)
        self.stopped = False
        self.waits = []

    def is_set(self):
        return self.stopped

    def set(self):
        self.stopped = True

    def wait(self, seconds):
        self.waits.append(seconds)
        action = next(self.steps)
        action(self)
        return self.stopped


class ScriptedThread:
    """Start records a pending target; tests decide exactly when it runs."""
    def __init__(self, *, target, **_):
        self.target = target
        self.alive = False

    def start(self):
        self.alive = True

    def is_alive(self):
        return self.alive

    def run(self):
        try:
            self.target()
        finally:
            self.alive = False

    def join(self, _timeout=None):
        if self.alive:
            self.run()


class PipDaemonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dgc-pip-daemon-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "project"
        self.root.mkdir()
        env = patch.dict(os.environ, {"DGC_HOME": str(self.base / "home"), "HOME": str(self.base / "home")})
        env.start(); self.addCleanup(env.stop)
        # Even an accidental execution call is stopped before a subprocess/model.
        execute = patch.object(pips, "_execute_run", side_effect=AssertionError("Tests must not start an audit"))
        execute.start(); self.addCleanup(execute.stop)
        self.registry = WorkspaceRegistry(clock=lambda: "2026-10-01T10:00:00.000Z")
        self.addCleanup(self.registry.close)
        self.workspace = self.registry.resolve(self.root)
        self.store = pips.PipStore(self.registry)
        self.config = ConfigFixture(self.root)

    def control(self, value):
        self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (daemon.CONTROL_KEY, value))

    def job(self):
        return self.store.create(self.workspace["id"], "Auditor", "Read source", "fixture")

    def run_row(self, job, status="queued", suffix="1"):
        # The tests exercise lifecycle state, not source resolution or model setup.
        run_id = "run_fixture_" + suffix
        manifest = {"job_version": 1, "source_revision": "0" * 40, "model": "fixture", "policy": "read_only", "runner_id": self.registry.runner_id}
        self.registry.db.execute("""INSERT INTO pip_runs
            (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)""", (run_id, job["id"], self.workspace["id"], self.workspace["binding_id"], suffix,
                                           "fixture", json.dumps(manifest), status, self.registry.clock()))
        return run_id

    def record(self, **changes):
        value = {"schema_version": 1, "instance_id": "instance", "pid": 999999,
                 "status": "running", "started_at": self.registry.clock(), "heartbeat_at": self.registry.clock()}
        value.update(changes)
        daemon._write(self.registry, daemon.SUPERVISOR_KEY, value)
        return value

    def test_pause_default_and_malformed_control_fail_closed(self):
        self.assertFalse(daemon.is_runtime_paused(self.registry))
        for invalid in ("oops", "null", "[]", '{"schema_version":1}',
                        '{"schema_version":1,"paused":0}', '{"schema_version":true,"paused":false}',
                        '{"schema_version":2,"paused":false}', " " * 8193):
            with self.subTest(invalid=invalid[:100]):
                self.control(invalid)
                self.assertTrue(daemon.is_runtime_paused(self.registry))
        self.control('{"schema_version":1,"paused":false}')
        self.assertFalse(daemon.is_runtime_paused(self.registry))

    def test_status_uses_freshness_not_pid_and_omits_private_process_paths(self):
        self.record()
        value = daemon.runner_status(self.registry)
        self.assertTrue(value["online"])
        self.assertEqual(value["status"], "running")
        self.assertNotIn("pid", value)
        self.assertNotIn(str(self.root), json.dumps(value))
        self.record(heartbeat_at="2026-10-01T09:59:44.000Z")
        self.assertEqual(daemon.runner_status(self.registry)["status"], "offline")
        self.record(heartbeat_at="2026-10-01T10:00:01.000Z")
        self.assertFalse(daemon.runner_status(self.registry)["online"])
        self.record(heartbeat_at="broken")
        self.assertFalse(daemon.runner_status(self.registry)["online"])

    def test_stop_persists_before_pausing_jobs_and_cancels_every_pending_run(self):
        job = self.job()
        queued = self.run_row(job)
        running = self.run_row(job, "running", "2")
        real = pips.PipStore.set_paused

        def check_pause(store, *args):
            self.assertTrue(daemon.is_runtime_paused(store.registry))
            return real(store, *args)

        with patch.object(pips.PipStore, "set_paused", check_pause), patch("os.kill", side_effect=AssertionError("Do not signal recorded PIDs")):
            result = daemon.stop_all(self.config, "local-console")
        self.assertTrue(result["paused"])
        self.assertEqual(result["affected"], {"paused_jobs": 1, "cancelled_runs": 2})
        self.assertEqual(self.store.get(job["id"])["status"], "paused")
        self.assertEqual(self.store.run(queued)["status"], "cancelled")
        self.assertEqual(self.store.run(running)["status"], "cancelling")
        self.assertTrue(self.config.get("pips_enabled"))

    def test_stop_remains_persisted_if_later_job_mutation_fails(self):
        self.job()
        with patch.object(pips.PipStore, "set_paused", side_effect=RuntimeError("storage fault")):
            with self.assertRaisesRegex(RuntimeError, "storage fault"):
                daemon.stop_all(self.config, "local-console")
        self.assertTrue(daemon.is_runtime_paused(self.registry))

    def test_resume_recovers_interrupted_cancellation_but_leaves_jobs_paused(self):
        job = self.job()
        run = self.run_row(job, "running")
        daemon.stop_all(self.config, "fixture")
        with patch.object(pips, "start_queued") as start:
            result = daemon.resume_runtime(self.config, "local-console")
        self.assertFalse(result["paused"])
        self.assertEqual(self.store.get(job["id"])["status"], "paused")
        self.assertEqual(self.store.run(run)["status"], "cancelled")
        start.assert_not_called()

    def test_resume_refuses_live_supervisor_or_worker_lease(self):
        for namespace in ("pips-supervisor", "pips-runner"):
            with self.subTest(namespace=namespace):
                daemon.stop_all(self.config, "fixture")
                lease = named_process_lock(namespace, str(state_directory()))
                self.assertTrue(lease.acquire(blocking=False))
                try:
                    with self.assertRaisesRegex(RegistryError, "Wait for"):
                        daemon.resume_runtime(self.config, "local-console")
                finally:
                    lease.release()
                self.assertTrue(daemon.is_runtime_paused(self.registry))

    def test_a_new_stop_wins_over_an_older_resume(self):
        daemon.stop_all(self.config, "first-stop")
        recover = pips.PipStore.recover
        def stop_during_recovery(store):
            result = recover(store)
            daemon.stop_all(self.config, "new-stop")
            return result
        with patch.object(pips.PipStore, "recover", stop_during_recovery):
            with self.assertRaisesRegex(RegistryError, "stop changed"):
                daemon.resume_runtime(self.config, "local-console")
        self.assertTrue(daemon.is_runtime_paused(self.registry))
        self.assertEqual(daemon._read(self.registry, daemon.CONTROL_KEY)["actor"], "new-stop")

    def test_serve_requires_opt_in_and_enable_cannot_bypass_global_stop(self):
        self.config.data["pips_enabled"] = False
        with self.assertRaisesRegex(RegistryError, "disabled"):
            daemon.serve(self.config)
        daemon.stop_all(self.config, "fixture")
        with self.assertRaisesRegex(RegistryError, "resume locally"):
            daemon.serve(self.config, enable=True)
        self.assertEqual(self.config.writes, [("pips_enabled", True, True)])
        self.assertTrue(daemon.is_runtime_paused(self.registry))

    def test_serve_heartbeats_and_invokes_existing_worker_without_an_editor(self):
        seen = []
        def next_tick(event):
            status = daemon.runner_status(self.registry)
            self.assertTrue(status["online"])
            seen.append(status["heartbeat_at"])
        event = ScriptedEvent([next_tick, lambda event: event.set()])
        clones = []
        with patch.object(pips, "start_queued", side_effect=lambda cfg: clones.append(cfg)):
            result = daemon.serve(self.config, stop_event=event, clock=self.registry.clock)
        self.assertEqual(len(clones), 2)
        self.assertIsNot(clones[0], self.config)
        self.assertFalse(clones[0].get("pips_enabled"))
        self.assertTrue(self.config.get("pips_enabled"))
        self.assertEqual(event.waits, [daemon.HEARTBEAT_SECONDS] * 2)
        self.assertEqual(len(seen), 1)
        self.assertEqual(result["status"], "stopped")
        self.assertFalse(result["paused"])

    def test_persisted_stop_ends_serve_on_next_event_wait(self):
        event = ScriptedEvent([lambda event: daemon.stop_all(self.config, "paired-browser")])
        with patch.object(pips, "start_queued") as start:
            result = daemon.serve(self.config, stop_event=event, clock=self.registry.clock)
        self.assertEqual(start.call_count, 1)
        self.assertEqual(result["status"], "stopped")
        self.assertTrue(result["paused"])

    def test_single_supervisor_lease_rejects_duplicate(self):
        lease = named_process_lock("pips-supervisor", str(state_directory()))
        self.assertTrue(lease.acquire(blocking=False))
        try:
            with self.assertRaisesRegex(RegistryError, "already running"):
                daemon.serve(self.config)
        finally:
            lease.release()

    def test_failed_drain_stops_supervisor_instead_of_healthy_retry_loop(self):
        threads = []
        def thread(**kwargs):
            value = ScriptedThread(**kwargs)
            threads.append(value)
            return value
        def fail_between_heartbeats(_event):
            threads[0].run()
        event = ScriptedEvent([fail_between_heartbeats])
        with patch.object(pips.threading, "Thread", side_effect=thread), \
             patch.object(pips, "_drain", side_effect=sqlite3.OperationalError("private/path: disk I/O error")) as drain:
            with self.assertRaises(RegistryError) as failed:
                daemon.serve(self.config, stop_event=event, clock=self.registry.clock)
            self.assertEqual(failed.exception.code, "runner_failed")
            self.assertEqual(drain.call_count, 1)
            self.assertEqual(len(threads), 1)
            pips.start_queued(self.config)
            self.assertEqual(len(threads), 1, "The fault must remain latched without a local restart")
        status = daemon.runner_status(self.registry)
        self.assertEqual(status["status"], "stopped")
        self.assertFalse(status["online"])
        self.assertEqual(status["error"]["code"], "runner_failed")
        self.assertIn("OperationalError", status["error"]["message"])
        self.assertNotIn("private/path", json.dumps(status))
        self.assertEqual(event.waits, [daemon.HEARTBEAT_SECONDS])
        self.assertIsNone(daemon._controller(self.registry.directory))

    def test_failed_drain_discards_rerun_and_only_explicit_restart_clears_fault(self):
        threads = []
        def thread(**kwargs):
            value = ScriptedThread(**kwargs)
            threads.append(value)
            return value
        with patch.object(pips.threading, "Thread", side_effect=thread), \
             patch.object(pips, "_drain", side_effect=OSError("storage unavailable")) as drain:
            pips.start_queued(self.config)
            pips.start_queued(self.config)  # Mark rerun while the controlled worker is live.
            threads[0].run()
            self.assertEqual(drain.call_count, 1)
            self.assertNotIn(str(self.registry.directory), pips._RERUN)
            pips.start_queued(self.config)
            self.assertEqual(len(threads), 1)
        event = ScriptedEvent([lambda event: event.set()])
        with patch.object(pips, "start_queued") as start:
            result = daemon.serve(self.config, stop_event=event, clock=self.registry.clock)
        self.assertEqual(start.call_count, 1)
        self.assertIsNone(pips.drain_failure(self.registry.directory))
        self.assertNotIn("error", result)

    def test_controller_thread_start_failure_is_latched_and_removes_stale_thread(self):
        thread = Mock()
        thread.start.side_effect = RuntimeError("cannot start new thread")
        with patch.object(pips.threading, "Thread", return_value=thread):
            with self.assertRaises(RegistryError) as failed:
                pips.start_queued(self.config)
        self.assertEqual(failed.exception.code, "runner_failed")
        self.assertIsNone(daemon._controller(self.registry.directory))
        self.assertEqual(pips.drain_failure(self.registry.directory)["code"], "runner_failed")

    def test_failure_during_shutdown_join_is_not_reported_as_clean_stop(self):
        threads = []
        def thread(**kwargs):
            value = ScriptedThread(**kwargs)
            threads.append(value)
            return value
        event = ScriptedEvent([lambda event: event.set()])
        with patch.object(pips.threading, "Thread", side_effect=thread), \
             patch.object(pips, "_drain", side_effect=sqlite3.OperationalError("state unavailable")):
            with self.assertRaises(RegistryError) as failed:
                daemon.serve(self.config, stop_event=event, clock=self.registry.clock)
        self.assertEqual(failed.exception.code, "runner_failed")
        self.assertFalse(threads[0].alive)
        self.assertEqual(daemon.runner_status(self.registry)["error"]["code"], "runner_failed")

    def test_shutdown_cancels_only_owned_run_and_joins_even_if_status_write_fails(self):
        job = self.job()
        owned = self.run_row(job, "running", "owned")
        other = self.run_row(job, "running", "other")
        thread = Mock()
        record = self.record()
        with patch.object(daemon, "_controller", side_effect=[thread, None]), \
             patch.object(pips, "active_run_ids", return_value=[owned], create=True), \
             patch.object(daemon, "_heartbeat", side_effect=OSError("status write failed")), \
             patch("os.kill", side_effect=AssertionError("No PID signalling")):
            with self.assertRaisesRegex(OSError, "status write failed"):
                daemon._shutdown_owned(self.registry, self.config, record)
        thread.join.assert_called_once_with(daemon.HEARTBEAT_SECONDS)
        self.assertEqual(self.store.run(owned)["status"], "cancelling")
        self.assertEqual(self.store.run(other)["status"], "running")

    def test_shutdown_waits_for_worker_even_if_cancellation_storage_fails(self):
        thread = Mock()
        with patch.object(daemon, "_controller", side_effect=[thread, None]), \
             patch.object(pips, "active_run_ids", return_value=["owned"], create=True), \
             patch.object(pips.PipStore, "cancel", side_effect=OSError("cancel storage failed")):
            with self.assertRaisesRegex(OSError, "cancel storage failed"):
                daemon._shutdown_owned(self.registry, self.config, self.record())
        self.assertFalse(self.config.get("pips_enabled"))
        thread.join.assert_called_once_with(daemon.HEARTBEAT_SECONDS)

    def test_emergency_stop_survives_reopening_with_a_stale_enabled_config(self):
        stale = ConfigFixture(self.root, enabled=True)
        daemon.stop_all(self.config, "local-console")
        with WorkspaceRegistry() as reopened:
            self.assertTrue(daemon.is_runtime_paused(reopened))
            self.assertIsNone(pips.PipStore(reopened).claim_next())
        with self.assertRaisesRegex(RegistryError, "resume locally"):
            daemon.serve(stale)
        self.assertTrue(stale.get("pips_enabled"))

    def test_cli_status_and_local_resume_do_not_start_workers(self):
        with patch.object(pips, "start_queued") as start, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(daemon.handle_command(self.config, ["status"]), 0)
        self.assertEqual(json.loads(output.getvalue())["runner_id"], self.registry.runner_id)
        start.assert_not_called()

    def test_cli_routes_before_constructing_agent_and_help_has_no_config_side_effect(self):
        from dgc import cli
        with patch.object(cli, "Config", return_value=self.config), \
             patch.object(daemon, "handle_command", return_value=0) as handle, \
             patch.object(cli, "Agent", side_effect=AssertionError("No chat Agent for lifecycle")):
            self.assertEqual(cli.main(["pips", "status"]), 0)
        handle.assert_called_once_with(self.config, ["status"])
        with patch.object(cli, "Config", side_effect=AssertionError("Help must not load config")), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(["pips", "serve", "--help"]), 0)
        self.assertIn("dgc pips serve", output.getvalue())


if __name__ == "__main__":
    unittest.main()
