"""pc-look, the rest (0.52, the list of 9 Nov): "a modern window and app theme, an icon theme ... so the file manager
and LibreOffice stop looking dated."

A Pip's desktop takes the best dark theme the machine has: Yaru's purple dark (DGC's colour), else Yaru dark, else
Adwaita dark, which every GTK 3 has built in; its icons the same way. GTK 3 and GTK 2 apps (the file manager) read it,
and LibreOffice follows GTK with its dark icons. Nothing is downloaded for it.
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dgc import pip_screen


def share(*themes, icons=()):
    root = Path(tempfile.mkdtemp(prefix="dgc-share-"))
    for name in themes:
        (root / "themes" / name / "gtk-3.0").mkdir(parents=True)
    for name in icons:
        (root / "icons" / name).mkdir(parents=True)
        (root / "icons" / name / "index.theme").write_text("[Icon Theme]\n")
    return root


class DesktopTheme(unittest.TestCase):
    def conf(self, root):
        conf = Path(tempfile.mkdtemp(prefix="dgc-desk-")) / "conf"
        with mock.patch("dgc.pip_apps.find", return_value="/usr/bin/x"), \
                mock.patch.object(pip_screen, "SHARES", (root,)):
            pip_screen.write_config(conf, "Pip", ("documents",))
        return conf

    def test_the_best_dark_theme_and_icons_the_machine_has(self):
        conf = self.conf(share("Yaru-dark", "Yaru-purple-dark", icons=("Yaru", "Yaru-purple-dark")))
        gtk3 = (conf / "gtk-3.0" / "settings.ini").read_text()
        self.assertIn("gtk-theme-name=Yaru-purple-dark", gtk3)
        self.assertIn("gtk-icon-theme-name=Yaru-purple-dark", gtk3)
        self.assertIn("gtk-application-prefer-dark-theme=1", gtk3)
        gtk2 = (conf / "gtkrc-2.0").read_text()
        self.assertIn('gtk-theme-name="Yaru-purple-dark"', gtk2)
        self.assertIn('gtk-icon-theme-name="Yaru-purple-dark"', gtk2)

    def test_without_yaru_adwaita_dark_which_gtk_has_built_in(self):
        conf = self.conf(share(icons=("Adwaita",)))
        gtk3 = (conf / "gtk-3.0" / "settings.ini").read_text()
        self.assertIn("gtk-theme-name=Adwaita-dark", gtk3)
        self.assertIn("gtk-icon-theme-name=Adwaita", gtk3)

    def test_the_desktop_reads_it(self):
        conf = self.conf(share("Yaru-purple-dark", icons=("Yaru-purple-dark",)))
        script = (conf / "desktop.sh").read_text()
        self.assertIn("cp -r /run/dgc/conf/gtk-3.0 /tmp/config/gtk-3.0", script)
        self.assertIn("GTK2_RC_FILES=/run/dgc/conf/gtkrc-2.0", script)

    def test_libreoffice_and_the_pdf_viewer_read_it_too(self):
        from dgc import pip_apps
        root = share("Yaru-purple-dark", icons=("Yaru-purple-dark",))
        config = Path(tempfile.mkdtemp(prefix="dgc-app-"))
        with mock.patch.object(pip_screen, "SHARES", (root,)):
            pip_apps.seed_settings(config)
        self.assertIn("gtk-theme-name=Yaru-purple-dark", (config / "gtk-3.0" / "settings.ini").read_text())
        profile = (config / "libreoffice" / "user" / "registrymodifications.xcu").read_text()
        self.assertIn('<prop oor:name="SymbolStyle" oor:op="fuse"><value>colibre_dark</value></prop>', profile)
        with mock.patch.object(pip_apps, "find", return_value={"source": "system"}):
            argv = pip_apps.box_argv("documents", x11_dir=config, files=config, config=config)
        at = argv.index("SAL_USE_VCLPLUGIN")
        self.assertEqual((argv[at - 1], argv[at + 1]), ("--setenv", "gtk3"), "LibreOffice follows GTK")

if __name__ == "__main__":
    unittest.main()
