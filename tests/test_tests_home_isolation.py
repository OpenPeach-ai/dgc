"""A test module run alone gets its own home, as the whole suite does (tests/__init__.py; 13 Nov 2026: single runs had
filled a developer's real ~/.dgc with thousands of temporary projects)."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def home_seen(home: str) -> str:
    env = {key: value for key, value in os.environ.items() if key != "DGC_HOME"}
    env["HOME"] = home
    run = subprocess.run([sys.executable, "-c", "import tests, os; print(os.environ['HOME'])"], cwd=ROOT, env=env,
                         capture_output=True, text=True, timeout=60)
    return run.stdout.strip()


class OwnHome(unittest.TestCase):
    def test_the_account_home_is_replaced(self):
        try:
            import pwd
            account = os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)
        except ImportError:
            self.skipTest("no pwd here")
        seen = home_seen(account)
        self.assertNotEqual(seen, account)
        self.assertIn("dgc-tests-home-", seen)

    def test_a_home_already_given_is_left_alone(self):
        with tempfile.TemporaryDirectory() as given:
            self.assertEqual(home_seen(os.path.realpath(given)), os.path.realpath(given))


if __name__ == "__main__":
    unittest.main()
