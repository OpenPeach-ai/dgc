"""pc-background-commands (0.52, his list of 9 Nov): "A Pip starts a long command
(a download, an install, a build) in the background on its computer, checks on it later (running or finished, exit
code, the end of its output) and can stop it."

run with background true starts it in the same box, network and keys as run, and answers at once; it doesn't hold the
Terminal. jobs lists them, newest first; stop_job stops one (its whole process group). At most 3 at once, each up to an
hour: both Dev Mode limits. What it prints is masked of the Pip's Terminal keys, and the end of a long output is kept.
"""
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from dgc import dev_mode, pip_computer, pip_computer_files as desk
from dgc.workspace_registry import RegistryError
from tests.test_pip_computer_desk import BOXES


def wait_for(check, seconds=20):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    return check()


@unittest.skipUnless(BOXES, "needs Linux and a working bubblewrap")
class BackgroundJobs(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="dgc-jobs-")) / "computer"
        # Nothing of a test's boxes outlives it, and its folder goes (cleanups run after tearDown's stops).
        self.addCleanup(shutil.rmtree, self.root.parent, True)
        self.addCleanup(_end_leftovers, str(self.root.parent))
        (self.root / "home").mkdir(parents=True)
        desk.files_root(self.root).mkdir(parents=True, exist_ok=True)
        self.host = types.SimpleNamespace(root=self.root, files_dir=desk.files_root(self.root), waiting=[], last_used=0,
                                          careful=False, run_id=None, state_directory=None, pip_id=None)

    def tearDown(self):
        for job in desk.jobs(self.root):
            if job["state"] == "running":
                desk.stop_job(self.root, job["id"])

    def pip(self, op, **args):
        return pip_computer.Host._desk(self.host, op, args)

    def job(self, job_id):
        return next(j for j in desk.jobs(self.root) if j["id"] == job_id)

    def test_a_long_command_runs_on_while_the_pip_carries_on_and_its_end_is_read_later(self):
        said = self.pip("run", command="sleep 1; echo built > out.txt; echo done", background=True)
        self.assertIn("Started in the background as job_", said)
        job_id = said.split("as ", 1)[1].split(":", 1)[0]
        self.assertEqual(self.job(job_id)["state"], "running", "it answered at once")
        self.assertIn("one", self.pip("run", command="echo one"), "the Terminal is free meanwhile")
        finished = wait_for(lambda: self.job(job_id)["state"] == "finished" and self.job(job_id))
        self.assertEqual((finished["exit"], finished["output"].strip()), (0, "done"))
        self.assertEqual((desk.files_root(self.root) / "out.txt").read_text(), "built\n")
        listed = self.pip("jobs")
        self.assertIn(f"{job_id} · finished, exit 0", listed)
        self.assertIn("done", listed)
        self.assertTrue(any(e.get("background") for e in desk.history(self.root)), "it shows in the Terminal's history")

    def test_stop_job_stops_it_and_its_children(self):
        job_id = desk.start_background(self.root, "sleep 60 & sleep 60; echo never", "pip")["id"]
        wait_for(lambda: self.job(job_id).get("state") == "running" and desk._alive(
            __import__("json").loads((self.root / "jobs" / f"{job_id}.json").read_text()).get("pgid")))
        inside = _children(_record(self.root, job_id)["pgid"])
        self.assertIn("is stopped", self.pip("stop_job", job=job_id))
        stopped = wait_for(lambda: self.job(job_id)["state"] == "stopped" and self.job(job_id))
        self.assertNotIn("never", stopped["output"])
        self.assertEqual([p for p in inside if _running(p)], [], "nothing of its box runs on")
        with self.assertRaises(RegistryError):
            desk.stop_job(self.root, "../etc")

    def test_three_at_once_unless_dev_mode_says_more(self):
        for _ in range(3):
            desk.start_background(self.root, "sleep 30", "pip")
        self.assertIn("3 background commands are already running", self.pip("run", command="sleep 1", background=True))
        with mock.patch.object(dev_mode, "_settings", return_value={"dev_mode": True, "dev_limits": {"pip_background_jobs": 4}}):
            self.assertIn("Started in the background", self.pip("run", command="sleep 1", background=True))

    def test_it_runs_out_of_time_and_keeps_the_end_of_a_long_output(self):
        with mock.patch.object(desk, "BACKGROUND_SECONDS", 1):
            job_id = desk.start_background(self.root, "seq 1 200000; sleep 30", "pip")["id"]
            ended = wait_for(lambda: self.job(job_id)["state"] == "timed_out" and self.job(job_id))
        self.assertIn("200000", ended["output"], "the end is kept")
        self.assertIn("only the end of its output is kept", ended["output"])
        self.assertNotIn("\n1\n2\n3\n", ended["output"][:200])
        self.assertIn("Stopped after 1 seconds", ended["output"])

    def test_its_keys_are_masked_in_what_it_prints(self):
        secret = "inv_live_0123456789abcdefJOBS"
        job_id = desk.start_background(self.root, 'echo "$INVOICELY_API_KEY"', "pip", env={"INVOICELY_API_KEY": secret})["id"]
        done = wait_for(lambda: self.job(job_id)["state"] == "finished" and self.job(job_id))
        self.assertNotIn(secret, done["output"])
        self.assertNotIn(secret, "".join(p.read_text() for p in (self.root / "jobs").glob("*.json")))

    def test_a_job_left_running_by_a_dgc_that_stopped_reads_as_stopped(self):
        import json
        (self.root / "jobs").mkdir(exist_ok=True)
        (self.root / "jobs" / "job_0000abcd.json").write_text(json.dumps(
            {"id": "job_0000abcd", "by": "pip", "command": "make", "state": "running", "exit": None, "output": "",
             "started": 1, "ended": None, "pgid": 999999}))
        self.assertEqual(self.job("job_0000abcd")["state"], "stopped")


class StopReachesTheBoxInside(unittest.TestCase):
    """bwrap starts a box's inside in a session of its own, which a signal to bwrap's process group never reaches; the
    inside is meant to die with bwrap (--die-with-parent), but a bwrap stopped in its first moments (a Stop right after
    the start, on a busy computer) can be gone before the inside armed that. The inside then ran on for good, its egress
    forwarder keeping the box alive, and the job said "stopping" until its command ended (13 Nov: test boxes found
    alive after 32 hours; the stop test failed whenever the computer was busy)."""

    def test_stop_ends_what_runs_in_a_session_of_its_own_under_the_group(self):
        root = Path(tempfile.mkdtemp(prefix="dgc-jobs-")) / "computer"
        root.mkdir()
        self.addCleanup(shutil.rmtree, root.parent, True)
        leader, inside = _orphan_maker(self)
        job = {"id": "job_0badc0de", "by": "pip", "command": "sleep 60", "state": "running", "exit": None,
               "output": "", "started": int(time.time()), "ended": None, "pgid": leader.pid}
        desk._job_write(root, job)
        desk.stop_job(root, job["id"])
        leader.wait(10)
        self.assertTrue(wait_for(lambda: not _running(inside), 5), "the box's inside was ended with it")

    def test_a_pip_computers_box_ends_its_inside_too(self):
        from dgc import pip_computer_box
        leader, inside = _orphan_maker(self)
        box = pip_computer_box.Box(home=Path("/nonexistent"), egress_socket=Path("/nonexistent"), chrome=Path("/nonexistent"))
        box.proc = leader
        box.stop()
        self.assertTrue(wait_for(lambda: not _running(inside), 5), "a computer stopped in its first moments leaves nothing")


def _orphan_maker(case):
    """A group leader whose child has a session of its own and runs on (bwrap whose inside never armed its
    parent-death signal); its leader and the child's pid."""
    leader = subprocess.Popen([sys.executable, "-c", "import subprocess, time; "
                               "kid = subprocess.Popen(['sleep', '60'], start_new_session=True); "
                               "print(kid.pid, flush=True); time.sleep(60)"],
                              stdout=subprocess.PIPE, text=True, start_new_session=True)
    inside = int(leader.stdout.readline())
    case.addCleanup(lambda: _running(inside) and os.kill(inside, signal.SIGKILL))
    case.addCleanup(lambda: leader.poll() is None and leader.kill())
    case.addCleanup(leader.stdout.close)
    return leader, inside


def _record(root, job_id):
    import json
    return json.loads((root / "jobs" / f"{job_id}.json").read_text())


def _children(pid):
    kids = []
    for name in os.listdir("/proc"):
        if name.isdigit():
            try:
                stat = Path(f"/proc/{name}/stat").read_bytes()
            except OSError:
                continue
            if stat[stat.rfind(b")") + 2:].split()[1:2] == [str(pid).encode()]:
                kids.append(int(name))
    return kids


def _running(pid):
    """Alive and not a zombie (one ended and waiting to be reaped counts as ended)."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_bytes()
    except OSError:
        return False
    return stat[stat.rfind(b")") + 2:][:1] not in (b"Z", b"X")


def _end_leftovers(marker):
    """Any process whose command line names this test's folder (a box binds it): ended."""
    for name in os.listdir("/proc"):
        if name.isdigit() and int(name) != os.getpid():
            try:
                if marker.encode() in Path(f"/proc/{name}/cmdline").read_bytes():
                    os.kill(int(name), signal.SIGKILL)
            except OSError:
                pass


class BackgroundSchema(unittest.TestCase):
    def test_the_pip_is_offered_it_in_plain_words(self):
        tool = pip_computer.schema()["function"]
        self.assertIn("jobs", tool["parameters"]["properties"]["op"]["enum"])
        self.assertIn("stop_job", tool["parameters"]["properties"]["op"]["enum"])
        self.assertEqual(tool["parameters"]["properties"]["background"], {"type": "boolean"})
        self.assertIn("background true", tool["description"])
        self.assertNotIn("with no internet", tool["description"], "its Terminal reaches public websites through DGC")


if __name__ == "__main__":
    unittest.main()
