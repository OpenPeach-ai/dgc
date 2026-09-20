"""The macOS Seatbelt ``strict-v1`` profile: what it must hide, and what must still work.

Two kinds of test live here.

* Composition tests run on every platform. They read the policy DGC would apply and check its
  shape — deny-by-default, every path a ``-D`` parameter, no user-controlled text spliced in, the
  right rules present or absent for read-only and for network.
* Live tests run only on macOS (``sandbox-exec``). They run real commands inside the profile and
  prove each escape the allow-by-default profile left open is closed, with an unsandboxed control
  behind every "blocked" claim so a check that simply fails on this runner cannot pass as a
  guarantee.

`tests/macos/seatbelt_probe.sh` is the wider version of the live half (it also signals a foreign
process, launches an app and reads the keychain) and runs in CI on macOS 15 and macOS 26.
"""
from __future__ import annotations

import contextlib
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import sandbox  # noqa: E402

DARWIN = sys.platform == "darwin"
SEATBELT = DARWIN and sandbox.MACOS_BACKEND_PATH.is_file()


class _Cfg:
    """The subset of Config the sandbox reads."""

    def __init__(self, **values):
        self.values = {"sandbox": True, "sandbox_network": False, **values}

    def get(self, key, default=None):
        return self.values.get(key, default)


def _profile_for(root: Path, **kwargs):
    box = sandbox._new_call_dir()
    assert box is not None, "no private call folder could be created"
    try:
        text, params = sandbox._macos_profile(root, box, **kwargs)
        return text, params, box
    finally:
        sandbox.release_call_dir(box)


class StrictProfileComposition(unittest.TestCase):
    """What the policy text says, on any platform (macOS is not needed to read it)."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="dgc-sbpl-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def test_profile_ships_and_is_deny_by_default(self):
        text = sandbox.MACOS_PROFILE_FILE.read_text(encoding="utf-8")
        body = "\n".join(line for line in text.splitlines()
                         if line.strip() and not line.strip().startswith(";"))
        rules = body.splitlines()
        self.assertEqual(rules[0].strip(), "(version 1)")
        self.assertEqual(rules[1].strip(), "(deny default)")
        # Never granted by the static policy: these are the escapes that made the old
        # allow-by-default profile leak (the header comment explains each one, hence `body`).
        for absent in ("launchservicesd", "cfprefsd", "SecurityServer", "pasteboard",
                       "(allow default)", '(subpath "/private/tmp")', "DARWIN_USER",
                       '(subpath "/Users")', "network-outbound"):
            self.assertNotIn(absent, body, absent)
        self.assertIn("(allow signal (target same-sandbox))", body)
        self.assertIn("(allow process-info* (target same-sandbox))", body)
        self.assertNotIn("(allow sysctl-read)", body)   # kern.proc.all would list every process
        self.assertIn('(sysctl-name "kern.procargs2")', body)

    def test_every_path_is_a_parameter_and_nothing_is_spliced(self):
        # A workspace whose name contains the characters that would end a rule early.
        nasty = self.root / 'weird ")(subpath "x" (literal "y"'
        nasty.mkdir()
        text, params, box = _profile_for(nasty, network=False, read_only=False)
        self.assertIsNotNone(text)
        self.assertNotIn(str(nasty), text)
        self.assertNotIn('(literal "y"', text)
        self.assertIn(f"-DWORKSPACE={nasty}", params)
        self.assertIn(f"-DSESSION_TMP={box}", params)
        self.assertIn('(allow file-read* file-test-existence file-map-executable'
                      ' (subpath (param "WORKSPACE")))', text)
        self.assertIn('(allow file-write* (subpath (param "WORKSPACE")))', text)
        # Every parameter is an absolute path, and each one is declared exactly once.
        keys = [item.split("=", 1)[0] for item in params]
        self.assertEqual(len(keys), len(set(keys)))
        for item in params:
            self.assertTrue(item.startswith("-D"), item)
            self.assertTrue(item.split("=", 1)[1].startswith("/"), item)
        # Each ancestor of the workspace gets metadata only, so a shell can resolve its way in
        # without being able to read anything on the way.
        self.assertIn(f"-DWS_ANC_0={os.sep}", params)

    def test_read_only_grants_no_write_rule(self):
        text, params, _ = _profile_for(self.root, network=False, read_only=True)
        self.assertNotIn('(allow file-write* (subpath (param "WORKSPACE")))', text)
        self.assertIn('(subpath (param "WORKSPACE"))', text)
        self.assertIn(f"-DWORKSPACE={self.root}", params)

    def test_network_section_is_ip_only_and_appears_only_when_allowed(self):
        def rules(text: str) -> str:
            return "\n".join(line for line in text.splitlines()
                             if line.strip() and not line.strip().startswith(";"))

        denied = rules(_profile_for(self.root, network=False, read_only=False)[0])
        allowed = _profile_for(self.root, network=True, read_only=False)[0]
        for fragment in ("network-outbound", "network-inbound", "SecurityServer"):
            self.assertNotIn(fragment, denied, fragment)
        self.assertIn('(allow network-outbound (remote ip "*:*"))', allowed)
        self.assertIn('(allow network-inbound (local ip "*:*"))', allowed)
        self.assertIn('(global-name "com.apple.SecurityServer")', allowed)
        # The only unix socket ever reachable is mDNSResponder's, and only with network allowed
        # (macOS resolves names through it). The SDK's tool relay and every other agent behind
        # /var/run stay out of a sandboxed command's reach in both modes.
        sockets = [line for line in allowed.splitlines()
                   if "unix-socket" in line and not line.strip().startswith(";")]
        self.assertEqual(sockets, ['(allow network-outbound (remote unix-socket'
                                   ' (literal "/private/var/run/mDNSResponder")))'])
        self.assertNotIn("unix-socket", denied)

    def test_extra_read_dirs_are_added_as_parameters(self):
        toolchain = self.root / "toolchain"
        toolchain.mkdir()
        text, params, _ = _profile_for(self.root, network=False, read_only=False,
                                       extra_read_dirs=(toolchain,))
        self.assertIn(f"-DREAD_EXTRA_0={toolchain}", params)
        self.assertIn('(subpath (param "READ_EXTRA_0"))', text)
        self.assertNotIn(str(toolchain), text)

    def test_config_read_dirs_are_resolved_and_filtered(self):
        real = self.root / "real"
        real.mkdir()
        (self.root / "file.txt").write_text("x")
        found = sandbox._extra_read_dirs(_Cfg(sandbox_read_dirs=[
            str(real), str(self.root / "missing"), str(self.root / "file.txt"), "/"]))
        self.assertEqual(found, (real,))

    def test_a_missing_policy_file_fails_closed(self):
        with mock.patch.object(sandbox, "MACOS_PROFILE_FILE", self.root / "gone.sbpl"):
            text, params = sandbox._macos_profile(self.root, self.root, network=False,
                                                  read_only=False)
        self.assertIsNone(text)
        self.assertEqual(params, [])

    def test_capabilities_dict_matches_the_frozen_contract(self):
        keys = {"backend", "profile", "process_isolated", "home_hidden", "private_temporary",
                "network_isolated", "keychain_hidden"}
        with mock.patch.object(sandbox, "_backend",
                               return_value=("sandbox-exec", sandbox.MACOS_BACKEND_PATH)):
            denied = sandbox.capabilities_dict(_Cfg())
            allowed = sandbox.capabilities_dict(_Cfg(sandbox_network=True))
        with mock.patch.object(sandbox, "_backend", return_value=None):
            none = sandbox.capabilities_dict(_Cfg())
        self.assertEqual(set(denied), keys)
        self.assertEqual(denied["backend"], "sandbox-exec")
        self.assertEqual(denied["profile"], "strict-v1")
        for flag in keys - {"backend", "profile"}:
            self.assertIsInstance(denied[flag], bool, flag)
            self.assertIs(none[flag], False, flag)
        self.assertIsNone(none["backend"])
        self.assertIsNone(none["profile"])
        self.assertTrue(denied["keychain_hidden"])
        self.assertFalse(allowed["keychain_hidden"])   # TLS needs SecurityServer (frozen: C8)
        self.assertTrue(allowed["process_isolated"] and allowed["home_hidden"])
        # A usable backend is not confinement: with the sandbox off for this session, the frame
        # names no backend and claims nothing, or a launcher would read an unconfined shell as
        # a sandboxed one.
        with mock.patch.object(sandbox, "_backend",
                               return_value=("sandbox-exec", sandbox.MACOS_BACKEND_PATH)):
            off = sandbox.capabilities_dict(_Cfg(sandbox=False))
        self.assertIsNone(off["backend"])
        self.assertIsNone(off["profile"])
        self.assertFalse(any(off[flag] for flag in keys - {"backend", "profile"}))

    def test_a_nested_sandbox_is_reported_unavailable_with_a_reason(self):
        """Seatbelt cannot nest: say so instead of running the command unconfined."""
        failure = subprocess.CompletedProcess(
            args=[], returncode=1,
            stderr=b"sandbox-exec: sandbox_apply: Operation not permitted\n")
        sandbox._SEATBELT_PROBE.clear()
        self.addCleanup(sandbox._SEATBELT_PROBE.clear)
        with mock.patch.object(sandbox.sys, "platform", "darwin"), \
                mock.patch.object(sandbox.Path, "is_file", lambda self: True), \
                mock.patch("os.access", return_value=True), \
                mock.patch("subprocess.run", return_value=failure):
            self.assertIsNone(sandbox.available())
            reason = sandbox.unavailable_reason()
        self.assertIn("cannot nest", reason)
        self.assertIn("already running inside a sandbox", reason)

    def test_the_call_folder_is_owner_only_and_reaped(self):
        box = sandbox._new_call_dir()
        self.assertIsNotNone(box)
        try:
            self.assertEqual(box.stat().st_mode & 0o777, 0o700)
            self.assertEqual((box / sandbox.CALL_HOME_NAME).stat().st_mode & 0o777, 0o700)
            self.assertEqual(sandbox._private_root().stat().st_mode & 0o777, 0o700)
            self.assertTrue(str(box).startswith(str(sandbox._private_root())))
        finally:
            sandbox.release_call_dir(box)
        self.assertFalse(box.exists())
        # An emptied folder (its command finished and wiped its HOME) is reaped by the next call.
        stale = sandbox._new_call_dir()
        shutil.rmtree(stale / sandbox.CALL_HOME_NAME)
        sandbox._reap_call_dirs()
        self.assertFalse(stale.exists())
        self.assertNotIn(str(stale), sandbox._CALL_DIRS)


@unittest.skipUnless(SEATBELT, "macOS sandbox-exec only")
class StrictProfileLive(unittest.TestCase):
    """Real commands inside the real profile, each "blocked" backed by an unsandboxed control."""

    @classmethod
    def setUpClass(cls):
        if sandbox.available() != "sandbox-exec":
            raise unittest.SkipTest(f"sandbox unavailable: {sandbox.unavailable_reason()}")

    def setUp(self):
        self.work = Path(tempfile.mkdtemp(prefix="dgc-sbx-live-")).resolve()
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)
        (self.work / "inside.txt").write_text("workspace fixture\n")

    def _run(self, argv: list[str], timeout: float, label: str):
        """Run one argv in its own process group, killing the whole group on a timeout.

        ``subprocess.run(..., timeout=)`` kills only the direct child and then blocks draining
        pipes a surviving grandchild still holds, which turns one stuck command into a stuck
        suite. A confined command that stalls must fail this test, not hang CI.
        """
        proc = subprocess.Popen(argv, cwd=str(self.work), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                start_new_session=True)
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(OSError):
                os.killpg(proc.pid, signal.SIGKILL)
            with contextlib.suppress(subprocess.TimeoutExpired):
                out, err = proc.communicate(timeout=20)
            self.fail(f"{label} did not finish within {timeout}s: {argv[-1]!r}")
        return subprocess.CompletedProcess(argv, proc.returncode, out, err)

    def run_confined(self, command: str, *, network=False, read_only=False, config=None,
                     timeout=60):
        argv = sandbox.wrap(command, self.work, config or _Cfg(sandbox_network=network,
                                                               sandbox_read_only=read_only))
        self.assertIsNotNone(argv, "sandbox.wrap refused to build an argv")
        box = next(item.split("=", 1)[1] for item in argv if item.startswith("-DSESSION_TMP="))
        try:
            return self._run(argv, timeout, "the confined command"), box
        finally:
            sandbox.release_call_dir(box)

    def run_free(self, command: str, timeout=60):
        """The same command unsandboxed: the control behind every "blocked"."""
        return self._run(["/bin/bash", "-o", "pipefail", "-c", command], timeout, "the control")

    def assertBlocked(self, command: str, *, network=False, expect_in_control=""):
        confined, _ = self.run_confined(command, network=network)
        control = self.run_free(command)
        self.assertEqual(control.returncode, 0,
                         f"untestable: the control failed too: {control.stderr[:200]}")
        if expect_in_control:
            self.assertIn(expect_in_control, control.stdout + control.stderr)
        self.assertNotEqual(confined.returncode, 0,
                            f"LEAK: {command!r} succeeded inside the sandbox: "
                            f"{(confined.stdout + confined.stderr)[:200]}")
        return confined

    # --- the workspace still works ----------------------------------------------------------
    def test_the_workspace_is_readable_and_writable(self):
        done, _ = self.run_confined("cat inside.txt && echo written > made.txt && cat made.txt")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("workspace fixture", done.stdout)
        self.assertTrue((self.work / "made.txt").exists())

    def test_read_only_denies_the_workspace_write(self):
        done, _ = self.run_confined("echo x > blocked.txt", read_only=True)
        self.assertNotEqual(done.returncode, 0)
        self.assertFalse((self.work / "blocked.txt").exists())
        done, _ = self.run_confined("cat inside.txt", read_only=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_common_tools_run_inside_the_profile(self):
        for command in ("git init -q r && cd r && git status --porcelain",
                        "/usr/bin/python3 -c 'import json,sys; print(sys.version_info[0])'",
                        "printf 'int main(void){return 0;}\\n' > t.c && clang -o t.out t.c"
                        " && ./t.out"):
            with self.subTest(command=command):
                done, _ = self.run_confined(command, timeout=90)
                self.assertEqual(done.returncode, 0,
                                 f"{command}: {(done.stdout + done.stderr)[:400]}")

    # --- the private temporary folder ---------------------------------------------------------
    def test_home_and_tmpdir_are_a_private_folder_removed_after_the_call(self):
        done, box = self.run_confined(
            'printf "%s|%s" "$HOME" "$TMPDIR"; echo secret > "$TMPDIR/f" && echo WROTE')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), f"{box}/t|{box}/t\nWROTE")
        self.assertFalse(Path(box).exists(), "the private folder survived the call")

    def test_one_command_cannot_read_another_commands_private_folder(self):
        first = sandbox.wrap("echo mine > $TMPDIR/secret; sleep 0.1", self.work, _Cfg())
        box = next(i.split("=", 1)[1] for i in first if i.startswith("-DSESSION_TMP="))
        try:
            (Path(box) / "t" / "secret").write_text("first-command-secret\n")
            done, _ = self.run_confined(f"cat {box}/t/secret")
            self.assertNotEqual(done.returncode, 0,
                                f"LEAK: a second command read {box}: {done.stdout[:200]}")
        finally:
            sandbox.release_call_dir(box)

    # --- the six confirmed escapes, and the guarantees around them ---------------------------
    def test_the_host_shared_temporary_folders_are_hidden(self):
        outside = Path(tempfile.mkdtemp(prefix="dgc-outside-", dir="/tmp")).resolve()
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        (outside / "secret.txt").write_text("tmp-secret\n")
        self.assertBlocked(f"cat {outside}/secret.txt", expect_in_control="tmp-secret")
        self.assertBlocked("ls /private/tmp")
        # Resolved outside: inside the sandbox getconf falls back to TMPDIR, which is the
        # sandbox's own private folder, so asking it there would prove nothing.
        for name in ("DARWIN_USER_TEMP_DIR", "DARWIN_USER_CACHE_DIR"):
            path = subprocess.run(["/usr/bin/getconf", name], capture_output=True,
                                  text=True).stdout.strip()
            self.assertTrue(path.startswith("/"), f"{name} did not resolve: {path!r}")
            self.assertBlocked(f"ls {path}")
        marker = Path("/private/tmp") / f"dgc-seatbelt-live-{os.getpid()}"
        self.addCleanup(marker.unlink, True)
        self.assertBlocked(f"echo x > {marker}")
        self.assertFalse(marker.exists(), "LEAK: a write reached the host's shared /tmp")

    def test_the_home_folder_and_dgc_state_are_hidden(self):
        home = Path.home()
        probe = home / f".dgc-seatbelt-live-{os.getpid()}"
        probe.write_text("home-secret\n")
        self.addCleanup(probe.unlink, True)
        self.assertBlocked(f"cat {probe}", expect_in_control="home-secret")
        self.assertBlocked(f"ls {home}")
        escape = home / f".dgc-seatbelt-live-write-{os.getpid()}"
        self.addCleanup(escape.unlink, True)
        self.assertBlocked(f"echo x > {escape}")
        self.assertFalse(escape.exists(), "LEAK: a write reached the home folder")

    def test_outside_processes_cannot_be_listed_inspected_or_signalled(self):
        victim = subprocess.Popen(["/bin/sleep", "600"],
                                  env={**os.environ, "DGC_LIVE_MARK": "foreign-env"})
        self.addCleanup(victim.kill)
        self.assertBlocked(f"ps -Eww -p {victim.pid}", expect_in_control="DGC_LIVE_MARK")
        self.assertBlocked(f"ps -A -o pid= | tr -d ' ' | grep -qx {victim.pid}")
        # The signal is checked before its control, because the control kills the victim.
        confined, _ = self.run_confined(f"kill -TERM {victim.pid}")
        self.assertNotEqual(confined.returncode, 0, "LEAK: kill succeeded inside the sandbox")
        time.sleep(0.5)
        self.assertIsNone(victim.poll(), "LEAK: a signal reached a process outside the sandbox")
        self.assertEqual(self.run_free(f"kill -TERM {victim.pid}").returncode, 0)
        time.sleep(0.5)
        self.assertIsNotNone(victim.poll(),
                             "untestable: the control could not signal it either")

    def test_apps_jobs_and_preferences_cannot_be_started_from_inside(self):
        # `open` and `defaults` are judged by their effect outside the sandbox, not by their exit
        # code: the old allow-by-default profile let both exit 0, and only the outside check told
        # the launched app (a real escape) from the swallowed preference write.
        subprocess.run(["/usr/bin/pkill", "-x", "TextEdit"], capture_output=True)
        self.addCleanup(subprocess.run, ["/usr/bin/pkill", "-x", "TextEdit"])
        self.run_confined("open -g -a TextEdit")
        subprocess.run(["/bin/sleep", "2"])
        self.assertEqual(subprocess.run(["/usr/bin/pgrep", "-x", "TextEdit"],
                                        capture_output=True).returncode, 1,
                         "LEAK: LaunchServices started an app outside the sandbox")
        domain = f"dgc.seatbelt.live.{os.getpid()}"
        self.addCleanup(subprocess.run, ["/usr/bin/defaults", "delete", domain],
                        capture_output=True)
        self.run_confined(f"defaults write {domain} k v")
        self.assertNotEqual(subprocess.run(["/usr/bin/defaults", "read", domain, "k"],
                                           capture_output=True).returncode, 0,
                            "LEAK: a preference written inside the sandbox reached cfprefsd")
        self.assertBlocked(f"launchctl submit -l dgc.live.{os.getpid()} -- /usr/bin/true")

    def test_a_sandbox_cannot_be_nested_from_inside(self):
        self.assertBlocked("/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true")

    def test_network_is_denied_by_default_and_allowed_only_on_request(self):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):                                # noqa: N802 - BaseHTTPRequestHandler
                body = b"ok"
                self.send_response(200)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        command = f"curl -sS -m 10 http://127.0.0.1:{port}/"
        denied, _ = self.run_confined(command, network=False)
        self.assertNotEqual(denied.returncode, 0, "LEAK: network reached with sandbox_network off")
        allowed, _ = self.run_confined(command, network=True)
        self.assertEqual(allowed.returncode, 0,
                         f"network was allowed but curl failed: {allowed.stderr[:200]}")
        self.assertIn("ok", allowed.stdout)

    def test_the_keychain_is_hidden_while_network_is_denied(self):
        service = f"dgc-seatbelt-live-{os.getpid()}"
        seeded = subprocess.run(
            ["/usr/bin/security", "add-generic-password", "-U", "-A", "-a", "dgc",
             "-s", service, "-w", "LIVE-SECRET-4d2"], capture_output=True)
        if seeded.returncode != 0:
            self.skipTest("this runner has no usable login keychain")
        self.addCleanup(subprocess.run,
                        ["/usr/bin/security", "delete-generic-password", "-s", service])
        command = f"security find-generic-password -s {service} -w"
        self.assertBlocked(command, expect_in_control="LIVE-SECRET-4d2")
        # And with network allowed it is reachable again, which is exactly what the capability
        # object reports (keychain_hidden is false there) and what the docs must say.
        self.assertFalse(sandbox.capabilities_dict(_Cfg(sandbox_network=True))["keychain_hidden"])

    def test_an_sdk_state_folder_outside_the_workspace_stays_hidden(self):
        state = Path(tempfile.mkdtemp(prefix="dgc-sbx-state-")).resolve()
        self.addCleanup(shutil.rmtree, state, ignore_errors=True)
        (state / "home").mkdir()
        (state / "audit").mkdir()
        (state / "audit" / "probe.txt").write_text("sdk-state-secret\n")
        with mock.patch.dict(os.environ, {"DGC_SDK_ISOLATED": "1",
                                          "DGC_HOME": str(state / "home")}, clear=False):
            self.assertBlocked(f"cat {state}/audit/probe.txt",
                               expect_in_control="sdk-state-secret")

    def test_the_reported_capabilities_are_the_ones_just_proven(self):
        report = sandbox.capabilities_dict(_Cfg())
        self.assertEqual(report["backend"], "sandbox-exec")
        self.assertEqual(report["profile"], "strict-v1")
        for flag in ("process_isolated", "home_hidden", "private_temporary", "network_isolated",
                     "keychain_hidden"):
            self.assertTrue(report[flag], flag)


if __name__ == "__main__":
    unittest.main()
