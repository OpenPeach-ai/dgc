#!/usr/bin/env python3
"""Local SDK workbench on a LAN port.

  PYTHONPATH=sdk/python:. python3 examples/sdk/workbench.py --port 8765 --mock
  PYTHONPATH=sdk/python:. python3 examples/sdk/workbench.py --host 0.0.0.0 --port 8765 --mock

Listens on all interfaces by default so phones/laptops on the same LAN can open
http://<this-host>:8765/ — stream, approve, deny, stop, resume. Isolated HOME.
The mock model stays on loopback.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdk" / "python"))
sys.path.insert(0, str(ROOT))

from dgc_sdk import DGC, QuestionAnswer  # noqa: E402

HTML = r"""<!doctype html>
<meta charset="utf-8">
<title>DGC SDK workbench</title>
<style>
  :root { font-family: ui-sans-serif, system-ui, sans-serif; color: #e8e4dc; background: #16141c; }
  body { max-width: 920px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 1.2rem; font-weight: 600; }
  textarea, input { width: 100%; background: #221f2a; color: inherit; border: 1px solid #3a3644; border-radius: 8px; padding: 8px; }
  button { background: #6d4aff; color: white; border: 0; border-radius: 8px; padding: 8px 12px; margin: 4px 4px 0 0; cursor: pointer; }
  button.secondary { background: #3a3644; }
  button.danger { background: #a33; }
  #log { white-space: pre-wrap; background: #0f0e14; border-radius: 8px; padding: 12px; min-height: 240px; font-size: 13px; }
  #pending { display: none; border: 1px solid #6d4aff; border-radius: 8px; padding: 12px; margin: 12px 0; }
  .muted { color: #9a94a8; font-size: 12px; }
</style>
<h1>DGC SDK workbench</h1>
<p class="muted">Local only. Isolated HOME. Stream, approve, deny, stop, resume.</p>
<textarea id="prompt" rows="3">Summarize the workspace in two sentences. Do not edit files.</textarea>
<div>
  <button id="run">Run</button>
  <button class="danger" id="stop">Stop</button>
  <button class="secondary" id="resume">Resume last</button>
</div>
<div id="pending">
  <strong>Approval</strong>
  <pre id="pending-body"></pre>
  <button id="allow">Allow once</button>
  <button class="danger" id="deny">Deny</button>
</div>
<pre id="log"></pre>
<script>
const logEl = document.getElementById("log");
const pending = document.getElementById("pending");
const pendingBody = document.getElementById("pending-body");
let currentPermission = null;
function log(line) { logEl.textContent += line + "\\n"; logEl.scrollTop = logEl.scrollHeight; }
async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return res.json();
}
const src = new EventSource("/api/events");
src.onmessage = (ev) => {
  const data = JSON.parse(ev.data);
  if (data.type === "permission_request") {
    currentPermission = data;
    pending.style.display = "block";
    pendingBody.textContent = (data.name || "") + " " + JSON.stringify(data.args || {}, null, 2);
  }
  if (data.type === "turn_end" || data.type === "result") pending.style.display = "none";
  log((data.type || "event") + (data.text ? (": " + data.text) : (data.status ? (" " + data.status) : "")));
};
document.getElementById("run").onclick = async () => {
  logEl.textContent = "";
  const r = await post("/api/run", { prompt: document.getElementById("prompt").value });
  log("accepted " + r.status);
};
document.getElementById("stop").onclick = () => post("/api/cancel", {});
document.getElementById("resume").onclick = () => post("/api/resume", {});
document.getElementById("allow").onclick = () => { post("/api/permission", { id: currentPermission && currentPermission.id, decision: "once" }); pending.style.display = "none"; };
document.getElementById("deny").onclick = () => { post("/api/permission", { id: currentPermission && currentPermission.id, decision: "deny" }); pending.style.display = "none"; };
</script>
"""


class _Mock(BaseHTTPRequestHandler):
    behavior = "text"

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
        if self.path.endswith("/models"):
            self._send(json.dumps({"data": [{"id": "sdk-model"}]}), "application/json")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        request = json.loads(self.rfile.read(length) or b"{}")
        messages = request.get("messages") or []
        last = ""
        for message in reversed(messages):
            if message.get("role") in ("user", "tool"):
                last = str(message.get("content") or "")
                break
        def sse(delta, finish=None):
            return "data: " + json.dumps({"id": "m", "object": "chat.completion.chunk",
                                          "choices": [{"index": 0, "delta": delta,
                                                       "finish_reason": finish}]}) + "\n\n"
        def answer(text):
            return sse({"content": text}) + sse({}, "stop") + "data: [DONE]\n\n"
        def call(name, args):
            return (sse({"tool_calls": [{"index": 0, "id": "c1", "type": "function",
                                         "function": {"name": name, "arguments": json.dumps(args)}}]})
                    + sse({}, "tool_calls") + "data: [DONE]\n\n")
        if last.startswith("TOOL:") or '"role": "tool"' in last:
            self._send(answer("Done."))
            return
        low = last.lower()
        if "option picker" in low:
            self._send(call("propose_options", {"questions": [{
                "question": "Which next?", "options": [
                    {"label": "Small fix", "recommended": True},
                    {"label": "Rewrite"},
                ]}]}))
            return
        if low.startswith("edit "):
            self._send(call("write_file", {"path": "guard.py", "content": "ok\n"}))
            return
        self._send(answer("The workspace is a local SDK workbench checkout."))


class Workbench:
    def __init__(self, workspace: Path, *, mock: bool):
        self.workspace = workspace
        self.state_dir = Path(tempfile.mkdtemp(prefix="dgc-sdk-workbench-"))
        self.events: list[dict] = []
        self.cond = threading.Condition()
        self.pending_permission: dict | None = None
        self.permission_choice: str | None = None
        self.dgc = None
        self.session = None
        self.last_id = ""
        self.mock_server = None
        self.base_url = os.environ.get("DGC_BASE_URL")
        self.model = os.environ.get("DGC_MODEL")
        if mock or not self.base_url:
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Mock)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            self.mock_server = httpd
            self.base_url = f"http://127.0.0.1:{httpd.server_address[1]}/v1"
            self.model = "sdk-model"
        self.dgc = DGC(
            state_dir=self.state_dir, inherit_user_state=False,
            model=self.model, base_url=self.base_url, api_key=os.environ.get("DGC_API_KEY", "sk-local"),
        )

    def _on_permission(self, request):
        with self.cond:
            self.pending_permission = {
                "type": "permission_request", "id": request.id, "name": request.name,
                "args": dict(request.args),
            }
            self.permission_choice = None
            self._emit(self.pending_permission)
            self.cond.wait(timeout=30)
            choice = self.permission_choice or "deny"
            self.pending_permission = None
            return choice if choice in ("once", "always", "deny") else "deny"

    def _on_question(self, request):
        qid = request.questions[0].id if request.questions else ""
        return {qid: QuestionAnswer(selected=(0,))} if qid else "dismiss"

    def _emit(self, event: dict) -> None:
        with self.cond:
            self.events.append(event)
            self.cond.notify_all()

    def ensure_session(self):
        if self.session is not None:
            return
        self.session = self.dgc.session(
            cwd=self.workspace,
            permissions={"mode": "default", "unhandled": "callback"},
            on_permission=self._on_permission,
            on_question=self._on_question,
            decision_timeout=30,
        )

    def run(self, prompt: str) -> dict:
        self.ensure_session()

        def worker() -> None:
            handle = self.session.stream(prompt, timeout=180)
            for event in handle:
                payload = {"type": event.type}
                if event.type == "text_delta":
                    payload["text"] = str((event.data or {}).get("text") or "")
                self._emit(payload)
            result = handle.result()
            self.last_id = self.session.session_id
            self._emit({"type": "result", "status": result.status, "text": result.final_text})

        threading.Thread(target=worker, daemon=True).start()
        return {"status": "running"}

    def cancel(self) -> dict:
        if self.session is not None:
            self.session.cancel()
        return {"status": "cancel-sent"}

    def resume(self) -> dict:
        if self.session is not None:
            try:
                self.session.close()
            except Exception:
                pass
        self.session = self.dgc.resume(
            self.last_id or None, latest=not self.last_id, cwd=self.workspace,
            permissions={"mode": "default", "unhandled": "callback"},
            on_permission=self._on_permission,
            on_question=self._on_question,
            decision_timeout=30,
        )
        return {"status": "resumed", "session_id": self.session.session_id}

    def decide(self, decision: str) -> dict:
        with self.cond:
            self.permission_choice = decision
            self.cond.notify_all()
        return {"status": "decided"}

    def close(self) -> None:
        try:
            self.dgc.close()
        except Exception:
            pass
        if self.mock_server is not None:
            self.mock_server.shutdown()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("DGC_SDK_WORKBENCH_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("DGC_SDK_WORKBENCH_PORT", "8765")))
    parser.add_argument("--workspace", default=str(Path.cwd()))
    parser.add_argument("--mock", action="store_true")
    args = parser.parse_args()
    bench = Workbench(Path(args.workspace).resolve(), mock=args.mock)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _json(self, payload, code=200):
            data = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/":
                body = HTML.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/health":
                self._json({"ok": True, "version": bench.dgc.version})
                return
            if path == "/api/events":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                index = 0
                try:
                    while True:
                        with bench.cond:
                            while index >= len(bench.events):
                                bench.cond.wait(timeout=15)
                            batch = bench.events[index:]
                            index = len(bench.events)
                        for event in batch:
                            self.wfile.write(b"data: " + json.dumps(event).encode() + b"\n\n")
                            self.wfile.flush()
                except BrokenPipeError:
                    return
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            path = urlparse(self.path).path
            if path == "/api/run":
                self._json(bench.run(str(body.get("prompt") or "Summarize. Do not edit files.")))
                return
            if path == "/api/cancel":
                self._json(bench.cancel())
                return
            if path == "/api/resume":
                self._json(bench.resume())
                return
            if path == "/api/permission":
                self._json(bench.decide(str(body.get("decision") or "deny")))
                return
            self.send_response(404)
            self.end_headers()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"DGC SDK workbench http://{args.host}:{args.port}/", flush=True)
    if args.host in ("0.0.0.0", "::"):
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("192.168.1.1", 80))
            lan = probe.getsockname()[0]
        except OSError:
            lan = "192.168.1.148"
        finally:
            probe.close()
        print(f"LAN http://{lan}:{args.port}/", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        bench.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
