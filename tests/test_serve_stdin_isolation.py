"""`dgc serve` owns its command pipe: no child process can end, steal from, or stall it.

The root cause of the editor's unexplained "code 0" backend exits: every child `dgc serve` started
inherited fd 0, the extension's command pipe. A Node child (npm, npx, vite) switches an inherited
stdin to O_NONBLOCK, the flag lives on the pipe, and `readline()` on a non-blocking pipe with
nothing in it returns b'' -- which the loop read as end of input. A child that reads stdin could
also swallow the user's Stop. These tests drive the real `python -m dgc serve` against a local
mock model, with HOME and XDG under a temporary directory.
"""
from __future__ import annotations

import ast
import fcntl
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc.editor_protocol import command_error, event_error  # noqa: E402
from dgc.headless import TURN_CONTINUE_MARKER, _PipeWatch, _claim_command_pipe, _command_lines  # noqa: E402


def _sse(delta: dict, finish: str | None = None) -> str:
    return "data: " + json.dumps({"id": "mock", "object": "chat.completion.chunk",
                                  "choices": [{"index": 0, "delta": delta,
                                               "finish_reason": finish}]}) + "\n\n"


def _tool_call(name: str, args: dict) -> str:
    return (_sse({"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                  "function": {"name": name, "arguments": json.dumps(args)}}]})
            + _sse({}, finish="tool_calls") + "data: [DONE]\n\n")


def _answer(text: str) -> str:
    return _sse({"content": text}) + _sse({}, finish="stop") + "data: [DONE]\n\n"


class _Model(BaseHTTPRequestHandler):
    """One bash call per user prompt, then a short answer once the tool result is in."""

    commands: list[str] = []        # the bash command for the Nth prompt; "" answers directly

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
        length = int(self.headers.get("Content-Length", 0))
        request = json.loads(self.rfile.read(length) or b"{}")
        messages = request.get("messages") or []
        last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
        answered = any(m.get("role") == "tool" for m in messages[last_user + 1:])
        prompts = sum(1 for m in messages if m.get("role") == "user"
                      and "<system-reminder>" not in str(m.get("content", "")))
        command = self.commands[min(prompts, len(self.commands)) - 1] if self.commands else ""
        if "tools" in request and command and not answered:
            body = _tool_call("bash", {"command": command})
        else:
            body = _answer("Done.")
        self._send(body.encode(), "text/event-stream")


class _Serve:
    """A real `dgc serve` child with its events collected on a thread."""

    def __init__(self, test: unittest.TestCase, port: int, *, share_read_end: bool = False):
        home = tempfile.TemporaryDirectory(prefix="dgc-stdin-home-")
        work = tempfile.TemporaryDirectory(prefix="dgc-stdin-work-")
        test.addCleanup(home.cleanup)
        test.addCleanup(work.cleanup)
        self.home, self.work = Path(home.name), Path(work.name)
        (self.home / ".dgc").mkdir()
        (self.home / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": f"http://127.0.0.1:{port}/v1", "model": "mock-model",
            "api_mode": "chat_completions", "suggest": False, "notes": False,
        }))
        env = dict(os.environ, HOME=str(self.home), PYTHONPATH=str(PROJECT),
                   PYTHONDONTWRITEBYTECODE="1")
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
            env[var] = str(self.home)
        # share_read_end: this process keeps its own copy of the pipe's read end, so it shares the
        # open file description serve reads from and can flip O_NONBLOCK on it from outside, the
        # way an inheriting Node child did.
        self.read_end = -1
        stdin = subprocess.PIPE
        write_end = -1
        if share_read_end:
            self.read_end, write_end = os.pipe()
            stdin = self.read_end
        self.proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=str(self.work),
                                     env=env, stdin=stdin, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
        self.writer = os.fdopen(write_end, "w") if share_read_end else self.proc.stdin
        if share_read_end:
            test.addCleanup(os.close, self.read_end)
        test.addCleanup(self.stop)
        self.events: list[dict] = []
        self._arrived: "queue.Queue[dict]" = queue.Queue()
        self.stderr = ""
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        self.wait(lambda e: e["type"] == "ready", 90)

    def _read(self):
        for line in self.proc.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            self.events.append(event)
            self._arrived.put(event)

    def _read_stderr(self):
        for line in self.proc.stderr:
            self.stderr += line

    def send(self, command: dict) -> None:
        self.writer.write(json.dumps(command) + "\n")
        self.writer.flush()

    def wait(self, predicate, timeout: float = 60) -> dict:
        for event in list(self.events):
            if predicate(event):
                return event
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                event = self._arrived.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                break
            if predicate(event):
                return event
        raise AssertionError(f"no matching event in {timeout}s; saw {[e['type'] for e in self.events][-30:]}")

    def auto_mode(self) -> None:
        self.send({"type": "set_mode", "mode": "auto", "acknowledge_workspace_trust": True,
                   "request_id": "mode"})
        self.wait(lambda e: e["type"] == "mode_changed" and e.get("mode") == "auto")

    def log(self) -> str:
        path = self.home / ".dgc" / "logs" / "serve.log"
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def stop(self) -> None:
        if self.proc.poll() is None:
            try:
                self.writer.close()
            except OSError:
                pass
            try:
                self.proc.wait(timeout=40)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        for pipe in (self.writer, self.proc.stdout, self.proc.stderr):
            try:
                pipe.close()
            except (OSError, ValueError):
                pass


class ServeCommandPipeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _turn_with_bash(self, command: str) -> _Serve:
        _Model.commands = [command]
        serve = _Serve(self, self.port)
        serve.auto_mode()
        serve.send({"type": "prompt", "text": "run it", "request_id": "p1"})
        return serve

    def _still_serving_after_a_command(self, serve: _Serve) -> None:
        serve.wait(lambda e: e["type"] == "turn_end", 60)
        serve.send({"type": "get_workspace_changes", "request_id": "after"})
        serve.wait(lambda e: e["type"] in ("workspace_changes", "command_rejected")
                   and e.get("request_id") == "after", 30)
        serve.send({"type": "status", "request_id": "st"})
        serve.wait(lambda e: e["type"] == "status" and e.get("request_id") == "st", 30)
        time.sleep(3)
        self.assertIsNone(serve.proc.poll(), serve.log() + serve.stderr)
        self.assertNotIn("stdin closed", serve.log())

    def test_child_that_sets_stdin_nonblocking_does_not_end_serve(self):
        serve = self._turn_with_bash(
            'python3 -c "import os,fcntl,time; fcntl.fcntl(0,fcntl.F_SETFL,'
            'fcntl.fcntl(0,fcntl.F_GETFL)|os.O_NONBLOCK); time.sleep(3)"; echo flipped')
        serve.wait(lambda e: e["type"] == "tool_call", 60)
        time.sleep(1.5)
        # Before the fix this was the command that killed the backend: exit 0 with "stdin closed
        # while the parent … is still alive; … last 'get_workspace_changes', turn running: yes".
        serve.send({"type": "get_workspace_changes", "request_id": "during"})
        serve.wait(lambda e: e["type"] in ("workspace_changes", "command_rejected")
                   and e.get("request_id") == "during", 30)
        result = serve.wait(lambda e: e["type"] == "tool_result", 60)
        self.assertIn("flipped", result["output"])
        self._still_serving_after_a_command(serve)
        self.assertIn("command pipe claimed (fd 0 → /dev/null)", serve.log())

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_node_child_touching_process_stdin(self):
        serve = self._turn_with_bash('node -e "process.stdin.isTTY; process.stdin; '
                                     'setTimeout(()=>{},3000)"; echo node-done')
        serve.wait(lambda e: e["type"] == "tool_call", 60)
        time.sleep(1.0)
        serve.send({"type": "get_workspace_changes", "request_id": "during"})
        self.assertIn("node-done", serve.wait(lambda e: e["type"] == "tool_result", 60)["output"])
        self._still_serving_after_a_command(serve)

    @unittest.skipUnless(shutil.which("node") and shutil.which("timeout"), "node or timeout missing")
    def test_sigkilled_node_child_leaves_the_pipe_alone(self):
        serve = self._turn_with_bash(
            "timeout -s KILL 1 node -e 'process.stdin;setInterval(()=>{},1e3)'; echo killed")
        self.assertIn("killed", serve.wait(lambda e: e["type"] == "tool_result", 60)["output"])
        self._still_serving_after_a_command(serve)

    def test_model_command_cannot_read_editor_frames(self):
        serve = self._turn_with_bash("head -n 1; echo read-done; sleep 8")
        serve.wait(lambda e: e["type"] == "tool_call", 60)
        time.sleep(0.4)
        # Before the fix `head` shared the pipe with us. Either it read this frame -- the tool
        # output contained the cancel and the turn ended "completed" -- or we read it first and
        # `head` sat blocked on the pipe, so "read-done" never printed. Now it reads /dev/null.
        serve.send({"type": "cancel"})
        end = serve.wait(lambda e: e["type"] == "turn_end", 60)
        self.assertEqual(end["reason"], "cancelled")
        results = [e for e in serve.events if e["type"] == "tool_result"]
        self.assertTrue(results)
        for event in results:
            self.assertNotIn('"type"', event["output"])
        self.assertTrue(any("read-done" in e["output"] for e in results), results)

    def test_serve_mirrors_its_exit_cause_to_stderr(self):
        home = tempfile.TemporaryDirectory(prefix="dgc-stdin-eof-")
        self.addCleanup(home.cleanup)
        env = dict(os.environ, HOME=home.name, PYTHONPATH=str(PROJECT))
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
            env[var] = home.name
        done = subprocess.run([sys.executable, "-m", "dgc", "serve"],
                              input=json.dumps({"type": "status", "request_id": "s"}) + "\n",
                              text=True, cwd=home.name, env=env, capture_output=True, timeout=90)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("serve loop ended: stdin closed", done.stderr)
        self.assertIn("pipe: blocking", done.stderr)
        log = (Path(home.name) / ".dgc" / "logs" / "serve.log").read_text(encoding="utf-8")
        self.assertIn("pipe: blocking", log)

    def test_queued_prompt_is_returned_when_backend_stops(self):
        _Model.commands = ["sleep 4; echo slow", ""]
        serve = _Serve(self, self.port)
        serve.auto_mode()
        serve.send({"type": "prompt", "text": "slow one", "request_id": "q-a"})
        serve.wait(lambda e: e["type"] == "tool_call", 60)
        serve.send({"type": "prompt", "text": "second one", "request_id": "q-b"})
        serve.wait(lambda e: e["type"] == "prompt_accepted" and e["request_id"] == "q-b"
                   and e["state"] == "queued")
        serve.proc.stdin.close()                 # the editor's pipe ends with a turn running
        returned = serve.wait(lambda e: e["type"] == "steering_update"
                              and e["request_id"] == "q-b", 60)
        self.assertEqual(returned["state"], "returned")
        self.assertIn("back in the composer", returned["message"])
        stopping = [e for e in serve.events if e["type"] == "info"
                    and "backend is stopping" in e.get("message", "")]
        self.assertTrue(stopping, [e for e in serve.events if e["type"] == "info"])
        self.assertEqual(serve.proc.wait(timeout=60), 0)
        for event in serve.events:
            self.assertIsNone(event_error(event), event)

    def test_frames_split_across_external_nonblocking_flips_are_read_whole(self):
        # A process sharing the pipe's open file description (as every inheriting child did) flips
        # O_NONBLOCK while serve is in the middle of a frame. Serve must restore blocking mode, keep
        # the half it already read, and parse the frame whole -- not drop it, not end the loop.
        _Model.commands = [""]
        serve = _Serve(self, self.port, share_read_end=True)
        for n in range(5):
            frame = json.dumps({"type": "status", "request_id": f"split-{n}"}) + "\n"
            half = len(frame) // 2
            serve.writer.write(frame[:half])
            serve.writer.flush()
            flags = fcntl.fcntl(serve.read_end, fcntl.F_GETFL)
            fcntl.fcntl(serve.read_end, fcntl.F_SETFL, flags | os.O_NONBLOCK)
            time.sleep(0.4)
            serve.writer.write(frame[half:])
            serve.writer.flush()
            serve.wait(lambda e, rid=f"split-{n}": e["type"] == "status"
                       and e.get("request_id") == rid, 30)
        self.assertIsNone(serve.proc.poll(), serve.log() + serve.stderr)
        self.assertEqual([e for e in serve.events if e["type"] in ("error", "command_rejected")], [])
        serve.writer.close()                          # a real end of input still ends the loop
        self.assertEqual(serve.proc.wait(timeout=60), 0)
        self.assertIn("command pipe was non-blocking (a process changed it); restored", serve.log())
        deadline = time.monotonic() + 10
        while "serve loop ended: stdin closed" not in serve.stderr and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertIn("serve loop ended: stdin closed", serve.stderr)
        self.assertIn("non-blocking-restored", serve.stderr)
        for event in serve.events:
            self.assertIsNone(event_error(event), event)

    def test_queued_turn_start_names_its_prompt_and_status_reports_busy(self):
        # The panel removes a queued message from its restore set by the id on turn_start, and asks
        # status.busy before a deferred restart, because turn_end does not say the worker is idle.
        _Model.commands = ["sleep 3; echo slow", ""]
        serve = _Serve(self, self.port)
        serve.auto_mode()
        serve.send({"type": "status", "request_id": "idle-before"})
        before = serve.wait(lambda e: e["type"] == "status" and e.get("request_id") == "idle-before")
        self.assertIs(before["busy"], False)
        serve.send({"type": "prompt", "text": "slow one", "request_id": "q-a"})
        serve.wait(lambda e: e["type"] == "tool_call", 60)
        serve.send({"type": "prompt", "text": "second one", "request_id": "q-b", "delivery": "queue"})
        serve.wait(lambda e: e["type"] == "prompt_accepted" and e["request_id"] == "q-b"
                   and e["state"] == "queued")
        serve.send({"type": "status", "request_id": "busy"})
        self.assertIs(serve.wait(lambda e: e["type"] == "status"
                                 and e.get("request_id") == "busy")["busy"], True)
        first = serve.wait(lambda e: e["type"] == "turn_start" and e.get("request_id") == "q-a", 60)
        second = serve.wait(lambda e: e["type"] == "turn_start" and e.get("request_id") == "q-b", 60)
        self.assertNotEqual(first["turn_id"], second["turn_id"])
        serve.wait(lambda e: e["type"] == "turn_end" and e["turn_id"] == second["turn_id"], 60)
        serve.send({"type": "status", "request_id": "idle-after"})
        after = serve.wait(lambda e: e["type"] == "status" and e.get("request_id") == "idle-after")
        self.assertIs(after["busy"], False)
        for event in serve.events:
            self.assertIsNone(event_error(event), event)

    def test_resume_turn_continues_as_a_marker_not_a_typed_prompt(self):
        _Model.commands = [""]
        serve = _Serve(self, self.port)
        self.assertIs(serve.events[0]["capabilities"].get("resume_turn"), True)
        serve.send({"type": "resume_turn", "request_id": "c0"})
        refused = serve.wait(lambda e: e["type"] == "command_rejected" and e.get("request_id") == "c0")
        self.assertEqual(refused["reason"], "nothing_to_continue")
        serve.send({"type": "prompt", "text": "say hi", "request_id": "p1"})
        serve.wait(lambda e: e["type"] == "turn_end")
        serve.send({"type": "resume_turn", "request_id": "c1"})
        accepted = serve.wait(lambda e: e["type"] == "prompt_accepted" and e["request_id"] == "c1")
        self.assertEqual(accepted["state"], "started")
        start = serve.wait(lambda e: e["type"] == "turn_start" and e.get("kind") == "continue")
        self.assertIn(TURN_CONTINUE_MARKER, start["prompt"])
        serve.wait(lambda e: e["type"] == "turn_end" and e["turn_id"] == start["turn_id"])
        serve.send({"type": "get_history", "request_id": "h"})
        history = serve.wait(lambda e: e["type"] == "history" and e.get("request_id") == "h")
        markers = [item for item in history["items"] if item.get("type") == "turn_start"
                   and item.get("kind") == "continue"]
        self.assertEqual(len(markers), 1, history["items"])
        self.assertNotIn(TURN_CONTINUE_MARKER, json.dumps(history["items"]))
        for event in serve.events:
            self.assertIsNone(event_error(event), event)


class CommandReaderTests(unittest.TestCase):
    def test_command_lines_treats_nonblocking_empty_read_as_not_eof(self):
        read_fd, write_fd = os.pipe()
        os.set_blocking(read_fd, False)
        reader = os.fdopen(read_fd, "rb")
        self.addCleanup(reader.close)

        def later():
            time.sleep(0.2)
            os.write(write_fd, b'{"type":')          # a frame that arrives in two pieces
            time.sleep(0.1)
            os.write(write_fd, b'"status"}\n')
            time.sleep(0.1)
            os.close(write_fd)
        threading.Thread(target=later, daemon=True).start()
        notes: list[str] = []
        watch = _PipeWatch(note=notes.append)
        frames = list(_command_lines(reader, watch))
        self.assertEqual(frames, [('{"type":"status"}\n', None)])
        self.assertTrue(os.get_blocking(read_fd))
        self.assertGreaterEqual(watch.restores, 1)
        self.assertIn("non-blocking-restored", watch.describe())
        self.assertTrue(notes and "restored" in notes[0])

    def test_a_pipe_that_keeps_flipping_is_given_up_on_instead_of_spinning(self):
        read_fd, write_fd = os.pipe()
        self.addCleanup(os.close, write_fd)
        reader = os.fdopen(read_fd, "rb")
        self.addCleanup(reader.close)

        class Flipper:                               # something in-process that never stops
            def readline(self, limit):
                os.set_blocking(read_fd, False)
                return b""

            def fileno(self):
                return read_fd

        class Stream:
            buffer = Flipper()
        watch = _PipeWatch()
        started = time.monotonic()
        self.assertEqual(list(_command_lines(Stream(), watch)), [])
        self.assertTrue(watch.gave_up)
        self.assertLess(time.monotonic() - started, 2)
        self.assertIn("gave up", watch.describe())

    def test_claimed_pipe_is_out_of_reach_of_a_child_that_inherits_fd_0(self):
        """In a separate process: claim, start a child the old way (no stdin=), let it flip fd 0."""
        script = r"""
import fcntl, os, subprocess, sys
from dgc.headless import _claim_command_pipe
reader, note = _claim_command_pipe()
child = subprocess.run([sys.executable, "-c",
    "import fcntl,os,sys; fcntl.fcntl(0, fcntl.F_SETFL, fcntl.fcntl(0, fcntl.F_GETFL) | os.O_NONBLOCK);"
    "print('/dev/null' if os.path.samestat(os.fstat(0), os.stat(os.devnull)) else os.fstat(0)); print(repr(sys.stdin.read()))"],
    capture_output=True, text=True)
print(note)
print("child:", child.stdout.replace("\n", " | "))
print("private blocking:", os.get_blocking(reader.fileno()))
print("line:", reader.readline().decode().strip())
"""
        env = dict(os.environ, PYTHONPATH=str(PROJECT))
        done = subprocess.run([sys.executable, "-c", script], input='{"type":"status"}\n',
                              capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("command pipe claimed", done.stdout)
        self.assertIn("private blocking: True", done.stdout)
        self.assertIn('line: {"type":"status"}', done.stdout)
        # The child saw /dev/null and read nothing: the frame was still there for us afterwards.
        self.assertIn("child: /dev/null | ''", done.stdout)

    def test_a_stream_without_a_descriptor_is_left_as_it_is(self):
        import io
        stream = io.StringIO('{"type":"status"}\n')
        same, note = _claim_command_pipe(stream)
        self.assertIs(same, stream)
        self.assertIn("not claimed", note)


class ChildStdinTests(unittest.TestCase):
    # Interactive terminal paths that must keep the user's terminal: `/login`-style flows in the
    # TUI run through prompt_toolkit's run_in_terminal, and `dgc update` runs the installer in the
    # user's own shell. Neither runs under `dgc serve`.
    INTERACTIVE = {("tui.py", "runner"), ("update.py", "run_update")}
    MODEL_DIRECTED = {("tools.py", "bash"), ("tools.py", "_bash_background"),
                      ("tools.py", "_run_search_process"), ("agent.py", "_run_autonomous_gate"),
                      ("artifacts.py", "_tailscale_ip")}

    @staticmethod
    def _spawn_calls(tree):
        """(function name, call) for every subprocess.Popen/run/call/check_* call."""
        found = []

        def visit(node, function):
            for child in ast.iter_child_nodes(node):
                name = child.name if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) else function
                if (isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute)
                        and isinstance(child.func.value, ast.Name) and child.func.value.id == "subprocess"
                        and child.func.attr in ("Popen", "run", "call", "check_call", "check_output")):
                    found.append((function, child, node))
                visit(child, name)
        visit(tree, "<module>")
        return found

    @staticmethod
    def _stdin_value(call, tree):
        for keyword in call.keywords:
            if keyword.arg == "stdin":
                return keyword.value
        for keyword in call.keywords:
            if keyword.arg is None and isinstance(keyword.value, ast.Name):
                target = keyword.value.id
                for node in ast.walk(tree):
                    targets = (node.targets if isinstance(node, ast.Assign)
                               else [node.target] if isinstance(node, ast.AnnAssign) else [])
                    if any(isinstance(t, ast.Name) and t.id == target for t in targets):
                        value = node.value
                        if isinstance(value, ast.Call):
                            for inner in value.keywords:
                                if inner.arg == "stdin":
                                    return inner.value
                        if isinstance(value, ast.Dict):
                            for key, item in zip(value.keys, value.values):
                                if isinstance(key, ast.Constant) and key.value == "stdin":
                                    return item
        return None

    def test_model_directed_subprocesses_never_inherit_stdin(self):
        seen_directed = set()
        missing = []
        for path in sorted((PROJECT / "dgc").rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for function, call, _parent in self._spawn_calls(tree):
                key = (path.name, function)
                value = self._stdin_value(call, tree)
                if key in self.INTERACTIVE:
                    continue
                if value is None:
                    missing.append(f"{path.relative_to(PROJECT)}:{call.lineno} ({function})")
                    continue
                if key in self.MODEL_DIRECTED:
                    seen_directed.add(key)
                    self.assertIn("DEVNULL", ast.unparse(value), f"{key} at line {call.lineno}")
        self.assertEqual(missing, [], "every child spawn must say what its stdin is")
        self.assertEqual(seen_directed, self.MODEL_DIRECTED)

    def test_the_v13_contract_declares_resume_turn_and_the_continue_marker(self):
        self.assertIsNone(command_error({"type": "resume_turn"}))
        self.assertIsNone(command_error({"type": "resume_turn", "request_id": "c1"}))
        self.assertIsNotNone(command_error({"type": "resume_turn", "text": "typed words"}))
        self.assertIsNone(event_error({"type": "turn_start", "seq": 0, "turn_id": "t1",
                                       "prompt": "", "kind": "continue"}))
        self.assertIsNone(event_error({"type": "turn_start", "seq": 0, "turn_id": "t1",
                                       "prompt": "p", "kind": "prompt", "request_id": "web-1"}))
        self.assertIsNotNone(event_error({"type": "turn_start", "seq": 0, "turn_id": "t1",
                                          "prompt": "p", "request_id": 7}))


if __name__ == "__main__":
    unittest.main()
