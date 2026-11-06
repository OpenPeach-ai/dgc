"""Keep Pips running: one switch, a user service on Linux and a LaunchAgent on macOS.

Fake service managers here; tests/test_pip_keep_running_live.py drives the real ones.
"""
import contextlib
import io
import os
import plistlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from dgc import pip_cli, pip_keep_running as keep, pip_service as service
from dgc.workspace_registry import RegistryError
from tests.host_python import trust_host_python


class Done:
    def __init__(self, code=0, out=b""):
        self.returncode, self.stdout, self.stderr = code, out, b""


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux user-systemd")
class LinuxSwitchTests(unittest.TestCase):
    def setUp(self):
        trust_host_python(self)
        native_linux = patch.object(keep.wsl, "version", return_value=0)
        native_linux.start()
        self.addCleanup(native_linux.stop)
        temp = tempfile.TemporaryDirectory(prefix="dgc-keep-")
        self.addCleanup(temp.cleanup)
        base = Path(temp.name)
        self.home = base / "home"; self.home.mkdir(mode=0o700)
        self.options = {"unit_directory": base / "units"}
        self.spec = service.preview(self.home, **self.options)
        self.unit = Path(self.spec["unit_path"])
        self.active, self.enabled, self.linger, self.calls = "inactive", "disabled", "no", []
        p = patch.object(service, "_systemctl", side_effect=self.systemctl); p.start(); self.addCleanup(p.stop)
        p = patch.object(keep, "_run", side_effect=self.loginctl); p.start(); self.addCleanup(p.stop)

    def systemctl(self, args):
        self.calls.append(args)
        if args[0] == "show":
            return "\n".join(f"{k}={v}" for k, v in {
                "Id": self.spec["unit_name"], "LoadState": "loaded", "ActiveState": self.active,
                "SubState": "running" if self.active == "active" else "dead", "UnitFileState": self.enabled,
                "FragmentPath": str(self.unit), "DropInPaths": ""}.items())
        self.active = {"start": "active", "stop": "inactive"}.get(args[0], self.active)
        self.enabled = {"enable": "enabled", "disable": "disabled"}.get(args[0], self.enabled)
        return ""

    def loginctl(self, argv, check=True):
        self.calls.append(argv)
        if "enable-linger" in argv:
            self.linger = "yes"
            return Done()
        if "disable-linger" in argv:
            self.linger = "no"
            return Done()
        return Done(out=self.linger.encode() + b"\n")

    def test_on_installs_registers_for_login_and_starts_the_runner(self):
        value = keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        self.assertEqual(self.unit.read_text(), self.spec["content"])
        self.assertIn(["enable", self.spec["unit_name"]], self.calls)
        self.assertIn(["start", self.spec["unit_name"]], self.calls)
        self.assertIn(["/usr/bin/loginctl", "enable-linger"], self.calls, "asks to keep running while logged out")
        self.assertEqual({k: value[k] for k in ("supported", "on", "starts_at_login", "restarts_after_failure", "while_logged_out")},
                         {"supported": True, "on": True, "starts_at_login": True, "restarts_after_failure": True, "while_logged_out": True})
        self.assertIn("also keeps running while you are logged out", pip_cli.keep_running_text(value))

    def test_on_restarts_a_verified_older_live_runner(self):
        old_source = self.home.parent / "old-release"
        (old_source / "dgc").mkdir(parents=True)
        (old_source / "dgc" / "__init__.py").write_text('')
        (old_source / "dgc" / "cli.py").write_text('')
        old = service.preview(self.home, package_root=old_source, **self.options)
        self.unit.parent.mkdir()
        self.unit.write_text(old["content"])
        self.unit.chmod(0o600)
        self.active, self.enabled = "active", "enabled"
        keep.set_on(True, runner_online=True, dgc_home=self.home, **self.options)
        self.assertEqual(self.unit.read_text(), self.spec["content"])
        self.assertIn(["restart", self.spec["unit_name"]], self.calls)

    def registry_file(self, *, busy):
        """The previous install's registry, a schema behind this install's, as an update finds it."""
        import sqlite3
        from dgc.workspace_registry import SCHEMA_VERSION
        directory = self.home.parent / "state"
        directory.mkdir(exist_ok=True)
        path = directory / "registry.sqlite3"
        path.unlink(missing_ok=True)
        db = sqlite3.connect(path)
        db.execute("CREATE TABLE pip_runs(id TEXT PRIMARY KEY, status TEXT NOT NULL)")
        db.execute("INSERT INTO pip_runs VALUES('run_old','succeeded')")
        if busy:
            db.execute("INSERT INTO pip_runs VALUES('run_now','running')")
        db.execute(f"PRAGMA user_version={SCHEMA_VERSION - 1}")
        db.commit(); db.close()
        return directory, SCHEMA_VERSION - 1

    def user_version(self, directory):
        import sqlite3
        db = sqlite3.connect(directory / "registry.sqlite3")
        try:
            return db.execute("PRAGMA user_version").fetchone()[0]
        finally:
            db.close()

    @contextlib.contextmanager
    def updating(self, status, directory):
        config = self.home.parent / "config"
        unit = config / "systemd" / "user" / self.spec["unit_name"]          # the outdated unit, as installed
        unit.parent.mkdir(parents=True, exist_ok=True)
        unit.write_text("# an earlier install's unit\n")
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(config)}), \
             patch.object(keep.wsl, "version", return_value=None), patch.object(keep, "_has_systemd", return_value=True), \
             patch.object(keep, "_home", return_value=self.home), patch.object(service, "status", return_value=status), \
             patch("dgc.workspace_registry.state_directory", return_value=directory), \
             patch("dgc.workspace_registry.WorkspaceRegistry", side_effect=AssertionError("opening it migrates it")), \
             patch.object(service, "install", return_value={"changed": True}) as install, \
             patch.object(service, "restart") as restart:
            yield install, restart

    def test_install_reconcile_never_migrates_and_moves_a_busy_runners_unit_without_restarting_it(self):
        status = {"installed": True, "outdated": True, "enabled_state": "enabled", "active_state": "active"}
        directory, before = self.registry_file(busy=True)
        with self.updating(status, directory) as (install, restart):
            said = keep.upgrade_after_install()
            self.assertEqual(said, keep.BUSY_NOTE)
            # The unit names this install now: whenever systemd starts the runner again, it starts this one.
            install.assert_called_once_with(self.home, upgrade=True)
            restart.assert_not_called()
        self.assertEqual(self.user_version(directory), before, "the old runner's database is left as it was")
        self.registry_file(busy=False)
        with self.updating(status, directory) as (install, restart):
            self.assertEqual(keep.upgrade_after_install(), keep.UPDATED_NOTE)
            install.assert_called_once_with(self.home, upgrade=True)
            restart.assert_called_once_with(self.home)
        self.assertEqual(self.user_version(directory), before)

    def test_install_reconcile_recovers_old_runner_in_restart_loop(self):
        status = {"installed": True, "outdated": True, "enabled_state": "enabled", "active_state": "activating"}
        directory, _ = self.registry_file(busy=False)
        with self.updating(status, directory) as (install, restart):
            self.assertIn("Updated", keep.upgrade_after_install())
            restart.assert_called_once_with(self.home)
            restart.reset_mock()
            status["active_state"] = "inactive"
            self.assertIn("Updated", keep.upgrade_after_install())
            restart.assert_not_called()

    def test_install_reconcile_counts_a_registry_it_cannot_read_as_busy(self):
        status = {"installed": True, "outdated": True, "enabled_state": "enabled", "active_state": "active"}
        directory = self.home.parent / "state"
        directory.mkdir()
        (directory / "registry.sqlite3").write_bytes(b"not a database")
        with self.updating(status, directory) as (_, restart):
            self.assertEqual(keep.upgrade_after_install(), keep.BUSY_NOTE)
            restart.assert_not_called()

    def test_install_refresh_says_nothing_to_someone_who_never_turned_it_on(self):
        (self.home / ".dgc").mkdir(mode=0o755)          # not owner-only: only writing a unit would need that
        config = self.home.parent / "config"
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(config)}), \
             patch.object(keep.wsl, "version", return_value=None), patch.object(keep, "_has_systemd", return_value=True), \
             patch.object(keep, "_home", return_value=self.home):
            self.assertEqual(keep.upgrade_after_install(), "")
            self.assertEqual(self.calls, [])
            unit = service.unit_file(self.home)
            self.assertEqual(unit, config / "systemd" / "user" / self.spec["unit_name"])
            unit.parent.mkdir(parents=True)
            unit.write_text(self.spec["content"]); unit.chmod(0o600)
            with self.assertRaisesRegex(RegistryError, "owner-only"):
                keep.upgrade_after_install()            # one that is there is still checked

    def test_a_runner_already_running_is_not_started_twice(self):
        keep.set_on(True, runner_online=True, dgc_home=self.home, **self.options)
        self.assertNotIn(["start", self.spec["unit_name"]], self.calls)
        self.assertIn(["enable", self.spec["unit_name"]], self.calls, "it still starts at the next login")

    def test_where_lingering_is_not_allowed_it_says_it_runs_while_you_are_logged_in(self):
        def refuse(argv, check=True):
            self.calls.append(argv)
            return Done(1) if "enable-linger" in argv else Done(out=b"no\n")
        with patch.object(keep, "_run", side_effect=refuse):
            value = keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        self.assertTrue(value["on"])
        self.assertFalse(value["while_logged_out"])
        self.assertIn("runs while you are logged in", pip_cli.keep_running_text(value))

    def test_off_stops_it_starting_on_its_own_but_never_stops_the_runner(self):
        keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        value = keep.set_on(False, runner_online=True, dgc_home=self.home, **self.options)
        self.assertFalse(value["on"])
        self.assertEqual(self.enabled, "disabled")
        self.assertEqual(self.active, "active", "a run in progress is never cut off by a settings change")
        self.assertIn("off", pip_cli.keep_running_text(value))

    def test_an_earlier_dgc_unit_can_still_be_read_and_turned_off(self):
        # Someone who installed the service before this format: the switch must still show and work.
        self.unit.parent.mkdir(parents=True)
        old = self.spec["content"].replace("format 2", "format 1").replace("Restart=on-failure\nRestartSec=30\n", "Restart=no\n")
        self.unit.write_text(old); self.unit.chmod(0o600)
        self.enabled = "enabled"
        self.assertTrue(keep.status(dgc_home=self.home, **self.options)["on"])
        self.assertFalse(keep.set_on(False, runner_online=True, dgc_home=self.home, **self.options)["on"])
        self.assertEqual(service.status(self.home, **self.options)["installed"], True)

    def test_lingering_this_switch_turned_on_is_turned_off_with_it_and_only_that(self):
        keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        keep.set_on(False, runner_online=True, dgc_home=self.home, **self.options)
        self.assertIn(["/usr/bin/loginctl", "disable-linger"], self.calls)
        self.calls.clear()
        self.linger = "yes"                       # lingering the user set up themselves
        keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        keep.set_on(False, runner_online=True, dgc_home=self.home, **self.options)
        self.assertNotIn(["/usr/bin/loginctl", "disable-linger"], self.calls, "theirs stays")

    def test_an_earlier_dgc_unit_is_upgraded_and_a_foreign_one_is_never_overwritten(self):
        self.unit.parent.mkdir(parents=True)
        old = self.spec["content"].replace("format 2", "format 1").replace("Restart=on-failure\nRestartSec=30\n", "Restart=no\n")
        self.unit.write_text(old); self.unit.chmod(0o600)
        keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        self.assertEqual(self.unit.read_text(), self.spec["content"], "our own earlier unit is replaced")
        foreign = self.spec["content"].replace("TimeoutStopSec=90", "TimeoutStopSec=5")
        self.unit.write_text(foreign)
        with self.assertRaises(RegistryError) as raised:
            keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        self.assertEqual(raised.exception.code, "service_conflict")
        self.assertEqual(self.unit.read_text(), foreign, "a unit someone edited is left alone")

    def test_on_and_off_only_take_a_real_choice(self):
        for bad in ("on", 1, None):
            with self.assertRaises(RegistryError):
                keep.set_on(bad, runner_online=False, dgc_home=self.home, **self.options)


class MacSwitchTests(unittest.TestCase):
    """The LaunchAgent logic, with a fake launchctl; the live test runs it on a real Mac."""

    def setUp(self):
        trust_host_python(self)
        temp = tempfile.TemporaryDirectory(prefix="dgc-keep-mac-")
        self.addCleanup(temp.cleanup)
        base = Path(temp.name)
        self.home = base / "home"; self.home.mkdir(mode=0o700)
        # This Python by its folder's link-free spelling, as DGC's installer gives it (install.sh resolves the folder):
        # the agent refuses a link on the way to its interpreter, and a test run's own Python can sit under one (on
        # the Mac Studio, a venv in /tmp, which is a link to /private/tmp, failed all five tests here).
        python = Path(os.path.realpath(os.path.dirname(sys.executable))) / os.path.basename(sys.executable)
        self.options = {"agent_directory": base / "LaunchAgents", "python_executable": python}
        self.loaded, self.disabled, self.calls = False, False, []
        for target, value in (("platform", "darwin"),):
            p = patch.object(sys, target, value); p.start(); self.addCleanup(p.stop)
        p = patch.object(keep, "_run", side_effect=self.launchctl); p.start(); self.addCleanup(p.stop)
        self.spec = keep._agent_spec(self.home.resolve(), **self.options)

    def launchctl(self, argv, check=True):
        self.calls.append(argv[1:])
        verb = argv[1]
        if verb == "print":
            return Done(0 if self.loaded else 113)
        if verb == "print-disabled":
            return Done(out=(f'\t"{self.spec["label"]}" => {"disabled" if self.disabled else "enabled"}\n').encode())
        if verb == "bootstrap":
            self.loaded = True
        if verb == "bootout":
            self.loaded = False
        if verb == "enable":
            self.disabled = False
        if verb == "disable":
            self.disabled = True
        return Done()

    def test_on_writes_an_agent_that_restarts_only_on_failure_and_loads_it(self):
        value = keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        agent = plistlib.loads(self.spec["path"].read_bytes())
        self.assertEqual(agent["ProgramArguments"][-3:], ["pips", "serve", "--service"])
        self.assertEqual(agent["KeepAlive"], {"SuccessfulExit": False})
        self.assertTrue(agent["RunAtLoad"])
        self.assertEqual(agent["EnvironmentVariables"]["DGC_HOME"], str(self.home.resolve()))
        self.assertEqual(self.spec["path"].stat().st_mode & 0o777, 0o644, "launchd refuses a group-writable agent")
        self.assertIn(["bootstrap", f"gui/{os.getuid()}", str(self.spec["path"])], self.calls)
        self.assertEqual((value["on"], value["starts_at_login"], value["while_logged_out"]), (True, True, False))
        self.assertNotIn("logged out", pip_cli.keep_running_text(value))

    def test_turning_it_on_again_never_restarts_the_runner_launchd_started(self):
        keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        self.calls.clear()
        keep.set_on(True, runner_online=True, dgc_home=self.home, **self.options)
        self.assertFalse([c for c in self.calls if c[0] in ("bootout", "bootstrap", "kickstart")], self.calls)
        keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        self.assertIn("kickstart", [c[0] for c in self.calls], "a stopped runner is started again")

    def test_exact_old_agent_is_refreshed_and_live_runner_reloaded(self):
        source = self.home.parent / "old-release"
        (source / "dgc").mkdir(parents=True)
        (source / "dgc" / "__init__.py").write_text('')
        (source / "dgc" / "cli.py").write_text('')
        old = keep._agent_spec(self.home.resolve(), package_root=source, **self.options)
        self.spec["path"].parent.mkdir()
        self.spec["path"].write_bytes(old["content"])
        self.spec["path"].chmod(0o644)
        self.loaded = True
        self.assertTrue(keep._mac_status(self.spec)["outdated"])
        keep.set_on(True, runner_online=True, dgc_home=self.home, **self.options)
        self.assertEqual(self.spec["path"].read_bytes(), self.spec["content"])
        self.assertFalse(keep._mac_status(self.spec)["outdated"])
        self.assertIn("bootout", [c[0] for c in self.calls])
        self.assertIn("bootstrap", [c[0] for c in self.calls])

    def test_a_changed_agent_is_never_overwritten_or_removed(self):
        keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        changed = self.spec["content"].replace(b"ThrottleInterval", b"ThrottleIntervaX")
        self.spec["path"].write_bytes(changed)
        self.calls.clear()
        with self.assertRaisesRegex(RegistryError, "differs"):
            keep.set_on(True, runner_online=True, dgc_home=self.home, **self.options)
        with self.assertRaisesRegex(RegistryError, "differs"):
            keep.set_on(False, runner_online=True, dgc_home=self.home, **self.options)
        self.assertEqual(self.spec["path"].read_bytes(), changed)
        self.assertEqual([c[0] for c in self.calls if c[0] in ("bootout", "bootstrap")], [])

    def test_pruned_previous_release_agent_refreshes_only_when_exact(self):
        source = self.home.parent / "old-release"
        (source / "dgc").mkdir(parents=True)
        (source / "dgc" / "__init__.py").write_text('')
        (source / "dgc" / "cli.py").write_text('')
        old = keep._agent_spec(self.home.resolve(), package_root=source, **self.options)
        self.spec["path"].parent.mkdir()
        self.spec["path"].write_bytes(old["content"])
        self.spec["path"].chmod(0o644)
        (source / "dgc" / "cli.py").unlink()
        (source / "dgc" / "__init__.py").unlink()
        (source / "dgc").rmdir()
        source.rmdir()
        self.loaded = True
        self.assertTrue(keep._mac_status(self.spec)["outdated"])
        keep.set_on(True, runner_online=True, dgc_home=self.home, **self.options)
        self.assertEqual(self.spec["path"].read_bytes(), self.spec["content"])

    def test_edited_pruned_previous_release_agent_is_rejected(self):
        source = self.home.parent / "old-release"
        (source / "dgc").mkdir(parents=True)
        (source / "dgc" / "__init__.py").write_text('')
        (source / "dgc" / "cli.py").write_text('')
        old = keep._agent_spec(self.home.resolve(), package_root=source, **self.options)
        self.spec["path"].parent.mkdir()
        self.spec["path"].write_bytes(old["content"].replace(b"ThrottleInterval", b"ThrottleIntervaX"))
        self.spec["path"].chmod(0o644)
        (source / "dgc" / "cli.py").unlink()
        (source / "dgc" / "__init__.py").unlink()
        (source / "dgc").rmdir()
        source.rmdir()
        with self.assertRaisesRegex(RegistryError, "differs"):
            keep.set_on(True, runner_online=True, dgc_home=self.home, **self.options)

    def test_an_agent_whose_interpreter_vanished_is_still_refreshed_and_turned_off(self):
        for pruned in (False, True):
            with self.subTest(pruned=pruned):
                base = self.home.parent
                source = base / f"old-release-{pruned}"
                (source / "dgc").mkdir(parents=True)
                (source / "dgc" / "__init__.py").write_text('')
                (source / "dgc" / "cli.py").write_text('')
                real = base / f"brew-python-{pruned}" / "python3.12"
                real.parent.mkdir()
                real.write_text("#!/bin/sh\n")
                real.chmod(0o755)
                link = base / f"old-venv-{pruned}" / "bin" / "python3"
                link.parent.mkdir(parents=True)
                link.symlink_to(real)
                old = keep._agent_spec(self.home.resolve(), agent_directory=self.options["agent_directory"],
                                       python_executable=link, package_root=source)
                self.spec["path"].parent.mkdir(exist_ok=True)
                self.spec["path"].write_bytes(old["content"])
                self.spec["path"].chmod(0o644)
                real.unlink()                          # Homebrew's python@3.12 was uninstalled
                if pruned:
                    import shutil
                    shutil.rmtree(source)
                self.loaded = True
                self.assertTrue(keep._mac_status(self.spec)["outdated"])
                keep.set_on(False, runner_online=False, dgc_home=self.home, **self.options)
                self.assertFalse(self.spec["path"].exists())
                self.spec["path"].write_bytes(old["content"])
                self.spec["path"].chmod(0o644)
                keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
                self.assertEqual(self.spec["path"].read_bytes(), self.spec["content"])

    def test_install_reconcile_leaves_a_busy_runners_agent_and_database_alone(self):
        import sqlite3
        from dgc.workspace_registry import SCHEMA_VERSION
        source = self.home.parent / "old-release"
        (source / "dgc").mkdir(parents=True)
        (source / "dgc" / "__init__.py").write_text('')
        (source / "dgc" / "cli.py").write_text('')
        old = keep._agent_spec(self.home.resolve(), package_root=source, **self.options)
        self.spec["path"].parent.mkdir()
        self.spec["path"].write_bytes(old["content"])
        self.spec["path"].chmod(0o644)
        self.loaded = True
        directory = self.home.parent / "state"
        directory.mkdir()
        db = sqlite3.connect(directory / "registry.sqlite3")
        db.execute("CREATE TABLE pip_runs(id TEXT PRIMARY KEY, status TEXT NOT NULL)")
        db.execute("INSERT INTO pip_runs VALUES('run_now','queued')")
        db.execute(f"PRAGMA user_version={SCHEMA_VERSION - 1}")
        db.commit(); db.close()
        with patch.object(keep, "_home", return_value=self.home.resolve()), \
             patch.object(keep, "_agent_file", return_value=self.spec["path"], create=True), \
             patch.object(keep, "_agent_spec", side_effect=lambda home, _real=keep._agent_spec, **kw:
                          _real(home, **{**self.options, **kw})), \
             patch("dgc.workspace_registry.state_directory", return_value=directory), \
             patch("dgc.workspace_registry.WorkspaceRegistry", side_effect=AssertionError("opening it migrates it")):
            self.assertEqual(keep.upgrade_after_install(), keep.BUSY_NOTE)
            self.assertEqual(self.spec["path"].read_bytes(), old["content"])
            self.assertNotIn("bootout", [c[0] for c in self.calls])
            db = sqlite3.connect(directory / "registry.sqlite3")
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION - 1)
            db.execute("UPDATE pip_runs SET status='succeeded'"); db.commit(); db.close()
            self.assertEqual(keep.upgrade_after_install(), keep.UPDATED_NOTE)
        self.assertEqual(self.spec["path"].read_bytes(), self.spec["content"])
        self.assertIn("bootstrap", [c[0] for c in self.calls])

    def test_a_link_at_the_agent_path_is_never_followed(self):
        self.spec["path"].parent.mkdir(parents=True)
        target = self.spec["path"].parent / "unrelated.plist"
        target.write_bytes(b"keep me")
        self.spec["path"].symlink_to(target)
        with self.assertRaisesRegex(RegistryError, "safely"):
            keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        self.assertEqual(target.read_bytes(), b"keep me")

    def test_on_again_after_off_never_unloads_the_running_runner(self):
        keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        keep.set_on(False, runner_online=True, dgc_home=self.home, **self.options)
        self.calls.clear()
        value = keep.set_on(True, runner_online=True, dgc_home=self.home, **self.options)
        self.assertNotIn("bootout", [c[0] for c in self.calls], "off left the job loaded; on again must not unload it")
        self.assertTrue(value["on"])
        self.assertEqual(self.spec["path"].read_bytes(), self.spec["content"])

    def test_off_removes_the_agent_and_never_stops_the_runner(self):
        keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        value = keep.set_on(False, runner_online=True, dgc_home=self.home, **self.options)
        self.assertFalse(self.spec["path"].exists())
        self.assertNotIn("bootout", [c[0] for c in self.calls])
        self.assertFalse(value["on"])


class ElsewhereTests(unittest.TestCase):
    def test_other_platforms_say_it_is_not_available(self):
        with patch.object(sys, "platform", "win32"):
            value = keep.status()
            self.assertFalse(value["supported"])
            self.assertIn("Linux and macOS", value["reason"])
            with self.assertRaises(RegistryError) as raised:
                keep.set_on(True, runner_online=False)
            self.assertEqual(raised.exception.code, "service_unsupported")


class ServiceModeServeTests(unittest.TestCase):
    """`serve --service` exits 0 when there is nothing to run, so a service never restart-loops."""

    def run_serve(self, *extra, error):
        out, err = io.StringIO(), io.StringIO()
        with patch("dgc.pip_daemon.serve", side_effect=RegistryError(error, "x")), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            return pip_cli.handle_command(type("C", (), {"get": lambda *a: None, "set": lambda *a, **k: None})(), ["serve", *extra])

    def test_expected_states_exit_cleanly_only_in_service_mode(self):
        for error in ("runner_running", "disabled", "runtime_paused"):
            with self.subTest(error=error):
                self.assertEqual(self.run_serve("--service", error=error), 0)
                self.assertNotEqual(self.run_serve(error=error), 0, "a person at a terminal sees the error")
        self.assertNotEqual(self.run_serve("--service", error="database_corrupt"), 0, "a real failure restarts")


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(sys.platform.startswith("linux"), "POSIX ownership")
class ServicePathTests(unittest.TestCase):
    """~/.config is often 775 under Ubuntu's private groups; only a group of one is accepted."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-keep-path-", dir=os.path.expanduser("~"))
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name) / "config"
        self.dir.mkdir()
        os.chown(self.dir, os.getuid(), os.getgid())

    def test_group_writable_is_accepted_only_when_the_group_is_just_you(self):
        import grp
        import pwd
        os.chmod(self.dir, 0o775)
        me = pwd.getpwuid(os.getuid())
        alone = grp.struct_group((me.pw_name, "x", me.pw_gid, []))
        shared = grp.struct_group((me.pw_name, "x", me.pw_gid, ["someone-else"]))
        with patch("grp.getgrgid", return_value=alone), patch("pwd.getpwall", return_value=[me]):
            service._safe_chain(self.dir)                       # a private group: accepted
        with patch("grp.getgrgid", return_value=shared), patch("pwd.getpwall", return_value=[me]):
            with self.assertRaises(RegistryError):
                service._safe_chain(self.dir)
        other = pwd.struct_passwd(("other", "x", me.pw_uid + 1, me.pw_gid, "", "/", "/bin/sh"))
        with patch("grp.getgrgid", return_value=alone), patch("pwd.getpwall", return_value=[me, other]):
            with self.assertRaises(RegistryError, msg="another account whose primary group it is"):
                service._safe_chain(self.dir)

    def test_world_writable_is_always_refused(self):
        os.chmod(self.dir, 0o777)
        with self.assertRaises(RegistryError):
            service._safe_chain(self.dir)


class CommandLineTests(unittest.TestCase):
    """`dgc pips keep-running` goes through the same local control as the Pips view."""
    from tests import test_pips_local as _fixtures
    setUp_base = _fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True

    def cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = pip_cli.handle_command(self.cfg, list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_show_and_turn_on(self):
        state = {"platform": "linux", "supported": True, "reason": "", "on": False, "starts_at_login": False,
                 "restarts_after_failure": False, "while_logged_out": False}
        with patch.object(keep, "status", return_value=state):
            code, text, err = self.cli("keep-running")
        self.assertEqual(code, 0, err)
        self.assertIn("Keep Pips running: off", text)
        on = {**state, "on": True, "starts_at_login": True, "restarts_after_failure": True}
        with patch.object(keep, "set_on", return_value=on) as switch:
            code, text, err = self.cli("keep-running", "on")
        self.assertEqual(code, 0, err)
        self.assertIs(switch.call_args.args[0], True)
        self.assertIn("runs while you are logged in", text)
