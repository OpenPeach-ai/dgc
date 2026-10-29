"""Completed lifecycle hooks release their pipe descriptors without waiting for GC."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from dgc import hooks


@unittest.skipUnless(os.name == "posix", "hooks use the POSIX shell")
class HookResourcesTests(unittest.TestCase):
    def test_completed_hook_closes_input_and_output(self):
        processes = []
        real_popen = subprocess.Popen

        def start(*args, **kwargs):
            proc = real_popen(*args, **kwargs)
            processes.append(proc)
            self.addCleanup(proc.stdout.close)
            self.addCleanup(proc.stdin.close)
            return proc

        with tempfile.TemporaryDirectory() as root, patch.object(hooks.subprocess, "Popen", start):
            result = hooks._run_one("cat", b"hook payload", {}, Path(root), 5)
        self.assertEqual(result, (0, "hook payload", ""))
        self.assertEqual(len(processes), 1)
        self.assertTrue(processes[0].stdin.closed)
        self.assertTrue(processes[0].stdout.closed)


class WindowsHookCleanupTests(unittest.TestCase):
    def test_timeout_terminates_windows_hook_children(self):
        proc = Mock(pid=4242, stdin=None, stdout=None)
        with patch.object(hooks.os, "name", "nt"), patch.object(hooks.subprocess, "run") as run:
            hooks._terminate_tree(proc)
        self.assertEqual(run.call_args.args[0], ["taskkill", "/PID", "4242", "/T", "/F"])
        proc.wait.assert_called_once_with(timeout=5)
