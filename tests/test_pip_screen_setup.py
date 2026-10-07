"""DGC sets up a Pip computer's desktop itself: no admin password, nothing installed on the system.

The founder: "why does my system need that? Doesn't a Pip create its own virtual OS?" These drive
the real pip_screen_setup against stand-in apt-get, apt-cache, dpkg-deb, dpkg and gpg that record
what they were asked (a real download is 130 MB and needs the network; it was run on the GB10:
Chrome 155 and the desktop in 33 seconds, a daily re-check in 12 with nothing downloaded).
"""
from __future__ import annotations

import io
import json
import os
import stat
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_screen, pip_screen_setup as setup

FPR = setup.GOOGLE_KEY_FINGERPRINT
FAKE_TOOL = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, sys
    from pathlib import Path
    name, args = Path(sys.argv[0]).name, sys.argv[1:]
    state = Path(os.environ["FAKE_STATE"])
    with open(state / "calls.jsonl", "a") as log:
        log.write(json.dumps([name, args, os.getcwd()]) + "\\n")
    plan = json.loads((state / "plan.json").read_text())
    words = [a for a in args if not a.startswith("-") and "=" not in a]
    if name == "dpkg":
        print("arm64")
    elif name == "gpg":
        assert Path(args[-1]).read_bytes().startswith(b"-----BEGIN PGP PUBLIC KEY BLOCK-----"), args
        print("pub:u:4096:1:7721F63BD38B4796:1460484000:::-:::scESC::::::23::0:")
        print("fpr:::::::::" + (state / "fpr").read_text().strip() + ":")
    elif name == "apt-get" and "update" in words:
        if (state / "fail-update").exists():
            print("E: The repository is not signed.", file=sys.stderr); sys.exit(100)
    elif name == "apt-get" and "-s" in args:
        for pkg, ver in plan.items():
            print(f"Inst {pkg} ({ver} Ubuntu:24.04/noble [arm64])")
    elif name == "apt-get" and "download" in words:
        for pkg in words[words.index("download") + 1:]:
            Path(f"{pkg}_{plan[pkg].replace(':', '%3a')}_arm64.deb").write_bytes(b"x" * 1000)
    elif name == "apt-cache":
        print("Package: " + words[-1]); print("Size: 1000")
    elif name == "dpkg-deb":
        deb, root = Path(args[-2]), Path(args[-1])
        pkg = deb.name.split("_")[0]
        if pkg == "google-chrome-stable":
            target = root / "opt/google/chrome/chrome"
        else:
            target = root / "usr/bin" / {"tigervnc-standalone-server": "Xtigervnc"}.get(pkg, pkg)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"\\x7fELF" + deb.name.encode())
        target.chmod(0o755)
    ''')


class SetupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-desktop-setup-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.bin, self.state, self.etc, self.home = (self.root / n for n in ("bin", "state", "etc", "home"))
        for d in (self.bin, self.state, self.etc / "apt" / "sources.list.d", self.home):
            d.mkdir(parents=True)
        for tool in ("apt-get", "apt-cache", "dpkg-deb", "dpkg", "gpg"):
            path = self.bin / tool
            path.write_text(FAKE_TOOL.replace("/usr/bin/env python3", sys.executable))
            path.chmod(0o755)
        (self.etc / "os-release").write_text('NAME="Ubuntu"\nID=ubuntu\n')
        (self.etc / "apt" / "sources.list.d" / "ubuntu.sources").write_text("Types: deb\nURIs: http://ports.ubuntu.com/\n")
        (self.etc / "apt" / "sources.list.d" / "docker.sources").write_text("Types: deb\nURIs: https://download.docker.com/\n")
        (self.state / "fpr").write_text(FPR)
        self.plan({"google-chrome-stable": "155.0.1-1", "tint2": "17.0.1-1", "openbox": "3.6.1-12"})
        patches = [patch.dict(os.environ, {"PATH": f"{self.bin}:/usr/bin:/bin", "FAKE_STATE": str(self.state)}),
                   patch.object(setup, "ETC", self.etc), patch("dgc.config.USER_HOME", self.home),
                   patch("urllib.request.urlopen", side_effect=lambda *a, **k: io.BytesIO(
                       b"-----BEGIN PGP PUBLIC KEY BLOCK-----\nkey\n-----END PGP PUBLIC KEY BLOCK-----\n"))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def plan(self, packages):
        (self.state / "plan.json").write_text(json.dumps(packages))

    def calls(self, tool=None, word=None):
        rows = [json.loads(l) for l in (self.state / "calls.jsonl").read_text().splitlines()] if (self.state / "calls.jsonl").exists() else []
        return [r for r in rows if (tool is None or r[0] == tool) and (word is None or word in r[1])]

    def run_setup(self, needs=("google-chrome-stable", "tint2", "openbox")):
        setup._run_logged(list(needs))
        return setup.status()

    def test_it_downloads_what_is_missing_unpacks_it_into_its_own_folder_and_switches_to_it(self):
        value = self.run_setup()
        self.assertEqual(value["state"], "ready", value)
        root = setup.current_root()
        self.assertTrue(root.is_relative_to(self.home / "desktop" / "arm64"), "inside DGC's own folder")
        self.assertEqual(setup.chrome_path(), root / "opt/google/chrome/chrome")
        self.assertTrue((root / "usr/bin/tint2").is_file())
        self.assertEqual(setup.manifest()["packages"], {"google-chrome-stable": "155.0.1-1", "tint2": "17.0.1-1", "openbox": "3.6.1-12"})
        self.assertEqual(setup.manifest()["chrome"], "155.0.1")
        downloaded = self.calls("apt-get", "download")
        self.assertEqual(len(downloaded), 1)
        self.assertEqual(sorted(a for a in downloaded[0][1] if not a.startswith("-") and "=" not in a and a != "download"),
                         ["google-chrome-stable", "openbox", "tint2"])
        self.assertFalse((self.home / "desktop" / "arm64" / "apt").exists(), "apt's lists are not kept")

    def test_apt_works_only_in_its_private_state_and_reads_only_the_distributions_sources(self):
        self.run_setup()
        update = self.calls("apt-get", "update")[0][1]
        options = dict(update[i + 1].split("=", 1) for i, a in enumerate(update) if a == "-o")
        base = self.home / "desktop" / "arm64" / "apt"
        self.assertEqual(options["Dir::State"], str(base / "state"))
        self.assertEqual(options["Dir::Cache"], str(base / "cache"))
        self.assertEqual(options["Dir::State::status"], "/var/lib/dpkg/status", "what the system has, read only")
        self.assertEqual(options["Dir::Etc::SourceList"], "/dev/null")
        self.assertEqual(options["Acquire::IndexTargets::deb::Translations::DefaultEnabled"], "false")
        self.assertNotIn("sudo", json.dumps(self.calls()))

    def test_only_the_distributions_own_sources_are_used_not_third_party_ones(self):
        parts = self.home / "probe"
        parts.mkdir()
        self.assertEqual(setup._distro_sources(parts), 1)
        self.assertEqual(sorted(p.name for p in parts.iterdir()), ["ubuntu.sources"], "not docker.sources")

    def test_google_chrome_comes_only_with_googles_own_key(self):
        (self.state / "fpr").write_text("0" * 40)
        value = self.run_setup()
        self.assertEqual(value["state"], "failed")
        self.assertIn("not the one DGC trusts", value["error"])
        self.assertEqual(self.calls("apt-get"), [], "nothing is fetched with a key DGC does not trust")
        self.assertIsNone(setup.current_root())

    def test_a_daily_check_with_nothing_new_downloads_nothing(self):
        self.run_setup()
        first = setup.current_root()
        checked = setup.manifest()["checked_at"]
        time.sleep(0.01)
        self.assertEqual(self.run_setup()["state"], "ready")
        self.assertEqual(len(self.calls("apt-get", "download")), 1, "the second check fetched nothing")
        self.assertEqual(setup.current_root(), first)
        self.assertGreater(setup.manifest()["checked_at"], checked)

    def test_a_new_chrome_is_downloaded_alone_and_switched_to_in_one_step(self):
        self.run_setup()
        old = setup.current_root()
        time.sleep(1.1)                                  # a new version folder needs a new second
        self.plan({"google-chrome-stable": "156.0.0-1", "tint2": "17.0.1-1", "openbox": "3.6.1-12"})
        self.assertEqual(self.run_setup()["state"], "ready")
        second = self.calls("apt-get", "download")[-1][1]
        self.assertEqual([a for a in second if not a.startswith("-") and "=" not in a and a != "download"], ["google-chrome-stable"])
        new = setup.current_root()
        self.assertNotEqual(new, old)
        self.assertTrue(old.exists(), "the previous version stays for a desktop still running on it")
        self.assertEqual(setup.manifest()["chrome"], "156.0.0")
        debs = sorted(p.name for p in (self.home / "desktop/arm64/debs").iterdir())
        self.assertEqual(debs, ["google-chrome-stable_156.0.0-1_arm64.deb", "openbox_3.6.1-12_arm64.deb", "tint2_17.0.1-1_arm64.deb"],
                         "the old Chrome's package is dropped")

    def test_a_failure_is_said_and_retried_after_an_hour_not_on_every_look(self):
        (self.state / "fail-update").write_text("1")
        value = self.run_setup()
        self.assertEqual(value["state"], "failed")
        self.assertIn("Updating package lists failed", value["error"])
        self.assertFalse(setup.due(), "not again at once")
        data = json.loads((self.home / "desktop/arm64/status.json").read_text())
        data["at"] = time.time() - 3601
        (self.home / "desktop/arm64/status.json").write_text(json.dumps(data))
        self.assertTrue(setup.due())

    def test_due_once_a_day(self):
        self.assertTrue(setup.due(), "never checked")
        self.run_setup()
        self.assertFalse(setup.due())
        data = json.loads((self.home / "desktop/arm64/status.json").read_text())
        data["at"] = time.time() - setup.CHECK_EVERY - 1
        (self.home / "desktop/arm64/status.json").write_text(json.dumps(data))
        self.assertTrue(setup.due())

    def test_the_desktop_uses_dgcs_own_copy_and_says_it_is_setting_up_until_then(self):
        with patch("shutil.which", side_effect=lambda name: None if name in pip_screen.PROGRAMS.values() else "/usr/bin/" + name):
            shown = pip_screen.availability()
            self.assertFalse(shown["available"])
            self.assertEqual((shown["install"], shown["reason"]), ("", "Setting up this computer's desktop."),
                             "no sudo command while DGC can fetch them")
            self.plan({name: "1.0-1" for name in setup.DESKTOP_PACKAGES.values()})
            self.run_setup(setup.DESKTOP_PACKAGES.values())
            parts = pip_screen.components()
            self.assertEqual(parts["missing"], [])
            self.assertEqual(parts["prefix"], setup.current_root())
            self.assertEqual(pip_screen._inside(parts["found"]["dock"], parts["prefix"]), "/opt/desk/usr/bin/tint2")

    def test_a_failed_setup_falls_back_to_the_install_command(self):
        (self.state / "fail-update").write_text("1")
        self.run_setup(setup.DESKTOP_PACKAGES.values())
        with patch("shutil.which", side_effect=lambda name: None if name in pip_screen.PROGRAMS.values() else "/usr/bin/" + name):
            shown = pip_screen.availability()
        self.assertEqual(shown["install"], pip_screen.INSTALL)
        self.assertIn("Updating package lists failed", shown["reason"])

    def test_the_browser_box_runs_dgcs_chrome_with_the_libraries_it_brought(self):
        from dgc import pip_computer_box as box
        self.run_setup()
        (setup.current_root() / "usr/lib/aarch64-linux-gnu").mkdir(parents=True)
        with patch.object(box, "GOOGLE_CHROME", ("/nonexistent/chrome",)):
            chrome = box.find_chrome(self.home)
        self.assertEqual(chrome, setup.chrome_path())
        self.assertEqual(box.browser_name(chrome), "Google Chrome")
        argv = box.Box(home=self.home, egress_socket=self.home / "e.sock", chrome=chrome).argv(self.home / "f.py")
        joined = " ".join(argv)
        self.assertIn(f"--ro-bind {setup.current_root() / 'usr'} /opt/desk/usr", joined)
        self.assertIn("--setenv LD_LIBRARY_PATH /opt/desk/usr/lib/aarch64-linux-gnu", joined)
        other = box.Box(home=self.home, egress_socket=self.home / "e.sock", chrome=Path("/usr/lib/chromium/chromium")).argv(self.home / "f.py")
        self.assertNotIn("/opt/desk", " ".join(other), "a system browser needs none of it")

    def test_a_real_system_chrome_still_comes_first(self):
        from dgc import pip_computer_box as box
        self.run_setup()
        system = self.root / "opt-google-chrome"
        system.write_bytes(b"\x7fELFsystem")
        system.chmod(0o755)
        with patch.object(box, "GOOGLE_CHROME", (str(system),)):
            self.assertEqual(box.find_chrome(self.home), system)

    def test_one_setup_at_a_time(self):
        import fcntl
        base = self.home / "desktop" / "arm64"
        base.mkdir(parents=True)
        fd = os.open(base / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX)
        self.assertFalse(setup.start(needs=["tint2"]), "another process is setting it up")
        self.assertFalse(setup.due(), "and no check is due while it runs")


class UnsupportedTests(unittest.TestCase):
    def test_off_linux_or_without_apt_it_says_why(self):
        with patch.object(sys, "platform", "win32"):        # a Mac sets up a VM instead (test_pip_container)
            self.assertEqual(setup.supported(), (False, "The desktop download is for Linux."))
            self.assertEqual(setup.status()["state"], "unsupported")
        with patch.object(sys, "platform", "linux"), patch("shutil.which", side_effect=lambda n: None if n == "apt-get" else "/usr/bin/" + n):
            ok, why = setup.supported()
            self.assertFalse(ok)
            self.assertIn("apt-get", why)


if __name__ == "__main__":
    unittest.main()
