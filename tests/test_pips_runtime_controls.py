"""Cross-module stop/claim/watch/control regressions without models, network or sleeps."""
from __future__ import annotations

import copy
import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from dgc import pip_daemon as daemon, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry


class ConfigFixture:
    def __init__(self, root):
        self.project_root = root
        self.data = {"pips_enabled": True, "model": "fixture", "base_url": "http://model.invalid/v1",
                     "api_mode": "chat_completions", "subscription_engine": "", "context_size": 4096}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def clone_for_root(self, root):
        clone = ConfigFixture(root)
        clone.data = copy.deepcopy(self.data)
        return clone


class EventFixture:
    def __init__(self):
        self.value = False
        self.wait_count = 0

    def is_set(self):
        return self.value

    def set(self):
        self.value = True

    def wait(self, _timeout):
        self.wait_count += 1
        if self.wait_count > 1:
            raise AssertionError("This watchdog fixture must stop on its first deterministic tick")
        return self.value


class RuntimeControlsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-runtime-controls-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.root = self.base / "project"
        self.root.mkdir()
        env = patch.dict(os.environ, {"DGC_HOME": str(self.base / "home"), "HOME": str(self.base / "home")})
        env.start(); self.addCleanup(env.stop)
        self.registry = WorkspaceRegistry(clock=lambda: "2026-10-01T10:00:00.000Z")
        self.addCleanup(self.registry.close)
        self.workspace = self.registry.resolve(self.root)
        self.store = pips.PipStore(self.registry)
        # The original committed rules: these runs copy through clean_snapshot, which the fixtures replace.
        self.job = self.store.create(self.workspace["id"], "Auditor", "Read committed source", "paired-browser",
                                     source_policy={"mode": "committed_only"})
        self.config = ConfigFixture(self.root)
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.source = self.stack.enter_context(patch.object(pips, "source_revision", return_value="c" * 40))
        self.stack.enter_context(patch.object(pips.subprocess, "Popen", side_effect=AssertionError("No real subprocess in runtime fixtures")))
        self.stack.enter_context(patch("requests.sessions.Session.request", side_effect=AssertionError("No network")))

    def enqueue(self, key="request"):
        return self.store.enqueue(self.job["id"], key, "paired-browser", self.config)

    def request(self, command, **args):
        return pips.handle_control(self.config, {"type": command, "request_id": "request-control", **args}, "paired-browser")

    def pause_only(self):
        # The first committed phase of stop_all, before it walks individual jobs/runs.
        daemon._set_paused(self.registry, True, "paired-browser")

    def snapshot(self, _root, _revision, target):
        target.mkdir(parents=True)
        return {"files": 0, "bytes": 0}

    def test_stop_blocks_stale_enabled_config_before_git_resolution(self):
        daemon.stop_all(self.config, "paired-browser")
        with self.assertRaises(RegistryError) as stopped:
            self.enqueue()
        self.assertEqual(stopped.exception.code, "runner_stopped")
        self.source.assert_not_called()
        self.assertTrue(self.config.get("pips_enabled"))
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_runs").fetchone()[0], 0)

    def test_enqueue_rechecks_stop_inside_transaction_after_source_resolution(self):
        self.source.side_effect = lambda *_: (self.pause_only(), "c" * 40)[1]
        with self.assertRaises(RegistryError) as stopped:
            self.enqueue()
        self.assertEqual(stopped.exception.code, "runner_stopped")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_runs").fetchone()[0], 0)

    def test_claim_cannot_cross_persisted_stop_even_before_jobs_are_paused(self):
        run = self.enqueue()
        self.pause_only()
        self.assertEqual(self.store.get(self.job["id"])["status"], "active")
        with WorkspaceRegistry() as reopened:
            self.assertIsNone(pips.PipStore(reopened).claim_next())
        self.assertEqual(self.store.run(run["id"])["status"], "queued")

    def test_malformed_pause_state_blocks_both_enqueue_and_claim(self):
        run = self.enqueue()
        self.registry.db.execute("INSERT INTO metadata VALUES(?,?)", (daemon.CONTROL_KEY, "corrupt"))
        self.assertIsNone(self.store.claim_next())
        with self.assertRaises(RegistryError) as stopped:
            self.enqueue("next")
        self.assertEqual(stopped.exception.code, "runner_stopped")
        self.assertEqual(self.store.run(run["id"])["status"], "queued")

    def test_idempotent_retry_returns_cancelled_run_without_restarting_it(self):
        original = self.enqueue()
        daemon.stop_all(self.config, "paired-browser")
        self.source.reset_mock()
        retried = self.enqueue()
        self.assertEqual(retried["id"], original["id"])
        self.assertEqual(retried["status"], "cancelled")
        self.source.assert_not_called()
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_runs").fetchone()[0], 1)

    def test_stop_after_claim_prevents_snapshot_and_process_spawn(self):
        run = self.enqueue(); row = self.store.claim_next()
        self.pause_only()
        with patch.object(pips, "clean_snapshot", side_effect=AssertionError("No snapshot after stop")):
            with self.assertRaises(RegistryError) as stopped:
                pips._execute_run(self.registry, row, self.config)
        self.assertEqual(stopped.exception.code, "cancelled")
        self.assertEqual(self.store.run(run["id"])["status"], "cancelling")

    def test_stop_during_snapshot_prevents_process_spawn(self):
        run = self.enqueue(); row = self.store.claim_next()
        def stop_in_snapshot(*args):
            result = self.snapshot(*args)
            self.pause_only()
            return result
        with patch.object(pips, "clean_snapshot", side_effect=stop_in_snapshot):
            with self.assertRaises(RegistryError) as stopped:
                pips._execute_run(self.registry, row, self.config)
        self.assertEqual(stopped.exception.code, "cancelled")
        self.assertEqual(self.store.run(run["id"])["status"], "cancelling")

    def worker_fixture(self, row, *, after_spawn=None, monitor_start_error=False):
        manifest = json.loads(row["manifest"])
        output = [ {"kind": "policy_ready", "digest": manifest["policy_digest"]},
                   {"kind": "result", "result": {"summary": "fixture"}} ]
        monitor_errors, terminated = [], []
        class Process:
            rc = 0
            stdin = io.BytesIO()
            stdout = io.BytesIO(("\n".join(json.dumps(value) for value in output) + "\n").encode())
            def wait(self, timeout=None): return self.rc
        proc = Process()
        class Thread:
            def __init__(self, *, target, **_): self.target = target
            def start(self):
                if monitor_start_error:
                    raise RuntimeError("thread creation failed")
                try: self.target()
                except BaseException as exc: monitor_errors.append(exc)
            def join(self, timeout=None): pass
        def spawn(*_args, **_kwargs):
            if after_spawn:
                after_spawn()
            return proc
        def terminate(owned):
            self.assertIs(owned, proc)
            terminated.append(owned)
            owned.rc = -9
        stack = ExitStack()
        stack.enter_context(patch.object(pips, "clean_snapshot", side_effect=self.snapshot))
        stack.enter_context(patch.object(pips.subprocess, "Popen", side_effect=spawn))
        stack.enter_context(patch.object(pips.threading, "Thread", Thread))
        stack.enter_context(patch.object(pips.threading, "Event", EventFixture))
        stack.enter_context(patch.object(pips.time, "monotonic", return_value=0))
        stack.enter_context(patch.object(pips, "_terminate", side_effect=terminate))
        return stack, proc, monitor_errors, terminated

    def test_watch_observes_stop_after_spawn_and_cancels_instead_of_failing_run(self):
        run = self.enqueue(); row = self.store.claim_next()
        stack, proc, monitor_errors, terminated = self.worker_fixture(row, after_spawn=self.pause_only)
        with stack, self.assertRaises(RegistryError) as stopped:
            pips._execute_run(self.registry, row, self.config)
        final = self.store.finish(run["id"], error={"code": stopped.exception.code})
        self.assertEqual(final["status"], "cancelled")
        self.assertIsNone(final["error"])
        self.assertEqual(monitor_errors, [])
        self.assertTrue(terminated)
        self.assertTrue(proc.stdout.closed)

    def test_watch_observes_owned_config_shutdown_after_spawn(self):
        run = self.enqueue(); row = self.store.claim_next()
        stack, _, monitor_errors, terminated = self.worker_fixture(row, after_spawn=lambda: self.config.data.update(pips_enabled=False))
        with stack, self.assertRaises(RegistryError) as stopped:
            pips._execute_run(self.registry, row, self.config)
        final = self.store.finish(run["id"], error={"code": stopped.exception.code})
        self.assertEqual(final["status"], "cancelled")
        self.assertEqual(monitor_errors, [])
        self.assertTrue(terminated)
        self.assertFalse(daemon.is_runtime_paused(self.registry))

    def test_watcher_storage_failure_terminates_owned_process_and_reports_structured_error(self):
        self.enqueue(); row = self.store.claim_next()
        stack, _, monitor_errors, terminated = self.worker_fixture(row)
        with stack, patch.object(pips, "WorkspaceRegistry", side_effect=sqlite3.OperationalError("private database details")), \
             self.assertRaises(RegistryError) as stopped:
            pips._execute_run(self.registry, row, self.config)
        self.assertEqual(stopped.exception.code, "runner_state_unavailable")
        self.assertNotIn("private database details", str(stopped.exception))
        self.assertEqual(monitor_errors, [])
        self.assertTrue(terminated)

    def test_failed_monitor_start_does_not_leave_the_spawned_worker_or_pipes_open(self):
        self.enqueue(); row = self.store.claim_next()
        stack, proc, _, terminated = self.worker_fixture(row, monitor_start_error=True)
        with stack, self.assertRaisesRegex(RuntimeError, "thread creation failed"):
            pips._execute_run(self.registry, row, self.config)
        self.assertTrue(terminated)
        self.assertTrue(proc.stdin.closed)
        self.assertTrue(proc.stdout.closed)

    def test_several_pips_run_at_once_and_each_pip_one_run_at_a_time(self):
        """Reported 2026-10-14: a Pip run keeps going, so one long run must not hold up every other Pip."""
        import threading
        import time as clock
        other = self.store.create(self.workspace["id"], "Second", "Read committed source", "paired-browser",
                                  source_policy={"mode": "committed_only"})
        first = self.enqueue("a-1")
        second = self.enqueue("a-2")
        third = self.store.enqueue(other["id"], "b-1", "paired-browser", self.config)
        running, seen, order, lock = set(), [], [], threading.Lock()
        release = threading.Event()

        def execution(registry, row, _config):
            with lock:
                self.assertNotIn(row["pip_id"], running, "a Pip never runs twice at once")
                running.add(row["pip_id"])
                seen.append(set(running))
                order.append(row["id"])
                together = len(running)
            if together < 2:
                release.wait(5)                  # the first holds until the other Pip's run is going too
            else:
                release.set()
            clock.sleep(0.05)
            with lock:
                running.discard(row["pip_id"])
            raise RegistryError("fixture_done", "done")
        with patch.object(pips, "_execute_run", side_effect=execution):
            pips._drain(self.config, self.registry.directory)
        self.assertTrue(any(len(both) == 2 for both in seen), "two Pips ran together")
        self.assertTrue(all(len(both) <= 2 for both in seen))
        self.assertEqual(sorted(order), sorted([first["id"], second["id"], third["id"]]), "each run once")
        self.assertEqual({self.store.run(r["id"])["status"] for r in (first, second, third)}, {"failed"}, "every run ran")

    def test_one_run_at_a_time_when_set_to_one(self):
        import threading
        other = self.store.create(self.workspace["id"], "Second", "Read committed source", "paired-browser",
                                  source_policy={"mode": "committed_only"})
        self.enqueue("a-1")
        self.store.enqueue(other["id"], "b-1", "paired-browser", self.config)
        self.config.data["pips_parallel_runs"] = 1
        live, peak, lock = [0], [0], threading.Lock()

        def execution(registry, row, _config):
            with lock:
                live[0] += 1
                peak[0] = max(peak[0], live[0])
            with lock:
                live[0] -= 1
            raise RegistryError("fixture_done", "done")
        with patch.object(pips, "_execute_run", side_effect=execution):
            pips._drain(self.config, self.registry.directory)
        self.assertEqual(peak[0], 1)
        self.assertEqual(pips.parallel_runs(self.config), 1)
        self.config.data["pips_parallel_runs"] = 999
        self.assertEqual(pips.parallel_runs(self.config), pips.PARALLEL_MAX)

    def test_a_pip_with_a_run_going_is_not_given_another(self):
        first = self.enqueue("a-1")
        second = self.enqueue("a-2")
        claimed = self.store.claim_next()
        self.assertIn(claimed["id"], (first["id"], second["id"]))
        self.assertIsNone(self.store.claim_next(), "its next run waits for this one")

    def test_controller_records_only_its_claimed_run_and_clears_ownership_after_failure(self):
        run = self.enqueue()
        seen = []
        def execution(registry, row, _config):
            seen.append(pips.active_run_id(registry.directory))
            self.assertEqual(row["id"], run["id"])
            raise RegistryError("fixture_failure", "Controlled worker failure")
        with patch.object(pips, "_execute_run", side_effect=execution):
            pips._drain(self.config, self.registry.directory)
        self.assertEqual(seen, [run["id"]])
        self.assertIsNone(pips.active_run_id(self.registry.directory))
        self.assertIsNone(pips.active_run_id(self.base / "unrelated"))
        self.assertEqual(self.store.run(run["id"])["status"], "failed")

    def test_control_stop_and_status_work_after_launch_directory_is_removed(self):
        self.enqueue()
        self.root.rmdir()
        with patch.object(pips, "start_queued", side_effect=AssertionError("Status/stop must not launch")):
            for command in ("get_pip_runner", "stop_pips", "get_pip_runner"):
                response = self.request(command)
                self.assertTrue(response["ok"], response)
                self.assertEqual(response["request_id"], "request-control")
                self.assertEqual(response["command"], command)
                self.assertNotIn("pid", response["result"]["runner"])
                self.assertNotIn(str(self.root), json.dumps(response))
        self.assertTrue(response["result"]["runner"]["paused"])
        self.assertEqual(self.store.get(self.job["id"])["status"], "paused")

    def test_global_stop_can_only_be_resumed_locally_and_jobs_stay_paused(self):
        self.enqueue()
        self.assertTrue(self.request("stop_pips")["ok"])
        for command in ("resume_pips", "resume_runtime"):
            response = self.request(command)
            self.assertEqual(response["error"]["code"], "unsupported_command")
        injected = self.request("stop_pips", paused=False)
        self.assertEqual(injected["error"]["code"], "invalid_request")
        with patch.object(pips, "start_queued") as start:
            result = daemon.resume_runtime(self.config, "local-console")
            start.assert_not_called()
        self.assertFalse(result["paused"])
        self.assertEqual(self.store.get(self.job["id"])["status"], "paused")
        with self.assertRaises(RegistryError) as stopped:
            self.enqueue("later")
        self.assertEqual(stopped.exception.code, "paused")


if __name__ == "__main__":
    unittest.main()
