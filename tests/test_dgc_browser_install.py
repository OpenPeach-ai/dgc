"""DGC Browser, phase 3b (0.52, Pips API 107; decided 18 Nov): Install Google Chrome, one button.

- DGC Browser uses the installed Google Chrome (/opt/google/chrome/chrome, whose package installs a root-owned
  chrome-sandbox and which Ubuntu's own AppArmor profile already names). Where none is installed and Chrome's sandbox
  can't run from DGC's downloaded copy, the answer is ONE button, Install Google Chrome: never a pasted sudo command and
  never an AppArmor profile from DGC. The sandbox check itself stays: DGC Browser never starts Chrome without it.
- The install is ONE root step through the system's own password prompt (pkexec): Google's signing key, checked
  against the fingerprint DGC pins, Google's package source, then `apt-get install -y google-chrome-stable`. DGC never
  sees the password. apt systems only; elsewhere the words say to install it from google.com/chrome.
- No password prompt can open (no screen, as over Remote-SSH; no pkexec), or it was refused or closed: the same card
  shows the one terminal line, the same steps, to run on that machine, with Copy.
- After it ends, what get_dgc_browser_recent says is read again: the card updates by itself.

Tests never run pkexec or apt for real: the root step is stood in, and the step's own script runs under a plain shell
against stand-in tools and a test signing key in temporary folders."""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_screen_setup, pips, dgc_browser
from tests import test_pips_local as fixtures

REPO = Path(__file__).resolve().parents[1]
PINNED = pip_screen_setup.GOOGLE_KEY_FINGERPRINT


class Base(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)

    def control(self, command, actor="editor-user", **fields):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"type": command, "request_id": "r", **fields}, actor, start_worker=False)

    def ok(self, command, **fields):
        out = self.control(command, **fields)
        self.assertTrue(out["ok"], out)
        return out["result"]


def _linux_without_chrome(screen=True, pkexec="/usr/bin/pkexec"):
    """A Linux with apt and no Google Chrome: DGC's own copy kept from its sandbox (Ubuntu's user-namespace rule)."""
    return [patch.object(dgc_browser.sys, "platform", "linux"),
            patch.object(dgc_browser, "find_chrome", return_value=(None, "")),
            patch.object(pip_screen_setup, "supported", return_value=(True, "")),
            patch.object(pip_screen_setup, "status", return_value={"state": "none"}),
            patch.object(dgc_browser, "has_screen", return_value=screen),
            patch.object(dgc_browser.shutil, "which", side_effect=lambda name: pkexec if name == "pkexec" else shutil.which(name))]


class Patched(Base):
    def given(self, patches):
        for p in patches:
            p.start()
            self.addCleanup(p.stop)


# --------------------------------------------------------------------------- what it says where Chrome is missing

class Availability(Patched):
    def test_with_no_google_chrome_it_offers_the_one_button_and_never_a_sudo_command(self):
        self.given(_linux_without_chrome())
        got = self.ok("get_dgc_browser_recent")
        self.assertFalse(got["available"])
        self.assertEqual(got["reason"], dgc_browser.NEEDS_CHROME)
        self.assertEqual((got["install"]["how"], got["install"]["state"]), ("password", ""))
        for never in ("sudo", "apparmor", "printf", "tee "):
            self.assertNotIn(never, got["reason"].lower(), "no pasted command in its words")
        self.assertEqual(self.ok("get_dgc_browser")["install"], got["install"], "get_dgc_browser says the same")

    def test_dgcs_own_copy_kept_from_its_sandbox_offers_it_too(self):
        self.given(_linux_without_chrome())
        copy = Path("/home/someone/.dgc/desktop/arm64/v-1/root/opt/google/chrome/chrome")
        with patch.object(dgc_browser, "find_chrome", return_value=(copy, "dgc_copy")), \
                patch.object(dgc_browser, "sandbox_ok", return_value=False):
            got = self.ok("get_dgc_browser_recent")
        self.assertEqual((got["available"], got["reason"]), (False, dgc_browser.NEEDS_CHROME))
        self.assertEqual(got["install"]["how"], "password")

    def test_with_no_screen_or_no_pkexec_the_card_shows_the_terminal_line(self):
        for screen, pkexec in ((False, "/usr/bin/pkexec"), (True, None)):
            with self.subTest(screen=screen, pkexec=pkexec):
                patches = _linux_without_chrome(screen=screen, pkexec=pkexec)
                for p in patches:
                    p.start()
                try:
                    got = self.ok("get_dgc_browser_recent")
                finally:
                    for p in reversed(patches):
                        p.stop()
                self.assertEqual(got["install"]["how"], "terminal")
                self.assertEqual(got["install"]["line"], dgc_browser.terminal_line())

    def test_elsewhere_it_says_to_install_it_from_google_and_offers_no_button(self):
        cases = [("darwin", (None, ""), (True, "")), ("linux", (None, ""), (False, "This Linux has no apt-get"))]
        for platform, found, supported in cases:
            with self.subTest(platform=platform), patch.object(dgc_browser.sys, "platform", platform), \
                    patch.object(dgc_browser, "find_chrome", return_value=found), \
                    patch.object(pip_screen_setup, "supported", return_value=supported):
                got = self.ok("get_dgc_browser_recent")
                self.assertEqual(got["reason"], "Install Google Chrome from google.com/chrome, then open DGC Browser again.")
                self.assertIsNone(got["install"])

    def test_with_google_chrome_installed_nothing_is_offered(self):
        with patch.object(dgc_browser, "_availability", return_value=(True, "", "installed")):
            got = self.ok("get_dgc_browser_recent")
        self.assertTrue(got["available"])
        self.assertIsNone(got["install"])

    def test_the_sandbox_check_stays_and_says_no_command(self):
        temp = Path(tempfile.mkdtemp(prefix="yb-sandbox-"))
        self.addCleanup(shutil.rmtree, temp, True)
        chrome = temp / "v-1" / "root" / "opt" / "google" / "chrome" / "chrome"
        chrome.parent.mkdir(parents=True)
        chrome.write_bytes(b"\x7fELF")
        (chrome.parent / "chrome-sandbox").write_bytes(b"\x7fELF")
        knobs = {"/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1", "/proc/sys/kernel/unprivileged_userns_clone": "1"}
        self.assertIs(dgc_browser.sandbox_ok(chrome, knobs=knobs, apparmor=temp, platform="linux"), False)
        self.assertIs(dgc_browser.sandbox_ok(chrome, knobs={**knobs, "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0"},
                                              apparmor=temp, platform="linux"), True)
        source = (REPO / "dgc" / "dgc_browser.py").read_text(encoding="utf-8")
        for never in ("apparmor_parser", "/etc/apparmor.d/dgc-chrome", "profile dgc-chrome"):
            self.assertNotIn(never, source, "DGC never writes an AppArmor profile")


# --------------------------------------------------------------------------- the one root step

class RootStep(Patched):
    def setUp(self):
        super().setUp()
        self.given(_linux_without_chrome())
        self.ran, self.finish = [], threading.Event()
        self.code = 0

        def root(argv, log):
            self.ran.append(argv)
            self.finish.wait(10)
            Path(log).write_text("Setting up google-chrome-stable\n" if self.code == 0 else "E: Unable to fetch some archives\n")
            return self.code

        self.given([patch.object(dgc_browser, "_run_root", side_effect=root)])

    def wait_done(self):
        self.finish.set()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            state = dgc_browser.install_status(self.registry.directory)
            if state.get("state") != "running":
                return state
            time.sleep(0.02)
        self.fail("the install never ended")

    def test_install_asks_the_systems_own_password_prompt_for_one_root_step(self):
        got = self.ok("install_google_chrome")
        self.assertEqual(got["install"]["state"], "running")
        self.assertEqual(self.ok("get_dgc_browser_recent")["install"]["state"], "running", "the card says it is installing")
        self.wait_done()
        [argv] = self.ran
        self.assertEqual(argv[:3], ["/usr/bin/pkexec", "/bin/sh", "-c"], "pkexec: DGC never sees the password")
        self.assertEqual(argv[3], dgc_browser.install_script())
        self.assertNotIn("sudo", argv[3])

    def test_a_second_ask_while_it_runs_starts_nothing_more(self):
        self.ok("install_google_chrome")
        self.assertEqual(self.ok("install_google_chrome")["install"]["state"], "running")
        self.wait_done()
        self.assertEqual(len(self.ran), 1)

    def test_once_it_ends_the_availability_is_read_again(self):
        self.ok("install_google_chrome")
        self.wait_done()
        with patch.object(dgc_browser, "_availability", return_value=(True, "", "installed")):
            got = self.ok("get_dgc_browser_recent")
        self.assertEqual((got["available"], got["install"]), (True, None))

    def test_closed_or_refused_or_no_prompt_shows_the_terminal_line(self):
        for code, words in ((126, "password prompt was closed"), (127, "No password prompt could open"),
                            (3, "signing key"), (100, "Unable to fetch")):
            with self.subTest(code=code):
                self.ran.clear()
                self.finish.clear()
                self.code = code
                self.ok("install_google_chrome")
                state = self.wait_done()
                self.assertEqual(state["state"], "failed")
                got = self.ok("get_dgc_browser_recent")["install"]
                self.assertEqual(got["state"], "failed")
                self.assertIn(words, got["error"])
                self.assertEqual(got["line"], dgc_browser.terminal_line())

    def test_with_no_password_prompt_possible_it_runs_nothing_and_answers_the_line(self):
        with patch.object(dgc_browser, "has_screen", return_value=False):
            got = self.ok("install_google_chrome")
        self.assertEqual((got["install"]["how"], got["install"]["state"]), ("terminal", ""))
        self.assertEqual(self.ran, [])

    def test_where_chrome_is_already_there_it_answers_at_once(self):
        with patch.object(dgc_browser, "_availability", return_value=(True, "", "installed")):
            got = self.ok("install_google_chrome")
        self.assertEqual((got["available"], got["install"]), (True, None))
        self.assertEqual(self.ran, [])

    def test_elsewhere_it_is_refused_with_the_words(self):
        with patch.object(pip_screen_setup, "supported", return_value=(False, "no apt-get")):
            out = self.control("install_google_chrome")
        self.assertEqual(out["error"]["code"], "unavailable")
        self.assertIn("google.com/chrome", out["error"]["message"])
        self.assertEqual(self.ran, [])

    def test_it_is_local_only_and_never_from_a_pip(self):
        for actor in ("device_paired_phone", "pip:" + "a" * 32):
            with self.subTest(actor=actor):
                self.assertEqual(self.control("install_google_chrome", actor=actor)["error"]["code"], "local_only")
        self.assertEqual(self.ran, [])

    def test_a_dead_install_is_never_running_for_ever(self):
        path = dgc_browser.folder(self.registry.directory) / dgc_browser.INSTALL_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"state": "running", "pid": 2 ** 22 + 12345, "at": "2026-11-18T10:00:00Z"}))
        self.assertEqual(self.ok("get_dgc_browser_recent")["install"]["state"], "")


# --------------------------------------------------------------------------- the step's own script, under a plain shell

def _gpg_key(home: Path, name: str) -> tuple[bytes, str]:
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    run = lambda *a, **kw: subprocess.run(["gpg", "--homedir", str(home), "--batch", *a], check=True, capture_output=True, **kw)  # noqa: E731
    run("--passphrase", "", "--quick-gen-key", f"{name} <{name.lower()}@example.com>", "ed25519", "sign", "never")
    listed = run("--with-colons", "--list-keys", f"{name.lower()}@example.com").stdout.decode()
    fingerprint = next(l.split(":")[9] for l in listed.splitlines() if l.startswith("fpr:"))
    return run("--armor", "--export", fingerprint).stdout, fingerprint


@unittest.skipUnless(shutil.which("gpg") and shutil.which("sh"), "needs gpg and sh")
class Script(unittest.TestCase):
    """The same script pkexec runs (and the terminal line wraps), against stand-in curl, dpkg and apt-get on PATH and a
    test signing key: the key is checked against the pinned fingerprint before anything is written or installed."""

    @classmethod
    def setUpClass(cls):
        cls.temp = Path(tempfile.mkdtemp(prefix="yb-script-"))
        cls.key, cls.fingerprint = _gpg_key(cls.temp / "gpg-a", "Signer")
        cls.other, _ = _gpg_key(cls.temp / "gpg-b", "Someone")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.temp, True)

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="yb-root-", dir=self.temp))
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.served = self.root / "served.pub"
        self.calls = self.root / "apt-calls"
        for name, body in (("curl", f'cat "{self.served}"'), ("dpkg", 'echo arm64'),
                           ("apt-get", f'echo "$*" >> "{self.calls}"')):
            path = self.bin / name
            path.write_text(f"#!/bin/sh\n{body}\n")
            path.chmod(0o755)
        self.key_file = self.root / "etc" / "apt" / "keyrings" / "google-chrome.asc"
        self.listing = self.root / "etc" / "apt" / "sources.list.d" / "google-chrome.list"
        self.listing.parent.mkdir(parents=True)

    def run_script(self, served: bytes):
        self.served.write_bytes(served)
        script = dgc_browser.install_script(fingerprint=self.fingerprint, key_file=str(self.key_file), source_list=str(self.listing))
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.root)}
        return subprocess.run(["sh", "-c", script], env=env, capture_output=True, text=True, timeout=60)

    def test_the_right_key_is_kept_the_source_is_added_and_chrome_installed(self):
        done = self.run_script(self.key)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.key_file.read_bytes(), self.key)
        self.assertEqual(stat.S_IMODE(self.key_file.stat().st_mode), 0o644)
        self.assertEqual(self.listing.read_text().strip(),
                         f"deb [arch=arm64 signed-by={self.key_file}] https://dl.google.com/linux/chrome/deb/ stable main")
        calls = self.calls.read_text().splitlines()
        self.assertEqual(calls[-1], "install -y google-chrome-stable")
        self.assertTrue(calls[0].startswith("update"))

    def test_a_key_that_isnt_the_pinned_one_installs_nothing(self):
        for served in (self.other, self.key + b"\n" + self.other, b"<html>not a key</html>"):
            with self.subTest(served=served[:30]):
                done = self.run_script(served)
                self.assertEqual(done.returncode, 3, done.stderr)
                self.assertIn("not the one DGC trusts", done.stderr)
                self.assertFalse(self.key_file.exists())
                self.assertFalse(self.listing.exists())
                self.assertFalse(self.calls.exists(), "apt is never asked")

    def test_the_real_script_pins_googles_key_source_and_package(self):
        script = dgc_browser.install_script()
        for part in (PINNED, pip_screen_setup.GOOGLE_KEY_URL, pip_screen_setup.GOOGLE_REPOSITORY,
                     "/etc/apt/keyrings/google-chrome.asc", "/etc/apt/sources.list.d/google-chrome.list",
                     "apt-get install -y google-chrome-stable"):
            self.assertIn(part, script)
        self.assertNotIn("'", script, "it fits inside the terminal line's quotes")

    def test_the_terminal_line_is_the_same_steps_for_sudo(self):
        line = dgc_browser.terminal_line()
        self.assertTrue(line.startswith("sudo sh -c '"))
        self.assertTrue(line.endswith("'"))
        self.assertNotIn("\n", line)
        inner = line[len("sudo sh -c '"):-1]
        self.assertEqual(inner, dgc_browser.install_script().replace("\n", "; "))
        # The same line, run with a stand-in sudo, does the same as the script.
        (self.bin / "sudo").write_text('#!/bin/sh\nexec "$@"\n')
        (self.bin / "sudo").chmod(0o755)
        self.served.write_bytes(self.key)
        test_line = dgc_browser.terminal_line(fingerprint=self.fingerprint, key_file=str(self.key_file), source_list=str(self.listing))
        done = subprocess.run(["sh", "-c", test_line], env={"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.root)},
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.key_file.read_bytes(), self.key)


class Api107(unittest.TestCase):
    def test_the_command_is_known_local_and_in_the_pips_md_row(self):
        self.assertIn("install_google_chrome", pips.CONTROL_COMMANDS)
        self.assertEqual(pips._COMMAND_ARGS["install_google_chrome"], set())
        self.assertEqual(dgc_browser.COMMAND_ARGS["install_google_chrome"], set())
        row = next(l for l in (REPO / "sdk" / "PIPS.md").read_text(encoding="utf-8").splitlines() if l.startswith("| 107 |"))
        for word in ("install_google_chrome", "pkexec", "install", "terminal"):
            with self.subTest(word=word):
                self.assertIn(word, row)
        self.assertNotIn("the one command that fixes it", row)


if __name__ == "__main__":
    unittest.main()
