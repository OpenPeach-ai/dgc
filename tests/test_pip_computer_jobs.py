"""pc-background-commands (0.52, his list of 9 Nov after the OpenMausBot computer check): "A Pip starts a long command
(a download, an install, a build) in the background on its computer, checks on it later (running or finished, exit
code, the end of its output) and can stop it."

run with background true starts it in the same box, network and keys as run, and answers at once; it doesn't hold the
Terminal. jobs lists them, newest first; stop_job stops one (its whole process group). At most 3 at once, each up to an
hour: both Dev Mode limits. What it prints is masked of the Pip's Terminal keys, and the end of a long output is kept.
"""
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
        self.assertIn("is stopped", self.pip("stop_job", job=job_id))
        stopped = wait_for(lambda: self.job(job_id)["state"] == "stopped" and self.job(job_id))
        self.assertNotIn("never", stopped["output"])
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
