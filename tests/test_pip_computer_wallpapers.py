"""Each of a Pip's computers wears its own wallpaper (asked 12 Nov: "if pip gets multi personal computers, each should
have a different wallpaper maybe by default"): the first Dusk (his pick), the second Aurora, the third Daylight (a light
one, so the desktop's icon labels turn dark), then round again. The same on a Mac's computer VM."""
import inspect
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dgc import pip_computer, pip_screen


def conf_for(number):
    conf = Path(tempfile.mkdtemp(prefix="dgc-walls-")) / "conf"
    with mock.patch("dgc.pip_apps.find", return_value=None):
        pip_screen.write_config(conf, "Pip", number=number)
    return conf


class Wallpapers(unittest.TestCase):
    def test_three_different_wallpapers_ship(self):
        files = [pip_screen.ASSETS / w.file for w in pip_screen.WALLPAPERS]
        self.assertEqual([f.name for f in files], ["wallpaper.jpg", "wallpaper-2.jpg", "wallpaper-3.jpg"])
        data = [f.read_bytes() for f in files]
        self.assertTrue(all(d[:3] == b"\xff\xd8\xff" for d in data), "JPEG images")
        self.assertEqual(len(set(data)), 3, "each different")

    def test_each_computer_its_own_then_round_again(self):
        for number, index in ((1, 0), (2, 1), (3, 2), (4, 0), (5, 1)):
            with self.subTest(number=number):
                conf = conf_for(number)
                chosen = pip_screen.ASSETS / pip_screen.WALLPAPERS[index].file
                self.assertEqual((conf / "wallpaper.jpg").read_bytes(), chosen.read_bytes())

    def test_a_light_wallpaper_gets_dark_icon_labels(self):
        items = lambda n: (conf_for(n) / "pcmanfm" / "dgc" / "desktop-items-0.conf").read_text()
        self.assertIn("desktop_fg=#ffffff", items(1))
        self.assertIn("desktop_fg=#ffffff", items(2))
        light = items(3)
        self.assertNotIn("desktop_fg=#ffffff", light)
        self.assertIn("desktop_fg=#1f1b2e", light)
        self.assertIn("wallpaper=/run/dgc/conf/wallpaper.jpg", light, "the same path the desktop reads")

    def test_the_desktop_is_made_with_its_computers_number(self):
        self.assertIn("number", inspect.signature(pip_screen.make_desktop).parameters)
        self.assertIn("number", inspect.signature(pip_screen.Desktop).parameters)
        desk = pip_screen.Desktop(Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp()), "Pip", number=2)
        self.assertEqual(desk.number, 2)
        made = []
        with mock.patch.object(pip_screen, "Desktop", side_effect=lambda *a, **k: made.append(k) or mock.Mock()):
            pip_screen.make_desktop(Path("/r"), Path("/f"), "Pip", number=3)
        self.assertEqual(made[0].get("number"), 3)
        self.assertIn('number=getattr(self, "number", 1)', inspect.getsource(pip_computer.Host.ensure_desktop))

    def test_a_computers_number_from_its_folder(self):
        state = Path(tempfile.mkdtemp())
        for number in (1, 2, 7):
            with self.subTest(number=number):
                root = pip_computer.computer_root(state, "pip_" + "a" * 32, number)
                self.assertEqual(pip_computer.computer_number(root), number)


if __name__ == "__main__":
    unittest.main()
