"""A Pip's computer shows Chinese, Japanese, Korean and emoji even where this machine has no such fonts.

Its setup (pip_screen_setup) fetches Noto's CJK and colour emoji fonts into DGC's own copy when this machine's
fontconfig has none, and both of the computer's boxes (its desktop and its browser) add DGC's fonts to the machine's own
through a fontconfig file of their own. A Mac's computer is a VM image that already carries them (pip_container).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_screen_setup as setup


def _host_font(pattern: str) -> Path | None:
    if not shutil.which("fc-list"):
        return None
    out = subprocess.run(["fc-list", pattern, "--format", "%{file}\n"], capture_output=True, text=True, timeout=20)
    files = [Path(line) for line in out.stdout.splitlines() if line.strip()]
    files = [f for f in files if f.is_file() and f.suffix.lower() in (".ttf", ".otf", ".ttc")]
    return min(files, key=lambda f: f.stat().st_size) if files else None


@unittest.skipUnless(sys.platform.startswith("linux"), "DGC's own desktop download is Linux with apt")
class FontsWantedTests(unittest.TestCase):
    def wanted(self, found):
        with patch("shutil.which", return_value="/usr/bin/present"), \
                patch("dgc.pip_computer_box._real_binary", return_value=True), \
                patch("dgc.pip_apps.consented", return_value=False), \
                patch.object(setup, "_font_found", side_effect=lambda pattern: found[pattern]):
            return setup.wanted()

    def test_a_machine_without_cjk_or_emoji_fonts_fetches_notos_for_its_pip_computers(self):
        names = self.wanted({pattern: False for _package, pattern in setup.FONT_PACKAGES})
        self.assertIn("fonts-noto-cjk", names)
        self.assertIn("fonts-noto-color-emoji", names)

    def test_a_machine_with_them_fetches_neither(self):
        names = self.wanted({pattern: True for _package, pattern in setup.FONT_PACKAGES})
        self.assertNotIn("fonts-noto-cjk", names)
        self.assertNotIn("fonts-noto-color-emoji", names)
        self.assertEqual(names, [], "a machine with everything fetches nothing")

    def test_only_what_is_missing(self):
        cjk, emoji = (pattern for _package, pattern in setup.FONT_PACKAGES)
        names = self.wanted({cjk: True, emoji: False})
        self.assertEqual(names, ["fonts-noto-color-emoji"])

    def test_the_check_asks_this_machines_fontconfig(self):
        """The real fc-list, pointed at a fontconfig with one folder: a Japanese font there is found, emoji is not."""
        font = _host_font(":lang=ja")
        if font is None:
            self.skipTest("this machine has no Japanese font to copy")
        with tempfile.TemporaryDirectory(prefix="dgc-fonts-") as temp:
            folder = Path(temp) / "fonts"
            folder.mkdir()
            shutil.copy(font, folder / font.name)
            conf = Path(temp) / "fonts.conf"
            conf.write_text('<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n'
                            f"<fontconfig><dir>{folder}</dir><cachedir>{temp}/cache</cachedir></fontconfig>\n")
            with patch.dict(os.environ, {"FONTCONFIG_FILE": str(conf)}):
                cjk, emoji = (pattern for _package, pattern in setup.FONT_PACKAGES)
                self.assertTrue(setup._font_found(cjk))
                if "emoji" not in font.name.lower():
                    self.assertFalse(setup._font_found(emoji))

    def test_without_fc_list_it_looks_in_the_font_folders(self):
        with tempfile.TemporaryDirectory(prefix="dgc-fonts-") as temp:
            share = Path(temp)
            (share / "opentype" / "noto").mkdir(parents=True)
            (share / "opentype" / "noto" / "NotoSansCJK-Regular.ttc").write_bytes(b"x")
            with patch("shutil.which", return_value=None), patch.object(setup, "FONT_FOLDERS", (share,)):
                cjk, emoji = (pattern for _package, pattern in setup.FONT_PACKAGES)
                self.assertTrue(setup._font_found(cjk))
                self.assertFalse(setup._font_found(emoji))


@unittest.skipUnless(sys.platform.startswith("linux"), "DGC's own desktop download is Linux with apt")
class FontsInBoxesTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-fonts-")
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name) / "desktop"
        self.root = self.home / "v-1" / "root"
        self.fonts = self.root / "usr" / "share" / "fonts"
        for p in (patch.object(setup, "current_root", return_value=self.root), patch.object(setup, "home", return_value=self.home)):
            p.start()
            self.addCleanup(p.stop)

    def test_no_fonts_of_dgcs_own_means_nothing_added(self):
        self.root.mkdir(parents=True)
        self.assertEqual(setup.font_args(), [])

    def test_dgcs_fonts_reach_a_box_through_its_own_fontconfig(self):
        (self.fonts / "opentype" / "noto").mkdir(parents=True)
        (self.fonts / "opentype" / "noto" / "NotoSansCJK-Regular.ttc").write_bytes(b"x")
        args = setup.font_args()
        joined = " ".join(args)
        self.assertIn(f"--ro-bind {self.fonts} {setup.FONTS_IN_BOX}", joined)
        self.assertIn(f"--setenv FONTCONFIG_FILE {setup.FONTS_CONF_IN_BOX}", joined)
        conf = Path(args[args.index(setup.FONTS_CONF_IN_BOX) - 1])
        text = conf.read_text()
        self.assertIn("<include ignore_missing=\"yes\">/etc/fonts/fonts.conf</include>", text, "the machine's own fonts stay")
        self.assertIn(f"<dir>{setup.FONTS_IN_BOX}</dir>", text)
        self.assertEqual(conf.stat().st_mode & 0o777, 0o644)

    def test_the_fontconfig_file_adds_a_folder_to_the_machines_own_fonts(self):
        """The real fc-list with that file (its folder pointed at a temp copy of one font): both are listed."""
        font = _host_font(":lang=en")
        if font is None:
            self.skipTest("no fc-list or no font here")
        with tempfile.TemporaryDirectory(prefix="dgc-fonts-") as temp:
            folder = Path(temp) / "mine"
            folder.mkdir()
            shutil.copy(font, folder / ("copy-" + font.name))
            conf = Path(temp) / "fonts.conf"
            conf.write_text(setup.fonts_conf(str(folder)))
            out = subprocess.run(["fc-list", "--format", "%{file}\n"], capture_output=True, text=True, timeout=60,
                                 env={**os.environ, "FONTCONFIG_FILE": str(conf), "HOME": temp, "XDG_CACHE_HOME": f"{temp}/cache"})
            files = out.stdout.splitlines()
            self.assertIn(str(folder / ("copy-" + font.name)), files, "DGC's folder is read")
            self.assertTrue(any(f.startswith("/usr/share/fonts") for f in files), "the machine's own fonts are still there")

    def test_both_boxes_of_a_computer_take_them(self):
        from dgc import pip_computer_box as box, pip_screen
        marker = ["--ro-bind", "/fonts-of-dgc", setup.FONTS_IN_BOX]
        with patch.object(setup, "font_args", return_value=marker):
            argv = box.Box(home=self.home, egress_socket=self.home / "e.sock", chrome=Path("/usr/bin/chromium")).argv(self.home / "f.py")
            self.assertIn("/fonts-of-dgc", argv, "the browser's box")
            self.assertLess(argv.index("/fonts-of-dgc"), argv.index("sh"))
            runtime = self.home / "rt"
            (runtime / "conf").mkdir(parents=True)
            parts = {"found": {k: Path("/usr/bin/" + k) for k in ("vnc", "wm", "dock", "files")}, "missing": [], "prefix": None}
            with patch.object(pip_screen, "availability", return_value={"available": True, "reason": "", "install": ""}), \
                    patch.object(pip_screen, "components", return_value=parts):
                desk = pip_screen.desktop_argv(runtime, self.home / "files", "Ava")
            self.assertIn("/fonts-of-dgc", desk, "the desktop's box")
            self.assertLess(desk.index("/fonts-of-dgc"), desk.index("sh"))


if __name__ == "__main__":
    unittest.main()
