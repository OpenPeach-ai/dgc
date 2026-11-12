"""pc-vscode-terminal, the terminal half (his list of 9 Nov): "a modern terminal in place of xterm".

A Pip's desktop opens lxterminal (GTK 3, so it wears the desktop's dark theme; no session bus needed, unlike GNOME's)
when the machine or DGC's own download has it, with xterm's colours, size and folder; xterm stays the fallback, so a
computer is never blocked waiting for it. The desktop setup fetches lxterminal with the desktop's other packages. The
Mac's image keeps xterm for now (its image is built from its own recipe).
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dgc import pip_screen, pip_screen_setup


class Terminal(unittest.TestCase):
    def conf(self, have_lxterminal):
        conf = Path(tempfile.mkdtemp(prefix="dgc-desk-")) / "conf"
        real_which = pip_screen.shutil.which
        which = lambda name, *a, **k: ("/usr/bin/lxterminal" if have_lxterminal else None) if name == "lxterminal" else real_which(name, *a, **k)
        with mock.patch("dgc.pip_apps.find", return_value="/usr/bin/x"), mock.patch.object(pip_screen, "_prefix", lambda: None), \
                mock.patch.object(pip_screen.shutil, "which", which):
            pip_screen.write_config(conf, "Pip", ())
        return conf

    def test_lxterminal_when_the_machine_has_it(self):
        conf = self.conf(True)
        entry = (conf / "apps" / "terminal.desktop").read_text()
        self.assertIn("lxterminal --working-directory=/home/pip/Files", entry)
        self.assertNotIn("exec xterm", entry)       # ("lxterminal" holds the letters "xterm" itself)
        script = (conf / "desktop.sh").read_text()
        self.assertIn("lxterminal --working-directory=/home/pip/Files", script, "the Pip's launch_app opens the same one")
        self.assertIn("cp /run/dgc/conf/lxterminal.conf /tmp/config/lxterminal/lxterminal.conf", script)
        settings = (conf / "lxterminal.conf").read_text()
        for line in ("bgcolor=#1d2430", "fgcolor=#e6edf3", "fontname=Monospace 11", "hidemenubar=true",
                     "geometry_columns=100", "geometry_rows=28"):
            self.assertIn(line, settings)

    def test_xterm_when_it_doesnt(self):
        entry = (self.conf(False) / "apps" / "terminal.desktop").read_text()
        self.assertIn("exec xterm", entry)

    def test_the_setup_fetches_it_with_the_desktop(self):
        real_which = pip_screen_setup.shutil.which
        with mock.patch.object(pip_screen_setup.sys, "platform", "linux"), \
                mock.patch.object(pip_screen_setup.shutil, "which",
                                  lambda name, *a, **k: None if name == "lxterminal" else real_which(name, *a, **k)):
            self.assertIn("lxterminal", pip_screen_setup.wanted())

    def test_the_mac_image_keeps_xterm(self):
        self.assertEqual(pip_screen.terminal_command(mac=True), pip_screen.XTERM_COMMAND)


if __name__ == "__main__":
    unittest.main()
