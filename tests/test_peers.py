"""Other DGC agents working in the same checkout.

DGC spawns a `dgc serve` per window, so two DGCs really can edit one checkout at the same time --
opencode, Codex and qwen-code each run ONE owner process and never have this problem. Neither DGC
knew the other existed. This is the registry that fixes that.

What these tests are mostly about is the thing that makes it safe: a pid is not an identity. Pids
are recycled, and a note whose pid now belongs to something else must not read as a live DGC.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import peers


class PeerRegistryTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self._home = os.environ.get("HOME")
        os.environ["HOME"] = str(self.home)

    def tearDown(self):
        if self._home is not None:
            os.environ["HOME"] = self._home

    def note(self, **over) -> dict:
        base = {"pid": os.getpid(), "proc_start": peers._proc_start(os.getpid()),
                "kind": "serve", "session": "", "cwd": "/w", "project_root": "/w",
                "git_common_dir": "/w/.git", "status": "idle", "heartbeat": time.time()}
        base.update(over)
        return base

    def write(self, record: dict) -> Path:
        d = peers.peers_dir(); d.mkdir(parents=True, exist_ok=True)
        path = d / f"{record['pid']}.json"
        path.write_text(json.dumps(record))
        return path

    # ---- liveness -------------------------------------------------------------------------

    def test_this_process_is_live(self):
        self.assertEqual(peers.liveness(self.note()), "live")

    def test_a_recycled_pid_is_not_the_process_that_wrote_the_note(self):
        # The whole reason proc_start is recorded. Without it, a stale note whose pid has been
        # handed to an unrelated program reads as a live DGC and its "work" is respected.
        self.assertEqual(peers.liveness(self.note(proc_start="1")), "gone")

    def test_a_pid_nobody_is_using_is_gone(self):
        self.assertEqual(peers.liveness(self.note(pid=4_000_000, proc_start="1")), "gone")

    def test_a_killed_but_unreaped_process_is_gone(self):
        # A zombie still answers kill(pid, 0). It is in the process table and signallable, and in
        # every sense that matters here it has gone.
        child = subprocess.Popen(["sleep", "30"])
        rec = self.note(pid=child.pid, proc_start=peers._proc_start(child.pid))
        self.assertEqual(peers.liveness(rec), "live")
        child.kill(); time.sleep(0.3)
        self.assertEqual(peers.liveness(rec), "gone")
        child.wait()

    def test_a_note_nobody_has_refreshed_is_gone(self):
        old = time.time() - peers.STALE_AFTER_S - 1
        self.assertEqual(peers.liveness(self.note(heartbeat=old)), "gone")

    def test_unprovable_identity_is_unknown_not_a_guess(self):
        # Where the process start time cannot be read, the honest answer is "I cannot tell".
        # Saying "live" would invent a peer; saying "gone" would ignore a real one.
        self.assertEqual(peers.liveness(self.note(proc_start="")), "unknown")

    def test_rubbish_is_gone_rather_than_an_exception(self):
        for bad in (None, [], {}, {"pid": "x"}, {"pid": -1}):
            self.assertEqual(peers.liveness(bad), "gone")

    # ---- the registry ---------------------------------------------------------------------

    def test_announce_then_find_it_from_elsewhere(self):
        peers.announce(kind="serve", project_root="/w", git_common_dir="/w/.git")
        path = peers.peers_dir() / f"{os.getpid()}.json"
        self.assertTrue(path.exists())
        self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600", "a peer note is owner-only")

    def test_my_own_note_is_not_a_peer(self):
        peers.announce(kind="serve", project_root="/w", git_common_dir="/w/.git")
        self.assertEqual(peers.others(project_root="/w", git_common_dir="/w/.git"), [])

    def test_a_peer_in_the_same_checkout_is_found(self):
        self.write(self.note(pid=os.getppid(), proc_start=peers._proc_start(os.getppid())))
        found = peers.others(project_root="/w", git_common_dir="/w/.git")
        self.assertEqual(len(found), 1)
        self.assertIn(found[0]["liveness"], ("live", "unknown"))

    def test_a_peer_somewhere_else_is_not_my_problem(self):
        self.write(self.note(pid=os.getppid(), proc_start=peers._proc_start(os.getppid()),
                             project_root="/other", git_common_dir="/other/.git"))
        self.assertEqual(peers.others(project_root="/w", git_common_dir="/w/.git"), [])

    def test_two_worktrees_of_one_repository_are_peers(self):
        # Different roots, same repository: they share branches and history, so they really can
        # tread on each other.
        self.write(self.note(pid=os.getppid(), proc_start=peers._proc_start(os.getppid()),
                             project_root="/w2", git_common_dir="/w/.git"))
        self.assertEqual(len(peers.others(project_root="/w", git_common_dir="/w/.git")), 1)

    def test_a_dead_peers_note_is_tidied_away(self):
        path = self.write(self.note(pid=4_000_001, proc_start="1"))
        peers.others(project_root="/w", git_common_dir="/w/.git")
        self.assertFalse(path.exists(), "a gone peer's note helps nobody")

    def test_withdraw_removes_only_mine(self):
        peers.announce(kind="serve", project_root="/w", git_common_dir="/w/.git")
        other = self.write(self.note(pid=os.getppid(), proc_start=peers._proc_start(os.getppid())))
        peers.withdraw()
        self.assertFalse((peers.peers_dir() / f"{os.getpid()}.json").exists())
        self.assertTrue(other.exists())

    def test_unreadable_rubbish_in_the_directory_is_survived(self):
        (peers.peers_dir()).mkdir(parents=True, exist_ok=True)
        (peers.peers_dir() / "junk.json").write_text("{not json")
        self.assertEqual(peers.others(project_root="/w", git_common_dir="/w/.git"), [])

    # ---- what gets said -------------------------------------------------------------------

    def test_nothing_is_said_when_nobody_is_there(self):
        self.assertEqual(peers.model_line([]), "")
        self.assertEqual(peers.user_line([]), "")

    def test_the_model_is_told_not_to_undo_work_that_is_not_its_own(self):
        line = peers.model_line([{"liveness": "live"}])
        self.assertIn("<dgc-peers>", line)
        self.assertIn("Do not revert", line)
        self.assertIn("stop and tell the user", line)

    def test_an_unsure_peer_is_described_as_unsure(self):
        line = peers.model_line([{"liveness": "unknown"}])
        self.assertIn("may still be running", line)

    def test_the_user_line_counts_correctly(self):
        self.assertEqual(peers.user_line([{"liveness": "live"}]),
                         "1 other DGC is working in this folder.")
        self.assertEqual(peers.user_line([{"liveness": "live"}] * 2),
                         "2 other DGCs are working in this folder.")


if __name__ == "__main__":
    unittest.main()


class ProcessIdentityWithoutProcfsTest(unittest.TestCase):
    """macOS has no /proc, so the pid-recycling and zombie checks had nothing to read there.

    Both opened /proc/<pid>/stat unconditionally. On a Mac that always raised, so `_proc_start`
    returned "" and every verdict degraded to `unknown`, and `_is_zombie` returned False so a
    killed-but-unreaped DGC read as a LIVE peer -- the exact confusion it exists to prevent. Three
    test_peers failures on every macOS job, on every tag, which is most of why tagged releases
    went red.

    These drive the REAL ps path, not a mock of it: DGC_NO_PROCFS=1 is the same override
    dgc.monitors and dgc.install_layout use so a Linux run exercises what macOS runs.
    """

    def setUp(self):
        self._env = patch.dict(os.environ, {"DGC_NO_PROCFS": "1"})
        self._env.start()
        self.addCleanup(self._env.stop)

    def test_ps_identifies_this_process(self):
        start = peers._proc_start(os.getpid())
        self.assertTrue(start, "ps must answer for a process that is running")
        # The SHAPE proves which branch ran, and that is the whole point: /proc yields clock ticks
        # ("130672363"), ps yields a date ("Wed Sep 23 01:11:27 2026"). Without this the test
        # passes on Linux even if the ps branch is deleted, because the fall-through still reads
        # /proc and still returns something true -- so it would not catch the macOS bug at all.
        self.assertFalse(start.isdigit(),
                         f"expected a ps date, got what looks like /proc clock ticks: {start!r}")
        self.assertEqual(peers.liveness({"pid": os.getpid(), "proc_start": start}), "live")

    def test_a_recycled_pid_is_caught_without_procfs(self):
        verdict = peers.liveness({"pid": os.getpid(), "proc_start": "Sun Sep 21 09:00:00 2026"})
        self.assertEqual(verdict, "gone", "a different start time is a different process")

    def test_the_two_paths_agree_on_the_same_process(self):
        without = peers.liveness({"pid": os.getpid(), "proc_start": peers._proc_start(os.getpid())})
        with patch.dict(os.environ, {"DGC_NO_PROCFS": "0"}):
            procfs = peers.liveness({"pid": os.getpid(),
                                     "proc_start": peers._proc_start(os.getpid())})
        self.assertEqual(without, procfs, "ps and /proc must reach the same verdict")
        self.assertEqual(without, "live")

    def test_a_vanished_pid_reads_as_gone(self):
        dead = 0x7FFFFFF0
        self.assertEqual(peers._proc_start(dead), "")
        self.assertFalse(peers._is_zombie(dead))
        self.assertEqual(peers.liveness({"pid": dead, "proc_start": "x"}), "gone")

    def test_a_running_process_is_not_a_zombie(self):
        self.assertFalse(peers._is_zombie(os.getpid()))

    def test_the_zombie_check_asks_ps_when_there_is_no_procfs(self):
        """Pins the branch, not just the answer: /proc happens to give the right answer on Linux,
        so without this the ps arm could be deleted and every test here would still pass."""
        asked = []
        real = peers.subprocess.run

        def spy(argv, **kwargs):
            asked.append(list(argv))
            return real(argv, **kwargs)

        with patch.object(peers.subprocess, "run", spy):
            peers._is_zombie(os.getpid())
        self.assertTrue(any("stat=" in " ".join(a) for a in asked),
                        f"the zombie check must reach ps without /proc: {asked}")

    def test_a_real_zombie_reads_as_gone(self):
        """A child that exited and has not been waited on still answers kill(pid, 0)."""
        proc = subprocess.Popen([sys.executable, "-c", "raise SystemExit(0)"])
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not peers._is_zombie(proc.pid):
                time.sleep(0.05)
            self.assertTrue(peers._is_zombie(proc.pid), "the child should be an unreaped zombie")
            self.assertEqual(peers.liveness({"pid": proc.pid, "proc_start": "x"}), "gone",
                             "a zombie is not a live peer")
        finally:
            proc.wait(timeout=10)

    def test_the_ps_child_cannot_inherit_the_protocol_pipe(self):
        # Under `dgc serve` this process's stdin is the editor protocol pipe.
        import inspect
        source = inspect.getsource(peers._ps_field)
        self.assertIn("stdin=subprocess.DEVNULL", source)
        self.assertIn("timeout=", source, "a peer check must not block on a wedged ps")

    @unittest.skipUnless(sys.platform.startswith("linux"), "the /proc path needs a real /proc")
    def test_procfs_is_still_used_when_it_exists(self):
        with patch.dict(os.environ, {"DGC_NO_PROCFS": "0"}):
            self.assertTrue(peers._procfs())
            self.assertTrue(peers._proc_start(os.getpid()).isdigit(),
                            "/proc returns clock ticks, not a date")
