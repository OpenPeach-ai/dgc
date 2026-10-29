"""A tracked link cannot become a release payload or redirect content scanning."""
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1] / "scripts/check-public-content.py"
SPEC = importlib.util.spec_from_file_location("check_public_content", SOURCE)
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class PublicContentSymlinkTests(unittest.TestCase):
    def test_tracked_symlink_is_rejected_without_reading_its_target(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / "dgc").mkdir()
            target = root / "outside.txt"
            target.write_text("private fixture")
            link = root / "dgc" / "linked.py"
            link.symlink_to(target)
            subprocess.run(["git", "add", "dgc/linked.py"], cwd=root, check=True)
            errors = CHECKER.check(root)
            self.assertTrue(any("symlink" in error or "link" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
