"""Integration never counts interpreter or test-runner caches as a child's work."""
import subprocess
import tempfile
import unittest
from pathlib import Path

from dgc import worktree


class CachePathsTests(unittest.TestCase):
    def test_caches_in_a_repo_that_does_not_ignore_them_are_not_dirty(self):
        with tempfile.TemporaryDirectory(prefix="dgc-worktree-caches-") as directory:
            root = Path(directory)
            git = lambda *args: subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
            git("init", "-q"); git("config", "user.email", "t@dgc.invalid"); git("config", "user.name", "T")
            (root / "shop").mkdir()
            (root / "shop" / "cart.py").write_text("x = 1\n")
            git("add", "."); git("commit", "-qm", "base")
            base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()
            (root / "shop" / "cart.py").write_text("x = 2\n")                     # the child's real work
            (root / "shop" / "tax.py").write_text("RATE = 0.2\n")
            for cache in ("shop/__pycache__/cart.cpython-312.pyc", ".pytest_cache/v/cache/nodeids",
                          "legacy.pyc", ".mypy_cache/3.12/shop.meta.json"):
                (root / cache).parent.mkdir(parents=True, exist_ok=True)
                (root / cache).write_bytes(b"\x00cache")
            self.assertEqual(worktree._dirty_paths(root, base, Path(".")), {"shop/cart.py", "shop/tax.py"})

    def test_only_cache_shapes_are_left_out(self):
        for path in ("shop/__pycache__/a.pyc", "a.pyo", ".pytest_cache/README.md", "x/.ruff_cache/y"):
            self.assertTrue(worktree._is_cache(path), path)
        for path in ("__pycache__.md", "docs/pycache.txt", "src/cache.py", ".github/workflows/ci.yml"):
            self.assertFalse(worktree._is_cache(path), path)


if __name__ == "__main__":
    unittest.main()
