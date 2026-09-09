"""Completed command output remains available without retaining open process pipes."""
import copy
from pathlib import Path
import subprocess
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from dgc.config import DEFAULTS
from dgc import tools


class ProcessResourceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-pipe-")
        self.addCleanup(directory.cleanup)
        data = copy.deepcopy(DEFAULTS)
        cfg = types.SimpleNamespace(data=data, get=data.get)
        self.ctx = types.SimpleNamespace(project_root=Path(directory.name), config=cfg,
                                         cancelled=threading.Event())
        self.processes = []
        original = subprocess.Popen
        def launch(*args, **kwargs):
            proc = original(*args, **kwargs)
            self.processes.append(proc)
            return proc
        mocked = patch.object(tools.subprocess, "Popen", side_effect=launch)
        mocked.start()
        self.addCleanup(mocked.stop)

    def test_repeated_foreground_commands_close_pipes_on_success_and_failure(self):
        for code in (0, 1) * 8:
            result = tools.bash({"command": f"printf 'fixture output'; exit {code}"}, self.ctx)
            self.assertIn(f"exit code: {code}\nfixture output", result)
        self.assertEqual(len(self.processes), 16)
        self.assertTrue(all(proc.poll() is not None and proc.stdout.closed for proc in self.processes))

    def test_completed_background_handle_retains_output_but_closes_pipe(self):
        result = tools.bash({"command": "printf 'background fixture\\n'", "background": True}, self.ctx)
        self.assertTrue(result.startswith("started background task"), result)
        bid = result.split()[3].rstrip(":")
        entry = tools._BG[bid]
        self.addCleanup(lambda: tools._BG.pop(bid, None))
        entry["thread"].join(timeout=5)
        self.assertFalse(entry["thread"].is_alive())
        self.assertEqual(entry["proc"].returncode, 0)
        self.assertTrue(entry["proc"].stdout.closed)
        self.assertIn("background fixture", tools.bash_output({"id": bid}, self.ctx))


if __name__ == "__main__":
    unittest.main()
