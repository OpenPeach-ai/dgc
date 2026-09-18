"""SDK examples, the README quickstart and the workbench run as shipped (mock model, temp HOME).

The examples are run the way a user runs them after `pip install dgc-sdk`: as scripts from an
unrelated directory, with the package importable from PYTHONPATH, and the model and endpoint
given through DGC_MODEL / DGC_BASE_URL.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples" / "sdk"
INSTALLED = os.environ.get("DGC_SDK_TEST_INSTALLED") == "1"


def _sse(delta: dict, finish: str | None = None) -> str:
    return "data: " + json.dumps({"id": "mock", "object": "chat.completion.chunk",
                                  "choices": [{"index": 0, "delta": delta,
                                               "finish_reason": finish}]}) + "\n\n"


def _answer(text: str) -> str:
    return _sse({"content": text}) + _sse({}, finish="stop") + "data: [DONE]\n\n"


def _call(name: str, args: dict) -> str:
    return (_sse({"tool_calls": [{"index": 0, "id": f"call_{name}", "type": "function",
                                  "function": {"name": name, "arguments": json.dumps(args)}}]})
            + _sse({}, finish="tool_calls") + "data: [DONE]\n\n")


class _Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, body: str, kind: str = "text/event-stream") -> None:
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(json.dumps({"data": [{"id": "sdk-model"}]}), "application/json")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        messages = body.get("messages") or []
        prompt, tools_since = "", 0
        for message in reversed(messages):
            if message.get("role") == "tool":
                tools_since += 1
            if message.get("role") == "user":
                prompt = str(message.get("content") or "")
                break
        low = prompt.lower()
        if "return only valid json" in low or "return json {ok" in low:
            self._send(_answer('{"ok": true, "summary": "checkout flow looks fine"}'))
        elif "smallest safe fix" in low:
            steps = [
                _call("write_file", {"path": "calc.py", "content": "def add(a, b):\n    return a + b\n"}),
                _call("write_file", {"path": ".github/workflows/ci.yml", "content": "name: ci\n"}),
                _answer("Fixed add() and added CI."),
            ]
            self._send(steps[min(tools_since, len(steps) - 1)])
        elif "fewer words" in low:
            self._send(_answer("A checkout flow."))
        elif tools_since:
            self._send(_answer("Done."))
        else:
            self._send(_answer("The repository holds a checkout flow that empties the cart."))


class ExampleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_address[1]}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dgc-sdk-examples-"))
        self.work = self.tmp / "work"
        self.work.mkdir()
        (self.work / "README.md").write_text("A checkout flow.\n", encoding="utf-8")
        self.home = self.tmp / "home"
        self.home.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _env(self, **extra: str) -> dict[str, str]:
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("DGC_") or key in ("DGC_PYTHON", "DGC_SDK_TEST_INSTALLED")}
        env.update(HOME=str(self.home), DGC_MODEL="sdk-model", DGC_BASE_URL=self.base_url,
                   PYTHONDONTWRITEBYTECODE="1")
        if not INSTALLED:
            # What `pip install dgc-sdk` provides, without touching this interpreter.
            env["PYTHONPATH"] = os.pathsep.join(
                [str(ROOT / "sdk" / "python"), str(ROOT), env.get("PYTHONPATH", "")]).rstrip(os.pathsep)
        env.update(extra)
        return env

    def _run(self, name: str, *args: str, env: dict[str, str] | None = None,
             timeout: float = 180) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(EXAMPLES / name), *args], cwd=self.tmp,
                              env=env or self._env(), capture_output=True, text=True, timeout=timeout)

    def test_examples_do_not_patch_sys_path_or_use_fixed_tmp_paths(self):
        for path in sorted(EXAMPLES.glob("*.py")) + [EXAMPLES / "hello_run.mjs"]:
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("sys.path", text, path.name)
            self.assertIsNone(re.search(r"[\"']/tmp/", text), f"{path.name} uses a fixed /tmp path")
            self.assertNotRegex(text, r"\b192\.168\.\d+\.\d+\b", f"{path.name} names a LAN address")

    def test_examples_refuse_to_run_without_a_model(self):
        env = self._env()
        env.pop("DGC_MODEL")
        for name in ("hello_run.py", "app_session.py", "resume_run.py", "ci_review.py"):
            done = self._run(name, str(self.work), env=env, timeout=60)
            self.assertEqual(done.returncode, 2, (name, done.stderr))
            self.assertIn("DGC_MODEL", done.stderr, name)

    def test_hello_run(self):
        done = self._run("hello_run.py", str(self.work))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("status: completed", done.stdout)
        self.assertIn("checkout flow", done.stdout)

    def test_app_session_streams_text(self):
        done = self._run("app_session.py", str(self.work))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("empties the cart", done.stdout)
        self.assertIn("[turn_end]", done.stdout)
        self.assertIn("status: completed", done.stdout)

    def test_resume_run_reopens_the_same_session(self):
        done = self._run("resume_run.py", str(self.work))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        first = re.search(r"first run: completed, session (\S+)", done.stdout)
        resumed = re.search(r"resumed: session (\S+)", done.stdout)
        self.assertTrue(first and resumed, done.stdout)
        self.assertEqual(first.group(1), resumed.group(1))
        self.assertIn("A checkout flow.", done.stdout)

    def test_ci_review_prints_schema_output_and_exit_code(self):
        done = self._run("ci_review.py", str(self.work))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        report = json.loads(done.stdout)
        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["output"], {"ok": True, "summary": "checkout flow looks fine"})

    def test_ci_edit_writes_a_patch_git_apply_accepts(self):
        if shutil.which("git") is None:
            self.skipTest("git is not installed")
        repo = self.tmp / "repo"
        repo.mkdir()
        (repo / "calc.py").write_text("def add(a, b):\n    return a - b\n", encoding="utf-8")
        git = ["git", "-c", "user.email=sdk@test", "-c", "user.name=sdk", "-c", "init.defaultBranch=main"]
        subprocess.run(git + ["init", "-q"], cwd=repo, check=True)
        subprocess.run(git + ["add", "calc.py"], cwd=repo, check=True)
        subprocess.run(git + ["commit", "-q", "-m", "base"], cwd=repo, check=True)
        index_before = (repo / ".git" / "index").read_bytes()
        patch = self.tmp / "fix.patch"
        done = self._run("ci_edit.py", str(repo), "--patch", str(patch))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        report = json.loads(done.stdout)
        self.assertEqual(report["status"], "completed")
        text = patch.read_text(encoding="utf-8")
        self.assertIn("@@", text)
        self.assertIn("+    return a + b", text)
        self.assertIn("b/.github/workflows/ci.yml", text, "new files under dot-directories are part of the patch")
        self.assertEqual((repo / ".git" / "index").read_bytes(), index_before, "the real index is untouched")
        clean = self.tmp / "clean"
        subprocess.run(["git", "clone", "-q", str(repo), str(clean)], check=True)
        check = subprocess.run(["git", "apply", "--check", str(patch)], cwd=clean,
                               capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_ci_edit_refuses_a_non_git_workspace(self):
        done = self._run("ci_edit.py", str(self.work), "--patch", str(self.tmp / "x.patch"), timeout=60)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn("not a git checkout", done.stderr)

    def test_readme_quickstart_runs_verbatim(self):
        snippet = _quickstart(ROOT / "sdk" / "python" / "README.md")
        for other in (ROOT / "sdk" / "README.md", ROOT / "docs" / "SDK.md"):
            self.assertIn(snippet, other.read_text(encoding="utf-8"),
                          f"{other.relative_to(ROOT)} must carry the same quickstart")
        done = subprocess.run([sys.executable, "-c", snippet], cwd=self.work, env=self._env(),
                              capture_output=True, text=True, timeout=180)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        first = done.stdout.splitlines()[0]
        self.assertTrue(first.startswith("completed"), done.stdout)
        self.assertIn("checkout flow", done.stdout)

    def test_node_example_runs_from_a_checkout(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node is not installed")
        major = int(subprocess.run([node, "-p", "process.versions.node.split('.')[0]"],
                                   capture_output=True, text=True).stdout.strip() or 0)
        if major < 22:
            self.skipTest("Node 22 or newer is required")
        env = self._env()
        env.setdefault("DGC_PYTHON", sys.executable)
        done = subprocess.run([node, "--experimental-strip-types", "--no-warnings",
                               str(EXAMPLES / "hello_run.mjs"), str(self.work)],
                              cwd=self.tmp, env=env, capture_output=True, text=True, timeout=180)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("status: completed", done.stdout)


def _quickstart(readme: Path) -> str:
    text = readme.read_text(encoding="utf-8")
    match = re.search(r"```python\n(.*?)```", text, re.S)
    assert match, f"no python block in {readme}"
    return match.group(1)


class WorkbenchTests(unittest.TestCase):
    """The workbench is loopback-only, token-gated, same-origin and JSON-only."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="dgc-sdk-workbench-test-"))
        (cls.tmp / "home").mkdir()
        work = cls.tmp / "work"
        work.mkdir()
        (work / "README.md").write_text("bench\n", encoding="utf-8")
        env = {key: value for key, value in os.environ.items() if not key.startswith("DGC_")
               or key in ("DGC_PYTHON", "DGC_SDK_TEST_INSTALLED")}
        env["HOME"] = str(cls.tmp / "home")
        if not INSTALLED:
            env["PYTHONPATH"] = os.pathsep.join([str(ROOT / "sdk" / "python"), str(ROOT)])
        cls.proc = subprocess.Popen(
            [sys.executable, str(EXAMPLES / "workbench.py"), "--mock", "--port", "0",
             "--workspace", str(work)],
            cwd=cls.tmp, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = cls.proc.stdout.readline()
        match = re.search(r"http://([\d.]+):(\d+)/#token=(\S+)", line)
        if not match:
            cls.proc.kill()
            raise AssertionError(f"workbench did not print its URL: {line!r} {cls.proc.stderr.read()}")
        cls.host, cls.port, cls.token = match.group(1), int(match.group(2)), match.group(3)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        for stream in (cls.proc.stdout, cls.proc.stderr):
            stream.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _request(self, method: str, path: str, body: dict | None = None, *,
                 headers: dict[str, str] | None = None, token: bool = True,
                 content_type: str = "application/json") -> tuple[int, dict]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        sent = {"Host": f"127.0.0.1:{self.port}"}
        if token:
            sent["Authorization"] = f"Bearer {self.token}"
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            sent["Content-Type"] = content_type
        sent.update(headers or {})
        conn.request(method, path, body=payload, headers=sent)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, (json.loads(data) if data else {})

    def _events_until(self, predicate, timeout: float = 60.0) -> list[dict]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        conn.request("GET", "/api/events", headers={"Host": f"127.0.0.1:{self.port}",
                                                    "Authorization": f"Bearer {self.token}"})
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        seen: list[dict] = []
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                line = response.fp.readline().decode()
                if line.startswith("data: "):
                    seen.append(json.loads(line[6:]))
                    if predicate(seen[-1]):
                        return seen
        finally:
            conn.close()
        self.fail(f"event never arrived; saw {[e.get('type') for e in seen]}")

    def test_binds_loopback_by_default(self):
        self.assertEqual(self.host, "127.0.0.1")
        self.assertGreaterEqual(len(self.token), 32)

    def test_page_is_served_with_a_restrictive_policy(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/", headers={"Host": f"127.0.0.1:{self.port}"})
        response = conn.getresponse()
        body = response.read().decode()
        conn.close()
        self.assertEqual(response.status, 200)
        self.assertIn("frame-ancestors 'none'", response.getheader("Content-Security-Policy", ""))
        self.assertNotIn(self.token, body)

    def test_api_needs_the_token(self):
        for method, path, body in (("POST", "/api/run", {"prompt": "hi"}),
                                   ("POST", "/api/permission", {"id": "x", "decision": "once"}),
                                   ("GET", "/api/events", None), ("GET", "/health", None)):
            status, _ = self._request(method, path, body, token=False)
            self.assertEqual(status, 401, path)
        status, _ = self._request("POST", "/api/run", {"prompt": "hi"},
                                  headers={"Authorization": "Bearer wrong"}, token=False)
        self.assertEqual(status, 401)

    def test_cross_site_and_rebinding_requests_are_refused(self):
        # A CORS-simple cross-site POST (text/plain) is refused before it is parsed.
        status, _ = self._request("POST", "/api/run", {"prompt": "edit guard"},
                                  content_type="text/plain")
        self.assertEqual(status, 415)
        status, _ = self._request("POST", "/api/run", {"prompt": "edit guard"},
                                  headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self._request("POST", "/api/run", {"prompt": "edit guard"},
                                  headers={"Host": "evil.example"})
        self.assertEqual(status, 421)

    def test_run_approve_by_id_and_finish(self):
        status, reply = self._request("POST", "/api/run", {"prompt": "edit guard please"},
                                      headers={"Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual((status, reply), (200, {"status": "running"}))
        seen = self._events_until(lambda e: e.get("type") == "permission_request")
        request_id = seen[-1]["id"]
        status, _ = self._request("POST", "/api/permission", {"id": "not-" + request_id, "decision": "once"})
        self.assertEqual(status, 409, "a decision must name the pending request")
        status, _ = self._request("POST", "/api/permission", {"id": request_id, "decision": "once"})
        self.assertEqual(status, 200)
        done = self._events_until(lambda e: e.get("type") == "result")
        self.assertEqual(done[-1]["status"], "completed", done[-1])
        self.assertTrue((self.tmp / "work" / "guard.py").exists())


if __name__ == "__main__":
    unittest.main()
