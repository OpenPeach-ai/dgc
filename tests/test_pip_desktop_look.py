"""pc-desktop (0.52, his list of 9 Nov after the OpenMausBot computer check): "A taskbar with the open windows, a clock
and the tray, labelled icons on the desktop for each app, and an app menu. Today a Pip's desktop is a dark wallpaper
and a dock, and a maximised browser covers it."

A bar at the top (a second tint2): an Apps button (a window of every app), the open windows, the tray and the clock.
Each app is a labelled icon on the desktop (in the box's own home, never the Pip's Files) and an item of the menu a
right-click on the desktop shows. The browser's window starts below the bar. The dock stays as it was.
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dgc import pip_screen


class DesktopLook(unittest.TestCase):
    def setUp(self):
        self.conf = Path(tempfile.mkdtemp(prefix="dgc-desk-")) / "conf"
        with mock.patch("dgc.pip_apps.find", return_value="/usr/bin/x"):
            pip_screen.write_config(self.conf, "Pip", ("images", "documents", "pdf"))

    def test_a_bar_at_the_top_with_apps_the_open_windows_the_tray_and_the_clock(self):
        bar = (self.conf / "topbar.rc").read_text()
        self.assertIn("panel_items = PTSC", bar)
        self.assertIn("panel_position = top center horizontal", bar)
        self.assertIn(f"panel_size = 100% {pip_screen.TOP_BAR}", bar)
        self.assertIn("button_text = Apps", bar)
        self.assertIn("button_lclick_command = pcmanfm --new-win /run/dgc/conf/apps", bar)
        self.assertIn("time1_format = %a %d %b  %H:%M", bar)
        self.assertIn("strut_policy = follow_size", bar, "a maximised window stays below it")
        script = (self.conf / "desktop.sh").read_text()
        self.assertIn('"$DESK_DOCK" -c /run/dgc/conf/topbar.rc', script)
        self.assertIn('"$DESK_DOCK" -c /tmp/config/tint2rc', script, "the dock stays (its day or night copy)")

    def test_each_app_is_a_labelled_icon_on_the_desktop_and_in_the_menu(self):
        names = sorted(p.read_text().split("Name=", 1)[1].split("\n", 1)[0] for p in (self.conf / "apps").glob("*.desktop"))
        self.assertEqual(names, ["Browser", "Documents", "Files", "Image editor", "PDF viewer", "Terminal"],
                         "short names under the icons")
        script = (self.conf / "desktop.sh").read_text()
        self.assertIn("cp \"$app\" /home/pip/Desktop/", script)
        self.assertNotIn("/home/pip/Files/Desktop", script, "never in the Pip's Files")
        menu = (self.conf / "menu.xml").read_text()
        for name in names:
            self.assertIn(f'label="{name}"', menu)
        self.assertIn("echo browser &gt; /run/dgc/sock/control", menu, "the browser through DGC, as the dock asks")
        openbox = (self.conf / "openbox.xml").read_text()
        self.assertIn("<file>/run/dgc/conf/menu.xml</file>", openbox)
        self.assertIn('<mousebind button="Right" action="Press"><action name="ShowMenu"><menu>root-menu</menu>', openbox)
        for look in ("light", "dark"):
            self.assertIn("show_wm_menu=1", (self.conf / "pcmanfm" / "dgc" / f"desktop-items-{look}.conf").read_text())
        self.assertIn("quick_exec=1", (self.conf / "libfm.conf").read_text(), "one click opens an app, no question")

    def test_the_mac_browser_also_starts_below_the_bar(self):
        from dgc import pip_container
        box = pip_container.ContainerBox.__new__(pip_container.ContainerBox)
        box.on_screen, box.viewport = True, (1280, 800)
        argv = " ".join(box.chrome_argv())
        self.assertIn(f"--window-position=0,{pip_screen.TOP_BAR}", argv)
        self.assertIn(f"--window-size=1280,{800 - pip_screen.TOP_BAR - pip_screen.BROWSER_STRIP}", argv)


if __name__ == "__main__":
    unittest.main()
