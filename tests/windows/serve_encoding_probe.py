"""M0 diagnostic: does `dgc serve` keep its NDJSON stdout valid UTF-8 when the interpreter's
stdout encoding is the Windows ANSI code page (cp1252)?

On Windows a piped stdout uses ``locale.getpreferredencoding()`` (cp1252 on en-US) unless UTF-8
mode is on, and ``dgc/`` never reconfigures stdout. This probe drives a real ``dgc serve`` child
(through the SDK, which speaks the protocol) against a loopback mock model whose answer is
``héllo → 你好 🍑``, once with the child forced to cp1252 and once to utf-8, and reports whether
the model text arrived intact. PYTHONIOENCODING is honoured on every OS, so this reproduces off
Windows too; the Windows runner is where it counts for the release.

    DGC_PYTHON=<python with the dgc CLI> python tests/windows/serve_encoding_probe.py

Exit code is always 0: this is a diagnostic, and the workflow leg is non-blocking. The findings
are the ``M0-RESULT`` lines.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
# Import the SDK from source unless a wheel is being tested (DGC_SDK_TEST_INSTALLED=1).
if os.environ.get("DGC_SDK_TEST_INSTALLED") != "1":
    sys.path[:0] = [str(ROOT / "sdk" / "python"), str(ROOT)]

from dgc_sdk import DGC, DGCError  # noqa: E402

ANSWER = "héllo → 你好 🍑"        # é encodes in cp1252; → 你好 🍑 do not
MARKERS = ("héllo", "你好", "🍑")


def _sse(delta: dict, finish: str | None = None) -> str:
    return "data: " + json.dumps({"id": "mock", "object": "chat.completion.chunk",
                                  "choices": [{"index": 0, "delta": delta,
                                               "finish_reason": finish}]}) + "\n\n"


class _Model(BaseHTTPRequestHandler):
    def log_message(self, *_a):  # quiet
        pass

    def do_GET(self):
        body = json.dumps({"data": [{"id": "sdk-model"}]}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        payload = (_sse({"content": ANSWER}) + _sse({}, finish="stop") + "data: [DONE]\n\n")
        data = payload.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(data)


def _start_model():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/v1"


def _run(base_url: str, encoding: str) -> dict:
    """One serve run with the child's stdout encoding forced to ``encoding``."""
    state = Path(tempfile.mkdtemp(prefix="dgc-enc-state-"))
    work = Path(tempfile.mkdtemp(prefix="dgc-enc-work-"))
    (work / "README.md").write_text("hi\n", encoding="utf-8")
    outcome = {"encoding": encoding, "status": None, "final_text": None,
               "markers_present": None, "error": None}
    try:
        with DGC(state_dir=state, model="sdk-model", base_url=base_url, api_key="sk-local",
                 extra_env={"PYTHONIOENCODING": encoding,
                            "PYTHONUTF8": "1" if encoding.lower().startswith("utf") else "0"}) as dgc:
            session = dgc.session(cwd=work, permissions={"mode": "auto", "unhandled": "deny"})
            result = session.run("Say the greeting exactly.", timeout=120)
            outcome["status"] = result.status
            outcome["final_text"] = result.final_text
            outcome["markers_present"] = sorted(m for m in MARKERS if m in (result.final_text or ""))
    except DGCError as exc:
        outcome["error"] = f"{type(exc).__name__}: {exc}"
    except Exception as exc:  # noqa: BLE001 - a diagnostic records every failure shape
        outcome["error"] = f"{type(exc).__name__}: {exc}"
    return outcome


def main() -> int:
    server, base_url = _start_model()
    try:
        results = [_run(base_url, "utf-8"), _run(base_url, "cp1252")]
    finally:
        server.shutdown()
        server.server_close()

    for r in results:
        intact = r["markers_present"] == sorted(MARKERS) and r["error"] is None
        summary = (f"M0-RESULT windows-encoding platform={sys.platform} "
                   f"enc={r['encoding']} status={r['status']} "
                   f"non_ascii_intact={'YES' if intact else 'NO'} "
                   f"markers={','.join(r['markers_present'] or [])!r} "
                   f"error={r['error']!r}")
        print(summary, flush=True)
        print(f"    final_text={r['final_text']!r}", flush=True)
    print(json.dumps({"probe": "windows-encoding", "platform": sys.platform,
                      "results": results}, ensure_ascii=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
