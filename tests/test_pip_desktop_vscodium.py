"""pc-vscode-terminal, the VSCodium half (his list of 9 Nov): "VSCodium on every Pip's computer, on the dock and
openable by the Pip ... installed pinned, the way Chrome is".

VSCodium (the open-source build of VS Code, his choice of 9 Nov) is a code editor among the computer's apps. Its
package is about 143 MB, so it is one of the apps DGC offers to download (as LibreOffice is), never part of the
desktop: from VSCodium's own apt repository, trusted only through its signing key, whose fingerprint is pinned here,
and checked by apt like every package. It runs in an app's box like the others: the system read-only, Files and its
own settings folder, Electron's own sandbox off inside DGC's, updates and telemetry off.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dgc import pip_apps, pip_computer, pip_screen, pip_screen_setup

ELF = b"\x7fELF" + b"\0" * 60


def _root():
    root = Path(tempfile.mkdtemp(prefix="dgc-desk-root-"))
    program = root / "usr" / "share" / "codium" / "codium"
    program.parent.mkdir(parents=True)
    program.write_bytes(ELF)
    return root


class TheApp(unittest.TestCase):
    def test_a_code_editor_among_the_apps(self):
        app = pip_apps.APPS["code"]
        self.assertEqual((app["name"], app["program"], app["packages"], app["icon"]),
                         ("Code editor", "VSCodium", ["codium"], "code.png"))
        self.assertTrue((Path(pip_screen.ASSETS) / "code.png").is_file(), "its dock icon ships")
        self.assertIn("code", pip_computer.APP_KEYS, "the Pip can open it")
        self.assertIn("code", pip_screen.CONTROL_LINES, "the dock can open it")
        self.assertEqual(pip_apps.app_for("Files/site/app.py"), "code")
        self.assertEqual(pip_apps.app_for("notes.md"), "documents", "a document still opens in Documents")

    def test_where_it_is(self):
        root = _root()
        with mock.patch.object(pip_apps.sys, "platform", "linux"), mock.patch.object(pip_apps, "CODIUM", root / "none"), \
                mock.patch.object(pip_apps, "_downloaded_root", lambda: root):
            self.assertEqual(pip_apps.find("code"), {"source": "dgc", "root": root})
        system = root / "usr" / "share" / "codium" / "codium"
        with mock.patch.object(pip_apps.sys, "platform", "linux"), mock.patch.object(pip_apps, "CODIUM", system):
            self.assertEqual(pip_apps.find("code"), {"source": "system"})
        with mock.patch.object(pip_apps.sys, "platform", "linux"), mock.patch.object(pip_apps, "CODIUM", root / "none"), \
                mock.patch.object(pip_apps, "_downloaded_root", lambda: None):
            self.assertIsNone(pip_apps.find("code"))

    def test_it_is_downloaded_even_where_the_system_has_libreoffice(self):
        lo = Path(tempfile.mkdtemp(prefix="dgc-lo-"))
        (lo / "program").mkdir()
        (lo / "program" / "soffice").write_bytes(ELF)
        with mock.patch.object(pip_apps, "LIBREOFFICE", lo):
            self.assertEqual(pip_apps.wanted_packages(["images", "code"]), ["codium"])

    def test_the_offer_says_what_and_from_where(self):
        lo = Path(tempfile.mkdtemp(prefix="dgc-lo-"))
        with mock.patch.object(pip_apps, "missing", lambda: ["code"]), mock.patch.object(pip_apps, "LIBREOFFICE", lo), \
                mock.patch.object(pip_apps, "_read_offer", lambda: {"measured": {"bytes": 151_000_000}}), \
                mock.patch.object(pip_apps, "status", lambda: []), \
                mock.patch("dgc.pip_screen_setup.supported", lambda: (True, "")), \
                mock.patch("dgc.pip_screen_setup.status", lambda: {"state": "ready", "error": ""}):
            offer = pip_apps.offer()
        self.assertEqual(offer["state"], "offer")
        self.assertIn("a code editor", offer["line"])
        self.assertIn("VSCodium", offer["line"])
        self.assertIn("151 MB", offer["line"])
        self.assertIn("VSCodium's own", offer["line"], "not the system's package servers")
        # Seen live (12 Nov): "from VSCodium's own, its signing key checked into its own folder" read as nonsense.
        self.assertIn("DGC downloads VSCodium from VSCodium's own package server (its signing key checked) into its own "
                      "folder: 151 MB, once.", offer["line"])


class ItsBox(unittest.TestCase):
    def argv(self, **extra):
        root = _root()
        work = Path(tempfile.mkdtemp(prefix="dgc-app-"))
        with mock.patch.object(pip_apps, "find", lambda key: {"source": "dgc", "root": root}):
            return pip_apps.box_argv("code", x11_dir=work / "x11", files=work / "Files", config=work / ".apps",
                                     file="/home/pip/Files/site/app.py", **extra)

    def test_electron_inside_dgcs_box(self):
        argv = self.argv()
        self.assertIn("--unshare-all", argv)
        program = argv.index("/opt/desk/usr/share/codium/codium")
        flags = argv[program + 1:]
        for flag in ("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
                     "--user-data-dir=/home/pip/.config/codium", "--extensions-dir=/home/pip/.config/codium-extensions"):
            self.assertIn(flag, flags)
        self.assertEqual(flags[-2:], ["/home/pip/Files", "/home/pip/Files/site/app.py"], "its Files open, then the file")
        self.assertNotIn("--share-net", argv, "no network unless the computer gives it its egress")

    def test_its_settings_turn_off_updates_and_telemetry(self):
        config = Path(tempfile.mkdtemp(prefix="dgc-apps-"))
        pip_apps.seed_settings(config)
        settings = json.loads((config / "codium" / "User" / "settings.json").read_text())
        self.assertEqual(settings["update.mode"], "none")
        self.assertEqual(settings["telemetry.telemetryLevel"], "off")
        self.assertFalse(settings["extensions.autoUpdate"])
        self.assertFalse(settings["security.workspace.trust.enabled"])

    def test_on_the_dock(self):
        conf = Path(tempfile.mkdtemp(prefix="dgc-desk-")) / "conf"
        with mock.patch.object(pip_screen, "_prefix", lambda: None):
            pip_screen.write_config(conf, "Pip", ["code"])
        entry = (conf / "apps" / "code.desktop").read_text()
        self.assertIn("Name=Code editor", entry)
        self.assertIn("echo code > /run/dgc/sock/control", entry)
        self.assertTrue((conf / "code.png").is_file())


class FromItsOwnRepository(unittest.TestCase):
    def fetch(self, fingerprint):
        target = Path(tempfile.mkdtemp(prefix="dgc-apt-")) / "vscodium.asc"
        key = mock.MagicMock()
        key.__enter__.return_value.read.return_value = b"-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n"
        shown = mock.Mock(stdout=f"pub:-:4096:1:x:1:::-:::scSC::::::23::0:\nfpr:::::::::{fingerprint}:\n".encode())
        with mock.patch.object(pip_screen_setup.urllib.request, "urlopen", return_value=key) as opened, \
                mock.patch.object(pip_screen_setup.subprocess, "run", return_value=shown):
            try:
                pip_screen_setup._vscodium_key(target)
            finally:
                self.assertEqual(opened.call_args[0][0], pip_screen_setup.VSCODIUM_KEY_URL)
        return target

    def test_the_key_is_trusted_only_by_its_pinned_fingerprint(self):
        self.assertEqual(pip_screen_setup.VSCODIUM_KEY_FINGERPRINT, "1302DE60231889FE1EBACADC54678CF75A278D9C")
        self.assertTrue(self.fetch(pip_screen_setup.VSCODIUM_KEY_FINGERPRINT).is_file())
        with self.assertRaisesRegex(RuntimeError, "VSCodium"):
            self.fetch("0" * 40)

    def setUp(self):
        status = mock.patch.object(pip_screen_setup, "_write_status", lambda **fields: None)   # never the real home's
        status.start()
        self.addCleanup(status.stop)

    def test_its_repository_is_added_only_while_it_is_wanted(self):
        apt = Path(tempfile.mkdtemp(prefix="dgc-apt-"))
        (apt / "parts").mkdir()
        with mock.patch.object(pip_screen_setup, "_vscodium_key", lambda target: target.write_text("key")), \
                mock.patch.object(pip_screen_setup, "arch", lambda: "arm64"):
            pip_screen_setup._extra_sources(apt, ["xterm"], wanted_apps=[])
            self.assertFalse((apt / "parts" / "vscodium.list").exists())
            pip_screen_setup._extra_sources(apt, ["xterm"], wanted_apps=["codium"])
        line = (apt / "parts" / "vscodium.list").read_text()
        self.assertEqual(line, f"deb [arch=arm64 signed-by={apt / 'vscodium.asc'}] https://download.vscodium.com/debs "
                               "vscodium main\n")

    def test_its_key_failing_never_stops_the_desktop_only_the_download_asked_for(self):
        apt = Path(tempfile.mkdtemp(prefix="dgc-apt-"))
        (apt / "parts").mkdir()

        def refused(target):
            raise RuntimeError("VSCodium's signing key is not the one DGC trusts; VSCodium was not downloaded.")
        with mock.patch.object(pip_screen_setup, "_vscodium_key", refused), mock.patch.object(pip_screen_setup, "arch", lambda: "arm64"):
            pip_screen_setup._extra_sources(apt, ["xterm"], wanted_apps=["codium"])     # only measuring the offer
            self.assertFalse((apt / "parts" / "vscodium.list").exists())
            with self.assertRaisesRegex(RuntimeError, "VSCodium"):
                pip_screen_setup._extra_sources(apt, ["xterm", "codium"], wanted_apps=[])


if __name__ == "__main__":
    unittest.main()
