"""Process trees: one command, one killable tree, and nothing left behind.

A timed-out build must take its compilers with it, a stopped background task must take its dev
server's workers, and a `dgc serve` whose launching process died must stop even when something
else still holds its stdin open. Those three are the same problem on POSIX and on Windows, and
this file tests the shared machinery in :mod:`dgc.proctree` plus the paths that use it.
"""
from __future__ import annotations

import copy
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import proctree, tools                                   # noqa: E402
from dgc.config import DEFAULTS                                   # noqa: E402

POSIX = os.name == "posix"


def _ctx(root: Path):
    data = copy.deepcopy(DEFAULTS)
    config = types.SimpleNamespace(data=data, get=data.get)
    return types.SimpleNamespace(project_root=root, config=config, cancelled=threading.Event(),
                                 todos=[], skills={}, on_todo=None)


class SpawnShapeTests(unittest.TestCase):
    def test_a_command_is_spawned_in_its_own_killable_group(self):
        kwargs = proctree.spawn_kwargs(cwd="/somewhere", stdin=subprocess.DEVNULL)
        self.assertEqual(kwargs["cwd"], "/somewhere")
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
        if POSIX:
            self.assertTrue(kwargs["start_new_session"])
            self.assertNotIn("creationflags", kwargs)
        else:
            flags = kwargs["creationflags"]
            self.assertTrue(flags & subprocess.CREATE_NEW_PROCESS_GROUP)
            self.assertTrue(flags & 0x08000000,
                            "CREATE_NO_WINDOW: a GUI host must not flash a console per command")

    def test_holding_a_self_job_is_a_no_op_off_windows_and_idempotent_on_it(self):
        first = proctree.hold_self_job()
        self.assertIs(proctree.hold_self_job(), first)
        if POSIX:
            self.assertIsNone(first, "POSIX reaps through the group and the registry instead")

    def test_the_parent_pid_variable_is_optional_and_never_fatal(self):
        self.assertIsNone(proctree.parent_pid({}))
        self.assertIsNone(proctree.parent_pid({proctree.PARENT_PID_ENV: ""}))
        self.assertIsNone(proctree.parent_pid({proctree.PARENT_PID_ENV: "not-a-pid"}))
        self.assertIsNone(proctree.parent_pid({proctree.PARENT_PID_ENV: "-4"}))
        self.assertEqual(proctree.parent_pid({proctree.PARENT_PID_ENV: " 41 "}), 41)

    def test_a_live_process_is_seen_as_live_and_a_dead_one_as_dead(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(child.wait)
        self.addCleanup(child.kill)
        self.assertTrue(proctree.process_alive(child.pid))
        child.kill()
        child.wait(timeout=10)
        deadline = time.monotonic() + 5
        while proctree.process_alive(child.pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(proctree.process_alive(child.pid))


class CommandTreeTests(unittest.TestCase):
    """The bash tool's own trees, through the real tool."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-tree-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.ctx = _ctx(self.root)
        self.processes: list[subprocess.Popen] = []
        original = subprocess.Popen

        def launch(*args, **kwargs):
            proc = original(*args, **kwargs)
            self.processes.append(proc)
            return proc

        mocked = patch.object(tools.subprocess, "Popen", side_effect=launch)
        mocked.start()
        self.addCleanup(mocked.stop)

    def _gone(self, proc: subprocess.Popen, timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if POSIX:
                if proctree.group_alive(proc.pid) is False:
                    return True
            elif proc.poll() is not None:
                return True
            time.sleep(0.05)
        return False

    @unittest.skipUnless(POSIX, "the grandchild probe uses a POSIX process group")
    def test_a_timeout_kills_the_whole_tree_not_only_the_shell(self):
        result = tools.bash({"command": "sleep 300 & sleep 300", "timeout": 1}, self.ctx)
        self.assertIn("did NOT finish", result)
        self.assertTrue(self.processes)
        self.assertTrue(self._gone(self.processes[0]),
                        "a backgrounded grandchild outlived the command that started it")

    @unittest.skipUnless(POSIX, "the grandchild probe uses a POSIX process group")
    def test_bash_kill_stops_the_whole_background_tree(self):
        started = tools.bash({"command": "sleep 300 & sleep 300", "background": True}, self.ctx)
        self.assertTrue(started.startswith("started background task"), started)
        bid = started.split()[3].rstrip(":")
        self.addCleanup(lambda: tools._BG.pop(bid, None))
        killed = tools.bash_kill({"id": bid}, self.ctx)
        self.assertIn("killed", killed)
        self.assertTrue(self._gone(tools._BG[bid]["proc"]))


@unittest.skipUnless(POSIX, "the group registry is POSIX only; Windows uses a Job Object")
class GroupRegistryTests(unittest.TestCase):
    """The file that lets a later `dgc serve` reap what a killed one left running."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-registry-")
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        patched = patch("dgc.config.USER_HOME", self.home / ".dgc")
        patched.start()
        self.addCleanup(patched.stop)

    def _sleeper(self) -> subprocess.Popen:
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"],
                                **proctree.spawn_kwargs())
        self.addCleanup(proc.wait)
        self.addCleanup(proc.kill)
        return proc

    def test_a_record_is_the_group_and_its_start_time_in_an_owner_only_file(self):
        proc = self._sleeper()
        self.assertTrue(proctree.register_group(proc.pid))
        path = proctree.registry_path()
        self.assertEqual(path.parent.name, "run")
        self.assertEqual(path.name, f"serve-{os.getpid()}.pgids")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        text = path.read_text(encoding="utf-8")
        self.assertTrue(text.endswith("\n"))
        pgid, stamp = text.split()
        self.assertEqual(int(pgid), proc.pid)
        self.assertEqual(stamp, proctree.start_time(proc.pid))

    def test_a_malformed_line_is_skipped_and_never_fatal(self):
        path = proctree.registry_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("nonsense\n\n12 34 56\n7 8\n", encoding="utf-8")
        self.assertEqual(proctree.read_registry(path), [(7, "8")])

    def test_a_sweep_ends_the_recorded_groups(self):
        proc = self._sleeper()
        proctree.register_group(proc.pid)
        self.assertEqual(proctree.sweep_registry(proctree.registry_path()), 1)
        proc.wait(timeout=10)
        self.assertFalse(proctree.registry_path().exists())

    def test_a_sweep_never_kills_a_pid_that_belongs_to_someone_else_now(self):
        """The recorded start time is what stops a reused pid being killed by mistake."""
        proc = self._sleeper()
        path = proctree.registry_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{proc.pid} 1\n", encoding="utf-8")   # a start time that is not this one
        self.assertEqual(proctree.sweep_registry(path), 0)
        self.assertIsNone(proc.poll(), "a process with a different start time was killed anyway")

    def test_stale_registries_of_dead_serves_are_swept_and_live_ones_left_alone(self):
        folder = proctree.registry_dir()
        folder.mkdir(parents=True, exist_ok=True)
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait(timeout=10)
        victim = self._sleeper()
        (folder / f"serve-{dead.pid}.pgids").write_text(
            f"{victim.pid} {proctree.start_time(victim.pid)}\n", encoding="utf-8")
        mine = folder / f"serve-{os.getpid()}.pgids"
        mine.write_text("", encoding="utf-8")
        self.assertEqual(proctree.sweep_stale_registries(folder), 1)
        victim.wait(timeout=10)
        self.assertTrue(mine.exists(), "this serve's own registry is not a stale one")


# --------------------------------------------------------------- the parent watcher ---

def _sse(delta: dict, finish: str | None = None) -> str:
    return "data: " + json.dumps({"id": "mock", "object": "chat.completion.chunk",
                                  "choices": [{"index": 0, "delta": delta,
                                               "finish_reason": finish}]}) + "\n\n"


class _Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, body: bytes, kind: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/models"):
            self._send(json.dumps({"data": [{"id": "mock-model"}]}).encode(), "application/json")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self._send((_sse({"content": "Done."}) + _sse({}, finish="stop")
                    + "data: [DONE]\n\n").encode(), "text/event-stream")


class ParentWatcherTests(unittest.TestCase):
    """DGC_SERVE_PARENT_PID: serve stops with its launcher, even with its stdin held open."""

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _state(self) -> Path:
        directory = tempfile.TemporaryDirectory(prefix="dgc-watch-home-")
        self.addCleanup(directory.cleanup)
        state = Path(directory.name)
        (state / ".dgc").mkdir()
        (state / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": f"http://127.0.0.1:{self.port}/v1", "model": "mock-model",
            "api_mode": "chat_completions", "suggest": False, "notes": False,
        }))
        return state

    def test_serve_stops_when_its_launcher_dies_although_stdin_stays_open(self):
        state = self._state()
        work = tempfile.TemporaryDirectory(prefix="dgc-watch-work-")
        self.addCleanup(work.cleanup)
        # The launching process the SDK would name. Something else — a forked worker, which is
        # this test process — keeps the write end of serve's stdin, so the ordinary "stdin
        # closed" signal never arrives.
        host = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
        self.addCleanup(host.wait)
        self.addCleanup(lambda: host.poll() is None and host.kill())
        read_end, write_end = os.pipe() if POSIX else (None, None)
        if read_end is None:
            self.skipTest("the held-open stdin needs a POSIX pipe")
        self.addCleanup(os.close, write_end)
        env = dict(os.environ, HOME=str(state), USERPROFILE=str(state), PYTHONPATH=str(PROJECT),
                   PYTHONDONTWRITEBYTECODE="1", DGC_SERVE_PARENT_PID=str(host.pid))
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
            env[var] = str(state)
        serve = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=work.name, env=env,
                                 stdin=read_end, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        os.close(read_end)
        self.addCleanup(serve.stdout.close)
        self.addCleanup(lambda: serve.poll() is None and serve.kill())
        # Read on a thread: readline() on a backend that writes nothing blocks for as long as the
        # backend lives, and a deadline checked between reads is no deadline at all.
        seen: list[bytes] = []
        threading.Thread(target=lambda: seen.extend(serve.stdout), daemon=True).start()
        ready = False
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline and not ready:
            ready = any(json.loads(line).get("type") == "ready" for line in list(seen) if line.strip())
            if not ready:
                time.sleep(0.05)
        self.assertTrue(ready, "serve never became ready")
        host.kill()
        started = time.monotonic()
        try:
            serve.wait(timeout=proctree.WATCH_DEADLINE_S)
        except subprocess.TimeoutExpired:
            self.fail("serve outlived its launching process by more than "
                      f"{proctree.WATCH_DEADLINE_S:g}s with stdin still open")
        self.assertLess(time.monotonic() - started, proctree.WATCH_DEADLINE_S)

    def test_no_watcher_and_no_error_when_the_variable_is_absent(self):
        self.assertIsNone(proctree.watch_parent(lambda: None, env={}))

    def test_the_watcher_fires_on_a_death_it_can_observe(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.addCleanup(child.wait)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        fired = threading.Event()
        thread = proctree.watch_parent(fired.set, env={proctree.PARENT_PID_ENV: str(child.pid)})
        self.assertIsNotNone(thread)
        child.kill()
        self.assertTrue(fired.wait(20), "the watcher never noticed the process exit")


@unittest.skipUnless(POSIX, "signal semantics differ; the Windows path is covered by winjob")
class TerminateTreeTests(unittest.TestCase):
    def test_terminate_tree_reports_an_empty_group(self):
        proc = subprocess.Popen([sys.executable, "-c",
                                 "import subprocess,sys,time\n"
                                 "subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)'])\n"
                                 "time.sleep(120)"], **proctree.spawn_kwargs())
        self.addCleanup(proc.wait)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        time.sleep(0.5)
        self.assertTrue(proctree.terminate_tree(proc))
        self.assertIs(proctree.group_alive(proc.pid), False)

    def test_terminating_an_already_finished_command_is_not_an_error(self):
        proc = subprocess.Popen([sys.executable, "-c", "pass"], **proctree.spawn_kwargs())
        proc.wait(timeout=10)
        self.assertTrue(proctree.terminate_tree(proc))


if __name__ == "__main__":
    unittest.main()
