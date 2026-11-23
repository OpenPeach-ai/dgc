"""A Pip's computer has no time or size limits by default (decided 15 Nov: "there should be no limit, if you remember
we have also removed any time limit for background jobs on work sessions too").

Before: a Terminal command was stopped after 60 s of CPU or wall time, a file could be at most 512 MB, a background
command ran at most an hour, and its Files held at most 1 GB. Now: no CPU, file-size or time limit, and no Files quota
(Dev Mode's own caps still apply when set). A command still running after a minute isn't stopped: it carries on in
the background as a job, and the Terminal is free again. Two guards stay, because they protect the user's machine, not
limit the Pip: the process cap (no fork bomb) and a disk floor (nothing starts, and a running command stops, when the
disk would have less than DISK_FLOOR_BYTES free). On a Mac the computer is a VM: unchanged here (its size is its own
item)."""
import resource
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from dgc import pip_computer, pip_computer_files as desk
from dgc.workspace_registry import RegistryError
from tests import test_pip_computer_jobs as jobs_tests
from tests.test_pip_computer_desk import BOXES


class Limits(unittest.TestCase):
    def test_only_the_process_cap_is_left(self):
        set_to = {}
        with mock.patch.object(resource, "setrlimit", side_effect=lambda which, value: set_to.__setitem__(which, value)):
            desk._limits(10)()
        self.assertEqual(set(set_to), {resource.RLIMIT_NPROC}, "no CPU time and no file size limit")

    def test_no_time_limit_and_no_files_quota_unless_dev_mode_sets_one(self):
        with mock.patch("dgc.dev_mode.chosen", return_value=None):
            self.assertEqual(desk.background_limits()[0], 0, "0: no time limit")
            self.assertEqual(desk.folder_limit(), 0, "0: no quota")
        with mock.patch("dgc.dev_mode.chosen", side_effect=lambda name: {"pip_background_minutes": 5, "pip_files_gb": 2}.get(name)):
            self.assertEqual(desk.background_limits()[0], 300)
            self.assertEqual(desk.folder_limit(), 2 * 1024 ** 3)

    def test_the_disk_floor_refuses_a_command_when_the_disk_is_nearly_full(self):
        root = Path(tempfile.mkdtemp(prefix="dgc-floor-")) / "computer"
        self.addCleanup(shutil.rmtree, root.parent, True)
        (root / "home").mkdir(parents=True)
        desk.files_root(root)
        nearly_full = types.SimpleNamespace(total=500 * 1024 ** 3, used=0, free=desk.DISK_FLOOR_BYTES - 1)
        with mock.patch.object(desk.shutil, "disk_usage", return_value=nearly_full), \
             mock.patch.object(desk, "_execute", side_effect=AssertionError("nothing starts")):
            for start in (desk.run_command, desk.start_background):
                with self.subTest(start=start.__name__), self.assertRaises(RegistryError) as caught:
                    start(root, "echo hi", "pip")
                self.assertIn("free", str(caught.exception))

    def test_the_pip_is_told_a_long_command_carries_on_and_never_up_to_an_hour(self):
        text = pip_computer.schema()["function"]["description"]
        self.assertNotIn("up to an hour", text)
        self.assertNotIn("at most 60 s", text)
        self.assertIn("carries on in the background", text)


@unittest.skipUnless(BOXES and sys.platform != "darwin", "needs Linux and a working bubblewrap")
class MovesToTheBackground(unittest.TestCase):
    setUp = jobs_tests.BackgroundJobs.setUp
    tearDown = jobs_tests.BackgroundJobs.tearDown
    job = jobs_tests.BackgroundJobs.job

    def test_a_background_command_is_never_said_to_run_up_to_0_minutes(self):
        host = types.SimpleNamespace(root=self.root, files_dir=desk.files_root(self.root), waiting=[], last_used=0,
                                     run_id=None, careful=False, state_directory=None, pip_id=None)
        with mock.patch("dgc.dev_mode.chosen", return_value=None):
            said = pip_computer.Host._desk(host, "run", {"command": "sleep 1", "background": True})
        self.assertIn("no time limit", said)
        self.assertNotIn("0 minutes", said)

    def test_a_quick_command_answers_as_before(self):
        entry = desk.run_command(self.root, "echo hi", "pip")
        self.assertEqual((entry["exit"], entry["output"].strip()), (0, "hi"))
        self.assertNotIn("job", entry)

    def test_a_command_past_the_wait_carries_on_in_the_background_and_is_never_stopped(self):
        with mock.patch.object(desk, "COMMAND_SECONDS", 1):
            entry = desk.run_command(self.root, "sleep 3; echo done", "pip")
        self.assertIsNone(entry["exit"])
        self.assertFalse(entry["timed_out"], "not stopped")
        self.assertRegex(entry["job"], r"^job_[0-9a-f]{8}$")
        self.assertIn("carries on in the background as " + entry["job"], entry["output"])
        self.assertIsNone(desk.running(self.root), "the Terminal is free again")
        ended = jobs_tests.wait_for(lambda: self.job(entry["job"])["state"] == "finished" and self.job(entry["job"]))
        self.assertEqual(ended["output"].strip(), "done")
        self.assertEqual(ended["exit"], 0)


class MacComputerSize(unittest.TestCase):
    def test_a_macs_pip_computer_takes_half_its_memory_and_cores_never_less_than_before(self):
        from dgc import pip_container
        cases = [((64 * 1024 ** 3), 16, ("32G", "8")), ((16 * 1024 ** 3), 8, ("8G", "4")), ((8 * 1024 ** 3), 4, ("4G", "4"))]
        for memory, cores, want in cases:
            with self.subTest(memory=memory, cores=cores), \
                 mock.patch.object(pip_container, "_mac_memory", return_value=memory), \
                 mock.patch.object(pip_container.os, "cpu_count", return_value=cores):
                self.assertEqual(pip_container.vm_size(), want)


if __name__ == "__main__":
    unittest.main()
