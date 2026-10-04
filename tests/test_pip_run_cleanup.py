"""A finished run's source copies are removed; its record, artifacts and running runs are not."""
import os
import stat
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_run_cleanup as cleanup
from tests import test_pips_local as fixtures


def snapshot(run: Path) -> None:
    """A run folder as a finished run leaves it: read-only copies plus kept artifacts."""
    for part in ("source/pkg", "worktree", "private-git/objects", "worker-home/.dgc", "artifacts"):
        (run / part).mkdir(parents=True, exist_ok=True)
    (run / "source" / "pkg" / "module.py").write_text("x = 1\n" * 1000)
    (run / "worktree" / "module.py").write_text("x = 1\n")
    (run / "private-git" / "objects" / "pack").write_bytes(b"\0" * 4096)
    (run / "worker-home" / ".dgc" / "usage.sqlite").write_bytes(b"")
    (run / "artifacts" / "changes.patch").write_text("--- a\n+++ b\n")
    for path in (run / "source" / "pkg" / "module.py", run / "worktree" / "module.py"):
        path.chmod(0o400)
    for path in (run / "source" / "pkg", run / "source"):
        path.chmod(0o500)


class RunCleanupTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def finished_run(self):
        pip = self.store.create(self.registry.personal()["id"], "Helper", "Plan the day", "local-console")
        run = self.store.enqueue(pip["id"], "key-" + pip["id"][-8:], "local-console", self.cfg)
        self.store.cancel(run["id"], "local-console")            # a real terminal state
        folder = self.registry.directory / "runs" / run["id"]
        snapshot(folder)
        return run["id"], folder

    def test_copies_go_and_the_record_and_artifacts_stay(self):
        run_id, folder = self.finished_run()
        with patch.object(cleanup, "_usage_recorded", return_value=True):
            freed = cleanup.prune_run(self.registry.directory, run_id)
        self.assertGreater(freed, 6000)
        for gone in ("source", "worktree", "private-git", "worker-home"):
            self.assertFalse((folder / gone).exists(), gone)
        self.assertEqual((folder / "artifacts" / "changes.patch").read_text(), "--- a\n+++ b\n")
        self.assertEqual(self.store.run(run_id)["status"], "cancelled")

    def test_the_worker_home_waits_until_its_usage_is_recorded(self):
        run_id, folder = self.finished_run()
        with patch.object(cleanup, "_usage_recorded", return_value=False):
            cleanup.prune_run(self.registry.directory, run_id)
        self.assertFalse((folder / "source").exists())
        self.assertTrue((folder / "worker-home" / ".dgc").is_dir(), "kept for the next usage import")

    def test_links_are_removed_never_followed(self):
        run_id, folder = self.finished_run()
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("not the run's")
        (folder / "source").chmod(0o700)
        os.symlink(outside, folder / "source" / "escape")
        with patch.object(cleanup, "_usage_recorded", return_value=True):
            cleanup.prune_run(self.registry.directory, run_id)
        self.assertEqual((outside / "keep.txt").read_text(), "not the run's")
        # A copy that is itself a link is refused, and its target is untouched.
        run_id, folder = self.finished_run()
        cleanup._remove_tree(folder / "worktree")
        os.symlink(outside, folder / "worktree")
        with self.assertRaises(OSError):
            cleanup.prune_run(self.registry.directory, run_id)
        self.assertTrue((outside / "keep.txt").exists())

    def test_the_sweep_skips_runs_that_have_not_finished(self):
        done, done_folder = self.finished_run()
        pip = self.store.create(self.registry.personal()["id"], "Queued", "Wait", "local-console")
        queued = self.store.enqueue(pip["id"], "queued-one", "local-console", self.cfg)
        queued_folder = self.registry.directory / "runs" / queued["id"]
        snapshot(queued_folder)
        with patch.object(cleanup, "_usage_recorded", return_value=True):
            result = cleanup.prune_finished(self.registry)
        self.assertEqual(result["runs"], 1)
        self.assertFalse((done_folder / "source").exists())
        self.assertTrue((queued_folder / "source" / "pkg" / "module.py").exists(), "a queued run keeps its copy")
        with patch.object(cleanup, "_usage_recorded", return_value=True):
            self.assertEqual(cleanup.prune_finished(self.registry)["runs"], 0, "nothing left to do twice")

    def test_a_sweep_is_bounded(self):
        for _ in range(3):
            self.finished_run()
        with patch.object(cleanup, "_usage_recorded", return_value=True):
            self.assertEqual(cleanup.prune_finished(self.registry, limit=2)["runs"], 2)
            self.assertEqual(cleanup.prune_finished(self.registry, limit=2)["runs"], 1)

    def test_the_runner_cleans_up_after_each_run_and_on_start(self):
        from dgc import pips
        run_id, folder = self.finished_run()          # left over from before this runner started
        pip = self.store.create(self.registry.personal()["id"], "Fresh", "Plan", "local-console")
        fresh = self.store.enqueue(pip["id"], "fresh-one", "local-console", self.cfg)
        fresh_folder = self.registry.directory / "runs" / fresh["id"]

        def execute(registry, row, config):
            snapshot(fresh_folder)
            raise RuntimeError("the fixture run fails; the runner records it as failed")
        self.cfg.data["pips_enabled"] = True
        with patch.object(pips, "_execute_run", side_effect=execute), \
                patch.object(cleanup, "_usage_recorded", return_value=True):
            pips._drain(self.cfg, self.registry.directory)
        self.assertEqual(self.store.run(fresh["id"])["status"], "failed")
        self.assertFalse((folder / "source").exists(), "the start-up sweep")
        self.assertFalse((fresh_folder / "source").exists(), "after the run itself")
        self.assertTrue((fresh_folder / "artifacts" / "changes.patch").exists())


if __name__ == "__main__":
    unittest.main()
