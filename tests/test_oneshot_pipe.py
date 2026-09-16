"""`dgc -p` whose reader goes away early (`dgc -p ... | head -1`) exits quietly, like other CLIs."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]


def _sse(delta, finish=None):
    return "data: " + json.dumps({"id": "m", "object": "chat.completion.chunk", "choices": [
        {"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"


class _Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, body, kind):
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(json.dumps({"data": [{"id": "mock-model"}]}), "application/json")

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        answer = "\n".join(f"line {i} of a long answer" for i in range(4000))
        self._send(_sse({"content": answer}) + _sse({}, finish="stop") + "data: [DONE]\n\n",
                   "text/event-stream")


class OneShotBrokenPipeTests(unittest.TestCase):
    def test_a_reader_that_closes_early_gets_no_traceback(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        home = tempfile.TemporaryDirectory(prefix="dgc-pipe-home-")
        self.addCleanup(home.cleanup)
        work = tempfile.TemporaryDirectory(prefix="dgc-pipe-work-")
        self.addCleanup(work.cleanup)
        env = dict(os.environ, HOME=home.name, PYTHONPATH=str(PROJECT), PYTHONDONTWRITEBYTECODE="1")
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
            env[var] = home.name
        for output_format in ("json", "text"):
            with self.subTest(output_format=output_format):
                read, write = os.pipe()
                os.close(read)                       # the reader is already gone
                try:
                    done = subprocess.run(
                        [sys.executable, "-m", "dgc", "-p", "say a lot", "--output-format",
                         output_format, "--trust", "--base-url",
                         f"http://127.0.0.1:{server.server_address[1]}/v1", "--model", "mock-model"],
                        cwd=work.name, env=env, stdin=subprocess.DEVNULL, stdout=write,
                        stderr=subprocess.PIPE, text=True, timeout=120)
                finally:
                    os.close(write)
                self.assertNotIn("BrokenPipeError", done.stderr)
                self.assertNotIn("Exception ignored", done.stderr)
                # 141 is SIGPIPE after a closed reader. Exit 0 is the same quiet outcome when
                # the process finishes the write before the kernel delivers SIGPIPE.
                self.assertIn(done.returncode, (0, 141), done.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
