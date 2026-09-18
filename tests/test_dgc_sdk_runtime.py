"""DGC SDK runtime layer: process lifetime, discovery, environment, transport errors, timeouts."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "sdk" / "python"))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

import test_dgc_sdk as base  # noqa: E402  (mock model server shared with the main SDK suite)
from dgc_sdk import (  # noqa: E402
    DGC, DGCConfigError, DGCError, DGCProtocolError, DGCRuntimeError, DGCTimeoutError,
    DGCUnsupportedError, RetryPolicy, define_tool,
)
from dgc_sdk import DGCCommandRejectedError  # noqa: E402
from dgc_sdk import runtime as sdk_runtime  # noqa: E402
from dgc_sdk.wire import client as wire  # noqa: E402

ON_LINUX = sys.platform.startswith("linux")
READY = ('emit("ready", version="9.9.9", protocol_version=PROTOCOL, capabilities={}, '
         'model="fixture", mode="default", think="off", base_url="http://127.0.0.1:1/v1", '
         'workspace_trusted=False, commands=[], custom_commands=[], '
         'goal={"text": "", "status": "none"}, context_size=32768)')

# A tiny stand-in for `dgc serve`: argv[1] picks a behaviour, argv[2] the offered protocol.
FAKE_SERVE = textwrap.dedent('''
    import json, sys, time
    mode = sys.argv[1]
    PROTOCOL = int(sys.argv[2]) if len(sys.argv) > 2 else 14
    seq = 0

    def emit(_type, /, **fields):
        global seq
        sys.stdout.write(json.dumps({"type": _type, "seq": seq, **fields}) + "\\n")
        sys.stdout.flush()
        seq += 1

    if mode == "exit3":
        sys.stderr.write("boom-marker: the runtime could not import its settings\\n")
        sys.stderr.flush()
        sys.exit(3)
    if mode == "unknown-first":
        emit("remote_status", state="on")
    READY
    if mode == "unknown":
        emit("remote_status", state="on", detail="paired")
        emit("remote_pairing", code="123-456")
        emit("info", message="after unknown")
    for line in sys.stdin:
        cmd = json.loads(line)
        kind, rid = cmd.get("type"), cmd.get("request_id")
        if kind == "shutdown":
            break
        if mode == "reject":
            emit("command_rejected", command=kind, reason="turn_in_progress",
                 message="busy with a turn", request_id=rid)
        elif mode == "error-reply":
            emit("error", message="no session to resume", request_id=rid)
        elif mode == "crash":
            emit("error", message=f"Command '{kind}' failed \\u2014 boom")
        elif mode == "delayed":
            emit("info", message="noise before the reply")
            time.sleep(0.3)
            emit("sessions", items=[], request_id=rid)
            emit("info", message="noise after the reply")
        elif mode == "late":
            time.sleep(1.0)
            emit("sessions", items=[], request_id=rid)
            emit("info", message="after the late reply")
        else:
            emit("sessions", items=[], request_id=rid)
''').replace("READY", READY)

# Wraps the real `dgc serve` and adds event types this SDK has never heard of, the way a newer
# CLI adds remote_status within protocol v14.
INJECT_UNKNOWN = textwrap.dedent('''
    import json, subprocess, sys
    child = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], stdout=subprocess.PIPE)
    seq = 0

    def out(event):
        global seq
        event["seq"] = seq
        seq += 1
        sys.stdout.write(json.dumps(event) + "\\n")
        sys.stdout.flush()

    for raw in child.stdout:
        event = json.loads(raw)
        out(event)
        if event.get("type") in ("ready", "turn_start", "stream_end"):
            out({"type": "remote_status", "state": "on", "url": "https://example.invalid/x"})
    sys.exit(child.wait())
''')


class _RuntimeModel(base._Model):
    """The main suite's mock model plus two behaviours the runtime tests need."""

    def do_POST(self):
        if self.behavior == "slow":
            base._Model.posts += 1
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            time.sleep(3.0)
            self._send(base._answer("The slow model answered."))
            return
        if self.behavior == "printenv":
            base._Model.posts += 1
            length = int(self.headers.get("Content-Length", 0))
            request = json.loads(self.rfile.read(length) or b"{}")
            messages = request.get("messages") or []
            if messages and messages[-1].get("role") == "tool":
                self._send(base._answer("Printed."))
            else:
                self._send(base._call("bash", {
                    "command": "printenv FAKE_CLOUD_SECRET || echo secret-absent"}))
            return
        super().do_POST()


def _start_model():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _RuntimeModel)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/v1"


def _proc_env(pid: int) -> dict[str, str]:
    raw = Path(f"/proc/{pid}/environ").read_bytes()
    pairs = [item.split(b"=", 1) for item in raw.split(b"\0") if b"=" in item]
    return {key.decode(): value.decode() for key, value in pairs}


def _serve_children() -> list[int]:
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            stat = Path(f"/proc/{entry}/stat").read_text()
            cmdline = Path(f"/proc/{entry}/cmdline").read_bytes()
        except OSError:
            continue
        fields = stat.rsplit(")", 1)[1].split()
        if int(fields[1]) == os.getpid() and fields[0] != "Z" and b"serve" in cmdline:
            found.append(int(entry))
    return found


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dgc-sdk-rt-"))
        self.state = self.tmp / "state"
        self.work = self.tmp / "work"
        self.work.mkdir()
        (self.work / "README.md").write_text("empty cart checkout\n", encoding="utf-8")
        self.fake = self.tmp / "fake_serve.py"
        self.fake.write_text(FAKE_SERVE, encoding="utf-8")
        self._old_env = dict(os.environ)
        os.environ["HOME"] = str(self.tmp / "host-home")
        (self.tmp / "host-home").mkdir()
        base._Model.posts = 0
        _RuntimeModel.behavior = "text"
        self.server, self.base_url = _start_model()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._old_env)
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _client(self, **kwargs):
        return DGC(state_dir=self.state, model="sdk-model", base_url=self.base_url,
                   api_key="sk-local", **kwargs)

    def _auto(self):
        return {"mode": "auto", "unhandled": "deny"}

    def _wire(self, mode: str, protocol: int = 14, **kwargs) -> wire.DGCClient:
        return wire.DGCClient([sys.executable, str(self.fake), mode, str(protocol)],
                              cwd=self.work, start_timeout=10, event_timeout=5,
                              shutdown_timeout=0.5, **kwargs)


class ProcessLifetimeTests(_Base):
    @unittest.skipUnless(ON_LINUX, "PR_SET_PDEATHSIG is Linux-only")
    def test_backend_survives_the_thread_that_created_the_session(self):
        with self._client() as dgc:
            made = {}
            worker = threading.Thread(
                target=lambda: made.setdefault("session", dgc.session(
                    cwd=self.work, permissions=self._auto())))
            worker.start()
            worker.join()
            session = made["session"]
            time.sleep(1.0)
            self.assertIsNone(session.raw.returncode,
                              "the backend died when its creating thread exited")
            result = session.run("Summarize README. Do not edit files.", timeout=60)
        self.assertEqual(result.status, "completed", result)

    @unittest.skipUnless(ON_LINUX, "reads /proc")
    def test_backend_still_dies_with_the_process_after_a_thread_created_it(self):
        pidfile = self.tmp / "orphan.pid"
        script = textwrap.dedent(f"""
            import os, sys, threading
            sys.path[:0] = [{str(ROOT / 'sdk' / 'python')!r}, {str(ROOT)!r}]
            from pathlib import Path
            from dgc_sdk import DGC
            dgc = DGC(state_dir={str(self.tmp / 'crash-state')!r}, model='sdk-model',
                      base_url={self.base_url!r}, api_key='sk-local')
            made = {{}}
            worker = threading.Thread(target=lambda: made.setdefault('s', dgc.session(
                cwd={str(self.work)!r}, permissions={{'mode': 'auto', 'unhandled': 'deny'}})))
            worker.start()
            worker.join()
            Path({str(pidfile)!r}).write_text(str(made['s'].raw.pid))
            os._exit(9)
        """)
        subprocess.run([sys.executable, "-c", script], env=os.environ.copy(), check=False,
                       timeout=90)
        pid = int(pidfile.read_text().strip())
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and os.path.exists(f"/proc/{pid}"):
            time.sleep(0.1)
        self.assertFalse(os.path.exists(f"/proc/{pid}"), f"orphaned dgc serve pid {pid}")

    @unittest.skipUnless(ON_LINUX, "reads /proc")
    def test_failed_runtime_start_is_an_sdk_error_with_its_stderr(self):
        with DGC(state_dir=self.state, runtime=[sys.executable, str(self.fake), "exit3"]) as dgc:
            with self.assertRaises(DGCRuntimeError) as caught:
                dgc.session(cwd=self.work)
        self.assertNotIsInstance(caught.exception, wire.DGCClientError)
        self.assertIn("boom-marker", str(caught.exception))
        self.assertEqual(_serve_children(), [])

    @unittest.skipUnless(ON_LINUX, "reads /proc")
    def test_failed_tool_setup_reaps_the_backend(self):
        tool = define_tool("sku_lookup", "Look up a SKU", {"type": "object"}, lambda _a: "x")
        with self._client() as dgc, mock.patch(
                "dgc_sdk.client.ToolHub.start", side_effect=OSError("AF_UNIX path too long")):
            with self.assertRaises(DGCRuntimeError) as caught:
                dgc.session(cwd=self.work, permissions=self._auto(), tools=[tool])
            self.assertEqual(dgc._sessions, [])
        self.assertIn("AF_UNIX path too long", str(caught.exception))
        self.assertEqual(_serve_children(), [], "a failed setup left dgc serve running")


class ProtocolTests(_Base):
    def test_unknown_event_types_are_skipped_not_fatal(self):
        client = self._wire("unknown")
        try:
            client.start()
            self.assertEqual(client.next_event(timeout=5)["type"], "ready")
            event = client.next_event(timeout=5)
            self.assertEqual(event["type"], "info")
            self.assertEqual(event["message"], "after unknown")
            self.assertEqual(client.ignored_event_types, {"remote_status": 1, "remote_pairing": 1})
            reply = client.request({"type": "list_sessions", "request_id": "r-1"}, "sessions",
                                   timeout=5)
            self.assertEqual(reply["request_id"], "r-1")
        finally:
            client.close()

    def test_unknown_event_before_ready_is_still_a_protocol_error(self):
        client = self._wire("unknown-first")
        with self.assertRaises(wire.DGCProtocolError):
            client.start()
        client.close()

    def test_session_survives_a_cli_that_adds_event_types(self):
        wrapper = self.tmp / "inject_unknown.py"
        wrapper.write_text(INJECT_UNKNOWN, encoding="utf-8")
        python = sdk_runtime.discover_runtime().python or sys.executable
        with self._client(runtime=[python, str(wrapper)]) as dgc:
            session = dgc.session(cwd=self.work, permissions=self._auto())
            result = session.run("Summarize README. Do not edit files.", timeout=60)
            skipped = session.raw.ignored_event_types
        self.assertEqual(result.status, "completed", result)
        self.assertIn("checkout", result.final_text.lower())
        self.assertGreaterEqual(skipped.get("remote_status", 0), 2)

    def test_protocol_mismatch_raises_the_sdk_protocol_error(self):
        for offered, advice in ((13, "dgc update"), (15, "pip install -U dgc-sdk")):
            with DGC(state_dir=self.state,
                     runtime=[sys.executable, str(self.fake), "ok", str(offered)]) as dgc:
                with self.assertRaises(DGCProtocolError) as caught:
                    dgc.session(cwd=self.work)
            message = str(caught.exception)
            self.assertNotIsInstance(caught.exception, wire.DGCClientError)
            self.assertIn(f"protocol v{offered}", message)
            self.assertIn("9.9.9", message)
            self.assertIn(advice, message)
            if ON_LINUX:
                self.assertEqual(_serve_children(), [])

    def _fake_python(self, offered: int) -> Path:
        """An 'interpreter' whose DGC answers the discovery probe with another protocol."""
        fake = self.tmp / f"python-v{offered}"
        fake.write_text(f"#!/bin/sh\necho '{offered} 0.40.9 3 12'\n", encoding="utf-8")
        fake.chmod(0o755)
        return fake

    @unittest.skipUnless(os.name == "posix", "the fake interpreter is a shell script")
    def test_discovery_that_finds_only_other_protocols_raises_the_protocol_error(self):
        for offered, advice in ((13, "dgc update"), (15, "pip install -U dgc-sdk")):
            sdk_runtime._CACHE.clear()
            with self.assertRaises(DGCProtocolError) as caught:
                sdk_runtime.discover_runtime(
                    {"PATH": "/nonexistent", "DGC_PYTHON": str(self._fake_python(offered))},
                    home=self.tmp, use_current=False, checkout=False)
            message = str(caught.exception)
            self.assertIn(f"protocol v{offered}", message)
            self.assertIn("0.40.9", message)
            self.assertIn(advice, message)
        sdk_runtime._CACHE.clear()
        with self.assertRaises(DGCConfigError) as missing:
            sdk_runtime.discover_runtime({"PATH": "/nonexistent"}, home=self.tmp,
                                         use_current=False, checkout=False)
        self.assertNotIsInstance(missing.exception, DGCProtocolError)

    @unittest.skipUnless(os.name == "posix", "the fake interpreter is a shell script")
    def test_an_unusable_dgc_python_is_reported_when_another_runtime_is_used(self):
        sdk_runtime._CACHE.clear()
        env = {"PATH": os.environ.get("PATH", ""), "DGC_PYTHON": str(self._fake_python(13))}
        try:
            with self.assertLogs("dgc_sdk", "WARNING") as logged:
                found = sdk_runtime.discover_runtime(env, home=self.tmp, use_current=True,
                                                     checkout=sdk_runtime.is_checkout())
        finally:
            sdk_runtime._CACHE.clear()
        self.assertEqual(found.protocol, 14)
        self.assertIn("DGC_PYTHON", "\n".join(logged.output))
        self.assertIn("protocol v13", "\n".join(logged.output))


class RequestTests(_Base):
    def test_rejected_command_raises_at_once_with_its_reason(self):
        client = self._wire("reject")
        try:
            client.start()
            started = time.monotonic()
            with self.assertRaises(DGCCommandRejectedError) as caught:
                client.request({"type": "list_sessions", "request_id": "r-2"}, "sessions",
                               timeout=10)
            self.assertLess(time.monotonic() - started, 3.0)
            self.assertEqual(caught.exception.reason, "turn_in_progress")
            self.assertEqual(caught.exception.command, "list_sessions")
            self.assertIn("busy with a turn", str(caught.exception))
        finally:
            client.close()

    def test_error_reply_and_uncorrelated_failure_are_rejections(self):
        for mode in ("error-reply", "crash"):
            client = self._wire(mode)
            try:
                client.start()
                started = time.monotonic()
                with self.assertRaises(DGCCommandRejectedError):
                    client.request({"type": "list_sessions", "request_id": "r-3"}, "sessions",
                                   timeout=10)
                self.assertLess(time.monotonic() - started, 3.0, mode)
            finally:
                client.close()

    def test_concurrent_event_reader_does_not_steal_a_reply(self):
        client = self._wire("delayed")
        seen: list[str] = []
        stop = threading.Event()

        def pump():
            while not stop.is_set():
                try:
                    seen.append(client.next_event(timeout=0.1)["type"])
                except wire.DGCEventTimeout:
                    continue
                except wire.DGCClientError:
                    return
        try:
            client.start()
            reader = threading.Thread(target=pump, daemon=True)
            reader.start()
            for index in range(10):
                reply = client.request({"type": "list_sessions", "request_id": f"r-{index}"},
                                       "sessions", timeout=5)
                self.assertEqual(reply["request_id"], f"r-{index}")
            time.sleep(0.3)
            stop.set()
            reader.join(timeout=2)
        finally:
            client.close()
        self.assertNotIn("sessions", seen, "the event reader consumed a request's reply")
        self.assertIn("info", seen)

    def test_late_reply_is_dropped_and_long_waits_are_allowed(self):
        client = self._wire("late")
        try:
            client.start()
            self.assertEqual(client.next_event(timeout=5)["type"], "ready")
            with self.assertRaises(DGCTimeoutError):
                client.request({"type": "list_sessions", "request_id": "r-late"}, "sessions",
                               timeout=0.3)
            event = client.next_event(timeout=7200)
            self.assertEqual(event["type"], "info", "a late reply leaked into the event stream")
        finally:
            client.close()

    def test_resume_failures_are_sdk_errors_without_the_long_timeout(self):
        with self._client() as dgc:
            for target in ({"latest": True}, {"session_id": "/etc/nothing.json"}):
                started = time.monotonic()
                with self.assertRaises(DGCConfigError) as caught:
                    dgc.resume(cwd=self.work, permissions=self._auto(), **target)
                self.assertLess(time.monotonic() - started, 8.0, target)
                self.assertIsInstance(caught.exception.__cause__, DGCCommandRejectedError)
            self.assertEqual(dgc._sessions, [])

    def test_control_command_rejection_is_typed(self):
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions=self._auto())
            started = time.monotonic()
            with self.assertRaises(DGCCommandRejectedError) as caught:
                session.set_goal("", status="active")
            self.assertLess(time.monotonic() - started, 5.0)
            self.assertNotIsInstance(caught.exception, wire.DGCClientError)
            self.assertIn("no standing goal", str(caught.exception))

    def test_control_requests_during_a_streaming_run_keep_their_replies(self):
        _RuntimeModel.behavior = "stall"
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions=self._auto())
            handle = session.stream("Summarize README.", timeout=60)
            kinds: list[str] = []
            pump = threading.Thread(target=lambda: kinds.extend(e.type for e in handle),
                                    daemon=True)
            pump.start()
            failures: list[BaseException] = []
            started = time.monotonic()
            for _ in range(12):
                try:
                    session.list_permissions()
                except BaseException as exc:  # noqa: BLE001 - collected for the assertion
                    failures.append(exc)
            elapsed = time.monotonic() - started
            handle.cancel()
            pump.join(timeout=30)
            result = handle.result()
        self.assertEqual(failures, [])
        self.assertLess(elapsed, 10.0)
        self.assertNotIn("permissions", kinds, "control replies leaked into the run stream")
        self.assertEqual(result.status, "cancelled")

    def test_transport_errors_are_sdk_errors(self):
        for kind in (wire.DGCStartError, wire.DGCProcessError, wire.DGCCommandError,
                     wire.DGCCommandRejected, wire.DGCEventTimeout, wire.DGCProtocolError):
            self.assertTrue(issubclass(kind, DGCError), kind)
        self.assertTrue(issubclass(wire.DGCEventTimeout, DGCTimeoutError))
        self.assertTrue(issubclass(wire.DGCProtocolError, DGCProtocolError))


class TimeoutTests(_Base):
    def test_timeout_is_reported_as_timeout_not_cancel(self):
        _RuntimeModel.behavior = "stall"
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions=self._auto())
            started = time.monotonic()
            result = session.run("Summarize README.", timeout=2)
            self.assertLess(time.monotonic() - started, 15.0)
            self.assertEqual(result.status, "failed")
            self.assertEqual(result.reason, "timeout")
            self.assertIn("2s timeout", result.error or "")
            _RuntimeModel.behavior = "text"
            again = session.run("Summarize README. Do not edit files.", timeout=60)
        self.assertEqual(again.status, "completed", "the timed-out run was not stopped cleanly")

    def test_no_timeout_survives_a_quiet_stretch(self):
        _RuntimeModel.behavior = "slow"
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions=self._auto())
            session.raw._event_timeout = 1.0   # make "30 s of quiet" one second for the test
            result = session.run("Summarize README.", timeout=None)
        self.assertEqual(result.status, "completed", result)
        self.assertIn("slow model", result.final_text)

    def test_timeouts_above_an_hour_are_accepted(self):
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions=self._auto())
            result = session.run("Summarize README. Do not edit files.", timeout=7200)
            huge = session.run("Summarize README. Do not edit files.", timeout=10**9)
        self.assertEqual(result.status, "completed", result)
        self.assertEqual(huge.status, "completed", huge)

    def test_invalid_timeouts_fail_before_the_prompt_is_sent(self):
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions=self._auto())
            for bad in (0, -5, float("nan"), float("inf"), True, "60"):
                with self.assertRaises(DGCConfigError):
                    session.run("Summarize README.", timeout=bad)
        self.assertEqual(base._Model.posts, 0)

    def test_result_wait_from_another_thread_raises_when_it_lapses(self):
        _RuntimeModel.behavior = "stall"
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions=self._auto())
            handle = session.stream("Summarize README.", timeout=60)
            pump = threading.Thread(target=lambda: [None for _ in handle], daemon=True)
            pump.start()
            time.sleep(0.2)
            with self.assertRaises(DGCTimeoutError):
                handle.result(timeout=0.5)
            handle.cancel()
            pump.join(timeout=30)
            self.assertEqual(handle.result(timeout=None).status, "cancelled")

    def test_client_timeouts_are_configurable_and_validated(self):
        with self.assertRaises(DGCConfigError):
            self._client(request_timeout=0)
        with self.assertRaises(DGCConfigError):
            self._client(start_timeout=float("nan"))
        with self._client(request_timeout=45, start_timeout=60) as dgc:
            session = dgc.session(cwd=self.work, permissions=self._auto())
            self.assertEqual(session._request_timeout, 45)
            self.assertEqual(session.raw._start_timeout, 60)


class EnvironmentTests(_Base):
    @unittest.skipUnless(ON_LINUX, "reads /proc")
    def test_runtime_gets_a_minimal_environment(self):
        os.environ.update({"FAKE_CLOUD_SECRET": "not-a-real-secret", "GITHUB_TOKEN": "ghp_x",
                           "DGC_API_KEY": "host-key",
                           "PYTHONPATH": os.pathsep.join([str(self.tmp), os.environ.get(
                               "PYTHONPATH", "")])})
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions=self._auto())
            env = _proc_env(session.raw.pid)
        self.assertNotIn("FAKE_CLOUD_SECRET", env)
        self.assertNotIn("GITHUB_TOKEN", env)
        self.assertEqual(env["DGC_API_KEY"], "sk-local")
        self.assertEqual(env["HOME"], str(self.state / "home"))
        self.assertIn("PATH", env)
        # A source checkout needs only itself: not the SDK dir, not the host's PYTHONPATH.
        self.assertEqual(env.get("PYTHONPATH"), str(ROOT))

    @unittest.skipUnless(ON_LINUX, "reads /proc")
    def test_inherit_env_is_an_explicit_opt_in(self):
        os.environ.update({"FAKE_CLOUD_SECRET": "not-a-real-secret", "GITHUB_TOKEN": "ghp_x",
                           "DGC_API_KEY": "host-key"})
        with self._client(inherit_env=["FAKE_CLOUD_SECRET"]) as dgc:
            named = _proc_env(dgc.session(cwd=self.work).raw.pid)
        with self._client(inherit_env=True) as dgc:
            everything = _proc_env(dgc.session(cwd=self.work).raw.pid)
        self.assertEqual(named.get("FAKE_CLOUD_SECRET"), "not-a-real-secret")
        self.assertNotIn("GITHUB_TOKEN", named)
        self.assertEqual(everything.get("GITHUB_TOKEN"), "ghp_x")
        self.assertEqual(everything.get("DGC_API_KEY"), "sk-local",
                         "isolated mode must not pass the host's DGC key")
        with self.assertRaises(DGCConfigError):
            self._client(inherit_env="FAKE_CLOUD_SECRET")

    def test_agent_shell_cannot_read_host_secrets(self):
        os.environ["FAKE_CLOUD_SECRET"] = "not-a-real-secret"
        _RuntimeModel.behavior = "printenv"
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions=self._auto())
            result = session.run("print the secret", timeout=60)
        outputs = " ".join(tool.output or "" for tool in result.tools)
        self.assertIn("secret-absent", outputs, result.tools)
        self.assertNotIn("not-a-real-secret", outputs)

    def test_a_dgc_package_in_the_workspace_does_not_replace_the_runtime(self):
        if "-P" not in sdk_runtime.discover_runtime().argv:
            self.skipTest("the runtime's Python has no -P (it is older than 3.11)")
        shadow = self.work / "dgc"
        shadow.mkdir()
        (shadow / "__init__.py").write_text("raise SystemExit('workspace dgc was imported')\n")
        (shadow / "__main__.py").write_text("raise SystemExit('workspace dgc was imported')\n")
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions=self._auto())
            result = session.run("Summarize README. Do not edit files.", timeout=60)
        self.assertEqual(result.status, "completed", result)


class RetryPolicyTests(unittest.TestCase):
    def test_retry_policy_sets_only_what_the_runtime_honours(self):
        self.assertEqual(RetryPolicy().isolated_values(), {"model_stall_retries": 3})
        self.assertEqual(RetryPolicy(max_attempts=1).isolated_values(), {"model_stall_retries": 0})
        self.assertEqual(RetryPolicy(retry_on=(504, 503, 502, 500, 429), backoff_s=0.5)
                         .isolated_values(), {"model_stall_retries": 3})
        for bad in (0, 12, True, 2.5):
            with self.assertRaises(DGCConfigError):
                RetryPolicy(max_attempts=bad)
        with self.assertRaises(DGCUnsupportedError):
            RetryPolicy(retry_on=(429,))
        with self.assertRaises(DGCUnsupportedError):
            RetryPolicy(backoff_s=5)


def _make_venv(path: Path, python: str = sys.executable) -> Path:
    subprocess.run([python, "-m", "venv", "--without-pip", str(path)], check=True,
                   timeout=120, capture_output=True)
    bindir = path / ("Scripts" if os.name == "nt" else "bin")
    return bindir / ("python.exe" if os.name == "nt" else "python")


APP = textwrap.dedent('''
    import json, sys
    sys.path.insert(0, sys.argv[1])
    from dgc_sdk import DGC, define_tool
    from dgc_sdk.runtime import discover_runtime, is_checkout
    spec = discover_runtime()
    seen = []

    def lookup(args):
        seen.append(dict(args))
        return {"name": "Widget", "sku": args.get("sku")}

    tool = define_tool("sku_lookup", "Look up a product SKU in the company catalog",
                       {"type": "object", "properties": {"sku": {"type": "string"}},
                        "required": ["sku"]}, lookup)
    report = {"checkout": is_checkout(), "argv": list(spec.argv), "source": spec.source, "runs": []}
    for runtime in (None, [sys.argv[5], "serve"]):
        with DGC(state_dir=sys.argv[2], model="sdk-model", base_url=sys.argv[3],
                 api_key="sk-local", runtime=runtime) as dgc:
            session = dgc.session(cwd=sys.argv[4],
                                  permissions={"mode": "auto", "unhandled": "deny"}, tools=[tool])
            env = open(f"/proc/{session.raw.pid}/environ", "rb").read().split(b"\\0")
            result = session.run("look up sku A-1", timeout=60)
            report["runs"].append({
                "status": result.status, "text": result.final_text,
                "pythonpath": [item.decode() for item in env if item.startswith(b"PYTHONPATH=")],
            })
    report["seen"] = seen
    print("REPORT " + json.dumps(report))
''')


class DiscoveryTests(_Base):
    def _installed_cli(self, home: Path) -> Path:
        """A vibedgc.com-style install: a venv that can import dgc, and ~/.local/bin/dgc."""
        data = home / ".local" / "share" / "dgc" / "versions" / "0.41.6"
        # Build it from whichever Python this checkout's runtime uses, so its dependencies exist.
        runtime_python = sdk_runtime.discover_runtime().python or sys.executable
        python = _make_venv(data / ".venv", runtime_python)
        purelib = subprocess.run(
            [str(python), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
            check=True, capture_output=True, text=True).stdout.strip()
        deps = subprocess.run(
            [runtime_python, "-c", "import site; print('\\n'.join(site.getsitepackages()))"],
            check=True, capture_output=True, text=True).stdout.split()
        deps = [path for path in deps if Path(path).is_dir()]
        Path(purelib, "dgc_test_install.pth").write_text("\n".join([str(ROOT)] + deps) + "\n")
        launcher = data / ".venv" / "bin" / "dgc"
        launcher.write_text(f"#!{python}\nimport sys\nfrom dgc.cli import main\n"
                            "if __name__ == '__main__':\n    sys.exit(main())\n")
        launcher.chmod(0o755)
        (data / ".complete").write_text("version=0.41.6\n")
        (home / ".local" / "bin").mkdir(parents=True)
        (home / ".local" / "bin" / "dgc").symlink_to(launcher)
        return launcher

    def test_discovery_finds_path_launcher_before_the_installer_layout(self):
        home = self.tmp / "disc-home"
        launcher = self._installed_cli(home)
        pathdir = self.tmp / "pathbin"
        pathdir.mkdir()
        (pathdir / "dgc").symlink_to(launcher)
        found = sdk_runtime.discover_runtime({"PATH": str(pathdir)}, home=home,
                                             use_current=False, checkout=False)
        self.assertEqual(found.argv, (str(pathdir / "dgc"), "serve"))
        self.assertEqual(found.protocol, 14)
        self.assertEqual(found.pythonpath, ())
        found = sdk_runtime.discover_runtime({"PATH": "/nonexistent"}, home=home,
                                             use_current=False, checkout=False)
        self.assertEqual(found.argv, (str(home / ".local" / "bin" / "dgc"), "serve"))
        (home / ".local" / "bin" / "dgc").unlink()
        sdk_runtime._CACHE.clear()
        found = sdk_runtime.discover_runtime({"PATH": "/nonexistent"}, home=home,
                                             use_current=False, checkout=False)
        self.assertEqual(found.argv, (str(launcher), "serve"))
        with self.assertRaises(DGCConfigError) as caught:
            sdk_runtime.discover_runtime({"PATH": "/nonexistent", "DGC_PYTHON": "/nope/python"},
                                         home=self.tmp, use_current=False, checkout=False)
        self.assertIn("DGC_PYTHON /nope/python", str(caught.exception))
        self.assertIn("install.sh", str(caught.exception))

    @unittest.skipUnless(ON_LINUX, "reads /proc and builds POSIX venvs")
    def test_installed_wheel_uses_the_installed_cli_and_custom_tools_work(self):
        """A pip-installed SDK in an app venv without dgc: no DGC_PYTHON, no PYTHONPATH."""
        home = self.tmp / "app-home"
        launcher = self._installed_cli(home)
        app_python = _make_venv(self.tmp / "app-venv")
        wheel_site = self.tmp / "app-site"
        shutil.copytree(ROOT / "sdk" / "python" / "dgc_sdk", wheel_site / "dgc_sdk",
                        ignore=shutil.ignore_patterns("__pycache__"))
        (self.tmp / "app.py").write_text(APP, encoding="utf-8")
        _RuntimeModel.behavior = "mcp"
        done = subprocess.run(
            [str(app_python), str(self.tmp / "app.py"), str(wheel_site), str(self.state),
             self.base_url, str(self.work), str(launcher)],
            env={"PATH": "/usr/bin:/bin", "HOME": str(home), "LANG": "C.UTF-8"},
            capture_output=True, text=True, timeout=180)
        lines = [line for line in done.stdout.splitlines() if line.startswith("REPORT ")]
        self.assertTrue(lines, done.stdout + done.stderr)
        report = json.loads(lines[-1][len("REPORT "):])
        self.assertFalse(report["checkout"])
        self.assertEqual(report["argv"], [str(home / ".local" / "bin" / "dgc"), "serve"])
        self.assertEqual(len(report["runs"]), 2)
        for run in report["runs"]:
            self.assertEqual(run["status"], "completed", report)
            self.assertIn("widget", run["text"].lower())
            self.assertEqual(run["pythonpath"], [], "the app's paths leaked into the runtime")
        self.assertEqual([item.get("sku") for item in report["seen"]], ["A-1", "A-1"])


if __name__ == "__main__":
    unittest.main()
