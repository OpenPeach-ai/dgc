"""Deterministic local supervisor startup, using controlled processes/events."""
import json
import os
import time
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from dgc import __version__, pip_runtime as runtime
from dgc.scheduler import named_process_lock
from dgc.workspace_registry import RegistryError
from module_clock import own_clock


class LocalStartupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-runtime-start-")
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.config = Mock(project_root=self.directory)
        self.config.get.side_effect = lambda key, default=None: True if key == "pips_enabled" else default
        self.process = Mock()
        self.process.poll.return_value = None
        self.offline = {"online": False, "status": "offline", "paused": False}
        self.online = {"online": True, "status": "running", "paused": False, "version": __version__}
        for name, value in (("state_directory", self.directory),):
            p = patch.object(runtime, name, return_value=value); p.start(); self.addCleanup(p.stop)

    def test_disabled_never_opens_state_or_process(self):
        self.config.get.return_value = False
        self.config.get.side_effect = None
        with patch.object(runtime, "_state", side_effect=AssertionError("must not read")), \
             patch.object(runtime.subprocess, "Popen", side_effect=AssertionError("must not spawn")), \
             self.assertRaisesRegex(RegistryError, "Enable Pips"):
            runtime.start_runtime(self.config)

    def test_paused_start_never_clears_stop(self):
        with patch.object(runtime, "_state", return_value=({**self.offline, "paused": True}, "old")), \
             patch.object(runtime, "resume_runtime", side_effect=AssertionError("no implicit resume")), \
             patch.object(runtime.subprocess, "Popen", side_effect=AssertionError("no child")), \
             self.assertRaisesRegex(RegistryError, "Global stop"):
            runtime.start_runtime(self.config)

    def test_existing_live_supervisor_returns_without_spawning(self):
        with patch.object(runtime, "_state", return_value=(self.online, "old")), \
             patch.object(runtime, "supervisor_is_live", return_value=True), \
             patch.object(runtime.subprocess, "Popen", side_effect=AssertionError("no duplicate")):
            self.assertEqual(runtime.start_runtime(self.config), self.online)

    def test_a_busy_runner_from_an_older_install_is_left_to_finish_and_says_so(self):
        for version, words in ((None, "an older DGC (an earlier version)"), ("0.0.1", "an older DGC (0.0.1)"),
                               (__version__ + "+other", f"another DGC install ({__version__}+other)")):
            old = {**self.online, "version": version}
            with self.subTest(version=version), patch.object(runtime, "_state", return_value=(old, "old")), \
                 patch.object(runtime, "supervisor_is_live", return_value=True), \
                 patch("dgc.pip_daemon.pause_if_idle", return_value=False) as pause, \
                 patch.object(runtime, "resume_runtime", side_effect=AssertionError("never stopped")), \
                 patch.object(runtime.subprocess, "Popen", side_effect=AssertionError("no duplicate")):
                for operation in (runtime.start_runtime, runtime.require_supervisor):
                    with self.assertRaises(RegistryError) as caught:
                        operation(self.config)
                    self.assertEqual(caught.exception.code, "runner_version_mismatch")
                    self.assertIn(f"is from {words} and is still working", str(caught.exception))
                    self.assertIn(f"moves it to this one ({__version__})", str(caught.exception))
                    self.assertNotIn("Keep Pips running", str(caught.exception))
                self.assertEqual(pause.call_count, 2)

    def test_a_runner_from_a_newer_install_is_never_replaced_by_this_one(self):
        newer = {**self.online, "version": "999.0.0"}
        with patch.object(runtime, "_state", return_value=(newer, "old")), \
             patch.object(runtime, "supervisor_is_live", return_value=True), \
             patch("dgc.pip_daemon.pause_if_idle", side_effect=AssertionError("never stopped")), \
             patch.object(runtime.subprocess, "Popen", side_effect=AssertionError("no duplicate")):
            for operation in (runtime.start_runtime, runtime.require_supervisor):
                with self.assertRaisesRegex(RegistryError, r"newer DGC \(999\.0\.0\) than this one"):
                    operation(self.config)

    def test_start_uses_same_package_and_independent_process_without_cloud(self):
        with patch.object(runtime, "_state", side_effect=[(self.offline, "old"), (self.online, "new")]), \
             patch.object(runtime, "supervisor_is_live", side_effect=[False, True]), \
             patch.object(runtime.subprocess, "Popen", return_value=self.process) as spawn, \
             patch.object(runtime.threading, "Thread") as reaper:
            self.assertEqual(runtime.start_runtime(self.config), self.online)
        command = spawn.call_args.args[0]
        self.assertEqual(command, runtime._supervisor_command(self.config.project_root))
        self.assertEqual(command[-1], str(self.config.project_root))
        self.assertEqual(spawn.call_args.kwargs["cwd"], Path(runtime.__file__).resolve().parents[1])
        self.assertTrue(spawn.call_args.kwargs["start_new_session"])
        self.assertEqual(spawn.call_args.kwargs["stdin"], subprocess.DEVNULL)
        self.assertNotIn("api_key", json.dumps(command))
        self.assertEqual(spawn.call_args.kwargs["env"]["PYTHONPATH"], str(Path(runtime.__file__).resolve().parents[1]))
        self.config.set.assert_not_called()
        reaper.assert_called_once()
        self.process.terminate.assert_not_called()
        self.assertEqual((self.directory / "supervisor.log").stat().st_mode & 0o777, 0o600)

    def test_explicit_resume_clears_stop_before_spawning(self):
        with patch.object(runtime, "_state", side_effect=[({**self.offline, "paused": True}, "old"), (self.offline, "old"), (self.online, "new")]), \
             patch.object(runtime, "resume_runtime") as resume, \
             patch.object(runtime, "supervisor_is_live", side_effect=[False, True]), \
             patch.object(runtime.subprocess, "Popen", return_value=self.process), patch.object(runtime.threading, "Thread"):
            runtime.start_runtime(self.config, resume=True)
        resume.assert_called_once_with(self.config, "local-editor")

    def test_stale_heartbeat_cannot_fake_start_and_timeout_kills_only_owned_child(self):
        with patch.object(runtime, "_state", side_effect=[(self.offline, "old"), (self.online, "old")]), \
             patch.object(runtime, "supervisor_is_live", return_value=False), \
             patch.object(runtime.subprocess, "Popen", return_value=self.process), \
             own_clock(runtime, 0, 9), \
             self.assertRaisesRegex(RegistryError, "did not report ready"):
            runtime.start_runtime(self.config)
        self.process.terminate.assert_called_once()
        self.process.wait.assert_called_once_with(timeout=5)

    def test_new_stop_during_start_wins(self):
        with patch.object(runtime, "_state", side_effect=[(self.offline, "old"), ({**self.offline, "paused": True}, "new")]), \
             patch.object(runtime, "supervisor_is_live", return_value=False), \
             patch.object(runtime.subprocess, "Popen", return_value=self.process), \
             self.assertRaisesRegex(RegistryError, "newer global stop"):
            runtime.start_runtime(self.config)
        self.process.terminate.assert_called_once()

    def test_startup_wait_is_controlled_without_sleep(self):
        with patch.object(runtime, "_state", side_effect=[(self.offline, "old"), (self.offline, "old"), (self.online, "new")]), \
             patch.object(runtime, "supervisor_is_live", side_effect=[False, True]), \
             patch.object(runtime.subprocess, "Popen", return_value=self.process), patch.object(runtime.threading, "Thread"), \
             patch.object(runtime.threading, "Event") as event, patch.object(runtime.time, "monotonic", return_value=0):
            runtime.start_runtime(self.config)
        event.return_value.wait.assert_called_once_with(0.05)

    def test_log_symlink_is_refused_before_process(self):
        outside = self.directory / "outside"
        outside.write_text("untouched")
        (self.directory / "supervisor.log").symlink_to(outside)
        with patch.object(runtime, "_state", return_value=(self.offline, None)), \
             patch.object(runtime, "supervisor_is_live", return_value=False), \
             patch.object(runtime.subprocess, "Popen", side_effect=AssertionError("no child")), self.assertRaises(OSError):
            runtime.start_runtime(self.config)
        self.assertEqual(outside.read_text(), "untouched")

    def test_supervisor_requires_lock_and_fresh_running_status(self):
        for held in (True, False):
            lease = Mock(last_error="")
            lease.acquire.return_value = not held
            with patch.object(runtime, "named_process_lock", return_value=lease):
                self.assertEqual(runtime.supervisor_is_live(self.directory, self.online), held)
            self.assertEqual(lease.release.call_count, int(not held))
        with patch.object(runtime, "named_process_lock", side_effect=AssertionError("no lease")):
            self.assertFalse(runtime.supervisor_is_live(self.directory, self.offline))

    def test_lease_storage_error_never_proves_liveness_or_starts_child(self):
        lease = Mock(last_error="pips-supervisor lease unavailable (PermissionError)")
        lease.acquire.return_value = False
        with patch.object(runtime, "named_process_lock", return_value=lease), \
             patch.object(runtime, "_state", return_value=(self.online, "old")), \
             patch.object(runtime.subprocess, "Popen", side_effect=AssertionError("Unknown ownership must not spawn")):
            for operation in (runtime.start_runtime, runtime.require_supervisor):
                with self.subTest(operation=operation.__name__), self.assertRaises(RegistryError) as raised:
                    operation(self.config)
                self.assertEqual(raised.exception.code, "runner_unavailable")

    def test_workspace_package_cannot_replace_supervisor_or_dependencies(self):
        project = self.directory / "untrusted-project"
        project.mkdir()
        marker = self.directory / "workspace-code-executed"
        payload = "from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('unsafe')\n"
        (project / "dgc").mkdir()
        (project / "dgc" / "__init__.py").write_text(payload)
        (project / "dgc" / "__main__.py").write_text(payload)
        (project / "json.py").write_text(payload)
        home = self.directory / "home"; home.mkdir()
        trusted = Path(runtime.__file__).resolve().parents[1]
        env = {"HOME": str(home), "DGC_HOME": str(home), "PATH": os.environ.get("PATH", ""),
               "PYTHONPATH": str(trusted), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}
        # Pips are on by default; this profile turns them off, so the actual trusted CLI must
        # refuse. If cwd/project won import precedence, either hostile fixture would run.
        (home / ".dgc").mkdir(mode=0o700)
        (home / ".dgc" / "config.json").write_text('{"pips_enabled": false}')
        os.chmod(home / ".dgc" / "config.json", 0o600)
        child = subprocess.run(runtime._supervisor_command(project), cwd=trusted, env=env,
                               capture_output=True, text=True, timeout=20)
        self.assertEqual(child.returncode, 1, child.stdout + child.stderr)
        self.assertIn("Pips are disabled", child.stderr)
        self.assertFalse(marker.exists())

    def test_pips_leases_live_under_runner_state_not_ambient_home(self):
        ambient = self.directory / "ambient-home"
        runner = self.directory / "isolated-runner" / ".dgc" / "pips"
        with patch.dict(os.environ, {"HOME": str(ambient), "DGC_HOME": str(runner.parent.parent)}):
            for namespace in ("pips-supervisor", "pips-runner"):
                lease = named_process_lock(namespace, str(runner))
                self.assertTrue(lease.acquire(blocking=False), lease.last_error)
                try:
                    self.assertEqual(lease.path.parent, runner / "locks")
                finally:
                    lease.release()
            self.assertFalse(ambient.exists(), "Pips must not create ambient ~/.dgc/locks")
            other = named_process_lock("unrelated-fixture", str(runner))
            self.assertTrue(other.acquire(blocking=False), other.last_error)
            try:
                self.assertEqual(other.path.parent, ambient / ".dgc" / "locks")
            finally:
                other.release()

    def test_same_pips_state_excludes_second_process_with_different_home(self):
        runner = self.directory / "runner" / ".dgc" / "pips"
        lease = named_process_lock("pips-supervisor", str(runner))
        self.assertTrue(lease.acquire(blocking=False), lease.last_error)
        try:
            trusted = Path(runtime.__file__).resolve().parents[1]
            env = {"HOME": str(self.directory / "other-home"), "DGC_HOME": str(runner.parent.parent),
                   "PYTHONPATH": str(trusted), "PYTHONDONTWRITEBYTECODE": "1", "PATH": os.environ.get("PATH", "")}
            child = subprocess.run([runtime.sys.executable, "-c",
                "import sys; from dgc.scheduler import named_process_lock; "
                "lease=named_process_lock('pips-supervisor',sys.argv[1]); "
                "print(lease.acquire(blocking=False)); print(lease.last_error)", str(runner)],
                cwd=trusted, env=env, text=True, capture_output=True, timeout=20)
            self.assertEqual(child.returncode, 0, child.stderr)
            self.assertEqual(child.stdout, "False\n\n")
        finally:
            lease.release()

    def test_pips_symlink_lock_directory_is_refused(self):
        runner = self.directory / "runner"
        runner.mkdir()
        outside = self.directory / "outside"; outside.mkdir()
        (runner / "locks").symlink_to(outside, target_is_directory=True)
        lease = named_process_lock("pips-supervisor", str(runner))
        self.assertFalse(lease.acquire(blocking=False))
        self.assertIn("not safe", lease.last_error)
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()


class MovingTheRunnerTests(unittest.TestCase):
    """After an update, a runner the editor started from the previous install keeps running it. When it is idle it is
    stopped with the runtime stop alone and this install's starts; Stop is cleared again and no Pip is paused."""

    def setUp(self):
        import threading
        from dgc import pip_daemon
        from dgc.workspace_registry import WorkspaceRegistry
        temp = tempfile.TemporaryDirectory(prefix="dgc-runtime-move-")
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.config = Mock(project_root=self.directory)
        self.config.get.side_effect = lambda key, default=None: True if key == "pips_enabled" else default
        for target in ("dgc.pip_runtime.state_directory", "dgc.pip_daemon.state_directory"):
            p = patch(target, return_value=self.directory); p.start(); self.addCleanup(p.stop)
        p = patch("dgc.pips._require_runner_platform"); p.start(); self.addCleanup(p.stop)
        self.registry = WorkspaceRegistry(self.directory)
        self.addCleanup(self.registry.close)
        self.lease = named_process_lock("pips-supervisor", str(self.directory))
        self.daemon, self.threading = pip_daemon, threading

    def supervisor(self, version, instance):
        record = {"schema_version": 1, "instance_id": instance, "version": version, "pid": os.getpid(),
                  "started_at": self.registry.clock(), "heartbeat_at": self.registry.clock(), "status": "running"}
        with self.registry.transaction():
            self.daemon._write(self.registry, self.daemon.SUPERVISOR_KEY, record)

    def old_runner(self):
        """Holds the lease, as the previous install's runner does, until the runtime stop is set."""
        self.supervisor("0.50.1", "supervisor_old")
        self.assertTrue(self.lease.acquire(blocking=False))
        seen = []

        def run():
            from dgc.workspace_registry import WorkspaceRegistry
            with WorkspaceRegistry(self.directory) as registry:
                while not self.daemon.is_runtime_paused(registry):
                    time.sleep(0.02)
                seen.append(True)
            self.lease.release()
        thread = self.threading.Thread(target=run, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        return seen

    def this_install_starts(self, *args, **kwargs):
        self.supervisor(__version__, "supervisor_new")
        self.assertTrue(self.lease.acquire(blocking=False))
        self.addCleanup(self.lease.release)
        process = Mock()
        process.poll.return_value = None
        return process

    def test_an_idle_runner_from_the_previous_install_is_moved_to_this_one(self):
        stopped = self.old_runner()
        with patch.object(runtime.subprocess, "Popen", side_effect=self.this_install_starts) as spawn, \
             patch.object(runtime.threading, "Thread"):
            status = runtime.require_supervisor(self.config)
        self.assertEqual(stopped, [True], "the old runner was stopped")
        spawn.assert_called_once()
        self.assertEqual(status["version"], __version__)
        self.assertFalse(self.daemon.is_runtime_paused(self.registry), "Stop is cleared again")
        self.assertIsNone(self.registry.db.execute("SELECT 1 FROM pips WHERE status='paused'").fetchone())

    def test_a_queued_run_keeps_it_running_and_nothing_is_stopped(self):
        self.supervisor("0.50.1", "supervisor_old")
        self.assertTrue(self.lease.acquire(blocking=False))
        self.addCleanup(self.lease.release)
        db = self.registry.db
        db.execute("PRAGMA foreign_keys=OFF")
        with self.registry.transaction():
            db.execute("INSERT INTO pip_runs(id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,"
                       "status,created_at) VALUES('run_'||hex(randomblob(16)),'pip_x','ws_x','b','k','device','{}',"
                       "'queued',?)", (self.registry.clock(),))
        db.execute("PRAGMA foreign_keys=ON")
        with patch.object(runtime.subprocess, "Popen", side_effect=AssertionError("no second runner")):
            for operation in (runtime.start_runtime, runtime.require_supervisor):
                with self.assertRaisesRegex(RegistryError, "is still working"):
                    operation(self.config)
        self.assertFalse(self.daemon.is_runtime_paused(self.registry), "never stopped")
        self.assertEqual(db.execute("SELECT status FROM pip_runs").fetchone()[0], "queued")

    def test_with_keep_pips_running_on_its_service_starts_this_installs_runner(self):
        stopped = self.old_runner()
        with patch.object(runtime, "_keep_running", return_value={"on": True, "outdated": False}), \
             patch("dgc.pip_keep_running.set_on", side_effect=lambda *a, **k: self.this_install_starts()) as service, \
             patch.object(runtime.subprocess, "Popen", side_effect=AssertionError("the service starts it")):
            status = runtime.start_runtime(self.config)
        self.assertEqual(stopped, [True])
        service.assert_called_once_with(True, runner_online=False)
        self.assertEqual(status["version"], __version__)
        self.assertFalse(self.daemon.is_runtime_paused(self.registry))

    def test_a_service_still_on_the_previous_install_is_moved_before_anything_else_starts(self):
        # Its runner can't start (it refuses the database this install moved on): nothing is live.
        self.supervisor("0.50.1", "supervisor_old")
        with patch.object(runtime, "_keep_running", return_value={"on": True, "outdated": True}), \
             patch("dgc.pip_keep_running.set_on", side_effect=lambda *a, **k: self.this_install_starts()) as service, \
             patch.object(runtime.subprocess, "Popen", side_effect=AssertionError("the service starts it")):
            status = runtime.start_runtime(self.config)
        service.assert_called_once_with(True, runner_online=False)
        self.assertEqual(status["version"], __version__)
