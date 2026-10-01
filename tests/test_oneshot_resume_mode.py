"""`dgc -p --mode X --continue` runs in X, whatever mode the session it reopens ran in.

0.47.0 records a chat's mode in its session file and reopening brings it back. It brought it back
over the flag: `dgc -p "summarise the diff, change nothing" --mode plan --continue` on a session
last run in auto ran in auto, so every command and write it made went ahead with no approval. A
script that names no mode never gets more than its configured one from a session either.

Drives the real CLI against a local model that records the permission mode each request's system
prompt names, so the test sees the mode the run actually had.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

PROJECT = Path(__file__).resolve().parents[1]
MODE = re.compile(r"^# Permission mode: (\w+)$", re.M)


def _sse(delta: dict, finish: str | None = None) -> str:
    return "data: " + json.dumps({"id": "m", "object": "chat.completion.chunk",
                                  "choices": [{"index": 0, "delta": delta,
                                               "finish_reason": finish}]}) + "\n\n"


class _Model(BaseHTTPRequestHandler):
    modes: list[str] = []

    def log_message(self, *args):
        pass

    def _send(self, body: str, kind: str) -> None:
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(json.dumps({"data": [{"id": "fixture"}]}), "application/json")

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        system = next((str(m.get("content") or "") for m in request.get("messages") or []
                       if m.get("role") == "system"), "")
        found = MODE.search(system)
        if found:
            _Model.modes.append(found.group(1))
        self._send(_sse({"content": "Nothing to change."}) + _sse({}, finish="stop")
                   + "data: [DONE]\n\n", "text/event-stream")


class OneShotResumeModeTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        _Model.modes = []
        self.home = Path(tempfile.mkdtemp(prefix="dgc-oneshot-resume-"))
        self.work = self.home / "ws"
        self.work.mkdir()
        (self.home / ".dgc").mkdir()
        (self.home / ".dgc" / "config.json").write_text(json.dumps({
            "model": "fixture", "mode": "default", "suggest": False, "eta": False,
            "base_url": f"http://127.0.0.1:{self.server.server_address[1]}/v1"}), encoding="utf-8")

    def dgc(self, *flags) -> str:
        """Run one `dgc -p` and return the mode its request ran in."""
        env = {**os.environ, "HOME": str(self.home), "USERPROFILE": str(self.home),
               "PYTHONPATH": str(PROJECT), "DGC_API_KEY": "sk-local"}
        env.pop("DGC_HOME", None)
        before = len(_Model.modes)
        done = subprocess.run([sys.executable, "-m", "dgc", "-p", "summarise the diff", *flags],
                              cwd=self.work, env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        self.assertGreater(len(_Model.modes), before, f"the run never reached the model:\n{done.stderr[-2000:]}")
        return _Model.modes[before]

    def test_a_named_mode_wins_over_the_session_it_reopens(self):
        self.assertEqual(self.dgc("--mode", "auto", "--trust"), "auto")
        self.assertEqual(self.dgc("--mode", "plan", "--continue"), "plan",
                         "--mode plan --continue ran in the auto the session was saved in")
        self.assertEqual(self.dgc("--mode", "default", "--continue"), "default")

    def test_a_named_mode_wins_over_a_session_reopened_by_id(self):
        self.assertEqual(self.dgc("--mode", "auto", "--trust"), "auto")
        sessions = sorted((self.home / ".dgc" / "sessions").rglob("*.json"))
        self.assertTrue(sessions, "the first run saved no session")
        self.assertEqual(self.dgc("--mode", "plan", "--resume", sessions[-1].stem), "plan")

    def test_a_script_with_no_mode_never_gets_more_than_its_own(self):
        self.assertEqual(self.dgc("--mode", "auto", "--trust"), "auto")
        self.assertEqual(self.dgc("--continue"), "default",
                         "a script with no --mode took auto from the session it reopened")

    def test_a_script_with_no_mode_still_reopens_a_plan(self):
        self.assertEqual(self.dgc("--mode", "plan"), "plan")
        self.assertEqual(self.dgc("--continue"), "plan", "a session that was planning lost its plan")


if __name__ == "__main__":
    unittest.main()
