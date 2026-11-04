"""Deterministic service lifecycle tests. No network, sleeping, or user-unit writes."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from dgc import pip_service as service
from dgc.workspace_registry import RegistryError
from tests.host_python import trust_host_python


@unittest.skipUnless(sys.platform == "linux", "Linux user-systemd service lifecycle")
class ServiceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-service-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.home = self.base / "home"
        self.home.mkdir(mode=0o700)
        self.units = self.base / "units"
        self.options = {"unit_directory": self.units}
        trust_host_python(self)
        self.spec = service.preview(self.home, **self.options)
        self.file = Path(self.spec["unit_path"])
        self.active = "inactive"
        self.enabled = "disabled"
        self.calls = []
        self.manager = patch.object(service, "_systemctl", side_effect=self.systemctl)
        self.manager.start()
        self.addCleanup(self.manager.stop)

    def systemctl(self, args):
        self.calls.append(args)
        if args[0] == "show":
            return "\n".join(f"{key}={value}" for key, value in {
                "Id": self.spec["unit_name"], "LoadState": "loaded", "ActiveState": self.active,
                "SubState": "running" if self.active == "active" else "dead",
                "UnitFileState": self.enabled, "FragmentPath": str(self.file), "DropInPaths": ""}.items())
        if args[0] == "start": self.active = "active"
        if args[0] == "stop": self.active = "inactive"
        if args[0] == "enable": self.enabled = "enabled"
        if args[0] == "disable": self.enabled = "disabled"
        return ""

    def assertCode(self, code, fn, *args, **kw):
        with self.assertRaises(RegistryError) as caught:
            fn(*args, **kw)
        self.assertEqual(caught.exception.code, code)

    def install(self):
        return service.install(self.home, **self.options)

    def test_preview_and_uninstalled_status_are_read_only(self):
        before = list(self.base.rglob("*"))
        value = service.status(self.home, **self.options)
        self.assertFalse(value["installed"])
        self.assertEqual(before, list(self.base.rglob("*")))
        self.assertEqual(self.calls, [])
        self.assertNotIn("--enable", self.spec["argv"])
        self.assertEqual(self.spec["argv"][-3:], ["pips", "serve", "--service"])
        # Restarted after a failure; `serve --service` exits 0 when Pips are off, stopped or already
        # running, so those never loop (pip_keep_running).
        self.assertIn("Restart=on-failure\nRestartSec=30\n", self.spec["content"])
        self.assertTrue(self.spec["content"].startswith("# DGC Pips managed user service, format 2\n"))
        self.assertIn("KillMode=mixed\n", self.spec["content"])

    def test_scoped_name_stable_and_canonical(self):
        self.assertEqual(self.spec["unit_name"], service.preview(str(self.home) + "/", **self.options)["unit_name"])
        self.assertEqual(self.spec["unit_name"], service.preview("/" + str(self.home), **self.options)["unit_name"])
        other = self.base / "other"; other.mkdir()
        self.assertNotEqual(self.spec["unit_name"], service.preview(other, **self.options)["unit_name"])

    def test_install_only_writes_scoped_owner_unit_never_starts_or_enables(self):
        self.assertTrue(self.install()["changed"])
        self.assertEqual(self.calls, [["daemon-reload"]])
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.file.read_text(), self.spec["content"])
        before = self.file.stat().st_mtime_ns
        self.assertFalse(self.install()["changed"])
        self.assertEqual(self.file.stat().st_mtime_ns, before)
        self.assertFalse((self.home / ".dgc").exists())

    def test_exact_previous_release_unit_can_be_upgraded_and_restarted(self):
        old_source = self.base / "old-release"
        (old_source / "dgc").mkdir(parents=True)
        (old_source / "dgc" / "__init__.py").write_text('__version__ = "0.48.0"\n')
        (old_source / "dgc" / "cli.py").write_text('')
        old = service.preview(self.home, package_root=old_source, **self.options)
        self.units.mkdir()
        self.file.write_text(old["content"])
        self.file.chmod(0o600)
        self.active = "active"
        self.enabled = "enabled"
        self.assertTrue(service.status(self.home, **self.options)["outdated"])
        self.assertCode("service_conflict", service.install, self.home, **self.options)
        self.assertTrue(service.install(self.home, upgrade=True, **self.options)["changed"])
        self.assertEqual(self.file.read_text(), self.spec["content"])
        self.assertFalse(service.status(self.home, **self.options)["outdated"])
        service.restart(self.home, **self.options)
        self.assertIn(["restart", self.spec["unit_name"]], self.calls)

    def test_edited_previous_release_unit_is_never_upgraded(self):
        old_source = self.base / "old-release"
        (old_source / "dgc").mkdir(parents=True)
        (old_source / "dgc" / "__init__.py").write_text('')
        (old_source / "dgc" / "cli.py").write_text('')
        old = service.preview(self.home, package_root=old_source, **self.options)
        self.units.mkdir()
        self.file.write_text(old["content"] + "# changed\n")
        self.file.chmod(0o600)
        self.assertCode("service_conflict", service.install, self.home, upgrade=True, **self.options)
        self.assertIn("# changed", self.file.read_text())

    def test_pruned_previous_release_unit_is_still_exactly_verified_for_upgrade(self):
        old_source = self.base / "old-release"
        (old_source / "dgc").mkdir(parents=True)
        (old_source / "dgc" / "__init__.py").write_text('')
        (old_source / "dgc" / "cli.py").write_text('')
        old = service.preview(self.home, package_root=old_source, **self.options)
        self.units.mkdir()
        self.file.write_text(old["content"])
        self.file.chmod(0o600)
        (old_source / "dgc" / "cli.py").unlink()
        (old_source / "dgc" / "__init__.py").unlink()
        (old_source / "dgc").rmdir()
        old_source.rmdir()
        self.active, self.enabled = "active", "enabled"
        self.assertTrue(service.status(self.home, **self.options)["outdated"])
        self.assertTrue(service.install(self.home, upgrade=True, **self.options)["changed"])
        self.assertEqual(self.file.read_text(), self.spec["content"])

    def test_edited_pruned_release_unit_remains_a_conflict(self):
        old_source = self.base / "old-release"
        (old_source / "dgc").mkdir(parents=True)
        (old_source / "dgc" / "__init__.py").write_text('')
        (old_source / "dgc" / "cli.py").write_text('')
        old = service.preview(self.home, package_root=old_source, **self.options)
        self.units.mkdir()
        self.file.write_text(old["content"].replace("RestartSec=30", "RestartSec=1"))
        self.file.chmod(0o600)
        (old_source / "dgc" / "cli.py").unlink()
        (old_source / "dgc" / "__init__.py").unlink()
        (old_source / "dgc").rmdir()
        old_source.rmdir()
        self.assertCode("service_conflict", service.install, self.home, upgrade=True, **self.options)
        self.assertIn("RestartSec=1", self.file.read_text())

    def _unit_whose_interpreter_vanishes(self, *, pruned):
        # An earlier install's venv interpreter is a link to the system Python; an OS upgrade then removes it.
        old_source = self.base / "old-release"
        (old_source / "dgc").mkdir(parents=True)
        (old_source / "dgc" / "__init__.py").write_text('')
        (old_source / "dgc" / "cli.py").write_text('')
        real = self.base / "system-python" / "python3.12"
        real.parent.mkdir()
        real.write_text("#!/bin/sh\n")
        real.chmod(0o755)
        link = self.base / "old-venv" / "bin" / "python3"
        link.parent.mkdir(parents=True)
        link.symlink_to(real)
        old = service.preview(self.home, python_executable=link, package_root=old_source, **self.options)
        self.units.mkdir()
        self.file.write_text(old["content"])
        self.file.chmod(0o600)
        real.unlink()
        if pruned:
            for item in (old_source / "dgc" / "cli.py", old_source / "dgc" / "__init__.py"):
                item.unlink()
            (old_source / "dgc").rmdir()
            old_source.rmdir()
        self.active, self.enabled = "failed", "enabled"

    def _vanished_interpreter_unit_is_refreshed_and_turned_off(self, pruned):
        self._unit_whose_interpreter_vanishes(pruned=pruned)
        self.assertTrue(service.status(self.home, **self.options)["outdated"])
        service.disable(self.home, **self.options)
        self.assertIn(["disable", self.spec["unit_name"]], self.calls)
        self.assertTrue(service.install(self.home, upgrade=True, **self.options)["changed"])
        self.assertEqual(self.file.read_text(), self.spec["content"])

    def test_a_unit_whose_interpreter_vanished_is_still_ours_to_refresh_and_turn_off(self):
        self._vanished_interpreter_unit_is_refreshed_and_turned_off(pruned=False)

    def test_a_pruned_unit_whose_interpreter_vanished_is_still_ours_to_refresh_and_turn_off(self):
        self._vanished_interpreter_unit_is_refreshed_and_turned_off(pruned=True)

    def test_an_edited_unit_whose_interpreter_vanished_is_still_a_conflict(self):
        self._unit_whose_interpreter_vanishes(pruned=True)
        self.file.write_text(self.file.read_text().replace("RestartSec=30", "RestartSec=1"))
        self.assertCode("service_conflict", service.install, self.home, upgrade=True, **self.options)
        self.assertCode("service_conflict", service.disable, self.home, **self.options)

    def test_failed_replacement_keeps_previous_service_unit(self):
        old_source = self.base / "old-release"
        (old_source / "dgc").mkdir(parents=True)
        (old_source / "dgc" / "__init__.py").write_text('')
        (old_source / "dgc" / "cli.py").write_text('')
        old = service.preview(self.home, package_root=old_source, **self.options)
        self.units.mkdir()
        self.file.write_text(old["content"])
        self.file.chmod(0o600)
        with patch.object(service.os, "replace", side_effect=OSError("disk unavailable")):
            self.assertCode("service_write_failed", service.install, self.home, upgrade=True, **self.options)
        self.assertEqual(self.file.read_text(), old["content"])

    def test_previous_server_variant_stays_server_on_upgrade(self):
        old_source = self.base / "old-release"
        (old_source / "dgc").mkdir(parents=True)
        (old_source / "dgc" / "__init__.py").write_text('')
        (old_source / "dgc" / "cli.py").write_text('')
        old = service.preview(self.home, package_root=old_source, server=True, **self.options)
        expected = service.preview(self.home, server=True, **self.options)
        self.units.mkdir()
        self.file.write_text(old["content"])
        self.file.chmod(0o600)
        self.assertTrue(service.status(self.home, **self.options)["server"])
        service.install(self.home, upgrade=True, **self.options)
        self.assertEqual(self.file.read_text(), expected["content"])

    def test_publication_failure_leaves_no_partial_unit_or_temp_file(self):
        with patch.object(service.os, "fsync", side_effect=OSError("disk unavailable")):
            self.assertCode("service_write_failed", service.install, self.home, **self.options)
        self.assertFalse(self.file.exists())
        self.assertEqual(list(self.units.iterdir()), [])
        self.assertEqual(self.calls, [])

    def test_publication_race_does_not_replace_foreign_unit(self):
        real_link = os.link
        def competing_link(source, destination, **kwargs):
            Path(destination).write_text("foreign unit")
            return real_link(source, destination, **kwargs)
        with patch.object(service.os, "link", side_effect=competing_link):
            self.assertCode("service_conflict", service.install, self.home, **self.options)
        self.assertEqual(self.file.read_text(), "foreign unit")
        self.assertEqual(list(self.units.iterdir()), [self.file])
        self.assertEqual(self.calls, [])

    def test_start_stop_enable_disable_are_distinct_scoped_operations(self):
        self.install()
        self.assertEqual(service.enable(self.home, **self.options)["enabled_state"], "enabled")
        self.assertEqual(self.active, "inactive")
        self.assertEqual(service.start(self.home, **self.options)["active_state"], "active")
        service.disable(self.home, **self.options)
        self.assertEqual(self.active, "active")
        self.assertEqual(self.enabled, "disabled")
        service.stop(self.home, **self.options)
        self.assertEqual(self.active, "inactive")
        self.assertFalse((self.home / ".dgc").exists())
        for call in self.calls:
            if call[0] not in ("show", "daemon-reload"):
                self.assertEqual(call[1:], [self.spec["unit_name"]])

    def test_uninstall_requires_explicit_stop_and_removes_only_exact_unit(self):
        self.install()
        other = self.units / "other.service"; other.write_text("owned elsewhere")
        self.active = "active"
        self.assertCode("service_running", service.uninstall, self.home, **self.options)
        self.assertTrue(self.file.exists())
        service.stop(self.home, **self.options)
        self.assertFalse(service.uninstall(self.home, **self.options)["installed"])
        self.assertEqual(other.read_text(), "owned elsewhere")

    def test_changed_unit_and_overrides_are_not_controlled_or_overwritten(self):
        self.install()
        self.file.write_text(self.spec["content"] + "# edited\n")
        self.calls.clear()
        for fn in (service.install, service.start, service.stop, service.uninstall):
            self.assertCode("service_conflict", fn, self.home, **self.options)
        self.assertEqual(self.calls, [])
        self.file.write_text(self.spec["content"])
        self.file.with_name(self.file.name + ".d").mkdir()
        self.assertCode("service_conflict", service.start, self.home, **self.options)

    def test_loaded_foreign_path_override_or_alias_refuses_mutation(self):
        self.install()
        valid = self.systemctl(["show"])
        for text in (valid.replace(str(self.file), "/etc/systemd/user/foreign.service"),
                     valid.replace("DropInPaths=", "DropInPaths=/etc/override.conf"),
                     valid.replace("Id=" + self.spec["unit_name"], "Id=foreign.service"),
                     valid.replace("LoadState=loaded", "LoadState=masked")):
            self.calls.clear()
            with patch.object(service, "_systemctl", return_value=text) as manager:
                self.assertCode("service_conflict", service.start, self.home, **self.options)
                self.assertEqual(manager.call_count, 1)

    def test_malformed_manager_properties_refuse_mutation(self):
        self.install()
        valid = self.systemctl(["show"])
        for text in ("", "anything", valid + "\nId=duplicate", valid + "\nSecret=value"):
            with patch.object(service, "_systemctl", return_value=text):
                self.assertCode("service_manager_invalid", service.start, self.home, **self.options)

    def test_config_and_secret_files_must_be_private_not_repaired(self):
        state = self.home / ".dgc"; state.mkdir(mode=0o755)
        self.assertCode("unsafe_service_state", service.preview, self.home, **self.options)
        self.assertEqual(state.stat().st_mode & 0o777, 0o755)
        state.chmod(0o700)
        config = state / "config.json"; config.write_text("{}"); config.chmod(0o644)
        self.assertCode("unsafe_service_state", service.preview, self.home, **self.options)
        config.chmod(0o600)
        self.assertEqual(service.preview(self.home, **self.options)["unit_name"], self.spec["unit_name"])
        config.unlink(); config.symlink_to(self.base / "outside")
        self.assertCode("unsafe_service_state", service.preview, self.home, **self.options)

    def test_empty_private_home_never_enabled_or_unpaused(self):
        state = self.home / ".dgc"; state.mkdir(mode=0o700)
        cfg = state / "config.json"
        cfg.write_text('{"pips_enabled":false}'); cfg.chmod(0o600)
        control = state / "paused-sentinel"; control.write_text("true")
        self.install(); service.start(self.home, **self.options); service.stop(self.home, **self.options)
        self.assertEqual(json.loads(cfg.read_text()), {"pips_enabled": False})
        self.assertEqual(control.read_text(), "true")

    def test_paths_reject_control_surrogate_relative_traversal_and_missing_home(self):
        for home in ("relative", "/tmp/../tmp", str(self.home) + "\nExecStart=evil", "\ud800", "/tmp/\x00"):
            self.assertCode("invalid_service_path", service.preview, home, **self.options)
        self.assertCode("service_path_missing", service.preview, self.base / "missing", **self.options)
        with patch.object(service.sys, "platform", "darwin"):
            self.assertCode("service_unsupported", service.preview, self.home, **self.options)

    def test_symlinked_directories_refused_even_owned(self):
        link = self.base / "alias"; link.symlink_to(self.home, target_is_directory=True)
        self.assertCode("unsafe_service_path", service.preview, link, **self.options)
        self.units.symlink_to(self.home, target_is_directory=True)
        self.assertCode("unsafe_service_path", service.preview, self.home, **self.options)

    def test_group_writable_directories_and_executables_refused(self):
        import grp
        import pwd
        self.home.chmod(0o770)
        me = pwd.getpwuid(os.getuid())
        # Writable by a group someone else is in: refused.
        with patch("grp.getgrgid", return_value=grp.struct_group(("docker", "x", me.pw_gid, ["someone-else"]))):
            self.assertCode("unsafe_service_path", service.preview, self.home, **self.options)
            # The message names the folder, who can write it and the fix (a real ~/.local was 775 under the shared
            # docker group, and the bare message left the user nothing to act on).
            with self.assertRaises(RegistryError) as caught:
                service.preview(self.home, **self.options)
            self.assertIn(f"{self.home} is writable by the docker group", str(caught.exception))
            self.assertIn("chmod go-w", str(caught.exception))
        # A group of one (Ubuntu's private groups): nobody else can write, so it is accepted.
        with patch("grp.getgrgid", return_value=grp.struct_group((me.pw_name, "x", me.pw_gid, []))), \
                patch("pwd.getpwall", return_value=[me]):
            service.preview(self.home, **self.options)
        self.home.chmod(0o700)
        executable = self.base / "python"; executable.write_text("x"); executable.chmod(0o777)
        self.assertCode("invalid_service_python", service.preview, self.home, python_executable=executable, **self.options)

    def test_files_writable_only_by_your_own_group_run_and_a_shared_group_is_named_with_the_fix(self):
        # An install made under Ubuntu's umask 0002 left every DGC file 664: Keep Pips running refused it with
        # "DGC service entry points must be trusted regular files" on a user's .111 although the group
        # was his alone.
        import grp
        import pwd
        root = self.base / "release"
        (root / "dgc").mkdir(parents=True, mode=0o755)
        for name in ("__init__.py", "cli.py"):
            (root / "dgc" / name).write_text("x")
            (root / "dgc" / name).chmod(0o664)
        me = pwd.getpwuid(os.getuid())
        with patch("grp.getgrgid", return_value=grp.struct_group((me.pw_name, "x", me.pw_gid, []))), \
                patch("pwd.getpwall", return_value=[me]):
            service.preview(self.home, package_root=root, **self.options)
        with patch("grp.getgrgid", return_value=grp.struct_group(("docker", "x", me.pw_gid, ["someone-else"]))):
            with self.assertRaises(RegistryError) as caught:
                service.preview(self.home, package_root=root, **self.options)
            self.assertEqual(caught.exception.code, "invalid_service_source")
            self.assertIn("can be changed by the docker group", str(caught.exception))
            self.assertIn(f"chmod -R go-w {root}", str(caught.exception))
        (root / "dgc" / "cli.py").chmod(0o666)
        self.assertCode("invalid_service_source", service.preview, self.home, package_root=root, **self.options)

    def test_existing_unit_symlink_fifo_hardlink_large_or_nonprivate_refused(self):
        self.units.mkdir()
        self.file.symlink_to(self.base / "other")
        self.assertCode("unsafe_service_unit", service.install, self.home, **self.options)
        self.file.unlink(); os.mkfifo(self.file, 0o600)
        self.assertCode("unsafe_service_unit", service.install, self.home, **self.options)
        self.file.unlink(); self.file.write_bytes(b"x" * (service.MAX_UNIT_BYTES + 1)); self.file.chmod(0o600)
        self.assertCode("unsafe_service_unit", service.install, self.home, **self.options)
        self.file.write_text(self.spec["content"]); self.file.chmod(0o644)
        self.assertCode("unsafe_service_unit", service.install, self.home, **self.options)
        self.file.chmod(0o600); os.link(self.file, self.units / "linked")
        self.assertCode("unsafe_service_unit", service.install, self.home, **self.options)

    def test_missing_unit_refuses_control(self):
        self.units.mkdir()
        self.assertCode("service_not_installed", service.start, self.home, **self.options)
        self.assertEqual(self.calls, [])

    def test_reload_failure_leaves_reviewable_unit_without_start(self):
        with patch.object(service, "_systemctl", side_effect=RegistryError("service_manager_error", "private raw text")):
            with self.assertRaises(RegistryError) as caught:
                self.install()
        self.assertTrue(self.file.exists())
        self.assertIn("not started", str(caught.exception))
        self.assertNotIn("private raw text", str(caught.exception))

    def test_special_characters_are_systemd_escaped_not_shell_interpolated(self):
        home = self.base / 'space $HOME %h "quote" \\slash'; home.mkdir()
        value = service.preview(home, **self.options)
        self.assertIn('$$HOME %%h \\"quote\\" \\\\slash', value["content"])
        self.assertIn("HOME=" + str(home), value["argv"])
        self.assertNotIn("EnvironmentFile=", value["content"])
        self.assertIn("WorkingDirectory=/\n", value["content"])
        with patch.dict(os.environ, {"DGC_API_KEY": "do-not-copy", "PYTHONPATH": "/evil", "LD_PRELOAD": "/evil"}):
            self.assertNotIn("do-not-copy", service.preview(home, **self.options)["content"])

    def test_unit_digest_changes_with_trusted_runtime_not_home_identity(self):
        alternative = self.base / "python"; alternative.symlink_to(sys.executable)
        value = service.preview(self.home, python_executable=alternative, **self.options)
        self.assertEqual(value["unit_name"], self.spec["unit_name"])
        self.assertNotEqual(value["sha256"], self.spec["sha256"])

    def test_actual_isolated_python_ignores_home_import_shadow_and_refuses_disabled(self):
        (self.home / "dgc.py").write_text('raise RuntimeError("untrusted imported")')
        # Pips are on by default; this profile turns them off, so the service must refuse.
        (self.home / ".dgc").mkdir(mode=0o700, exist_ok=True)
        (self.home / ".dgc" / "config.json").write_text('{"pips_enabled": false}')
        os.chmod(self.home / ".dgc" / "config.json", 0o600)
        process = subprocess.run(self.spec["argv"], cwd=self.home, capture_output=True, timeout=15)
        # A clean exit, not a failure: under Restart=on-failure a disabled profile must not loop.
        self.assertEqual(process.returncode, 0, process.stderr)
        output = (process.stdout + process.stderr).decode()
        self.assertIn("not started: Pips are disabled", output)
        self.assertNotIn("untrusted imported", output)
        self.assertFalse((self.home / ".dgc" / "pips").exists())

    def test_actual_systemctl_capture_is_bounded_and_does_not_echo_raw_output(self):
        self.manager.stop()
        real_popen = subprocess.Popen
        def spawn(_argv, **kwargs):
            return real_popen([sys.executable, "-c", "print('private text' * 3000)"], **kwargs)
        with patch.object(service.subprocess, "Popen", side_effect=spawn):
            self.assertCode("service_manager_limit", service._systemctl, ["show", "fixture.service"])
        def fail(_argv, **kwargs):
            return real_popen([sys.executable, "-c", "print('private secret'); raise SystemExit(1)"], **kwargs)
        with patch.object(service.subprocess, "Popen", side_effect=fail):
            with self.assertRaises(RegistryError) as caught:
                service._systemctl(["show", "fixture.service"])
        self.assertNotIn("private secret", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
