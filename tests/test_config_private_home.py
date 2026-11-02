"""A first configuration save must create private state before Pips Controls reads it."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class PrivateHomeTest(unittest.TestCase):
    def test_first_save_creates_owner_only_dgc_directory(self):
        with tempfile.TemporaryDirectory() as home:
            root = Path(home)
            (root / "project").mkdir()
            env = {**os.environ, "HOME": home, "USERPROFILE": home,
                   "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
            result = subprocess.run(
                [sys.executable, "-c",
                 "from dgc.config import Config; from pathlib import Path; "
                 "Config(Path.home() / 'project').set('thinking', 'high')"],
                env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / ".dgc").stat().st_mode & 0o777, 0o700)

    def test_old_world_readable_dgc_directory_is_narrowed_on_load(self):
        if os.name != "posix":
            self.skipTest("POSIX permissions")
        with tempfile.TemporaryDirectory() as home:
            root = Path(home)
            (root / "project").mkdir()
            old = root / ".dgc"
            old.mkdir(mode=0o755)
            old.chmod(0o755)
            env = {**os.environ, "HOME": home, "USERPROFILE": home,
                   "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
            result = subprocess.run(
                [sys.executable, "-c", "from dgc.config import Config; from pathlib import Path; "
                 "Config(Path.home() / 'project')"],
                env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(old.stat().st_mode & 0o777, 0o700)

    def test_permission_repair_does_not_follow_dgc_symlink(self):
        if os.name != "posix":
            self.skipTest("POSIX permissions")
        with tempfile.TemporaryDirectory() as home:
            root = Path(home)
            (root / "project").mkdir()
            target = root / "other-directory"
            target.mkdir(mode=0o755)
            target.chmod(0o755)
            (root / ".dgc").symlink_to(target, target_is_directory=True)
            env = {**os.environ, "HOME": home, "USERPROFILE": home,
                   "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
            result = subprocess.run(
                [sys.executable, "-c", "from dgc.config import Config; from pathlib import Path; "
                 "Config(Path.home() / 'project')"],
                env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(target.stat().st_mode & 0o777, 0o755)


if __name__ == "__main__":
    unittest.main()
