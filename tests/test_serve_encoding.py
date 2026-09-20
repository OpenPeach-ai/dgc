"""`dgc serve` speaks UTF-8 NDJSON on every OS, whatever the console code page is.

On Windows with a legacy code page (cp1252 on an English install, which is also what a bare
`python -m dgc serve` gets there) the backend could not encode its own ready frame: the command
registry contains "·". ``Emitter`` caught ``ValueError``, and ``UnicodeEncodeError`` is one, so
the frame was dropped in silence and the editor waited forever. A model's CJK or emoji output was
destroyed the same way.

These tests run everywhere: the encoding is forced with PYTHONIOENCODING, so Linux and macOS
exercise exactly the path Windows takes by default.
"""
from __future__ import annotations

import io
import json
import os
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

from dgc.protocol import Emitter, configure_utf8_stream  # noqa: E402

#: Latin-1 (fine in cp1252), an arrow (not in cp1252), CJK and an emoji (in neither).
HARD_TEXT = "héllo → 你好 🍑"


def _sse(delta: dict, finish: str | None = None) -> str:
    return "data: " + json.dumps({"id": "mock", "object": "chat.completion.chunk",
                                  "choices": [{"index": 0, "delta": delta,
                                               "finish_reason": finish}]}) + "\n\n"


class _Model(BaseHTTPRequestHandler):
    """Answers every prompt with HARD_TEXT."""

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
        self.rfile.read(length)
        body = _sse({"content": HARD_TEXT}) + _sse({}, finish="stop") + "data: [DONE]\n\n"
        self._send(body.encode("utf-8"), "text/event-stream")


class EmitterEncodingTests(unittest.TestCase):
    """The emitter never loses a frame, whatever the stream it was handed can encode."""

    def test_a_cp1252_text_stream_still_carries_every_frame(self):
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="cp1252", errors="strict", newline="\n")
        Emitter._encoding_failure_reported = False
        emitter = Emitter(stream)
        emitter.emit("text_delta", text=HARD_TEXT)
        stream.flush()
        payload = raw.getvalue().strip()
        self.assertTrue(payload, "the frame was dropped instead of being re-encoded")
        event = json.loads(payload.decode("utf-8"))     # the byte layer carries real UTF-8
        self.assertEqual(event["type"], "text_delta")
        self.assertEqual(event["text"], HARD_TEXT)

    def test_a_text_only_stream_falls_back_to_escaped_ascii(self):
        """A stream with no byte layer at all: JSON escapes still carry the exact text."""

        class _TextOnly:
            encoding = "cp1252"

            def __init__(self):
                self.text = ""

            def write(self, value):
                value.encode("cp1252")               # raises exactly as a real console would
                self.text += value

            def flush(self):
                pass

        stream = _TextOnly()
        Emitter._encoding_failure_reported = False
        Emitter(stream).emit("text_delta", text=HARD_TEXT)
        self.assertTrue(stream.text, "the frame was dropped instead of being escaped")
        self.assertEqual(json.loads(stream.text)["text"], HARD_TEXT)
        self.assertEqual(stream.text, stream.text.encode("ascii").decode("ascii"))

    def test_a_reconfigured_stream_writes_utf8_bytes_with_unix_newlines(self):
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="cp1252", errors="strict", newline="\r\n")
        configure_utf8_stream(stream)
        emitter = Emitter(stream)
        emitter.emit("text_delta", text=HARD_TEXT)
        stream.flush()
        payload = raw.getvalue()
        self.assertNotIn(b"\r", payload, "a CRLF line ending puts a stray byte in the NDJSON")
        self.assertEqual(json.loads(payload.decode("utf-8"))["text"], HARD_TEXT)

    def test_configure_is_harmless_on_a_stream_that_cannot_be_reconfigured(self):
        class _Fake:
            encoding = "cp1252"

            def __init__(self):
                self.lines: list[str] = []

            def write(self, text):
                self.lines.append(text)

            def flush(self):
                pass

        fake = _Fake()
        self.assertIs(configure_utf8_stream(fake), fake)
        Emitter(fake).emit("info", message=HARD_TEXT)
        self.assertEqual(json.loads("".join(fake.lines))["message"], HARD_TEXT)

    def test_a_closed_stream_is_still_treated_as_a_departed_front_end(self):
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="utf-8", newline="\n")
        stream.close()
        Emitter(stream).emit("info", message="after close")   # must not raise


class ServeStdoutEncodingTests(unittest.TestCase):
    """A real `dgc serve` child, started with a legacy code page, writes only valid UTF-8."""

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _serve(self, encoding: str) -> tuple[subprocess.Popen, list[bytes]]:
        home = tempfile.TemporaryDirectory(prefix="dgc-encoding-home-")
        work = tempfile.TemporaryDirectory(prefix="dgc-encoding-work-")
        self.addCleanup(home.cleanup)
        self.addCleanup(work.cleanup)
        state = Path(home.name)
        (state / ".dgc").mkdir()
        (state / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": f"http://127.0.0.1:{self.port}/v1", "model": "mock-model",
            "api_mode": "chat_completions", "suggest": False, "notes": False,
        }))
        env = dict(os.environ, HOME=str(state), USERPROFILE=str(state), PYTHONPATH=str(PROJECT),
                   PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING=encoding, PYTHONUTF8="0")
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
            env[var] = str(state)
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=work.name, env=env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL)
        self.addCleanup(self._stop, proc)
        lines: list[bytes] = []

        def read():
            for line in proc.stdout:
                lines.append(line)

        threading.Thread(target=read, daemon=True).start()
        return proc, lines

    @staticmethod
    def _stop(proc: subprocess.Popen) -> None:
        if proc.poll() is None:
            try:
                proc.stdin.close()
            except (OSError, ValueError):
                pass
            try:
                proc.wait(timeout=40)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
        for pipe in (proc.stdin, proc.stdout):
            try:
                pipe.close()
            except (OSError, ValueError):
                pass

    @staticmethod
    def _await(lines: list[bytes], predicate, timeout: float = 120) -> dict:
        deadline = time.monotonic() + timeout
        seen: list[str] = []
        while time.monotonic() < deadline:
            for raw in list(lines):
                text = raw.decode("utf-8")           # the assertion: every line is valid UTF-8
                if not text.strip():
                    continue
                event = json.loads(text)
                seen.append(event.get("type", "?"))
                if predicate(event):
                    return event
            time.sleep(0.05)
        raise AssertionError(f"no matching event in {timeout}s; saw {seen[-30:]}")

    def test_the_ready_frame_survives_a_legacy_code_page(self):
        proc, lines = self._serve("cp1252")
        ready = self._await(lines, lambda e: e["type"] == "ready")
        registry = json.dumps(ready.get("commands", []), ensure_ascii=False)
        self.assertIn("·", registry, "the command registry's own non-Latin-1 text is the canary")

    def test_model_text_reaches_the_front_end_intact(self):
        proc, lines = self._serve("cp1252")
        self._await(lines, lambda e: e["type"] == "ready")
        proc.stdin.write(json.dumps({"type": "prompt", "text": "say it"}).encode("utf-8") + b"\n")
        proc.stdin.flush()
        delta = self._await(lines, lambda e: e["type"] == "text_delta" and e.get("text"))
        self.assertIn(HARD_TEXT, delta["text"])

    def test_utf8_is_also_correct_when_the_environment_already_says_so(self):
        proc, lines = self._serve("utf-8")
        ready = self._await(lines, lambda e: e["type"] == "ready")
        self.assertTrue(ready.get("version"))


if __name__ == "__main__":
    unittest.main()
