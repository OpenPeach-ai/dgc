"""pc-fills-tab (0.52, his list of 9 Nov): "The computer's screen fills the editor tab ... larger sizes (1440x900,
1920x1080) are on offer. Today it is fixed at 1280x800."

The backend half: a Pip's computers have a screen size, one of 1280x800 (everyone's to begin with), 1440x900 and
1920x1080 (set_pip_computer_screen, local only), taken as each screen next starts: the display is that size, the
dock sits at its foot, the browser's window fills it above the dock, and what the Pip is told about the screen says it.
"""
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from dgc import pip_computer, pip_screen
from dgc.workspace_registry import RegistryError
from tests.test_pip_levels import Store


class ScreenSize(Store):
    def setUp(self):
        super().setUp()
        self.pip = self.personal(computer=True)

    def status(self):
        return self.control("get_pip_computer", pip_id=self.pip["id"])["computer"]

    def test_it_starts_at_1280x800_and_takes_a_larger_size(self):
        shown = self.status()
        self.assertEqual(shown["screen"], "1280x800")
        self.assertEqual(shown["screens"], ["1280x800", "1440x900", "1920x1080"])
        self.assertEqual(self.control("set_pip_computer_screen", pip_id=self.pip["id"], size="1920x1080")["screen"], "1920x1080")
        self.assertEqual(self.status()["screen"], "1920x1080")
        self.assertEqual(pip_computer.computer_screen(self.registry.db, self.pip["id"]), (1920, 1080))

    def test_only_the_sizes_on_offer_and_only_here(self):
        for bad in ("1000x700", "1920X1080", "", None, 1440):
            with self.assertRaises(RegistryError, msg=repr(bad)):
                self.control("set_pip_computer_screen", pip_id=self.pip["id"], size=bad)
        with self.assertRaises(RegistryError) as caught:
            self.control("set_pip_computer_screen", actor="device_1", pip_id=self.pip["id"], size="1440x900")
        self.assertEqual(caught.exception.code, "local_only")

    def test_a_host_reads_its_size_as_its_screen_starts(self):
        self.control("set_pip_computer_screen", pip_id=self.pip["id"], size="1440x900")
        host = types.SimpleNamespace(state_directory=self.registry.directory, pip_id=self.pip["id"], desktop=None)
        self.assertEqual(pip_computer.Host._screen_size(host), (1440, 900))
        self.assertEqual(pip_computer.Host.screen(host), (1280, 800), "none showing yet")
        host.desktop = types.SimpleNamespace(size=(1440, 900))
        self.assertEqual(pip_computer.Host.screen(host), (1440, 900))


class TheScreenItself(unittest.TestCase):
    def test_the_display_and_the_dock_follow_the_size(self):
        conf = Path(tempfile.mkdtemp(prefix="dgc-screen-")) / "conf"
        with mock.patch("dgc.pip_apps.find", return_value=None):
            pip_screen.write_config(conf, "Pip", (), (1920, 1080))
        self.assertIn("-geometry 1920x1080", (conf / "desktop.sh").read_text())
        self.assertEqual(pip_screen.dock_icon(0, 3, (1920, 1080))[1], 1080 - 42)
        self.assertEqual(pip_screen.dock_icon(1, 3), pip_screen.dock_icon(1, 3, (1280, 800)), "the old size by default")
        self.assertGreater(pip_screen.dock_icon(1, 3, (1920, 1080))[0], pip_screen.dock_icon(1, 3)[0], "centred on the wider screen")

    def test_a_desktop_keeps_only_a_size_on_offer(self):
        root = Path(tempfile.mkdtemp(prefix="dgc-screen-"))
        self.assertEqual(pip_screen.Desktop(root, root, "Pip", size=(1440, 900)).size, (1440, 900))
        self.assertEqual(pip_screen.Desktop(root, root, "Pip", size=(999, 999)).size, (1280, 800))

    def test_the_browser_window_fills_the_screen_above_the_dock(self):
        from dgc import pip_computer_box as box
        temp = Path(tempfile.mkdtemp(prefix="dgc-screen-"))
        chrome = temp / "chrome" / "chrome"
        plain = box.Box(temp, temp / "e.sock", chrome, display_dir=temp / "x11")
        self.assertIn("--window-size=1280,724", " ".join(plain.argv(temp / "forward.py")), "as before when none is set")
        sized = box.Box(temp, temp / "e.sock", chrome, display_dir=temp / "x11",
                        window_size=(1920, 1080 - pip_screen.BROWSER_STRIP))
        self.assertIn("--window-size=1920,1004", " ".join(sized.argv(temp / "forward.py")))
        # And the browser hands the Box the size its Host gave it (pip_computer.Host.ensure_desktop).
        source = Path(box.__file__).read_text()
        self.assertIn('window_size=getattr(self, "window_size", None)', source)


if __name__ == "__main__":
    unittest.main()
