"""DGC updated under a running Pips supervisor.

A user's runner stopped at 15:10:55 IST, 24 seconds after their everyday DGC was updated to a
build that moved the Pips database to a new schema: the long-running supervisor still had the old
code, its next drain could not open the newer database, and all it said was "The local Pips
controller stopped (RegistryError)". Now it says DGC was updated, and `dgc pips serve` starts itself
again on the new code -- once a minute at most, so a database newer than any code on disk cannot
restart it forever.
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_cli, pip_daemon, pip_runtime as runtime, pips
from dgc.workspace_registry import SCHEMA_VERSION, RegistryError, WorkspaceRegistry


class UpdateMessageTests(unittest.TestCase):
    def test_a_newer_database_reads_as_an_update_not_a_bare_class_name(self):
        failure = pips._controller_failure(RegistryError("schema_version", "This Pips database needs a compatible DGC version."))
        self.assertEqual(failure["code"], "runner_failed")
        self.assertTrue(failure["updated"])
        self.assertEqual(failure["message"], "DGC was updated while the Pips runner was running. "
                                             "Start the runner again to use the new version.")
        other = pips._controller_failure(RegistryError("conflict", "secret path /home/x"))
        self.assertNotIn("updated", other)
        self.assertIn("(RegistryError)", other["message"], "other failures still expose only the class")
        self.assertNotIn("/home/x", other["message"])

    def test_the_supervisor_loop_names_the_update(self):
        with patch.object(pips, "drain_failure", return_value={"code": "runner_failed", "updated": True, "message": "m"}):
            with self.assertRaises(RegistryError) as raised:
                pip_daemon._check_controller(Path("/x"))
        self.assertEqual(raised.exception.code, "dgc_updated")
        with patch.object(pips, "drain_failure", return_value={"code": "runner_failed", "message": "m"}):
            with self.assertRaises(RegistryError) as raised:
                pip_daemon._check_controller(Path("/x"))
        self.assertEqual(raised.exception.code, "runner_failed")


class RestartGuardTests(unittest.TestCase):
    def test_it_restarts_with_the_exact_command_once_a_minute_at_most(self):
        calls = []
        orig = ["/usr/bin/python3", "-c", "bootstrap", "/pkg", "/project"]
        with patch.dict(os.environ, {}, clear=False), patch.object(sys, "orig_argv", orig), \
                patch.object(os, "execv", side_effect=lambda exe, argv: calls.append((exe, argv))):
            os.environ.pop(pip_cli.RESTART_ENV, None)
            self.assertTrue(pip_cli._restart_on_new_code())
            self.assertEqual(calls, [(sys.executable, [sys.executable, "-c", "bootstrap", "/pkg", "/project"])])
            self.assertTrue(os.environ.get(pip_cli.RESTART_ENV), "the new process knows it was just restarted")
            self.assertFalse(pip_cli._restart_on_new_code(), "a second update within a minute stops instead")
            self.assertEqual(len(calls), 1)
            os.environ[pip_cli.RESTART_ENV] = str(time.time() - pip_cli.RESTART_GAP_SECONDS - 1)
            self.assertTrue(pip_cli._restart_on_new_code(), "a later update restarts again")

    def test_without_a_command_line_it_does_not_try(self):
        with patch.object(sys, "orig_argv", []), patch.object(os, "execv") as execv:
            self.assertFalse(pip_cli._restart_on_new_code())
        execv.assert_not_called()


class RealSupervisorTests(unittest.TestCase):
    def test_a_supervisor_whose_database_moves_on_restarts_once_and_says_why(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-supervisor-update-")
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        home, project = root / "home", root / "project"
        project.mkdir()
        (home / ".dgc").mkdir(parents=True, mode=0o700)
        (home / ".dgc" / "config.json").write_text('{"pips_enabled": true}')
        os.chmod(home / ".dgc" / "config.json", 0o600)
        trusted = Path(runtime.__file__).resolve().parents[1]
        env = {"HOME": str(home), "DGC_HOME": str(home), "PATH": os.environ.get("PATH", ""),
               "PYTHONPATH": str(trusted), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}
        state = home / ".dgc" / "pips"
        log = root / "supervisor.log"
        with open(log, "wb") as out:
            proc = subprocess.Popen(runtime._supervisor_command(project), cwd=trusted, env=env,
                                    stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        database = state / "registry.sqlite3"

        def supervisor():
            try:
                db = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=3)
                try:
                    row = db.execute("SELECT value FROM metadata WHERE key='pips_supervisor'").fetchone()
                finally:
                    db.close()
                import json
                return json.loads(row[0]) if row else None
            except sqlite3.Error:
                return None

        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and (supervisor() or {}).get("status") != "running":
            self.assertIsNone(proc.poll(), log.read_text(errors="replace"))
            time.sleep(0.2)
        self.assertEqual((supervisor() or {}).get("status"), "running", log.read_text(errors="replace"))
        # A newer DGC moves the database on underneath it.
        db = sqlite3.connect(database, timeout=10)
        db.execute(f"PRAGMA user_version={SCHEMA_VERSION + 1}")
        db.close()
        try:
            proc.wait(timeout=40)
        finally:
            db = sqlite3.connect(database, timeout=10)
            db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            db.close()
        text = log.read_text(errors="replace")
        self.assertEqual(text.count("DGC was updated; starting again on the new version."), 1, text)
        self.assertIn("needs a compatible DGC version", text,
                      "the restarted process met a database newer than its code too, and stopped instead of looping")
        record = supervisor()
        self.assertEqual(record["status"], "stopped")
        self.assertEqual(record["error"]["message"], "DGC was updated while the Pips runner was running. "
                                                     "Start the runner again to use the new version.")
        with patch.dict(os.environ, {"DGC_HOME": str(home)}):
            with WorkspaceRegistry(state) as registry:
                status = pip_daemon.runner_status(registry)
        self.assertEqual(status["error"]["message"], record["error"]["message"], "what the editor shows")


if __name__ == "__main__":
    unittest.main()
