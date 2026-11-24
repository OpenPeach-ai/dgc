"""Your Browser opens Chrome on its own profile, never on Chrome's profile picker (25 Nov, the owner's machine: its data
folder held two Chrome profiles, "Default", a week of use, and "Profile 1", made at 19:00 by a sign-in or profile prompt,
so Chrome opened its profile picker, no tab came, and Your Browser gave up after 15 s with "its window never opened":
"Opening Your Browser…" for ever). It always opens Default, where its sign-ins are."""
import tempfile
import unittest
from pathlib import Path

from dgc.your_browser import chrome_argv


class ProfileDirectoryTests(unittest.TestCase):
    def test_always_its_own_profile(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "Default").mkdir(); (root / "Profile 1").mkdir()
            for argv in (chrome_argv("/chrome", root), chrome_argv("/chrome", root, headless=True),
                         chrome_argv("/chrome", root, headless=True, virtual=True)):
                self.assertIn("--profile-directory=Default", argv, "never the picker, never the newer stray profile")
                self.assertEqual(sum(a.startswith("--profile-directory") for a in argv), 1)


if __name__ == "__main__":
    unittest.main()
