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
