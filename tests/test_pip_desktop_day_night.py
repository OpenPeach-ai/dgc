"""A Pip computer's desktop (decided 16 Nov): it opens on the desktop, with no browser started; one wallpaper in two
versions, the teal one by day and the dark grey one by night, by this computer's clock; a rounded glass dock; smaller
icons on the desktop.

The day and night switch moments are worked out here, by DGC, from this computer's own clock, and written for the
desktop as plain seconds since 1970 (no time zone needed inside the box or the Mac's VM): the desktop reads them when it
starts and every minute after, and changes its wallpaper and dock when one passes."""
import os
import re
import subprocess
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from dgc import pip_computer, pip_screen


def conf_for(**kw):
    conf = Path(tempfile.mkdtemp(prefix="dgc-daynight-")) / "conf"
    with mock.patch("dgc.pip_apps.find", return_value=None):
        pip_screen.write_config(conf, "Pip", **kw)
    return conf


def in_zone(zone):
    """Run a block with this process's local time in ``zone``."""
    class Zone:
        def __enter__(self):
            self.old = os.environ.get("TZ")
            os.environ["TZ"] = zone
            time.tzset()

        def __exit__(self, *exc):
            if self.old is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = self.old
            time.tzset()
    return Zone()


def rc(text):
    """A tint2rc's settings, each by its first line (background 1, the bar, comes first)."""
    out = {}
    for line in text.splitlines():
        if " = " in line:
            key, value = line.split(" = ", 1)
            out.setdefault(key, value)
    return out


class OneWallpaperTwoVersions(unittest.TestCase):
    def test_one_wallpaper_ships_in_a_light_and_a_dark_version(self):
        self.assertEqual(set(pip_screen.WALLPAPERS), {"light", "dark"})
        light, dark = (pip_screen.ASSETS / pip_screen.WALLPAPERS[k] for k in ("light", "dark"))
        for picture in (light, dark):
            data = picture.read_bytes()
            self.assertEqual(data[:3], b"\xff\xd8\xff", f"{picture.name} is a JPEG")
            self.assertLess(len(data), 400_000, f"{picture.name} stays small in the package")
        self.assertNotEqual(light.read_bytes(), dark.read_bytes())

    def test_the_old_per_computer_wallpapers_are_gone(self):
        for old in ("wallpaper.jpg", "wallpaper-2.jpg", "wallpaper-3.jpg"):
            self.assertFalse((pip_screen.ASSETS / old).exists(), old)
        self.assertFalse(hasattr(pip_screen, "wallpaper_for"), "every computer wears the same one")

    def test_every_computer_gets_both_versions(self):
        conf = conf_for()
        for look in ("light", "dark"):
            self.assertEqual((conf / f"wallpaper-{look}.jpg").read_bytes(),
                             (pip_screen.ASSETS / pip_screen.WALLPAPERS[look]).read_bytes())
            items = (conf / "pcmanfm" / "dgc" / f"desktop-items-{look}.conf").read_text()
            self.assertIn(f"wallpaper=/run/dgc/conf/wallpaper-{look}.jpg", items)
            self.assertIn("wallpaper_mode=crop", items)


class DayAndNight(unittest.TestCase):
    def test_light_by_day_dark_by_night(self):
        self.assertEqual(pip_screen.look_for_hour(6), "dark")
        for hour in range(pip_screen.DAY[0], pip_screen.DAY[1]):
            self.assertEqual(pip_screen.look_for_hour(hour), "light", hour)
        self.assertEqual(pip_screen.look_for_hour(pip_screen.DAY[1]), "dark")
        self.assertEqual(pip_screen.look_for_hour(23), "dark")
        self.assertEqual(pip_screen.DAY, (7, 19))

    def test_the_switches_fall_at_this_computers_7_and_19(self):
        for zone in ("Asia/Kolkata", "America/New_York", "Europe/London", "UTC"):
            with self.subTest(zone=zone), in_zone(zone):
                start = time.mktime((2026, 11, 16, 12, 30, 0, 0, 0, -1))
                looks = pip_screen.look_switches(start, days=3)
                self.assertEqual(looks[0], (0, "light"), "it is day at 12:30: the first line says what is now")
                rest = looks[1:]
                self.assertEqual(len(rest), 6)
                self.assertTrue(all(a < b for (a, _), (b, _) in zip(rest, rest[1:])), "in order")
                self.assertGreater(rest[0][0], start)
                for at, look in rest:
                    local = time.localtime(at)
                    self.assertEqual((local.tm_hour, local.tm_min, local.tm_sec),
                                     (7, 0, 0) if look == "light" else (19, 0, 0))
                self.assertEqual([look for _, look in rest], ["dark", "light"] * 3)

    def test_a_clock_change_day_still_switches_at_7_and_19(self):
        with in_zone("America/New_York"):
            start = time.mktime((2026, 11, 1, 1, 0, 0, 0, 0, -1))        # the night the clocks go back
            looks = pip_screen.look_switches(start, days=2)
            self.assertEqual(looks[0], (0, "dark"))
            for at, look in looks[1:]:
                self.assertEqual(time.localtime(at).tm_hour, 7 if look == "light" else 19)

    def test_a_year_of_switches_is_written_for_the_desktop(self):
        with in_zone("Asia/Kolkata"), mock.patch.object(pip_screen.time, "time",
                                                         return_value=time.mktime((2026, 11, 16, 22, 0, 0, 0, 0, -1))):
            conf = conf_for()
        lines = (conf / "looks").read_text().splitlines()
        self.assertEqual(lines[0], "0 dark")
        self.assertGreaterEqual(len(lines), 1 + 2 * 365)
        for line in lines:
            self.assertRegex(line, r"^\d+ (light|dark)$")


class TheDesktopFollowsTheClock(unittest.TestCase):
    """The desktop's own piece of shell that reads the switch list, run here with sh."""

    def look_now(self, lines, now):
        looks = Path(tempfile.mkdtemp()) / "looks"
        looks.write_text("".join(f"{at} {look}\n" for at, look in lines))
        script = pip_screen.LOOK_NOW_SH + 'look_now\n'
        out = subprocess.run(["sh", "-c", script], env={"PATH": "/usr/bin:/bin", "LOOKS": str(looks), "NOW": str(now)},
                             capture_output=True, text=True, timeout=10)
        self.assertEqual(out.returncode, 0, out.stderr)
        return out.stdout.strip()

    def test_it_takes_the_last_switch_that_has_passed(self):
        lines = [(0, "light"), (1000, "dark"), (2000, "light"), (3000, "dark")]
        self.assertEqual(self.look_now(lines, 10), "light")
        self.assertEqual(self.look_now(lines, 1000), "dark")
        self.assertEqual(self.look_now(lines, 2500), "light")
        self.assertEqual(self.look_now(lines, 99999), "dark")

    def test_a_missing_or_broken_list_means_dark(self):
        out = subprocess.run(["sh", "-c", pip_screen.LOOK_NOW_SH + "look_now\n"],
                             env={"PATH": "/usr/bin:/bin", "LOOKS": "/nonexistent/looks"}, capture_output=True, text=True)
        self.assertEqual(out.stdout.strip(), "dark")
        self.assertEqual(self.look_now([(0, "purple")], 5), "dark", "only light or dark is ever used")

    def test_the_desktop_starts_in_the_look_of_now_and_checks_every_minute(self):
        sh = (conf_for() / "desktop.sh").read_text()
        self.assertIn(pip_screen.LOOK_NOW_SH.strip().splitlines()[0], sh)
        start = sh.index('look=$(look_now)')
        self.assertLess(start, sh.index('"$DESK_FILES" --desktop'), "the look is chosen before the desktop draws")
        self.assertLess(start, sh.index('"$DESK_DOCK" -c /tmp/config/tint2rc'), "and before the dock")
        self.assertIn("cp /run/dgc/conf/pcmanfm/dgc/desktop-items-$look.conf /tmp/config/pcmanfm/dgc/desktop-items-0.conf", sh)
        self.assertIn("cp /run/dgc/conf/tint2rc-$look /tmp/config/tint2rc", sh)
        self.assertIn("sleep 60", sh)
        self.assertIn('--set-wallpaper=/run/dgc/conf/wallpaper-$now.jpg', sh)
        self.assertIn('redraw_dock "$dock"', sh)
        self.assertNotIn("-c /run/dgc/conf/tint2rc ", sh, "the dock reads the copy that changes with the look")

    def test_after_a_switch_the_pointer_is_nudged_so_no_old_square_stays_under_it(self):
        """Seen live (16 Nov): a screen reader connected before the switch kept a square of the old wallpaper under the
        pointer until it moved."""
        sh = (conf_for() / "desktop.sh").read_text()
        switch = sh.index("--set-wallpaper=/run/dgc/conf/wallpaper-$now.jpg")
        self.assertIn("nudge_pointer() {", sh)
        self.assertGreater(sh.find("nudge_pointer\n", switch), switch, "nudged after the wallpaper changes")
        out = subprocess.run(["sh", "-c", pip_screen.NUDGE_SH + "nudge_pointer; echo done\n"],
                             env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True, timeout=20)
        self.assertEqual((out.returncode, out.stdout.strip()), (0, "done"), "harmless with no display")


class AGlassDock(unittest.TestCase):
    def test_the_dock_is_a_rounded_glass_bar_with_close_set_icons(self):
        conf = conf_for()
        light, dark = rc((conf / "tint2rc-light").read_text()), rc((conf / "tint2rc-dark").read_text())
        for look in (light, dark):
            self.assertGreaterEqual(int(look["rounded"]), 16)
            self.assertEqual(look["launcher_icon_size"], str(pip_screen.DOCK_ICON))
            self.assertGreaterEqual(pip_screen.DOCK_ICON, 46)
            self.assertLessEqual(pip_screen.DOCK_GAP, 8, "close-set icons")
            self.assertEqual(look["mouse_effects"], "1", "an icon lights up under the pointer")
            self.assertIn("mouse_hover_icon_asb", look)
            self.assertIn("mouse_pressed_icon_asb", look)
            self.assertEqual(look["panel_position"], "bottom center horizontal")
            self.assertEqual(look["panel_shrink"], "1")
        # By day a light frosted glass, by night a dark one (the alpha after the colour).
        bright = lambda colour: sum(int(colour[i:i + 2], 16) for i in (1, 3, 5)) / 3
        self.assertGreater(bright(light["background_color"].split()[0]), 200)
        self.assertLess(bright(dark["background_color"].split()[0]), 80)
        for look in (light, dark):
            colour, alpha = look["background_color"].split()
            self.assertLess(int(alpha), 80, "the wallpaper shows through")

    def test_the_pips_clicks_land_on_the_docks_icons(self):
        """dock_icon (the Pip clicks the dock by it) agrees with the dock's own numbers."""
        conf = conf_for(screen=(1440, 900))
        look = rc((conf / "tint2rc-dark").read_text())
        pad_h = int(look["panel_padding"].split()[0]) + int(look["launcher_padding"].split()[0])
        gap = int(look["launcher_padding"].split()[2])
        size = int(look["launcher_icon_size"])
        height = int(look["panel_size"].split()[1])
        margin = int(look["panel_margin"].split()[1])
        count = 3
        width = 2 * pad_h + count * size + (count - 1) * gap + 2 * int(look["border_width"])
        left = (1440 - width) // 2 + pad_h + int(look["border_width"])
        for index in range(count):
            self.assertEqual(pip_screen.dock_icon(index, count, (1440, 900)),
                             (left + index * (size + gap) + size // 2, 900 - margin - height // 2))
        self.assertEqual(pip_screen.dock_icon(1, 3), pip_screen.dock_icon(1, 3, (1280, 800)))


    def test_after_the_dock_redraws_the_wallpaper_is_set_again_so_its_corners_match(self):
        """Seen live (16 Nov): after the dock's reload it copied the screen's background for its glass while it still
        shrank to its icons, so the square corners around its rounded bar showed another part of the wallpaper (a teal
        square on the dark wave), at the start and at a switch. Measured on a real desktop: 76 levels apart; with the
        wallpaper set again a moment after the reload, the dock copies it once more where it stands: 1 apart."""
        sh = (conf_for() / "desktop.sh").read_text()
        body = sh[sh.index("redraw_dock() {"):sh.index("}", sh.index("redraw_dock() {"))]
        reload = body.index('kill -USR1 "$@"')
        again = body.index("--set-wallpaper=/run/dgc/conf/wallpaper-$look.jpg --wallpaper-mode=crop")
        self.assertLess(reload, body.index("sleep 1"), body)
        self.assertLess(body.index("sleep 1"), again, "the wallpaper again once the dock stands where it stays")
        start = sh.index('sleep 2; redraw_dock "$dock" "$topbar"')
        self.assertLess(sh.index('"$DESK_DOCK" -c /tmp/config/tint2rc'), start, "at the start, after the dock is up")
        switch = sh[sh.index("while sleep 60"):]
        self.assertLess(switch.index("look=$now"), switch.index('redraw_dock "$dock"'), "at a switch, in the new look")
        self.assertNotIn("kill -USR1", sh.replace('kill -USR1 "$@"', ""), "every redraw goes through redraw_dock")


class SmallerDesktopIcons(unittest.TestCase):
    def test_the_desktops_icons_and_labels_are_smaller(self):
        conf = conf_for()
        libfm = (conf / "libfm.conf").read_text()
        size = int(re.search(r"big_icon_size=(\d+)", libfm).group(1))
        self.assertLessEqual(size, 36, "they were 48 and looked too big")
        self.assertGreaterEqual(size, 32)
        for look in ("light", "dark"):
            items = (conf / "pcmanfm" / "dgc" / f"desktop-items-{look}.conf").read_text()
            self.assertIn("desktop_font=Sans 9", items)
            self.assertIn("desktop_fg=#ffffff", items, "both versions are dark enough for white labels")
            self.assertIn("desktop_shadow=#000000", items)


class OpensOnTheDesktop(unittest.TestCase):
    """Decided 16 Nov: the computer opens on its desktop; the Pip or the user opens the browser when it's wanted."""

    def host(self, root, started):
        browser = types.SimpleNamespace(display_dir=None, start=lambda: started.append("browser"), close=lambda: None,
                                        window_size=None)
        from dgc.pip_computer_files import files_root
        return types.SimpleNamespace(lock=threading.RLock(), desktop=None, pip_id="pip_" + "a" * 32, root=root,
                                     tag="a" * 12, files_dir=files_root(root),
                                     proxy=types.SimpleNamespace(path=root / "egress.sock"), browser=browser,
                                     _dock_launch=lambda what: None, _launch=lambda start: start(), _pump_thread=object())

    def test_the_screen_starts_without_the_browser(self):
        root = Path(tempfile.mkdtemp()); self.addCleanup(__import__("shutil").rmtree, root, True)
        started = []
        host = self.host(root, started)

        class Screen:
            size = (1280, 800)

            def __init__(self, runtime):
                self.x11_dir = runtime / "x11"
                self.on_launch = None

            def start(self, launch):
                started.append("screen")

            def running(self):
                return True
        with mock.patch.object(pip_screen, "availability", return_value={"available": True, "reason": ""}), \
                mock.patch.object(pip_screen, "make_desktop", lambda runtime, files, name, egress=None, size=None: Screen(runtime)):
            self.assertTrue(pip_computer.Host.ensure_desktop(host))
        self.assertEqual(started, ["screen"], "only the screen: no browser window waits on it")
        self.assertEqual(host.browser.display_dir, host.desktop.x11_dir, "the browser draws on this screen when it opens")

    def test_asked_about_a_browser_not_open_yet_the_pip_hears_how_to_open_it(self):
        host = types.SimpleNamespace(lock=threading.RLock(), last_used=0, waiting=False,
                                     browser=types.SimpleNamespace(alive=lambda: False, held=None))
        said = pip_computer.Host._act(host, "status", {})["text"]
        self.assertIn("isn't open", said)
        self.assertIn("starts on its desktop", said)
        self.assertIn("open a page", said.lower())
        self.assertIn("isn't open", pip_computer.Host._act(host, "tabs", {})["text"])

    def test_the_dock_still_opens_the_browser(self):
        started = []
        browser = types.SimpleNamespace(alive=lambda: False, close=lambda: None, start=lambda: started.append("browser"))
        host = types.SimpleNamespace(lock=threading.RLock(), browser=browser, browser_closed_by_request=False)
        pip_computer.Host._dock_launch(host, "browser")
        self.assertEqual(started, ["browser"])



class EveryComputerTheSame(unittest.TestCase):
    """A Pip's second and third computers wear the same wallpaper as its first (each had its own until 16 Nov); a
    computer still knows its number from its folder, for its name and sockets."""

    def test_the_desktop_no_longer_takes_a_computers_number(self):
        import inspect
        for made in (pip_screen.make_desktop, pip_screen.Desktop, pip_screen.write_config):
            self.assertNotIn("number", inspect.signature(made).parameters)

    def test_a_computers_number_from_its_folder(self):
        state = Path(tempfile.mkdtemp())
        for number in (1, 2, 7):
            with self.subTest(number=number):
                root = pip_computer.computer_root(state, "pip_" + "a" * 32, number)
                self.assertEqual(pip_computer.computer_number(root), number)


if __name__ == "__main__":
    unittest.main()
