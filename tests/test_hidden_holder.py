"""A backend that holds a session never hides (seen 13 Nov on a user's machine, DGC 0.51.0).

"This session is open in another window" → Open Here → the same message again. A `dgc serve` with no window held the
session's owner and turn locks: its turn was deadlocked (dismissing a Pip report card saved the session under the
history lock while a Pip fix inside the same chat held the sub-agent registry's lock and waited for the history lock),
its heartbeat thread froze behind the turn lock while building its note, and 15 minutes later another DGC deleted the
note of the live process as "gone". From then on nothing could find it: not `dgc ps`, not Running sessions, not Open
Here. Three fixes, each with its test here:
1. A live process's note is never deleted: a stale heartbeat on a live process is "stuck", shown, not "gone".
2. A process's note is built without waiting on its turn lock, so a stuck turn can't silence its heartbeat.
3. Saving shown Pip reports lets go of the history lock before it saves, so a helper recording a step can finish.
"""
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import peers


class StuckIsNotGone(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-holder-"))
        p = patch.dict(os.environ, {"HOME": str(self.home), "DGC_HOME": str(self.home)})
        p.start()
        self.addCleanup(p.stop)
        self.child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.addCleanup(self.child.kill)

    def note(self, pid, heartbeat):
        record = {"pid": pid, "proc_start": peers._proc_start(pid), "kind": "serve", "session": "/x/s.json",
                  "heartbeat": heartbeat, "status": "working", "takeover": True}
        return record

    def test_a_live_process_with_a_stale_heartbeat_is_stuck_not_gone(self):
        old = time.time() - 3600
        self.assertEqual(peers.liveness(self.note(self.child.pid, old)), "stuck")
        self.assertEqual(peers.liveness(self.note(self.child.pid, time.time())), "live")
        gone = subprocess.Popen([sys.executable, "-c", "pass"])
        gone.wait()
        self.assertEqual(peers.liveness(self.note(gone.pid, time.time())), "gone")

    def test_its_note_is_kept_and_listed(self):
        import json
        folder = peers.peers_dir()
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{self.child.pid}.json"
        path.write_text(json.dumps(self.note(self.child.pid, time.time() - 3600)))
        found = [r for r in peers.others(here=False) if r["pid"] == self.child.pid]
        self.assertEqual([r["liveness"] for r in found], ["stuck"])
        self.assertTrue(path.exists(), "never deleted while its process lives")
        self.assertEqual(peers.session_holder("/x/s.json")["pid"], self.child.pid, "Open Here still finds it")
        self.assertIn("stopped answering", peers.describe_holder(found[0]))


class StopEndsAStuckOne(StuckIsNotGone):
    def test_stop_signals_a_stuck_process_it_can_prove_and_ends_it(self):
        from dgc import serve_detach
        stuck = subprocess.Popen([sys.executable, "-c", "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"])
        self.addCleanup(stuck.kill)
        time.sleep(0.3)
        record = self.note(stuck.pid, time.time() - 3600)
        with patch.object(time, "monotonic", side_effect=_fast_clock(time.monotonic())):
            stopped, said = serve_detach.stop_process(record, wait_s=0)
        self.assertTrue(stopped, said)
        self.assertIn("SIGKILL", said, "it ignored SIGTERM, as a deadlocked one can't finish: ended")
        stuck.wait(5)


def _fast_clock(start):
    now = [start]

    def tick():
        now[0] += 5.0
        return now[0]
    while True:
        yield tick()


class NoteWithoutWaiting(unittest.TestCase):
    def test_a_held_turn_lock_never_blocks_the_note(self):
        from dgc import headless
        chat = object.__new__(headless.Backend)
        lock = chat._turn_state_lock()
        taken = threading.Event()
        release = threading.Event()

        def hold():
            with lock:
                taken.set()
                release.wait(10)
        holder = threading.Thread(target=hold, daemon=True)
        holder.start()
        taken.wait(5)
        started = time.monotonic()
        try:
            self.assertTrue(headless._busy_for_note(chat), "held by someone: counted as working")
            self.assertLess(time.monotonic() - started, 2.0, "and answered without waiting for it")
        finally:
            release.set()
            holder.join(5)
        self.assertFalse(headless._busy_for_note(chat), "free again: the real answer")


class ReportsSaveWithoutTheHistoryLock(unittest.TestCase):
    def test_a_helper_recording_a_step_finishes_while_reports_are_saved(self):
        from dgc import headless, pip_report_delivery
        history = threading.RLock()
        registry_lock = threading.Lock()          # stands for the sub-agent registry's publish lock
        in_save = threading.Event()
        helper_has_it = threading.Event()
        helper_done = {}

        def persist():
            in_save.set()
            with registry_lock:                  # the save reads the helpers' records (subagents.saved_state)
                return True
        agent = SimpleNamespace(session_file=Path("/x/20261113-120000-abcd1234.json"),
                                messages=[{"role": "assistant", "content": "Done."}], _persist=persist)
        state = pip_report_delivery.ChatReports()
        state.dirty = True
        backend = object.__new__(headless.Backend)
        backend.__dict__["_pip_reports"] = state
        backend.em = SimpleNamespace(history_lock=history)
        backend.agent = agent
        backend._worker = None

        def helper():                            # a Pip fix inside the chat: holds the registry, then records a step
            with registry_lock:
                helper_has_it.set()
                in_save.wait(5)
                helper_done["history"] = history.acquire(timeout=3)
                if helper_done["history"]:
                    history.release()
        t = threading.Thread(target=helper, daemon=True)
        t.start()
        helper_has_it.wait(5)
        flusher = threading.Thread(target=backend._flush_pip_reports, daemon=True)
        flusher.start()
        flusher.join(10)
        t.join(10)
        self.assertFalse(flusher.is_alive(), "the save finished")
        self.assertTrue(helper_done.get("history"), "the helper got the history lock while the save waited for it")
        self.assertFalse(state.dirty, "and the reports were saved")


if __name__ == "__main__":
    unittest.main()
